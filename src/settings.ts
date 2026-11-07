import { normalizeDomainList, normalizeUserList } from "./preview-filters";

export type PreviewClick = "viewer" | "site";

export interface Settings {
  chatPreviews: boolean;
  autoInsert: boolean;
  catchUpLatency: boolean;
  previewClick: PreviewClick;
  blockedUsers: string[];
  blockedDomains: string[];
  hideBots: boolean;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  chatPreviews: true,
  autoInsert: false,
  catchUpLatency: true,
  previewClick: "viewer",
  blockedUsers: [],
  blockedDomains: [],
  hideBots: true,
});

export function normalizeSettings(value: unknown): Settings {
  const stored =
    value && typeof value === "object" ? (value as Record<string, unknown>) : ({} as const);
  return {
    chatPreviews:
      typeof stored.chatPreviews === "boolean"
        ? stored.chatPreviews
        : DEFAULT_SETTINGS.chatPreviews,
    autoInsert:
      typeof stored.autoInsert === "boolean" ? stored.autoInsert : DEFAULT_SETTINGS.autoInsert,
    catchUpLatency:
      typeof stored.catchUpLatency === "boolean"
        ? stored.catchUpLatency
        : DEFAULT_SETTINGS.catchUpLatency,
    previewClick: stored.previewClick === "site" ? "site" : "viewer",
    blockedUsers: normalizeUserList(stored.blockedUsers),
    blockedDomains: normalizeDomainList(stored.blockedDomains),
    hideBots: typeof stored.hideBots === "boolean" ? stored.hideBots : DEFAULT_SETTINGS.hideBots,
  };
}

export interface SettingsStore {
  load(): unknown;
  save(settings: Settings): void;
}

export interface SettingsController {
  /** The current settings, safe to read synchronously from event handlers. */
  get(): Settings;
  /** Resolves once the stored settings have been read. */
  readonly ready: Promise<void>;
  update(patch: Partial<Settings>): void;
  /** Applies settings saved by another tab or frame without writing them again. */
  replace(value: unknown): void;
  subscribe(listener: (settings: Settings) => void): () => void;
}

function sameSettings(first: Settings, second: Settings): boolean {
  return (
    first.chatPreviews === second.chatPreviews &&
    first.autoInsert === second.autoInsert &&
    first.catchUpLatency === second.catchUpLatency &&
    first.previewClick === second.previewClick &&
    first.hideBots === second.hideBots &&
    JSON.stringify(first.blockedUsers) === JSON.stringify(second.blockedUsers) &&
    JSON.stringify(first.blockedDomains) === JSON.stringify(second.blockedDomains)
  );
}

export function createSettings(store: SettingsStore): SettingsController {
  let current = normalizeSettings(undefined);
  const listeners = new Set<(settings: Settings) => void>();
  const emit = () => {
    for (const listener of [...listeners]) listener(current);
  };
  const ready = Promise.resolve()
    .then(() => store.load())
    .then((value) => {
      const next = normalizeSettings(value);
      if (sameSettings(next, current)) return;
      current = next;
      emit();
    })
    .catch((error) => {
      console.error("[Viewer Companion] Could not load settings", error);
    });

  return {
    get: () => current,
    ready,
    update(patch) {
      const next = normalizeSettings({ ...current, ...patch });
      if (sameSettings(next, current)) return;
      current = next;
      emit();
      void Promise.resolve()
        .then(() => store.save(current))
        .catch((error) => {
          console.error("[Viewer Companion] Could not save settings", error);
        });
    },
    replace(value) {
      const next = normalizeSettings(value);
      if (sameSettings(next, current)) return;
      current = next;
      emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
