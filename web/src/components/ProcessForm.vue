<script setup lang="ts">
import { reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ChevronRight, TriangleAlert, X } from "@lucide/vue";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { addProcess, deleteProcess, updateProcess } from "@/api";
import type { ProcessInput, ProcessView } from "@/types";

const { t } = useI18n({ useScope: "global" });

const open = defineModel<boolean>("open", { required: true });
const props = defineProps<{
  mode: "add" | "edit";
  projectId: string;
  initial: ProcessView | null;
}>();
const emit = defineEmits<{ saved: [] }>();

const form = reactive({
  id: "",
  name: "",
  command: "",
  cwd: "",
  color: "",
  port: null as number | null,
  url: "",
  autostart: false,
  // "auto" maps to no per-process runtime (use the global default).
  runtime: "auto" as "auto" | "node" | "bun",
  // A port number, or another process's id (in this same project) — waits for that
  // port to be listening before this process spawns. Typed as free text; parsed to
  // a number when it looks like one, else sent as the sibling-id string.
  waitForPort: "",
});
const runtimeOptions = [
  { label: "auto", value: "auto" },
  { label: "node", value: "node" },
  { label: "bun", value: "bun" },
];
const error = ref("");
const saving = ref(false);
const confirmDelete = ref(false);
const advancedOpen = ref(false);

watch(open, (v) => {
  if (!v) return;
  error.value = "";
  confirmDelete.value = false;
  const p = props.initial;
  advancedOpen.value = false; // always start collapsed
  form.id = p?.localId ?? "";
  form.name = p?.name ?? "";
  form.command = p?.command ?? "";
  form.cwd = p?.cwdRaw ?? "";
  form.color = p?.color ?? "";
  form.port = p?.port ?? null;
  form.url = p?.url ?? "";
  form.autostart = p?.autostart ?? false;
  form.runtime = p?.runtime ?? "auto";
  form.waitForPort = p?.waitForPort != null ? String(p.waitForPort) : "";
});

function payload(): ProcessInput {
  return {
    id: form.id.trim(),
    name: form.name.trim(),
    command: form.command.trim(),
    cwd: form.cwd.trim() || undefined,
    color: form.color.trim() || undefined,
    port: form.port ?? undefined,
    url: form.url.trim() || undefined,
    autostart: form.autostart || undefined,
    runtime: form.runtime === "auto" ? undefined : form.runtime,
    waitForPort: parseWaitForPort(form.waitForPort),
  };
}

/** "" -> undefined; a bare integer -> number (literal port); anything else -> the string as-is
 *  (a sibling process id, per the schema). */
function parseWaitForPort(v: string): number | string | undefined {
  const trimmed = v.trim();
  if (!trimmed) return undefined;
  return /^\d+$/.test(trimmed) ? Number(trimmed) : trimmed;
}

async function save() {
  if (!form.id.trim() || !form.name.trim() || !form.command.trim()) {
    error.value = t("processForm.requiredFields");
    return;
  }
  saving.value = true;
  error.value = "";
  try {
    const res =
      props.mode === "add"
        ? await addProcess(props.projectId, payload())
        : await updateProcess(props.projectId, props.initial!.localId, payload());
    if (res?.error) {
      error.value = res.error;
      return;
    }
    emit("saved");
    open.value = false;
  } catch (e) {
    error.value = e instanceof Error ? e.message : t("processForm.saveFailed");
  } finally {
    saving.value = false;
  }
}

function onColorPick(e: Event) {
  form.color = (e.target as HTMLInputElement).value;
}

async function remove() {
  if (!props.initial) return;
  saving.value = true;
  error.value = "";
  try {
    const res = await deleteProcess(props.projectId, props.initial.localId);
    if (res?.error) {
      error.value = res.error;
      return;
    }
    emit("saved");
    open.value = false;
  } catch (e) {
    error.value = e instanceof Error ? e.message : t("processForm.deleteFailed");
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <Dialog :open="open" @update:open="(v: boolean) => { if (!saving) open = v }">
    <DialogContent class="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-[480px]" :aria-busy="saving">
      <DialogHeader>
        <DialogTitle>{{ mode === "add" ? t("processForm.addProcess") : t("processForm.editProcess") }}</DialogTitle>
        <DialogDescription class="sr-only">{{ t("processForm.dialogDescription") }}</DialogDescription>
      </DialogHeader>

      <form class="flex flex-col gap-4" @submit.prevent="save">
        <Alert v-if="error" variant="destructive">
          <TriangleAlert />
          <AlertDescription>{{ error }}</AlertDescription>
        </Alert>

        <div class="flex flex-col gap-1.5">
          <Label for="pf-name">{{ t("processForm.labelName") }}</Label>
          <Input id="pf-name" v-model="form.name" :placeholder="t('processForm.placeholderName')" />
        </div>

        <div class="flex flex-col gap-1.5">
          <Label for="pf-id" v-html="t('processForm.labelId')" />
          <Input
            id="pf-id"
            v-model="form.id"
            :disabled="mode === 'edit'"
            :placeholder="t('processForm.placeholderId')"
          />
        </div>

        <div class="flex items-center justify-between gap-4 rounded-lg border border-border bg-muted/40 px-3.5 py-3">
          <div>
            <div class="text-sm font-medium">{{ t("processForm.autostartLabel") }}</div>
            <div class="mt-0.5 text-xs text-muted-foreground">{{ t("processForm.autostartDescription") }}</div>
          </div>
          <Switch
            id="pf-autostart"
            :model-value="form.autostart"
            :aria-label="t('processForm.autostartLabel')"
            @update:model-value="(v: boolean) => (form.autostart = v)"
          />
        </div>

        <div class="border-t border-border pt-3.5">
          <button
            type="button"
            class="flex w-full items-center gap-2 py-1.5 text-left text-sm font-medium text-muted-foreground outline-none transition hover:text-foreground focus-visible:text-foreground"
            :aria-expanded="advancedOpen"
            @click="advancedOpen = !advancedOpen"
          >
            <ChevronRight
              class="size-3.5 text-muted-foreground transition-transform"
              :class="advancedOpen ? 'rotate-90' : ''"
            />
            {{ t("processForm.advancedOptions") }}
          </button>

          <div
            class="grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none"
            :class="advancedOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'"
          >
            <div class="min-h-0 overflow-hidden">
              <div class="flex flex-col gap-4 pt-3.5">
                <div class="grid grid-cols-2 gap-3.5 max-[520px]:grid-cols-1">
                  <div class="flex flex-col gap-1.5">
                    <Label for="pf-cwd" v-html="t('processForm.labelCwd')" />
                    <Input id="pf-cwd" v-model="form.cwd" :placeholder="t('processForm.placeholderCwd')" />
                  </div>
                  <div class="flex flex-col gap-1.5">
                    <Label for="pf-port" v-html="t('processForm.labelPort')" />
                    <Input
                      id="pf-port"
                      type="number"
                      min="1"
                      :model-value="form.port ?? ''"
                      :placeholder="t('processForm.placeholderPort')"
                      @update:model-value="(v) => (form.port = v === '' || v == null ? null : Number(v))"
                    />
                  </div>
                </div>

                <div class="flex flex-col gap-1.5">
                  <Label for="pf-url" v-html="t('processForm.labelUrl')" />
                  <Input id="pf-url" v-model="form.url" :placeholder="t('processForm.placeholderUrl')" />
                </div>

                <div class="flex flex-col gap-1.5">
                  <Label for="pf-wait-for-port" v-html="t('processForm.labelWaitForPort')" />
                  <Input
                    id="pf-wait-for-port"
                    v-model="form.waitForPort"
                    :placeholder="t('processForm.placeholderWaitForPort')"
                  />
                </div>

                <div class="grid grid-cols-2 gap-3.5 max-[520px]:grid-cols-1">
                  <div class="grid grid-cols-[38px_1fr] items-end gap-2.5">
                    <label
                      class="relative size-[38px] cursor-pointer overflow-hidden rounded-lg border border-border"
                      :style="{ backgroundColor: form.color || 'var(--primary)' }"
                      :title="form.color || t('processForm.titlePickColor')"
                    >
                      <input
                        type="color"
                        class="absolute -inset-1 size-[130%] cursor-pointer border-0 bg-transparent p-0"
                        :value="form.color || '#6366f1'"
                        :aria-label="t('processForm.titlePickColor')"
                        @input="onColorPick"
                      />
                    </label>
                    <div class="flex flex-col gap-1.5">
                      <Label for="pf-color" v-html="t('processForm.labelColor')" />
                      <Input id="pf-color" v-model="form.color" :placeholder="t('processForm.placeholderColor')" />
                    </div>
                  </div>
                  <div class="flex flex-col gap-1.5">
                    <Label for="pf-runtime">{{ t("processForm.labelRuntime") }}</Label>
                    <Select v-model="form.runtime">
                      <SelectTrigger id="pf-runtime">
                        <SelectValue :placeholder="t('processForm.runtimeAuto')" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem v-for="o in runtimeOptions" :key="o.value" :value="o.value">
                          {{ o.value === "auto" ? t("processForm.runtimeAuto") : o.value === "node" ? t("processForm.runtimeNode") : t("processForm.runtimeBun") }}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div class="flex flex-col gap-1.5">
                  <Label for="pf-cmd">{{ t("processForm.labelCommand") }}</Label>
                  <Input id="pf-cmd" v-model="form.command" :placeholder="t('processForm.placeholderCommand')" />
                </div>
              </div>
            </div>
          </div>
        </div>

        <DialogFooter :class="mode === 'edit' ? 'sm:justify-between' : ''">
          <div v-if="confirmDelete" class="flex items-center gap-2">
            <Button type="button" variant="destructive" :disabled="saving" @click="remove">
              {{ t("processForm.confirmDelete") }}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              :aria-label="t('processForm.cancelDelete')"
              :disabled="saving"
              @click="confirmDelete = false"
            >
              <X class="size-4" />
            </Button>
          </div>
          <Button
            v-else-if="mode === 'edit'"
            type="button"
            variant="destructive"
            :disabled="saving"
            @click="confirmDelete = true"
          >
            {{ t("processForm.delete") }}
          </Button>
          <div class="ml-auto flex items-center gap-2">
            <Button type="button" variant="ghost" :disabled="saving" @click="open = false">
              {{ t("processForm.cancel") }}
            </Button>
            <Button type="submit" :disabled="saving">
              {{ mode === "add" ? t("processForm.add") : t("processForm.save") }}
            </Button>
          </div>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
