import { DEFAULT_SETTINGS, type Settings, type SettingsStore } from "./settings";
import {
  hasUserscriptStorage,
  readUserscriptValue,
  writeUserscriptValue,
} from "./userscript-storage";

export const SETTINGS_KEY = "imageUploaderSettings";

export function createUserscriptSettingsStore(): SettingsStore {
  return {
    load() {
      if (hasUserscriptStorage()) return readUserscriptValue(SETTINGS_KEY, DEFAULT_SETTINGS);
      try {
        const stored = localStorage.getItem(SETTINGS_KEY);
        return stored ? JSON.parse(stored) : DEFAULT_SETTINGS;
      } catch {
        return DEFAULT_SETTINGS;
      }
    },
    save(settings: Settings) {
      try {
        if (hasUserscriptStorage()) writeUserscriptValue(SETTINGS_KEY, settings);
        else localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      } catch (error) {
        console.error("[Viewer Companion] Could not save settings", error);
      }
    },
  };
}
