<script setup lang="ts">
import { Toaster } from "vue-sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useTheme } from "@/lib/theme";
import AppShell from "./AppShell.vue";
import FocusView from "./components/FocusView.vue";

// Shared kit light/dark/system theme; drives the toaster theme. DevWebUI now defaults
// to dark (was the lone OS-`auto` outlier). `mode` ("light" | "dark" | "system") maps
// 1:1 to vue-sonner's theme prop.
const { mode } = useTheme();

// `/?process=<id>` swaps the whole dashboard for the single-process focus view that a
// desktop shortcut opens. Read once at startup rather than reactively: this app has no
// router and this is not a navigable route — the window is launched directly onto it,
// and "Open dashboard" is a full document navigation back to "/".
const focusProcessId = new URLSearchParams(window.location.search).get("process");
</script>

<template>
  <TooltipProvider :delay-duration="300">
    <FocusView v-if="focusProcessId" :process-id="focusProcessId" />
    <AppShell v-else />
    <Toaster
      :theme="mode"
      position="bottom-center"
      :duration="3500"
      :offset="16"
      rich-colors
      close-button
    />
  </TooltipProvider>
</template>
