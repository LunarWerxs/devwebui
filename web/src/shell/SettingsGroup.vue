<script setup lang="ts">
/**
 * SettingsGroup — one labelled section of a settings sidebar: a small caps label
 * over a rounded, hairline-divided card. Every LunarWerx app's settings use this
 * (+ SettingsRow) so the three read identically. Put SettingsRow children inside,
 * or arbitrary content for richer sections.
 */
defineProps<{ label?: string }>();
</script>

<template>
  <section>
    <p
      v-if="label"
      class="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
    >
      {{ label }}
    </p>
    <div class="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60 bg-card shadow-sm">
      <slot />
    </div>
  </section>
</template>
