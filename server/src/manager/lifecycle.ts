import { spawn, type ChildProcess } from "node:child_process";
import treeKill from "tree-kill";
import type { FreePortResult, PortOwner } from "../../../shared/dto";
import { clearLastCrash, readLastCrash, recordLastCrash, type LastCrash } from "../log-vault";
import { freePort, isPortListening, killPids, portOwners } from "../ports";
import { effectiveRuntime, withRuntime } from "../runtime";
import { setEnabledOverride, setProjectOverride } from "../state";
import type { ProcessDef, Status } from "../types";
import { ManagerWithMonitoring } from "./monitoring";
import {
  KILL_GRACE_MS,
  START_STAGGER_MS,
  WAIT_FOR_PORT_POLL_MS,
  WAIT_FOR_PORT_TIMEOUT_MS,
  type Entry,
} from "./types";
import { coStartIds, linkedGroupIds } from "./links";
import { DependencyCycleError, orderByDependency, resolveWaitPort } from "./wait-for-port";

/**
 * Process lifecycle: start/stop/restart of individual processes (and the
 * fleet as a whole), the staggered auto-start queue, spawn/exit handling,
 * the per-process/per-project enable toggles (setters — the predicates live
 * in `ManagerBase`), and the "free this port" confirm-then-kill flow.
 */
export class ManagerWithLifecycle extends ManagerWithMonitoring {
  // Instance-overridable so tests can shrink the timeout/poll cadence rather than
  // waiting out the real 30s default.
  waitForPortTimeoutMs = WAIT_FOR_PORT_TIMEOUT_MS;
  waitForPortPollMs = WAIT_FOR_PORT_POLL_MS;

  // ---- processes ----------------------------------------------------------
  /**
   * Start a process. Returns the crash metadata from its LAST run (if that run
   * ended in a non-zero exit) so a caller (the HTTP route/GUI) can proactively
   * surface "last time this failed with …" — the Log Vault's killer detail.
   * Returns null when there's no child to start (already running/starting) or
   * the last run wasn't a crash.
   */
  start(id: string): LastCrash | null {
    const e = this.entries.get(id);
    if (!e || e.child || e.pendingStart) return null;
    const lastCrash = readLastCrash(id);
    this.cancelQueuedStart(id);
    e.stopping = false;
    e.exitCode = null;
    this.clearStopTimer(e);
    // Also push over SSE (a dedicated event, not folded into the frequent "status"
    // stream) so auto-started processes — no HTTP response to attach this to — still
    // surface the hint in the GUI.
    if (lastCrash) this.emit("lastCrash", { id, lastCrash });

    // Dependency-ordered startup (S): wait for a declared port before spawning. The
    // wait is async, so flag pendingStart — same guard the free-port step below uses
    // — and bail out of every continuation if we were cancelled/replaced meanwhile.
    const waitPort = resolveWaitPort(e.def, this.defsById());
    if (waitPort) {
      e.pendingStart = true;
      e.waitingOnPort = waitPort;
      this.setStatus(e, "waiting");
      void this.waitForPort(waitPort).then((ok) => {
        if (!e.pendingStart || this.entries.get(e.def.id) !== e) return;
        e.waitingOnPort = null;
        if (!ok) {
          e.pendingStart = false;
          const label = typeof e.def.waitForPort === "string" ? e.def.waitForPort : waitPort;
          this.addLog(
            e,
            "stderr",
            `[devwebui] gave up waiting for port ${waitPort} (${label}) after ${this.waitForPortTimeoutMs}ms; not starting.`,
          );
          this.setStatus(e, "stopped");
          this.resolveExitWaiters(e);
          return;
        }
        e.pendingStart = false;
        this.setStatus(e, "starting");
        this.continueStart(e);
      });
    } else {
      this.setStatus(e, "starting");
      this.continueStart(e);
    }
    return lastCrash;
  }

  /**
   * Start a process the way the GUI/MCP "start" action does: the process itself,
   * plus its linked group and the project's companion processes (see links.ts for
   * the semantics). The anchor starts immediately — preserving `start()`'s
   * last-crash return for the caller — while the rest go through the ordinary
   * staggered, dependency-ordered batch queue. Already-running members are
   * no-ops, so this is safely idempotent ("bring this group up").
   * `coStarted` lists the OTHER processes this action actually set in motion
   * (already-running/queued members excluded) so the GUI can say "also started …".
   */
  startWithLinks(id: string): { lastCrash: LastCrash | null; coStarted: string[] } {
    const e = this.entries.get(id);
    if (!e) return { lastCrash: null, coStarted: [] };
    let extras = coStartIds(e.def, [...this.defsById().values()]);
    const lastCrash = this.start(id);
    // startMany() is all-or-nothing on a waitForPort cycle — correct for an
    // explicit batch, but here an unrelated cycle (say, between two companions)
    // would silently block the anchor's real linked group. Strip cycle members
    // (logging against them, same as startMany would) and still start the rest.
    for (;;) {
      try {
        orderByDependency(extras, this.defsById());
        break;
      } catch (err) {
        if (!(err instanceof DependencyCycleError)) throw err;
        for (const cid of err.cycle) {
          const ce = this.entries.get(cid);
          if (ce) this.addLog(ce, "stderr", `[devwebui] ${err.message}; not starting.`);
        }
        const cycle = new Set(err.cycle);
        extras = extras.filter((x) => !cycle.has(x));
      }
    }
    // Same guard queueStart applies: members already running, mid-start, or
    // queued by an earlier batch aren't started BY THIS ACTION — don't report them.
    const coStarted = extras.filter((x) => {
      const xe = this.entries.get(x);
      return !!xe && !xe.child && !xe.pendingStart && !this.queuedStarts.has(x);
    });
    if (extras.length) this.startMany(extras);
    return { lastCrash, coStarted };
  }

  /**
   * Stop a process the way the GUI/MCP "stop" action does: the process itself
   * plus its linked group — a linked group acts as one unit, so stopping any
   * member brings the whole group down. Companions are NOT included: they join
   * starts only (a shared database shouldn't die because one consumer stopped).
   * Resolves to the OTHER group members this action actually brought down
   * (already-stopped members excluded) so the GUI can say "also stopped …".
   */
  async stopWithLinks(id: string): Promise<string[]> {
    const e = this.entries.get(id);
    if (!e) return [];
    const group = linkedGroupIds(e.def, [...this.defsById().values()]);
    const coStopped = group.filter((gid) => {
      const ge = this.entries.get(gid);
      return !!ge && (!!ge.child || ge.pendingStart || this.queuedStarts.has(gid));
    });
    await Promise.all([id, ...group].map((pid) => this.stop(pid)));
    return coStopped;
  }

  /**
   * All currently-registered process defs, keyed by global id (used to resolve `waitForPort`).
   * Note: `.values()`/`.keys()`/`.entries()` on the returned Map are one-shot iterators.
   * Materialize (`[...]`) before handing one to anything that may walk it twice (see coStartIds).
   */
  private defsById(): Map<string, ProcessDef> {
    const map = new Map<string, ProcessDef>();
    for (const e of this.entries.values()) map.set(e.def.id, e.def);
    return map;
  }

  /** Poll until `port` is listening or the timeout elapses. Resolves false on timeout. */
  private async waitForPort(port: number): Promise<boolean> {
    const deadline = Date.now() + this.waitForPortTimeoutMs;
    for (;;) {
      if (await isPortListening(port)) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, this.waitForPortPollMs));
    }
  }

  /** Runs after any `waitForPort` step (or immediately, if there was none): the pre-existing
   *  optional free-port step, then the actual spawn. */
  private continueStart(e: Entry): void {
    if (e.child || e.stopping || this.entries.get(e.def.id) !== e || e.status !== "starting")
      return;
    // Optionally clear the declared port first (kill whatever holds it) so a
    // `--strictPort` server can bind. It's async (probe + kill), so flag the entry
    // pendingStart — that blocks a concurrent start() and lets stop() cancel us —
    // and spawn in the callback only if we weren't cancelled or replaced meanwhile.
    if (this.freePortOnStart && e.def.port) {
      e.pendingStart = true;
      void this.freePortIfBusy(e.def.port).then(() => {
        if (!e.pendingStart || this.entries.get(e.def.id) !== e) return;
        e.pendingStart = false;
        this.spawnEntry(e);
      });
    } else {
      this.spawnEntry(e);
    }
  }

  /** Kill the port's holder only if something is actually listening (skip a needless subprocess). */
  private async freePortIfBusy(port: number): Promise<void> {
    if (await isPortListening(port)) await freePort(port);
  }

  /** Spawn the child for an entry already moved to "starting". */
  private spawnEntry(e: Entry): void {
    // The async free-port window means state may have moved on — bail if so.
    if (e.child || e.stopping || this.entries.get(e.def.id) !== e || e.status !== "starting")
      return;
    const command = withRuntime(e.def.command, effectiveRuntime(e.def.runtime, this.globalRuntime));
    let child: ChildProcess;
    try {
      child = spawn(command, {
        cwd: e.def.cwd,
        env: { ...process.env, ...e.def.env },
        shell: true,
        // shell:true runs the command under `cmd /d /s /c`, a console program. Whether that
        // pops a VISIBLE console depends on the console the daemon itself owns, so it only
        // misbehaves on some launch paths: under the tray the daemon is started with
        // CreateNoWindow and children inherit that headless console, but a desktop shortcut
        // boots the daemon detached (cli.ts, DETACHED_PROCESS) with NO console at all — and
        // then Windows gives each managed dev server a brand-new console of its own, which
        // Windows Terminal (when set as the default terminal) hosts as a real window that
        // stays up for the life of the server. windowsHide (CREATE_NO_WINDOW) makes the
        // outcome the same on every path. Safe with the piped stdio below: the console is
        // only ever a window, never where our logs come from.
        windowsHide: true,
      });
    } catch (err) {
      this.handleSpawnError(e, null, err);
      return;
    }
    e.child = child;
    e.pid = child.pid ?? null;
    e.startedAt = e.pid ? Date.now() : null;

    child.stdout?.on("data", (d: Buffer) => this.addLog(e, "stdout", d.toString()));
    child.stderr?.on("data", (d: Buffer) => this.addLog(e, "stderr", d.toString()));
    child.on("error", (err) => this.handleSpawnError(e, child, err));
    child.on("exit", (code) => this.handleExit(e, child, code));
    if (e.pid) this.setStatus(e, "running");
  }

  // ---- enable/disable: setters (predicates live in ManagerBase) -----------
  // Toggling never starts or stops a live process (use start/stop for that). It
  // only records what should auto-start next time the project loads.
  /** Set one process's toggle and persist it. Does NOT start/stop it. */
  setProcessEnabled(id: string, enabled: boolean): void {
    const e = this.entries.get(id);
    if (!e) return;
    setEnabledOverride(id, enabled);
    this.emitStatus(e); // push the new `enabled` flag to the GUI
  }

  /** Flip a project's master switch and persist it. Does NOT start/stop, and does
   *  NOT touch the individual per-process toggles — it just gates the whole stack. */
  setProjectEnabled(projectId: string, enabled: boolean): void {
    if (!this.projects.has(projectId)) return;
    setProjectOverride(projectId, enabled);
    this.emitProjects(); // ProjectView.enabled changed — refresh the list
  }

  stop(id: string): Promise<void> {
    const e = this.entries.get(id);
    if (!e) return Promise.resolve();
    this.cancelQueuedStart(id);
    if (e.pendingStart) {
      // Cancel a start still waiting on a dependency port or the free-port step
      // (no child exists yet).
      e.pendingStart = false;
      e.waitingOnPort = null;
      this.clearStopTimer(e);
      this.setStatus(e, "stopped");
      return Promise.resolve();
    }
    if (!e.child) return Promise.resolve();
    if (e.stopping) return new Promise((resolve) => e.exitWaiters.push(resolve));
    e.stopping = true;
    this.setStatus(e, "stopping");
    const child = e.child;
    const pid = e.pid;
    if (!pid) {
      this.addLog(
        e,
        "stderr",
        "[devwebui] process had no PID while stopping; clearing stale state.",
      );
      this.finishProcess(e, child, "stopped", null);
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      e.exitWaiters.push(resolve);
      const forceKill = (reason: string) => {
        if (e.child !== child || e.pid !== pid) return;
        this.clearStopTimer(e);
        this.addLog(e, "stderr", `[devwebui] ${reason}; sent SIGKILL.`);
        try {
          treeKill(pid, "SIGKILL", (err) => {
            if (e.child !== child || e.pid !== pid) return;
            if (err) {
              this.addLog(
                e,
                "stderr",
                `[devwebui] failed to force stop process ${pid}: ${err.message}`,
              );
              this.finishProcess(e, child, "crashed", null);
            } else {
              this.finishProcess(e, child, "stopped", null);
            }
          });
        } catch (err) {
          this.addLog(
            e,
            "stderr",
            `[devwebui] failed to force stop process ${pid}: ${(err as Error).message}`,
          );
          this.finishProcess(e, child, "crashed", null);
        }
      };
      e.stopTimer = setTimeout(
        () => forceKill(`process did not exit after ${KILL_GRACE_MS}ms`),
        KILL_GRACE_MS,
      );
      try {
        treeKill(pid, "SIGTERM", (err) => {
          if (err) forceKill(`SIGTERM failed for process ${pid}: ${err.message}`);
        });
      } catch (err) {
        forceKill(`SIGTERM failed for process ${pid}: ${(err as Error).message}`);
      }
    });
  }

  async restart(id: string): Promise<void> {
    const e = this.entries.get(id);
    if (!e) return;
    const wasRunning = !!e.child;
    await this.stop(id);
    await new Promise((r) => setTimeout(r, 200));
    if (wasRunning || e.status === "stopped" || e.status === "crashed") e.restarts += 1;
    this.start(id);
  }

  startAll(): void {
    this.startMany([...this.entries.keys()]);
  }

  /** Restart everything currently running — used when the global runtime changes. */
  async restartRunning(): Promise<void> {
    const running = [...this.entries.entries()].filter(([, e]) => e.child).map(([id]) => id);
    await Promise.all(running.map((id) => this.stop(id)));
    for (const id of running) {
      const e = this.entries.get(id);
      if (e && (e.status === "stopped" || e.status === "crashed")) e.restarts += 1;
    }
    this.startMany(running);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.stop(id)));
  }

  /**
   * Free a process's declared port with a SMALL blast radius:
   *   • a holder we manage is STOPPED cleanly (never SIGKILLed out from under us);
   *   • external (unmanaged) holders are only killed after explicit confirmation, and
   *     only those exact PIDs — never a blind "kill anything on this port" sweep.
   * Returns the external owners + `needsConfirm` when confirmation is required.
   */
  async freeProcessPort(id: string, opts: { confirm?: boolean } = {}): Promise<FreePortResult> {
    const e = this.entries.get(id);
    if (!e?.def.port) return { ok: true };
    const owners = await portOwners(e.def.port);
    if (!owners.length) return { ok: true, owners: [] }; // already free

    const stoppedManaged: string[] = [];
    const external: PortOwner[] = [];
    for (const o of owners) {
      const mine = this.entryByPid(o.pid);
      if (mine) stoppedManaged.push(mine.def.id);
      else external.push(o);
    }
    // Prefer a clean stop of anything we own.
    await Promise.all([...new Set(stoppedManaged)].map((mid) => this.stop(mid)));

    if (!external.length) return { ok: true, stoppedManaged };
    if (!opts.confirm) return { needsConfirm: true, owners: external, stoppedManaged };
    await killPids(external.map((o) => o.pid));
    return { ok: true, stoppedManaged, owners: external };
  }

  // ---- internals: staggered auto-start queue + spawn/exit handling --------
  /**
   * Start a batch (individual start_all/startProject calls, or launch-time autostart).
   * Resolves `waitForPort` dependency ordering within the batch first (simple
   * topological sort — see wait-for-port.ts), so a dependency is queued to start
   * before its dependent, then staggers the (now-ordered) queue same as before.
   * On a dependency cycle, nothing in the batch is started — the error is logged
   * against every process named in the cycle so it's visible in the GUI.
   */
  protected startMany(ids: string[]): void {
    const unique = [...new Set(ids)];
    let ordered: string[];
    try {
      ordered = orderByDependency(unique, this.defsById());
    } catch (err) {
      if (err instanceof DependencyCycleError) {
        for (const id of err.cycle) {
          const e = this.entries.get(id);
          if (e) this.addLog(e, "stderr", `[devwebui] ${err.message}; not starting.`);
        }
        return;
      }
      throw err;
    }
    ordered.forEach((id, i) => {
      this.queueStart(id, i * START_STAGGER_MS);
    });
  }

  private queueStart(id: string, delayMs: number): void {
    const e = this.entries.get(id);
    if (!e || e.child || e.pendingStart || this.queuedStarts.has(id)) return;
    if (delayMs <= 0) {
      this.start(id);
      return;
    }
    const timer = setTimeout(() => {
      this.queuedStarts.delete(id);
      this.start(id);
    }, delayMs);
    this.queuedStarts.set(id, timer);
  }

  private finishProcess(
    e: Entry,
    child: ChildProcess,
    status: Status,
    exitCode: number | null,
  ): void {
    if (e.child !== child) return;
    this.clearStopTimer(e);
    e.child = null;
    e.pid = null;
    e.cpu = null;
    e.memory = null;
    e.exitCode = exitCode;
    e.startedAt = null;
    e.stopping = false;
    this.setStatus(e, status);
    this.resolveExitWaiters(e);
  }

  private handleSpawnError(e: Entry, child: ChildProcess | null, err: unknown): void {
    if (child && e.child !== child) return;
    const current = this.entries.get(e.def.id) === e;
    const message = err instanceof Error ? err.message : String(err);
    this.clearStopTimer(e);
    e.child = null;
    e.pid = null;
    e.cpu = null;
    e.memory = null;
    e.exitCode = null;
    e.startedAt = null;
    const stopped = e.stopping;
    e.stopping = false;
    if (current) {
      this.addLog(e, "stderr", `[devwebui] spawn error: ${message}`);
      this.setStatus(e, stopped ? "stopped" : "crashed");
    }
    this.resolveExitWaiters(e);
  }

  private handleExit(e: Entry, child: ChildProcess, code: number | null): void {
    if (e.child !== child) return;
    const current = this.entries.get(e.def.id) === e;
    const crashed = current && !e.stopping && code !== 0 && code !== null;
    if (crashed) {
      this.errors.record(this.errorInfo(e), "crash", `Process exited with code ${code}`);
      // Time-Travel Log Vault killer detail: persist this crash's exit code + stderr
      // tail so the NEXT start() attempt can proactively surface it, even across a
      // daemon restart (the in-memory Entry this reads from is gone by then).
      recordLastCrash(e.def.id, code, e.recentStderr);
    } else if (code === 0) {
      // A clean exit retires any previously-recorded crash hint for this process.
      clearLastCrash(e.def.id);
    }
    this.finishProcess(e, child, crashed ? "crashed" : "stopped", code);
  }
}
