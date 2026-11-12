---
name: Viewer Companion
description: Established branding and preserved injected extension UI.
colors:
  surface: "#18181b"
  text: "#fafafa"
  mark-white: "#fff"
  muted: "#a1a1aa"
  control: "#27272a"
  divider: "#3f3f46"
  field: "#09090b"
  field-border: "#52525b"
  field-border-hover: "#71717a"
  accent: "#9147ff"
  accent-hover: "#a970ff"
  focus: "#a78bfa"
  notice-border: "#7160ec"
  kick-focus: "#53fc18"
  beta-background: "#facc151a"
  beta-border: "#facc1533"
  beta-text: "#fde047"
typography:
  account-title:
    fontFamily: "system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 600
  title:
    fontFamily: "system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 600
  body:
    fontFamily: "system-ui, sans-serif"
    fontSize: "13px"
    lineHeight: 1.45
  hint:
    fontFamily: "system-ui, sans-serif"
    fontSize: "12px"
    lineHeight: 1.5
rounded:
  control: "6px"
  kick-button: "8px"
  settings: "10px"
  notice: "12px"
spacing:
  copy-gap: "4px"
  action-gap: "8px"
  row-gap: "16px"
  panel-padding: "20px"
  section-gap: "24px"
components:
  settings-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.settings}"
    width: "420px"
  action:
    backgroundColor: "{colors.control}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "0 12px"
  action-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "0 12px"
  textarea:
    backgroundColor: "{colors.field}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
---

# Design System: Viewer Companion

## Overview

**Creative North Star: "A compact companion, not a replacement."**

Viewer Companion (вьювер компаньен) uses an original, angular, solid monochrome VC monogram. The approved reference is 7TV's graphic economy, not its lettering or identity. This document captures a narrow rebrand and incumbent UI tokens, not a redesign or a new visual world. Existing layout, styles, behavior, and the product principles in `PRODUCT.md` remain unchanged.

**Key Characteristics:**

- Forward-cut solid V and open C; compact, monochrome recognition.
- Existing dark settings, system typography, and purple interaction accents.
- Host-compatible injected controls rather than a standalone application shell.

## Colors

The mark is neutral; purple remains an existing UI accent, not a new logo color. `accent` identifies checked switches and primary actions; `accent-hover` and `focus` retain their existing interaction roles. Neutral tokens distinguish settings surfaces, controls, fields, dividers, and secondary copy. `notice-border` belongs to the floating upload notification; `kick-focus` belongs only to the Kick navigation button.

## Typography

Use the incumbent system-ui stack, with settings title, body, and hint roles above. Labels retain their existing medium weight. Floating notices use the same stack at (14px/1.5); chat-mounted notices use (12px/1.4). No display face or custom font has been introduced.

The Twir account heading is 18px/600. A separate full-width notice at the top of the Accounts tab, above all provider sections, reads **Sign-in is in beta.** (12px/1.5, 8px 12px padding, 6px radius). It has a translucent yellow background, a subtle 1px border, yellow text, and an 18px decorative warning-triangle SVG. This notice belongs to the whole tab, not to Twir. It stays visible in every connection state and uses `beta-background`, `beta-border`, and `beta-text`, not the error palette. Keep the rest of Accounts minimal.

Passive account-status failures do not add error copy or permanently disable Sign in. Preserve the last known account state without treating an unknown status as signed out. Explicit sign-in and sign-out errors remain inline, and successful action state remains visible even if the following status refresh fails.

## Layout

Settings retain an anchored panel with viewport clearance (8px), maximum width `calc(100vw - 16px)`, and maximum height `calc(100dvh - 16px)`. The content region scrolls; tabs are General, Filters, Accounts, and Backup, in that order. Use the extracted spacing roles without imposing a new global grid or breakpoint system. Floating notices remain (360px) wide, capped at `calc(100vw - 40px)`; chat-mounted notices fill their host width.

## Elevation & Depth

Existing panels combine dark tonal layering, borders, and structural shadows. Settings and floating-notice shadow values are recorded in the sidecar. Chat-mounted notices keep their host-color fallbacks and no shadow; do not force the floating-panel appearance into chat.

## Shapes

The mark shares a (32×32) viewBox across `src/brand.ts`, `public/icon/icon.svg`, and `public/icon/theme.svg`; those files own the geometry. The browser tile has rounded corners (5 viewBox units), a neutral surface, and a white path. The transparent theme asset uses the neutral path in light mode and white in dark mode. Production navigation uses the same path at (20×20px), filled with `currentColor`. Keep the solid forward-cut V, open C, and their negative space; do not replace them with font letters or an outlined approximation. The revised C has inward-facing terminals, a beveled outer shoulder, and extra right clearance so its opening reads as intentional rather than a clipped letter.

## Components

- **Navigation:** preserve the Twitch button (30×30px, control radius, transparent rest background) and Kick button (36×36px, Kick radius, control background), including their existing hover and focus treatments. Both expose “Viewer Companion settings” as their accessible name; the decorative SVG stays hidden from assistive technology.
- **Settings:** preserve the card, tab order, toggles, fields, backup review, and immediate-save behavior. Primary and secondary actions retain their existing states; textareas retain visible focus. Sidecar snippets are visual extracts, not replacement production components.
- **Accounts:** a separate tab for platform connections, currently Twir only. It inherits the settings surface, medium-weight heading, muted status copy, purple primary action, secondary actions, focus rings, and disabled treatment; no new visual vocabulary. Keep the default view to the Twir heading and Sign in button, with no explanatory paragraphs or settings-save footer. Public-image and bundled-permission details remain in README.md and Twir's consent flow. Empty status and feedback paragraphs take no space. Checking connection disables Sign in; connecting shows a disabled Signing in… action with an available Cancel sign-in; connected shows Signed in and Sign out; expired authorization shows Sign in again and Sign out with the existing error treatment and a short explanation that uploads are paused. Status and feedback use polite live regions. Sign-out feedback distinguishes confirmed revocation from local-only disconnection, and sign-in failures appear inline. The extension and userscript show the same connection controls. Preserve the viewport-fitting shell, scrollable body, and available tabs and close control at narrow widths; the separate tab leaves room for future connections without presenting unimplemented providers.
- **Upload notice:** preserve the floating/chat variants, host-variable fallbacks, link and copy controls, and current reduced-motion behavior. The rebrand changes identity, not notification timing or interaction.
- **Assets:** committed PNGs at (16, 32, 48, 96, 128px) are rasterizations of the original authored `public/icon/icon.svg`, not downloaded or traced third-party artwork. Optional regeneration is `bun run build:icons`, requiring FFmpeg with librsvg support. Regular builds consume committed assets and do not require those tools.

The supplied independent finish review returned **SHIP** for this scoped rebrand using `artifacts/branding/desktop.png`, `artifacts/branding/mobile.png`, and native-size (16px/128px) logos. The screenshots render production settings in a local fixture, not live Twitch/Kick; fixture headings are not extension UI. Reported checks: 166 unit tests passed and 79 integration tests passed per browser. These results were supplied with the documentation brief, not rerun for this documentation-only change; they do not establish a broader UI redesign or accessibility certification.

## Do's and Don'ts

- **Do** preserve the shared authored geometry and theme-specific asset treatments.
- **Do** preserve incumbent UI layout, styles, behavior, host integration, and accessibility handling.
- **Don't** copy 7TV's mark or imply affiliation with external brands.
- **Don't** expand this scoped rebrand into a redesign or invent palette ramps, motion, or a full visual world.
- **Don't** rename compatibility identifiers, storage keys, or release artifacts solely to match visible branding.
