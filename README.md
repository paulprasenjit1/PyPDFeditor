Changelog — PyPDF Editor (iPhone PWA)

All notable changes to the on-device iPhone PWA. The "version" tag matches the service-worker cache name (CACHE in sw.js); bumping it forces phones to fetch the new build.

[v7-mupdf] — 2026-06-10 — About dialog

Added an About entry at the bottom of the More menu (works with or without a PDF open). It opens a dialog showing the app version (7.0), build date/time, the service-worker cache name, and the engine (MuPDF.js + pdf-lib), plus a short privacy note. This makes it easy to confirm, on the device, which build is actually running after an update.
Version, build time and cache name are now kept in one place (APP_VERSION / BUILD_DATETIME in app.js, CACHE in sw.js) and bumped together each release.
[v6-mupdf] — 2026-06-10 — Close PDF

Added a Close PDF button at the bottom of the More menu. It closes the open document and returns to the empty state, releasing the MuPDF engine and image memory, clearing the undo history and resetting zoom to 100%. Disabled when nothing is open.
[v5-mupdf] — 2026-06-10 — Battery, performance & security

Battery / lifecycle

Release all background work when the app is hidden or closed. A single lazy-render IntersectionObserver is now disconnected on visibilitychange, and on pagehide (app closed or swiped away) the MuPDF WebAssembly document is destroyed, image object URLs are revoked, the text-span cache is cleared and timers are stopped — so a backgrounded or closed PWA uses essentially no CPU or memory.
Resume cleanly: re-attaches lazy rendering when the app becomes visible again, and rebuilds the engine if the OS restores the page from the back/forward cache.
Performance

Offscreen pages are no longer painted (content-visibility:auto with a per-page intrinsic size), a large CPU/GPU saving on long PDFs.
Rendered page bitmaps are capped (~6 MP) so high zoom on a large page can't allocate a huge canvas.
Resize re-renders only when the viewer width actually changes, ignoring the constant height-only resize events iOS fires as the address bar shows/hides.
Reuse one render observer instead of leaking a new one on every re-render; images decode asynchronously; object URLs are tracked and revoked reliably.
Security

Added a strict Content-Security-Policy (default-src 'none', scripts limited to same-origin plus wasm-unsafe-eval for the engine, no network egress). This blocks injected-script attacks. App logic was moved out of an inline block into app.js so the policy can forbid inline scripts entirely.
Fixed a DOM-based XSS: PDF file names are now HTML-escaped before being shown in the password and merge dialogs (a crafted file name could previously inject markup).
Download file names are sanitised (path separators and control characters stripped), and a no-referrer policy is set.
Notes

app.js and the new policy mean nothing loads from third-party servers and nothing you open ever leaves the device.
[v4-mupdf] — 2026-06-09 — Workflow refinements

Fixed compress crash ("Underlying ArrayBuffer has been detached"): MuPDF's byte outputs are views into WebAssembly memory that detach when the heap grows; every output is now copied into a JS-owned buffer immediately.
Images → PDF now always creates a brand-new document instead of appending to the open file (closes the current file and opens the images as a new PDF).
Merge now asks for the order — the open document plus each picked file are listed as PDF 1, PDF 2 … and combined top to bottom in the order you choose.
Zoom control added: 50%–300% in 25% steps, default 100% (fit to width).
Sign moved into the More menu; Undo promoted to the main toolbar.
[v3-mupdf] — 2026-06-09 — UI fixes

Signature "remove white background" is now off by default and removed from the UI (signatures are placed as-is).
Fixed the More → Cancel button (it had no handler).
Fixed unresponsive modal dialogs: the working spinner overlay was sitting on top of dialogs and swallowing taps. Modals now drop the spinner first and sit above it, so the password field, Unlock and Cancel buttons work.
Fixed page scrolling in edit mode and on multi-page PDFs: the page overlay no longer intercepts touches except while drawing a signature box; text spans allow vertical panning so you can scroll and tap-to-edit.
[v2-mupdf] — 2026-06-09 — Re-platformed on MuPDF.js

Rebuilt the PWA on the MuPDF.js WebAssembly engine (vendored for full offline use), bringing the phone to parity with the macOS app.
True in-place text editing: tap existing text, edit it, and the original glyphs are removed (MuPDF redaction) and new selectable text is reinserted at the same position, font, size and colour (drawn with pdf-lib).
Added password unlock for encrypted PDFs (detected on open, decrypted in memory), Organise pages (reorder and delete), high-fidelity rendering, and structural compression. Retained Sign, Compress (3 levels), Merge, Images → PDF, page → PNG, Undo and Save.
Service worker caches the engine so the app installs and runs fully offline.
Engine architecture

MuPDF.js is the core engine (render, text extraction, redaction, page operations, password handling, compression). pdf-lib is used only as a "pen" to draw replacement text and images back onto the page after MuPDF removes the originals.
Known limits

Replacement text uses the closest standard font (Helvetica / Times / Courier, with bold/italic) and the WinAnsi character set; unusual glyphs become ?.
Text-edit and signature placement assume an upright (0°) page.
MuPDF.js is AGPL-3.0 (or commercial) — a public host must keep its source available.

##########################################################################################################################################

# PyPDF Editor — iPhone PWA (MuPDF.js engine)

A web version of the editor that installs to your iPhone Home Screen and runs
**entirely on the device**. No App Store, no sideloading, no Apple ID, no
payment, no expiry. Nothing you open is uploaded anywhere.

This version runs on the **MuPDF.js** engine, so it now does **true in-place text
editing** on the phone.¸                       

## What's in this folder

```
index.html              the app
manifest.webmanifest    makes it installable
sw.js                   offline support (service worker)
icon-180/192/512.png    app icons
vendor/
  pdf-lib.min.js        used to draw replacement text/images back into the page
  mupdf/
    mupdf.js            MuPDF.js wrapper (ES module)
    mupdf-wasm.js       WASM loader
    mupdf-wasm.wasm     the engine (~10 MB, cached once then works offline)
```

**Everything in this folder must be uploaded together**, including the whole
`vendor/` directory. The `.wasm` file is the engine — without it the app won't
open PDFs.

## How the engine is split

- **MuPDF.js** does the heavy lifting: high-fidelity page rendering, structured
  text extraction (positions, fonts, sizes, colours), permanent redaction,
  page reorder/delete, merge, password unlock, and compression.
- **pdf-lib** is used only as a "pen" — after MuPDF removes the original glyphs
  with a redaction, pdf-lib draws the new, selectable text (or an image) back at
  the same place, font, size and colour. This is exactly how the Mac app edits
  text: erase the old span, reinsert the new one.

## Install on your iPhone

1. Open the URL in **Safari** (must be Safari for install).
2. **Share** → **Add to Home Screen** → **Add**.
3. Open it. First launch downloads the ~10 MB engine once; after that it works
   offline.

> Requires iOS 16.4 or later (for WebAssembly + service worker support in
> installed web apps). Any recent iPhone is fine.

## Features (full parity with the Mac app)

The toolbar keeps the common actions one tap away — **Open · Edit text · Sign ·
Compress · Save** — with the rest under **More ▾**.

- **Open** — pick a PDF from Files, iCloud Drive or Photos. **Password-protected
  PDFs** are detected; enter the password once and the working copy is unlocked
  for editing and saving.
- **Edit text** — tap to enter edit mode; existing text is highlighted. Tap any
  piece, change it, and it's replaced in place — the original glyphs are
  removed and the new text is drawn at the same position, size and colour.
  Leave it empty to just delete the text.
- **Sign** — tap Sign, choose a signature image, then drag a box on the page.
  By default the white background is knocked out (toggle under **More ▾**).
- **Compress** — High (<1 MB), Medium (<700 KB) or Low (<200 KB). Tries a
  lossless pass first and only rasterises if needed to hit the target.
- **Save** — opens the iOS share sheet; choose **Save to Files** (or AirDrop,
  Mail, etc.).
- **More ▾**
  - **Undo last change** — revert the last edit.
  - **Organise pages** — reorder pages (↑ ↓) and mark pages to delete, then Apply.
  - **Merge another PDF** — append other PDFs to the end.
  - **Images → PDF** — turn photos / JPG / PNG into PDF pages.
  - **Current page → PNG** — save the page you're viewing as an image.

## Known limits

- **Replacement-text fonts:** new text is drawn with the closest standard font
  (Helvetica / Times / Courier, with bold/italic), matching the Mac app's
  base-14 approach. Exotic embedded fonts are approximated, not reproduced.
- **Characters:** replacement text uses the WinAnsi character set; very unusual
  glyphs are substituted with `?` so an edit never fails outright.
- **Rotated pages:** text-edit and signature placement assume an upright
  (0°) page, which covers almost all documents.

## Licensing note (important if you share it publicly)

MuPDF.js is licensed under the **GNU AGPL v3** (or a paid commercial licence
from Artifex). Hosting this app on a public URL counts as providing it as a
network service, which under the AGPL means the source must be available — your
GitHub Pages repo satisfies that if it stays public. For a private/personal tool
this is fine; for a closed-source or commercial product you'd need a commercial
licence from Artifex. See https://artifex.com/licensing.

## Updating the app later

Re-upload the changed files and **bump `CACHE` in `sw.js`** (e.g. `v2`→`v3`) so
phones fetch the new version. The Home Screen icon keeps working.
