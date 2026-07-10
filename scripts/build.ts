#!/usr/bin/env bun
/**
 * Build a distributable DevWebUI bundle into `dist/`:
 *   dist/devwebui[.exe]   — the compiled daemon (bun --compile, single self-contained binary)
 *   dist/web/dist/...     — the built GUI, served by the daemon at runtime (resolved next to the
 *                           binary; see server/src/http/index.ts distCandidates)
 *
 * Mirrors the same build script pattern used by sibling LunarWerx daemons. DevWebUI has no
 * native-FFI deps, so nothing is kept `--external` and there's no vendored binary to copy —
 * a clean single-file compile.
 * Run: `bun run scripts/build.ts`  (or `bun run dist`)
 */
import { $ } from "bun";
import { rmSync, mkdirSync, cpSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const isWin = process.platform === "win32";
const outBin = join(DIST, isWin ? "devwebui.exe" : "devwebui");

console.log("→ clean dist/");
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

console.log("→ build web (check:i18n + vue-tsc + vite)");
await $`bun run --cwd ${join(ROOT, "web")} build`;

console.log("→ compile daemon (bun --compile)");
await $`bun build --compile --minify ${join(ROOT, "server", "src", "index.ts")} --outfile ${outBin}`;

console.log("→ copy web assets next to the binary");
mkdirSync(join(DIST, "web"), { recursive: true });
cpSync(join(ROOT, "web", "dist"), join(DIST, "web", "dist"), { recursive: true });

console.log(`\n✓ Built ${outBin}`);
console.log(`  Run it:  ${isWin ? "dist\\devwebui.exe" : "./dist/devwebui"}`);
