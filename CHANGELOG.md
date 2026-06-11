# Changelog — PyPDF Editor (iPhone PWA)

All notable changes to the on-device iPhone PWA. The "version" tag matches the
service-worker cache name (`CACHE` in `sw.js`); bumping it forces phones to fetch
the new build.

## [v8-mupdf] — 2026-06-11 — Document scanner (camera)

- New **Scan document (camera)** entry at the top of the **More** menu — a
  CamScanner / Office Lens style scanner that runs entirely on-device.
- **Live camera preview** (rear camera) with real-time document **edge detection**:
  the detected page is outlined in green as you aim. Detection is pure JS
  (Otsu threshold + largest connected component) — no new libraries, CSP unchanged
  except `media-src` for the camera stream.
- After capture, an **Adjust edges** screen shows the photo with the detected
  quadrilateral and four **draggable corner handles** to fine-tune the crop.
- **Perspective correction**: the chosen quad is straightened into a flat page with
  a true homography warp (bilinear sampling, output capped at 2000 px).
- **Filters**: *Colour* (gentle auto-contrast) or *Black & white* (adaptive
  threshold against the local mean — clean white paper, crisp text, shadows evened out).
- **Multi-page**: keep tapping the shutter to add pages, then **Create PDF (n)**
  builds one PDF (pages scaled to A4-size points) and opens it in the editor as
  `scan.pdf`, ready to edit, compress, sign or save.
- Falls back to the **native camera app** (file capture) if a live camera stream
  isn't available or permission is denied.
- Battery: the camera stream and detection loop are stopped whenever the app is
  hidden or the scanner is closed, and restarted on return.

## [v7-mupdf] — 2026-06-10 — About dialog

- Added an **About** entry at the bottom of the **More** menu (works with or without a
  PDF open). It opens a dialog showing the app **version (7.0)**, **build date/time**,
  the service-worker **cache name**, and the **engine** (MuPDF.js + pdf-lib), plus a
  short privacy note. This makes it easy to confirm, on the device, which build is
  actually running after an update.
- Version, build time and cache name are now kept in one place (`APP_VERSION` /
  `BUILD_DATETIME` in `app.js`, `CACHE` in `sw.js`) and bumped together each release.

## [v6-mupdf] — 2026-06-10 — Close PDF

- Added a **Close PDF** button at the bottom of the **More** menu. It closes the open
  document and returns to the empty state, releasing the MuPDF engine and image memory,
  clearing the undo history and resetting zoom to 100%. Disabled when nothing is open.

## [v5-mupdf] — 2026-06-10 — Battery, performance & security

### Battery / lifecycle
- Release all background work when the app is hidden or closed. A single lazy-render
  `IntersectionObserver` is now disconnected on `visibilitychange`, and on `pagehide`
  (app closed or swiped away) the MuPDF WebAssembly document is destroyed, image
  object URLs are revoked, the text-span cache is cleared and timers are stopped — so
  a backgrounded or closed PWA uses essentially no CPU or memory.
- Resume cleanly: re-attaches lazy rendering when the app becomes visible again, and
  rebuilds the engine if the OS restores the page from the back/forward cache.

### Performance
- Offscreen pages are no longer painted (`content-visibility:auto` with a per-page
  intrinsic size), a large CPU/GPU saving on long PDFs.
- Rendered page bitmaps are capped (~6 MP) so high zoom on a large page can't allocate
  a huge canvas.
- Resize re-renders only when the viewer width actually changes, ignoring the constant
  height-only resize events iOS fires as the address bar shows/hides.
- Reuse one render observer instead of leaking a new one on every re-render; images
  decode asynchronously; object URLs are tracked and revoked reliably.

### Security
- Added a strict Content-Security-Policy (`default-src 'none'`, scripts limited to
  same-origin plus `wasm-unsafe-eval` for the engine, no network egress). This blocks
  injected-script attacks. App logic was moved out of an inline block into `app.js` so
  the policy can forbid inline scripts entirely.
- Fixed a DOM-based XSS: PDF file names are now HTML-escaped before being shown in the
  password and merge dialogs (a crafted file name could previously inject markup).
- Download file names are sanitised (path separators and control characters stripped),
  and a `no-referrer` policy is set.

### Notes
- `app.js` and the new policy mean nothing loads from third-party servers and nothing
  you open ever leaves the device.

## [v4-mupdf] — 2026-06-09 — Workflow refinements

- **Fixed compress crash** ("Underlying ArrayBuffer has been detached"): MuPDF's
  byte outputs are views into WebAssembly memory that detach when the heap grows;
  every output is now copied into a JS-owned buffer immediately.
- **Images → PDF** now always creates a brand-new document instead of appending to the
  open file (closes the current file and opens the images as a new PDF).
- **Merge** now asks for the order — the open document plus each picked file are listed
  as PDF 1, PDF 2 … and combined top to bottom in the order you choose.
- **Zoom** control added: 50%–300% in 25% steps, default 100% (fit to width).
- **Sign** moved into the **More** menu; **Undo** promoted to the main toolbar.

## [v3-mupdf] — 2026-06-09 — UI fixes

- Signature "remove white background" is now off by default and removed from the UI
  (signatures are placed as-is).
- Fixed the **More → Cancel** button (it had no handler).
- Fixed unresponsive modal dialogs: the working spinner overlay was sitting on top of
  dialogs and swallowing taps. Modals now drop the spinner first and sit above it, so
  the password field, Unlock and Cancel buttons work.
- Fixed page scrolling in edit mode and on multi-page PDFs: the page overlay no longer
  intercepts touches except while drawing a signature box; text spans allow vertical
  panning so you can scroll and tap-to-edit.

## [v2-mupdf] — 2026-06-09 — Re-platformed on MuPDF.js

- Rebuilt the PWA on the **MuPDF.js** WebAssembly engine (vendored for full offline
  use), bringing the phone to parity with the macOS app.
- **True in-place text editing**: tap existing text, edit it, and the original glyphs
  are removed (MuPDF redaction) and new selectable text is reinserted at the same
  position, font, size and colour (drawn with pdf-lib).
- Added **password unlock** for encrypted PDFs (detected on open, decrypted in memory),
  **Organise pages** (reorder and delete), high-fidelity rendering, and structural
  compression. Retained Sign, Compress (3 levels), Merge, Images → PDF, page → PNG,
  Undo and Save.
- Service worker caches the engine so the app installs and runs fully offline.

### Engine architecture
- MuPDF.js is the core engine (render, text extraction, redaction, page operations,
  password handling, compression). pdf-lib is used only as a "pen" to draw replacement
  text and images back onto the page after MuPDF removes the originals.

### Known limits
- Replacement text uses the closest standard font (Helvetica / Times / Courier, with
  bold/italic) and the WinAnsi character set; unusual glyphs become `?`.
- Text-edit and signature placement assume an upright (0°) page.
- MuPDF.js is AGPL-3.0 (or commercial) — a public host must keep its source available.
