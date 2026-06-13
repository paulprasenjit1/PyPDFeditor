# Changelog — PyPDF Editor (iPhone PWA)

All notable changes to the on-device iPhone PWA. The "version" tag matches the
service-worker cache name (`CACHE` in `sw.js`); bumping it forces phones to fetch
the new build.

## [v10.15] — 2026-06-12 — Scan colour fix + detection fix (v10.14 regressions)

Two regressions from v10.14, both reported from device screenshots, both mine:

- **Yellow scans fixed.** The v10.14 shadow-lift multiplied all colour channels
  by one brightness-based gain — under warm indoor light that preserves (even
  amplifies) the yellow cast. The pipeline now white-balances **per channel**
  locally, so paper lands on neutral white regardless of the room's lighting.
  Fixture-proven: a warm-lit page (235/212/172) comes out at exactly
  255/255/255 across both lit and shadowed regions, with text untouched, and
  the worker/fallback remain byte-identical.
- **Green detection outline restored when the page fills the frame.** The
  detector rejected any candidate covering >92% of the frame — but filling the
  frame with the page is precisely how people scan. The limit is now 97%, and
  the shape thresholds were carefully loosened for real-world pages (boundary
  coverage 0.80→0.76, fill 0.85→0.80, minimum size 12%→10%) while the L-shape
  and blank/wall rejection fixtures still pass. New fixture: a page filling
  95% of the frame must detect (it does, at 1px).

All suites green: 51 integration + 4 guard + 6 detection + 21 scenario + 4
colour-pipeline checks.

## [v10.14] — 2026-06-12 — Toolbar polish + Adobe-grade scan quality

### Toolbar (from screenshot feedback)
- Segment buttons now share space in proportion to their labels — "Compress"
  never truncates, "Edit"/"Undo" no longer swim in slack.
- All toolbar buttons are bigger (14px text, taller targets), as mocked.
- The ✕ close button is now red, so its meaning is unmistakable.
- The stray pale block beneath the status banner now blends into the banner
  (page root background matched) and the banner itself is slightly slimmer.

### Scanner quality (Colour mode)
- **Capture at up to 4K** (was 2.5K) — more pixels into the perspective
  correction means visibly sharper text.
- **New "magic scan" colour pipeline**, applied identically in the worker and
  the fallback (parity test-enforced): local illumination correction lifts
  shadows so paper comes out flat white like a flatbed scan, then contrast
  stretch, then a luminance unsharp mask crisps text edges — the Adobe Scan
  look. The crop-screen preview shows exactly the final result.
- **Standard quality output raised**: max page 2000→2400px, JPEG 85→88.
  "Small file" unchanged. Black & white pipeline unchanged (already binary-crisp).
- Verified: app/worker byte parity on the new pipeline, shadow-gradient
  fixture lifts 145→240 background, all 81 existing checks pass.

## [v10.13] — 2026-06-12 — Segmented toolbar

- The toolbar is now three calm zones: **Open** (primary, left) · an iOS-style
  **segmented group** holding Edit / Undo / Compress / More (one soft container
  with hairline dividers that stretches to fill the row — no more uneven gaps
  or scattered pills) · **Save + ✕** (right; the ✕ is now a quiet borderless
  glyph). Disabled actions dim inside the segment instead of looking like
  washed-out buttons. The ▾ caret is gone from More.
- Same heights, same tap targets, both themes. CSS + markup only.

## [v10.12] — 2026-06-12 — Close in the toolbar

- A compact **✕ (close)** button now sits right after Save in the toolbar —
  one tap to close the document. Protected by the unsaved-changes guard, so a
  stray tap can never lose work. "Close this PDF" is removed from the More
  menu (it lived there before); More is now seven entries.

## [v10.11] — 2026-06-12 — Toolbar fit on Pro Max

- The zoom − / + buttons now step aside on ALL phone widths (breakpoint was
  430px; iPhone Pro Max screens are 440pt, so they never hid there). Pinch and
  double-tap zoom remain; buttons still show on tablet/desktop (≥600px).
- Toolbar button padding tightened slightly — Open · Edit · Undo · Compress ·
  More · Save all fit one row with no scrolling.

## [v10.10] — 2026-06-12 — Toolbar fits the screen

- **No more toolbar scrolling on phones.** The compression-level dropdown is
  gone from the toolbar — Compress now opens a small plain-words sheet
  (High quality / Balanced / Smallest) when tapped. The − / + zoom buttons
  step aside on phone widths (pinch and double-tap already zoom there; the
  buttons remain on tablets/desktop). Everything now fits in one row.
- "Edit text" is now simply **"Edit"**.
- Tests: 51 integration + 4 guard + 5 detection + 21 scenario = 81 checks
  (new: Compress level sheet renders and runs).

## [v10.9] — 2026-06-12 — Combine fix

- **Combine PDFs was broken since v10.2** — tapping it threw "Can't find
  variable: orig" before the order sheet could appear. Cause: the v10.2
  accessibility-label pass used a global text replacement that edited the
  Combine sheet's buttons with a variable that only exists in the Pages sheet.
  (Found via the on-device error log added in v9.3 — exactly what it's for.)
- Fixed, and three new tests now drive the actual Combine order sheet UI
  (render, reorder, cancel) plus an About-sheet smoke test, so this whole class
  of "sheet fails to build" bug is covered.
- Tests: 50 integration + 4 guard + 5 detection + 21 scenario = 80 checks.

## [v10.8] — 2026-06-12 — Visual refresh

CSS-only — zero behaviour change, ~3KB. All 77 checks still pass untouched.

- **Automatic light theme**: the whole app now follows the iPhone's system
  appearance — bright, clean whites in the day, the dark theme at night. No
  toggle, no settings screen. The scanner screens stay camera-black by design.
- **Richer dark theme**: deeper near-black background with a subtle blue cast
  instead of flat grey; refined borders and raised panels.
- **Buttons feel alive**: primary actions get a soft blue gradient and a gentle
  press-down (3% scale) on touch; secondary buttons get a raised tint. All
  motion respects the Reduce Motion accessibility setting.
- **Welcome screen hero**: larger gradient title and a soft glow under the
  primary button.
- **Sheets look iOS-native**: bigger top radius, a grabber bar, and a soft
  shadow; page rows in Pages / Copy-pages are now rounded cards.
- **Status messages** get a subtle colour-tinted background so success and
  error states read at a glance.
- The iOS status-bar colour (theme-color) now matches the active theme.

## [v10.7] — 2026-06-12 — Performance Pack (big scanned books)

Fixes for 500-page / ~100MB scanned-book PDFs hanging the app and the screen
blacking out during zoom. Five changes, no UI change:

- **Black-screen fix**: the page container was permanently promoted to a GPU
  layer (`will-change`) for pinch-zoom — for a 500-page book that is a texture
  hundreds of thousands of pixels tall, which exhausts the iOS compositor.
  The layer is now created only during an active pinch and released after.
- **Flat memory while reading**: pages that scroll far away are released back
  to lightweight placeholders and re-rendered when approached again — about a
  dozen live page bitmaps at any time, regardless of book length. (Previously
  every page you ever scrolled past stayed decoded in memory until iOS killed
  the tab.)
- **No more 100MB clones**: documents over 25MB are no longer auto-persisted
  for session restore — cloning the whole book to storage on open and after
  every change caused multi-second stalls. The original file in Files is
  unaffected; only the restore-after-kill convenience is skipped for huge docs.
- **Chunked page building with progress**: opening builds the page scaffold in
  slices ("Preparing page 240 of 500…") instead of freezing, and page sizes
  are cached per document version — zooming no longer makes 500 engine calls.
- **Adaptive sharpness**: documents over 150 pages render at 2× instead of 3×
  (indistinguishable for scanned books, half the work and memory). Small
  documents keep the full v10.6 Retina sharpness.

Tests: 47 integration (4 new: 300-page chunked build, zoom rebuild, bitmap
release/restore, >25MB persist skip) + 4 guard + 5 detection + 21 scenario
= 77 checks, all passing.

## [v10.6] — 2026-06-12 — Reading quality + page indicator

### Pages now render at true Retina sharpness
The root cause of "softer than Acrobat": pages were rasterised at a device
pixel ratio capped at 2, but modern iPhones are 3× displays — every page was
rendered at two-thirds of native resolution and stretched. Three changes:

- **Render at the real device pixel ratio (up to 3×)** — text is now pixel-sharp
  at native resolution, like a native PDF viewer.
- **Page bitmaps encode at JPEG quality 90** (was 80) — removes the faint
  ringing artefacts around letters.
- **High-zoom cap raised** (2600 → 3500px long side) so 200–300% zoom stays
  crisp instead of going soft.

Battery/memory note: only visible pages are ever rasterised (lazy rendering +
content-visibility), so the extra pixels cost little in practice. Scan output
and compression qualities are unchanged — this is purely the reading view.

### Page indicator
- While scrolling a multi-page document, a small "Page 3 of 12" pill fades in
  at the bottom and fades out when you stop. No buttons, no setup; honours
  reduced-motion settings.

### Tests
- 42 integration + 4 guard + 5 detection + 21 scenario = 72 checks, all passing
  (two new: pill appears on scroll, pill fades after scrolling stops).

## [v10.5] — 2026-06-12 — Hardening release (scenario campaign)

A 21-scenario abuse campaign was run against the app (corrupt/zero-byte/fake
files, password PDFs, double-taps, guards, unicode, huge documents, extreme
zoom). Two real bugs were found and fixed:

- **Double-tap "Use page" duplicated the scanned page**: tapping again while
  the page was still processing added it twice. A re-entrancy guard now ensures
  one capture = one page.
- **A non-PDF file renamed to .pdf could half-open and break the app**: MuPDF
  opens HTML through its own handler, leaving the editor with no usable
  document while the buttons stayed enabled. The file probe now rejects
  anything that isn't a real PDF (and zero-page files) BEFORE the currently
  open document is touched — a failed open can no longer lose your place.

Verified intact by the campaign (no changes needed): friendly errors and
recovery after corrupt files, delete-every-page guard, unicode text edits,
filename sanitisation, password unlock + never-persist rule, undo on empty,
merge with a corrupt file leaves the original untouched, zoom clamps,
rotated-page warning, signature placement, and 40-page open/Pages/compress
responsiveness.

The campaign is now part of the test suite (tests/scenario-tests.mjs).
Total: 40 integration + 4 guard + 5 detection + 21 scenario = 70 checks.

## [v10.4] — 2026-06-11 — Unsaved-changes protection

- The app now tracks whether the open document has changes that haven't been
  Saved (any edit, sign, page change, combine or compress marks it; Save
  clears it).
- Before any action that would **replace or close** the document — Open,
  Photos → PDF, Create PDF from a scan, Close — a sheet asks first:
  **Save first / Continue without saving / Cancel**. "Save first" opens the
  normal Save dialog.
- Non-destructive actions (Save, Copy pages, page → picture, starting a scan,
  edits themselves) never nag.
- The unsaved state survives the app being killed: it is stored with the
  auto-saved session, so a restored document still warns before being replaced.
- Tests: 40 integration + 4 guard + 5 detection checks, all passing — including
  four new checks (warns when dirty, Cancel preserves, Continue proceeds,
  silent after Save).

## [v10.3] — 2026-06-11 — Touch + long-document speed

### Pinch to zoom (finally feels native)
- **Pinch anywhere on the pages**: they scale instantly under your fingers
  (pure CSS transform, 60fps, zero engine work), and the moment you let go they
  re-render sharp at the new zoom — anchored at the pinch centre, so the spot
  between your fingers stays put. Range 50–300%.
- **Double-tap** toggles 100% ↔ 200%, centred on the tap.
- The − / + buttons remain and now also keep the view centred when zooming.
- Browser page-zoom is suppressed inside the viewer (touch-action), so a pinch
  always zooms the document, never the app shell.

### Long documents stay fast
- Page thumbnails are rasterised once per document version and cached, and the
  Pages / Copy-pages sheets load them lazily as you scroll. Opening Pages on a
  100-page PDF is instant instead of a multi-second freeze, and every
  rotate/delete/reorder tap redraws with no engine work.

### Tests
- 36 integration + 4 guard + 5 detection checks, all passing — including new
  checks for anchored zoom re-rendering and lazy cached thumbnails.

## [v10.2] — 2026-06-11 — Robustness + two small features

### Scanner sees better (no UI change)
- **Detection rewritten and stricter**: every sizeable region is considered (not
  just the largest), and a candidate must truly look like a document — convex,
  real side lengths, well filled, its outline following the region's actual
  boundary. Doors, walls, and L-shaped regions are rejected instead of being
  outlined in green.
- **White-on-white now works**: when the paper is the same tone as the desk, a
  gradient (Sobel) fallback finds the boundary/shadow line instead.
- New fixture tests (tests/detect-tests.mjs): classic page ≤1px, same-tone
  paper via shadow line ≤1px, L-shape rejected, blank/wall frames rejected.

### Lighter on memory (no UI change)
- Undo history is capped by total size (120MB) as well as steps — huge PDFs can
  no longer pile up ten full copies in memory.
- Scan sessions persist incrementally: adding page 12 writes one page to
  storage, not all twelve again. Old saved sessions still restore.

### Accessibility
- VoiceOver labels on all icon-only controls (zoom, rotate, move, corners,
  torch, thumbnails) and the status bar is now a live region, so feedback is
  announced.

### New
- **Copy pages → new PDF** (More menu): pick pages with thumbnails; they are
  copied into a brand-new file, the open document is untouched.
- **Standard / Small file** quality choice on the scan crop screen (remembered):
  Small produces noticeably lighter PDFs for multi-page scans.

### Tests
- 34 integration + 4 guard + 5 detection checks, all passing.

## [v10.1] — 2026-06-11 — Naming + reverts

- App is now called **PyPDF** everywhere (Home-Screen name, title, header,
  welcome screen, About).
- **"Make smaller" reverted to "Compress"** (button and messages).
- **Pages reorder reverted to ↑ ↓ buttons** (drag handle removed); rotate ⟳,
  Delete and the per-page badges stay.
- All 32 integration + 8 guard/security tests pass.

## [v10] — 2026-06-11 — Simplicity release

Top priority this release: anyone, including a child, can use the app. Total
size added: ~9KB. No new libraries. Still three screens.

### Easier for everyone
- **Welcome screen**: instead of an empty dark page, two big buttons —
  "📄 Open a PDF" and "📷 Scan a document" — plus "Everything stays on your
  phone — nothing is uploaded."
- **Plain words everywhere**: "Compress" → "Make smaller", "Organise pages" →
  "Pages", "Merge" → "Combine", no more "engine" or technical jargon in any
  message. Errors speak human: "This file appears damaged, or isn't really a
  PDF" instead of raw engine output (raw text still goes to the About log).
- **Save made obvious**: Save opens a small sheet with a name box (rename your
  PDF at last) and one line explaining what happens next.
- Success/error messages are bolder so feedback is hard to miss.

### Pages & scanning
- **Drag to reorder**: hold ≡ and drag a page up or down in the Pages sheet
  (replaces the ↑ ↓ buttons — one obvious gesture instead of three buttons
  per row; rotate ⟳ and Delete stay).
- **Magnifier loupe** while dragging crop corners — see exactly which pixel
  the corner sits on, CamScanner-style.
- Crop filter preview now runs at reduced resolution: filter switching is ~4×
  faster with no visible difference (final quality unchanged).
- "Make smaller" shows per-page progress and no longer freezes the app on
  very long documents.
- Editing text on a rotated page now warns first (edits assume upright pages).

### Under the hood
- **Structural XSS safety**: every dialog is built with an auto-escaping
  template (h\`\`) — interpolated values are escaped by default rather than
  relying on per-call-site discipline. Verified by new tests (V6/V7) including
  a malicious-filename injection attempt.
- About now shows the MuPDF AGPL-3.0 licence with a source link.
- Host security headers (COOP/COEP/nosniff) are NOT possible on GitHub Pages —
  documented; revisit only on a host change.
- Tests: 32 integration + 8 negative/security checks, all passing.

## [v9.3] — 2026-06-11 — Error-banner fix + diagnostics

- **"Unexpected error: Script error." banner fixed.** Root cause: if
  `scan-worker.js` is missing from a deploy (it's new in v9), the host returns
  an HTML 404 page, the Worker fails parsing it, and the failure leaked to the
  global error handler as a sanitised "Script error." Scanning kept working via
  the main-thread fallback, but the banner appeared. Worker load/runtime errors
  are now absorbed (`preventDefault`) and silently switch to the fallback.
- **Better diagnostics**: unexpected errors now include file:line where
  available, and the last 3 are kept on-device and shown in **More → About →
  Recent errors** — so any future report can say exactly what failed and where.
- The live camera-preview loop is hardened: one bad frame can no longer kill
  the loop or leak an error.
- DEPLOY.md now includes a direct-URL check that `scan-worker.js` is actually
  live on the host.
- Tests: 31 integration + 5 negative checks all pass, including a new test
  that a worker load failure is absorbed and flips to the fallback.

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
