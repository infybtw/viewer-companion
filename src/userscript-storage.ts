// Tampermonkey and Violentmonkey expose these as globals. They stay isolated
// from the page, including site localStorage and page scripts.
declare const GM_getValue: ((key: string, fallback?: unknown) => unknown) | undefined;
declare const GM_setValue: ((key: string, value: unknown) => void) | undefined;

export function hasUserscriptStorage(): boolean {
  return typeof GM_getValue !== "undefined" && typeof GM_setValue !== "undefined";
}

export function readUserscriptValue<T>(key: string, fallback: T): T {
  if (typeof GM_getValue === "undefined") return fallback;
  try {
    const value = GM_getValue(key, fallback);
    // Some managers serialize values; accept both native objects and JSON.
    if (typeof value === "string") {
      try {
        return JSON.parse(value) as T;
      } catch {
        return fallback;
      }
    }
    return (value ?? fallback) as T;
  } catch {
    return fallback;
  }
}

export function writeUserscriptValue(key: string, value: unknown): void {
  if (!hasUserscriptStorage())
    throw new Error(
      "Userscript storage is unavailable. Enable GM_getValue and GM_setValue in the userscript manager.",
    );
  GM_setValue!(key, value);
}
