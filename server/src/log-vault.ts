// ---------------------------------------------------------------------------
// Time-Travel Log Vault — rotating per-process log files under
// ~/.devwebui/logs/<processId>.log, appended-through from the existing log
// pipeline (manager/monitoring.ts's addLog). Size-based rotation (~1MB, keep
// 2 rotations: <id>.log.1, <id>.log.2), no new deps (fs only).
//
// THE KILLER DETAIL lives alongside: a small per-process "last crash" sidecar
// (lastcrash.json) recording {exitCode, endedAt, stderrTail} so the next
// start() attempt can proactively surface it — this survives daemon restarts,
// unlike the in-memory Entry it's derived from.
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
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LastCrash } from "../../shared/dto";

export type { LastCrash };

const DIR = path.join(os.homedir(), ".devwebui", "logs");
const MAX_BYTES = 1_000_000; // ~1MB per file before rotating
const KEEP_ROTATIONS = 2; // <id>.log.1, <id>.log.2 — <id>.log.3+ is discarded
const STDERR_TAIL_LINES = 20;

/** Sanitize an id for use as a filename component (defense in depth — see header comment). */
function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function ensureDir(): void {
  mkdirSync(DIR, { recursive: true });
}

function logPath(id: string, rotation = 0): string {
  const base = path.join(DIR, `${safeId(id)}.log`);
  return rotation === 0 ? base : `${base}.${rotation}`;
}

function sidecarPath(id: string): string {
  return path.join(DIR, `${safeId(id)}.lastcrash.json`);
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

/** Persist the last crash's exit metadata + stderr tail for a process (best-effort). */
export function recordLastCrash(id: string, exitCode: number | null, recentStderr: string[]): void {
  try {
    ensureDir();
    const crash: LastCrash = {
      exitCode,
      endedAt: Date.now(),
      stderrTail: recentStderr.slice(-STDERR_TAIL_LINES),
    };
    writeFileSync(sidecarPath(id), JSON.stringify(crash));
  } catch {
    /* best-effort */
  }
}

/** Read the last recorded crash for a process, or null if none / unreadable. */
export function readLastCrash(id: string): LastCrash | null {
  try {
    const raw = readFileSync(sidecarPath(id), "utf8");
    const parsed = JSON.parse(raw) as LastCrash;
    if (typeof parsed.endedAt !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Clear the last-crash sidecar (e.g. after a clean start makes it stale). */
export function clearLastCrash(id: string): void {
  try {
    rmSync(sidecarPath(id), { force: true });
  } catch {
    /* best-effort */
  }
}

export const STDERR_TAIL_LINE_COUNT = STDERR_TAIL_LINES;
export const LOG_ROTATION_MAX_BYTES = MAX_BYTES;
export const LOG_ROTATION_KEEP = KEEP_ROTATIONS;

/** The vault's on-disk directory (for tests that need to clean up their fixture files). */
export function logVaultDir(): string {
  return DIR;
}
