<script setup lang="ts">
import { Toaster } from "vue-sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useTheme } from "@/lib/theme";
import AppShell from "./AppShell.vue";

// Shared kit light/dark/system theme; drives the toaster theme. DevWebUI now defaults
// to dark (was the lone OS-`auto` outlier). `mode` ("light" | "dark" | "system") maps
// 1:1 to vue-sonner's theme prop.
const { mode } = useTheme();
</script>

<template>
  <TooltipProvider :delay-duration="300">
    <AppShell />
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
