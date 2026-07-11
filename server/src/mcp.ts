// DevWebUI MCP server (stdio) — a thin client over the running daemon's REST API, so the GUI,
// the CLI, and agents share one source of truth. Start the daemon first (`devwebui start`);
// point elsewhere with DEVWEBUI_URL / DEVWEBUI_PORT.
//
// The JSON-RPC 2.0 / MCP protocol + the stdio loop live in the SHARED, zero-dependency engine
// `./mcp-stdio.mjs` (part of the shared kit — edit it there, never here). This file is
// only the app-specific part: an HTTP client + a tool table, each tool a 1:1 wrapper over a
// ROUTES.* endpoint. Replaces the previous @modelcontextprotocol/sdk-based server (dep dropped).
import { daemonUrl } from "./constants";
import { readInstanceInfo } from "./instance";
import { ROUTES } from "../../shared/routes";
import { runMcpStdio } from "./mcp-stdio.mjs";
import type { McpEngineTool } from "./mcp-stdio.mjs";

// Resolve the base URL per call: an explicit DEVWEBUI_URL/DEVWEBUI_PORT always wins, else follow
// the port the daemon ACTUALLY bound (~/.devwebui/runtime.json), so an auto-hopped port still works.
function daemonBase(): string {
  if (process.env.DEVWEBUI_URL) return process.env.DEVWEBUI_URL;
  if (process.env.DEVWEBUI_PORT) return `http://localhost:${process.env.DEVWEBUI_PORT}`;
  return readInstanceInfo()?.url ?? daemonUrl();
}

async function api(pathname: string, init?: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${daemonBase()}${pathname}`, init);
  } catch (e) {
    throw new Error(
      `couldn't reach the DevWebUI daemon at ${daemonBase()} — start it with \`devwebui start\`. (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  if (!res.ok) throw new Error(`DevWebUI ${res.status}: ${await res.text()}`);
  return res.json();
}

// JSON Schema helper (the engine advertises each tool's `inputSchema` verbatim in tools/list).
const S = (properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: "object" as const,
  properties,
  required,
  additionalProperties: false,
});
const JSON_HEADERS = { "content-type": "application/json" };
const str = (v: unknown): string => String(v ?? "");

const TOOLS: McpEngineTool[] = [
  {
    name: "list_projects",
    description: "List loaded projects (codebases), each with its processes and live status.",
    inputSchema: S(),
    run: () => api(ROUTES.projects),
  },
  {
    name: "load_project",
    description:
      "Load a .devwebui file by absolute path (registers its processes and remembers it).",
    inputSchema: S({ path: { type: "string" } }, ["path"]),
    run: (a) =>
      api(ROUTES.projectsLoad, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ path: a.path }),
      }),
  },
  {
    name: "remove_project",
    description: "Unload a project by id (stops its processes and forgets it).",
    inputSchema: S({ id: { type: "string" } }, ["id"]),
    run: (a) => api(ROUTES.projectAction.build(str(a.id), "remove"), { method: "POST" }),
  },
  {
    name: "list_processes",
    description:
      "List every managed dev-server process with its live status, pid, uptime, CPU and memory.",
    inputSchema: S(),
    run: () => api(ROUTES.processes),
  },
  {
    name: "start_process",
    description:
      "Start a managed process by id. Its linked processes (`links`) and the project's companion processes start with it.",
    inputSchema: S({ id: { type: "string" } }, ["id"]),
    run: (a) => api(ROUTES.processAction.build(str(a.id), "start"), { method: "POST" }),
  },
  {
    name: "stop_process",
    description:
      "Stop a managed process by id. Its linked processes (`links`) stop with it; companions are left running.",
    inputSchema: S({ id: { type: "string" } }, ["id"]),
    run: (a) => api(ROUTES.processAction.build(str(a.id), "stop"), { method: "POST" }),
  },
  {
    name: "restart_process",
    description: "Restart a managed process by id.",
    inputSchema: S({ id: { type: "string" } }, ["id"]),
    run: (a) => api(ROUTES.processAction.build(str(a.id), "restart"), { method: "POST" }),
  },
  {
    name: "start_all",
    description: "Start every managed process.",
    inputSchema: S(),
    run: () => api(ROUTES.startAll, { method: "POST" }),
  },
  {
    name: "stop_all",
    description: "Stop every managed process.",
    inputSchema: S(),
    run: () => api(ROUTES.stopAll, { method: "POST" }),
  },
  {
    name: "get_logs",
    description: "Get recent log lines for a process (most recent last).",
    inputSchema: S({ id: { type: "string" }, limit: { type: "number" } }, ["id"]),
    run: async (a) => {
      const data = (await api(ROUTES.processLogs.build(str(a.id)))) as {
        id: string;
        lines: unknown[];
      };
      if (typeof a.limit === "number" && Array.isArray(data.lines))
        data.lines = data.lines.slice(-a.limit);
      return data;
    },
  },
  {
    name: "list_errors",
    description:
      "List the de-duplicated record of process errors (stderr / crashes / error-looking stdout), most recent first.",
    inputSchema: S(),
    run: () => api(ROUTES.errors),
  },
  {
    name: "clear_errors",
    description: "Clear the recorded error log (optionally for a single process id).",
    inputSchema: S({ processId: { type: "string" } }),
    run: (a) =>
      api(
        `${ROUTES.errorsClear}${a.processId ? `?processId=${encodeURIComponent(str(a.processId))}` : ""}`,
        { method: "POST" },
      ),
  },
  {
    name: "enable_process",
    description:
      "Enable a process (turn it on) and start it; the on/off choice persists across daemon restarts.",
    inputSchema: S({ id: { type: "string" } }, ["id"]),
    run: (a) => api(ROUTES.processAction.build(str(a.id), "enable"), { method: "POST" }),
  },
  {
    name: "disable_process",
    description:
      "Disable a process (turn it off) and stop it; it stays off across daemon restarts until re-enabled.",
    inputSchema: S({ id: { type: "string" } }, ["id"]),
    run: (a) => api(ROUTES.processAction.build(str(a.id), "disable"), { method: "POST" }),
  },
  {
    name: "enable_project",
    description:
      "Enable every process in a project (turn the whole codebase on) and start them; persists across restarts.",
    inputSchema: S({ id: { type: "string" } }, ["id"]),
    run: (a) => api(ROUTES.projectAction.build(str(a.id), "enable"), { method: "POST" }),
  },
  {
    name: "disable_project",
    description:
      "Disable every process in a project (turn the whole codebase off) and stop them; persists across restarts.",
    inputSchema: S({ id: { type: "string" } }, ["id"]),
    run: (a) => api(ROUTES.projectAction.build(str(a.id), "disable"), { method: "POST" }),
  },
  {
    name: "diagnose_process",
    description:
      "Incident Autopilot: correlate a process's exit code, its de-duped error log, live port ownership, and its configured script/command into a structured root-cause guess (rootCause, confidence, evidence) plus a SUGGESTED remediation (never auto-executed — you decide whether to act on it).",
    inputSchema: S({ id: { type: "string" } }, ["id"]),
    run: (a) => api(ROUTES.processDiagnose.build(str(a.id))),
  },
  {
    name: "take_over_autostart",
    description:
      "Retire a repo's EXTERNAL dev-server auto-start (VS Code tasks.json runOn:folderOpen, the 'Vite' extension's vite.autoStart) so DevWebUI is the sole launcher. Backs each edited file up first. Pass the project FOLDER (absolute path).",
    inputSchema: S({ dir: { type: "string" } }, ["dir"]),
    run: (a) =>
      api(ROUTES.projectsTakeOver, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ dir: a.dir }),
      }),
  },
];

await runMcpStdio({ serverInfo: { name: "devwebui", version: "0.1.0" }, tools: TOOLS });
