#!/usr/bin/env bun
/**
 * devwebui CLI — one installable command so humans, scripts, and AI agents can run and drive
 * DevWebUI without typing `bun run <script>` or speaking raw HTTP/MCP.
 *
 * It's a THIN wrapper over the daemon's existing REST API (the same surface the GUI and the MCP
 * server already use — see shared/routes.ts) plus a launcher for the daemon itself. Nothing here
 * reimplements the manager; lifecycle/status/list/process verbs just drive the running daemon over
 * loopback HTTP, exactly like server/src/mcp.ts does. Modeled on the same thin-CLI-over-daemon
 * pattern used by sibling LunarWerx daemons.
 *
 *   devwebui start [--port N] [--foreground]   boot the daemon (detached by default; prints the URL)
 *   devwebui stop                              graceful shutdown of the running daemon
 *   devwebui status [--json]                   is it running + where + a project/process summary
 *   devwebui list | ps [--json]                list managed processes (id · name · status · port)
 *   devwebui start-process   <id|name>         start / stop / restart / enable / disable one process
 *   devwebui stop-process    <id|name>
 *   devwebui restart-process <id|name>
 *   devwebui enable-process  <id|name>
 *   devwebui disable-process <id|name>
 *   devwebui start-all | stop-all              start / stop every managed process
 *   devwebui mcp                               run the stdio MCP server for AI agents
 *
 * Connection resolution matches mcp.ts: DEVWEBUI_URL > DEVWEBUI_PORT > ~/.devwebui/runtime.json
 * pointer > default port. Bin entry is wired in package.json ("bin": { "devwebui": ... }).
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROUTES } from "../../shared/routes";
import { daemonUrl } from "../../shared/constants";
import { findLiveInstance, readInstanceInfo, type InstanceInfo } from "./instance";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", ".."); // server/src/cli.ts → repo root
const INDEX_TS = path.join(REPO_ROOT, "server", "src", "index.ts");

// ── tiny arg parser (positionals + --flags; --key=val or --key val or bare boolean) ──────────
interface Args {
  _: string[];
  [k: string]: string | boolean | string[];
}
function parseArgs(argv: string[]): Args {
  const out: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    } else if (a === "-f") out.foreground = true;
    else out._.push(a);
  }
  return out;
}

class UsageError extends Error {}

// ── connection to a running daemon ────────────────────────────────────────────────────────────
/** Base URL of the running daemon (env override → instance pointer → default). Matches mcp.ts. */
function base(): string {
  if (process.env.DEVWEBUI_URL) return process.env.DEVWEBUI_URL;
  if (process.env.DEVWEBUI_PORT) return `http://localhost:${process.env.DEVWEBUI_PORT}`;
  return readInstanceInfo()?.url ?? daemonUrl();
}

async function api<T = unknown>(pathname: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base()}${pathname}`, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`daemon ${res.status}: ${text || res.statusText}`);
  return (text ? JSON.parse(text) : {}) as T;
}

/** Require a live daemon and return its instance info, else a friendly error. */
async function requireLive(): Promise<InstanceInfo> {
  const live = await findLiveInstance();
  if (!live) throw new UsageError("DevWebUI isn't running. Start it with:  devwebui start");
  return live;
}

// ── process/project view shapes (subset of server/src/process-view.ts) ────────────────────────
interface ProcessView {
  id: string;
  localId: string;
  name: string;
  port: number | null;
  projectId: string;
  projectName: string;
  status: string;
}
interface ProjectView {
  id: string;
  name: string;
  processes: ProcessView[];
}

// ── output helpers ────────────────────────────────────────────────────────────────────────────
function table(rows: string[][]): string {
  if (!rows.length) return "";
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => (r[c] ?? "").length)));
  return rows.map((r) => r.map((cell, c) => (cell ?? "").padEnd(widths[c]!)).join("  ")).join("\n");
}

function printProcesses(procs: ProcessView[]): void {
  if (!procs.length) {
    console.log("No managed processes. Load a project's .devwebui file in the GUI first.");
    return;
  }
  const rows = [["STATUS", "NAME", "PORT", "PROJECT", "ID"]];
  for (const p of procs) {
    rows.push([p.status, p.name, p.port ? String(p.port) : "-", p.projectName, p.id]);
  }
  console.log(table(rows));
}

/** Resolve a user-supplied process reference (id, name, localId, or "project:local") to its id. */
async function resolveProcessId(ref: string): Promise<string> {
  const procs = await api<ProcessView[]>(ROUTES.processes);
  const exact = procs.find((p) => p.id === ref);
  if (exact) return exact.id;
  const low = ref.toLowerCase();
  const matches = procs.filter(
    (p) =>
      p.name.toLowerCase() === low ||
      p.localId.toLowerCase() === low ||
      `${p.projectName}:${p.localId}`.toLowerCase() === low,
  );
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length > 1) {
    throw new UsageError(
      `"${ref}" matches ${matches.length} processes — use the full id:\n` +
        matches.map((p) => `  ${p.id}  (${p.projectName} · ${p.name})`).join("\n"),
    );
  }
  throw new UsageError(`No process matches "${ref}". Run \`devwebui list\` to see them.`);
}

// ── verbs ──────────────────────────────────────────────────────────────────────────────────────
async function startCmd(args: Args): Promise<void> {
  const live = await findLiveInstance();
  if (live) {
    console.log(`DevWebUI is already running  →  ${live.url}`);
    return;
  }
  const env = { ...process.env };
  if (typeof args.port === "string") env.DEVWEBUI_PORT = args.port;
  // process.execPath (the real bun binary) rather than "bun" — on Windows "bun" may be a .cmd
  // shim CreateProcess can't spawn directly. Same reason as server/src/dev.ts.

  // Foreground: run the daemon attached (inherit stdio + await) — behaves like `bun server/src/index.ts`.
  if (args.foreground) {
    const child = spawn(process.execPath, [INDEX_TS], { cwd: REPO_ROOT, env, stdio: "inherit" });
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));
    return;
  }

  // Detached (default): spawn the daemon in the background (detached + unref so it outlives this
  // CLI process), then poll until it answers /api/health and print the URL it actually bound (it
  // may have hopped off a busy port).
  const child = spawn(process.execPath, [INDEX_TS], {
    cwd: REPO_ROOT,
    env,
    stdio: "ignore",
    detached: true,
  });
  child.unref();

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const info = await findLiveInstance(500);
    if (info) {
      console.log(`DevWebUI daemon started  →  ${info.url}  (pid ${info.pid})`);
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    "the daemon didn't come up within 20s — try `devwebui start --foreground` to see why.",
  );
}

async function stopCmd(): Promise<void> {
  const live = await findLiveInstance();
  if (!live) {
    console.log("DevWebUI isn't running.");
    return;
  }
  // The shutdown route accepts the `ui` source header without a token (see http/core.ts).
  const res = await fetch(`${live.url}${ROUTES.shutdown}`, {
    method: "POST",
    headers: { "x-devwebui-shutdown-source": "ui" },
  });
  if (!res.ok) throw new Error(`shutdown refused (${res.status}): ${await res.text()}`);
  console.log(`Stopped DevWebUI (${live.url}).`);
}

async function statusCmd(args: Args): Promise<void> {
  const live = await findLiveInstance();
  if (!live) {
    if (args.json) console.log(JSON.stringify({ running: false }, null, 2));
    else console.log("DevWebUI: not running.  Start it with `devwebui start`.");
    return;
  }
  const [projects, processes] = await Promise.all([
    api<ProjectView[]>(ROUTES.projects).catch(() => [] as ProjectView[]),
    api<ProcessView[]>(ROUTES.processes).catch(() => [] as ProcessView[]),
  ]);
  if (args.json) {
    console.log(JSON.stringify({ running: true, ...live, projects, processes }, null, 2));
    return;
  }
  const running = processes.filter((p) => p.status === "running").length;
  console.log(
    `DevWebUI  →  ${live.url}  (pid ${live.pid})\n` +
      `projects  →  ${projects.length}\n` +
      `processes →  ${processes.length} (${running} running)\n`,
  );
  printProcesses(processes);
}

async function listCmd(args: Args): Promise<void> {
  await requireLive();
  const processes = await api<ProcessView[]>(ROUTES.processes);
  if (args.json) console.log(JSON.stringify(processes, null, 2));
  else printProcesses(processes);
}

async function processActionCmd(action: string, ref: string | undefined): Promise<void> {
  await requireLive();
  if (!ref) throw new UsageError(`Usage: devwebui ${action}-process <id|name>`);
  const id = await resolveProcessId(ref);
  await api(ROUTES.processAction.build(id, action), { method: "POST" });
  console.log(`${action}: ${id}`);
}

async function bulkCmd(route: string, label: string): Promise<void> {
  await requireLive();
  await api(route, { method: "POST" });
  console.log(label);
}

function printHelp(): void {
  console.log(`devwebui — run & drive DevWebUI from the command line

Daemon lifecycle:
  devwebui start [--port N] [--foreground]   Boot the daemon (detached; prints the URL). -f runs attached.
  devwebui stop                              Gracefully stop the running daemon
  devwebui status [--json]                   Running? where? + project/process summary

Drive a running daemon:
  devwebui list | ps [--json]                List managed processes
  devwebui start-process   <id|name>         Start a process
  devwebui stop-process    <id|name>         Stop a process
  devwebui restart-process <id|name>         Restart a process
  devwebui enable-process  <id|name>         Enable (allow autostart) a process
  devwebui disable-process <id|name>         Disable a process
  devwebui start-all | stop-all              Start / stop every managed process
  devwebui mcp                               Run the stdio MCP server (for AI agents)

Connection: DEVWEBUI_URL / DEVWEBUI_PORT override the daemon location.`);
}

export async function main(argv: string[]): Promise<void> {
  const cmd = argv[0] ?? "help";
  const args = parseArgs(argv.slice(1));
  const ref = args._[0];

  switch (cmd) {
    case "start":
      await startCmd(args);
      break;
    case "stop":
      await stopCmd();
      break;
    case "status":
      await statusCmd(args);
      break;
    case "list":
    case "ps":
      await listCmd(args);
      break;
    case "start-process":
      await processActionCmd("start", ref);
      break;
    case "stop-process":
      await processActionCmd("stop", ref);
      break;
    case "restart-process":
      await processActionCmd("restart", ref);
      break;
    case "enable-process":
      await processActionCmd("enable", ref);
      break;
    case "disable-process":
      await processActionCmd("disable", ref);
      break;
    case "start-all":
      await bulkCmd(ROUTES.startAll, "Started all processes.");
      break;
    case "stop-all":
      await bulkCmd(ROUTES.stopAll, "Stopped all processes.");
      break;
    case "mcp":
      // Run the stdio MCP server IN THIS PROCESS (it connects StdioServerTransport on import),
      // so `devwebui mcp` is exactly what a tool-calling agent spawns. Emits only JSON-RPC on stdout.
      await import("./mcp");
      break;
    case "-h":
    case "--help":
    case "help":
      printHelp();
      break;
    default:
      console.error(`Unknown command: ${cmd}\n`);
      printHelp();
      process.exitCode = 1;
  }
}

// Run when invoked as the bin/entrypoint (not when imported by a test).
if (import.meta.main) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(err instanceof UsageError ? msg : `Error: ${msg}`);
    process.exitCode = 1;
  });
}
