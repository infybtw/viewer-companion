import { describe, expect, test } from "bun:test";
import {
  createSettings,
  DEFAULT_SETTINGS,
  normalizeSettings,
  type Settings,
} from "../src/settings";

describe("settings validation", () => {
  test("uses safe defaults for missing or invalid values", () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings("invalid")).toEqual(DEFAULT_SETTINGS);
    expect(
      normalizeSettings({ chatPreviews: "yes", autoInsert: 1, previewClick: "other" }),
    ).toEqual(DEFAULT_SETTINGS);
  });

  test("hides bot previews until the user opts in", () => {
    expect(DEFAULT_SETTINGS.hideBots).toBe(true);
    expect(normalizeSettings({ hideBots: false }).hideBots).toBe(false);
    expect(normalizeSettings({ hideBots: "no" }).hideBots).toBe(true);
  });

  test("normalizes the configurable latency threshold", () => {
    expect(DEFAULT_SETTINGS.latencyThresholdSeconds).toBe(4);
    expect(normalizeSettings({ latencyThresholdSeconds: 7 }).latencyThresholdSeconds).toBe(7);
    expect(normalizeSettings({ latencyThresholdSeconds: 4.6 }).latencyThresholdSeconds).toBe(5);
    expect(normalizeSettings({ latencyThresholdSeconds: 0 }).latencyThresholdSeconds).toBe(1);
    expect(normalizeSettings({ latencyThresholdSeconds: 999 }).latencyThresholdSeconds).toBe(60);
    expect(normalizeSettings({ latencyThresholdSeconds: "5" }).latencyThresholdSeconds).toBe(4);
    expect(normalizeSettings({ latencyThresholdSeconds: Number.NaN }).latencyThresholdSeconds).toBe(
      4,
    );
  });

  test("keeps valid stored values", () => {
    expect(
      normalizeSettings({ chatPreviews: false, autoInsert: true, previewClick: "site" }),
    ).toEqual({
      ...DEFAULT_SETTINGS,
      chatPreviews: false,
      autoInsert: true,
      previewClick: "site",
    });
  });
});

describe("settings controller", () => {
  const stored = {
    ...DEFAULT_SETTINGS,
    chatPreviews: false,
    autoInsert: true,
    previewClick: "site" as const,
  };

  test("loads stored settings and notifies subscribers", async () => {
    const settings = createSettings({ load: () => stored, save: () => {} });
    const updates: Settings[] = [];
    settings.subscribe((value) => updates.push(value));
    expect(settings.get()).toEqual(DEFAULT_SETTINGS);
    await settings.ready;
    expect(settings.get()).toEqual(stored);
    expect(updates).toEqual([stored]);
  });

  test("updates immediately and persists the full settings object", async () => {
    const saved: Settings[] = [];
    const settings = createSettings({ load: () => stored, save: (value) => saved.push(value) });
    await settings.ready;
    settings.update({ autoInsert: false });
    expect(settings.get()).toEqual({ ...stored, autoInsert: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(saved).toEqual([{ ...stored, autoInsert: false }]);
  });

  test("applies cross-tab changes without writing them back", async () => {
    let saves = 0;
    const settings = createSettings({ load: () => stored, save: () => saves++ });
    await settings.ready;
    settings.replace({ ...stored, chatPreviews: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settings.get()).toEqual({ ...stored, chatPreviews: true });
    expect(saves).toBe(0);
  });

  test("saves exclusion changes and compares lists by value", async () => {
    const saved: Settings[] = [];
    const settings = createSettings({ load: () => undefined, save: (value) => saved.push(value) });
    await settings.ready;
    settings.update({
      blockedUsers: ["@SomeUser"],
      blockedDomains: ["https://Example.com/a"],
      hideBots: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(saved).toEqual([
      {
        ...DEFAULT_SETTINGS,
        blockedUsers: ["someuser"],
        blockedDomains: ["example.com"],
        hideBots: true,
      },
    ]);
    settings.update({ blockedUsers: ["someuser"], blockedDomains: ["example.com"] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(saved).toHaveLength(1);
    settings.replace(saved[0]);
    expect(settings.get().hideBots).toBe(true);
  });
});
