import { defineContentScript } from "wxt/utils/define-content-script";
import { registerPasteHandler } from "../content";
import { SITE_MATCHES } from "../shared";
import { browser } from "wxt/browser";
import type { UploadMessage, UploadReply } from "../shared";
import { createPreviewPageResolver, type PreviewPageReply } from "../preview-page";
import { createSettings } from "../settings";
import { createExtensionSettingsStore, watchExtensionSettings } from "../extension-settings";
import { createExtensionAccounts } from "../extension-accounts";
import { registerLatencyCatcher } from "../latency";

export default defineContentScript({
  matches: SITE_MATCHES,
  runAt: "document_start",
  allFrames: true,
  main() {
    const settings = createSettings(createExtensionSettingsStore());
    watchExtensionSettings(settings);
    registerLatencyCatcher(settings);
    registerPasteHandler(
      async (image) => {
        const message: UploadMessage = { type: "upload-image", image };
        const reply: UploadReply | undefined = await browser.runtime.sendMessage(message);
        if (!reply)
          throw new Error("The extension's background process is unavailable. Reload the page.");
        if (!reply.ok) throw new Error(reply.error);
        return reply.url;
      },
      undefined,
      createPreviewPageResolver(async (url) => {
        const reply: PreviewPageReply | undefined = await browser.runtime.sendMessage({
          type: "preview-page",
          url,
        });
        return reply?.page ?? null;
      }),
      settings,
      createExtensionAccounts(),
    );
  },
});
