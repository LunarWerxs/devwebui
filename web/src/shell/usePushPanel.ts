import { computed, ref, watch, type Ref } from "vue";
import { useMediaQuery } from "@vueuse/core";

/**
 * usePushPanel, the shared "settings slide-in that PUSHES content" behaviour.
 *
 * On desktop the panel docks to the right edge and the page content is shifted
 * left by the panel's width (an animated `padding-right` on the app shell root).
 * On mobile it becomes a bottom sheet and nothing is pushed. The chosen side is
 * LOCKED at open time so a mid-open viewport resize can't break the animation.
 *
 * Usage (in an app shell):
 *   const open = ref(false);
 *   const { side, containerStyle } = usePushPanel(open);
 *   // <div class="transition-[padding] duration-300 ease-in-out" :style="containerStyle"> ... </div>
 *   // <SettingsPanel v-model:open="open" :side="side"> ... </SettingsPanel>
 */
export type PushPanelSide = "right" | "bottom";

export interface UsePushPanelOptions {
  /** Breakpoint at/above which the panel docks to the side and pushes content. */
  desktopQuery?: string;
  /** Panel width in px when docked on the side (also drives the content shift). */
  widthPx?: number;
}

export const DEFAULT_DESKTOP_QUERY = "(min-width: 768px)";
export const DEFAULT_PANEL_WIDTH = 420;

export function usePushPanel(open: Ref<boolean>, options: UsePushPanelOptions = {}) {
  const query = options.desktopQuery ?? DEFAULT_DESKTOP_QUERY;
  const width = options.widthPx ?? DEFAULT_PANEL_WIDTH;

  const isDesktop = useMediaQuery(query);
  const side = ref<PushPanelSide>(isDesktop.value ? "right" : "bottom");
  watch(open, (isOpen) => {
    if (isOpen) side.value = isDesktop.value ? "right" : "bottom";
  });

  const shiftPx = computed(() => (open.value && side.value === "right" ? width : 0));
  const containerStyle = computed<{ paddingRight?: string }>(() => ({
    paddingRight: shiftPx.value ? `${shiftPx.value}px` : undefined,
  }));

  return { side, shiftPx, containerStyle, widthPx: width };
}
