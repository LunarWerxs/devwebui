// Re-export the shared network + buffering constants so existing
// `import { daemonPort } from "./constants"` call sites keep working. The
// canonical definitions live in ../../shared/constants.
export { DEFAULT_DAEMON_PORT, daemonPort, daemonUrl, MAX_LOG_LINES } from "../../shared/constants";
