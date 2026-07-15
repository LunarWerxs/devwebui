<script setup lang="ts">
// Single-process view: what a desktop shortcut opens (`/?process=<id>`), instead of
// the whole dashboard. It is deliberately NOT a new way to render a process — it's the
// ordinary ProcessCard with the shell stripped away, so status, logs, links, metrics,
// Start/Stop and the SSE wiring are all the same code the dashboard uses and cannot
// drift from it.
//
// Reading the id from the query string rather than adding a router: the app has no
// routes, and one query param does not justify inventing them.
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { storeToRefs } from "pinia";
import { LayoutDashboard } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import Hint from "./Hint.vue";
import ProcessCard from "./ProcessCard.vue";
import LogDrawer from "./LogDrawer.vue";
import CloseFocusDialog from "./CloseFocusDialog.vue";
import { useAppStore } from "@/store";
import type { ProcessView } from "@/types";

const props = defineProps<{ processId: string }>();

const { t } = useI18n({ useScope: "global" });
const store = useAppStore();
const { allProcesses, connected } = storeToRefs(store);

const process = computed<ProcessView | undefined>(() =>
  allProcesses.value.find((p) => p.id === props.processId),
);

const isLive = computed(
  () =>
    process.value?.status === "running" ||
    process.value?.status === "starting" ||
    process.value?.status === "waiting",
);

const drawerOpen = ref(false);
const closeOpen = ref(false);
// The store starts empty, so `process` is undefined on the very first render — before
// the initial fetch has had any chance to land. Without this flag the template's
// v-else would paint "This process is gone" for a beat on EVERY normal open, which is
// both wrong and alarming. Only once the store has actually synced does a missing
// process mean the shortcut is genuinely stale.
const loaded = ref(false);

/**
 * The window's own X is Edge's, not ours: a chromeless `--app=` window only exposes
 * `beforeunload`, whose prompt is Chromium's generic non-customizable "Leave site?" —
 * it cannot ask whether to stop the server, and offers no third choice. So we provide
 * an explicit Close that asks properly, and let the X mean "close the window, leave
 * the server running" (the daemon keeps supervising it either way, and the tray still
 * has it). That default is the safe one: a stray X-click never kills a dev server.
 */
function requestClose() {
  if (isLive.value) closeOpen.value = true;
  else window.close();
}

function openDashboard() {
  window.location.href = "/";
}

// The same live wiring AppShell sets up, minus what a single card can't use (sync
// status, the ignored-project list). Without connect() the card would render whatever
// the first refresh returned and then freeze — no status changes, no metrics.
onMounted(async () => {
  store.connect();
  void store.loadSettings(); // monitorResources gates the CPU/Mem readouts on the card
  try {
    await store.refresh();
  } catch {
    // Best-effort, exactly as AppShell treats it: SSE will catch us up. `loaded` still
    // flips, since a failed refresh shouldn't leave the window spinning forever.
  } finally {
    loaded.value = true;
  }
});
</script>

<template>
  <div class="safe-bottom flex min-h-dvh flex-col">
    <header class="flex items-center gap-2 border-b px-4 py-2">
      <!-- Same shape as the dashboard's TopBar indicator, and for the same reason: the
           dot alone encodes state in colour only, so it pairs with the Live/Offline
           text and reuses TopBar's own keys rather than inventing a second vocabulary. -->
      <Hint :label="connected ? t('header.statusTooltip.live') : t('header.statusTooltip.offline')">
        <div class="flex items-center gap-1.5 text-sm">
          <span
            class="size-2 rounded-full"
            :class="connected ? 'bg-success' : 'bg-destructive'"
          />
          <span class="font-medium" :class="connected ? 'text-success' : 'text-destructive'">
            {{ connected ? t("header.live") : t("header.offline") }}
          </span>
        </div>
      </Hint>
      <span class="truncate text-sm font-medium">{{ process?.projectName ?? "DevWebUI" }}</span>
      <Button
        variant="ghost"
        size="sm"
        class="ml-auto"
        :aria-label="t('focus.openDashboard')"
        @click="openDashboard"
      >
        <LayoutDashboard class="size-4" /> {{ t("focus.openDashboard") }}
      </Button>
    </header>

    <main class="flex-1 p-4">
      <ProcessCard
        v-if="process"
        :process="process"
        @logs="drawerOpen = true"
        @edit="openDashboard"
        @errors="openDashboard"
      />

      <!-- Still syncing: neutral, says nothing it might have to take back. -->
      <p v-else-if="!loaded" class="mt-24 text-center text-sm text-muted-foreground">
        {{ t("focus.loading") }}
      </p>

      <!-- Synced, and the id really isn't there: the .lnk was written who-knows-when and
           the process may have been renamed or deleted from the .devwebui file since.
           Say so plainly and offer the dashboard rather than an empty window. -->
      <div v-else class="mx-auto mt-24 flex max-w-sm flex-col items-center gap-4 text-center">
        <h2 class="text-lg font-semibold">{{ t("focus.notFound") }}</h2>
        <p class="text-sm text-muted-foreground">{{ t("focus.notFoundHint") }}</p>
        <Button variant="outline" @click="openDashboard">
          <LayoutDashboard class="size-4" /> {{ t("focus.openDashboard") }}
        </Button>
      </div>
    </main>

    <footer class="flex items-center justify-end gap-2 border-t px-4 py-2">
      <Button variant="outline" size="sm" @click="requestClose">{{ t("focus.close") }}</Button>
    </footer>

    <LogDrawer v-if="process" v-model:open="drawerOpen" :process-id="process.id" />
    <CloseFocusDialog v-if="process" v-model:open="closeOpen" :process="process" />
  </div>
</template>
