import { registerPasteHandler } from "./content";
import { decodeImage, uploadFile, UploadHttpError } from "./upload";
import { createUserscriptFetch, type UserscriptRequest } from "./userscript-request";
import { createPreviewPageResolver } from "./preview-page";
import { createUserscriptPreviewLoader, type UserscriptPreviewRequest } from "./userscript-preview";
import { createSettings } from "./settings";
import { createUserscriptSettingsStore } from "./userscript-settings";
import { registerLatencyCatcher } from "./latency";
import { createUserscriptAuth, relayUserscriptAuthCallback } from "./userscript-auth";
import { UPLOAD_TIMEOUT_MS } from "./config";

declare const GM_xmlhttpRequest: UserscriptRequest & UserscriptPreviewRequest;
declare const GM: { setClipboard(text: string, type: "text"): Promise<void> };

relayUserscriptAuthCallback();

const fetcher = createUserscriptFetch((details) => GM_xmlhttpRequest(details));
const settings = createSettings(createUserscriptSettingsStore());
const { auth, accounts } = createUserscriptAuth({ fetcher });
registerLatencyCatcher(settings);
registerPasteHandler(
  async (image) => {
    // Validate before refreshing a token, matching the extension background.
    const file = decodeImage(image);
    const access = await auth.accessToken();
    try {
      return await uploadFile(file, fetcher, UPLOAD_TIMEOUT_MS, access?.token);
    } catch (error) {
      if (access && error instanceof UploadHttpError && error.status === 401)
        await auth.rejectAccess(access);
      throw error;
    }
  },
  (text) => GM.setClipboard(text, "text"),
  createPreviewPageResolver(createUserscriptPreviewLoader((details) => GM_xmlhttpRequest(details))),
  settings,
  accounts,
);
