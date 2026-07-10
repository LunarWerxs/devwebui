import type { ChildProcess } from "node:child_process";
import { MAX_LOG_LINES } from "../constants";
import type { LogLine, ProcessDef, Status } from "../types";

export const MAX_LOGS = MAX_LOG_LINES;
export const TICK_INTERVAL = 2000; // TCP port probes + error flush
export const METRICS_INTERVAL = 3000; // one batched CPU/memory sample for the whole fleet (in-process on Windows, ~µs)
export const KILL_GRACE_MS = 5000;
export const START_STAGGER_MS = 1200; // avoid cold-booting a wall of Vite servers at once
// Dependency-ordered startup: how long a process with `waitForPort` polls before giving up.
export const WAIT_FOR_PORT_TIMEOUT_MS = 30_000;
export const WAIT_FOR_PORT_POLL_MS = 300;

export interface Entry {
  def: ProcessDef;
  status: Status;
  child: ChildProcess | null;
  pid: number | null;
  startedAt: number | null;
  restarts: number;
  exitCode: number | null;
  cpu: number | null;
  memory: number | null;
  portInUse: boolean;
  /** While status is "waiting": the resolved port number being waited on (for the GUI hint). */
  waitingOnPort: number | null;
  logs: LogLine[];
  /** Small ring of the most recent stderr lines — cheap source for the crash-tail hint
   *  (log-vault's recordLastCrash) without re-reading the log file at exit time. */
  recentStderr: string[];
  stopping: boolean;
  pendingStart: boolean; // start() is awaiting the async free-port step (no child yet)
  exitWaiters: Array<() => void>;
  stopTimer: ReturnType<typeof setTimeout> | null;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  processIds: string[];
}
