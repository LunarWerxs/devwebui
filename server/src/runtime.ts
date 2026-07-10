// ---------------------------------------------------------------------------
// Runtime selection — let a process (or a global default) choose whether its
// command runs under Node or Bun. Bun-driven Vite starts faster and lighter
// than Node-driven Vite, so this is the "use the efficient method" lever.
//
// The rewrite is deliberately CONSERVATIVE: it only touches clear node/bun
// invocations and leaves anything it doesn't recognise exactly as written.
//   bun:   `node x`        -> `bun x`            (run the file under Bun)
//          `bun run x`      -> `bun --bun run x`  (force Bun for the script's bins)
//   node:  `bun --bun run x`-> `bun run x`        (back to Node-shebang bins)
//          `bun x.js`       -> `node x.js`        (run the file under Node)
// `npm run …`, `bunx …`, and everything else are left alone.
// ---------------------------------------------------------------------------
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { OS_SKIP, type SkipOs } from "./scan";
import { AUTO_UPDATE_INTERVAL_DEFAULT_S, clampAutoUpdateInterval } from "./auto-update";
import type { RuntimePref, Settings } from "../../shared/dto";

export type { RuntimePref, Settings } from "../../shared/dto";

export type Runtime = "node" | "bun";

export function withRuntime(command: string, runtime?: Runtime): string {
  if (!runtime) return command;
  const m = command.match(/^(\s*)(\S+)(?:\s+(\S+))?/);
  if (!m) return command;
  const ws = m[1];
  const first = m[2];
  const second = m[3];
  const afterFirst = command.slice(ws.length + first.length); // includes leading space

  if (runtime === "bun") {
    if (first === "node" || first === "node.exe") return `${ws}bun${afterFirst}`;
    if (first === "bun" && second === "run")
      return command.replace(/^(\s*)bun(\s+)run\b/, "$1bun$2--bun run");
    return command;
  }
  // runtime === "node"
  if (first === "bun" || first === "bun.exe") {
    if (second === "--bun") return command.replace(/^(\s*)bun(\s+)--bun\b/, "$1bun"); // drop --bun
    if (second === "run") return command; // `bun run x` already uses Node-shebang bins
    // Only rewrite a direct FILE invocation; leave bare shorthands like `bun dev` alone
    // (Node can't run a bare script name).
    if (second && /\.(?:js|cjs|mjs|ts|cts|mts)$/i.test(second)) return `${ws}node${afterFirst}`;
    return command;
  }
  return command;
}

// ---------------------------------------------------------------------------
// Global settings (~/.devwebui/settings.json). The `Settings` shape lives in
// the shared DTOs (re-exported above); the read/write functions stay here.
// ---------------------------------------------------------------------------
const SETTINGS_FILE = path.join(os.homedir(), ".devwebui", "settings.json");
const RUNTIME_PREFS: RuntimePref[] = ["auto", "node", "bun"];

const cleanList = (v: unknown, fallback: string[]): string[] =>
  Array.isArray(v)
    ? [
        ...new Set(
          v
            .map(String)
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean),
        ),
      ]
    : fallback;
const cleanExclude = (v: unknown): string[] =>
  Array.isArray(v)
    ? [
        ...new Set(
          v
            .map(String)
            .map((s) => s.trim())
            .filter(Boolean),
        ),
      ]
    : [];

// The current OS's skip is on by default; the others off. Stored values win.
const skipToggleDefaults = () => ({
  skipWindows: process.platform === "win32",
  skipMac: process.platform === "darwin",
  skipLinux: process.platform === "linux",
});
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);
// A trimmed string setting. A blank value is kept (it means "use the GUI page's own
// hostname"); only a missing/non-string value falls back to the default.
const cleanStr = (v: unknown, fallback: string): string =>
  typeof v === "string" ? v.trim() : fallback;
// Default blank → links use whatever host the GUI was opened on (localhost on the
// same machine, the LAN IP from another device). Set an explicit host to override.
const DEFAULT_LINK_HOST = "";

const readOsSkip = (o: unknown, base: Record<SkipOs, string[]>): Record<SkipOs, string[]> => {
  const src = (o ?? {}) as Partial<Record<SkipOs, unknown>>;
  return {
    windows: cleanList(src.windows, base.windows),
    mac: cleanList(src.mac, base.mac),
    linux: cleanList(src.linux, base.linux),
  };
};

export function readSettings(): Settings {
  const d = skipToggleDefaults();
  try {
    const s = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
    return {
      runtime: RUNTIME_PREFS.includes(s.runtime) ? s.runtime : "auto",
      freePortOnStart: bool(s.freePortOnStart, true),
      autoStartOnLaunch: bool(s.autoStartOnLaunch, false),
      monitorResources: bool(s.monitorResources, true),
      linkHost: cleanStr(s.linkHost, DEFAULT_LINK_HOST),
      autoScan: bool(s.autoScan, true),
      scanExclude: cleanExclude(s.scanExclude),
      skipWindows: bool(s.skipWindows, d.skipWindows),
      skipMac: bool(s.skipMac, d.skipMac),
      skipLinux: bool(s.skipLinux, d.skipLinux),
      osSkip: readOsSkip(s.osSkip, OS_SKIP),
      pulseInstallId:
        typeof s.pulseInstallId === "string"
          ? s.pulseInstallId
          : typeof s.analyticsInstallId === "string"
            ? s.analyticsInstallId
            : undefined,
      autoUpdate: bool(s.autoUpdate, false),
      autoUpdateIntervalSecs: Number.isFinite(s.autoUpdateIntervalSecs)
        ? clampAutoUpdateInterval(s.autoUpdateIntervalSecs)
        : AUTO_UPDATE_INTERVAL_DEFAULT_S,
    };
  } catch {
    return {
      runtime: "auto",
      freePortOnStart: true,
      autoStartOnLaunch: false,
      monitorResources: true,
      linkHost: DEFAULT_LINK_HOST,
      autoScan: true,
      scanExclude: [],
      ...d,
      osSkip: readOsSkip(null, OS_SKIP),
      autoUpdate: false,
      autoUpdateIntervalSecs: AUTO_UPDATE_INTERVAL_DEFAULT_S,
    };
  }
}

/** Merge a partial patch into the saved settings and persist the result. */
export function writeSettings(patch: Partial<Settings>): Settings {
  const cur = readSettings();
  const next: Settings = {
    runtime:
      patch.runtime !== undefined && RUNTIME_PREFS.includes(patch.runtime)
        ? patch.runtime
        : cur.runtime,
    freePortOnStart: bool(patch.freePortOnStart, cur.freePortOnStart),
    autoStartOnLaunch: bool(patch.autoStartOnLaunch, cur.autoStartOnLaunch),
    monitorResources: bool(patch.monitorResources, cur.monitorResources),
    linkHost: patch.linkHost !== undefined ? cleanStr(patch.linkHost, cur.linkHost) : cur.linkHost,
    autoScan: patch.autoScan !== undefined ? !!patch.autoScan : cur.autoScan,
    scanExclude:
      patch.scanExclude !== undefined ? cleanExclude(patch.scanExclude) : cur.scanExclude,
    skipWindows: bool(patch.skipWindows, cur.skipWindows),
    skipMac: bool(patch.skipMac, cur.skipMac),
    skipLinux: bool(patch.skipLinux, cur.skipLinux),
    osSkip: patch.osSkip !== undefined ? readOsSkip(patch.osSkip, cur.osSkip) : cur.osSkip,
    pulseInstallId:
      typeof patch.pulseInstallId === "string" ? patch.pulseInstallId : cur.pulseInstallId,
    autoUpdate: bool(patch.autoUpdate, cur.autoUpdate),
    autoUpdateIntervalSecs:
      patch.autoUpdateIntervalSecs !== undefined
        ? clampAutoUpdateInterval(patch.autoUpdateIntervalSecs)
        : cur.autoUpdateIntervalSecs,
  };
  mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  const tmp = `${SETTINGS_FILE}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(tmp, SETTINGS_FILE);
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best-effort temp cleanup */
    }
    throw e;
  }
  return next;
}

/** Ensure the on-disk file contains every key (incl. osSkip) so users can discover + hand-edit them. */
export function materializeSettings(): void {
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
    if (raw && typeof raw === "object" && raw.osSkip) return; // already complete
  } catch {
    /* missing or invalid — (re)write below */
  }
  writeSettings({});
}

/** Resolve the effective runtime for a process given its pin + the global default. */
export function effectiveRuntime(
  processRuntime: Runtime | undefined,
  global: RuntimePref,
): Runtime | undefined {
  if (processRuntime) return processRuntime;
  return global === "auto" ? undefined : global;
}
