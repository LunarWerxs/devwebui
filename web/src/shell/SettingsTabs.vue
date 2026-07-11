<script setup lang="ts" generic="T extends string">
// Segmented tab bar for a settings panel: flat buttons in a bordered pill row with the
// active tab lifted onto the page background. Promoted from RepoYeti's Settings
// (2026-07-10) when DevWebUI needed the identical bar; the tab CONTENT stays app-local,
// only the bar is kit. Rule for consumers: keep every tab's sections MOUNTED behind
// v-show (not v-if) whenever a section loads its data from an open-watcher, or a
// section first mounted by a later tab click never runs that watcher.
defineProps<{ tabs: readonly { id: T; label: string }[] }>();

const model = defineModel<T>({ required: true });
</script>

<template>
  <div
    role="tablist"
    class="flex shrink-0 gap-1 rounded-lg border border-border/60 bg-secondary/30 p-1"
  >
    <button
      v-for="tb in tabs"
      :key="tb.id"
      type="button"
      role="tab"
      :aria-selected="model === tb.id"
      class="flex-1 rounded-md px-1 py-1.5 text-[12.5px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40"
      :class="model === tb.id ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
      @click="model = tb.id"
    >
      {{ tb.label }}
    </button>
  </div>
</template>
