import { describe, expect, mock, test } from "bun:test";
import {
  AUTH_CALLBACK_KEY,
  AUTH_RECORD_KEY,
  AUTH_SESSION_KEY,
  createUserscriptAuth,
  createUserscriptAuthStore,
  relayUserscriptAuthCallback,
  USERSCRIPT_REDIRECT_URI,
} from "../src/userscript-auth";
import { TWIR_CLIENT_ID, type AuthSession } from "../src/twir-auth";

interface Gm {
  values: Map<string, unknown>;
  restore(): void;
}

function installGm(values = new Map<string, unknown>()): Gm {
  const read = Object.getOwnPropertyDescriptor(globalThis, "GM_getValue");
  const write = Object.getOwnPropertyDescriptor(globalThis, "GM_setValue");
  (globalThis as Record<string, unknown>).GM_getValue = (key: string, fallback?: unknown) =>
    values.has(key) ? values.get(key) : fallback;
  (globalThis as Record<string, unknown>).GM_setValue = (key: string, value: unknown) => {
    values.set(key, value);
  };
  return {
    values,
    restore() {
      if (read) Object.defineProperty(globalThis, "GM_getValue", read);
      else delete (globalThis as Record<string, unknown>).GM_getValue;
      if (write) Object.defineProperty(globalThis, "GM_setValue", write);
      else delete (globalThis as Record<string, unknown>).GM_setValue;
    },
  };
}

function installWindow(opener: unknown, href: string) {
  const savedWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const savedLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const window = { opener, close: mock(() => {}) };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: window,
  });
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    writable: true,
    value: { href },
  });
  return {
    window,
    restore() {
      if (savedWindow) Object.defineProperty(globalThis, "window", savedWindow);
      else delete (globalThis as Record<string, unknown>).window;
      if (savedLocation) Object.defineProperty(globalThis, "location", savedLocation);
      else delete (globalThis as Record<string, unknown>).location;
    },
  };
}

function attempt(state: string, expiresAt = Date.now() + 60_000): AuthSession {
  return {
    attempt: {
      id: `attempt-${state}`,
      state,
      verifier: "verifier",
      client: { id: TWIR_CLIENT_ID, redirectUri: USERSCRIPT_REDIRECT_URI },
      expiresAt,
    },
  };
}

async function waitFor(predicate: () => boolean, timeout = 1_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error("Timed out waiting for auth state.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("userscript Twir authorization", () => {
  test("stores the Twir record and session only in GM storage", async () => {
    const gm = installGm();
    try {
      const store = createUserscriptAuthStore();
      const record = {
        client: { id: TWIR_CLIENT_ID, redirectUri: USERSCRIPT_REDIRECT_URI },
        grant: { id: "grant-1", refreshToken: "refresh-1" },
      };
      await store.write(record);
      expect(gm.values.get(AUTH_RECORD_KEY)).toEqual(record);
      expect(await store.read()).toEqual(record);

      // Managers that serialize values still read as structured records.
      gm.values.set(AUTH_RECORD_KEY, JSON.stringify(record));
      expect(await store.read()).toEqual(record);

      expect(await store.readSession()).toEqual({});
      const session: AuthSession = {
        access: { grantId: "grant-1", token: "access-1", expiresAt: 2_000_000 },
      };
      await store.writeSession(session);
      expect(gm.values.get(AUTH_SESSION_KEY)).toEqual(session);
      expect(await store.readSession()).toEqual(session);
    } finally {
      gm.restore();
    }
  });

  test("never falls back to website storage when GM storage is unavailable", async () => {
    const gm = installGm();
    try {
      (globalThis as Record<string, unknown>).GM_getValue = undefined;
      (globalThis as Record<string, unknown>).GM_setValue = undefined;
      const store = createUserscriptAuthStore();
      expect(await store.read()).toEqual({});
      expect(await store.readSession()).toEqual({});
      await expect(store.write({})).rejects.toThrow("Userscript storage is unavailable");
      await expect(store.writeSession({})).rejects.toThrow("Userscript storage is unavailable");
    } finally {
      gm.restore();
    }
  });

  test("relays a matching OAuth callback through GM storage and closes the popup", async () => {
    const gm = installGm();
    const href = `${USERSCRIPT_REDIRECT_URI}?code=one-time-code&state=state-1`;
    const env = installWindow({}, href);
    try {
      gm.values.set(AUTH_SESSION_KEY, attempt("state-1"));
      relayUserscriptAuthCallback();
      expect(gm.values.get(AUTH_CALLBACK_KEY)).toEqual({
        state: "state-1",
        url: href,
      });
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(env.window.close).toHaveBeenCalledTimes(1);
    } finally {
      env.restore();
      gm.restore();
    }
  });

  test("ignores callbacks without a matching pending attempt or valid URL", () => {
    for (const [name, session, opener, href] of [
      ["missing attempt", {}, {}, `${USERSCRIPT_REDIRECT_URI}?code=x&state=state-1`],
      [
        "wrong state",
        attempt("other-state"),
        {},
        `${USERSCRIPT_REDIRECT_URI}?code=x&state=state-1`,
      ],
      [
        "expired attempt",
        attempt("state-1", Date.now() - 1),
        {},
        `${USERSCRIPT_REDIRECT_URI}?code=x&state=state-1`,
      ],
      ["wrong origin", attempt("state-1"), {}, `https://example.com/?code=x&state=state-1`],
      ["missing code", attempt("state-1"), {}, `${USERSCRIPT_REDIRECT_URI}?state=state-1`],
    ] as const) {
      const gm = installGm();
      const env = installWindow(opener, href);
      try {
        gm.values.set(AUTH_SESSION_KEY, session);
        relayUserscriptAuthCallback();
        expect(gm.values.has(AUTH_CALLBACK_KEY), name).toBe(false);
        expect(env.window.close, name).not.toHaveBeenCalled();
      } finally {
        env.restore();
        gm.restore();
      }
    }
  });

  test("connects through the popup callback and keeps credentials out of the page", async () => {
    const gm = installGm();
    let popup: { closed: boolean; close(): void; location: { replace(): void } };
    popup = {
      closed: false,
      close() {
        this.closed = true;
      },
      location: { replace: mock(() => {}) },
    };
    try {
      const tokens = {
        access_token: "access-1",
        refresh_token: "refresh-1",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "files:edit",
      };
      const fetcher = mock(async (_url: string, init: RequestInit) => {
        expect(init.method).toBe("POST");
        return Response.json(tokens);
      });
      const { accounts } = createUserscriptAuth({
        fetcher,
        open: () => popup as unknown as Window,
      });
      const connecting = accounts.connect();
      await waitFor(() => gm.values.has(AUTH_SESSION_KEY));
      const session = gm.values.get(AUTH_SESSION_KEY) as AuthSession;
      const state = session.attempt?.state;
      expect(state).toBeString();
      expect(session.attempt?.client.redirectUri).toBe(USERSCRIPT_REDIRECT_URI);
      gm.values.set(AUTH_CALLBACK_KEY, {
        state,
        url: `${USERSCRIPT_REDIRECT_URI}?code=one-time-code&state=${state}`,
      });
      await connecting;

      expect(await accounts.status()).toBe("connected");
      expect(popup.closed).toBe(true);
      expect(gm.values.get(AUTH_CALLBACK_KEY)).toBeNull();
      expect(gm.values.get(AUTH_RECORD_KEY)).toMatchObject({
        client: { id: TWIR_CLIENT_ID, redirectUri: USERSCRIPT_REDIRECT_URI },
        grant: { refreshToken: tokens.refresh_token },
      });
      const [url, init] = fetcher.mock.calls[0]!;
      expect(url).toBe("https://twir.app/api/oauth/token");
      const body = init.body as URLSearchParams;
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("redirect_uri")).toBe(USERSCRIPT_REDIRECT_URI);
    } finally {
      gm.restore();
    }
  });

  test("cancels the popup and the pending attempt when signing out", async () => {
    const gm = installGm();
    const popup = {
      closed: false,
      close() {
        this.closed = true;
      },
      location: { replace: mock(() => {}) },
    };
    try {
      const { accounts } = createUserscriptAuth({
        fetcher: async () => Response.json({}),
        open: () => popup as unknown as Window,
      });
      const connecting = accounts.connect().catch((error: unknown) => error);
      await waitFor(() => gm.values.has(AUTH_SESSION_KEY));
      await accounts.disconnect();
      expect(await connecting).toMatchObject({
        message: expect.stringContaining("canceled"),
      });
      expect(popup.closed).toBe(true);
      expect(await accounts.status()).toBe("disconnected");
      expect(gm.values.get(AUTH_SESSION_KEY)).toEqual({});
    } finally {
      gm.restore();
    }
  });

  test("reports blocked sign-in popups without leaving a pending attempt", async () => {
    const gm = installGm();
    try {
      const { accounts } = createUserscriptAuth({ open: () => null });
      await expect(accounts.connect()).rejects.toThrow("blocked the Twir sign-in window");
      expect(await accounts.status()).toBe("disconnected");
      expect(gm.values.has(AUTH_SESSION_KEY)).toBe(false);
    } finally {
      gm.restore();
    }
  });
});
