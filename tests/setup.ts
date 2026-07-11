// Bun test preload (wired in bunfig.toml). Points DEVWEBUI_HOME at a throwaway temp dir so the
// suite never reads or writes the REAL ~/.devwebui. Every module that touches the data dir goes
// through server/src/data-dir.ts's dataDir(), which honors this override — state.json, the
// registry, logs, errors.ndjson, runtime.json, settings.json, connections.json all land here.
// Without this, a test that spins up a real Manager persists synthetic error records into the
// live user's error log (a phantom "N errors" count in the GUI) and toggle tests flip the real
// machine's autostart state.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "bun:test";

const home = mkdtempSync(path.join(os.tmpdir(), "devwebui-test-"));
process.env.DEVWEBUI_HOME = home;

// Remove this run's throwaway data dir once every test has finished, so the `devwebui-test-*`
// dirs don't pile up in %TEMP% across runs. A global afterAll registered from the preload is
// the test-runner-native hook (Bun's `bun test` does NOT reliably emit Node's `process.exit`
// event, so an exit handler wouldn't fire). Each run owns a uniquely-named dir and deletes only
// its own — never a sibling's — so concurrent test processes can't clobber each other.
afterAll(() => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* best-effort — the OS temp cleaner reclaims anything left behind */
  }
});
