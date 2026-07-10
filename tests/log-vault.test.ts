// ───────────────────────────────────────────────────────────────────────────────
// Time-Travel Log Vault: rotation, tail retrieval, and the last-crash sidecar that
// backs the "next start() surfaces the previous crash" killer detail. This module
// writes to the REAL ~/.devwebui/logs directory (no DI for the directory — matches
// errors.ts/state.ts's existing homedir idiom), so every test uses a randomized,
// unique process id and removes its own fixture files afterward.
// ───────────────────────────────────────────────────────────────────────────────
import { afterEach, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import {
  appendLog,
  clearLastCrash,
  LOG_ROTATION_KEEP,
  LOG_ROTATION_MAX_BYTES,
  logVaultDir,
  readLastCrash,
  recordLastCrash,
  tailLog,
} from "../server/src/log-vault";

const idsToClean = new Set<string>();

function uniqueId(label: string): string {
  const id = `logvault-test.${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  idsToClean.add(id);
  return id;
}

function cleanup(id: string) {
  const dir = logVaultDir();
  for (const suffix of ["", ".1", ".2", ".3"]) {
    const f = path.join(dir, `${id}.log${suffix}`);
    if (existsSync(f)) rmSync(f, { force: true });
  }
  const sidecar = path.join(dir, `${id}.lastcrash.json`);
  if (existsSync(sidecar)) rmSync(sidecar, { force: true });
}

afterEach(() => {
  for (const id of idsToClean) cleanup(id);
  idsToClean.clear();
});

// ---- appendLog / tailLog ---------------------------------------------------

test("tailLog returns [] for a process that hasn't logged anything", () => {
  const id = uniqueId("empty");
  expect(tailLog(id, 50)).toEqual([]);
});

test("appendLog + tailLog round-trip recent lines in order", () => {
  const id = uniqueId("roundtrip");
  appendLog(id, ["line one", "line two"]);
  appendLog(id, ["line three"]);
  expect(tailLog(id, 10)).toEqual(["line one", "line two", "line three"]);
});

test("tailLog caps to the requested line count (most recent last)", () => {
  const id = uniqueId("cap");
  appendLog(
    id,
    Array.from({ length: 30 }, (_, i) => `line ${i}`),
  );
  const tail = tailLog(id, 5);
  expect(tail).toEqual(["line 25", "line 26", "line 27", "line 28", "line 29"]);
});

test("appendLog is a no-op for an empty batch", () => {
  const id = uniqueId("noop");
  appendLog(id, []);
  expect(tailLog(id, 10)).toEqual([]);
});

// ---- rotation ---------------------------------------------------------------

test("log rotates once the current file crosses the size cap, keeping older rotations", () => {
  const id = uniqueId("rotate");
  // Comfortably exceed the ~1MB cap in the FIRST append so the very next append
  // rotates it out to .1 before writing a fresh current file.
  const bigLine = "x".repeat(1000);
  const bigBatch = Array.from(
    { length: Math.ceil(LOG_ROTATION_MAX_BYTES / 1000) + 10 },
    () => bigLine,
  );
  appendLog(id, bigBatch); // current file now >= MAX_BYTES
  appendLog(id, ["fresh line after rotation"]); // should rotate old -> .1, start a new current file

  const dir = logVaultDir();
  expect(existsSync(path.join(dir, `${id}.log`))).toBe(true);
  expect(existsSync(path.join(dir, `${id}.log.1`))).toBe(true);

  // The tail should still surface the newest line (from the fresh current file).
  const tail = tailLog(id, 5);
  expect(tail.at(-1)).toBe("fresh line after rotation");
});

test("rotation keeps only LOG_ROTATION_KEEP older files — the oldest is dropped", () => {
  const id = uniqueId("rotate-cap");
  const bigLine = "x".repeat(1000);
  const bigBatch = Array.from(
    { length: Math.ceil(LOG_ROTATION_MAX_BYTES / 1000) + 10 },
    () => bigLine,
  );

  // Force rotation LOG_ROTATION_KEEP + 2 times so the oldest rotation gets pushed
  // past the keep limit and discarded.
  for (let i = 0; i < LOG_ROTATION_KEEP + 2; i++) {
    appendLog(id, bigBatch);
    appendLog(id, [`marker-${i}`]); // small append that triggers the NEXT rotation check
  }

  const dir = logVaultDir();
  expect(existsSync(path.join(dir, `${id}.log`))).toBe(true);
  expect(existsSync(path.join(dir, `${id}.log.${LOG_ROTATION_KEEP}`))).toBe(true);
  expect(existsSync(path.join(dir, `${id}.log.${LOG_ROTATION_KEEP + 1}`))).toBe(false);
});

// ---- last-crash sidecar ------------------------------------------------------

test("readLastCrash returns null when nothing has been recorded", () => {
  const id = uniqueId("no-crash");
  expect(readLastCrash(id)).toBeNull();
});

test("recordLastCrash + readLastCrash round-trip exit code and stderr tail", () => {
  const id = uniqueId("crash");
  const before = Date.now();
  recordLastCrash(id, 1, ["Error: ECONNREFUSED 127.0.0.1:5432", "    at Socket.<anonymous>"]);
  const crash = readLastCrash(id);
  expect(crash).not.toBeNull();
  expect(crash?.exitCode).toBe(1);
  expect(crash?.endedAt).toBeGreaterThanOrEqual(before);
  expect(crash?.stderrTail).toEqual([
    "Error: ECONNREFUSED 127.0.0.1:5432",
    "    at Socket.<anonymous>",
  ]);
});

test("recordLastCrash truncates the stderr tail to the last N lines", () => {
  const id = uniqueId("crash-truncate");
  const lines = Array.from({ length: 40 }, (_, i) => `stderr line ${i}`);
  recordLastCrash(id, 1, lines);
  const crash = readLastCrash(id);
  expect(crash?.stderrTail.length).toBeLessThanOrEqual(20);
  expect(crash?.stderrTail.at(-1)).toBe("stderr line 39");
});

test("clearLastCrash removes a recorded crash", () => {
  const id = uniqueId("crash-clear");
  recordLastCrash(id, 1, ["boom"]);
  expect(readLastCrash(id)).not.toBeNull();
  clearLastCrash(id);
  expect(readLastCrash(id)).toBeNull();
});

test("clearLastCrash on a process with no recorded crash is a harmless no-op", () => {
  const id = uniqueId("crash-clear-noop");
  expect(() => clearLastCrash(id)).not.toThrow();
  expect(readLastCrash(id)).toBeNull();
});
