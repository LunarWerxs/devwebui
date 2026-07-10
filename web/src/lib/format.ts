// Shared formatting helpers — used by ProcessCard, NotificationsDrawer, etc. so the same
// duration/relative-time/byte logic lives in exactly one place.

export function formatDuration(totalSeconds: number): string {
  const t = Math.max(0, totalSeconds);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
}

export function formatUptime(nowMs: number, startedAt: number | null, running: boolean): string {
  if (!startedAt || !running) return "—";
  return formatDuration(Math.floor((nowMs - startedAt) / 1000));
}

export { formatAgo, formatAgoCoarse } from "@/lib/relativeTime";

export function formatBytes(bytes: number | null): string {
  if (!bytes) return "—";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes / 1048576)} MB`;
}

/**
 * Browser URL for a process's dev server, or null when there's nothing to open.
 * Used to make the process title a click-through link. `host` is the configurable
 * link host (Settings → Open in browser); it defaults to `localhost`.
 *
 *   - An absolute `http(s)://` `url` is used verbatim (point anywhere; host ignored).
 *   - A relative `url` (e.g. `/admin`) is appended to `http://<host>:<port>`.
 *   - No `url` → `http://<host>:<port>`.
 *   - No port and no absolute `url` → null (a bare path has no host to hang off).
 */
export function processUrl(
  port: number | null | undefined,
  url?: string | null,
  host: string = "localhost",
): string | null {
  const custom = url?.trim();
  if (custom && /^https?:\/\//i.test(custom)) return custom;
  if (port == null) return null;
  const base = `http://${host}:${port}`;
  if (!custom) return base;
  return base + (custom.startsWith("/") ? custom : `/${custom}`);
}
