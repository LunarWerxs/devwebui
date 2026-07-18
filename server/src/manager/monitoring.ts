import { stripAnsi } from "../errors";
import { appendLog } from "../log-vault";
import { sampleMetrics } from "../metrics";
import { isPortListening } from "../ports";
import type { LogLine } from "../types";
import { ManagerBase } from "./base";
import { MAX_LOGS, type Entry } from "./types";

/**
 * The polling/diagnostics loop: live-log ingestion, the 2s port-probe +
 * error-flush tick, and the batched CPU/memory sampling tick. Implements the
 * two abstract hooks (`tick`, `metricsTick`) that `ManagerBase`'s constructor
 * and `applyMonitorResources` wire up to timers.
 */
export class ManagerWithMonitoring extends ManagerBase {
  protected addLog(e: Entry, stream: LogLine["stream"], text: string): void {
    const clean = stripAnsi(text);
    const fileLines: string[] = [];
    for (const raw of clean.split(/\r?\n/)) {
      if (!raw) continue;
      const line: LogLine = { id: e.def.id, stream, line: raw, ts: Date.now() };
      e.logs.push(line);
      if (e.logs.length > MAX_LOGS) e.logs.shift();
      // Don't emit per line — the batcher coalesces a burst into one "log" event so a
      // noisy child can't fan out one SSE write per line to every connected client.
      this.logBatcher.push(line);
      fileLines.push(`${new Date(line.ts).toISOString()} [${stream}] ${raw}`);
    }
    // Time-Travel Log Vault: append-through to the rotating on-disk file so history
    // survives a daemon restart (the in-memory `logs` ring above is capped + volatile).
    appendLog(e.def.id, fileLines);
    // Record the whole chunk as ONE error candidate, so a multi-line stack trace
    // becomes a single de-duplicated record rather than one record per line.
    this.errors.record(this.errorInfo(e), stream === "stderr" ? "stderr" : "stdout", clean);
  }

  protected async tick(): Promise<void> {
    if (this.tickRunning) return;
    this.tickRunning = true;
    try {
      await this.pollPorts();
      if (this.errorsDirty) {
        this.errorsDirty = false;
        this.emit("errors", this.errors.list());
      }
    } finally {
      this.tickRunning = false;
    }
  }

  /** Self-guarded metrics loop tick: never let a slow sample overlap the next one. */
  protected async metricsTick(): Promise<void> {
    if (this.metricsRunning) return;
    this.metricsRunning = true;
    try {
      await this.pollMetrics();
    } finally {
      this.metricsRunning = false;
    }
  }

  /**
   * Sample CPU + memory for every running process in ONE batched call.
   *
   * The heavy lifting lives in metrics.ts. On Windows (under Bun) it reads the Win32
   * API in-process via FFI — NO child processes at all. Elsewhere it falls back to a
   * single batched `pidusage` call. Either way it's one call for the whole fleet, on
   * the metrics loop (METRICS_INTERVAL), and only while `monitorResources` is on.
   *
   * (This replaced the original code, which called pidusage(pid) once PER process PER
   * 2s tick — on Win11 each call spawned a powershell.exe + conhost.exe, so a handful
   * of servers became a continuous storm of shells.)
   */
  private async pollMetrics(): Promise<void> {
    const running = [...this.entries.values()].filter((e) => e.pid);
    if (running.length === 0) return;
    const stats = await sampleMetrics(running.map((e) => e.pid!));
    for (const e of running) {
      const s = stats[e.pid!];
      e.cpu = s ? Math.round(s.cpu) : null;
      e.memory = s ? s.memory : null;
      this.emitStatus(e);
    }
  }

  private async pollPorts(): Promise<void> {
    const byPort = new Map<number, Entry[]>();
    for (const e of this.entries.values()) {
      if (!e.def.port) continue;
      const entries = byPort.get(e.def.port) ?? [];
      entries.push(e);
      byPort.set(e.def.port, entries);
    }
    await Promise.all(
      [...byPort.entries()].map(async ([port, entries]) => {
        const inUse = await isPortListening(port);
        for (const e of entries) {
          if (inUse !== e.portInUse) {
            e.portInUse = inUse;
            this.emitStatus(e);
          }
        }
      }),
    );
  }
}
