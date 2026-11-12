# Viewer Companion

<!-- impeccable:product-schema 1 -->

## Platform

web

Browser extension for Firefox and Chrome/Chromium, with a standalone Tampermonkey userscript. Interfaces are injected into Twitch and Kick, including their subdomains; this is not a standalone website or native application.

## Users

Twitch and Kick viewers and chat participants who want companion tools without leaving the stream or chat.

## Product Purpose

Provide a viewer companion within the existing Twitch and Kick workflow. Current tools focus on image sharing and viewing: users can paste an image, obtain its public link, and choose when to send it, while viewing and optionally filtering image previews in chat. A playback tool keeps live streams close to the live edge by gently increasing speed when the stream falls behind. Broader viewer tools are a product direction, not implemented capabilities.

## Positioning

Viewer Companion combines clipboard uploads through Twir Uploader, inline chat-link previews, an image viewer, local image editing, and live delay catch-up inside Twitch and Kick. It augments the host site's chat and player rather than replacing them. No exclusive capability or competitive superiority claim is established.

## Operating Context

- Users install either the extension or the userscript, not both on the same site.
- Pasting an image into an editable field on a supported site immediately starts an upload. Normal text pastes remain unchanged.
- Completed links appear above a recognized chat input, with a floating notification as the fallback. Users can copy links and manually send their message.
- Optional automatic insertion adds a link to an unsent draft; it is off by default and never sends messages.
- Live delay catch-up is on by default. When a live stream falls behind by the configured threshold (4 seconds by default), playback runs 2-4% faster until the gap closes to about 1.5 seconds. The threshold is configurable from 1 to 60 seconds, and the feature can be disabled in General.
- A navigation VC button opens General, Filters, Accounts, and Backup settings. Chat previews can be disabled, opened in an on-page viewer or as website links, and excluded by username, domain, or known bot account. Previews from known bots are hidden by default. Settings can be exported to and imported from a local JSON backup; an import replaces all settings only after confirmation. Accounts currently offers one Twir connection; future platform connections belong in this separate tab.
- Upload thumbnails open an editor with crop, draw, rotate, horizontal flip, undo/redo, and reset. Uploading an edited image replaces its displayed link and any matching link in the unsent chat message only after success.
- The interface must coexist with host-site navigation, themes, chat input replacement, and chat remounting without disrupting messages, drafts, or normal link behavior.

## Capabilities and Constraints

- Uploads go to Twir Uploader, anonymously by default. The Chrome/Firefox extensions and the Tampermonkey/Violentmonkey userscript can optionally connect Twir via OAuth PKCE and associate new uploads with that account. Accepted formats are PNG, JPEG, GIF, WebP, AVIF, and BMP, up to 25 MiB per file; SVG is unsupported. Multiple images upload sequentially.
- Twir authorization requests only `files:edit`, which bundles upload and deletion rights; Viewer Companion does not delete files. Refresh tokens persist in extension-origin IndexedDB in the extension and in userscript-manager GM storage in the userscript. Access tokens and pending sign-in state live in private session storage in the extension and in GM storage in the userscript. No tokens are sent to page scripts, website storage, or settings backups. Storage is isolated, not an encrypted OS keychain. Expired/rejected authorization blocks uploads until reconnection, without anonymous fallback. Disconnect clears local authorization and attempts remote revocation without deleting existing images.
- Public uploads are not deleted by closing a panel, undoing chat text, or replacing a link with an edited upload. Retention and deletion policies belong to Twir; anonymous upload management is not implemented.
- Image editing is local and in-memory, limited to 32 megapixels. Edited exports are PNG; animated GIFs become still images. Closing the editor discards unsaved edits.
- Chat previews inspect HTTP/HTTPS links and may fetch page metadata when direct image loading fails. Unsupported layouts and failed previews leave original messages and links intact.
- Delay catch-up estimates the gap to the live edge from the player's seekable range. It changes only the playback rate: resolution and audio pitch are unchanged. VODs, clips, ads, and paused videos are never affected. Players that do not report a live seekable range are left untouched.
- Preview exclusions affect chat thumbnails, not uploaded-image panels or the editor. Settings apply without a page reload.
- Settings are stored locally and shared across supported sites by extension storage or Tampermonkey storage. The userscript falls back to per-site local storage if its storage API is unavailable.
- Clipboard images are read only from trusted paste events in editable fields. There is no clipboard polling, browsing-history collection, telemetry, or upload storage within Viewer Companion. Clipboard replacement happens only on an explicit copy action.
- Uploads and background metadata requests omit cookies and the host-page referrer. Only authenticated Twir uploads receive a bearer token; previews and metadata remain anonymous. Chat text and Twitch/Kick page URLs are not sent to the uploader. Ordinary image requests and metadata requests still expose the user's IP address and requested URL to destination servers; image requests follow browser cookie policy.
- Twir controls uploader availability and limits. Failed uploads are not automatically retried. Authenticated pages, script-generated metadata, and destination security policies may prevent previews.
- The documented minimum browsers are Firefox 140+ and Chrome/Chromium 148+. Extension and userscript behavior should remain aligned where platform APIs permit.

## Brand Commitments

The product name is Viewer Companion (вьювер компаньен), formerly ImageUploader. The user approved a minimalist, monochrome, angular VC monogram inspired by the graphic economy of 7TV, not a copy of its mark. Preserve the existing interface layout and behavior during this rebrand. Twitch, Kick, 7TV, and Twir Uploader are external brands; no affiliation is implied.

Legacy extension IDs, userscript namespace and update URLs, storage keys, backup format, and release filenames remain stable for compatibility. Visible labels and new backup filenames use Viewer Companion.

## Evidence on Hand

- `README.md` documents installation, supported workflows, privacy disclosures, limitations, and manual extension loading.
- `src/` contains the implemented upload, chat preview, settings, viewer, editor, and userscript behavior.
- `extension/` contains browser metadata; `tests/` contains unit and browser integration coverage.
- `package.json` and `wxt.config.ts` establish the existing Bun/WXT build tooling. There is no standalone app development-server workflow.
- No customer testimonials, adoption statistics, performance benchmarks, or pricing evidence was established during init; do not invent them.

## Product Principles

1. Keep participants in their existing chat workflow; do not replace chat or silently send messages.
2. Preserve user control over drafts, clipboard writes, preview behavior, and edited-image uploads.
3. Be explicit that pasted images become public third-party uploads; do not imply private hosting or deletion control.
4. Keep settings and chat processing local, with no telemetry or unnecessary data transmission.
5. Fail without damaging the host experience: retain original links, completed uploads, and recoverable edits when requests or integrations fail.

## Accessibility & Inclusion

Existing behavior includes reduced-motion handling, keyboard controls, and focus containment/restoration in the image viewer. Preserve these behaviors. No additional accessibility standard or compliance claim was established during init.
