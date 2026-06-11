# Changelog — PyPDF Editor (iPhone PWA)

All notable changes to the on-device iPhone PWA. The "version" tag matches the
service-worker cache name (`CACHE` in `sw.js`); bumping it forces phones to fetch
the new build.

## [v9.1] — 2026-06-11 — Update reliability + fast updates

### Root cause of the "frozen scanner buttons"
A full integration suite (31 checks, executing the real app code with the real
engines) confirmed every feature works in the v9 code — including capture,
Cancel and the discard flow. The freeze matches a **partial update**: the
service worker installed shell files through the HTTP cache, which can mix a
stale `index.html` with a new `app.js`; the script then crashes at startup on a
missing element and every button wired after that point goes dead, silently.

### Fixes
- **Atomic updates**: the app shell is now installed with `cache:"reload"`
  (HTTP cache bypassed), so a build can never be a mix of old and new files.
- **Build guard**: if the page and script still somehow mismatch, the app now
  shows "App update incomplete — fully close the app and reopen it" instead of
  freezing silently.
- **Visible errors**: unexpected errors / unhandled rejections are surfaced in
  the status bar rather than dying silently.
- **Worker watchdog**: if the scan worker ever hangs, processing falls back to
  the main thread after 15s instead of freezing behind the spinner.

### Slow first load after updates — fixed
The cache was previously nuked and fully re-downloaded (~12MB including the
MuPDF engine) on **every** release. Caches are now split: a small app cache
(~100KB, bumped each release) and a separate vendor cache for the engine,
which persists across releases. Updates now download ~100KB, not ~12MB.
(The very first install still downloads the engine once — that's inherent.)

### Tests
- New `tests/harness.mjs`: headless integration suite (jsdom + real MuPDF +
  real pdf-lib) covering all 31 feature checks, plus negative tests for the
  partial-update guard and the hung-worker watchdog. All pass on this build.

## [v9-mupdf] — 2026-06-11 — Persistence, off-thread processing, capture conveniences

### Never lose work (IndexedDB persistence)
- The **working document** is saved on-device after every change (debounced,
  flushed the moment the app is hidden) and an **unfinished scan session**
  (captured pages) is saved continuously. If iOS kills or evicts the PWA, the
  next launch shows a **Restore previous session?** sheet — restore the
  document, continue the scan, or discard. Nothing is restored silently.
- Privacy rule: **password-unlocked PDFs are never persisted** — the decrypted
  copy lives only in memory and any stored copy is actively deleted.
- Closing a PDF or discarding a scan deliberately also clears the saved copy.

### Scanner
- **Off-thread processing**: perspective warp + filters now run in a Web Worker
  (`scan-worker.js`), so the UI no longer freezes during "Use page". Falls back
  to identical main-thread code if workers are unavailable. The two code paths
  are validated byte-for-byte identical in the build tests.
- **Auto-capture** (toggle, remembered): when the detected document holds steady
  for ~1.5s and fills enough of the frame, the page is captured automatically —
  with a "Hold still…" cue. Off by default.
- **Torch** toggle, shown only when the camera supports it.
- **Photos import**: a Photos button on the scanner imports an image from the
  library through the same edge-detection → crop → filter pipeline.
- The Colour / B&W choice is remembered across sessions.

### Editor
- **Page rotation**: the Organise sheet now has a ⟳ button per page (90° steps,
  badge shows the pending angle); rotations apply together with reorder/delete.
  Note: in-place text editing still assumes upright pages — edit text before
  rotating, or rotate back first.

### Validation (build tests, all PASS)
- Worker vs main-thread warp + both filters: byte-identical output.
- Edge detection ≤1px corner error; homography exact to 1e-13; B&W: 100%
  paper→white, 100% text→black on the shadow-gradient fixture.
- Rotation round-trip and the full rotate→reorder→delete pipeline verified
  against the real vendored pdf-lib + MuPDF engines.
- Persistence flows (save / restore / sensitive-doc exclusion / clear) verified
  against a simulated IndexedDB; all element ids, CSS classes, handlers and the
  service-worker shell statically checked.

## [v8.2-mupdf] — 2026-06-11 — Scanner UX + hardened CSP

### Scanner
- **Thumbnail strip**: scanned pages now appear as numbered thumbnails above the
  shutter. Tap one to preview it full-size and delete it before creating the PDF.
- **Steady edge outline**: the live green quad is smoothed — it appears after two
  consistent detections, eases toward each new detection instead of jumping, and
  tolerates brief detection dropouts. No more flicker.
- **Bigger corner targets**: each crop handle now has an invisible 28px-radius hit
  area on top of the visible grip, much easier to grab with a thumb.
- **In-app discard dialog**: cancelling a scan with pages now asks via the app's
  own bottom sheet instead of the jarring native confirm() popup.

### Security
- **CSP tightened — `'unsafe-inline'` removed from `style-src`**. All CSS moved to
  an external `styles.css` (new file, added to the offline cache), inline style
  attributes were removed from generated markup (replaced with classes/CSSOM), so
  injected-style attacks are now blocked too. Policy is now fully `'self'`-only
  apart from `wasm-unsafe-eval` (engine) and blob/data for local images.
- **Service-worker cache scoped**: cross-origin requests are no longer intercepted
  and `backups/` is never served or cached, keeping restore-point archives out of
  the app cache.

### Fixes
- **Layering bug**: the working spinner and bottom sheets rendered *underneath*
  the scanner screens (z-index 60/80 vs 90), so "Straightening page…" was
  invisible and sheets couldn't appear over the camera. Layering is now
  scanner (90) < sheets (110) < spinner (120).
- v8.1 restore point added at `backups/pypdf-pwa-v8.1-restore-point.zip`.

## [v8.1-mupdf] — 2026-06-11 — Scanner polish

- **Restore point**: `backups/pypdf-pwa-v8.0-restore-point.zip` is a full snapshot
  of the previous build (v8.0), with rollback instructions in `backups/RESTORE.md`.
- **Shutter button fixed**: a CSS specificity bug let the toolbar's `min-width`
  stretch the shutter into an oval. It is now a locked 74px circle (iOS-camera
  style ring), sized for 6.6"–6.9" phones.
- **Black & white filter overhauled**: much wider illumination window (no
  blotching or hollow letter strokes), a floor on the illumination map so dark
  photos/figures don't invert, steeper response and hard white/black clipping —
  paper comes out pure white and text pure black even under strong shadows.
  Validated on a synthetic shadow-gradient test: 100% of paper → white,
  100% of thin text → black, thick strokes stay solid.
- **Live filter preview**: on the Adjust-edges screen, tapping **Colour** /
  **Black & white** now re-renders the photo with that filter instantly
  (display-resolution preview; the final page is still processed at full
  resolution when you tap Use page).

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
