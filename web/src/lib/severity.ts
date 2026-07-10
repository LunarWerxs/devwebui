// Single source of truth for status/source → presentation. The old PrimeVue
// "severity" strings are gone; instead each state maps to Tailwind classes used
// on a shadcn Badge (outline base) plus a dot colour, so the same semantics live
// in one place and read correctly in both light and dark themes.
import type { Status } from "@/types";

export interface Pill {
  label: string;
  /** Classes layered on a `<Badge variant="outline">`. */
  badge: string;
  /** Background class for a small round status dot. */
  dot: string;
}

const RUNNING = "border-success/30 bg-success/10 text-success";
const BUSY = "border-warning/30 bg-warning/10 text-warning";
const BAD = "border-destructive/30 bg-destructive/10 text-destructive";
const IDLE = "border-border bg-muted text-muted-foreground";

/** Shared amber/warning callout-banner color classes (port conflicts, takeover/scaffold notices). */
export const WARNING_BANNER = "border-warning/30 bg-warning/10 text-warning";

export function statusPill(status: Status): Pill {
  switch (status) {
    case "running":
      return { label: status, badge: RUNNING, dot: "bg-success" };
    case "starting":
    case "stopping":
    case "waiting":
      return { label: status, badge: BUSY, dot: "bg-warning" };
    case "crashed":
      return { label: status, badge: BAD, dot: "bg-destructive" };
    default:
      return { label: status, badge: IDLE, dot: "bg-muted-foreground" };
  }
}

/** Badge classes for an error record's source (crash / stderr / stdout). */
export function sourcePill(source: string): string {
  return source === "crash" ? BAD : source === "stderr" ? BUSY : IDLE;
}
