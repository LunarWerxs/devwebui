import path from "node:path";
import { fileURLToPath } from "node:url";
import { createUpdater } from "./updater-engine.mjs";
import type { UpdateApplyResult, UpdateStatus } from "../../shared/dto";

// Thin per-app adapter over the shared kit updater engine (synced in as
// updater-engine.mjs). All the git / spawn / ls-remote / apply logic lives there;
// only DevWebUI's checkout root, update-remote env var, install/build commands, and
// service identity are local. The engine's UpdateStatus.service is `string`; it is
// narrowed back to DevWebUI's DTO here (the runtime value already is "devwebui").
const engine = createUpdater({
  appRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
  serviceName: "devwebui",
  appLabel: "DevWebUI",
  updateRepoEnvVar: "DEVWEBUI_UPDATE_REPO",
  installCmd: ["bun", "install"],
  buildCmd: ["bun", "run", "build"],
});

export const checkForUpdate = engine.checkForUpdate as () => Promise<UpdateStatus>;
export const applyUpdate = engine.applyUpdate as () => Promise<UpdateApplyResult>;
