<script setup lang="ts">
import { computed } from "vue";
import {
  Cpu,
  ExternalLink,
  MemoryStick,
  Pencil,
  Play,
  RotateCw,
  ScrollText,
  Square,
  Star,
  TriangleAlert,
} from "@lucide/vue";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import IconButton from "./IconButton.vue";
import { storeToRefs } from "pinia";
import { disableProcess, enableProcess, restart, start, stop } from "@/api";
import { useAppStore } from "@/store";
import { useFreePortAction } from "@/lib/freePort";
import { useLastCrashHint } from "@/lib/lastCrash";
import { useRunAction } from "@/lib/useAction";
import { formatBytes, formatUptime, processUrl } from "@/lib/format";
import { statusPill, WARNING_BANNER } from "@/lib/severity";
import type { ProcessView } from "@/types";
import { useI18n } from "vue-i18n";

const { t } = useI18n({ useScope: "global" });
const freePortAction = useFreePortAction();
const showLastCrashHint = useLastCrashHint();

const props = defineProps<{ process: ProcessView }>();
const emit = defineEmits<{ logs: []; edit: []; errors: [] }>();

const store = useAppStore();
const { errorCountByProcess, now, monitorResources, linkHost } = storeToRefs(store);

const isLive = computed(
  () =>
    props.process.status === "running" ||
    props.process.status === "starting" ||
    props.process.status === "waiting",
);
// Title links to the dev server only while it's actually running — a link to a
// stopped server would just yield connection-refused.
const linkUrl = computed(() =>
  props.process.status === "running"
    ? processUrl(
        props.process.port,
        props.process.url,
        linkHost.value.trim() || window.location.hostname, // blank → the GUI page's own host
      )
    : null,
);
const uptime = computed(() =>
  formatUptime(now.value, props.process.startedAt, props.process.status === "running"),
);
const cpu = computed(() => (props.process.cpu != null ? `${props.process.cpu}%` : "—"));
const mem = computed(() => formatBytes(props.process.memory));
const errorCount = computed(() => errorCountByProcess.value[props.process.id] ?? 0);
const pill = computed(() => statusPill(props.process.status));

const runAction = useRunAction("processCard.actionFailed");

/** Start, then surface the Time-Travel Log Vault hint if the LAST run crashed. */
function onStart() {
  return runAction(async () => {
    const res = await start(props.process.id);
    if (res.lastCrash) showLastCrashHint(props.process.name, res.lastCrash);
  });
}
</script>

<template>
  <Card
    class="gap-0 py-0 transition-colors hover:border-primary/30"
    :class="process.enabled ? '' : 'opacity-60'"
  >
    <div class="flex flex-col gap-4 p-4">
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <span
              class="size-2.5 shrink-0 rounded-full"
              :style="{ background: process.color || 'var(--primary)' }"
            />
            <a
              v-if="linkUrl"
              :href="linkUrl"
              target="_blank"
              rel="noopener noreferrer"
              :title="t('processCard.openUrl', { url: linkUrl })"
              class="group inline-flex min-w-0 items-center gap-1 rounded font-semibold underline-offset-4 outline-none hover:underline focus-visible:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span class="truncate">{{ process.name }}</span>
              <ExternalLink
                class="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-60 group-focus-visible:opacity-60"
                aria-hidden="true"
              />
            </a>
            <h3 v-else class="truncate font-semibold">{{ process.name }}</h3>
          </div>
          <code class="mt-1 block truncate text-xs text-muted-foreground">{{ process.command }}</code>
        </div>
        <div class="flex shrink-0 items-center gap-1.5">
          <button
            v-if="errorCount"
            :aria-label="t('processCard.errorCountAriaLabel', { count: errorCount })"
            class="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-1.5 py-0.5 text-xs font-semibold text-destructive outline-none transition-colors hover:bg-destructive/20 focus-visible:ring-2 focus-visible:ring-destructive/40 active:bg-destructive/30"
            @click="emit('errors')"
          >
            <TriangleAlert class="size-3" aria-hidden="true" /> {{ errorCount }}
          </button>
          <Badge variant="outline" class="capitalize" :class="pill.badge">{{ pill.label }}</Badge>
          <IconButton
            :tooltip="process.starred ? t('processCard.unstar') : t('processCard.star')"
            @click="store.toggleStar(process)"
          >
            <Star
              class="size-4"
              :class="process.starred ? 'fill-warning text-warning' : 'text-muted-foreground/60'"
            />
          </IconButton>
          <Switch
            :model-value="process.enabled"
            :aria-label="process.enabled ? t('processCard.switchAriaLabelEnabled') : t('processCard.switchAriaLabelDisabled')"
            :title="
              process.enabled
                ? t('processCard.switchTitleEnabled')
                : t('processCard.switchTitleDisabled')
            "
            @update:model-value="(v: boolean) => runAction(() => (v ? enableProcess(process.id) : disableProcess(process.id)))"
          />
        </div>
      </div>

      <div class="grid gap-2 text-xs" :class="monitorResources ? 'grid-cols-3' : 'grid-cols-1'">
        <div>
          <div class="text-muted-foreground">{{ t("processCard.uptime") }}</div>
          <div class="mt-0.5 font-medium tabular-nums">{{ uptime }}</div>
        </div>
        <div v-if="monitorResources">
          <div class="flex items-center gap-1 text-muted-foreground"><Cpu class="size-3" /> {{ t("processCard.cpu") }}</div>
          <div class="mt-0.5 font-medium tabular-nums">{{ cpu }}</div>
        </div>
        <div v-if="monitorResources">
          <div class="flex items-center gap-1 text-muted-foreground">
            <MemoryStick class="size-3" /> {{ t("processCard.mem") }}
          </div>
          <div class="mt-0.5 font-medium tabular-nums">{{ mem }}</div>
        </div>
      </div>

      <div
        v-if="process.status === 'waiting' && process.waitingOnPort"
        class="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs"
        :class="WARNING_BANNER"
      >
        <TriangleAlert class="size-3.5" />
        <i18n-t keypath="processCard.waitingForPort" tag="span" scope="global">
          <template #port>{{ process.waitingOnPort }}</template>
        </i18n-t>
      </div>

      <div
        v-if="process.conflict"
        class="flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-xs"
        :class="WARNING_BANNER"
      >
        <span class="flex items-center gap-1.5">
          <TriangleAlert class="size-3.5" />
          <i18n-t keypath="processCard.portAlreadyInUse" tag="span" scope="global">
            <template #port>{{ process.port }}</template>
          </i18n-t>
        </span>
        <button
          class="rounded font-medium underline-offset-2 outline-none transition hover:underline focus-visible:underline focus-visible:ring-2 focus-visible:ring-warning/40 active:opacity-70"
          :aria-label="t('processCard.freePortAriaLabel', { port: process.port })"
          @click="freePortAction(process)"
        >
          {{ t("processCard.freeIt") }}
        </button>
      </div>

      <div class="flex items-center gap-1.5">
        <IconButton v-if="!isLive" :tooltip="t('processCard.tooltipStart')" variant="outline" @click="onStart">
          <Play class="size-4 text-success" />
        </IconButton>
        <IconButton v-else :tooltip="t('processCard.tooltipStop')" variant="outline" @click="runAction(() => stop(process.id))">
          <Square class="size-4 text-destructive" />
        </IconButton>
        <IconButton :tooltip="t('processCard.tooltipRestart')" variant="outline" @click="runAction(() => restart(process.id))">
          <RotateCw class="size-4" />
        </IconButton>
        <IconButton :tooltip="t('processCard.tooltipEdit')" variant="ghost" @click="emit('edit')">
          <Pencil class="size-4" />
        </IconButton>
        <Button variant="outline" size="sm" class="ml-auto" @click="emit('logs')">
          <ScrollText class="size-4" /> {{ t("processCard.logs") }}
        </Button>
      </div>
    </div>
  </Card>
</template>
