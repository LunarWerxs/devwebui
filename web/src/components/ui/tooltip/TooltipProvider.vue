<script setup lang="ts">
import type { TooltipProviderProps } from "reka-ui"
import { TooltipProvider } from "reka-ui"
import { computed } from "vue"
import { useTooltipConfig } from "@/lib/tooltip-config"

const props = withDefaults(defineProps<TooltipProviderProps>(), {
  delayDuration: 0,
})

// Global kill-switch: unless a caller pins `disabled` explicitly, follow the shared
// "show tooltips" setting (lib/tooltip-config.ts) so one Settings toggle silences every
// tooltip under this provider. InfoHint nests its own `:disabled="false"` provider to
// stay exempt.
const { enabled } = useTooltipConfig()
const resolvedDisabled = computed(() => props.disabled ?? !enabled.value)
</script>

<template>
  <TooltipProvider v-bind="props" :disabled="resolvedDisabled">
    <slot />
  </TooltipProvider>
</template>
