// Tests for the shared portable-window opener (SHARED LunarWerx server-lib — source of truth:
// lunarwerx-ui/src/server-lib/portable-window.test.ts, synced by sync.mjs into each app's
// `serverTests` dir under a `server-lib/` subdir next to the app's server tree). The
// `../../src/portable-window.mjs` import resolves only from that synced location — sync.mjs
// validates the placement — so this file is NOT runnable inside the kit repo itself.
//
// Scope note: openPortableWindow SPAWNS a real, detached browser window — an intolerable side
// effect in an automated run — so it is deliberately NOT exercised here. Only the pure,
// read-only resolver (existsSync probing, no process spawn) is tested. Its contract holds on
// every host: it returns a real, existing Chromium-family executable, or null when none is
// installed (a valid outcome on a headless CI box).
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolveChromiumBrowser } from "../../src/portable-window.mjs";

const KNOWN_NAMES = [
  "msedge",
  "chrome",
  "chromium",
  "chromium-browser",
  "google-chrome",
  "google-chrome-stable",
  "microsoft-edge",
];

test("resolveChromiumBrowser returns null, or a real existing executable with a known name", () => {
  const found = resolveChromiumBrowser();
  if (found === null) return; // no Chromium-family browser on this host — a valid result
  expect(KNOWN_NAMES).toContain(found.name);
  expect(typeof found.path).toBe("string");
  expect(found.path.length).toBeGreaterThan(0);
  expect(existsSync(found.path)).toBe(true);
});
