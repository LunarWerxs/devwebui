<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useLocalStorage } from "@vueuse/core";
import { Boxes, ChevronDown, EllipsisVertical, Play, Plus, Square, Trash2 } from "@lucide/vue";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { storeToRefs } from "pinia";
import ProcessCard from "./ProcessCard.vue";
import ProcessTable from "./ProcessTable.vue";
import IconButton from "./IconButton.vue";
import { disableProject, enableProject, startProject, stopProject } from "@/api";
import { useAppStore } from "@/store";
import { useRunAction } from "@/lib/useAction";
import { statusPill } from "@/lib/severity";
import { arrangeProcesses } from "@/lib/arrange";
import type { ProcessView, ProjectView } from "@/types";

const { t } = useI18n({ useScope: "global" });

const props = defineProps<{ project: ProjectView }>();
const emit = defineEmits<{
  logs: [id: string];
  addProcess: [projectId: string];
  editProcess: [projectId: string, process: ProcessView];
  errorsProcess: [processId: string];
}>();

// Remember each project's collapsed state so a screen full of codebases stays tidy.
const open = useLocalStorage(`devwebui.collapsed.${props.project.id}.v2`, true);
function onOpen(v: boolean) {
  open.value = v;
}

const store = useAppStore();
const { viewMode, sortKey, sortDir, statusFilter, now } = storeToRefs(store);

const running = computed(
  () => props.project.processes.filter((p) => p.status === "running").length,
);
const total = computed(() => props.project.processes.length);

// The stack master switch (project.enabled) GATES the whole project's autostart
// without touching the individual per-process toggles. It's a preference only —
// flipping it never starts/stops anything now. Off collapses the stack; on re-expands it.
async function onToggleStack(v: boolean) {
  onOpen(v);
  await runAction(() => (v ? enableProject(props.project.id) : disableProject(props.project.id)));
}

// Filtered + sorted once here; both the card grid and the table render this list.
const arranged = computed(() =>
  arrangeProcesses(props.project.processes, {
    sortKey: sortKey.value,
    sortDir: sortDir.value,
    statusFilter: statusFilter.value,
    now: now.value,
  }),
);
// True when the project has processes but the active filter hides them all.
const filteredEmpty = computed(() => total.value > 0 && arranged.value.length === 0);

const removeDialogOpen = ref(false);
async function doRemove() {
  removeDialogOpen.value = false;
  await runAction(() => store.removeProject(props.project.id));
}

const runAction = useRunAction("projectPanel.actionFailed");
</script>

<template>
  <Collapsible
    :open="open"
    class="overflow-hidden rounded-xl border border-border bg-card/40"
    @update:open="onOpen"
  >
    <div class="flex items-center gap-2 px-2.5 py-3 sm:px-4">
      <CollapsibleTrigger
        class="group -mx-1 flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-1 py-0.5 text-left outline-none transition hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring active:opacity-60"
        :aria-label="t('projectPanel.triggerAriaLabel', { name: project.name, running, total, action: open ? t('projectPanel.collapse') : t('projectPanel.expand') })"
      >
        <ChevronDown
          class="size-4 shrink-0 text-muted-foreground transition-transform"
          :class="open ? '' : '-rotate-90'"
        />
        <Boxes
          class="size-[18px] shrink-0"
          :class="project.enabled ? 'text-primary' : 'text-muted-foreground'"
        />
        <span class="truncate font-semibold" :class="project.enabled ? '' : 'text-muted-foreground'">
          {{ project.name }}
        </span>
        <Badge
          aria-hidden="true"
          variant="outline"
          :class="running > 0 ? statusPill('running').badge : 'text-muted-foreground'"
        >
          {{ running }}/{{ total }}
        </Badge>
      </CollapsibleTrigger>

      <div v-auto-animate class="flex shrink-0 items-center gap-1">
        <Switch
          :model-value="project.enabled"
          class="mr-1"
          :aria-label="project.enabled ? t('projectPanel.disableStack', { name: project.name }) : t('projectPanel.enableStack', { name: project.name })"
          :title="project.enabled ? t('projectPanel.stackOnTitle') : t('projectPanel.stackOffTitle')"
          @update:model-value="onToggleStack"
        />
        <IconButton v-if="open" :tooltip="t('projectPanel.startAll')" @click="runAction(() => startProject(project.id))">
          <Play class="size-4 text-success" />
        </IconButton>
        <IconButton v-if="open" :tooltip="t('projectPanel.stopAll')" @click="runAction(() => stopProject(project.id))">
          <Square class="size-4" />
        </IconButton>
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button variant="ghost" size="icon-sm" :aria-label="t('projectPanel.moreActions')">
              <EllipsisVertical class="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="w-44">
            <DropdownMenuItem @select="emit('addProcess', project.id)">
              <Plus class="size-4" /> {{ t("projectPanel.addProcess") }}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" @select="removeDialogOpen = true">
              <Trash2 class="size-4" /> {{ t("projectPanel.removeProject") }}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>

    <CollapsibleContent :class="project.enabled ? '' : 'opacity-50'">
      <p
        v-if="filteredEmpty"
        class="px-2.5 pb-4 pt-0 text-sm text-muted-foreground sm:px-4"
      >
        {{ t("projectPanel.noProcessesMatch") }}
      </p>
      <div v-else-if="viewMode === 'table'" class="px-2.5 pb-4 pt-0 sm:px-4">
        <ProcessTable
          :processes="arranged"
          @logs="(p) => emit('logs', p.id)"
          @edit="(p) => emit('editProcess', project.id, p)"
          @errors="(p) => emit('errorsProcess', p.id)"
        />
      </div>
      <div v-else class="grid grid-cols-1 gap-4 px-2.5 pb-4 pt-0 sm:grid-cols-2 sm:px-4 xl:grid-cols-3">
        <ProcessCard
          v-for="p in arranged"
          :key="p.id"
          :process="p"
          @logs="emit('logs', p.id)"
          @edit="emit('editProcess', project.id, p)"
          @errors="emit('errorsProcess', p.id)"
        />
      </div>
    </CollapsibleContent>
  </Collapsible>

  <Dialog v-model:open="removeDialogOpen">
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{{ t("projectPanel.removeProjectTitle", { name: project.name }) }}</DialogTitle>
        <DialogDescription>
          {{ t("projectPanel.removeProjectDescription", { name: project.name, count: total }, total) }}
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="ghost" @click="removeDialogOpen = false">{{ t("projectPanel.cancel") }}</Button>
        <Button variant="destructive" @click="doRemove">{{ t("projectPanel.removeProject") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
