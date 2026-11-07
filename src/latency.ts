import type { SettingsController } from "./settings";

/** Start catching up once the live edge is at least this far ahead. */
export const LATENCY_START_SECONDS = 4;
/** Stop catching up near live so playback keeps a small buffer. */
export const LATENCY_STOP_SECONDS = 1.5;
/** Smallest speedup: 2% at the threshold. */
export const LATENCY_MIN_RATE = 1.02;
/** Largest speedup: 4% once the stream is far enough behind. */
export const LATENCY_MAX_RATE = 1.04;
/** The speedup reaches its maximum 4 seconds after the threshold. */
export const LATENCY_FULL_SPEED_SECONDS = 4;
export const LATENCY_CHECK_INTERVAL_MS = 1000;

const RATE_EPSILON = 0.0005;

export interface SeekableRange {
  readonly length: number;
  end(index: number): number;
}

/** The subset of HTMLVideoElement used to estimate live latency. */
export interface LatencyVideo {
  readonly currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  readonly ended: boolean;
  readonly playbackRate: number;
  readonly seekable: SeekableRange;
}

export function isLiveVideo(video: Pick<LatencyVideo, "duration">): boolean {
  // Live HLS streams (Twitch and Kick) expose an infinite duration. VODs,
  // clips, and ads have a finite one, so they must be left alone.
  return video.duration === Number.POSITIVE_INFINITY;
}

/**
 * Returns how many seconds of live edge the player has not consumed yet, or
 * null when the video is not a live stream or has no usable seekable range.
 */
export function liveDelaySeconds(video: LatencyVideo): number | null {
  if (!isLiveVideo(video)) return null;
  if (!Number.isFinite(video.currentTime) || video.currentTime < 0) return null;
  if (video.seekable.length === 0) return null;
  const edge = video.seekable.end(video.seekable.length - 1);
  if (!Number.isFinite(edge) || edge <= 0) return null;
  const delay = edge - video.currentTime;
  return delay > 0 ? delay : null;
}

/**
 * Chooses a playback rate between 1 and LATENCY_MAX_RATE. Active catch-up keeps
 * at least a 2% speedup until the delay drops to LATENCY_STOP_SECONDS, which
 * avoids rapid on/off cycling around the threshold.
 */
export function catchUpPlaybackRate(delay: number, catchingUp: boolean): number {
  if (!Number.isFinite(delay) || delay <= LATENCY_STOP_SECONDS) return 1;
  if (!catchingUp && delay < LATENCY_START_SECONDS) return 1;
  const progress = Math.min(
    Math.max((delay - LATENCY_START_SECONDS) / LATENCY_FULL_SPEED_SECONDS, 0),
    1,
  );
  const rate = LATENCY_MIN_RATE + (LATENCY_MAX_RATE - LATENCY_MIN_RATE) * progress;
  return Math.round(rate * 1000) / 1000;
}

interface AppliedRate {
  original: number;
  applied: number;
}

export function registerLatencyCatcher(
  settings: SettingsController,
  doc: Document = globalThis.document,
  win: Window = globalThis.window,
): () => void {
  if (!doc || !win) return () => {};
  try {
    if (win.top !== win) return () => {};
  } catch {
    return () => {};
  }

  const applied = new Map<HTMLVideoElement, AppliedRate>();
  let stopped = false;

  const restore = (video: HTMLVideoElement) => {
    const entry = applied.get(video);
    if (!entry) return;
    applied.delete(video);
    // Only undo a change that is still ours. If the site or the viewer changed
    // the speed meanwhile, leave their choice untouched.
    if (Math.abs(video.playbackRate - entry.applied) > RATE_EPSILON) return;
    try {
      video.playbackRate = entry.original;
    } catch {
      // The element may have been detached; nothing left to restore.
    }
  };

  const restoreAll = () => {
    for (const video of [...applied.keys()]) restore(video);
  };

  const sync = (video: HTMLVideoElement) => {
    if (video.paused || video.ended) {
      restore(video);
      return;
    }
    const delay = liveDelaySeconds(video);
    if (delay === null) {
      restore(video);
      return;
    }
    const current = applied.get(video);
    const rate = catchUpPlaybackRate(delay, current !== undefined);
    if (rate === 1) {
      restore(video);
      return;
    }
    const entry = current ?? {
      original:
        Number.isFinite(video.playbackRate) && video.playbackRate > 0 ? video.playbackRate : 1,
      applied: rate,
    };
    entry.applied = rate;
    applied.set(video, entry);
    if (Math.abs(video.playbackRate - rate) <= RATE_EPSILON) return;
    try {
      video.playbackRate = rate;
    } catch {
      applied.delete(video);
    }
  };

  const tick = () => {
    if (stopped) return;
    if (!settings.get().catchUpLatency) {
      restoreAll();
      return;
    }
    const videos = doc.querySelectorAll("video");
    const seen = new Set<HTMLVideoElement>();
    for (const video of videos) {
      seen.add(video);
      sync(video);
    }
    for (const video of [...applied.keys()]) {
      if (!seen.has(video)) restore(video);
    }
  };

  const unsubscribe = settings.subscribe(tick);
  void settings.ready.then(tick);
  const timer = win.setInterval(tick, LATENCY_CHECK_INTERVAL_MS);
  tick();
  return () => {
    stopped = true;
    win.clearInterval(timer);
    unsubscribe();
    restoreAll();
  };
}
