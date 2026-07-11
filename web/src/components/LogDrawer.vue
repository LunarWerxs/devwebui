<script setup lang="ts">
import { computed, nextTick, useTemplateRef, watch } from "vue";
import { storeToRefs } from "pinia";
import { useI18n } from "vue-i18n";
import RightDrawer from "./RightDrawer.vue";
import { useAppStore } from "@/store";

const { t } = useI18n({ useScope: "global" });

const open = defineModel<boolean>("open", { required: true });
const props = defineProps<{ processId: string | null }>();

const store = useAppStore();
const { allProcesses, logs } = storeToRefs(store);

const scroller = useTemplateRef<HTMLElement>("scroller");
const lines = computed(() => (props.processId ? (logs.value[props.processId] ?? []) : []));
const proc = computed(() => allProcesses.value.find((p) => p.id === props.processId));

function scrollToBottom() {
  if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight;
}

watch(open, async (v) => {
  if (v && props.processId) {
    await store.fetchLogs(props.processId);
    await nextTick();
    scrollToBottom();
  }
});

// Drawer already open and the caller switched processes — refetch for the new id.
watch(
  () => props.processId,
  async (id) => {
    if (open.value && id) {
      await store.fetchLogs(id);
      await nextTick();
      scrollToBottom();
    }
  },
);

watch(
  () => lines.value.length,
  async () => {
    await nextTick();
    scrollToBottom();
  },
);
</script>

<template>
  <RightDrawer v-model:open="open" :title="proc?.name ?? t('logs.title')">
    <template #header>
      <span class="font-semibold">{{ proc?.name ?? t("logs.title") }}</span>
      <code v-if="proc" class="truncate text-xs text-muted-foreground">{{ proc.command }}</code>
    </template>
    <div
      ref="scroller"
      class="mt-3 min-h-0 flex-1 overflow-auto rounded-md border border-border bg-muted p-3 font-mono text-xs leading-relaxed"
    >
      <div v-if="!lines.length" class="text-muted-foreground">{{ t("logs.noOutput") }}</div>
      <div
        v-for="(l, i) in lines"
        :key="i"
        class="whitespace-pre-wrap break-all"
        :class="l.stream === 'stderr' ? 'text-destructive' : 'text-foreground/80'"
      >
        {{ l.line }}
      </div>
    </div>
  </RightDrawer>
</template>
