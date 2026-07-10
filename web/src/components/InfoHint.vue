<script setup lang="ts">
// A small "(i)" trigger that reveals help text in a tooltip — used to keep section
// titles clean while still surfacing the detail on hover/focus. Needs a
// <TooltipProvider> ancestor (mounted once at the App root).
import { Info } from "@lucide/vue";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useI18n } from "vue-i18n";
const { t } = useI18n({ useScope: "global" });
</script>

<template>
  <Tooltip>
    <TooltipTrigger as-child>
      <button
        type="button"
        class="inline-grid size-4 shrink-0 place-items-center rounded-full text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        :aria-label="t('infoHint.moreInfo')"
      >
        <Info class="size-3.5" />
      </button>
    </TooltipTrigger>
    <TooltipContent class="max-w-xs text-pretty font-normal leading-relaxed">
      <slot />
    </TooltipContent>
  </Tooltip>
</template>
