import type { Accounts, TwirAccountStatus } from "./accounts";
import { errorMessage } from "./shared";

export function createAccountsUi(doc: Document, accounts?: Accounts) {
  const section = doc.createElement("section");
  section.className = "account";
  section.setAttribute("aria-labelledby", "twir-account-title");
  const title = doc.createElement("strong");
  title.id = "twir-account-title";
  title.textContent = "Twir";
  const state = doc.createElement("p");
  state.className = "status";
  state.setAttribute("role", "status");
  state.setAttribute("aria-live", "polite");
  section.append(title, state);

  if (!accounts) {
    state.textContent = "Sign-in is unavailable in this build.";
    return { section, dispose() {} };
  }

  const actions = doc.createElement("div");
  actions.className = "actions";
  const connect = doc.createElement("button");
  connect.type = "button";
  connect.className = "action primary";
  connect.textContent = "Sign in";
  const disconnect = doc.createElement("button");
  disconnect.type = "button";
  disconnect.className = "action";
  disconnect.textContent = "Sign out";
  disconnect.hidden = true;
  const feedback = doc.createElement("p");
  feedback.className = "status";
  feedback.setAttribute("role", "status");
  feedback.setAttribute("aria-live", "polite");
  actions.append(connect, disconnect);
  section.append(actions, feedback);

  let disposed = false;
  let busy = false;
  let checking = true;
  let current: TwirAccountStatus | undefined;
  let version = 0;
  const render = () => {
    state.textContent =
      current === "connected"
        ? "Signed in"
        : current === "reconnect-required"
          ? "Session expired. Uploads paused until you sign in again."
          : current === "connecting"
            ? "Finish signing in in the Twir window."
            : current === "disconnected"
              ? ""
              : checking
                ? "Checking…"
                : "";
    state.dataset.tone = current === "reconnect-required" ? "error" : "info";
    connect.textContent =
      current === "reconnect-required"
        ? "Sign in again"
        : current === "connecting"
          ? "Signing in…"
          : "Sign in";
    connect.hidden = current === "connected";
    connect.disabled = busy || checking || current === "connecting";
    disconnect.hidden = !current || current === "disconnected";
    // Cancel remains available while the OAuth window is open.
    disconnect.disabled = busy && current !== "connecting";
    disconnect.textContent = current === "connecting" ? "Cancel sign-in" : "Sign out";
  };
  const refresh = async () => {
    const requestVersion = version;
    try {
      const next = await accounts.status();
      if (disposed || requestVersion !== version) return;
      current = next;
      checking = false;
      render();
    } catch {
      if (!disposed && requestVersion === version) {
        // A passive status check must not block sign-in or replace action feedback.
        // Keep the last known state; do not assume an unknown account is signed out.
        checking = false;
        render();
      }
    }
  };
  const run = async (operation: "connect" | "disconnect") => {
    if (busy && !(operation === "disconnect" && current === "connecting")) return;
    const operationVersion = ++version;
    const previous = current;
    busy = true;
    feedback.textContent = "";
    feedback.dataset.tone = "info";
    if (operation === "connect") current = "connecting";
    render();
    try {
      if (operation === "connect") {
        await accounts.connect();
        if (!disposed && operationVersion === version) current = "connected";
      } else {
        const result = await accounts.disconnect();
        if (!disposed && operationVersion === version) {
          current = "disconnected";
          feedback.textContent = result.revoked
            ? "Signed out."
            : "Signed out locally. Revoke access in Twir to finish.";
        }
      }
    } catch (error) {
      if (!disposed && operationVersion === version) {
        current = previous;
        feedback.textContent = errorMessage(error);
        feedback.dataset.tone = "error";
      }
    } finally {
      if (!disposed && operationVersion === version) {
        busy = false;
        render();
        await refresh();
      }
    }
  };
  connect.addEventListener("click", () => void run("connect"));
  disconnect.addEventListener("click", () => void run("disconnect"));
  render();
  void refresh();
  // Poll only while this panel is open and Accounts is visible. No credentials
  // are exposed through storage change events or runtime replies.
  const timer = doc.defaultView?.setInterval(() => {
    if (!doc.hidden && section.isConnected && !section.parentElement?.hidden && !busy)
      void refresh();
  }, 3_000);
  return {
    section,
    dispose() {
      disposed = true;
      doc.defaultView?.clearInterval(timer);
    },
  };
}
