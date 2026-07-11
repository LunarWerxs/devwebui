// ───────────────────────────────────────────────────────────────────────────────
// Hardcore guard for the one-click launcher. The promise to a user is: there is
// ALWAYS a clickable shortcut in the project root that, when run, boots the daemon
// and shows the tray icon. These tests fail LOUD ("thou shalt not pass") the moment
// any link in that chain is missing, uncommitted, mis-wired, or the icon is broken.
//
// The chain:  DevWebUI.lnk (root)  →  wscript  →  misc/DevWebUI.vbs  →
//             misc/DevWebUI-Tray.ps1  →  bun server/src/index.ts  +  misc/DevWebUI.ico
//
// The .lnk itself is gitignored (it stores absolute, per-machine paths), so the
// guarantee is enforced via the COMMITTED machinery that regenerates it
// (Create-Shortcut.ps1) — and, on Windows, by actually regenerating + resolving it
// and by running the tray's headless self-test.
// ───────────────────────────────────────────────────────────────────────────────
import { test, expect } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const MISC = join(ROOT, "misc");
const isWin = process.platform === "win32";

/** Loud assertion — a failure here should read like a stop sign, not a diff. */
function must(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`THOU SHALT NOT PASS — ${msg}`);
}
const read = (p: string): string => readFileSync(p, "utf8");
/** Is this path committed (in git's index)? Untracked files never reach a clone. */
function tracked(relFromRoot: string): boolean {
  return (
    Bun.spawnSync(["git", "ls-files", "--error-unmatch", "--", relFromRoot], { cwd: ROOT })
      .exitCode === 0
  );
}

// The committed pieces that let ANY clone regenerate a working shortcut + tray.
const REQUIRED = [
  "Create-Shortcut.ps1",
  "DevWebUI.vbs",
  "DevWebUI-Tray.ps1",
  "DevWebUI.ico",
] as const;

test("launcher machinery exists, is non-empty, and is COMMITTED (a clone must be able to make the shortcut)", () => {
  for (const name of REQUIRED) {
    const abs = join(MISC, name);
    must(existsSync(abs), `misc/${name} is MISSING — the tray launcher is incomplete`);
    must(statSync(abs).size > 0, `misc/${name} is EMPTY`);
    must(
      tracked(`misc/${name}`),
      `misc/${name} is NOT committed to git — a fresh clone would have NO shortcut or tray. Run: git add misc/`,
    );
  }
});

test("the tray icon is a real .ico file (so the tray icon can't silently be broken)", () => {
  const buf = readFileSync(join(MISC, "DevWebUI.ico"));
  // ICO header: reserved=0x0000, type=0x0001(icon), count>=1.
  const headerOk = buf.length > 6 && buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0;
  const count = buf.length > 6 ? buf[4]! | (buf[5]! << 8) : 0;
  must(
    headerOk && count >= 1,
    `misc/DevWebUI.ico is not a valid icon (bad header / 0 images) — the tray icon would be broken`,
  );
  // The Windows tray needs a SMALL frame (16/24/32/48). A 256-only icon renders BLANK in
  // the tray (the classic "tray icon is broken"). Walk the ICONDIR and require a <=48px
  // frame. Each 16-byte ICONDIRENTRY starts at 6 + i*16; byte 0 is the width (0 => 256).
  const frames: number[] = [];
  for (let i = 0; i < count; i++) {
    const w = buf[6 + i * 16]!;
    frames.push(w === 0 ? 256 : w);
  }
  must(
    frames.some((w) => w >= 1 && w <= 48),
    `misc/DevWebUI.ico has no small (<=48px) frame (frames: ${frames.join(",")}) — a 256-only icon renders blank in the tray`,
  );
});

test("launcher chain is wired: shortcut → wscript → DevWebUI.vbs → DevWebUI-Tray.ps1 → daemon + icon", () => {
  const cs = read(join(MISC, "Create-Shortcut.ps1"));
  must(/wscript/i.test(cs), "Create-Shortcut.ps1 doesn't launch via wscript");
  must(/DevWebUI\.vbs/.test(cs), "Create-Shortcut.ps1 doesn't point the shortcut at DevWebUI.vbs");
  must(/DevWebUI\.ico/.test(cs), "Create-Shortcut.ps1 doesn't set the tray icon");
  must(/DevWebUI\.lnk/.test(cs), "Create-Shortcut.ps1 doesn't write a DevWebUI.lnk in the root");

  const vbs = read(join(MISC, "DevWebUI.vbs"));
  must(
    /DevWebUI-Tray\.ps1/.test(vbs),
    "DevWebUI.vbs doesn't launch the tray host DevWebUI-Tray.ps1",
  );

  const tray = read(join(MISC, "DevWebUI-Tray.ps1"));
  must(
    /server[\\/]src[\\/]index\.ts/.test(tray),
    "DevWebUI-Tray.ps1 doesn't start the daemon (server/src/index.ts)",
  );
  must(/DevWebUI\.ico/.test(tray), "DevWebUI-Tray.ps1 doesn't load the tray icon DevWebUI.ico");

  const trayVisibleIdx = tray.indexOf("$tray.Visible = $true");
  const existingIdx = tray.indexOf("$existing = Get-RunningUrl");
  const startIdx = tray.indexOf("$startProc = Start-DevWebUI");
  must(trayVisibleIdx >= 0, "DevWebUI-Tray.ps1 never makes the tray icon visible");
  must(existingIdx >= 0, "DevWebUI-Tray.ps1 doesn't check for an existing daemon");
  must(startIdx >= 0, "DevWebUI-Tray.ps1 doesn't launch the daemon through Start-DevWebUI");
  must(
    trayVisibleIdx < existingIdx && trayVisibleIdx < startIdx,
    "DevWebUI-Tray.ps1 can launch/open DevWebUI before the tray icon exists",
  );

  const existingBlock = tray.match(
    /\$existing = Get-RunningUrl[\s\S]*?if \(\$existing\)\s*\{([\s\S]*?)\}\s*else\s*\{/,
  );
  must(existingBlock, "DevWebUI-Tray.ps1 doesn't attach an existing daemon through the tray");
  must(
    !/\breturn\b|Start-Process/.test(existingBlock[1] ?? ""),
    "DevWebUI-Tray.ps1 exits before creating a tray icon when a daemon is already running",
  );
  must(
    /DEVWEBUI_TRAY_SHUTDOWN_TOKEN/.test(tray),
    "DevWebUI-Tray.ps1 doesn't pass a tray shutdown token to the daemon",
  );
  must(/\/api\/shutdown/.test(tray), "DevWebUI-Tray.ps1 doesn't request daemon shutdown");
  must(
    /x-devwebui-shutdown-token/.test(tray),
    "DevWebUI-Tray.ps1 doesn't authorize daemon shutdown requests",
  );
});

test("Portable mode: DevWebUI-Tray.ps1 opens the app UI through Open-AppUi, not a bare Start-Process", () => {
  const tray = read(join(MISC, "DevWebUI-Tray.ps1"));
  must(
    /function Resolve-ChromiumBrowser/.test(tray),
    "DevWebUI-Tray.ps1 is missing Resolve-ChromiumBrowser",
  );
  must(/function Open-AppUi/.test(tray), "DevWebUI-Tray.ps1 is missing Open-AppUi");
  must(/--app=\$url/.test(tray), "Open-AppUi doesn't launch a chromeless --app= window");
  must(
    /\.portableMode/.test(tray),
    "Open-AppUi doesn't read the portableMode field from runtime.json",
  );
  must(
    /--user-data-dir=/.test(tray),
    "Open-AppUi doesn't give the portable window a dedicated profile via --user-data-dir",
  );
  must(
    /portable-profile/.test(tray),
    "Open-AppUi doesn't derive the shared portable-profile dir from runtime.json's location",
  );
  // Every place the tray used to open a browser directly must now go through Open-AppUi,
  // so a running daemon's portableMode setting is honoured everywhere the UI can be opened.
  const bareOpens = tray.match(/(?<!Open-AppUi \$?)Start-Process \$script:url/g);
  must(
    !bareOpens,
    `DevWebUI-Tray.ps1 still opens the UI via a bare Start-Process, bypassing Open-AppUi: ${JSON.stringify(bareOpens)}`,
  );
});

// ── Windows-only runtime proofs (the tray is Windows-only) ────────────────────────

test.skipIf(!isWin)(
  "tray self-test passes: bun on PATH + daemon entry + the icon LOADS into a real NotifyIcon",
  () => {
    const r = Bun.spawnSync(
      [
        "powershell",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(MISC, "DevWebUI-Tray.ps1"),
        "-SelfTest",
      ],
      { cwd: ROOT },
    );
    const out = (r.stdout?.toString() ?? "") + (r.stderr?.toString() ?? "");
    must(
      out.includes("DEVWEBUI_TRAY_SELFTEST_OK"),
      `the tray self-test did not pass:\n${out.trim()}`,
    );
    must(r.exitCode === 0, `tray self-test exit code ${r.exitCode}:\n${out.trim()}`);
  },
);

test.skipIf(!isWin)(
  "a root shortcut can be (re)generated and resolves to the tray launcher + icon",
  () => {
    // Regenerate the root shortcut — gitignored + per-machine, so this is the canonical
    // way "there is always a shortcut in the root". Then resolve it and prove every hop.
    const gen = Bun.spawnSync(
      [
        "powershell",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(MISC, "Create-Shortcut.ps1"),
      ],
      { cwd: ROOT },
    );
    must(gen.exitCode === 0, `Create-Shortcut.ps1 failed:\n${gen.stderr?.toString()?.trim()}`);

    const lnk = join(ROOT, "DevWebUI.lnk");
    must(existsSync(lnk), "no DevWebUI.lnk in the project root after running Create-Shortcut.ps1");

    const resolve = [
      `$ws = New-Object -ComObject WScript.Shell;`,
      `$s = $ws.CreateShortcut('${lnk.replace(/'/g, "''")}');`,
      `$icon = ($s.IconLocation -split ',')[0];`,
      `$arg = $s.Arguments.Trim([char]34);`,
      `[pscustomobject]@{ target=$s.TargetPath; args=$s.Arguments; iconExists=[bool](Test-Path $icon); vbsExists=[bool](Test-Path $arg) } | ConvertTo-Json -Compress`,
    ].join(" ");
    const r = Bun.spawnSync(["powershell", "-NoProfile", "-Command", resolve], { cwd: ROOT });
    const info = JSON.parse((r.stdout?.toString() ?? "{}").trim()) as {
      target: string;
      args: string;
      iconExists: boolean;
      vbsExists: boolean;
    };
    must(/wscript/i.test(info.target), `shortcut target isn't wscript: ${info.target}`);
    must(/DevWebUI\.vbs/i.test(info.args), `shortcut doesn't launch DevWebUI.vbs: ${info.args}`);
    must(info.vbsExists, "shortcut points at a DevWebUI.vbs that doesn't exist");
    must(info.iconExists, "shortcut's tray icon (DevWebUI.ico) doesn't exist");
    expect(info.iconExists && info.vbsExists).toBe(true);
  },
);
