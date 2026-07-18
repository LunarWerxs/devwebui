// ---------------------------------------------------------------------------
// Time-Travel Log Vault — rotating per-process log files under
// ~/.devwebui/logs/<processId>.log, appended-through from the existing log
// pipeline (manager/monitoring.ts's addLog). Size-based rotation (~1MB, keep
// 2 rotations: <id>.log.1, <id>.log.2), no new deps (fs only).
//
// Crash HISTORY deliberately does NOT live here. A crash is surfaced once, when
// it happens, through the errors panel (manager/lifecycle.ts's handleExit ->
// errors.record); the stderr that caused it stays readable in the log files
// above. There is no "last crash" sidecar and no start-time hint: a process that
// died on a previous run but is healthy now is not a problem, and interrupting
// on it trains the user to ignore the alert channel that DOES matter.
//
// `def.id` (`${projectId}.${localId}`) is already filesystem-safe (projectId
// is `p`+8 hex chars; localId is schema-validated to [A-Za-z0-9._-] — see
// shared/schema.ts's ID_RE) but filenames are still defensively sanitized
// below in case a future format relaxes that.
// ---------------------------------------------------------------------------
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { dataDir } from "./data-dir";

const vaultDir = (): string => path.join(dataDir(), "logs");
const MAX_BYTES = 1_000_000; // ~1MB per file before rotating
const KEEP_ROTATIONS = 2; // <id>.log.1, <id>.log.2 — <id>.log.3+ is discarded

/** Sanitize an id for use as a filename component (defense in depth — see header comment). */
function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function ensureDir(): void {
  mkdirSync(vaultDir(), { recursive: true });
}

function logPath(id: string, rotation = 0): string {
  const base = path.join(vaultDir(), `${safeId(id)}.log`);
  return rotation === 0 ? base : `${base}.${rotation}`;
}

/** Shift <id>.log -> .1 -> .2, dropping anything past KEEP_ROTATIONS, then start a fresh <id>.log. */
function rotate(id: string): void {
  try {
    const oldest = logPath(id, KEEP_ROTATIONS);
    if (existsSync(oldest)) rmSync(oldest, { force: true });
    for (let i = KEEP_ROTATIONS - 1; i >= 0; i--) {
      const from = logPath(id, i);
      if (!existsSync(from)) continue;
      renameSync(from, logPath(id, i + 1));
    }
  } catch {
    /* best-effort — a failed rotation just means the current file keeps growing */
  }
}

/**
 * Append a batch of already-formatted lines to a process's log file, rotating
 * first if the current file is at/over the size cap. Best-effort: a disk
 * error here must never take down the process it's logging.
 */
export function appendLog(id: string, lines: string[]): void {
  if (!lines.length) return;
  try {
    ensureDir();
    const file = logPath(id);
    if (existsSync(file) && statSync(file).size >= MAX_BYTES) rotate(id);
    appendFileSync(file, `${lines.join("\n")}\n`);
  } catch {
    /* best-effort */
  }
}

/**
 * Tail the last `lines` lines for a process across the current file and its
 * rotations (oldest rotation first, so the result reads chronologically).
 * Returns [] when nothing has been logged yet.
 */
export function tailLog(id: string, lines: number): string[] {
  try {
    // Oldest rotation first .. current file last, so the concatenated result reads
    // chronologically: rotation KEEP_ROTATIONS (oldest) down to rotation 0 (current).
    const rotationsOldestFirst = Array.from(
      { length: KEEP_ROTATIONS + 1 },
      (_, i) => KEEP_ROTATIONS - i,
    );
    let all: string[] = [];
    for (const rotation of rotationsOldestFirst) {
      const file = logPath(id, rotation);
      if (!existsSync(file)) continue;
      const content = readFileSync(file, "utf8");
      const fileLines = content.split("\n").filter((l, i, arr) => l !== "" || i !== arr.length - 1);
      all = all.concat(fileLines);
    }
    return all.slice(-lines);
  } catch {
    return [];
  }
}

export const LOG_ROTATION_MAX_BYTES = MAX_BYTES;
export const LOG_ROTATION_KEEP = KEEP_ROTATIONS;

/** The vault's on-disk directory (for tests that need to clean up their fixture files). */
export function logVaultDir(): string {
  return vaultDir();
}
