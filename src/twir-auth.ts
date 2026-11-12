import type { TwirAccountStatus } from "./accounts";
import { authErrorDetail, oauthSecretValues } from "./auth-errors";

const OAUTH_BASE = "https://twir.app/api/oauth";
// Public application identifier, not a secret. Never embed a client_secret.
export const TWIR_CLIENT_ID = "ZpsvaPsnURNKY-cBtc-aXAjf4ek6GGZyovQ0ZdMbE2U";
export const TWIR_RESOURCE = "https://twir.app/api";
export const TWIR_SCOPE = "files:edit";
const REQUEST_TIMEOUT = 15_000;
export const AUTH_ATTEMPT_LIFETIME = 10 * 60_000;
const RECONNECT = "Your Twir connection has expired. Reconnect Twir in Settings → Accounts.";

export interface OAuthClient {
  id: string;
  redirectUri: string;
}

export interface TwirGrant {
  id: string;
  // Disabled grants retain tokens only for remote revocation, never for uploads.
  refreshToken: string | null;
  needsReconnect?: true;
}

export interface AuthRecord {
  client?: OAuthClient;
  grant?: TwirGrant;
}

export interface AccessToken {
  grantId: string;
  token: string;
  expiresAt: number;
}

export interface AuthAttempt {
  id: string;
  state: string;
  verifier: string;
  client: OAuthClient;
  expiresAt: number;
}

export interface AuthSession {
  access?: AccessToken;
  attempt?: AuthAttempt;
}

export interface AuthStore {
  read(): Promise<AuthRecord>;
  write(record: AuthRecord): Promise<void>;
  readSession(): Promise<AuthSession>;
  writeSession(session: AuthSession): Promise<void>;
}

interface AuthDependencies {
  store: AuthStore;
  redirectUri: () => string;
  launch: (url: string) => Promise<string | undefined>;
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
}

class InvalidGrant extends Error {}

function oauthError(
  value: unknown,
  description?: unknown,
  secrets: readonly string[] = [],
): string {
  const detail = authErrorDetail(description, secrets);
  const knownCode =
    typeof value === "string" &&
    [
      "access_denied",
      "invalid_scope",
      "invalid_target",
      "invalid_client",
      "invalid_grant",
      "unauthorized_client",
      "invalid_request",
      "unsupported_response_type",
      "server_error",
      "temporarily_unavailable",
    ].includes(value)
      ? ` (${value})`
      : "";
  if (detail) return `Twir OAuth${knownCode}: ${detail}`;
  // Keep local recovery hints only when Twir did not provide a description.
  switch (value) {
    case "access_denied":
      return "Twir access was not granted (access_denied). Approve the file permission and try connecting again.";
    case "invalid_scope":
      return "Twir rejected the file permission (invalid_scope). Enable files:edit for the Viewer Companion OAuth app.";
    case "invalid_target":
      return "Twir rejected the API resource (invalid_target). The OAuth app must allow https://twir.app/api.";
    case "invalid_client":
      return "Twir rejected the OAuth app (invalid_client). Check its client ID and public PKCE client configuration.";
    case "invalid_grant":
      return "Twir rejected the authorization code or refresh token (invalid_grant).";
    case "unauthorized_client":
      return "Twir does not allow this sign-in flow (unauthorized_client). Enable Authorization Code with PKCE for the OAuth app.";
    case "invalid_request":
      return "Twir rejected the sign-in request (invalid_request). Check the app's registered redirect URIs and PKCE configuration.";
    case "unsupported_response_type":
      return "Twir does not allow authorization codes (unsupported_response_type). Enable Authorization Code for the OAuth app.";
    case "server_error":
    case "temporarily_unavailable":
      return `Twir sign-in is temporarily unavailable (${value}). Try again later.`;
    default:
      return "Twir access was not granted. Try connecting again.";
  }
}

function randomSecret(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
}

function bearer(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 16_384 &&
    /^[A-Za-z0-9._~+\/-]+=*$/.test(value)
  );
}

function tokenSet(value: unknown) {
  const data = value as Record<string, unknown> | null;
  if (
    !data ||
    !bearer(data.access_token) ||
    !bearer(data.refresh_token) ||
    typeof data.token_type !== "string" ||
    data.token_type.toLowerCase() !== "bearer" ||
    typeof data.expires_in !== "number" ||
    !Number.isSafeInteger(data.expires_in) ||
    data.expires_in <= 0 ||
    data.expires_in > 365 * 24 * 60 * 60 ||
    typeof data.scope !== "string" ||
    !data.scope.split(/\s+/).includes(TWIR_SCOPE)
  )
    throw new Error("Twir returned an invalid token response. Try connecting again.");
  return { access: data.access_token, refresh: data.refresh_token, expiresIn: data.expires_in };
}

export function createTwirAuth({
  store,
  redirectUri,
  launch,
  fetcher = fetch,
  now = Date.now,
}: AuthDependencies) {
  // Serialize refreshes and storage mutations across tabs. Never hold this lock
  // while the user is interacting with the authorization window.
  let queue: Promise<unknown> = Promise.resolve();
  const locked = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };

  async function request(path: "token" | "revoke", body: URLSearchParams) {
    try {
      return await fetcher(`${OAUTH_BASE}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      });
    } catch (error) {
      const detail = authErrorDetail(error, oauthSecretValues(Object.fromEntries(body)));
      throw new Error(
        `Could not reach Twir (${path} request): ${detail || "No network error details were provided."}`,
      );
    }
  }

  async function json(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new Error("Twir returned an invalid response. Try again.");
    }
  }

  async function exchange(parameters: Record<string, string>) {
    const response = await request(
      "token",
      new URLSearchParams({ ...parameters, resource: TWIR_RESOURCE }),
    );
    if (!response.ok) {
      // Error bodies may be HTML or empty. Still report the exact HTTP status,
      // but never render an entire raw response body.
      const value: unknown = await response.json().catch(() => null);
      const body = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
      const secrets = [...oauthSecretValues(parameters), ...oauthSecretValues(body)];
      const reason =
        typeof body.error === "string" || typeof body.error_description === "string"
          ? oauthError(body.error, body.error_description, secrets)
          : "Twir returned no OAuth error details.";
      const message = `Twir token request failed (HTTP ${response.status}): ${reason}`;
      if (body.error === "invalid_grant") throw new InvalidGrant(`${message} ${RECONNECT}`);
      if (body.error === "invalid_client") throw new InvalidGrant(message);
      throw new Error(message);
    }
    return tokenSet(await json(response));
  }

  function isCurrentClient(client: OAuthClient | undefined): boolean {
    return client?.id === TWIR_CLIENT_ID && client.redirectUri === redirectUri();
  }

  async function sessionState(): Promise<AuthSession> {
    const session = await store.readSession();
    // Drop old dynamically registered attempts after an upgrade, and purge
    // expired PKCE state. Never exchange their codes using the configured app.
    if (
      session.attempt &&
      (!isCurrentClient(session.attempt.client) || session.attempt.expiresAt <= now())
    ) {
      const clean = { access: session.access };
      await store.writeSession(clean);
      return clean;
    }
    return session;
  }

  async function revoke(client: OAuthClient | undefined, tokens: (string | undefined | null)[]) {
    const results = await Promise.all(
      [...new Set(tokens.filter((token): token is string => !!token))].map(async (token) => {
        try {
          return (
            await request(
              "revoke",
              new URLSearchParams({ token, ...(client ? { client_id: client.id } : {}) }),
            )
          ).ok;
        } catch {
          return false;
        }
      }),
    );
    return results.every(Boolean);
  }

  async function status(): Promise<TwirAccountStatus> {
    return locked(async () => {
      const session = await sessionState();
      if (session.attempt && session.attempt.expiresAt > now()) return "connecting";
      const record = await store.read();
      if (!record.grant) return "disconnected";
      return isCurrentClient(record.client) &&
        record.grant.refreshToken &&
        !record.grant.needsReconnect
        ? "connected"
        : "reconnect-required";
    });
  }

  async function connect() {
    const attempt = await locked(async () => {
      const session = await sessionState();
      if (session.attempt && session.attempt.expiresAt > now()) {
        throw new Error("Twir sign-in is already open. Finish it or disconnect to cancel.");
      }
      const client: OAuthClient = { id: TWIR_CLIENT_ID, redirectUri: redirectUri() };
      // Keep any old client/grant bound together until login succeeds, so failed
      // migrations can still revoke the old credentials on explicit disconnect.
      const pending: AuthAttempt = {
        id: randomSecret(),
        state: randomSecret(),
        verifier: randomSecret(),
        client,
        expiresAt: now() + AUTH_ATTEMPT_LIFETIME,
      };
      await store.writeSession({ ...session, attempt: pending });
      return pending;
    });

    try {
      const authorize = new URL(`${OAUTH_BASE}/authorize`);
      authorize.search = new URLSearchParams({
        client_id: attempt.client.id,
        redirect_uri: attempt.client.redirectUri,
        response_type: "code",
        scope: TWIR_SCOPE,
        resource: TWIR_RESOURCE,
        state: attempt.state,
        code_challenge: await pkceChallenge(attempt.verifier),
        code_challenge_method: "S256",
      }).toString();
      let callback: string | undefined;
      try {
        callback = await launch(authorize.href);
      } catch (error) {
        const detail = authErrorDetail(error, [
          attempt.state,
          attempt.verifier,
          authorize.searchParams.get("code_challenge")!,
        ]);
        throw new Error(
          `Twir sign-in failed (browser): ${detail || "The browser did not provide an error description."}`,
        );
      }
      await locked(async () => {
        const session = await store.readSession();
        if (session.attempt?.id !== attempt.id || attempt.expiresAt <= now()) {
          throw new Error(
            "This Twir sign-in attempt expired or was canceled. Try connecting again.",
          );
        }
        // Consume the attempt once, including callbacks containing an OAuth error.
        await store.writeSession({ access: session.access });
        let url: URL;
        try {
          url = new URL(callback ?? "");
        } catch {
          throw new Error("Twir did not return a valid sign-in callback.");
        }
        const expected = new URL(attempt.client.redirectUri);
        if (
          url.origin !== expected.origin ||
          url.pathname !== expected.pathname ||
          url.hash ||
          url.username ||
          url.password ||
          url.searchParams.getAll("state").length !== 1 ||
          url.searchParams.get("state") !== attempt.state
        ) {
          throw new Error("Twir sign-in verification failed. Try connecting again.");
        }
        if (url.searchParams.has("error"))
          throw new Error(
            oauthError(
              url.searchParams.getAll("error").length === 1
                ? url.searchParams.get("error")
                : undefined,
              url.searchParams.getAll("error_description").length === 1
                ? url.searchParams.get("error_description")
                : undefined,
              [...oauthSecretValues(Object.fromEntries(url.searchParams)), attempt.verifier],
            ),
          );
        const codes = url.searchParams.getAll("code");
        if (codes.length !== 1 || !codes[0]) throw new Error("Twir did not return a sign-in code.");
        const tokens = await exchange({
          grant_type: "authorization_code",
          client_id: attempt.client.id,
          redirect_uri: attempt.client.redirectUri,
          code: codes[0],
          code_verifier: attempt.verifier,
        });
        const previous = await store.read();
        const grant: TwirGrant = { id: randomSecret(), refreshToken: tokens.refresh };
        let committed = false;
        try {
          // Durable rotated refresh token first; the access cache is disposable.
          await store.write({ client: attempt.client, grant });
          committed = true;
          await store.writeSession({
            access: {
              grantId: grant.id,
              token: tokens.access,
              expiresAt: now() + tokens.expiresIn * 1000,
            },
          });
        } catch {
          if (committed) {
            // Do not leave a "connected" record for credentials we are revoking.
            try {
              await store.write({
                client: attempt.client,
                grant: { ...grant, needsReconnect: true },
              });
            } catch {}
          }
          await revoke(attempt.client, [tokens.refresh, tokens.access]);
          throw new Error("Could not save your Twir connection. Try connecting again.");
        }
        await revoke(previous.client, [previous.grant?.refreshToken, session.access?.token]);
      });
    } finally {
      await locked(async () => {
        const session = await store.readSession();
        if (session.attempt?.id === attempt.id)
          await store.writeSession({ access: session.access });
      });
    }
  }

  async function disconnect() {
    const previous = await locked(async () => {
      const record = await store.read();
      const session = await store.readSession();
      await store.write({ client: record.client });
      await store.writeSession({});
      return { record, session };
    });
    return {
      revoked: await revoke(previous.record.client, [
        previous.record.grant?.refreshToken,
        previous.session.access?.token,
      ]),
    };
  }

  async function accessToken(): Promise<AccessToken | null> {
    return locked(async () => {
      const record = await store.read();
      const session = await sessionState();
      if (session.attempt && session.attempt.expiresAt > now()) {
        throw new Error(
          "Finish connecting Twir before uploading, or cancel sign-in in Settings → Accounts.",
        );
      }
      if (!record.grant) return null;
      if (
        !record.client ||
        !isCurrentClient(record.client) ||
        !record.grant.refreshToken ||
        record.grant.needsReconnect
      )
        throw new Error(RECONNECT);
      if (session.access?.grantId === record.grant.id && session.access.expiresAt > now() + 60_000)
        return session.access;
      let tokens;
      try {
        tokens = await exchange({
          grant_type: "refresh_token",
          client_id: record.client.id,
          refresh_token: record.grant.refreshToken,
        });
      } catch (error) {
        if (error instanceof InvalidGrant) {
          await store.write({ ...record, grant: { ...record.grant, needsReconnect: true } });
        }
        throw error;
      }
      const access = {
        grantId: record.grant.id,
        token: tokens.access,
        expiresAt: now() + tokens.expiresIn * 1000,
      };
      await store.write({ ...record, grant: { ...record.grant, refreshToken: tokens.refresh } });
      await store.writeSession({ ...session, access });
      return access;
    });
  }

  async function rejectAccess(access: AccessToken) {
    await locked(async () => {
      const record = await store.read();
      const session = await store.readSession();
      // A late 401 must not disconnect a newer login or a newly refreshed token.
      if (record.grant?.id !== access.grantId || session.access?.token !== access.token) return;
      await store.write({ ...record, grant: { ...record.grant, needsReconnect: true } });
    });
  }

  return { status, connect, disconnect, accessToken, rejectAccess };
}
