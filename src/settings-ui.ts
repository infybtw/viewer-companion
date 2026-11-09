import { ChevronDown, ChevronUp } from "lucide";
import {
  MAX_LATENCY_THRESHOLD_SECONDS,
  MIN_LATENCY_THRESHOLD_SECONDS,
  type Settings,
  type SettingsController,
} from "./settings";
import { BRAND_NAME, createBrandIcon } from "./brand";
import type { Accounts } from "./accounts";
import { createAccountsUi } from "./accounts-ui";
import { normalizeDomainList, normalizeUserList } from "./preview-filters";
import {
  MAX_SETTINGS_BACKUP_BYTES,
  parseSettingsBackup,
  serializeSettingsBackup,
  settingsBackupFileName,
} from "./settings-transfer";

export const SETTINGS_BUTTON_ATTRIBUTE = "data-imageuploader-settings";
export const SETTINGS_PANEL_ATTRIBUTE = "data-imageuploader-settings-panel";

type Site = "twitch" | "kick";

const SVG_NS = "http://www.w3.org/2000/svg";

type IconNode = typeof ChevronUp;

function iconSvg(doc: Document, icon: IconNode): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg");
  for (const [name, value] of Object.entries({
    width: "12",
    height: "12",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2.5",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    focusable: "false",
  }))
    svg.setAttribute(name, value);
  for (const [tag, attributes] of icon) {
    const child = doc.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attributes)) child.setAttribute(name, String(value));
    svg.append(child);
  }
  return svg;
}

const TWITCH_ANCHORS = [
  '[data-a-target="user-menu-toggle"]',
  '[data-test-selector="user-menu__toggle"]',
  '[data-test-selector="user-menu-toggle"]',
  '[aria-label="User menu" i]',
  '[data-a-target="user-card"]',
];
const TWITCH_CONTAINERS = [
  ".top-nav__right",
  '[data-a-target="top-nav"]',
  'nav[aria-label="Top navigation bar" i]',
  "#top-nav",
];
// The authenticated Kick header renders the KICKs balance instead of the
// "Get KICKs" label, so the test id is the stable anchor. The text match below
// still covers older and logged-out variants.
const KICK_ANCHORS = [
  '[data-testid="kicks-top-nav"]',
  '[data-testid="navbar-drops"]',
  '[data-testid="navbar-display-language"]',
  '[data-testid="navbar-account"]',
];
const KICK_CONTAINERS = ['nav[aria-label="Top navigation bar" i]', "header", "nav"];
const LEAF_TAGS = new Set([
  "A",
  "BUTTON",
  "CANVAS",
  "IFRAME",
  "IMG",
  "INPUT",
  "PICTURE",
  "SELECT",
  "SVG",
  "TEXTAREA",
  "VIDEO",
]);

type Anchor = { parent: HTMLElement; before: Element | null; precise: boolean };

function siteFor(hostname: string): Site | null {
  if (hostname === "twitch.tv" || hostname.endsWith(".twitch.tv")) return "twitch";
  if (hostname === "kick.com" || hostname.endsWith(".kick.com")) return "kick";
  return null;
}

function isVisible(element: Element): boolean {
  return element.getClientRects().length > 0;
}

function visible<T extends Element>(selectors: string, doc: Document): T | null {
  return [...doc.querySelectorAll<T>(selectors)].find(isVisible) ?? null;
}

// Sites hydrate their navigation after the content script starts. Until an
// account/currency control exists, append to the rightmost wrapper rather than
// the navigation itself: an extra flex child of a `justify-between` navbar
// pushes the whole account group into the centered search field.
function rightmostGroup(container: HTMLElement): HTMLElement {
  let parent = container;
  for (let depth = 0; depth < 2; depth++) {
    const last = [...parent.children].filter(isVisible).at(-1);
    if (!last || LEAF_TAGS.has(last.tagName)) break;
    parent = last as HTMLElement;
  }
  return parent;
}

function findAnchor(doc: Document, site: Site): Anchor | null {
  if (site === "twitch") {
    // Twitch nests the avatar toggle inside a balloon wrapper. Insert before the
    // whole account control so settings becomes its own top-navigation item.
    const userMenu = visible<HTMLElement>('[data-a-target="user-menu-toggle"]', doc);
    const account = userMenu?.closest<HTMLElement>(
      '[data-a-target="dropdown-down"], [data-a-target="dropdown-up"]',
    );
    if (account?.parentElement)
      return { parent: account.parentElement, before: account, precise: true };
    for (const selector of TWITCH_ANCHORS) {
      const element = visible<HTMLElement>(selector, doc);
      if (element?.parentElement)
        return { parent: element.parentElement, before: element, precise: true };
    }
    for (const selector of TWITCH_CONTAINERS) {
      const element = visible<HTMLElement>(selector, doc);
      if (element) return { parent: rightmostGroup(element), before: null, precise: false };
    }
    return null;
  }
  const getKicks = [
    ...doc.querySelectorAll<HTMLElement>("nav button, nav a, header button, header a"),
  ].find((element) => isVisible(element) && /get\s*kicks/i.test(element.textContent ?? ""));
  if (getKicks?.parentElement)
    return { parent: getKicks.parentElement, before: getKicks, precise: true };
  for (const selector of KICK_ANCHORS) {
    const element = visible<HTMLElement>(selector, doc);
    if (element?.parentElement)
      return { parent: element.parentElement, before: element, precise: true };
  }
  for (const selector of KICK_CONTAINERS) {
    const element = visible<HTMLElement>(selector, doc);
    if (element) return { parent: rightmostGroup(element), before: null, precise: false };
  }
  return null;
}

function createButton(doc: Document, site: Site, open: () => void) {
  const host = doc.createElement("span");
  host.setAttribute(SETTINGS_BUTTON_ATTRIBUTE, site);
  host.style.cssText =
    "all:initial;display:inline-flex;align-items:center;flex:0 0 auto;margin:0 2px";
  const root = host.attachShadow({ mode: "open" });
  const style = doc.createElement("style");
  style.textContent =
    site === "kick"
      ? `
        :host { color: #fff; }
        button { all: unset; box-sizing: border-box; display: grid; place-items: center; width: 36px;
          height: 36px; border-radius: 8px; background: #27272a; color: #fff; cursor: pointer;
          transition: background-color .12s; }
        button:hover { background: #3f3f46; }
        button:focus-visible { outline: 2px solid #53fc18; outline-offset: 2px; }
      `
      : `
        :host { color: #fff; }
        button { all: unset; box-sizing: border-box; display: grid; place-items: center; width: 30px;
          height: 30px; border-radius: 6px; color: #fff; cursor: pointer; transition: background-color .12s; }
        button:hover { background: #ffffff1a; }
        button:focus-visible { outline: 2px solid #a970ff; outline-offset: 2px; }
      `;
  const button = doc.createElement("button");
  button.type = "button";
  button.title = `${BRAND_NAME} settings`;
  button.setAttribute("aria-label", `${BRAND_NAME} settings`);
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-expanded", "false");
  button.append(createBrandIcon(doc));
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    open();
  });
  root.append(style, button);
  return { host, button };
}

function toggleRow(
  doc: Document,
  title: string,
  description: string,
  checked: boolean,
  onChange: (checked: boolean) => void,
) {
  const row = doc.createElement("label");
  row.className = "row";
  const copy = doc.createElement("span");
  copy.className = "copy";
  const label = doc.createElement("strong");
  label.textContent = title;
  const hint = doc.createElement("small");
  hint.textContent = description;
  copy.append(label, hint);
  const input = doc.createElement("input");
  input.type = "checkbox";
  input.className = "switch";
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  row.append(copy, input);
  return { row, input };
}

function numberRow(
  doc: Document,
  title: string,
  description: string,
  read: () => number,
  min: number,
  max: number,
  onChange: (value: number) => void,
) {
  const row = doc.createElement("label");
  row.className = "row";
  const copy = doc.createElement("span");
  copy.className = "copy";
  const label = doc.createElement("strong");
  label.textContent = title;
  const hint = doc.createElement("small");
  hint.textContent = description;
  copy.append(label, hint);
  const input = doc.createElement("input");
  input.type = "number";
  input.className = "number";
  input.min = String(min);
  input.max = String(max);
  input.step = "1";
  input.inputMode = "numeric";
  input.value = String(read());
  input.setAttribute("aria-label", title);
  const commit = (rewrite: boolean) => {
    const parsed = Number(input.value);
    if (!input.value.trim() || !Number.isFinite(parsed)) {
      if (rewrite) input.value = String(read());
      return;
    }
    const next = Math.min(max, Math.max(min, Math.round(parsed)));
    if (next !== read()) onChange(next);
    if (rewrite) input.value = String(next);
  };
  input.addEventListener("input", () => commit(false));
  input.addEventListener("change", () => commit(true));
  const step = (delta: number) => {
    const parsed = Number(input.value);
    const base = input.value.trim() && Number.isFinite(parsed) ? Math.round(parsed) : read();
    const next = Math.min(max, Math.max(min, base + delta));
    input.value = String(next);
    if (next !== read()) onChange(next);
  };
  const stepButton = (icon: IconNode, delta: number, label: string) => {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "number-step";
    button.title = `${title}: ${label}`;
    button.setAttribute("aria-label", `${title}: ${label}`);
    button.append(iconSvg(doc, icon));
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      step(delta);
    });
    return button;
  };
  const upButton = stepButton(ChevronUp, 1, "increase");
  const downButton = stepButton(ChevronDown, -1, "decrease");
  const stepper = doc.createElement("span");
  stepper.className = "number-stepper";
  stepper.append(upButton, downButton);
  const control = doc.createElement("span");
  control.className = "number-control";
  control.append(input, stepper);
  row.append(copy, control);
  return { row, input, upButton, downButton };
}

function actionButton(doc: Document, label: string, primary = false) {
  const button = doc.createElement("button");
  button.type = "button";
  button.className = primary ? "action primary" : "action";
  button.textContent = label;
  return button;
}

function describeSettings(settings: Settings): string {
  const count = (value: number, one: string, many: string) =>
    `${value} ${value === 1 ? one : many} excluded`;
  return [
    settings.chatPreviews ? "previews on" : "previews off",
    settings.autoInsert ? "auto-insert on" : "auto-insert off",
    settings.catchUpLatency
      ? `delay catch-up on at ${settings.latencyThresholdSeconds}s`
      : "delay catch-up off",
    settings.previewClick === "viewer" ? "viewer clicks" : "website clicks",
    settings.hideBots ? "bot previews hidden" : "bot previews shown",
    count(settings.blockedUsers.length, "username", "usernames"),
    count(settings.blockedDomains.length, "domain", "domains"),
  ].join(" · ");
}

function buildPanel(doc: Document, settings: SettingsController, accounts?: Accounts) {
  const host = doc.createElement("div");
  host.setAttribute(SETTINGS_PANEL_ATTRIBUTE, "");
  host.style.cssText = "all:initial;position:fixed;z-index:2147483647;left:0;top:0";
  const root = host.attachShadow({ mode: "open" });
  const style = doc.createElement("style");
  style.textContent = `
    :host { color-scheme: dark; }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    ::selection { background: #9147ff; color: #fff; }
    .card { display: flex; flex-direction: column; width: 420px; max-width: calc(100vw - 16px);
      max-height: calc(100dvh - 16px); overflow: hidden;
      background: #18181b; color: #fafafa; border: 1px solid #3f3f46; border-radius: 10px;
      box-shadow: 0 12px 36px #0008; font: 13px/1.45 system-ui, sans-serif; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 12px;
      flex: 0 0 auto; padding: 16px 16px 4px 20px; }
    header strong { font-size: 14px; font-weight: 600; }
    button.close { display: grid; place-items: center; width: 32px; height: 32px; padding: 0;
      border: 0; border-radius: 6px; background: transparent; color: #a1a1aa;
      cursor: pointer; }
    button.close:hover { background: #27272a; color: #fafafa; }
    button:focus-visible, .choices input:focus-visible { outline: 2px solid #a78bfa; outline-offset: 2px; }
    .tabs { display: flex; flex: 0 0 auto; gap: clamp(12px, 4vw, 24px); margin: 0 20px; border-bottom: 1px solid #3f3f46; }
    .tab { min-height: 40px; padding: 8px 0; border: 0; border-bottom: 2px solid transparent;
      background: transparent; color: #a1a1aa; font: inherit; font-weight: 500; cursor: pointer; }
    .tab:hover { color: #fafafa; }
    .tab[aria-selected="true"] { border-bottom-color: #a78bfa; color: #fafafa; }
    .tab:focus-visible { outline-offset: -4px; border-radius: 4px; }
    .panels { min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 20px;
      scrollbar-color: #52525b #18181b; }
    .tab-panel { display: flex; flex-direction: column; gap: 24px; }
    .preview-settings { display: flex; flex-direction: column; gap: 16px; }
    .row { display: flex; align-items: center; gap: 16px; min-height: 44px; cursor: pointer; }
    .latency-settings { display: flex; flex-direction: column; }
    .sub-row { margin-left: 12px; padding-left: 16px; border-left: 2px solid #3f3f46; }
    .copy { display: flex; flex: 1; flex-direction: column; gap: 4px; min-width: 0; }
    .copy strong { font-size: 13px; font-weight: 500; }
    .copy small, .list small { color: #a1a1aa; font-size: 12px; line-height: 1.5; }
    .switch { appearance: none; flex: 0 0 auto; width: 34px; height: 20px; margin: 0;
      border-radius: 999px; background: #3f3f46; cursor: pointer; position: relative;
      transition: background-color .15s; }
    .switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px;
      border-radius: 50%; background: #fafafa; transition: transform .15s; }
    .switch:checked { background: #9147ff; }
    .switch:checked::after { transform: translateX(14px); }
    .switch:focus-visible { outline: 2px solid #a78bfa; outline-offset: 2px; }
    fieldset { min-width: 0; margin: 0; padding: 0; border: 0; }
    legend { padding: 0; margin-bottom: 4px; font-size: 13px; font-weight: 500; }
    .choices { display: flex; flex-wrap: wrap; gap: 4px 20px; }
    .choices label { display: flex; align-items: center; gap: 6px; color: #d4d4d8;
      min-height: 32px; cursor: pointer; }
    .choices input { accent-color: #9147ff; margin: 0; }
    fieldset:disabled legend, fieldset:disabled label { color: #a1a1aa; cursor: default; }
    .list { display: flex; flex-direction: column; gap: 4px; }
    .list span { font-weight: 500; }
    .number-control { position: relative; display: flex; flex: 0 0 auto; }
    .number { width: 76px; min-height: 32px; padding: 4px 28px 4px 8px;
      border: 1px solid #52525b; border-radius: 6px; background: #09090b; color: #fafafa;
      font: 13px/1.5 system-ui, sans-serif; text-align: right; appearance: textfield;
      -moz-appearance: textfield; }
    .number::-webkit-outer-spin-button, .number::-webkit-inner-spin-button {
      -webkit-appearance: none; margin: 0; }
    .number:hover { border-color: #71717a; }
    .number:focus-visible { outline: 2px solid #a78bfa; outline-offset: 1px; }
    .number-stepper { position: absolute; top: 1px; right: 1px; bottom: 1px; width: 22px;
      display: flex; flex-direction: column; border-left: 1px solid #3f3f46; }
    .number-step { all: unset; box-sizing: border-box; flex: 1; display: grid; place-items: center;
      color: #a1a1aa; cursor: pointer; }
    .number-step:first-child { border-bottom: 1px solid #3f3f46; border-radius: 0 5px 0 0; }
    .number-step:last-child { border-radius: 0 0 5px 0; }
    .number-step:hover { background: #27272a; color: #fafafa; }
    .number-step:focus-visible { outline: 2px solid #a78bfa; outline-offset: -2px; }
    .number-step:disabled { opacity: .45; cursor: default; }
    textarea { width: 100%; min-height: 80px; resize: vertical; margin-top: 4px; padding: 8px 12px;
      border: 1px solid #52525b; border-radius: 6px; background: #09090b; color: #fafafa;
      caret-color: #a78bfa; font: 13px/1.5 system-ui, sans-serif; }
    textarea::placeholder { color: #a1a1aa; opacity: 1; }
    textarea:hover { border-color: #71717a; }
    textarea:focus-visible { outline: 2px solid #a78bfa; outline-offset: 1px; }
    .backup { display: flex; flex-direction: column; gap: 16px; }
    .account { display: flex; flex-direction: column; align-items: flex-start; gap: 12px; }
    .account > strong { font-size: 18px; font-weight: 600; }
    .accounts-beta { display: flex; align-items: flex-start; gap: 8px; margin: 0; padding: 8px 12px;
      border: 1px solid #facc1533; border-radius: 6px; background: #facc151a; color: #fde047;
      font-size: 12px; line-height: 1.5; }
    .accounts-beta svg { flex: 0 0 auto; }
    .account .status { overflow-wrap: anywhere; }
    .account .status:empty { display: none; }
    .backup-copy, .review-copy { display: flex; flex-direction: column; gap: 4px; }
    .backup-copy strong, .review-copy strong { font-size: 13px; font-weight: 500; }
    .backup-copy small, .review-copy small { color: #a1a1aa; font-size: 12px; line-height: 1.5; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .action { min-height: 36px; padding: 0 12px; border: 1px solid #52525b; border-radius: 6px;
      background: #27272a; color: #fafafa; font: inherit; font-weight: 500; cursor: pointer; }
    .action:hover { background: #3f3f46; border-color: #71717a; }
    .action:disabled { opacity: .55; cursor: default; }
    .action.primary { border-color: #9147ff; background: #9147ff; }
    .action.primary:hover { background: #a970ff; border-color: #a970ff; }
    .review { display: flex; flex-direction: column; gap: 12px; padding-top: 16px;
      border-top: 1px solid #3f3f46; }
    .review-copy strong { overflow-wrap: anywhere; }
    .status { margin: 0; color: #a1a1aa; font-size: 12px; line-height: 1.5; }
    .status[data-tone="error"] { color: #fca5a5; }
    .note { flex: 0 0 auto; margin: 0; padding: 0 20px 16px; color: #a1a1aa; font-size: 12px; }
    @media (prefers-reduced-motion: reduce) {
      .switch, .switch::after { transition: none; }
    }
  `;
  const card = doc.createElement("section");
  card.className = "card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", `${BRAND_NAME} settings`);
  card.addEventListener("click", (event) => event.stopPropagation());

  const header = doc.createElement("header");
  const title = doc.createElement("strong");
  title.textContent = BRAND_NAME;
  const closeButton = doc.createElement("button");
  closeButton.type = "button";
  closeButton.className = "close";
  const closeIcon = doc.createElementNS(SVG_NS, "svg");
  closeIcon.setAttribute("width", "16");
  closeIcon.setAttribute("height", "16");
  closeIcon.setAttribute("viewBox", "0 0 24 24");
  closeIcon.setAttribute("aria-hidden", "true");
  closeIcon.setAttribute("focusable", "false");
  const closePath = doc.createElementNS(SVG_NS, "path");
  closePath.setAttribute("d", "M18 6 6 18M6 6l12 12");
  closePath.setAttribute("stroke", "currentColor");
  closePath.setAttribute("stroke-width", "2");
  closePath.setAttribute("stroke-linecap", "round");
  closeIcon.append(closePath);
  closeButton.append(closeIcon);
  closeButton.setAttribute("aria-label", "Close settings");
  header.append(title, closeButton);

  const tabList = doc.createElement("div");
  tabList.className = "tabs";
  tabList.setAttribute("role", "tablist");
  tabList.setAttribute("aria-label", "Settings categories");
  const panels = doc.createElement("div");
  panels.className = "panels";
  const tabs: HTMLButtonElement[] = [];
  const tabPanels: HTMLElement[] = [];
  const note = doc.createElement("p");
  note.className = "note";
  note.textContent = "Changes apply immediately and are saved in this browser.";
  const selectTab = (index: number) => {
    tabs.forEach((tab, position) => {
      const selected = position === index;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      tabPanels[position]!.hidden = !selected;
    });
    note.hidden = tabs[index]?.id === "settings-tab-accounts";
    panels.scrollTop = 0;
  };
  for (const [id, label] of [
    ["general", "General"],
    ["filters", "Filters"],
    ["accounts", "Accounts"],
    ["backup", "Backup"],
  ] as const) {
    const tab = doc.createElement("button");
    const index = tabs.length;
    tab.type = "button";
    tab.id = `settings-tab-${id}`;
    tab.className = "tab";
    tab.textContent = label;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", `settings-panel-${id}`);
    tab.addEventListener("click", () => selectTab(index));
    tab.addEventListener("keydown", (event) => {
      let next: number;
      switch (event.key) {
        case "ArrowRight":
          next = (index + 1) % tabs.length;
          break;
        case "ArrowLeft":
          next = (index + tabs.length - 1) % tabs.length;
          break;
        case "Home":
          next = 0;
          break;
        case "End":
          next = tabs.length - 1;
          break;
        default:
          return;
      }
      event.preventDefault();
      event.stopPropagation();
      selectTab(next);
      tabs[next]!.focus({ preventScroll: true });
    });
    const tabPanel = doc.createElement("div");
    tabPanel.id = `settings-panel-${id}`;
    tabPanel.className = "tab-panel";
    tabPanel.setAttribute("role", "tabpanel");
    tabPanel.setAttribute("aria-labelledby", tab.id);
    tabs.push(tab);
    tabPanels.push(tabPanel);
    tabList.append(tab);
    panels.append(tabPanel);
  }
  selectTab(0);

  const previews = toggleRow(
    doc,
    "Preview links in chat",
    "Show image thumbnails below messages with links.",
    settings.get().chatPreviews,
    (checked) => settings.update({ chatPreviews: checked }),
  );
  const autoInsert = toggleRow(
    doc,
    "Auto-insert uploaded links",
    "Adds the link to your draft, but never sends it. The upload notification stays open until you send the message.",
    settings.get().autoInsert,
    (checked) => settings.update({ autoInsert: checked }),
  );
  const catchUpLatency = toggleRow(
    doc,
    "Catch up stream delay",
    "When the live stream falls behind, play 2-4% faster (up to 1.04x) until it catches up. Resolution and audio pitch are unchanged.",
    settings.get().catchUpLatency,
    (checked) => settings.update({ catchUpLatency: checked }),
  );
  const latencyThreshold = numberRow(
    doc,
    "Start catch-up after",
    "Seconds behind the live edge before playback starts speeding up. Lower values keep you closer to live but may reduce the buffer.",
    () => settings.get().latencyThresholdSeconds,
    MIN_LATENCY_THRESHOLD_SECONDS,
    MAX_LATENCY_THRESHOLD_SECONDS,
    (value) => settings.update({ latencyThresholdSeconds: value }),
  );
  latencyThreshold.row.classList.add("sub-row");
  latencyThreshold.row.hidden = !settings.get().catchUpLatency;
  latencyThreshold.input.disabled = !settings.get().catchUpLatency;
  latencyThreshold.upButton.disabled = !settings.get().catchUpLatency;
  latencyThreshold.downButton.disabled = !settings.get().catchUpLatency;
  const latencySettings = doc.createElement("div");
  latencySettings.className = "latency-settings";
  latencySettings.append(catchUpLatency.row, latencyThreshold.row);

  const fieldset = doc.createElement("fieldset");
  fieldset.disabled = !settings.get().chatPreviews;
  const legend = doc.createElement("legend");
  legend.textContent = "Clicking a chat preview";
  const choices = doc.createElement("div");
  choices.className = "choices";
  const radios: HTMLInputElement[] = [];
  for (const [value, labelText] of [
    ["viewer", "Open viewer"],
    ["site", "Open website"],
  ] as const) {
    const label = doc.createElement("label");
    const input = doc.createElement("input");
    input.type = "radio";
    input.name = "preview-click";
    input.value = value;
    input.checked = settings.get().previewClick === value;
    input.addEventListener("change", () => {
      if (input.checked) settings.update({ previewClick: value });
    });
    radios.push(input);
    label.append(input, doc.createTextNode(labelText));
    choices.append(label);
  }
  fieldset.append(legend, choices);

  const bots = toggleRow(
    doc,
    "Hide previews from bots",
    "Known bot accounts and messages with a bot badge. Add other bots to the username list.",
    settings.get().hideBots,
    (checked) => settings.update({ hideBots: checked }),
  );
  const listField = (
    key: "blockedUsers" | "blockedDomains",
    labelText: string,
    hint: string,
    placeholder: string,
    normalize: (value: unknown) => string[],
  ) => {
    const label = doc.createElement("label");
    label.className = "list";
    const title = doc.createElement("span");
    title.textContent = labelText;
    const description = doc.createElement("small");
    description.textContent = hint;
    const input = doc.createElement("textarea");
    input.name = key;
    input.rows = 2;
    input.placeholder = placeholder;
    input.spellcheck = false;
    input.value = settings.get()[key].join("\n");
    input.addEventListener("input", () => settings.update({ [key]: normalize(input.value) }));
    label.append(title, description, input);
    const sync = (values: string[]) => {
      // Preserve the raw draft across tabs and unrelated settings changes, while
      // still accepting a different list saved by another browser tab.
      if (root.activeElement !== input && normalize(input.value).join("\n") !== values.join("\n"))
        input.value = values.join("\n");
    };
    return { label, input, sync };
  };
  const users = listField(
    "blockedUsers",
    "Excluded usernames",
    "One per line or separated by commas. Case-insensitive; @ is optional.",
    "username, another_user",
    normalizeUserList,
  );
  const domains = listField(
    "blockedDomains",
    "Excluded domains",
    "One per line or separated by commas. Includes subdomains; URLs are accepted too.",
    "example.com, another.site",
    normalizeDomainList,
  );
  const previewSettings = doc.createElement("div");
  previewSettings.className = "preview-settings";
  previewSettings.append(previews.row, fieldset);
  tabPanels[0]!.append(previewSettings, autoInsert.row, latencySettings);
  tabPanels[1]!.append(bots.row, users.label, domains.label);
  const accountsBeta = doc.createElement("p");
  accountsBeta.id = "settings-accounts-beta";
  accountsBeta.className = "accounts-beta";
  const warningIcon = doc.createElementNS(SVG_NS, "svg");
  warningIcon.setAttribute("width", "18");
  warningIcon.setAttribute("height", "18");
  warningIcon.setAttribute("viewBox", "0 0 24 24");
  warningIcon.setAttribute("fill", "none");
  warningIcon.setAttribute("stroke", "currentColor");
  warningIcon.setAttribute("stroke-width", "2");
  warningIcon.setAttribute("stroke-linecap", "round");
  warningIcon.setAttribute("stroke-linejoin", "round");
  warningIcon.setAttribute("aria-hidden", "true");
  warningIcon.setAttribute("focusable", "false");
  const warningPath = doc.createElementNS(SVG_NS, "path");
  warningPath.setAttribute("d", "M12 3 2 21h20L12 3ZM12 9v4m0 4h.01");
  warningIcon.append(warningPath);
  const betaCopy = doc.createElement("span");
  betaCopy.textContent = "Sign-in is in beta.";
  accountsBeta.append(warningIcon, betaCopy);
  const accountUi = createAccountsUi(doc, accounts);
  tabPanels[2]!.setAttribute("aria-describedby", accountsBeta.id);
  tabPanels[2]!.append(accountsBeta, accountUi.section);

  const backup = doc.createElement("section");
  backup.className = "backup";
  const backupCopy = doc.createElement("div");
  backupCopy.className = "backup-copy";
  const backupTitle = doc.createElement("strong");
  backupTitle.textContent = "Move settings between browsers";
  const backupHint = doc.createElement("small");
  backupHint.id = "settings-backup-hint";
  backupHint.textContent =
    "Export a JSON backup, or replace these settings from one. The file includes your excluded usernames and domains, but no chats, drafts, or uploads.";
  backupCopy.append(backupTitle, backupHint);
  const actions = doc.createElement("div");
  actions.className = "actions";
  const exportButton = actionButton(doc, "Export settings");
  const importButton = actionButton(doc, "Import settings");
  importButton.setAttribute("aria-describedby", backupHint.id);
  actions.append(exportButton, importButton);

  const fileInput = doc.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".json,application/json";
  fileInput.hidden = true;

  const review = doc.createElement("div");
  review.className = "review";
  review.hidden = true;
  review.setAttribute("role", "group");
  const reviewCopy = doc.createElement("div");
  reviewCopy.className = "review-copy";
  const reviewTitle = doc.createElement("strong");
  reviewTitle.id = "settings-import-review-title";
  const reviewSummary = doc.createElement("small");
  reviewSummary.id = "settings-import-review-summary";
  reviewCopy.append(reviewTitle, reviewSummary);
  review.setAttribute("aria-labelledby", reviewTitle.id);
  review.setAttribute("aria-describedby", reviewSummary.id);
  const reviewActions = doc.createElement("div");
  reviewActions.className = "actions";
  const replaceButton = actionButton(doc, "Replace settings", true);
  replaceButton.setAttribute("aria-describedby", `${reviewTitle.id} ${reviewSummary.id}`);
  const cancelButton = actionButton(doc, "Cancel");
  reviewActions.append(replaceButton, cancelButton);
  review.append(reviewCopy, reviewActions);

  const status = doc.createElement("p");
  status.className = "status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  backup.append(backupCopy, actions, review, status, fileInput);
  tabPanels[3]!.append(backup);

  let pendingImport: Settings | null = null;
  const setStatus = (message: string, tone: "info" | "error" = "info") => {
    status.textContent = message;
    status.dataset.tone = tone;
  };
  const clearReview = (focusImport = false) => {
    pendingImport = null;
    review.hidden = true;
    if (focusImport) importButton.focus({ preventScroll: true });
  };
  exportButton.addEventListener("click", () => {
    try {
      const text = serializeSettingsBackup(settings.get());
      const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      const anchor = doc.createElement("a");
      anchor.href = url;
      anchor.download = settingsBackupFileName();
      anchor.style.display = "none";
      doc.documentElement.append(anchor);
      try {
        anchor.click();
      } finally {
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
      }
      setStatus("Backup file exported.");
    } catch (error) {
      console.error("[Viewer Companion] Could not export settings", error);
      setStatus("Could not export settings.", "error");
    }
  });
  importButton.addEventListener("click", () => {
    setStatus("");
    fileInput.click();
  });
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;
    setStatus("");
    clearReview();
    if (file.size > MAX_SETTINGS_BACKUP_BYTES) {
      setStatus("This file is too large to be a settings backup.", "error");
      importButton.focus({ preventScroll: true });
      return;
    }
    importButton.disabled = true;
    let focusImportAfterRead = false;
    void file
      .text()
      .then((text) => {
        if (!host.isConnected) return;
        const result = parseSettingsBackup(text);
        if (!result.ok) {
          setStatus(result.error, "error");
          focusImportAfterRead = true;
          return;
        }
        pendingImport = result.settings;
        reviewTitle.textContent = `Replace settings from “${file.name || "backup"}”?`;
        reviewSummary.textContent = describeSettings(result.settings);
        review.hidden = false;
        replaceButton.focus({ preventScroll: true });
      })
      .catch(() => {
        if (!host.isConnected) return;
        setStatus("Could not read this file.", "error");
        focusImportAfterRead = true;
      })
      .finally(() => {
        importButton.disabled = false;
        if (focusImportAfterRead) importButton.focus({ preventScroll: true });
      });
  });
  replaceButton.addEventListener("click", () => {
    if (!pendingImport) return;
    settings.update(pendingImport);
    clearReview();
    setStatus("Settings imported.");
    importButton.focus({ preventScroll: true });
  });
  cancelButton.addEventListener("click", () => {
    clearReview(true);
    setStatus("");
  });

  card.append(header, tabList, panels, note);
  root.append(style, card);

  const sync = (next: Settings) => {
    previews.input.checked = next.chatPreviews;
    fieldset.disabled = !next.chatPreviews;
    autoInsert.input.checked = next.autoInsert;
    catchUpLatency.input.checked = next.catchUpLatency;
    latencyThreshold.row.hidden = !next.catchUpLatency;
    latencyThreshold.input.disabled = !next.catchUpLatency;
    latencyThreshold.upButton.disabled = !next.catchUpLatency;
    latencyThreshold.downButton.disabled = !next.catchUpLatency;
    if (root.activeElement !== latencyThreshold.input)
      latencyThreshold.input.value = String(next.latencyThresholdSeconds);
    bots.input.checked = next.hideBots;
    users.sync(next.blockedUsers);
    domains.sync(next.blockedDomains);
    for (const radio of radios) radio.checked = next.previewClick === radio.value;
  };

  return { host, card, closeButton, firstInput: tabs[0]!, sync, dispose: accountUi.dispose };
}

function mount(doc: Document, site: Site, settings: SettingsController, accounts?: Accounts) {
  let buttonHost: HTMLElement | null = null;
  let button: HTMLButtonElement | null = null;
  let panel: ReturnType<typeof buildPanel> | null = null;
  let closePanel: (restoreFocus?: boolean) => void = () => {};
  let placedParent: HTMLElement | null = null;
  let placedBefore: Element | null = null;
  let placedPrecisely = false;

  const placementIsCurrent = () => {
    if (!buttonHost?.isConnected || !placedParent || buttonHost.parentElement !== placedParent)
      return false;
    return placedBefore
      ? placedBefore.isConnected && buttonHost.nextElementSibling === placedBefore
      : buttonHost === placedParent.lastElementChild;
  };

  const inject = () => {
    // A specific anchor only needs to be checked again when the site replaces
    // it. Generic fallbacks keep looking for a better anchor on every mutation.
    if (buttonHost?.isConnected && placedPrecisely && placementIsCurrent()) return;
    const anchor = findAnchor(doc, site);
    if (!anchor) return;
    // Do not downgrade an intact precise placement when a re-render briefly
    // hides the real anchor. The observer will retry on the next mutation.
    if (!anchor.precise && buttonHost?.isConnected && placedPrecisely) return;
    if (
      buttonHost?.isConnected &&
      anchor.precise === placedPrecisely &&
      buttonHost.parentElement === anchor.parent &&
      (anchor.before
        ? buttonHost.nextElementSibling === anchor.before
        : buttonHost === anchor.parent.lastElementChild)
    )
      return;
    if (!buttonHost) {
      const created = createButton(doc, site, toggle);
      buttonHost = created.host;
      button = created.button;
      if (panel) button.setAttribute("aria-expanded", "true");
    }
    placedParent = anchor.parent;
    placedBefore = anchor.before;
    placedPrecisely = anchor.precise;
    anchor.parent.insertBefore(buttonHost, anchor.before);
  };

  function toggle() {
    if (panel) {
      closePanel();
      return;
    }
    const view = doc.defaultView;
    if (!view || !buttonHost || !button) return;
    const created = buildPanel(doc, settings, accounts);
    panel = created;
    const { host, closeButton, firstInput } = created;

    const setExpanded = (expanded: boolean) =>
      button?.setAttribute("aria-expanded", String(expanded));
    let closed = false;
    const outside = (event: PointerEvent) => {
      const path = event.composedPath();
      if (path.includes(host) || (buttonHost && path.includes(buttonHost))) return;
      closePanel(false);
    };
    const keys = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closePanel();
    };
    const place = () => {
      if (!buttonHost?.isConnected) {
        closePanel(false);
        return;
      }
      const rect = buttonHost.getBoundingClientRect();
      const width = host.offsetWidth;
      const height = host.offsetHeight;
      const margin = 8;
      let left = rect.right - width;
      left = Math.min(Math.max(margin, left), Math.max(margin, view.innerWidth - width - margin));
      let top = rect.bottom + 6;
      if (top + height > view.innerHeight - margin) top = Math.max(margin, rect.top - height - 6);
      host.style.left = `${Math.round(left)}px`;
      host.style.top = `${Math.round(top)}px`;
    };
    const unsubscribe = settings.subscribe(created.sync);
    // Tab changes and resized textareas can change the panel's anchored height.
    const resizeObserver = new ResizeObserver(place);
    closePanel = (restoreFocus = true) => {
      if (closed) return;
      closed = true;
      unsubscribe();
      created.dispose();
      resizeObserver.disconnect();
      view.removeEventListener("resize", place);
      doc.removeEventListener("scroll", place, true);
      doc.removeEventListener("pointerdown", outside, true);
      doc.removeEventListener("keydown", keys, true);
      host.remove();
      panel = null;
      setExpanded(false);
      if (restoreFocus && button?.isConnected) button.focus({ preventScroll: true });
    };

    doc.documentElement.append(host);
    setExpanded(true);
    place();
    resizeObserver.observe(created.card);
    view.addEventListener("resize", place);
    doc.addEventListener("scroll", place, true);
    doc.addEventListener("pointerdown", outside, true);
    doc.addEventListener("keydown", keys, true);
    closeButton.addEventListener("click", () => closePanel());
    firstInput.focus({ preventScroll: true });
  }

  inject();
  const view = doc.defaultView;
  const ensureVisible = () => {
    if (buttonHost?.isConnected && buttonHost.getClientRects().length > 0) return;
    buttonHost?.remove();
    inject();
  };
  view?.addEventListener("load", ensureVisible, { once: true });
  view?.addEventListener("resize", ensureVisible);
  const observer = new MutationObserver(inject);
  observer.observe(doc.documentElement, { childList: true, subtree: true });

  return () => {
    observer.disconnect();
    view?.removeEventListener("load", ensureVisible);
    view?.removeEventListener("resize", ensureVisible);
    closePanel(false);
    buttonHost?.remove();
  };
}

export function registerSettingsUi(
  settings: SettingsController,
  hostname = location.hostname,
  accounts?: Accounts,
) {
  if (typeof window === "undefined" || typeof document === "undefined") return () => {};
  try {
    if (window.top !== window) return () => {};
  } catch {
    return () => {};
  }
  const site = siteFor(hostname);
  if (!site) return () => {};
  let dispose = () => {};
  const start = () => {
    dispose = mount(document, site, settings, accounts);
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
    return () => {
      document.removeEventListener("DOMContentLoaded", start);
      dispose();
    };
  }
  start();
  return () => dispose();
}
