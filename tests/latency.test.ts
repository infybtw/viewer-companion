import { describe, expect, test } from "bun:test";
import {
  LATENCY_MAX_RATE,
  LATENCY_MIN_RATE,
  catchUpPlaybackRate,
  liveDelaySeconds,
  registerLatencyCatcher,
  type LatencyVideo,
} from "../src/latency";
import { createSettings } from "../src/settings";

function seekable(edge: number | null): LatencyVideo["seekable"] {
  return {
    length: edge === null ? 0 : 1,
    end: () => edge ?? Number.NaN,
  };
}

function video(
  currentTime: number,
  edge: number | null,
  overrides: Partial<LatencyVideo> = {},
): LatencyVideo {
  return {
    currentTime,
    duration: Number.POSITIVE_INFINITY,
    paused: false,
    ended: false,
    playbackRate: 1,
    seekable: seekable(edge),
    ...overrides,
  };
}

describe("live latency", () => {
  test("measures the gap to the live edge", () => {
    expect(liveDelaySeconds(video(10, 14))).toBe(4);
    expect(liveDelaySeconds(video(10, 100))).toBe(90);
  });

  test("ignores VODs, ads, and unusable ranges", () => {
    expect(liveDelaySeconds(video(10, 14, { duration: 600 }))).toBeNull();
    expect(liveDelaySeconds(video(10, null))).toBeNull();
    expect(liveDelaySeconds(video(10, Number.NaN))).toBeNull();
    expect(liveDelaySeconds(video(15, 14))).toBeNull();
  });
});

describe("catch-up playback rate", () => {
  test("does nothing up to the threshold", () => {
    expect(catchUpPlaybackRate(0, false)).toBe(1);
    expect(catchUpPlaybackRate(3.9, false)).toBe(1);
    expect(catchUpPlaybackRate(4, false)).toBe(LATENCY_MIN_RATE);
  });

  test("ramps from 2% to 4% as the delay grows", () => {
    expect(catchUpPlaybackRate(6, false)).toBe(1.03);
    expect(catchUpPlaybackRate(8, false)).toBe(LATENCY_MAX_RATE);
    expect(catchUpPlaybackRate(30, false)).toBe(LATENCY_MAX_RATE);
  });

  test("keeps a minimum speedup while already catching up", () => {
    expect(catchUpPlaybackRate(3, false)).toBe(1);
    expect(catchUpPlaybackRate(3, true)).toBe(LATENCY_MIN_RATE);
    expect(catchUpPlaybackRate(2, true)).toBe(LATENCY_MIN_RATE);
  });

  test("stops near live to preserve a small buffer", () => {
    expect(catchUpPlaybackRate(1.5, true)).toBe(1);
    expect(catchUpPlaybackRate(1.4, true)).toBe(1);
    expect(catchUpPlaybackRate(Number.NaN, true)).toBe(1);
  });

  test("respects a custom start threshold", () => {
    expect(catchUpPlaybackRate(5.9, false, 6)).toBe(1);
    expect(catchUpPlaybackRate(6, false, 6)).toBe(LATENCY_MIN_RATE);
    expect(catchUpPlaybackRate(10, false, 6)).toBe(LATENCY_MAX_RATE);
    expect(catchUpPlaybackRate(3, true, 6)).toBe(LATENCY_MIN_RATE);
  });
});

describe("latency catcher", () => {
  type MutableVideo = { -readonly [Key in keyof LatencyVideo]: LatencyVideo[Key] };

  function harness(initialRate = 1, latencyThresholdSeconds = 4) {
    const element = {
      ...video(10, 14),
      playbackRate: initialRate,
    } as MutableVideo;
    let interval: (() => void) | undefined;
    const doc = { querySelectorAll: () => [element] } as unknown as Document;
    const win = {
      setInterval: (callback: () => void) => {
        interval = callback;
        return 1;
      },
      clearInterval: () => {},
    } as unknown as Window & { top: unknown };
    win.top = win;
    const settings = createSettings({
      load: () => ({ catchUpLatency: true, latencyThresholdSeconds }),
      save: () => {},
    });
    const stop = registerLatencyCatcher(settings, doc, win);
    return {
      element,
      settings,
      tick: () => interval?.(),
      stop,
    };
  }

  test("speeds up a delayed live stream and restores it near live", () => {
    const test = harness();
    expect(test.element.playbackRate).toBe(LATENCY_MIN_RATE);
    test.element.currentTime = 12.8; // 1.2 seconds behind the edge.
    test.tick();
    expect(test.element.playbackRate).toBe(1);
    test.stop();
  });

  test("restores the viewer's original rate when disabled", () => {
    const test = harness(1.5);
    expect(test.element.playbackRate).toBe(LATENCY_MIN_RATE);
    test.settings.update({ catchUpLatency: false });
    expect(test.element.playbackRate).toBe(1.5);
    test.stop();
  });

  test("uses the configured start threshold", async () => {
    const test = harness(1, 6);
    await test.settings.ready;
    expect(test.element.playbackRate).toBe(1);
    test.element.currentTime = 8; // 6 seconds behind the edge.
    test.tick();
    expect(test.element.playbackRate).toBe(LATENCY_MIN_RATE);
    test.stop();
  });
});
