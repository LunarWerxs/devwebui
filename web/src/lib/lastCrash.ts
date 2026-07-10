import { toast } from "vue-sonner";
import { useI18n } from "vue-i18n";
import type { LastCrash } from "@/api";

// How many stderr lines to quote in the toast body — the full tail (up to 20) is kept
// server-side, but the toast should stay glanceable.
const TAIL_PREVIEW_LINES = 6;

/**
 * Time-Travel Log Vault's killer detail: when starting a process whose LAST run
 * crashed, proactively show a dismissible toast quoting its exit code + a stderr
 * tail — "last time this failed with … — is Postgres running?" style. Call this in
 * a component's setup, then invoke the returned function with the `lastCrash` a
 * start() response (or the store's `lastCrash` SSE event) carried.
 */
export function useLastCrashHint() {
  const { t } = useI18n({ useScope: "global" });

  return function showLastCrashHint(processName: string, crash: LastCrash) {
    const tail = crash.stderrTail.slice(-TAIL_PREVIEW_LINES).join("\n");
    toast.warning(t("lastCrash.title", { name: processName }), {
      description: [
        t("lastCrash.exitCode", { code: crash.exitCode ?? t("lastCrash.unknownCode") }),
        tail || t("lastCrash.noOutput"),
      ].join("\n"),
      duration: 15000,
    });
  };
}
