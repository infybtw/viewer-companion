import type { Accounts } from "./accounts";
import { errorMessage } from "./shared";
import {
  AUTH_ATTEMPT_LIFETIME,
  createTwirAuth,
  type AuthRecord,
  type AuthSession,
  type AuthStore,
} from "./twir-auth";
import {
  hasUserscriptStorage,
  readUserscriptValue,
  writeUserscriptValue,
} from "./userscript-storage";

// The public OAuth app must allow this exact callback. The userscript runs in
// the popup on this page, stores the one-time callback in GM storage and closes
// it. The stream page never reads the authorization code.
export const USERSCRIPT_REDIRECT_URI = "https://www.twitch.tv/";
export const AUTH_RECORD_KEY = "twirOAuth";
export const AUTH_SESSION_KEY = "twirOAuthSession";
export const AUTH_CALLBACK_KEY = "twirOAuthCallback";
export const AUTH_WINDOW_NAME = "viewer-companion-twir";
const CALLBACK_POLL_MS = 250;
const CALLBACK_CLOSE_GRACE_MS = 2_000;

interface AuthCallback {
  state: string;
  url: string;
}

// GM storage is shared by the userscript across Twitch and Kick tabs but is
// isolated from the pages themselves. Never fall back to website storage here.
export function createUserscriptAuthStore(): AuthStore {
  return {
    async read() {
      return readUserscriptValue<AuthRecord>(AUTH_RECORD_KEY, {});
    },
    async write(record) {
      writeUserscriptValue(AUTH_RECORD_KEY, record);
    },
    async readSession() {
      return readUserscriptValue<AuthSession>(AUTH_SESSION_KEY, {});
    },
    async writeSession(session) {
      writeUserscriptValue(AUTH_SESSION_KEY, session);
    },
  };
}

function readAuthCallback(): AuthCallback | null {
  const value = readUserscriptValue<unknown>(AUTH_CALLBACK_KEY, null);
  if (!value || typeof value !== "object") return null;
  const { state, url } = value as Record<string, unknown>;
  return typeof state === "string" && typeof url === "string" ? { state, url } : null;
}

// Runs in the OAuth popup as soon as the userscript starts. It never touches
// the opener or page storage: the opener polls the shared GM value instead.
// A matching one-time state, not window.opener, identifies our callback, so the
// popup still works if the site uses Cross-Origin-Opener-Policy.
export function relayUserscriptAuthCallback(): void {
  if (typeof window === "undefined") return;
  try {
    const callback = new URL(location.href);
    const expected = new URL(USERSCRIPT_REDIRECT_URI);
    if (
      callback.origin !== expected.origin ||
      callback.pathname !== expected.pathname ||
      callback.hash ||
      callback.username ||
      callback.password
    )
      return;
    const states = callback.searchParams.getAll("state");
    const codes = callback.searchParams.getAll("code");
    const errors = callback.searchParams.getAll("error");
    if (states.length !== 1 || (codes.length === 0 && errors.length === 0)) return;
    if (codes.length > 1 || errors.length > 1) return;
    if (!hasUserscriptStorage()) return;
    const session = readUserscriptValue<AuthSession>(AUTH_SESSION_KEY, {});
    const attempt = session.attempt;
    if (!attempt || attempt.state !== states[0] || attempt.expiresAt <= Date.now()) return;
    writeUserscriptValue(AUTH_CALLBACK_KEY, { state: attempt.state, url: callback.href });
    // Give the manager a moment to persist the GM value before the tab closes.
    setTimeout(() => {
      try {
        window.close();
      } catch {}
    }, 50);
  } catch {
    // A callback page must never interrupt the host page.
  }
}

export interface UserscriptAuthOptions {
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
  open?: (url: string) => Window | null;
  now?: () => number;
}

export function createUserscriptAuth(options: UserscriptAuthOptions = {}) {
  const store = createUserscriptAuthStore();
  const openPopup =
    options.open ??
    ((url: string) =>
      window.open(url, AUTH_WINDOW_NAME, "popup,width=520,height=720,resizable=yes"));
  let pendingPopup: Window | null = null;
  let cancelActiveLaunch: (() => void) | undefined;
  let launchCanceled = false;

  function closePendingPopup() {
    if (!pendingPopup) return;
    try {
      pendingPopup.close();
    } catch {}
    pendingPopup = null;
  }

  function launch(authorizeUrl: string): Promise<string> {
    if (launchCanceled) {
      launchCanceled = false;
      closePendingPopup();
      return Promise.reject(new Error("Twir sign-in was canceled."));
    }
    let expectedState: string | null = null;
    try {
      expectedState = new URL(authorizeUrl).searchParams.get("state");
    } catch {}
    if (!expectedState)
      return Promise.reject(new Error("Twir sign-in request is missing its security state."));
    try {
      writeUserscriptValue(AUTH_CALLBACK_KEY, null);
    } catch (error) {
      return Promise.reject(error);
    }

    const preOpened = pendingPopup;
    pendingPopup = null;
    let popup: Window | null = null;
    try {
      popup = preOpened ?? openPopup(authorizeUrl);
      // The settings click opens a blank popup synchronously. Navigating it
      // here keeps the browser's user gesture from being lost to an async
      // storage read, while the PKCE state is already stored by now.
      if (preOpened) preOpened.location.replace(authorizeUrl);
    } catch (error) {
      try {
        (preOpened ?? popup)?.close();
      } catch {}
      return Promise.reject(
        new Error(`Could not open the Twir sign-in window: ${errorMessage(error)}`),
      );
    }
    if (!popup)
      return Promise.reject(
        new Error(
          "Your browser blocked the Twir sign-in window. Allow popups for this site and try again.",
        ),
      );

    return new Promise<string>((resolve, reject) => {
      let done = false;
      let callbackUrl = "";
      let closedAt = 0;
      let poll: ReturnType<typeof setInterval> | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const closePopup = () => {
        try {
          popup?.close();
        } catch {}
      };
      const finish = (error?: Error) => {
        if (done) return;
        done = true;
        if (poll !== undefined) clearInterval(poll);
        if (timeout !== undefined) clearTimeout(timeout);
        cancelActiveLaunch = undefined;
        if (error) reject(error);
        else resolve(callbackUrl);
      };
      const useCallback = (callback: AuthCallback) => {
        callbackUrl = callback.url;
        try {
          writeUserscriptValue(AUTH_CALLBACK_KEY, null);
        } catch {}
        closePopup();
        finish();
      };
      const check = () => {
        const callback = readAuthCallback();
        if (callback?.state === expectedState) {
          useCallback(callback);
          return;
        }
        if (!popup?.closed) return;
        // The popup may have stored the callback between polls and closed. GM
        // storage is shared but propagation can lag slightly across tabs.
        const last = readAuthCallback();
        if (last?.state === expectedState) {
          useCallback(last);
          return;
        }
        if (!closedAt) closedAt = Date.now();
        if (Date.now() - closedAt < CALLBACK_CLOSE_GRACE_MS) return;
        finish(new Error("Twir sign-in was canceled."));
      };

      cancelActiveLaunch = () => {
        closePopup();
        finish(new Error("Twir sign-in was canceled."));
      };
      poll = setInterval(check, CALLBACK_POLL_MS);
      timeout = setTimeout(() => {
        closePopup();
        finish(new Error("Twir sign-in timed out. Try connecting again."));
      }, AUTH_ATTEMPT_LIFETIME);
      check();
    });
  }

  const auth = createTwirAuth({
    store,
    redirectUri: () => USERSCRIPT_REDIRECT_URI,
    launch,
    fetcher: options.fetcher,
    now: options.now,
  });

  const accounts: Accounts = {
    status: () => auth.status(),
    connect() {
      launchCanceled = false;
      closePendingPopup();
      // Open the window while the click gesture is still active. Some browsers
      // reject window.open after the asynchronous PKCE/storage preparation.
      let popup: Window | null;
      try {
        popup = openPopup("");
      } catch (error) {
        return Promise.reject(
          new Error(`Could not open the Twir sign-in window: ${errorMessage(error)}`),
        );
      }
      if (!popup)
        return Promise.reject(
          new Error(
            "Your browser blocked the Twir sign-in window. Allow popups for this site and try again.",
          ),
        );
      pendingPopup = popup;
      return auth.connect().catch((error) => {
        if (pendingPopup === popup) {
          try {
            popup.close();
          } catch {}
          pendingPopup = null;
        }
        throw error;
      });
    },
    async disconnect() {
      // Cancel waits for the popup too, so the settings panel can show the
      // disconnected state immediately instead of leaving an orphaned window.
      launchCanceled = true;
      closePendingPopup();
      cancelActiveLaunch?.();
      try {
        writeUserscriptValue(AUTH_CALLBACK_KEY, null);
      } catch {}
      return auth.disconnect();
    },
  };

  return { auth, accounts };
}
