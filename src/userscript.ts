import { registerPasteHandler } from "./content";
import { uploadImage } from "./upload";
import { createUserscriptFetch, type UserscriptRequest } from "./userscript-request";
import { createPreviewPageResolver } from "./preview-page";
import { createUserscriptPreviewLoader, type UserscriptPreviewRequest } from "./userscript-preview";
import { createSettings } from "./settings";
import { createUserscriptSettingsStore } from "./userscript-settings";
import { registerLatencyCatcher } from "./latency";

declare const GM_xmlhttpRequest: UserscriptRequest & UserscriptPreviewRequest;
declare const GM: { setClipboard(text: string, type: "text"): Promise<void> };

const fetcher = createUserscriptFetch((details) => GM_xmlhttpRequest(details));
const settings = createSettings(createUserscriptSettingsStore());
registerLatencyCatcher(settings);
registerPasteHandler(
  (image) => uploadImage(image, fetcher),
  (text) => GM.setClipboard(text, "text"),
  createPreviewPageResolver(createUserscriptPreviewLoader((details) => GM_xmlhttpRequest(details))),
  settings,
);
