# Changelog — PyPDF Editor (iPhone PWA)

All notable changes to the on-device iPhone PWA. The "version" tag matches the
service-worker cache name (`CACHE` in `sw.js`); bumping it forces phones to fetch
the new build.

## [v10.31] — 2026-06-20 — Fixes: page jump, scan rotate, live rotate preview

Three reported issues fixed. No other behaviour changed; all checks pass.

- **Go to page no longer hides the toolbar.** Jumping to a deep page (e.g. 500
  of 524) used `element.scrollIntoView`, which on iOS bubbled up and scrolled the
  whole app, pushing the header + toolbar off screen — so you couldn't get back
  to page 1. It now scrolls the viewer itself, so the toolbar always stays put.
- **Rotate a scan before saving.** The scanner's Adjust-edges screen has a new
  "⟳ Rotate" button that turns a sideways capture a quarter-turn (re-detecting
  the edges), so a scan that came out on its side can be made upright before it
  becomes a PDF page.
- **Live rotation preview in Pages.** Rotating a page in More → Pages now turns
  its thumbnail immediately, instead of only showing the change after Apply. The
  list thumbnails are now a fixed square so a rotated preview stays neatly inside
  its row.

## [v10.30] — 2026-06-20 — Phase 3: accessibility, navigation & polish

Larger UX / accessibility items from the review, plus the remaining polish. No
feature removed or changed in behaviour except where noted. All checks pass.

Accessibility:

- **Text edits are keyboard / VoiceOver reachable.** The tappable text boxes in
  Edit mode are now real buttons: Tab to one and press Enter or Space to edit it
  (the focus ring was already styled for this).
- **Crop corners are keyboard adjustable.** On the scanner's Adjust-edges screen
  you can Tab to a corner and nudge it with the arrow keys (Shift = bigger steps),
  not only drag it.

Navigation:

- **Go to page.** Long documents get a "Go to page…" item in More (multi-page
  only) that scrolls straight to a page, instead of relying on scrolling and the
  transient page pill.
- **Zoom hint matches the device.** On phones (where the − / + buttons are
  hidden) the open message now says "Pinch or double-tap to zoom" instead of
  pointing at buttons that aren't there.

Quality & performance:

- **Live scanner edge detection moved off the main thread.** The detector
  (`detectQuad` and helpers) now lives in `scan-core.js`, shared by the app and
  the scan worker, so the 300 ms live-preview detection runs in the worker. It
  falls back to the original synchronous path if the worker is unavailable, and
  the one-shot still-capture detection is unchanged.
- **Compress wording is honest about targets.** The size labels now say "aim
  for ~1 MB" etc. and the sheet explains a text PDF may stay larger and an
  already-small file is left unchanged.
- **"Save this page as a picture" picks the centred page**, matching the page
  pill, so a partly-scrolled tall page isn't mistaken for its neighbour.
- **Sharper list thumbnails** (Pages / Copy-pages): JPEG quality raised from 70
  to 82.
- **Error log no longer keeps document names.** Messages written to the on-device
  error log are scrubbed of the open file's name and other filename-looking
  tokens.

## [v10.29] — 2026-06-20 — Reviewer fixes: reliability, scanner & polish

Two passes of fixes from an external code review. No feature removed; behaviour
only changes on previously-broken edge cases. All 105 checks pass.

Phase 1:

- **Compress never grows the file.** An already-optimised PDF could come back a
  few bytes larger from the lossless structural pass; the app used to commit
  that, growing the document, marking it dirty, adding a pointless undo step and
  reporting a negative "% smaller". It now leaves the document untouched and
  says it's already as small as it usefully gets.
- **Copy-pages and Save-page-as-picture now use the iOS share sheet.** Both used
  a synthetic `<a download>` click, which frequently does nothing in a
  standalone Home-Screen PWA. They now go through the same Web Share path as
  Save (with a download fallback), so the file actually reaches Files/AirDrop.
- **Scanned-page preview no longer leaks a blob URL** when dismissed by tapping
  the backdrop instead of Close.

Phase 2:

- **Engine-load watchdog.** `app.js` is a module that loads the MuPDF WASM
  engine; if that import never resolves (partial cache, failed download) the
  module body never runs and the UI used to sit on "Loading engine…" forever.
  A tiny classic `engine-watchdog.js` now arms a timer before the module and,
  if the engine hasn't signalled ready in 20 s, shows a tap-to-reload message.
  It cancels silently on normal start. Added to the precache.
- **Unencodable-character notice.** When replacement text contains glyphs the
  base-14 fonts can't draw (shown as "?"), the status line now says so instead
  of substituting silently.
- **Signature on a rotated page now warns first**, matching the existing
  text-edit guard (placement assumes an upright page).
- **Removed dead code.** The unreachable `signRemoveWhite` / `knockoutWhite`
  background-knockout branch (never wired to any control) was deleted; signatures
  are placed as-is, exactly as before.
- **About → engine source** opens in the real browser (`target="_blank"`)
  instead of navigating the installed app away with no way back.

## [v10.28] — 2026-06-19 — New dark-theme app icon

- **New icon.** Replaced the red square icon with a dark, OLED-black icon that
  matches the app's dark UI: a dark "glass" document with a soft red glow and
  red "PDF" wordmark. Full-bleed (no transparent corners) so iOS masks it
  cleanly. Regenerated at 180 / 192 / 512 px; cache bumped so installed Home
  Screen apps refetch the new artwork.

## [v10.27] — 2026-06-19 — Audit fixes: signatures, undo/dirty, save & tests

Fixes for five issues from the latest code audit. No feature removed.

- **Sign now always asks for a signature image.** Tapping "Add my signature"
  opens the image picker every time instead of silently reusing the previously
  loaded signature. The signature is placed as-is with its background kept (the
  long-standing default); the docs were corrected to match.
- **Undo no longer leaves a false "unsaved changes" flag.** Each undo step now
  remembers the dirty state at the time, so undoing back to the originally
  opened document restores a clean (not-dirty) state.
- **Merge validates inputs before mutating.** All source PDFs are parsed first;
  a corrupt input now aborts cleanly without marking the document dirty or
  leaving a bogus undo step.
- **Save uses the real iOS share sheet.** Save now uses the Web Share API
  (Save to Files / AirDrop / Mail…) with a download fallback, and **"Save
  first"** in the unsaved-changes dialog now continues the original action.
- **Tooling & deploy hygiene.** `tests/version-tests.mjs` works from a path
  containing spaces (e.g. "PY EDITOR SCAN"); `.gitignore` now also excludes
  `tests/` and `node_modules/`.

## [v10.26] — 2026-06-16 — Audit polish: shared scanner core, a11y & quality nits

The "polish" set from the v10.24 audit. Behaviour is unchanged for users except
the noted improvements; 105 checks pass.

- **Scanner pixel math now lives in one file.** The perspective-warp and colour
  filter code was previously copied verbatim into both app.js and scan-worker.js
  and kept in sync by source-identity tests. It now lives once in `scan-core.js`,
  imported by app.js (for the main-thread fallback and crop preview) and by the
  scan worker (now a **module worker**). If module workers are unavailable the
  app silently falls back to main-thread processing, exactly as before. The
  colour parity tests are replaced by behavioural + single-source checks.
- **Photos → PDF uses sensible page sizes.** Imported photos are now scaled to
  A4-ish point dimensions (long side 842pt) like the scanner, instead of
  1px-per-point (which made a phone photo a ~55-inch page).
- **Accessibility polish.** Visible keyboard focus rings (`:focus-visible`) for
  buttons, links, inputs and the editable-text spans; page-row controls (↑ ↓ ⟳
  Delete) enlarged to a 44px touch height.
- **Performance nits.** The "save this page as a picture" page-picker reads the
  viewer rect once instead of once per page; the live document detector reuses
  its big scratch buffers across the 300ms preview frames instead of
  re-allocating them every tick.
- **New file:** `scan-core.js` (added to the service-worker app-shell cache and
  the deploy checklist).
- Tests: 58 integration + 4 guard + 5 detection + 23 scenario + 8 colour +
  7 version = 105 checks, all passing.

## [v10.25] — 2026-06-16 — Audit fixes: no password hang, text-safe compress, a11y

Acted on the priority findings from the v10.24 full-app audit. No existing
feature behaviour changed except where noted; 105 checks pass (was 90).

- **Password sheet no longer hangs the Open flow.** Tapping outside the password
  prompt (or pressing Esc) used to dismiss it without resolving, leaving the open
  in limbo. Sheets now register a dismiss handler that `closeSheet()` fires, so a
  backdrop/Esc dismiss cleanly cancels ("Open cancelled"). New tests S12c/S12d.
- **Compress protects real text.** When the lossless pass misses the target on a
  document that contains actual text, the app now asks before rasterising —
  Keep text (text-safe lossless result), Make smallest (pictures), or Cancel —
  instead of silently turning selectable/searchable text into images. Scanned /
  image-only PDFs still compress straight through. New tests T38, T39a–e.
- **Lower peak memory on heavy ops.** Compress now runs the lossless pass and
  decides BEFORE taking the Undo snapshot, and both Compress and Merge skip the
  full-document Undo copy above 48 MB (the original is still in Files), telling
  you when a step can't be undone. Reduces OOM risk on large files (iOS).
- **Accessibility.** Bottom sheets are now exposed as `role="dialog"
  aria-modal="true"`, labelled from their heading, with focus moved in on open
  and restored on close, and Esc closes them. Status-bar text 9px → 11px for
  legibility (reclaims slightly less page height; worth it).
- **Release hygiene.** `APP_VERSION` and the About cache label now derive from a
  single `APP_BUILD` constant (no more drifting literals). DEPLOY.md no longer
  hard-codes a stale build number. New `tests/version-tests.mjs` enforces that
  `data-build` (index.html), `APP_BUILD` (app.js) and `APP_CACHE` (sw.js) agree.
- Tests: 58 integration + 4 guard + 5 detection + 23 scenario + 8 colour +
  7 version = 105 checks, all passing.

## [v10.24] — 2026-06-15 — Full-app review: leak fix, faster zoom, sharper view

From a full read-through of the codebase. Three safe improvements; no feature
behaviour changed.

- **Storage leak fixed.** Discarding a restorable session (or undoing to empty)
  deleted the `doc`/`scan` index records but left the individual scanned-page
  blobs (`scan:p0…pN`) orphaned in IndexedDB forever. New `dropScanStorage()`
  removes every per-page key, and restoring a scan now tracks its existing keys
  so a later clear is complete. New test T32 covers it.
- **IndexedDB connection reused.** Persisting the document or each scan page used
  to open and close a fresh DB connection every time; it now reuses one cached
  handle (the standard pattern), removing churn during scanning and editing.
- **Zoom is faster on long PDFs.** Zoom/width changes now resize the existing
  page nodes in place instead of rebuilding every one (O(n) DOM work — 525 nodes
  on a big book per zoom tap). The lazy-render observer re-rasterises the visible
  pages at the new scale. Content edits still do a full rebuild (they bump the
  document epoch), so nothing stale survives.
- **Reading view a touch sharper.** On-screen page render JPEG 92→94 (display
  only — saved and exported files are unchanged).
- Verified text-edit colour handling is correct (MuPDF returns normalised RGB).
- Tests: 52 integration + 4 guard + 5 detection + 21 scenario + 8 colour = 90
  checks, all passing.

## [v10.23] — 2026-06-15 — Status banner trimmed further (9px)

- Status banner font 11→9px with tighter padding (top 2px, bottom 1px + the
  home-indicator safe area). Reclaims ~12px of page height versus v10.22's
  11px. Confirmed against an on-screen mock before applying. CSS-only
  (`.status`); 89 checks still pass. (9px is the practical floor — still legible
  on a 3× iPhone screen.)

## [v10.22] — 2026-06-15 — Slimmer status banner (more page on screen)

- The bottom status banner is trimmed to give the page more room: font 12→11px,
  top padding 9→4px, bottom padding 6→2px (plus the home-indicator safe area,
  which stays so the text never hides under the indicator), and the 16px
  min-height removed. Reclaims ~12px of vertical space for the document view.
  CSS-only (`.status`) — no behaviour or layout logic changed; all 89 checks
  still pass.

## [v10.21] — 2026-06-13 — Sticky sheet buttons + higher export/scan quality

### Pages / Copy pages / Combine — Apply & Cancel always visible
- On long documents the Apply/Cancel (and "Save as new PDF" / "Combine")
  buttons used to sit at the very bottom of the list, so a 500-page PDF meant
  scrolling forever to reach them. They now sit in a **sticky footer** pinned
  to the bottom of the sheet — the page list scrolls behind them, the actions
  are always on screen. CSS + markup only; all button IDs unchanged.

### Quality (analysed first; capture kept at 2.5K per request)
- **PDF → picture (PNG)** now renders at ~400 dpi (was ~300) for crisper text,
  with the long side capped at 4096px so huge/image-sized pages can't exhaust
  memory. (The embedded scan is the real ceiling — rendering past it only
  upsamples, so the cap also avoids needless bloat.)
- **Scan Standard** JPEG quality 0.92 → 0.95 (less compression loss; small size
  increase). "Small file" unchanged.
- **Viewer** page render JPEG 90 → 92 — slightly crisper on-screen text.
- **Image → PDF** was already lossless (it embeds your original JPEG/PNG bytes
  at full resolution) — left unchanged.
- Camera capture stays at 2560×1440 by choice. Note for later: that is the
  detail ceiling for camera scans; raising it to 4K is the only way to push
  scan/PNG sharpness further, and 4K does not cause the old darkness (that was
  the removed pipeline).

### Tests
- 51 integration + 4 guard + 5 detection + 21 scenario + 8 colour = 89 checks,
  all passing. `guard-tests.mjs` is now path-portable.

## [v10.20] — 2026-06-13 — Scanner trimmed + brighter, crisper colour

From device feedback on a real scan. Scoped entirely to the scanner.

### Removed (as requested)
- **Black & white mode** is gone — the scanner is colour-only. The B&W button,
  its filter code, and `applyDocBW` are removed from `app.js` and the worker.
- **Photos** and **Auto** buttons removed from the camera bar (and the
  auto-capture logic). **Torch stays.** The native-camera fallback (used only
  when the live camera can't start) is unaffected.

### Colour quality (brightness + crispness)
- New gentle `crispenAndLift` step after white balance: a 1px luminance unsharp
  mask to sharpen letters and a small midtone brightness gain so the captured
  still (which iOS often grabs darker/softer than the live preview) reads bright
  and sharp. Deliberately mild — NOT the v10.14 magic-scan that caused halos.
  Measured on a text capture: edge sharpness +65%, brightness +5, no wash-out.
  Identical in worker and main thread (parity test-enforced).
- **Standard output raised** to max 2560px / JPEG 0.92 (was 2000 / 0.85) for
  sharper letters. "Small file" unchanged.
- Re: the earlier 2.5K→4K question — capture was already reverted to 2560×1440
  back in v10.16, so 4K is NOT in this build and is not the cause of dark/soft
  scans. The real levers are a tight crop and the new sharpening, both addressed.

### Detection
- Edge detection now runs at higher working resolution (live 220→300px,
  captured still 300→520px) for finer, more reliable edges on low-contrast
  documents (e.g. a white envelope on a pale desk). Thresholds unchanged — the
  past threshold-loosening (v10.15) proved unhelpful and was reverted.
- Reminder: detection is for flat documents; a tight crop is what makes letters
  sharp (more pixels land on the page). If it ever misses, the corners are
  draggable.

### Tests
- `tests/colour-tests.mjs` updated (white balance ×3, crispen+lift ×2, parity
  ×3); harness B&W step replaced with a quality-toggle check; `guard-tests.mjs`
  made path-portable and its mismatch simulation no longer depends on removed
  elements. Suite: 51 integration + 4 guard + 5 detection + 21 scenario + 8
  colour = 89 checks, all passing.

## [v10.19] — 2026-06-13 — Colour white balance back + softened B&W

Two scoped scanner fixes from device screenshots. Nothing outside the scanner
was touched.

### Colour
- The gentle global white balance (`colourBalanceCore`, first shipped v10.17)
  is back on the Colour path: grey-world over the bright paper region lifts each
  channel to neutral, removing the warm/yellow indoor cast, then the unchanged
  gentle contrast stretch deepens text. Global per-channel gain (capped 2.2×),
  so it can't blotch; no sharpening, so no halos.

### Black & white
- **B&W no longer blows out.** The old filter was a hard adaptive binariser:
  on a flat text page it gives the clean scanned look, but on a 3-D or imperfect
  capture (a shelf, a wall, an object) it forced everything bright to pure white
  and everything else to black smears — an almost-blank result. It now blends
  the crisp adaptive binary with a little of the real grayscale (≈0.72 / 0.28,
  integer weights summing to 256), so flat text pages stay clean (paper light,
  text dark) while non-flat scenes keep their tonal structure instead of
  collapsing to a white void. The hard clip was also relaxed (215/40 → 238/22).
  Proven on fixtures: a flat text page still reads paper≈248 / text≈15, and a
  gradient-wall + object scene now retains ~90 tonal levels instead of ~2.

### Parity / tests
- Worker and main-thread copies verified identical: `applyAutoContrast` and
  `colourBalanceCore` are source-identical, and `applyDocBW` (which differs only
  by call signature) produces byte-identical output across the two.
- `tests/colour-tests.mjs` now covers white balance (3), B&W softening (2), and
  parity (3). Suite total: 51 integration + 4 guard + 5 detection + 21 scenario
  + 8 colour = 89 checks, all passing.

## [v10.18] — 2026-06-13 — Scanner reverted to the v10.12 pipeline

Per request, the scanner is rolled back to the v10.12 version. The colour
scan code (capture settings, edge detection, perspective warp, and the plain
2nd–98th percentile auto-contrast filter) is byte-for-byte the v10.9–v10.13
scanner — which IS the v10.12 scanner, since v10.10–v10.12 were toolbar-only
releases that never touched scan code (verified by diffing the backups).

- The v10.17 white-balance step (`colourBalanceCore`) is removed from both
  `app.js` and `scan-worker.js`. Colour scans use the plain auto-contrast
  filter again, exactly as in v10.12.
- `app.js` and `scan-worker.js` now match the v10.13 backup byte-for-byte
  (apart from the version tag). Nothing else was touched: the toolbar, themes,
  reading view, compress, merge, organise, save/close and every other feature
  are exactly as they were.
- `tests/colour-tests.mjs` updated to match: it now verifies the plain
  pipeline's worker/main-thread byte parity, that auto-contrast stretches the
  tonal range, and that the white-balance code is fully gone.
- Tests: 51 integration + 4 guard + 5 detection + 21 scenario + 3 colour = 84
  checks, all passing.

## [v10.17] — 2026-06-13 — Clean-scan white balance (cast fix, done safely)

Builds on the v10.16 revert. The restored original pipeline was neutral but had
no white balance, so warm/indoor-lit pages came out pale and yellow. This adds
white balance back — but global and conservative, explicitly avoiding what made
v10.14 fail.

- **Global grey-world white balance over the paper.** The paper is the bright
  majority of a document, so the colour of all pixels above the 60th-percentile
  luminance is averaged (the estimated paper/light colour) and each channel is
  scaled so that average lands on a neutral 245. Because it is area-averaged, a
  small neutral element — a plastic address window, a white label — can't skew
  it, and the warm cast on the paper is removed. One gain per channel for the
  whole image (gain capped at 2.2×), so it physically cannot create the local
  dark blotches v10.14 did. No unsharp mask, so no harsh halos.
- Then the unchanged gentle 2nd–98th percentile luminance stretch deepens text.
- Worker and main-thread copies are byte-identical (parity test-enforced).
- New `tests/colour-tests.mjs`: a warm page (235/212/172) comes out neutral
  white with dark ink; a neutral page stays neutral and is not darkened; a dim
  page brightens (never darkens — the v10.14 failure mode); plus the two parity
  checks. Proven visually on a synthetic warm, unevenly-lit page: cast roughly
  halved on a deliberately pessimistic fixture, no dark patches anywhere.
- Tests: 51 integration + 4 guard + 5 detection + 21 scenario + 5 colour = 86
  checks, all passing.

## [v10.16] — 2026-06-13 — Scanner reverted to v10.13 (drop "magic scan")

Reverts the scanner to the last known-good build (v10.13). On real device
photos the v10.14 "magic scan" colour pipeline produced a dark/odd colour
cast and an over-processed look, and the v10.14/v10.15 detection and
capture-resolution changes did not reliably help edge detection. Per
request, the whole scan feature is rolled back rather than patched further.

- **Colour pipeline restored** to the simple 2%-percentile auto-contrast
  stretch (`applyAutoContrast`) in both `app.js` and `scan-worker.js`. The
  per-channel shadow-lift gain + contrast stretch + unsharp mask that caused
  the cast is gone. Clean, neutral scans again.
- **Edge-detection thresholds restored** to v10.13 (frame-cover 0.92, fill
  0.85, min size 0.12, outline coverage 0.80). If a page that fills the
  whole frame isn't auto-outlined, the crop screen still lets you drag the
  four corners by hand.
- **Capture settings restored**: camera 2560×1440 (was 4K), Standard output
  max 2000px / JPEG 0.85, photo-import downscale 2600px.
- Only the scanner reverted. The v10.14–v10.15 toolbar polish (segmented
  buttons, bigger targets, red ✕) and all other features are untouched.
- Tests: 51 integration + 4 guard + 5 detection + 21 scenario = 81 checks,
  all passing. (The v10.15 D6 "page fills 95% of frame" detection fixture is
  removed with the threshold revert.)

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
