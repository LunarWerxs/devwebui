// ───────────────────────────────────────────────────────────────────────────────
// Time-Travel Log Vault, end-to-end through the real Manager: a process that
// crashes gets its exit metadata + stderr tail persisted (log-vault.ts), and the
// NEXT start() attempt proactively returns that as `lastCrash` — the killer detail.
// Also covers getLogFileTail() (the GET .../logfile route's backing method) and that
// a clean exit retires a stale crash hint. Real child processes (bun -e), following
// manager.test.ts's idiom, so the daemon's actual spawn/exit/log pipeline is exercised.
// ───────────────────────────────────────────────────────────────────────────────
import { afterEach, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { Manager } from "../server/src/manager";
import { logVaultDir } from "../server/src/log-vault";
import type { LoadedProject, ProcessDef } from "../server/src/types";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function quote(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}

/** A process that writes to stderr then exits with the given code. */
function crashingCommand(stderrText: string, exitCode: number): string {
  const script = `process.stderr.write(${JSON.stringify(stderrText)}); process.exitCode = ${exitCode};`;
  return `${quote(process.execPath)} -e ${quote(script)}`;
}

/** A process that exits 0 immediately (a "clean" run). */
function cleanExitCommand(): string {
  return `${quote(process.execPath)} -e ${quote("process.exitCode = 0;")}`;
}

function processDef(id: string, command: string): ProcessDef {
  return {
    id: `logvault-mgr-test.${id}`,
    localId: id,
    name: id,
    command,
    cwd: process.cwd(),
    autostart: false,
    projectId: "logvault-mgr-test",
    projectName: "LogVaultMgrTest",
  };
}

function project(processes: ProcessDef[]): LoadedProject {
  return {
    id: "logvault-mgr-test",
    name: "LogVaultMgrTest",
    path: `${process.cwd()}\\.devwebui`,
    dir: process.cwd(),
    processes,
  };
}

const idsToClean = new Set<string>();

function cleanupVaultFiles(id: string) {
  const dir = logVaultDir();
  for (const suffix of ["", ".1", ".2", ".3"]) {
    const f = path.join(dir, `${id}.log${suffix}`);
    if (existsSync(f)) rmSync(f, { force: true });
  }
  const sidecar = path.join(dir, `${id}.lastcrash.json`);
  if (existsSync(sidecar)) rmSync(sidecar, { force: true });
}

afterEach(() => {
  for (const id of idsToClean) cleanupVaultFiles(id);
  idsToClean.clear();
});

async function waitFor(fn: () => boolean, timeoutMs = 5000, stepMs = 25): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await sleep(stepMs);
  }
}

test("a crashed process's exit code + stderr tail persist, and the next start() surfaces them", async () => {
  const manager = new Manager();
  manager.monitorResources = false;
  manager.applyMonitorResources();
  const localId = `crash-${Date.now()}`;
  const globalId = `logvault-mgr-test.${localId}`;
  idsToClean.add(globalId);

  try {
    manager.addProject(
      project([processDef(localId, crashingCommand("boom: ECONNREFUSED 127.0.0.1:5432\n", 1))]),
      {
        autostart: false,
      },
    );

    const firstStart = manager.start(globalId);
    expect(firstStart).toBeNull(); // nothing crashed before this run

    await waitFor(() => manager.view(globalId)?.status === "crashed");

    // Give the debounced log-vault append a moment (addLog appends synchronously,
    // but be generous under CI scheduling).
    await sleep(50);

    const tail = manager.getLogFileTail(globalId, 50);
    expect(tail.some((l) => l.includes("ECONNREFUSED"))).toBe(true);

    // The killer detail: starting again surfaces the PREVIOUS crash.
    const secondStart = manager.start(globalId);
    expect(secondStart).not.toBeNull();
    expect(secondStart?.exitCode).toBe(1);
    expect(secondStart?.stderrTail.some((l) => l.includes("ECONNREFUSED"))).toBe(true);

    await waitFor(() => manager.view(globalId)?.status === "crashed");
  } finally {
    await manager.stopProject("logvault-mgr-test");
    manager.dispose();
  }
}, 10000);

test("a clean exit retires a previously-recorded crash hint", async () => {
  const manager = new Manager();
  manager.monitorResources = false;
  manager.applyMonitorResources();
  const localId = `clean-${Date.now()}`;
  const globalId = `logvault-mgr-test.${localId}`;
  idsToClean.add(globalId);

  try {
    manager.addProject(project([processDef(localId, crashingCommand("first run dies\n", 1))]), {
      autostart: false,
    });
    manager.start(globalId);
    await waitFor(() => manager.view(globalId)?.status === "crashed");

    expect(manager.getLastCrash(globalId)).not.toBeNull();

    // Swap in a command that exits cleanly, then reconcile + start it.
    manager.reconcileProject(project([processDef(localId, cleanExitCommand())]));
    const started = manager.start(globalId);
    expect(started).not.toBeNull(); // still surfaces the OLD crash on this start
    await waitFor(() => manager.view(globalId)?.status === "stopped");

    // Now the crash hint should be retired.
    expect(manager.getLastCrash(globalId)).toBeNull();
    expect(manager.start(globalId)).toBeNull();
    await waitFor(() => manager.view(globalId)?.status === "stopped");
  } finally {
    await manager.stopProject("logvault-mgr-test");
    manager.dispose();
  }
}, 10000);

test("getLogFileTail returns [] for an unknown process id", async () => {
  const manager = new Manager();
  manager.monitorResources = false;
  manager.applyMonitorResources();
  try {
    expect(manager.getLogFileTail("no-such-process", 50)).toEqual([]);
  } finally {
    manager.dispose();
  }
}, 5000);
