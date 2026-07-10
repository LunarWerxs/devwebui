<script setup lang="ts">
// Dense, scan-friendly alternative to the ProcessCard grid: one row per process.
// Same actions + emitted events as ProcessCard, so ProjectPanel can swap layouts
// purely on the store's viewMode without changing its wiring.
import {
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  Cpu,
  EllipsisVertical,
  ExternalLink,
  MemoryStick,
  Pencil,
  Play,
  Power,
  RotateCw,
  ScrollText,
  Square,
  Star,
  TriangleAlert,
} from "@lucide/vue";
import { computed } from "vue";
import { storeToRefs } from "pinia";
import { useI18n } from "vue-i18n";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import IconButton from "./IconButton.vue";
import { disableProcess, enableProcess, restart, start, stop } from "@/api";
import { useAppStore } from "@/store";
import { useFreePortAction } from "@/lib/freePort";
import { useLastCrashHint } from "@/lib/lastCrash";
import { useRunAction } from "@/lib/useAction";
import { formatBytes, formatUptime, processUrl } from "@/lib/format";
import { statusPill } from "@/lib/severity";
import type { ProcessView, SortKey } from "@/types";

const { t } = useI18n({ useScope: "global" });
const freePortAction = useFreePortAction();
const showLastCrashHint = useLastCrashHint();

const props = defineProps<{ processes: ProcessView[] }>();
const emit = defineEmits<{
  logs: [process: ProcessView];
  edit: [process: ProcessView];
  errors: [process: ProcessView];
}>();

const store = useAppStore();
const { errorCountByProcess, now, sortKey, sortDir, monitorResources, linkHost } =
  storeToRefs(store);

const isLive = (p: ProcessView) =>
  p.status === "running" || p.status === "starting" || p.status === "waiting";

/**
 * Per-process link target, keyed by id. Only running processes get one — a link
 * to a stopped server just yields a connection-refused, so we render plain text
 * until it's actually up.
 */
const liveUrls = computed<Record<string, string>>(() => {
  // Blank linkHost → fall back to the host the GUI itself was opened on.
  const host = linkHost.value.trim() || window.location.hostname;
  const out: Record<string, string> = {};
  for (const p of props.processes) {
    if (p.status !== "running") continue;
    const url = processUrl(p.port, p.url, host);
    if (url) out[p.id] = url;
  }
  return out;
});

/** Icon shown in a sortable header: direction arrow when active, faint hint otherwise. */
const sortIcon = (key: SortKey) =>
  sortKey.value !== key ? ChevronsUpDown : sortDir.value === "asc" ? ArrowUp : ArrowDown;

const runAction = useRunAction("processTable.actionFailed");

/** Start, then surface the Time-Travel Log Vault hint if the LAST run crashed. */
function onStart(p: ProcessView) {
  return runAction(async () => {
    const res = await start(p.id);
    if (res.lastCrash) showLastCrashHint(p.name, res.lastCrash);
  });
}
</script>

<template>
  <div class="overflow-hidden rounded-lg border border-border">
    <Table>
      <TableHeader>
        <TableRow class="bg-muted/40 hover:bg-muted/40">
          <TableHead class="w-[26%]">
            <Button
              variant="ghost"
              size="sm"
              class="-ml-1 h-auto gap-1 px-1 py-0.5 font-medium text-muted-foreground hover:text-foreground"
              :class="sortKey === 'name' ? 'text-foreground' : ''"
              @click="store.toggleSort('name')"
            >
              {{ t("processTable.colProcess") }}
              <component :is="sortIcon('name')" class="size-3" :class="sortKey === 'name' ? '' : 'opacity-40'" />
            </Button>
          </TableHead>
          <TableHead class="hidden w-full md:table-cell">{{ t("processTable.colCommand") }}</TableHead>
          <TableHead class="w-px">
            <Button
              variant="ghost"
              size="sm"
              class="-ml-1 h-auto gap-1 px-1 py-0.5 font-medium text-muted-foreground hover:text-foreground"
              :class="sortKey === 'status' ? 'text-foreground' : ''"
              @click="store.toggleSort('status')"
            >
              {{ t("processTable.colStatus") }}
              <component :is="sortIcon('status')" class="size-3" :class="sortKey === 'status' ? '' : 'opacity-40'" />
            </Button>
          </TableHead>
          <TableHead class="w-px">
            <Button
              variant="ghost"
              size="sm"
              class="h-auto w-full justify-end gap-1 px-1 py-0.5 font-medium text-muted-foreground hover:text-foreground"
              :class="sortKey === 'port' ? 'text-foreground' : ''"
              @click="store.toggleSort('port')"
            >
              {{ t("processTable.colPort") }}
              <component :is="sortIcon('port')" class="size-3" :class="sortKey === 'port' ? '' : 'opacity-40'" />
            </Button>
          </TableHead>
          <TableHead class="w-px">
            <Button
              variant="ghost"
              size="sm"
              class="h-auto w-full justify-end gap-1 px-1 py-0.5 font-medium text-muted-foreground hover:text-foreground"
              :class="sortKey === 'uptime' ? 'text-foreground' : ''"
              @click="store.toggleSort('uptime')"
            >
              {{ t("processTable.colUptime") }}
              <component :is="sortIcon('uptime')" class="size-3" :class="sortKey === 'uptime' ? '' : 'opacity-40'" />
            </Button>
          </TableHead>
          <TableHead v-if="monitorResources" class="hidden w-px md:table-cell">
            <Button
              variant="ghost"
              size="sm"
              class="h-auto w-full justify-end gap-1 px-1 py-0.5 font-medium text-muted-foreground hover:text-foreground"
              :class="sortKey === 'cpu' ? 'text-foreground' : ''"
              @click="store.toggleSort('cpu')"
            >
              <Cpu class="size-3" /> {{ t("processTable.colCpu") }}
              <component :is="sortIcon('cpu')" class="size-3" :class="sortKey === 'cpu' ? '' : 'opacity-40'" />
            </Button>
          </TableHead>
          <TableHead v-if="monitorResources" class="hidden w-px md:table-cell">
            <Button
              variant="ghost"
              size="sm"
              class="h-auto w-full justify-end gap-1 px-1 py-0.5 font-medium text-muted-foreground hover:text-foreground"
              :class="sortKey === 'memory' ? 'text-foreground' : ''"
              @click="store.toggleSort('memory')"
            >
              <MemoryStick class="size-3" /> {{ t("processTable.colMem") }}
              <component :is="sortIcon('memory')" class="size-3" :class="sortKey === 'memory' ? '' : 'opacity-40'" />
            </Button>
          </TableHead>
          <TableHead class="w-px text-right">{{ t("processTable.colActions") }}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow v-for="p in processes" :key="p.id" :class="p.enabled ? '' : 'opacity-60'">
          <!-- Process: colour dot + name -->
          <TableCell>
            <div class="flex min-w-0 items-center gap-2">
              <span
                class="size-2.5 shrink-0 rounded-full"
                :style="{ background: p.color || 'var(--primary)' }"
              />
              <Star
                v-if="p.starred"
                class="size-3 shrink-0 fill-warning text-warning"
                :aria-label="t('processTable.unstar')"
              />
              <a
                v-if="liveUrls[p.id]"
                :href="liveUrls[p.id]"
                target="_blank"
                rel="noopener noreferrer"
                :title="t('processTable.openUrl', { url: liveUrls[p.id] })"
                class="group inline-flex min-w-0 items-center gap-1 rounded font-medium underline-offset-4 outline-none hover:underline focus-visible:underline focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span class="truncate">{{ p.name }}</span>
                <ExternalLink
                  class="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-60 group-focus-visible:opacity-60"
                  aria-hidden="true"
                />
              </a>
              <span v-else class="truncate font-medium">{{ p.name }}</span>
            </div>
          </TableCell>

          <!-- Command -->
          <TableCell class="hidden max-w-0 whitespace-normal md:table-cell">
            <code class="line-clamp-1 break-all text-xs text-muted-foreground" :title="p.command">{{ p.command }}</code>
          </TableCell>

          <!-- Status (+ error count) -->
          <TableCell>
            <div class="flex items-center gap-1.5">
              <Badge
                variant="outline"
                class="capitalize"
                :class="statusPill(p.status).badge"
                :title="p.status === 'waiting' && p.waitingOnPort ? t('processTable.waitingForPort', { port: p.waitingOnPort }) : undefined"
              >
                {{ statusPill(p.status).label }}
              </Badge>
              <button
                v-if="errorCountByProcess[p.id]"
                :aria-label="t('processTable.errorCountAriaLabel', errorCountByProcess[p.id])"
                class="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-1.5 py-0.5 text-xs font-semibold text-destructive outline-none transition-colors hover:bg-destructive/20 focus-visible:ring-2 focus-visible:ring-destructive/40 active:bg-destructive/30"
                @click="emit('errors', p)"
              >
                <TriangleAlert class="size-3" aria-hidden="true" /> {{ errorCountByProcess[p.id] }}
              </button>
            </div>
          </TableCell>

          <!-- Port. On conflict: amber number + a warning icon that toasts/frees the holder. -->
          <TableCell class="text-right tabular-nums">
            <span v-if="p.port == null" class="text-muted-foreground">—</span>
            <span v-else class="inline-flex items-center justify-end gap-1">
              <button
                v-if="p.conflict"
                class="rounded text-warning outline-none transition-colors hover:text-warning/80 focus-visible:ring-2 focus-visible:ring-warning/40"
                :aria-label="t('processTable.freePortAriaLabel', { port: p.port })"
                :title="t('processTable.freePortAriaLabel', { port: p.port })"
                @click="freePortAction(p)"
              >
                <TriangleAlert class="size-3.5" />
              </button>
              <span :class="p.conflict ? 'text-warning' : ''">{{ p.port }}</span>
            </span>
          </TableCell>

          <!-- Uptime / CPU / Mem -->
          <TableCell class="text-right tabular-nums">
            {{ formatUptime(now, p.startedAt, p.status === "running") }}
          </TableCell>
          <TableCell v-if="monitorResources" class="hidden text-right tabular-nums md:table-cell">{{ p.cpu != null ? `${p.cpu}%` : "—" }}</TableCell>
          <TableCell v-if="monitorResources" class="hidden text-right tabular-nums md:table-cell">{{ formatBytes(p.memory) }}</TableCell>

          <!-- Actions. Star + enable/disable live in the ⋮ menu so the row stays narrow (no
               horizontal scroll); the enabled state still reads at a glance from the row's opacity,
               and the star from the indicator next to the name. -->
          <TableCell>
            <div class="flex items-center justify-end gap-1">
              <IconButton v-if="!isLive(p)" :tooltip="t('processTable.actionStart')" @click="onStart(p)">
                <Play class="size-4 text-success" />
              </IconButton>
              <IconButton v-else :tooltip="t('processTable.actionStop')" @click="runAction(() => stop(p.id))">
                <Square class="size-4 text-destructive" />
              </IconButton>
              <DropdownMenu>
                <DropdownMenuTrigger as-child>
                  <Button variant="ghost" size="icon-sm" :aria-label="t('processTable.moreActions')">
                    <EllipsisVertical class="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" class="w-44">
                  <DropdownMenuItem @select="store.toggleStar(p)">
                    <Star class="size-4" :class="p.starred ? 'fill-warning text-warning' : ''" />
                    {{ p.starred ? t("processTable.unstar") : t("processTable.star") }}
                  </DropdownMenuItem>
                  <DropdownMenuItem @select="runAction(() => (p.enabled ? disableProcess(p.id) : enableProcess(p.id)))">
                    <Power class="size-4" />
                    {{ p.enabled ? t("processTable.actionDisable") : t("processTable.actionEnable") }}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem v-if="isLive(p) || p.status === 'crashed'" @select="runAction(() => restart(p.id))">
                    <RotateCw class="size-4" /> {{ t("processTable.actionRestart") }}
                  </DropdownMenuItem>
                  <DropdownMenuItem @select="emit('edit', p)">
                    <Pencil class="size-4" /> {{ t("processTable.actionEdit") }}
                  </DropdownMenuItem>
                  <DropdownMenuItem @select="emit('logs', p)">
                    <ScrollText class="size-4" /> {{ t("processTable.actionLogs") }}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  </div>
</template>
