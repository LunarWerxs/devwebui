// Bun test preload (wired in bunfig.toml). Points DEVWEBUI_HOME at a throwaway temp dir so the
// suite never reads or writes the REAL ~/.devwebui (errors.ndjson / runtime.json). Without this,
// any test that spins up a real Manager persists synthetic error records into the live user's
// error log — which then surfaces as a phantom "N errors" count in the GUI on the next launch.
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DEVWEBUI_HOME = mkdtempSync(path.join(os.tmpdir(), "devwebui-test-"));
