import { captureInsertionPoint, findEditor, observeSend, replaceText } from "../../src/editor";
import { browser } from "wxt/browser";
import { serializeImage } from "../../src/clipboard";
import { errorMessage } from "../../src/shared";
import { createCopyButton } from "../../src/copy-button";
import { createNotice } from "../../src/notice";
import { findChatInput, mountNotice } from "../../src/notice-placement";
import type { UploadReply } from "../../src/shared";
import { observeChatPreviews } from "../../src/chat-previews";
import { createSettings, type Settings } from "../../src/settings";
import {
  registerSettingsUi,
  SETTINGS_BUTTON_ATTRIBUTE,
  SETTINGS_PANEL_ATTRIBUTE,
} from "../../src/settings-ui";
import { MAX_SETTINGS_BACKUP_BYTES } from "../../src/settings-transfer";
import type { Accounts, TwirAccountStatus } from "../../src/accounts";
import { createAccountsUi } from "../../src/accounts-ui";
import { checkImageViewer } from "./image-viewer";
import { checkPreviewFilters } from "./preview-filters";
import { checkPreviewScroll } from "./preview-scroll";
import { waitFor } from "./preview-wait";
import { checkImageEditor, editorFixture } from "./image-editor";
import {
  createPreviewPageResolver,
  extractPreviewImage,
  loadPreviewPage,
  type PreviewPageReply,
} from "../../src/preview-page";

// This File was created by a page script, not by the extension's isolated world.
const pageFile = (document.getElementById("page-file") as HTMLInputElement).files![0]!;

const results: { name: string; error?: string }[] = [];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function test(name: string, run: () => void) {
  document.body.replaceChildren();
  try {
    run();
    results.push({ name });
  } catch (error) {
    results.push({ name, error: error instanceof Error ? error.message : String(error) });
  }
}

async function check(name: string, run: () => Promise<void>) {
  try {
    await run();
    results.push({ name });
  } catch (error) {
    results.push({ name, error: errorMessage(error) });
  }
}

function twitchChat() {
  const chat = document.createElement("div");
  chat.className = "chat-input";
  const wrapper = document.createElement("div");
  const editor = document.createElement("div");
  editor.contentEditable = "true";
  editor.textContent = "unsent draft";
  wrapper.append(editor);
  chat.append(wrapper);
  document.body.append(chat);
  return { chat, editor };
}

function kickChat() {
  const chat = document.createElement("div");
  chat.id = "chatroom-footer";
  chat.style.cssText = "display:flex;flex-direction:column;width:340px";
  const composer = document.createElement("div");
  const row = document.createElement("div");
  row.id = "chat-input-wrapper";
  row.style.display = "flex";
  const wrapper = document.createElement("div");
  const editor = document.createElement("div");
  editor.contentEditable = "true";
  editor.className = "editor-input";
  editor.setAttribute("data-testid", "chat-input");
  editor.textContent = "unsent draft";
  wrapper.append(editor);
  row.append(wrapper, document.createElement("button"));
  composer.append(row);
  chat.append(composer);
  document.body.append(chat);
  return { chat, editor };
}

// Detached fixtures keep lazy images offscreen: these checks make no image requests.
function previewChat(hostname = "www.twitch.tv") {
  const root = document.createElement("div");
  root.id = "chatroom-messages";
  const message = document.createElement("div");
  message.className = hostname.endsWith("kick.com") ? "chat-entry" : "chat-line__message";
  const link = document.createElement("a");
  link.href = `${location.origin}/preview-image?chat=1`;
  link.textContent = link.href;
  message.append(link);
  root.append(message);
  return { root, message, link };
}

function previewHost(message: Element) {
  const sibling = message.nextElementSibling;
  if (sibling?.matches("[data-imageuploader-preview]")) return sibling as HTMLElement;
  const row = message.closest(".seventv-message");
  return row?.querySelector<HTMLElement>(":scope > [data-imageuploader-preview]") ?? null;
}

test("PicDrisnya post metadata resolves to its image, not the HTML page", () => {
  const page = "https://img.hishi.icu/post/nw8nBYytbd";
  const thumbnail = "https://pic.hishi.icu/media/v2/thumbs/thumb_pdqMFvnQMDqs9JDHDZ.webp";
  assert(
    extractPreviewImage(`<meta property="og:image" content="${thumbnail}">`, page) === thumbnail,
    "reported post thumbnail not extracted",
  );
  assert(
    extractPreviewImage(
      '<meta content="/photo?size=1&amp;token=abc" property="og:image">',
      page,
    ) === "https://img.hishi.icu/photo?size=1&token=abc",
    "relative URL or HTML entities lost",
  );
  assert(
    extractPreviewImage(
      '<meta name="twitter:image" content="//pic.hishi.icu/photo.webp">',
      page,
    ) === "https://pic.hishi.icu/photo.webp",
    "Twitter metadata not supported",
  );
  assert(
    extractPreviewImage(
      '<base href="https://cdn.example/gallery/"><meta property="og:image:url" content="thumb.webp">',
      page,
    ) === "https://cdn.example/gallery/thumb.webp",
    "base URL or alternate Open Graph property ignored",
  );
  assert(
    extractPreviewImage(
      '<meta name="twitter:image:src" content="/photo.webp">',
      "http://another.example/post",
    ) === "http://another.example/photo.webp",
    "alternate Twitter metadata ignored",
  );
  assert(
    extractPreviewImage(
      '<meta property="og:image" content="javascript:alert(1)"><meta name="twitter:image" content="https://pic.hishi.icu/safe.webp">',
      page,
    ) === "https://pic.hishi.icu/safe.webp",
    "unsafe metadata not skipped",
  );
  assert(
    extractPreviewImage('<meta property="og:image" content="data:image/png;base64,AA==">', page) ===
      null,
    "unsafe image source accepted",
  );
  assert(
    extractPreviewImage(
      '<img src="/not-metadata"><script>document.body.id="executed"</script>',
      page,
    ) === null,
    "ordinary page images scraped",
  );
  assert(document.body.id !== "executed", "fetched script executed");
});

for (const hostname of ["www.twitch.tv", "kick.com"]) {
  check(`${hostname}: Uploader thumbnail is below the unchanged message link`, async () => {
    const { root, message, link } = previewChat(hostname);
    const stop = observeChatPreviews(root, hostname);
    try {
      await waitFor(() => previewHost(message), "preview not rendered");
      const host = previewHost(message);
      assert(host && message.nextElementSibling === host, "preview not below message");
      assert(message.firstElementChild === link && link.textContent === link.href, "link changed");
      const image = host.shadowRoot!.querySelector("img")!;
      assert(image.src === link.href, "wrong image source");
      assert(image.loading === "lazy" && image.decoding === "async", "eager image loading");
      assert(image.referrerPolicy === "no-referrer", "page referrer can leak");
      const previewLink = image.parentElement as HTMLAnchorElement;
      assert(
        previewLink.target === "_blank" && previewLink.rel.includes("noreferrer"),
        "unsafe link",
      );
      document.body.append(root);
      const gutter = hostname.endsWith("twitch.tv") ? 20 : 0;
      for (const width of [180, 340]) {
        root.style.width = `${width}px`;
        const bounds = root.getBoundingClientRect();
        const thumbnail = previewLink.getBoundingClientRect();
        assert(thumbnail.left - bounds.left === gutter, "incorrect chat preview gutter");
        assert(thumbnail.right <= bounds.right, "preview overflows narrow chat");
      }
    } finally {
      stop();
      root.remove();
    }
    assert(!previewHost(message), "cleanup left a preview behind");
  });
}

check("7TV messages mount previews outside the moderation slider", async () => {
  const root = document.createElement("div");
  const row = document.createElement("div");
  row.className = "seventv-message";
  const slider = document.createElement("div");
  slider.className = "seventv-ban-slider";
  const wrapped = document.createElement("div");
  wrapped.className = "wrapped";
  const message = document.createElement("span");
  message.className = "seventv-user-message";
  const author = document.createElement("span");
  author.className = "seventv-chat-user-username";
  author.textContent = "viewer";
  const link = document.createElement("a");
  link.href = `${location.origin}/preview-image?chat=7tv`;
  link.textContent = link.href;
  message.append(author, link);
  wrapped.append(message);
  slider.append(wrapped);
  row.append(slider);
  root.append(row);
  const stop = observeChatPreviews(root, "twitch.tv");
  try {
    await waitFor(() => previewHost(message), "7TV preview not rendered");
    const host = previewHost(message);
    assert(host && host.parentElement === row, "preview not attached to the 7TV row");
    assert(!slider.contains(host), "preview remained inside the moderation slider");
    assert(row.lastElementChild === host, "preview not outside the message content");
    root.style.width = "340px";
    document.body.append(root);
    const thumbnail = host.shadowRoot!.querySelector("a")!.getBoundingClientRect();
    assert(
      thumbnail.left - row.getBoundingClientRect().left === 20,
      "7TV preview is missing the Twitch chat gutter",
    );
  } finally {
    stop();
    root.remove();
  }
  assert(!root.querySelector("[data-imageuploader-preview]"), "cleanup left a 7TV preview");
});

test("previews ignore unsafe URLs, outside-chat links, editors and lookalike sites", () => {
  const { root, message, link } = previewChat();
  link.href = "javascript:alert(1)";
  const outside = document.createElement("a");
  outside.href = "https://twir.app/u/Outside";
  root.append(outside);
  const editor = message.cloneNode(true) as HTMLElement;
  editor.contentEditable = "true";
  (editor.firstElementChild as HTMLAnchorElement).href = "https://twir.app/u/Draft";
  root.append(editor);
  const stop = observeChatPreviews(root, "www.twitch.tv");
  try {
    assert(!root.querySelector("[data-imageuploader-preview]"), "non-chat/image link previewed");
  } finally {
    stop();
  }
  link.href = "https://twir.app/u/AbC123";
  const stopUnsupported = observeChatPreviews(root, "twitch.tv.evil.com");
  assert(!previewHost(message), "unsupported host previewed");
  stopUnsupported();
});

test("Twitch's own links are left to Twitch's native link cards", () => {
  const { root, message, link } = previewChat();
  link.href = "https://www.twitch.tv/guacamolemolly/clip/SleepyKawaii";
  const clip = link.cloneNode(true) as HTMLAnchorElement;
  clip.href = "https://clips.twitch.tv/AnotherClip";
  message.append(clip);
  const stop = observeChatPreviews(root, "www.twitch.tv");
  try {
    assert(!previewHost(message), "Twitch link previewed twice");
    assert(message.contains(link) && message.contains(clip), "original links removed");
  } finally {
    stop();
  }
});

check("duplicate URLs are collapsed and non-image responses leave no preview", async () => {
  const { root, message, link } = previewChat();
  for (const url of [
    link.href,
    `${location.origin}/preview-image?one=1`,
    `${location.origin}/preview-image?one=1`,
    `${location.origin}/preview-image?two=2`,
    `${location.origin}/preview-image?image=42&signature=abc`,
    `${location.origin}/preview-page`,
  ]) {
    const other = link.cloneNode(true) as HTMLAnchorElement;
    other.href = url;
    message.append(other);
  }
  const stop = observeChatPreviews(root, "twitch.tv");
  try {
    const images = () => [...(previewHost(message)?.shadowRoot?.querySelectorAll("img") ?? [])];
    await waitFor(() => images().length === 4, "unique links skipped or previews missing");
    assert(
      images().filter((image) => image.src.includes("one=1")).length === 1,
      "duplicate link rendered twice",
    );
    assert(
      images().some(
        (image) => image.src === `${location.origin}/preview-image?image=42&signature=abc`,
      ),
      "query lost",
    );
    assert(message.querySelectorAll("a").length === 7, "original links changed");
  } finally {
    stop();
  }
});

test("inline notices recognize Twitch containers without accepting bare editors", () => {
  const { chat, editor } = twitchChat();
  editor.setAttribute("data-a-target", "chat-input");
  assert(findChatInput(editor, "www.twitch.tv") === chat, "Twitch chat not found");
  assert(findChatInput(editor, "kick.com") === null, "Twitch container accepted on Kick");
  assert(findChatInput(editor, "fake-twitch.tv") === null, "lookalike host accepted");
  assert(findChatInput(textarea(), "www.twitch.tv") === null, "non-chat field accepted");
  editor.removeAttribute("data-a-target");
  chat.className = "";
  chat.setAttribute("data-a-target", "chat-input");
  assert(findChatInput(editor, "twitch.tv") === chat, "data attribute not recognized");
  chat.removeAttribute("data-a-target");
  editor.setAttribute("data-a-target", "chat-input");
  assert(findChatInput(editor, "twitch.tv") === null, "editor itself accepted as a panel host");
});

test("Kick uses the chat footer, not its horizontal input row or an unrelated editor", () => {
  const { chat, editor } = kickChat();
  for (const hostname of ["kick.com", "www.kick.com", "player.kick.com"]) {
    assert(findChatInput(editor, hostname) === chat, "Kick chat footer not found");
  }
  for (const hostname of ["twitch.tv", "fake-kick.com", "kick.com.evil.com", "example.com"]) {
    assert(findChatInput(editor, hostname) === null, "Kick footer accepted on another site");
  }
  assert(findChatInput(textarea(), "kick.com") === null, "unrelated input accepted");
  chat.removeAttribute("id");
  assert(findChatInput(editor, "kick.com") === null, "horizontal input row accepted");
  editor.id = "chatroom-footer";
  assert(findChatInput(editor, "kick.com") === null, "bare editor accepted as a panel host");
});

for (const [site, createChat] of [
  ["Twitch", twitchChat],
  ["Kick", kickChat],
] as const) {
  test(`${site}: inline notice sits above the editor without changing its draft or focus`, () => {
    const { chat, editor } = createChat();
    editor.focus();
    window.getSelection()!.selectAllChildren(editor);
    const host = document.createElement("div");
    const unmount = mountNotice(host, chat);
    try {
      assert(chat.firstElementChild === host, "panel was not placed above the editor");
      assert(!editor.contains(host), "panel was inserted into the editor");
      assert(host.dataset.placement === "chat", "inline styling not selected");
      assert(getComputedStyle(host).position === "relative", "panel overlays the chat");
      assert(editor.textContent === "unsent draft", "draft changed");
      assert(document.activeElement === editor, "editor lost focus");
      assert(window.getSelection()!.toString() === "unsent draft", "selection changed");
    } finally {
      unmount();
      host.remove();
    }
  });
}

test("unrecognized layouts keep a floating notification", () => {
  const host = document.createElement("div");
  const unmount = mountNotice(host, null);
  try {
    assert(host.parentElement === document.documentElement, "floating notice not mounted");
    assert(host.dataset.placement === "floating", "floating styling not selected");
    assert(getComputedStyle(host).position === "fixed", "floating position lost");
  } finally {
    unmount();
    host.remove();
  }
});

function textarea(value = "hello world") {
  const field = document.createElement("textarea");
  field.value = value;
  document.body.append(field);
  field.focus();
  field.setSelectionRange(6, 11);
  return field;
}

test("textarea: replaces the captured selection and emits input", () => {
  const field = textarea();
  let input = false;
  field.addEventListener("input", () => {
    input = true;
  });
  const point = captureInsertionPoint(field);
  assert(point.insert("https://twir.app/u/test"), "insertion failed");
  assert(field.value === "hello https://twir.app/u/test", `unexpected value: ${field.value}`);
  assert(input, "input event was not emitted");
});

test("input: inserts at the caret", () => {
  const field = document.createElement("input");
  field.value = "ab";
  document.body.append(field);
  field.focus();
  field.setSelectionRange(1, 1);
  assert(captureInsertionPoint(field).insert("LINK"), "insertion failed");
  assert(field.value === "aLINKb", `unexpected value: ${field.value}`);
});

test("contenteditable: inserts plain text into nested markup and emits input", () => {
  const field = document.createElement("div");
  field.contentEditable = "true";
  const span = document.createElement("span");
  span.textContent = "hello world";
  field.append(span);
  document.body.append(field);
  field.focus();
  const range = document.createRange();
  range.setStart(span.firstChild!, 6);
  range.setEnd(span.firstChild!, 11);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  let input = false;
  field.addEventListener("input", () => {
    input = true;
  });
  assert(findEditor(span) === field, "nested editable not resolved");
  assert(captureInsertionPoint(field).insert("https://twir.app/u/test"), "insertion failed");
  assert(
    field.textContent === "hello https://twir.app/u/test",
    `unexpected text: ${field.textContent}`,
  );
  assert(input, "input event was not emitted");
});

test("rich editors insert through beforeinput instead of execCommand", () => {
  const field = document.createElement("div");
  field.contentEditable = "true";
  field.setAttribute("data-slate-editor", "true");
  field.textContent = "draft";
  document.body.append(field);
  field.focus();
  const range = document.createRange();
  range.selectNodeContents(field);
  range.collapse(false);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  let inserted = "";
  field.addEventListener("beforeinput", (event) => {
    const input = event as InputEvent;
    if (input.inputType !== "insertText") return;
    inserted += input.data ?? "";
    field.textContent = `draft${inserted}`;
    event.preventDefault();
  });
  try {
    const point = captureInsertionPoint(field);
    assert(point.insert("https://twir.app/u/test"), "editor insertion rejected");
    assert(inserted === "https://twir.app/u/test", "beforeinput did not carry the link");
    assert(field.textContent === "drafthttps://twir.app/u/test", "editor state not updated");
  } finally {
    field.remove();
  }
});

test("textarea: replaces a link in place and keeps the caret", () => {
  const field = textarea("before https://twir.app/u/old after");
  const next = "https://twir.app/u/edited";
  field.setSelectionRange(field.value.length, field.value.length);
  let inputs = 0;
  field.addEventListener("input", () => inputs++);
  try {
    assert(replaceText(field, "https://twir.app/u/old", next), "link not replaced");
    assert(field.value === `before ${next} after`, `unexpected value: ${field.value}`);
    assert(
      field.selectionStart === field.value.length && field.selectionEnd === field.value.length,
      "caret not kept at the end of the draft",
    );
    assert(inputs === 1, "input event was not emitted");
    assert(!replaceText(field, "https://twir.app/u/missing", "x"), "missing link replaced");
  } finally {
    field.remove();
  }
});

test("contenteditable: replaces a link and restores focus", () => {
  const field = document.createElement("div");
  field.contentEditable = "true";
  field.textContent = "before https://twir.app/u/old after";
  const other = document.createElement("button");
  document.body.append(field, other);
  other.focus();
  const next = "https://twir.app/u/edited";
  let inputs = 0;
  field.addEventListener("input", () => inputs++);
  try {
    assert(replaceText(field, "https://twir.app/u/old", next), "link not replaced");
    assert(field.textContent === `before ${next} after`, `unexpected text: ${field.textContent}`);
    assert(inputs === 1, "input event was not emitted");
    assert(document.activeElement === other, "focus not restored after replacement");
  } finally {
    field.remove();
    other.remove();
  }
});

test("rich editors replace links using the real beforeinput target range", () => {
  const field = document.createElement("div");
  field.contentEditable = "true";
  field.setAttribute("data-slate-editor", "true");
  field.textContent = "draft https://twir.app/u/old";
  document.body.append(field);
  // Mimic Slate/Lexical: stateful editors keep their own selection at the end
  // and only trust the target range carried by a real beforeinput event.
  field.addEventListener("beforeinput", (event) => {
    const input = event as InputEvent;
    if (input.inputType !== "insertText") return;
    event.preventDefault();
    const range = document.createRange();
    const target = input.getTargetRanges()[0];
    if (target) {
      range.setStart(target.startContainer, target.startOffset);
      range.setEnd(target.endContainer, target.endOffset);
    } else {
      range.selectNodeContents(field);
      range.collapse(false);
    }
    range.deleteContents();
    range.insertNode(document.createTextNode(input.data ?? ""));
    field.normalize();
  });
  const next = "https://twir.app/u/edited";
  try {
    assert(replaceText(field, "https://twir.app/u/old", next), "rich link not replaced");
    assert(
      field.textContent === `draft ${next}`,
      `rich editor appended instead of replacing: ${field.textContent}`,
    );
  } finally {
    field.remove();
  }
});

test("stateful editors never receive DOM-only fallback edits", () => {
  const field = document.createElement("div");
  field.contentEditable = "true";
  field.setAttribute("data-lexical-editor", "true");
  field.textContent = "draft";
  document.body.append(field);
  field.focus();
  const range = document.createRange();
  range.selectNodeContents(field);
  range.collapse(false);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  try {
    assert(!captureInsertionPoint(field).insert("LINK"), "DOM-only edit was accepted");
    assert(field.textContent === "draft", "stateful editor DOM was changed");
  } finally {
    field.remove();
  }
});

test("send detection handles Enter, modifiers and the send button", () => {
  const field = textarea();
  const send = document.createElement("button");
  send.type = "submit";
  document.body.append(send);
  const state = { sent: 0 };
  const expectSent = (count: number, message: string) => {
    if (state.sent !== count) throw new Error(`${message}: got ${state.sent} sends`);
  };
  const stop = observeSend(field, () => state.sent++);
  try {
    for (const init of [
      { key: "Enter", shiftKey: true },
      { key: "Enter", ctrlKey: true },
      { key: "Enter", metaKey: true },
      { key: "Enter", altKey: true },
      { key: "a" },
      { key: "Enter", isComposing: true },
    ])
      field.dispatchEvent(new KeyboardEvent("keydown", { ...init, bubbles: true }));
    expectSent(0, "a newline or shortcut was treated as sending");
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expectSent(1, "Enter did not count as sending");
    send.click();
    expectSent(2, "send button did not count as sending");
    send.disabled = true;
    send.click();
    expectSent(2, "disabled send button counted as sending");
    stop();
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expectSent(2, "stopped detector still fired");
  } finally {
    send.remove();
  }
});

test("draft edited while uploading is not overwritten", () => {
  const field = textarea();
  const point = captureInsertionPoint(field);
  field.value = "new draft";
  field.dispatchEvent(new InputEvent("input", { bubbles: true }));
  assert(!point.insert("LINK"), "changed draft was overwritten");
  assert(field.value === "new draft", "draft lost");
});

test("typing then undoing still invalidates the old insertion point", () => {
  const field = textarea();
  const point = captureInsertionPoint(field);
  field.dispatchEvent(new InputEvent("input", { bubbles: true }));
  assert(!point.insert("LINK"), "stale insertion accepted");
  assert(field.value === "hello world", "draft changed");
});

test("lost focus does not steal focus or insert in another field", () => {
  const field = textarea();
  const point = captureInsertionPoint(field);
  const other = textarea("another draft");
  assert(!point.insert("LINK"), "insertion accepted after focus change");
  assert(
    document.activeElement === other && other.value === "another draft",
    "other field changed",
  );
});

test("disconnected and newly readonly fields reject insertion", () => {
  const field = textarea();
  const point = captureInsertionPoint(field);
  field.remove();
  assert(!point.insert("LINK"), "detached field accepted");
  document.body.append(field);
  field.focus();
  const readonlyPoint = captureInsertionPoint(field);
  field.readOnly = true;
  assert(!readonlyPoint.insert("LINK"), "readonly field accepted");
});

test("passwords, disabled fields, non-editable content and inert fields are ignored", () => {
  const field = document.createElement("input");
  document.body.append(field);
  field.type = "password";
  assert(findEditor(field) === null, "password accepted");
  field.type = "text";
  field.disabled = true;
  assert(findEditor(field) === null, "disabled input accepted");
  field.disabled = false;
  field.inert = true;
  assert(findEditor(field) === null, "inert input accepted");
  assert(findEditor(document.body) === null, "body accepted");
});

test("programmatic rich text change invalidates the insertion point", () => {
  const field = document.createElement("div");
  field.contentEditable = "true";
  field.textContent = "draft";
  document.body.append(field);
  field.focus();
  window.getSelection()!.selectAllChildren(field);
  const point = captureInsertionPoint(field);
  field.textContent = "updated";
  assert(!point.insert("LINK"), "programmatic changes overwritten");
  assert(field.textContent === "updated", "updated draft lost");
});

async function checkClipboard() {
  const name = "content script reads a page-owned File";
  try {
    assert(
      typeof browser.runtime.id === "string",
      "test must run as an actual extension content script",
    );
    const image = await serializeImage(pageFile);
    assert(image.mimeType === "image/png", "wrong image type");
    assert(image.name === "pasted-image.png", "original filename leaked");
    assert(image.base64 === "AAEC/w==", `incorrect bytes: ${image.base64}`);
    results.push({ name });
  } catch (error) {
    results.push({ name, error: errorMessage(error) });
  }
  const backgroundTest =
    "production background replies asynchronously and rejects non-allowlisted pages";
  try {
    const reply: UploadReply = await browser.runtime.sendMessage({
      type: "upload-image",
      image: { name: "test.png", mimeType: "image/png", base64: "AAEC/w==" },
    });
    assert(
      reply?.ok === false && reply.error === "Uploads are only allowed on Twitch and Kick.",
      "background did not enforce the site allowlist",
    );
    results.push({ name: backgroundTest });
  } catch (error) {
    results.push({ name: backgroundTest, error: errorMessage(error) });
  }
  await check("metadata background requests reject non-allowlisted senders", async () => {
    const reply: PreviewPageReply = await browser.runtime.sendMessage({
      type: "preview-page",
      url: "https://img.hishi.icu/post/nw8nBYytbd",
    });
    assert(reply?.page === null, "metadata request bypassed the sender allowlist");
  });
  await check(
    "account background commands reject non-allowlisted pages without exposing credentials",
    async () => {
      for (const type of ["twir-status", "twir-connect", "twir-disconnect"]) {
        const reply = await browser.runtime.sendMessage({ type });
        assert(
          reply?.ok === false && /only available/.test(reply.error),
          "account sender was not rejected",
        );
        assert(!JSON.stringify(reply).includes("token"), "credentials leaked in account reply");
      }
    },
  );
  await check(
    "persistent credentials are isolated from content scripts and session storage is private",
    async () => {
      try {
        const seeded = await browser.runtime.sendMessage({ type: "test-auth-seed" });
        assert(
          seeded?.ok,
          `background account store did not persist its records: ${JSON.stringify(seeded)}`,
        );
        let session: unknown;
        try {
          session = await browser.storage.session.get("twirOAuthSession");
        } catch {}
        assert(
          !JSON.stringify(session ?? {}).includes("test-access-secret"),
          "content script can read session access token",
        );
        const local = await browser.storage.local.get(null);
        assert(!JSON.stringify(local).includes("secret"), "credentials were saved with settings");
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open("viewer-companion-accounts", 1);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        assert(
          !database.objectStoreNames.contains("credentials"),
          "content script can open the extension's credential database",
        );
        database.close();
        indexedDB.deleteDatabase("viewer-companion-accounts");
      } finally {
        await browser.runtime.sendMessage({ type: "test-auth-clear" });
      }
    },
  );
  await checkChatPreviews();
  await checkPreviewFilters(check);
  await checkPreviewScroll(check);
  await checkImageViewer(check);
  await checkImageEditor(check);
  await checkNoticePlacement();
  await checkCopyButtons();
  await checkNoticeCountdown();
  await checkSettings();
  await checkAccounts();
  await fetch("/results", { method: "POST", body: JSON.stringify(results) });
}

async function checkAccounts() {
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  await check("Accounts: connection states and recovery", async () => {
    document.body.replaceChildren();
    const settings = createSettings({ load: () => ({}), save: () => {} });
    await settings.ready;
    const nav = document.createElement("nav");
    nav.innerHTML = '<button data-a-target="user-menu-toggle">Account</button>';
    document.body.append(nav);
    let status: TwirAccountStatus = "disconnected";
    let offline = false;
    let failConnect = false;
    let connectCount = 0;
    let pending: ReturnType<typeof Promise.withResolvers<void>> | undefined;
    const accounts: Accounts = {
      async status() {
        return status;
      },
      async connect() {
        connectCount++;
        if (failConnect)
          throw new Error("Twir sign-in failed (browser): Authorization page could not be loaded.");
        status = "connecting";
        if (pending) await pending.promise;
        else status = "connected";
      },
      async disconnect() {
        status = "disconnected";
        return { revoked: !offline };
      },
    };
    const stop = registerSettingsUi(settings, "www.twitch.tv", accounts);
    try {
      document
        .querySelector(`[${SETTINGS_BUTTON_ATTRIBUTE}]`)!
        .shadowRoot!.querySelector<HTMLButtonElement>("button")!
        .click();
      const root = document.querySelector(`[${SETTINGS_PANEL_ATTRIBUTE}]`)!.shadowRoot!;
      const tabs = [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
      tabs.find((tab) => tab.textContent === "Accounts")!.click();
      await tick();
      const panel = root.querySelector<HTMLElement>("#settings-panel-accounts")!;
      assert(!panel.hidden && panel.textContent!.includes("Twir"), "Accounts tab is missing Twir");
      assert(
        panel.querySelector(".accounts-beta")?.textContent === "Sign-in is in beta.",
        "account sign-in is not marked as beta",
      );
      assert(
        getComputedStyle(panel.querySelector("#twir-account-title")!).fontSize === "18px",
        "Twir title is not enlarged",
      );
      assert(
        panel.firstElementChild?.className === "accounts-beta" &&
          panel.querySelector(".accounts-beta")!.nextElementSibling?.className === "account" &&
          panel.querySelector(".accounts-beta")!.getBoundingClientRect().bottom <=
            panel.querySelector("#twir-account-title")!.getBoundingClientRect().top,
        "beta notice must be global to Accounts and above Twir",
      );
      assert(
        panel.querySelector('.accounts-beta svg[aria-hidden="true"] path') &&
          getComputedStyle(panel.querySelector(".accounts-beta")!).backgroundColor.startsWith(
            "rgba(",
          ),
        "beta notice needs a warning icon and translucent background",
      );
      assert(root.querySelector<HTMLElement>(".note")!.hidden, "settings hint clutters Accounts");
      tabs.find((tab) => tab.textContent === "General")!.click();
      assert(!root.querySelector<HTMLElement>(".note")!.hidden, "settings hint missing in General");
      tabs.find((tab) => tab.textContent === "Accounts")!.click();
      const connect = panel.querySelector<HTMLButtonElement>(".primary")!;
      const disconnect = panel.querySelector<HTMLButtonElement>(".action:not(.primary)")!;
      assert(
        connect.textContent === "Sign in" && !connect.disabled && disconnect.hidden,
        "incorrect disconnected state",
      );
      assert(
        panel.textContent === "Sign-in is in beta.TwirSign inSign out",
        "redundant account explanations remain",
      );
      assert(
        [...panel.querySelectorAll<HTMLElement>(".status")].every(
          (element) => element.getClientRects().length === 0,
        ),
        "empty account statuses take up space",
      );
      failConnect = true;
      connect.click();
      await tick();
      assert(
        panel.textContent!.includes(
          "Twir sign-in failed (browser): Authorization page could not be loaded.",
        ) && !connect.disabled,
        "sign-in error prevents retry",
      );
      failConnect = false;
      connect.click();
      await tick();
      assert(
        connect.hidden && !disconnect.hidden && panel.textContent!.includes("Signed in"),
        "successful connection not shown",
      );
      offline = true;
      disconnect.click();
      await tick();
      assert(
        !connect.hidden && panel.textContent!.includes("Revoke access in Twir"),
        "offline logout was not explained",
      );
      status = "reconnect-required";
      // Reopening reads fresh background state without storing account data in settings.
      root.querySelector<HTMLButtonElement>('[aria-label="Close settings"]')!.click();
      document
        .querySelector(`[${SETTINGS_BUTTON_ATTRIBUTE}]`)!
        .shadowRoot!.querySelector<HTMLButtonElement>("button")!
        .click();
      const reopened = document.querySelector(`[${SETTINGS_PANEL_ATTRIBUTE}]`)!.shadowRoot!;
      reopened.querySelector<HTMLButtonElement>("#settings-tab-accounts")!.click();
      await tick();
      const reconnect = reopened.querySelector<HTMLButtonElement>(
        "#settings-panel-accounts .primary",
      )!;
      assert(
        reconnect.textContent === "Sign in again" &&
          reopened.textContent!.includes("Uploads paused until you sign in again"),
        "expired connection has no recovery",
      );
      pending = Promise.withResolvers<void>();
      reconnect.click();
      await tick();
      const cancel = reopened.querySelector<HTMLButtonElement>(
        "#settings-panel-accounts .action:not(.primary)",
      )!;
      assert(
        cancel.textContent === "Cancel sign-in" && !cancel.disabled,
        "pending sign-in cannot be canceled",
      );
      cancel.click();
      await tick();
      pending.reject(new Error("Old sign-in was canceled"));
      await tick();
      assert(
        !reopened.textContent!.includes("Old sign-in"),
        "late sign-in callback overwrote logout feedback",
      );
      assert(connectCount === 3, "unexpected number of sign-in requests");
      assert(
        !JSON.stringify(settings.get()).includes("Twir"),
        "account credentials entered settings",
      );
    } finally {
      stop();
      nav.remove();
    }
  });
  await check(
    "Accounts: failed status checks do not block sign-in or replace action feedback",
    async () => {
      let failConnect = true;
      const ui = createAccountsUi(document, {
        async status() {
          throw new Error("Background unavailable");
        },
        async connect() {
          if (failConnect) throw new Error("Sign-in failed. Try again.");
        },
        async disconnect() {
          return { revoked: true };
        },
      });
      document.body.append(ui.section);
      try {
        const connect = ui.section.querySelector<HTMLButtonElement>(".primary")!;
        const disconnect = ui.section.querySelector<HTMLButtonElement>(".action:not(.primary)")!;
        await tick();
        assert(!connect.disabled && !connect.hidden, "failed status check blocks sign-in");
        assert(
          [...ui.section.querySelectorAll(".status")].every((element) => !element.textContent),
          "passive status failure adds unexpected text or assumes the account is disconnected",
        );
        connect.click();
        await tick();
        assert(
          !connect.disabled && ui.section.textContent!.includes("Sign-in failed. Try again."),
          "status failure hides action error or prevents retry",
        );
        failConnect = false;
        connect.click();
        await tick();
        assert(
          connect.hidden && !disconnect.hidden && ui.section.textContent!.includes("Signed in"),
          "status failure loses successful sign-in state",
        );
        disconnect.click();
        await tick();
        assert(
          !connect.hidden &&
            !connect.disabled &&
            disconnect.hidden &&
            ui.section.textContent!.includes("Signed out."),
          "status failure loses successful sign-out state",
        );
      } finally {
        ui.dispose();
        ui.section.remove();
      }
    },
  );
}

async function checkChatPreviews() {
  const tick = () => new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  await check(
    "metadata resolver uses the redirected page URL and shares pending requests",
    async () => {
      let requests = 0;
      const pending = Promise.withResolvers<{ html: string; url: string } | null>();
      const resolve = createPreviewPageResolver(async () => {
        requests++;
        return pending.promise;
      });
      const first = resolve("https://short.example/abc");
      const duplicate = resolve("https://short.example/abc#top");
      pending.resolve({
        html: '<meta name="twitter:image" content="thumb.webp">',
        url: "https://another.example/gallery/post",
      });
      assert(
        (await first) === "https://another.example/gallery/thumb.webp",
        "relative redirected thumbnail resolved incorrectly",
      );
      assert(
        (await duplicate) === (await first) && requests === 1,
        "pending requests not deduplicated",
      );
    },
  );
  for (const path of ["/preview-post", "/preview-post-redirect"]) {
    await check(
      `${path}: generic page metadata loads a thumbnail while keeping the original link`,
      async () => {
        const { root, message, link } = previewChat();
        const post = `${location.origin}${path}`;
        link.href = post;
        let requests = 0;
        const resolve = createPreviewPageResolver(async (url) => {
          requests++;
          return loadPreviewPage(url);
        });
        document.body.append(root);
        const stop = observeChatPreviews(root, "twitch.tv", resolve);
        try {
          // The HTML page is never rendered as an image: only its thumbnail appears.
          await waitFor(() => previewHost(message), "metadata preview not rendered");
          const image = previewHost(message)!.shadowRoot!.querySelector("img")!;
          assert(
            image.src === `${location.origin}/preview-image?size=small&token=abc`,
            "wrong metadata image",
          );
          assert(
            (image.parentElement as HTMLAnchorElement).href === post,
            "thumbnail no longer opens original post",
          );
          assert(link.href === post && link.parentElement === message, "original post changed");
          (image.parentElement as HTMLAnchorElement).click();
          const viewer = document.querySelector<HTMLElement>(
            "[data-imageuploader-viewer]",
          )!.shadowRoot!;
          assert(
            viewer.querySelector("img")!.src === image.src,
            "chat viewer loads the HTML post instead of its image",
          );
          viewer.querySelector<HTMLButtonElement>('[aria-label="Close image preview"]')!.click();
          await resolve(`${post}#fragment`);
          assert(requests === 1, "metadata was not cached");
        } finally {
          stop();
          root.remove();
        }
      },
    );
  }
  await check(
    "late metadata cannot restore a preview after a link edit or observer cleanup",
    async () => {
      for (const action of ["edit", "stop"] as const) {
        const { root, message, link } = previewChat();
        link.href = `${location.origin}/preview-page?late=${action}`;
        const pending = Promise.withResolvers<string | null>();
        const stop = observeChatPreviews(root, "twitch.tv", () => pending.promise);
        try {
          await tick(); // Let the probe fail and the metadata request start.
          assert(!previewHost(message), "HTML link rendered before metadata");
          if (action === "edit") link.href = `${location.origin}/preview-image?new=${action}`;
          else stop();
          await tick();
          pending.resolve(`${location.origin}/preview-image?old=${action}`);
          if (action === "stop") {
            await tick();
            assert(!previewHost(message), "stopped preview restored");
          } else {
            await waitFor(() => previewHost(message), "edited preview missing");
            assert(
              previewHost(message)?.shadowRoot?.querySelector("img")?.src === link.href,
              "stale metadata replaced the edited preview",
            );
          }
        } finally {
          stop();
        }
      }
    },
  );
  await check(
    "missing or failed post metadata is cached and leaves only the original link",
    async () => {
      for (const html of [null, "<title>No image</title>"]) {
        const { root, message, link } = previewChat();
        link.href = `${location.origin}/preview-page?metadata=${html === null ? "null" : "empty"}`;
        let requests = 0;
        const resolve = createPreviewPageResolver(async () => {
          requests++;
          return html === null ? null : { html, url: link.href };
        });
        const stop = observeChatPreviews(root, "twitch.tv", resolve);
        try {
          await waitFor(() => requests === 1, "metadata not requested");
          await tick();
          assert(!previewHost(message), "empty metadata left a preview");
          message.prepend(document.createTextNode("updated "));
          await tick();
          await resolve(link.href);
          assert(requests === 1, "failed metadata retried");
          assert(link.parentElement === message, "original post link removed");
        } finally {
          stop();
        }
      }
    },
  );
  await check("broken metadata images never render or retry", async () => {
    const { root, message, link } = previewChat();
    link.href = `${location.origin}/preview-page?broken=1`;
    let requests = 0;
    const stop = observeChatPreviews(root, "twitch.tv", async () => {
      requests++;
      return `${location.origin}/preview-page?broken-thumb`;
    });
    try {
      await waitFor(() => requests === 1, "metadata not requested");
      await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
      assert(!previewHost(message), "broken metadata image rendered");
      message.prepend(document.createTextNode("updated "));
      await tick();
      assert(!previewHost(message) && requests === 1, "failed metadata was retried");
      assert(link.parentElement === message, "original link removed");
    } finally {
      stop();
    }
  });
  await check(
    "direct images avoid metadata requests; HTML without image metadata leaves no preview",
    async () => {
      const { root, message, link } = previewChat();
      link.href = `${location.origin}/preview-image?token=abc`;
      for (const path of ["/preview-redirect", "/preview-page"]) {
        const other = document.createElement("a");
        other.href = `${location.origin}${path}`;
        message.append(other);
      }
      document.body.append(root);
      let requests = 0;
      const resolve = createPreviewPageResolver(async (url) => {
        requests++;
        return loadPreviewPage(url);
      });
      const stop = observeChatPreviews(root, "twitch.tv", resolve);
      try {
        await waitFor(
          () => previewHost(message)?.shadowRoot?.querySelectorAll("img").length === 2,
          "direct images not rendered",
        );
        const shadow = previewHost(message)!.shadowRoot!;
        await resolve(`${location.origin}/preview-page`);
        await tick();
        assert(requests === 1, "direct images triggered metadata requests");
        assert(shadow.querySelectorAll("img").length === 2, "HTML response left a preview");
        assert(message.querySelectorAll("a").length === 3, "original links changed");
        message.prepend(document.createTextNode("updated "));
        await tick();
        assert(previewHost(message)?.shadowRoot === shadow, "failed URL triggered another probe");
      } finally {
        stop();
        root.remove();
      }
    },
  );
  await check(
    "previews follow new messages, edited/deleted links and chat remounts without duplicates",
    async () => {
      const { root, message, link } = previewChat();
      const stop = observeChatPreviews(root, "twitch.tv");
      try {
        await waitFor(() => previewHost(message), "initial preview missing");
        const first = previewHost(message);
        message.prepend(document.createTextNode("edited message "));
        await tick();
        assert(previewHost(message) === first, "unrelated mutations recreated preview");
        link.href = `${location.origin}/preview-image?changed=1&tracking=1#fragment`;
        await waitFor(
          () => previewHost(message)?.shadowRoot?.querySelector("img")?.src === link.href,
          "edited URL ignored",
        );
        link.remove();
        await tick();
        assert(!previewHost(message), "deleted link left a preview");
        root.replaceChildren();
        const replacement = previewChat();
        root.append(replacement.message);
        await waitFor(() => previewHost(replacement.message), "remounted chat ignored");
        const restored = previewHost(replacement.message)!;
        restored.remove();
        await waitFor(
          () => previewHost(replacement.message) === restored,
          "removed preview not restored",
        );
        assert(
          root.querySelectorAll("[data-imageuploader-preview]").length === 1,
          "removed preview was duplicated",
        );
      } finally {
        stop();
      }
    },
  );
  await check("removing a message removes its preview", async () => {
    const { root, message } = previewChat();
    const stop = observeChatPreviews(root, "twitch.tv");
    try {
      await waitFor(() => previewHost(message), "initial preview missing");
      message.remove();
      await tick();
      assert(!root.querySelector("[data-imageuploader-preview]"), "message removal left a preview");
    } finally {
      stop();
    }
  });
  await check("unresolvable links never render and are not retried", async () => {
    const { root, message, link } = previewChat();
    link.href = `${location.origin}/preview-page?unresolvable=1`;
    const stop = observeChatPreviews(root, "twitch.tv");
    try {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
      assert(!previewHost(message), "non-image link rendered");
      message.prepend(document.createTextNode("updated "));
      await tick();
      assert(!previewHost(message), "non-image link retried");
      assert(link.parentElement === message, "original link removed");
    } finally {
      stop();
    }
  });
}

async function checkNoticePlacement() {
  const tick = () => new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  for (const [site, createChat, createOtherChat] of [
    ["Twitch", twitchChat, kickChat],
    ["Kick", kickChat, twitchChat],
  ] as const) {
    await check(
      `${site}: notice survives chat removal and reattaches to the matching composer`,
      async () => {
        document.body.replaceChildren();
        const { chat } = createChat();
        const host = document.createElement("div");
        host.textContent = "https://twir.app/u/preserved";
        const unmount = mountNotice(host, chat);
        try {
          chat.remove();
          const bareEditor = document.createElement("div");
          bareEditor.contentEditable = "true";
          bareEditor.setAttribute("data-a-target", "chat-input");
          if (site === "Kick") bareEditor.id = "chatroom-footer";
          document.body.append(bareEditor);
          const other = createOtherChat();
          await tick();
          assert(host.isConnected, "links disappeared with the old chat");
          assert(
            host.getAttribute("data-placement") === "floating",
            "missing chat did not use fallback",
          );
          assert(!bareEditor.contains(host), "fallback panel was mounted inside a bare editor");
          assert(!other.chat.contains(host), "panel attached to another site's composer");
          const replacement = createChat();
          await tick();
          assert(replacement.chat.firstElementChild === host, "panel did not reattach");
          assert(host.getAttribute("data-placement") === "chat", "inline styling not restored");
          assert(host.textContent === "https://twir.app/u/preserved", "links lost on remount");
          host.remove();
          await tick();
          assert(host.isConnected, "removing only the panel was not repaired");
        } finally {
          unmount();
          host.remove();
        }
        await tick();
        assert(!host.isConnected, "dismissed panel reappeared");
      },
    );
  }
}

async function checkCopyButtons() {
  const tick = () => new Promise<void>((resolve) => window.setTimeout(resolve, 0));

  await check(
    "copy button copies its own URL and morphs to a check only after success",
    async () => {
      let copied = "";
      const { promise, resolve } = Promise.withResolvers<void>();
      const control = createCopyButton(
        "https://twir.app/u/copy-test",
        (error) => {
          throw new Error(error);
        },
        (text) => {
          copied = text;
          return promise;
        },
      );
      document.body.append(control.element);
      try {
        const path = control.element.querySelector("path")!;
        const originalPath = path.getAttribute("d");
        assert(originalPath, "Morphicons copy icon wasn't rendered");
        control.element.click();
        assert(copied === "https://twir.app/u/copy-test", "wrong URL copied");
        assert(
          control.element.getAttribute("data-state") === "copying",
          "check shown before clipboard write finished",
        );
        assert(path.getAttribute("d") === originalPath, "icon changed before successful copy");
        resolve();
        await tick();
        assert(
          control.element.getAttribute("data-state") === "copied",
          "successful copy not indicated",
        );
        assert(
          control.element.getAttribute("aria-label") === "Copied",
          "accessible label not updated",
        );
        await new Promise((resolve) => window.setTimeout(resolve, 100));
        assert(path.getAttribute("d") !== originalPath, "Morphicons didn't animate to the check");
        await new Promise((resolve) => window.setTimeout(resolve, 2_100));
        assert(
          control.element.getAttribute("data-state") === "idle",
          "copy state wasn't restored after two seconds",
        );
        assert(
          control.element.getAttribute("aria-label") === "Copy link",
          "copy label wasn't restored",
        );
      } finally {
        control.destroy();
        control.element.remove();
      }
    },
  );

  await check("copy failures keep the copy icon and report the actual error", async () => {
    let message = "";
    const control = createCopyButton(
      "https://twir.app/u/test",
      (error) => {
        message = error;
      },
      async () => {
        throw new DOMException("Clipboard blocked", "NotAllowedError");
      },
    );
    document.body.append(control.element);
    try {
      control.element.click();
      await tick();
      assert(message.includes("Clipboard blocked"), "copy error wasn't reported");
      assert(control.element.dataset.state === "idle", "failed copy shows success");
      assert(!control.element.disabled, "copy button cannot be retried");
    } finally {
      control.destroy();
      control.element.remove();
    }
  });

  await check("closing a notice stops pending copy state updates", async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    const control = createCopyButton(
      "https://twir.app/u/test",
      () => {},
      () => promise,
    );
    document.body.append(control.element);
    control.element.click();
    control.destroy();
    control.element.remove();
    resolve();
    await tick();
    assert(control.element.dataset.state === "copying", "destroyed control was updated");
  });
}

type TestNoticeFactory = (
  writeText: (text: string) => Promise<void>,
  chatInput?: Element | null,
  editing?: Parameters<typeof createNotice>[2],
) => { notify: ReturnType<typeof createNotice>; root: ShadowRoot; host: Element };

async function captureNotices(run: (create: TestNoticeFactory) => Promise<void>) {
  const attachShadow = Element.prototype.attachShadow;
  const roots: ShadowRoot[] = [];
  Element.prototype.attachShadow = function (options) {
    const root = attachShadow.call(this, options);
    roots.push(root);
    return root;
  };
  try {
    await run((writeText, chatInput = null, editing) => {
      const index = roots.length;
      const notify = createNotice(writeText, chatInput, editing);
      const root = roots[index];
      assert(root, "notice shadow root not created");
      return { notify, root, host: root.host };
    });
  } finally {
    Element.prototype.attachShadow = attachShadow;
  }
}

async function checkNoticePreviews(testNotice: TestNoticeFactory) {
  const { chat } = twitchChat();
  const kick = kickChat();
  try {
    for (const [label, placement] of [
      ["floating", null],
      ["Twitch inline", chat],
      ["Kick inline", kick.chat],
    ] as const) {
      await check(`${label} upload panel shows a preview for each link`, async () => {
        let copied = "";
        const { notify, root } = testNotice(async (text) => {
          copied = text;
        }, placement);
        const urls = ["https://twir.app/u/First", "https://twir.app/u/Second"];
        try {
          notify("Uploaded. Copy the link:", urls, true);
          const images = root.querySelectorAll<HTMLImageElement>(".preview img");
          assert(images.length === 2, "missing upload previews");
          for (const [index, image] of images.entries()) {
            const preview = image.parentElement as HTMLAnchorElement;
            assert(image.src === urls[index] && preview.href === urls[index], "wrong preview URL");
            assert(image.loading === "lazy" && image.decoding === "async", "eager preview loading");
            assert(image.referrerPolicy === "no-referrer", "page referrer can leak");
            assert(
              preview.target === "_blank" && preview.rel.includes("noreferrer"),
              "unsafe preview link",
            );
            assert(
              preview.nextElementSibling?.className === "link",
              "preview not above its copy row",
            );
          }
          const links = root.querySelector<HTMLElement>(".links")!;
          images[1]!.src = `${location.origin}/viewer-image`;
          (images[1]!.parentElement as HTMLAnchorElement).click();
          const viewer = document.querySelector<HTMLElement>(
            "[data-imageuploader-viewer]",
          )!.shadowRoot!;
          assert(
            viewer.querySelector("img")!.src === images[1]!.src,
            "upload preview did not open the image viewer",
          );
          viewer.querySelector<HTMLButtonElement>('[aria-label="Close image preview"]')!.click();
          assert(getComputedStyle(links).overflowY === "auto", "multiple uploads cannot scroll");
          images[0]!.dispatchEvent(new Event("error"));
          assert(root.querySelectorAll(".preview").length === 1, "broken preview retained");
          const inputs = root.querySelectorAll<HTMLInputElement>("input");
          assert(
            inputs.length === 2 && inputs[0]!.value === urls[0],
            "broken image removed its link",
          );
          root.querySelectorAll<HTMLButtonElement>(".copy-button")[1]!.click();
          await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
          assert(copied === urls[1], "preview changed copy behavior");
          notify("Uploading another image…", [], true);
          assert(!root.querySelector(".preview, .link"), "update retained old previews or links");
          notify("Not an Uploader image", ["https://twir.app/uploader"], true);
          assert(!root.querySelector(".preview"), "non-image URL previewed");
        } finally {
          root.querySelector<HTMLButtonElement>("header button")!.click();
        }
      });
    }
  } finally {
    chat.remove();
    kick.chat.remove();
  }
}

async function checkNoticeCountdown() {
  await captureNotices(async (testNotice) => {
    await checkNoticePreviews(testNotice);
    await check(
      "upload preview opens editor and replaces only the edited link after upload",
      async () => {
        const file = await editorFixture();
        const urls = ["https://twir.app/u/Original", "https://twir.app/u/Other"];
        const nextUrl = "https://twir.app/u/Edited";
        const field = textarea(`Draft ${urls[0]}`);
        const files = new Map([
          [urls[0]!, file],
          [urls[1]!, file],
        ]);
        const pending = Promise.withResolvers<string>();
        let copied = "";
        let replacedWhileOpen: boolean | undefined;
        const { notify, root } = testNotice(
          async (text) => {
            copied = text;
          },
          null,
          {
            files,
            upload: () => pending.promise,
            replace: (from, to) => {
              replacedWhileOpen = Boolean(document.querySelector("[data-imageuploader-editor]"));
              replaceText(field, from, to);
            },
          },
        );
        try {
          notify("Uploaded", urls, true);
          const preview = root.querySelector<HTMLAnchorElement>(".preview")!;
          assert(preview.title === "Edit image", "upload preview not editable");
          preview.click();
          const editorHost = document.querySelector<HTMLElement>("[data-imageuploader-editor]")!;
          assert(editorHost?.shadowRoot, "preview did not open editor overlay");
          const buttons = () => [...editorHost.shadowRoot!.querySelectorAll("button")];
          const save = buttons().find((button) => button.textContent === "Upload edited image")!;
          for (let count = 0; save.disabled && count < 100; count++)
            await new Promise<void>((resolve) => window.setTimeout(resolve, 10));
          assert(!save.disabled, "local original did not load");
          save.click();
          assert(
            root.querySelector("input")!.value === urls[0],
            "original link replaced before success",
          );
          pending.resolve(nextUrl);
          for (let count = 0; editorHost.isConnected && count < 100; count++)
            await new Promise<void>((resolve) => window.setTimeout(resolve, 10));
          assert(!editorHost.isConnected, "successful editor did not close");
          assert(replacedWhileOpen === false, "draft was edited while the editor was still open");
          assert(field.value === `Draft ${nextUrl}`, `draft not updated: ${field.value}`);
          const inputs = root.querySelectorAll("input");
          assert(
            inputs[0]!.value === nextUrl && inputs[1]!.value === urls[1],
            "wrong upload link replaced",
          );
          assert(
            files.get(nextUrl)?.type === "image/png",
            "edited source not retained for reopening",
          );
          assert(
            root.activeElement === root.querySelector(".preview"),
            "focus not restored to updated preview",
          );
          root.querySelector<HTMLButtonElement>(".copy-button")!.click();
          await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
          assert(copied === nextUrl, "copy button still copies original link");
        } finally {
          field.remove();
          root.querySelector<HTMLButtonElement>("header button")!.click();
        }
      },
    );
    const tick = () => new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    const waitForDismiss = () => new Promise<void>((resolve) => window.setTimeout(resolve, 3_100));
    let write: () => Promise<void> = async () => {};
    const { notify, root, host } = testNotice(() => write());

    await check(
      "successful copy starts a three-second countdown and dismisses a persistent notice",
      async () => {
        const pending = Promise.withResolvers<void>();
        write = () => pending.promise;
        try {
          notify("Uploaded. Copy the link:", ["https://twir.app/u/test"], true);
          const copy = root.querySelector<HTMLButtonElement>(".copy-button")!;
          const countdown = root.querySelector<HTMLElement>(".countdown")!;
          assert(countdown.hidden, "countdown visible before copying");
          copy.click();
          await tick();
          assert(countdown.hidden && host.isConnected, "countdown started before copy succeeded");
          pending.resolve();
          await tick();
          assert(!countdown.hidden, "countdown not shown after copying");
          const firstBar = countdown.firstElementChild!;
          assert(getComputedStyle(firstBar).animationDuration === "3s", "wrong countdown duration");
          write = () => Promise.resolve();
          copy.click();
          await tick();
          assert(
            countdown.firstElementChild !== firstBar,
            "repeat copy did not restart the countdown",
          );
          await waitForDismiss();
          assert(!host.isConnected, "persistent notice did not close after copying");
          await tick();
          assert(!host.isConnected, "dismissed notice was remounted");
        } finally {
          root.querySelector<HTMLButtonElement>("header button")!.click();
        }
      },
    );

    await check("automatic insertion notice stays open until the message is sent", async () => {
      const field = textarea("https://twir.app/u/test");
      try {
        notify(
          "Uploaded and inserted into chat. Copy the link:",
          ["https://twir.app/u/test"],
          true,
          { dismissOnSend: field },
        );
        const countdown = root.querySelector<HTMLElement>(".countdown")!;
        assert(countdown.hidden, "automatic insertion started a countdown");
        assert(host.isConnected, "automatic insertion notice missing");
        await waitForDismiss();
        assert(host.isConnected, "automatic insertion notice closed without sending");
        field.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }),
        );
        assert(host.isConnected, "a chat newline dismissed the notice");
        field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        assert(!host.isConnected, "sending the message did not dismiss the notice");
        await tick();
        assert(!host.isConnected, "dismissed auto-insert notice was remounted");
      } finally {
        field.remove();
        root.querySelector<HTMLButtonElement>("header button")!.click();
      }
    });

    await check(
      "failed retry cancels an active countdown and leaves the notice visible",
      async () => {
        let fail = false;
        write = async () => {
          if (fail) throw new Error("Clipboard blocked");
        };
        try {
          notify("Uploaded. Copy the link:", ["https://twir.app/u/test"], true);
          const copy = root.querySelector<HTMLButtonElement>(".copy-button")!;
          copy.click();
          await tick();
          fail = true;
          copy.click();
          await tick();
          assert(
            root.querySelector<HTMLElement>(".countdown")!.hidden,
            "failed copy shows countdown",
          );
          assert(root.textContent!.includes("Clipboard blocked"), "copy error not shown");
          await waitForDismiss();
          assert(host.isConnected, "notice closed after a copy error");
        } finally {
          root.querySelector<HTMLButtonElement>("header button")!.click();
        }
      },
    );

    await check(
      "repeat copy cancels the old countdown before calling the Tampermonkey clipboard API",
      async () => {
        const countdown = root.querySelector<HTMLElement>(".countdown")!;
        let canceledBeforeWrite = false;
        write = () => {
          canceledBeforeWrite = countdown.hidden === true;
          // GM.setClipboard can return an already-fulfilled promise. Native clicks
          // may run its continuation before the next non-capturing click listener.
          return Promise.resolve();
        };
        try {
          notify("Uploaded. Copy the link:", ["https://twir.app/u/test"], true);
          const copy = root.querySelector<HTMLButtonElement>(".copy-button")!;
          copy.click();
          await tick();
          assert(!countdown.hidden, "initial copy did not start the countdown");
          copy.click();
          await tick();
          assert(canceledBeforeWrite, "old countdown was canceled after the clipboard call");
          assert(!countdown.hidden, "successful repeat copy lost its new countdown");
          await waitForDismiss();
          assert(!host.isConnected, "notice did not close after the repeat copy");
        } finally {
          root.querySelector<HTMLButtonElement>("header button")!.click();
        }
      },
    );

    await check("updating a notice clears the previous copy countdown", async () => {
      write = async () => {};
      try {
        notify("Uploaded. Copy the link:", ["https://twir.app/u/test"], true);
        root.querySelector<HTMLButtonElement>(".copy-button")!.click();
        await tick();
        notify("Uploading another image…", [], true);
        assert(
          root.querySelector<HTMLElement>(".countdown")!.hidden,
          "stale countdown still visible",
        );
        await waitForDismiss();
        assert(host.isConnected, "previous countdown dismissed the updated notice");
      } finally {
        root.querySelector<HTMLButtonElement>("header button")!.click();
      }
    });

    await check(
      "new notices replace both floating and inline notices without reviving stale uploads",
      async () => {
        const { chat } = twitchChat();
        try {
          for (const placement of [null, chat]) {
            const pending = Promise.withResolvers<void>();
            const old = testNotice(() => pending.promise, placement);
            old.notify("Old upload", ["https://twir.app/u/old"], true);
            const copy = old.root.querySelector<HTMLButtonElement>(".copy-button")!;
            copy.click();
            const latest = testNotice(async () => {});
            try {
              latest.notify("New upload", [], true);
              assert(!old.host.isConnected, "previous notice is still visible");
              assert(latest.host.isConnected, "new notice is missing");
              pending.resolve();
              old.notify("Late upload result", ["https://twir.app/u/stale"], true);
              await tick();
              assert(!old.host.isConnected, "superseded notice was remounted");
              assert(copy.dataset.state === "copying", "pending copy updated a superseded notice");
              old.root.querySelector<HTMLButtonElement>("header button")!.click();
              assert(latest.host.isConnected, "old close handler dismissed the new notice");
            } finally {
              latest.root.querySelector<HTMLButtonElement>("header button")!.click();
            }
          }
        } finally {
          chat.remove();
        }
      },
    );

    await check("a replaced notice's copy countdown cannot dismiss the new notice", async () => {
      const old = testNotice(async () => {});
      old.notify("Old upload", ["https://twir.app/u/old"], true);
      old.root.querySelector<HTMLButtonElement>(".copy-button")!.click();
      await tick();
      const latest = testNotice(async () => {});
      try {
        latest.notify("New upload", [], true);
        await waitForDismiss();
        assert(!old.host.isConnected, "previous countdown notice reappeared");
        assert(latest.host.isConnected, "old countdown dismissed the new notice");
      } finally {
        latest.root.querySelector<HTMLButtonElement>("header button")!.click();
      }
    });

    await check(
      "Kick panel uses the chat theme and closes after copying without remounting",
      async () => {
        const { chat, editor } = kickChat();
        chat.style.setProperty("--color-surface-bg-default", "#112233");
        chat.style.setProperty("--color-surface-fg-default", "#ddeeff");
        chat.style.setProperty("--color-surface-fg-decorative", "#445566");
        chat.style.setProperty("--color-surface-bg-highest", "#223344");
        let copied = "";
        const panel = testNotice(
          (text) => {
            copied = text;
            return Promise.resolve();
          },
          findChatInput(editor, "kick.com"),
        );
        try {
          panel.notify("Uploaded. Copy the link:", ["https://twir.app/u/kick-test"], true);
          assert(chat.firstElementChild === panel.host, "panel not above the Kick composer");
          const card = getComputedStyle(panel.root.querySelector<HTMLElement>(".card")!);
          assert(card.backgroundColor === "rgb(17, 34, 51)", "Kick background not used");
          assert(card.color === "rgb(221, 238, 255)", "Kick text color not used");
          assert(card.borderTopColor === "rgb(68, 85, 102)", "Kick border color not used");
          assert(card.boxShadow === "none", "floating card shadow retained");
          assert(
            getComputedStyle(panel.root.querySelector<HTMLElement>(".link")!).backgroundColor ===
              "rgb(34, 51, 68)",
            "Kick input background not used",
          );
          panel.root.querySelector<HTMLButtonElement>(".copy-button")!.click();
          await tick();
          assert(copied === "https://twir.app/u/kick-test", "wrong Kick link copied");
          assert(!panel.root.querySelector<HTMLElement>(".countdown")!.hidden, "countdown missing");
          await waitForDismiss();
          assert(!panel.host.isConnected, "Kick panel did not close after copying");
          await tick();
          assert(!panel.host.isConnected, "Kick panel was remounted after dismissal");
          assert(editor.textContent === "unsent draft", "Kick draft changed");
        } finally {
          panel.root.querySelector<HTMLButtonElement>("header button")!.click();
          chat.remove();
        }
      },
    );
  });
}

async function checkSettings() {
  await check(
    "Twitch: settings button sits next to the account menu and toggles saved features",
    async () => {
      const saved: Settings[] = [];
      const settings = createSettings({
        load: () => ({}),
        save: (value) => saved.push(value),
      });
      await settings.ready;
      const nav = document.createElement("nav");
      nav.innerHTML =
        '<div class="header-right"><div data-a-target="dropdown-down"><button data-a-target="user-menu-toggle">Account</button></div></div>';
      document.body.append(nav);
      const stop = registerSettingsUi(settings, "www.twitch.tv");
      try {
        const host = document.querySelector<HTMLElement>(`[${SETTINGS_BUTTON_ATTRIBUTE}]`);
        assert(host?.shadowRoot, "settings button missing from the Twitch navigation");
        const account = nav.querySelector('[data-a-target="dropdown-down"]')!;
        assert(
          host.nextElementSibling === account,
          "settings button is not next to the account control",
        );
        assert(
          host.parentElement === account.parentElement,
          "settings button is in the wrong group",
        );
        assert(host.getAttribute(SETTINGS_BUTTON_ATTRIBUTE) === "twitch", "wrong site styling");

        const button = host.shadowRoot!.querySelector<HTMLButtonElement>("button")!;
        assert(button.title === "Viewer Companion settings", "old settings branding remains");
        assert(
          button.getAttribute("aria-label") === "Viewer Companion settings",
          "settings accessible name was not rebranded",
        );
        assert(
          button.querySelector("svg")?.getAttribute("viewBox") === "0 0 32 32" &&
            button.querySelectorAll("svg path").length === 1,
          "VC monogram is missing",
        );
        assert(
          getComputedStyle(button).color === "rgb(255, 255, 255)",
          "settings icon is not white",
        );
        button.click();
        const panel = document.querySelector<HTMLElement>(`[${SETTINGS_PANEL_ATTRIBUTE}]`);
        assert(panel?.shadowRoot, "settings panel did not open");
        const root = panel.shadowRoot!;
        assert(
          root.querySelector("header strong")?.textContent === "Viewer Companion",
          "settings title was not rebranded",
        );
        const tabs = [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
        const tabPanels = [...root.querySelectorAll<HTMLElement>('[role="tabpanel"]')];
        assert(
          tabs.length === 4 &&
            tabs[0]!.textContent === "General" &&
            tabs[1]!.textContent === "Filters" &&
            tabs[2]!.textContent === "Accounts" &&
            tabs[3]!.textContent === "Backup",
          "settings categories missing",
        );
        assert(
          tabs[0]!.getAttribute("aria-selected") === "true" &&
            tabs[0]!.tabIndex === 0 &&
            tabs[1]!.tabIndex === -1 &&
            tabs[2]!.tabIndex === -1 &&
            !tabPanels[0]!.hidden &&
            tabPanels[1]!.hidden &&
            tabPanels[2]!.hidden,
          "General is not the initial tab",
        );
        assert(root.activeElement === tabs[0], "opening did not focus the selected tab");
        assert(
          tabPanels.every(
            (tabPanel, index) =>
              tabs[index]!.getAttribute("aria-controls") === tabPanel.id &&
              tabPanel.getAttribute("aria-labelledby") === tabs[index]!.id,
          ),
          "tabs are not associated with their panels",
        );
        for (const [key, index] of [
          ["ArrowRight", 1],
          ["ArrowRight", 2],
          ["ArrowRight", 3],
          ["ArrowRight", 0],
          ["ArrowLeft", 3],
          ["Home", 0],
          ["End", 3],
          ["ArrowLeft", 2],
          ["ArrowLeft", 1],
        ] as const) {
          root.activeElement!.dispatchEvent(
            new KeyboardEvent("keydown", {
              key,
              bubbles: true,
              composed: true,
              cancelable: true,
            }),
          );
          assert(root.activeElement === tabs[index], `${key} did not focus its tab`);
          assert(
            tabs[index]!.getAttribute("aria-selected") === "true",
            `${key} did not select its tab`,
          );
          assert(
            tabPanels.every((tabPanel, position) => tabPanel.hidden === (position !== index)),
            `${key} did not switch panels`,
          );
        }
        const switches = root.querySelectorAll<HTMLInputElement>(".switch");
        assert(switches.length === 3, "settings switches missing");
        assert(
          switches[0]!.checked && !switches[1]!.checked && switches[2]!.checked,
          "wrong default settings",
        );
        switches[0]!.click();
        assert(!settings.get().chatPreviews, "chat preview setting was not applied");
        const radios = [...root.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
        assert(
          radios.every((radio) => radio.matches(":disabled")),
          "preview action stayed enabled",
        );
        radios[1]!.click();
        assert(settings.get().previewClick === "viewer", "disabled preview action changed");
        switches[1]!.click();
        assert(settings.get().autoInsert, "automatic insertion setting was not applied");
        tabs[1]!.click();
        assert(tabPanels[0]!.hidden && !tabPanels[1]!.hidden, "Filters did not open");
        assert(!switches[2]!.disabled, "filters disabled with chat previews");
        switches[2]!.click();
        assert(!settings.get().hideBots, "bot exclusion setting was not applied");
        const users = root.querySelector<HTMLTextAreaElement>('textarea[name="blockedUsers"]')!;
        const domains = root.querySelector<HTMLTextAreaElement>('textarea[name="blockedDomains"]')!;
        users.focus();
        users.value = "@Someone, Other_User";
        users.dispatchEvent(new InputEvent("input", { bubbles: true }));
        assert(
          users.value === "@Someone, Other_User",
          "auto-save moved the caret or rewrote a draft",
        );
        assert(
          settings.get().blockedUsers.join(",") === "someone,other_user",
          "user list not saved",
        );
        domains.focus();
        domains.value = "Example.com\nhttps://cdn.site/photo";
        domains.dispatchEvent(new InputEvent("input", { bubbles: true }));
        assert(
          settings.get().blockedDomains.join(",") === "example.com,cdn.site",
          "domain list not saved",
        );
        domains.value += "\nhttps:";
        domains.dispatchEvent(new InputEvent("input", { bubbles: true }));
        domains.setSelectionRange(domains.value.length, domains.value.length);
        const draft = domains.value;
        const caret = domains.selectionStart;
        tabs[0]!.focus();
        tabs[0]!.click();
        switches[1]!.click();
        switches[1]!.click();
        tabs[1]!.focus();
        tabs[1]!.click();
        assert(domains.value === draft, "switching tabs lost a partially typed domain");
        assert(domains.selectionStart === caret, "switching tabs moved the textarea caret");
        assert(users.value === "@Someone, Other_User", "switching tabs rewrote the username draft");
        settings.replace({ ...settings.get(), blockedUsers: ["remote_user"] });
        assert(
          String(users.value) === "remote_user",
          "external list changes were not synchronized",
        );
        users.focus();
        users.value = "@Someone, Other_User";
        users.dispatchEvent(new InputEvent("input", { bubbles: true }));
        tabs[0]!.focus();
        tabs[0]!.click();
        switches[0]!.click();
        assert(
          radios.every((radio) => !radio.matches(":disabled")),
          "preview action stayed disabled",
        );
        assert(
          radios.length === 2 && radios[0]!.checked && !radios[1]!.checked,
          "wrong preview click mode",
        );
        radios[1]!.click();
        assert(settings.get().previewClick === "site", "preview click mode was not applied");
        switches[0]!.click();
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        assert(
          saved.at(-1)?.chatPreviews === false &&
            saved.at(-1)?.autoInsert === true &&
            saved.at(-1)?.previewClick === "site",
          "settings were not persisted",
        );

        document.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
        assert(!panel.isConnected, "Escape did not close the settings panel");
        assert(
          button.getAttribute("aria-expanded") === "false",
          "settings button state was not reset",
        );
        assert(host.shadowRoot!.activeElement === button, "Escape did not restore gear focus");

        button.click();
        const reopened = document.querySelector<HTMLElement>(`[${SETTINGS_PANEL_ATTRIBUTE}]`);
        assert(reopened?.isConnected, "settings panel did not reopen");
        assert(
          reopened.shadowRoot!.querySelector<HTMLTextAreaElement>('textarea[name="blockedUsers"]')!
            .value === "someone\nother_user",
          "reopening lost user exclusions",
        );
        document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        assert(!reopened.isConnected, "outside click did not close the settings panel");
      } finally {
        stop();
        nav.remove();
      }
    },
  );

  await check("Kick: settings button is inserted before Get KICKs", async () => {
    const settings = createSettings({ load: () => ({}), save: () => {} });
    await settings.ready;
    const nav = document.createElement("nav");
    nav.innerHTML = '<div class="right"><button>Get KICKs</button><button>Avatar</button></div>';
    document.body.append(nav);
    const stop = registerSettingsUi(settings, "kick.com");
    try {
      const host = document.querySelector<HTMLElement>(`[${SETTINGS_BUTTON_ATTRIBUTE}]`);
      assert(host?.shadowRoot, "settings button missing from the Kick header");
      assert(host.getAttribute(SETTINGS_BUTTON_ATTRIBUTE) === "kick", "wrong site styling");
      const getKicks = [...nav.querySelectorAll("button")].find(
        (element) => element.textContent === "Get KICKs",
      )!;
      assert(host.nextElementSibling === getKicks, "settings button is not before Get KICKs");
      assert(
        host.parentElement === getKicks.parentElement,
        "settings button is in the wrong group",
      );
      const button = host.shadowRoot!.querySelector<HTMLButtonElement>("button")!;
      assert(getComputedStyle(button).color === "rgb(255, 255, 255)", "settings icon is not white");
    } finally {
      stop();
      nav.remove();
    }
  });

  await check(
    "Kick: settings button joins a hydrated header without displacing its groups",
    async () => {
      document.body.replaceChildren();
      const settings = createSettings({ load: () => ({}), save: () => {} });
      await settings.ready;
      const nav = document.createElement("nav");
      nav.style.cssText = "display:flex;justify-content:space-between";
      nav.innerHTML = '<a href="/">Logo</a><div class="right"><button>Drops</button></div>';
      document.body.append(nav);
      const stop = registerSettingsUi(settings, "kick.com");
      const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      try {
        const host = document.querySelector<HTMLElement>(`[${SETTINGS_BUTTON_ATTRIBUTE}]`)!;
        const right = nav.querySelector<HTMLElement>(".right")!;
        assert(host.shadowRoot, "settings button missing from the hydrated Kick header");
        assert(
          host.parentElement === right,
          "settings button became a navigation child and could displace the header groups",
        );

        // Kick hydrates the authenticated controls after the content script.
        // The balance variant has no "Get KICKs" text, so use the real test id.
        const kicks = document.createElement("button");
        kicks.dataset.testid = "kicks-top-nav";
        kicks.textContent = "1,200";
        right.prepend(kicks);
        await frame();
        await frame();
        assert(
          host.nextElementSibling === kicks,
          "settings button did not re-anchor after hydration",
        );
        assert(host.parentElement === right, "settings button left the account group");
        assert(
          nav.firstElementChild?.tagName === "A" && right.lastElementChild?.textContent === "Drops",
          "settings button displaced the Kick navigation groups",
        );
      } finally {
        stop();
        nav.remove();
      }
    },
  );

  await check("settings backup exports and imports valid JSON only after review", async () => {
    document.body.replaceChildren();
    const settings = createSettings({
      load: () => ({ blockedDomains: ["old.example"] }),
      save: () => {},
    });
    await settings.ready;
    const nav = document.createElement("nav");
    nav.innerHTML =
      '<div class="right"><button data-a-target="user-menu-toggle">Account</button></div>';
    document.body.append(nav);
    const stop = registerSettingsUi(settings, "www.twitch.tv");
    const waitFor = async (condition: () => boolean, message: string) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (condition()) return;
        await new Promise<void>((resolve) => window.setTimeout(resolve, 10));
      }
      throw new Error(message);
    };
    try {
      const host = document.querySelector<HTMLElement>(`[${SETTINGS_BUTTON_ATTRIBUTE}]`)!;
      host.shadowRoot!.querySelector<HTMLButtonElement>("button")!.click();
      const panel = document.querySelector<HTMLElement>(`[${SETTINGS_PANEL_ATTRIBUTE}]`)!;
      const root = panel.shadowRoot!;
      const tabs = [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
      tabs[3]!.click();
      const status = root.querySelector<HTMLElement>("#settings-panel-backup .status")!;
      const review = root.querySelector<HTMLElement>(".review")!;
      const buttons = [...root.querySelectorAll<HTMLButtonElement>(".action")];
      const button = (label: string) => buttons.find((element) => element.textContent === label)!;
      const importButton = button("Import settings");
      const exportButton = button("Export settings");
      const replaceButton = button("Replace settings");
      const cancelButton = button("Cancel");
      const file = root.querySelector<HTMLInputElement>('input[type="file"]')!;
      assert(
        status.getAttribute("role") === "status" && status.getAttribute("aria-live") === "polite",
        "import feedback is not announced",
      );
      assert(file.hidden && file.accept.includes("json"), "backup file picker is misconfigured");

      exportButton.click();
      assert(status.textContent === "Backup file exported.", "export feedback is missing");

      const choose = (text: string, name: string) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([text], name, { type: "application/json" }));
        file.files = transfer.files;
        file.dispatchEvent(new Event("change", { bubbles: true }));
      };
      choose("{", "broken.json");
      await waitFor(
        () => status.textContent!.includes("valid JSON"),
        "invalid backup was accepted",
      );
      assert(
        review.hidden && settings.get().blockedDomains.join(",") === "old.example",
        "invalid backup changed settings",
      );

      choose("x".repeat(MAX_SETTINGS_BACKUP_BYTES + 1), "huge.json");
      await waitFor(() => status.textContent!.includes("too large"), "oversized backup was read");
      assert(
        review.hidden && settings.get().blockedDomains.join(",") === "old.example",
        "oversized backup changed settings",
      );

      const backup = JSON.stringify({
        format: "imageuploader-settings",
        version: 1,
        exportedAt: "2026-10-26T20:00:00.000Z",
        settings: {
          chatPreviews: false,
          autoInsert: true,
          previewClick: "site",
          blockedUsers: ["@SomeOne"],
          blockedDomains: ["https://CDN.Example/a"],
          hideBots: false,
        },
      });
      choose(backup, "twitch-backup.json");
      await waitFor(() => !review.hidden, "valid backup was not reviewed");
      assert(review.textContent!.includes("twitch-backup.json"), "backup filename is missing");
      assert(
        settings.get().blockedDomains.join(",") === "old.example",
        "backup replaced settings before confirmation",
      );
      assert(root.activeElement === replaceButton, "review did not focus replacement");
      assert(
        review.getAttribute("role") === "group" &&
          replaceButton.getAttribute("aria-describedby") ===
            "settings-import-review-title settings-import-review-summary",
        "import review lacks accessible context",
      );
      replaceButton.click();
      assert(
        settings.get().chatPreviews === false &&
          settings.get().autoInsert === true &&
          settings.get().previewClick === "site" &&
          settings.get().hideBots === false,
        "backup settings were not applied",
      );
      assert(
        settings.get().blockedUsers.join(",") === "someone",
        "backup usernames not normalized",
      );
      assert(
        settings.get().blockedDomains.join(",") === "cdn.example",
        "backup domains not normalized",
      );
      assert(
        review.hidden && String(status.textContent) === "Settings imported.",
        "import feedback is missing",
      );
      assert(root.activeElement === importButton, "import did not restore focus");

      tabs[1]!.click();
      assert(
        root.querySelector<HTMLTextAreaElement>('textarea[name="blockedUsers"]')!.value ===
          "someone",
        "import did not update the username list",
      );
      assert(
        !root.querySelectorAll<HTMLInputElement>(".switch")[2]!.checked,
        "import did not update the bot toggle",
      );

      tabs[3]!.click();
      choose(backup.replace('"@SomeOne"', '"cancelled"'), "cancel.json");
      await waitFor(() => !review.hidden, "cancel backup was not reviewed");
      cancelButton.click();
      assert(review.hidden && String(status.textContent) === "", "cancel left import feedback");
      assert(settings.get().blockedUsers.join(",") === "someone", "cancel applied settings");
      assert(root.activeElement === importButton, "cancel did not restore import focus");
    } finally {
      stop();
      nav.remove();
    }
  });

  for (const hostname of ["www.twitch.tv", "kick.com"]) {
    await check(
      `${hostname}: settings stay anchored and scroll without hiding navigation`,
      async () => {
        document.body.replaceChildren();
        const settings = createSettings({ load: () => ({ chatPreviews: false }), save: () => {} });
        await settings.ready;
        const nav = document.createElement("nav");
        nav.style.cssText = "position:fixed;right:16px;bottom:16px;display:flex";
        nav.innerHTML =
          '<button data-a-target="user-menu-toggle">Account</button><button>Get KICKs</button>';
        document.body.append(nav);
        const stop = registerSettingsUi(settings, hostname);
        const frame = () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          );
        try {
          const host = document.querySelector<HTMLElement>(`[${SETTINGS_BUTTON_ATTRIBUTE}]`)!;
          host.shadowRoot!.querySelector<HTMLButtonElement>("button")!.click();
          const panel = document.querySelector<HTMLElement>(`[${SETTINGS_PANEL_ATTRIBUTE}]`)!;
          const root = panel.shadowRoot!;
          const tabs = root.querySelectorAll<HTMLButtonElement>('[role="tab"]');
          assert(
            root.querySelector("fieldset")!.disabled,
            "stored disabled preview state was ignored",
          );
          const assertBounds = () => {
            const rect = panel.getBoundingClientRect();
            assert(
              rect.left >= 7 && rect.right <= innerWidth - 7,
              "settings overflow the viewport width",
            );
            assert(
              rect.top >= 7 && rect.bottom <= innerHeight - 7,
              "settings overflow the viewport height",
            );
          };
          await frame();
          assertBounds();
          tabs[1]!.click();
          await frame();
          assertBounds();
          assert(
            !root.querySelector<HTMLInputElement>('[role="tabpanel"]:not([hidden]) input')!
              .disabled,
            "filters cannot be edited with previews off",
          );
          const users = root.querySelector<HTMLTextAreaElement>('textarea[name="blockedUsers"]')!;
          users.style.height = `${innerHeight}px`;
          await frame();
          assertBounds();
          const content = root.querySelector<HTMLElement>(".panels")!;
          assert(content.scrollHeight > content.clientHeight, "long settings cannot scroll");
          content.scrollTop = content.scrollHeight;
          const card = root.querySelector<HTMLElement>(".card")!.getBoundingClientRect();
          const close = root.querySelector<HTMLButtonElement>('[aria-label="Close settings"]')!;
          const note = root.querySelector<HTMLElement>(".note")!.getBoundingClientRect();
          assert(close.getBoundingClientRect().top >= card.top, "scrolling hid the close button");
          assert(note.bottom <= card.bottom && note.top >= card.top, "scrolling hid the save note");
          tabs[0]!.click();
          await frame();
          assertBounds();
          assert(content.scrollTop === 0, "tab switching retained an unrelated scroll offset");
          close.click();
          assert(
            !panel.isConnected &&
              host.shadowRoot!.activeElement === host.shadowRoot!.querySelector("button"),
            "close did not dismiss and restore focus",
          );
        } finally {
          stop();
          nav.remove();
        }
      },
    );
  }
}

void checkClipboard();
