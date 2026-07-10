// ---------------------------------------------------------------------------
// Running-instance pointer — thin per-app adapter over the shared kit factory
// (`createInstancePointer`, synced in as `./instance-pointer.mjs`). The only local
// code is DevWebUI's ~/.devwebui config-dir resolution and its host. The daemon
// records the port it ACTUALLY bound in runtime.json so launchers and the
// /api/health probe can find it and enforce single-instance. Best-effort throughout.
// ---------------------------------------------------------------------------
import os from "node:os";
import path from "node:path";
import { createInstancePointer, type InstanceInfo } from "./instance-pointer.mjs";

export type { InstanceInfo };

const pointer = createInstancePointer({
  // DEVWEBUI_HOME overrides the config dir so tests (and side-by-side instances) don't touch the
  // real ~/.devwebui runtime pointer; see tests/setup.ts.
  configDir: process.env.DEVWEBUI_HOME?.trim() || path.join(os.homedir(), ".devwebui"),
  host: "localhost",
});

export const instanceFilePath = pointer.instanceFilePath;
export const writeInstanceInfo = pointer.writeInstanceInfo;
export const readInstanceInfo = pointer.readInstanceInfo;
export const clearInstanceInfo = pointer.clearInstanceInfo;
export const findLiveInstance = pointer.findLiveInstance;
