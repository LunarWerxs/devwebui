import { test, expect, afterEach } from "bun:test";
import {
  runAutoUpdateOnce,
  setAutoUpdateHooks,
  setAutoUpdateEnabled,
  stopAutoUpdate,
  clampAutoUpdateInterval,
  AUTO_UPDATE_INTERVAL_MIN_S,
  AUTO_UPDATE_INTERVAL_MAX_S,
  AUTO_UPDATE_INTERVAL_DEFAULT_S,
} from "../server/src/auto-update.ts";
import type { UpdateApplyResult, UpdateStatus } from "../shared/dto.ts";

// The auto-update orchestrator's decision logic, driven through injected hooks so nothing actually
// pulls git / spawns / exits. Gates applying strictly on updateAvailable && canApply, and only
// relaunches after a successful apply that reports restartRequired.

// Reset the module's hooks + timer state after each case so they don't bleed across tests.
afterEach(() => {
  setAutoUpdateEnabled(false);
  stopAutoUpdate();
  setAutoUpdateHooks({}); // restore the real hooks
});

// A full UpdateStatus with sensible defaults; overrides tweak the fields under test.
function status(over: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    ok: true,
    service: "devwebui",
    currentVersion: "0.1.0",
    currentCommit: "aaaa",
    remoteCommit: "bbbb",
    branch: "main",
    upstream: "origin/main",
    remote: "origin",
    dirty: false,
    updateAvailable: false,
    canApply: false,
    checkedAt: 0,
    reason: null,
    ...over,
  };
}
function applyResult(over: Partial<UpdateApplyResult> = {}): UpdateApplyResult {
  return {
    ok: true,
    message: "updated",
    restartRequired: true,
    status: status({}),
    output: [],
    ...over,
  };
}

test("applies + relaunches when an update is available and applicable", async () => {
  let applied = 0;
  let relaunched = 0;
  setAutoUpdateHooks({
    check: async () => status({ updateAvailable: true, canApply: true }),
    apply: async () => {
      applied++;
      return applyResult({ restartRequired: true });
    },
    relaunch: () => {
      relaunched++;
    },
  });
  const r = await runAutoUpdateOnce();
  expect(r.applied).toBe(true);
  expect(r.relaunched).toBe(true);
  expect(applied).toBe(1);
  expect(relaunched).toBe(1);
});

test("does nothing when already up to date", async () => {
  let applied = 0;
  setAutoUpdateHooks({
    check: async () => status({ updateAvailable: false }),
    apply: async () => {
      applied++;
      return applyResult({});
    },
    relaunch: () => {},
  });
  const r = await runAutoUpdateOnce();
  expect(r.applied).toBe(false);
  expect(r.reason).toBe("up-to-date");
  expect(applied).toBe(0);
});

test("never applies on a dirty tree (canApply false)", async () => {
  let applied = 0;
  let relaunched = 0;
  setAutoUpdateHooks({
    check: async () =>
      status({
        updateAvailable: true,
        canApply: false,
        dirty: true,
        reason: "local changes must be committed or stashed before updating",
      }),
    apply: async () => {
      applied++;
      return applyResult({});
    },
    relaunch: () => {
      relaunched++;
    },
  });
  const r = await runAutoUpdateOnce();
  expect(r.applied).toBe(false);
  expect(applied).toBe(0);
  expect(relaunched).toBe(0);
});

test("does not relaunch when the apply fails", async () => {
  let relaunched = 0;
  setAutoUpdateHooks({
    check: async () => status({ updateAvailable: true, canApply: true }),
    apply: async () => applyResult({ ok: false, message: "build failed" }),
    relaunch: () => {
      relaunched++;
    },
  });
  const r = await runAutoUpdateOnce();
  expect(r.applied).toBe(false);
  expect(r.relaunched).toBe(false);
  expect(relaunched).toBe(0);
});

test("reports the reason when the check itself fails", async () => {
  setAutoUpdateHooks({
    check: async () => status({ ok: false, reason: "no update remote configured" }),
    apply: async () => applyResult({}),
    relaunch: () => {},
  });
  const r = await runAutoUpdateOnce();
  expect(r.applied).toBe(false);
  expect(r.reason).toBe("no update remote configured");
});

test("clampAutoUpdateInterval bounds the cadence", () => {
  expect(clampAutoUpdateInterval(10)).toBe(AUTO_UPDATE_INTERVAL_MIN_S);
  expect(clampAutoUpdateInterval(9_999_999)).toBe(AUTO_UPDATE_INTERVAL_MAX_S);
  expect(clampAutoUpdateInterval(Number.NaN)).toBe(AUTO_UPDATE_INTERVAL_DEFAULT_S);
  expect(clampAutoUpdateInterval(3600)).toBe(3600);
});
