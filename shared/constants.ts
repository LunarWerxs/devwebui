// ---------------------------------------------------------------------------
// Single source of truth for the daemon's network + buffering defaults. The
// daemon is authoritative; other surfaces (MCP client, Vite dev proxy, GUI log
// buffer) are documented to match these. Override the port with DEVWEBUI_PORT.
//
// This module is imported from BOTH the Bun daemon (which has @types/node) and
// the web bundle (which deliberately doesn't pull in Node's ambient types — see
// web/tsconfig.app.json). daemonPort()/daemonUrl() read `process.env`, so they
// reach it through a locally-typed `nodeGlobal` cast of `globalThis` rather than
// the ambient Node global, keeping the file typecheckable — and side-effect-free
// at module scope — on both sides. Neither function is ever called from web code.
// ---------------------------------------------------------------------------
type NodeGlobal = { process?: { env: Record<string, string | undefined> } };
const nodeGlobal = globalThis as NodeGlobal;

/** Default port the daemon (REST + SSE + built GUI) listens on. */
export const DEFAULT_DAEMON_PORT = 4000;

/** Resolve the daemon port from the environment, falling back to the default. */
export function daemonPort(): number {
  return Number(nodeGlobal.process?.env.DEVWEBUI_PORT) || DEFAULT_DAEMON_PORT;
}

/** Base URL the MCP client uses to reach the daemon (override with DEVWEBUI_URL). */
export function daemonUrl(): string {
  return nodeGlobal.process?.env.DEVWEBUI_URL || `http://localhost:${daemonPort()}`;
}

/**
 * Per-process log ring-buffer cap. The daemon owns this; the GUI keeps its own
 * SSE-accumulated buffer at the same size (see web/src/store.ts MAX_LOG_LINES).
 */
export const MAX_LOG_LINES = 500;
