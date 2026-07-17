import {
  commands,
  DEFAULT_TRANSLATE_PORT,
  events,
  type TranslateEffort,
  type TranslateModel,
  type TranslateSettings,
  type TranslateSettingsSnapshot,
} from "./bindings";
import { unwrap } from "./unwrap";

export type { TranslateEffort, TranslateModel, TranslateSettings, TranslateSettingsSnapshot };
export { DEFAULT_TRANSLATE_PORT };

export function translateSettingsGet() {
  return unwrap(commands.translateSettingsGet());
}

export function translateSettingsSave(settings: TranslateSettings) {
  return unwrap(commands.translateSettingsSave(settings));
}

export function onOpenSettingsRequested(cb: () => void) {
  return events.settingsOpen.listen(() => cb());
}
