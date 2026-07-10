import { createAppI18n } from "@/lib/i18n-core";
import en from "./locales/en";

// The vue-i18n bootstrap — locale persistence (under `devwebui.locale`), the
// `<html lang>` sync, and the supported-locale set — lives in the shared kit
// factory (`@/lib/i18n-core`) so every LunarWerx app shares one implementation.
// The locale registry with translation-provenance metadata stays
// app-local in `./locales` (imported directly by the language picker); the factory
// just needs the message catalogs and derives which locales exist from their keys.
export const { i18n, setLocale, t } = createAppI18n({ en }, "devwebui.locale");
