# Changelog — PyPDF Editor (iPhone PWA)

All notable changes to the on-device iPhone PWA. The "version" tag matches the
service-worker cache name (`CACHE` in `sw.js`); bumping it forces phones to fetch
the new build.

## [v11.48] — 2026-07-27 — Phase 6: OCR — scanned PDFs become searchable

The last roadmap phase, and the biggest Acrobat paid feature left: recognise
the text in a scanned document so Find, Select and copy work — in this app
and in every other PDF viewer the file is opened in.

- **More → Recognise text.** Pages that carry no real text are rendered at up
  to 300 dpi and read by an on-device Tesseract 5 (LSTM) engine — vendored
  like the PDF engine, downloaded once (~17 MB), cached in VENDOR_CACHE for
  offline use, never touching any server. Each recognised word is laid over
  the page image as INVISIBLE real text (opacity 0) at its exact position —
  Acrobat's "searchable PDF". Born-digital pages are skipped, low-confidence
  junk (<40) is dropped rather than embedded, the undo snapshot is only taken
  once words were actually found, and the worker is terminated afterwards to
  release its WASM heap. English first; other languages are a data file away.
- Honesty note kept from the roadmap: Adobe's OCR engine is proprietary and
  cannot be used or rebuilt. Tesseract is what every serious non-Adobe tool
  ships. Measured on a 200 dpi scan of the invoice seed: **95% confidence,
  100/100 words** — capture quality (v11.41) matters more than the engine.
- sw.js: `.gz` joined the cacheable types so the language data self-caches.

New suite: ocr-tests (15) — the full loop against the VENDORED wasm and
language data: render a real scanned fixture (zero extractable chars), OCR it,
place the invisible layer with the shipped `ocrWordPlacement`, then prove via
MuPDF that the text extracts, `search()` finds it at its position, and the
page renders pixel-identical (diff 0.000). All thirteen suites green.

## [v11.47] — 2026-07-27 — Phase 5: fill real forms (AcroForm)

The feature that most often sends people back to Acrobat. Until now a
fillable form could only be drawn on top of; this fills the ACTUAL fields, so
the values are readable by Acrobat, Preview and whatever system the form is
submitted to.

- **Form** joins the Markup tools. It finds every fillable field and overlays
  a dashed tap target on it: a text field opens a keyboard sheet, a checkbox
  toggles with one tap (no sheet — like a real form), radio groups and
  dropdowns list their options. Values are written through pdf-lib's form API
  and appearances are regenerated with an embedded font, so the filled value
  is visible in every viewer, not only ones that honour NeedAppearances.
  A document with no fields says so and points at Edit text / Sign instead.
  Buttons and signature fields are explained as not fillable here.
- **More → Flatten form** bakes every value into permanent page content and
  removes the fields — a separate, confirmed action (never a side effect),
  reversible with Undo while the document is open.
- Field TYPE detection is by capability (duck typing) because the vendored
  pdf-lib is minified — constructor names are meaningless. That detector is
  sliced from the shipped app.js and pinned by tests.

New suite: form-tests (14) — generates a real form at test time, classifies,
fills, flattens, and verifies through MuPDF (a different engine) that the
flattened text is extractable and the filled file parses cleanly. A
`SEED-form.pdf` joined the corpus; its compressed output passes qpdf.

## [v11.46] — 2026-07-27 — Phase 4: compress to a target size

The iLovePDF move people actually make — "get it under 2 MB for the portal" —
plus font subsetting, plus a real result report.

- **Reach a size…** in the Compress sheet: presets (10/5/2/1 MB) or a typed
  limit. The search runs over the machinery that already exists, most-careful
  first: lossless clean-up, then per-image recompression at 200 → 150 → 110 dpi,
  **stopping at the first setting that fits** so quality is never given up
  without need. Rasterising stays the last resort and still asks first when
  the document has real text. Never-grow and undo guarantees unchanged. A
  target the file already meets is reported honestly, not "compressed".
- **Result report**: a before/after sheet — sizes, whether the limit was met,
  what changed, and whether text is still selectable. When the limit is not
  reachable, it says so and suggests deleting unneeded pages instead of
  pretending.
- **Font subsetting** (`subset-fonts`) joined every compress save path:
  embedded fonts are trimmed to the glyphs actually used. Verified a no-op on
  already-subset fonts (byte-identical) and text-preserving via MuPDF
  round-trip; a new `SEED-embedfont.pdf` (full DejaVu TTF) keeps it honest in
  the corpus, where output passes qpdf's structural check.

Tests: compress-tests 67 → 76. All eleven suites green; corpus 35/35 + 12/12
external.

## [v11.45] — 2026-07-27 — Phase 3: remove restrictions, not just passwords

A PDF can be locked WITHOUT a password: encrypted with an owner password
only, it opens with no prompt but forbids editing, printing and copying —
bank and telco invoices are the classic case, and removing these locks is an
Acrobat paid feature. `needsPassword()` is false for such files, so until now
"Unlock a PDF" told their owners there was "nothing to remove".

- **Unlock a PDF** now detects owner-locked files via the encryption metadata
  and removes the locks losslessly (MuPDF `decrypt` save: no image
  re-compression, original quality and size), opening the result as
  `name_unlocked.pdf`, marked unsaved.
- **Opening** such a file directly (which already auto-decrypted the working
  copy since v11.11-era plumbing) now SAYS so: "it had editing/printing
  restrictions (no password), and this working copy has them removed."
- A file with no password AND no restrictions gets the accurate message.

New suite: unlock-tests (11) — generates an owner-locked fixture at test time
with the shipped MuPDF (AES-128, permissions -3904), then proves it opens
passwordless, decrypts to `encryption: None`, keeps its content, and is freely
editable afterwards. A matching `SEED-ownerlocked.pdf` joined the corpus.

**The corpus caught its first real bug within minutes of that seed landing:**
the in-app self-test (and the corpus C4 check) fed still-encrypted bytes
straight to pdf-lib, which corrupts owner-locked files on save — the exact
historical failure the open path's decrypt exists to prevent. Both harnesses
now mirror the app's open path (decrypt first), which is the correct model of
what the app really does. Working exactly as designed.

## [v11.44] — 2026-07-27 — Phase 2: duplicate pages, insert blank

Page organisation, completed. Reorder, rotate, delete, Combine and
copy-to-new-PDF (extract/split) already existed; the two missing everyday
moves land in All pages → Select:

- **Duplicate** copies every selected page in place, each copy directly after
  its original. Uses the same `graftPage` primitive as Combine, from a copy of
  the document into the live one, so fonts and images carry across intact —
  never re-rasterised. Grafts run in reverse index order so insertion points
  stay valid.
- **+ Blank** inserts an empty page after the single selected page, matching
  that page's size, so an A4 document stays all-A4. (Enabled only with exactly
  one page selected — an insertion point has to be unambiguous.)

Both are one Undo away from reversal. Tests: editor-tests 56 → 65, including
an end-to-end that duplicates and inserts with the same primitives and reads
the result back through MuPDF (copy carries content; blank is empty and
size-matched; following pages intact).

## [v11.43] — 2026-07-27 — Phase 1: add text anywhere, whiteout, place pictures

The Acrobat edit gap, closed for the everyday cases. All three tools ride on
plumbing that already existed, which is what keeps this release small enough
to trust.

- **Add new text.** In Edit text mode, tapping EMPTY page space opens an
  "Add text" sheet: multi-line text, size (default 12pt), colour and typeface
  (the same controls the editor uses), placed with its first line just under
  the tap. Inserted with pdf-lib exactly like an edit's replacement text, so
  Save, Undo and Compress treat it identically. Taps on existing text still
  edit that text — the span buttons capture their own clicks.
- **Whiteout.** New Markup tool: drag a box, it is painted opaque white.
  Deliberately a COVER, not a removal, and the status message says so plainly
  (text underneath is still selectable). True redaction is a separate future
  feature so the two are never confused.
- **Place a picture.** New Markup tool: pick from Photos, drag a box, done —
  the exact placement flow signatures use (aspect preserved, fitted inside the
  box), with the image capped at 2000px. The status and confirmation say
  "Picture", not "Signature".

Wiring: `mkMenu` gains Whiteout + Image buttons; both enable/disable with the
document like every other tool; the sign-mode overlay routes white-mode boxes
to `applyWhiteout`. Tests: editor-tests 46 → 56, including an end-to-end that
draws two lines the way `addNewText` does and reads their baselines back
through MuPDF (first line one em under the tap, second one leading below).

## [v11.42] — 2026-07-27 — Phase 0: real-document verification (corpus + self-test)

The first roadmap phase, and deliberately not a feature: the machinery to stop
"406 green assertions, broken on the first real document" from ever happening
again.

### corpus/ — real files as the test suite

`corpus/` now holds the documents the app must never break — meant for the
user's real invoices, statements, forms and scans (git-ignored; see
corpus/README.md). Seeded with four synthetic PDFs from three producers the
app itself does not use (reportlab, PIL, standalone pdf-lib), including an
Indexed-colourspace image, a near-bilevel 200 dpi scan, and 6-megapixel photos
drawn small. `npm run corpus` runs every file through open → render → text →
pdf-lib round-trip → redact-edit plumbing → per-image compression, then
re-validates every output with decoders that share no code with the app:
**qpdf** (`--check`, structural) and **Pillow/libtiff** (decodes every JPEG
and CCITT G4 stream and checks polarity). First run: 23/23 Node checks and
10/10 external checks green — the compressor's first-ever validation outside
MuPDF, including the from-scratch G4 encoder (881→152 KB on the scan seed,
4.9 MB→571 KB on the photo seed, zero text characters lost anywhere).

### In-app: About → "Run self-test on this document"

The same pipeline, runnable on the phone against the exact file that
misbehaves: parse, render page 1, extract text, pdf-lib save round-trip,
redaction edit on a copy, lossless compress — every step on a copy, touching
nothing (no undo entry, no dirty flag). Skips content steps on
password-protected files and refuses >60 MB files rather than risk the tab.
`selfTestCore` is pure (bytes in, results out) and `tests/selftest-tests.mjs`
slices it from the shipped app.js and runs it over the corpus in Node, so the
button and the desktop harness are provably the same code.

### Suite

New: selftest-tests (6). scan-tests unchanged (78). All eleven jobs green.
Phase 0 exit criterion: the corpus holds real user documents and stays green —
then Phase 1 (new text boxes, images, whiteout) begins.

## [v11.41] — 2026-07-27 — Sharper capture source + receipts keep their shape

Independent review of the v11.32–v11.40 session, prompted by "it broke my app"
with all three complaints (scan quality, viewing quality, text editing) still
reported. The v11.39 and v11.40 fixes were re-verified — v11.39 by line-by-line
review (paragraph mode is opt-in, table/label rows are refused, overflow asks
first), v11.40 by running the shipped `scan-core.js` against a simulated 4K
capture (still-frame detection at 520px measured 11.9px worst-corner error vs
25.6px for the live-quad path it replaced). Both fixes are sound. But the same
measurement exposed what v11.40 missed:

### 1. Scan sharpness has a hard ceiling, and the gate was under it

The app captures the getUserMedia VIDEO frame — 16:9, at most 3840×2160. A
portrait page in a landscape frame is bounded by the frame's SHORT side, so
even a page filling 85% of a 4K view warps to ~1830px ≈ **156 dpi on A4**. The
v11.40 resolution gate (1600px) passed that happily; the user's 183 dpi sample
was near the ceiling of the design, not below it. Two changes:

- **The camera now asks for the 4:3 sensor mode first** (4032×3024). iOS
  exposes the camera's native 4:3 formats through getUserMedia, and 3024px of
  frame height against 2160 is a 40% linear gain — an A4 page can now reach
  ~250 dpi instead of ~180. `ideal` constraints never reject, so a device
  without such a mode gets exactly what it got before; this cannot lose
  resolution, only gain it. (`ImageCapture.takePhoto()` — the real 12MP path —
  is still unshipped in iOS Safari as of June 2026 caniuse data, so a video
  frame remains the only capture source.)
- **`AUTO.MIN_LONG_PX` raised 1600 → 2400**, so the 0.75×short-side term is
  what binds on every current stream: auto capture now demands the best the
  frame can physically give rather than a number below the frame's floor.

### 2. "Viewing quality reduced" — reproduced, and fixed

Not a render-path change (renderStage and viewerCssWidth are byte-identical to
v11.31) — it is v11.33's paper snapping. A capture that is not paper-shaped (a
receipt, a part-page crop) was letterboxed into A4: a 1:2.4 till roll becomes a
337pt strip of image centred in a 595pt page. The viewer fits the PAGE to the
screen, so the same pixels drew ~30% smaller than v11.31, surrounded by white.
`fitToPaper` is now **aspect-gated at 20%**: paper-shaped captures still snap
(including the furthest legitimate case, an A4 sheet with Legal selected at
16.5% off), and anything further out keeps its own page size — exactly the
pre-v11.33 behaviour for exactly the shapes that behaviour suited.

### Tests

scan-tests: 72 → 78 (receipt/square keep their shape, A4-on-Legal still snaps,
the 4:3 constraint and raised gate are wired). All nine suites green. The
fixtures remain synthetic — the standing caveat from the handover applies: none
of this substitutes for a real document on a real iPhone.

## [v11.40] — 2026-07-27 — Fix: auto capture cut pages with the wrong outline

Reported with a sample scan: "scan quality also ruined than before". Measuring
the file rather than guessing found two defects, both introduced in v11.32, both
in auto capture. The submitted page came out **2142 x 1494px drawn at 841.9pt —
183 dpi** — with a visibly skewed crop.

### 1. Auto capture cropped using the live preview outline

`autoFire` warped straight from the smoothed live-preview quad. That quad is the
wrong thing to cut by, for two independent reasons:

- **It is detected at a 300px working size; the Adjust screen uses 520px.** On a
  4K frame that is a corner accuracy of about 12.8 source pixels against 7.4.
  Corner error does not blur a scan, it **shears** it: those four points define
  the homography the entire page is warped through, so a corner off by 13px
  tilts and stretches everything, worst at the far edge.
- **It is an exponential average of successive detections** (a = 0.35). It is
  designed to lag and to round corners, because its job is to stop the green
  outline flickering.

The live quad's job is to decide *when* to fire. Where to cut is a different
question, and it now gets the same answer the manual path gets: the edges are
**re-detected on the captured frame** through one shared `detectQuadOnFrame`
helper at the shared 520px working size. The smoothed quad survives only as a
fallback for when the still-frame detector finds nothing at all.

Measured on a synthetic page with a known quad, using the shipped detector:
**7.4px worst-corner error at 520px against 12.6px at 300px.** That is the test,
not an argument.

### 2. Auto capture fired on pages that were too far away

The gate required the page to cover 22% of the frame. A page filling a quarter
of a 4K frame warps to a long side of roughly 1900px — an A4 sheet at 160 dpi —
and nothing downstream can put that detail back. The submitted scan is exactly
this: the document occupied a little over half the frame, so it warped to 2142px
and landed at 183 dpi.

The gate now also requires the **warp's own long side** to reach 1600px, since
the output size is the quad's edge lengths. The ceiling is measured against the
frame's **short** side (`min(vw,vh) * 0.75`): a portrait page inside a landscape
video frame has its long side bounded by the frame's height, so a ceiling keyed
to the long side would work out at 98% of the frame height on 1080p and auto
capture would never fire at all. On 4K the 1600px target binds; on 720p the
frame does. The refusal surfaces as "Move closer — fill the screen with the page
for a sharper scan", which is the single most useful thing anyone can be told
about scan quality.

### On the viewing quality

Honestly reported: **no change since v11.31 could be found that reduces it.**
The submitted page is a landscape A4 (841.89 x 595.28pt) because the capture
itself was landscape-shaped, and v11.31 would have produced a page of the same
shape (842 x 587.3pt) at the same 183 dpi from the same capture. A landscape
page on a portrait phone is fitted to the screen width, so it is shown smaller
and therefore softer, and that is inherent to the page being landscape rather
than to any change here. The remedies are to hold the phone in portrait, or to
turn the page from its review sheet (v11.33). If a specific document still reads
worse than it did on v11.31, that is a separate defect and needs its own sample.

**Getting exactly the v11.31 scan behaviour back**, for comparison: turn **Auto**
off in the scan title bar (every capture then goes through the Adjust screen, as
before) and set **Page: As captured** in the filter row (no paper snapping, no
letterbox). Both settings are remembered.

### Tests

`tests/scan-tests.mjs` grows to 72 checks. The new ones drive the resolution
gate (a too-far page sized to pass the area test so only the new rule can reject
it, the reachability of the cap on 1080p, and the 1600px target binding on 4K)
and measure the detector's corner error at both working sizes on a synthetic
page with a known quad.

All four mutations bite: reverting auto capture to the live quad fails SC63,
removing the resolution gate fails SC56/SC59/SC66, keying the cap to the frame's
long side fails SC1/SC2/SC2b (auto capture becomes impossible to satisfy), and
dropping the still-frame detector to 300px fails SC64.

Whole suite green: 13 + 15 + 59 + 46 + 72 + 67 + 30 + 17 + 104.

## [v11.39] — 2026-07-27 — Fix: v11.37 re-flowed forms as if they were prose

**Regression report, with screenshots, on a pharmacy tax invoice.** Tapping text
re-flowed a block of unrelated fields into a running sentence and pushed it past
the space it had. This is a defect introduced in v11.37 and it is the worst kind:
it damaged a document on a single tap.

**What went wrong.** v11.37's paragraph rules were correct in isolation and
useless as a test of what may be re-wrapped. An address block, a label/value
stack and a table column all satisfy every one of them: same size, same colour,
even pitch, same column. So the grouping fired on an invoice, and because
paragraph mode was made the DEFAULT whenever a block was detected, one tap
committed to it. The overflow was then reported in the status bar *after* the
re-flow, which is a report, not a choice. Three separate mistakes, all mine, all
pointing the same way: the feature was allowed to act before the user had agreed
to what it was about to do.

The tests did not catch it because every fixture I wrote was prose. The rules
were tested against exactly the content they were designed for.

### The fix

- **Paragraph mode is opt-in.** A tap edits one line, which is the safe,
  predictable, pre-v11.37 behaviour. Re-wrapping is a deliberate second choice,
  and the button now says how many lines it would take ("Whole paragraph (4
  lines)") so the scope is visible before committing.
- **Anything with a neighbour on its own baseline is refused outright.** A table
  row and a label/value pair have something beside them; a line of a paragraph
  never does. On an invoice this alone rejects almost everything, which is the
  point. It also declines genuine two-column magazine prose, and that trade is
  deliberate: declining costs a line-by-line edit, accepting a table destroys it.
- **The body lines must agree on a right edge**, within 4% of the measure. That
  margin is what caused the wrap in the first place, so prose has it and a list
  of values does not. On the reported invoice the address block's first two lines
  differ by 15pt on a 250pt measure and are now refused; the footer's genuine
  wrapped prose differs by 5pt on 825pt and is still offered. The tolerance is
  tight enough to occasionally decline a real paragraph ending on a long word,
  which is the right way to be wrong.
- **Overflow is asked about before anything is redacted**, not reported after.
  A dry run measures the replacement against the block using the same font
  metrics the real pass will use; if it will not fit, the sheet says how many
  lines it needs versus how many it has and offers to go back. Declining leaves
  the document untouched.
- **The undo snapshot moved to after that decision**, so a cancelled edit no
  longer leaves a pointless undo step behind.

### Tests

`tests/editor-tests.mjs` grows to 46 checks. Five new fixtures are cut from the
reported invoice's actual shape: a table column, a label/value stack, a ragged
address block, a short line in the middle of a block, and — as the control —
the genuine wrapped prose from the same document's footer, which must still be
offered. Every prose test from v11.37 still passes, so the rules got sharper
rather than merely blunter.

All five mutations bite: removing the neighbour rule fails ED8/ED36/ED43,
removing the right-edge agreement fails ED38/ED40/ED44, and restoring paragraph
mode as the default fails ED33.

Whole suite green: 13 + 15 + 59 + 46 + 60 + 67 + 30 + 17 + 104.

## [v11.38] — 2026-07-27 — Sign with your finger

**Signing used to require an image file.** You had to sign paper, photograph it,
get the photo onto the phone, and then pick it — every single time, because
nothing was remembered. Every competing app lets you draw with a finger and
keeps what you drew. Tapping Sign now opens a sheet with your saved signatures
first, then "Draw a signature", with the photo import kept as a secondary path.

- **Up to three signatures are kept on the device** (IndexedDB, alongside the
  rest of the app's on-device storage; nothing leaves the phone) and there is a
  "Forget saved signatures" button, because a signature is the one thing in this
  app a person may want gone immediately.
- **The stroke tapers with speed** — a fast stroke is drawn thinner, the way a
  pen behaves. Without it a finger-drawn signature reads as rope rather than as
  ink.
- **The export is cropped to the ink**, with a 12pt margin, and keeps its
  transparent background. Cropping matters as much as transparency: an untrimmed
  pad places a mostly-empty box on the page, and the user then has to fight the
  aspect ratio to get the signature to the right size. A test asserts the crop
  rectangle is the ink and not the whole board; reverting it fails that test.
- **The pad is a light panel, not a dark one.** The sheet is OLED black and a
  signature is drawn in dark ink, so a dark pad would be invisible while
  drawing.
- Placement is completely unchanged: the same drag-a-box overlay, the same
  transparency handling, the same rotated-page warning. Only where the picture
  comes from is new.

Tests: 3 checks added to `tests/editor-tests.mjs` (37 total) covering the export,
the crop rectangle, and an empty pad exporting nothing rather than a blank box.
Whole suite green: 13 + 15 + 59 + 37 + 60 + 67 + 30 + 17 + 104.

## [v11.37] — 2026-07-27 — Edit a whole paragraph, and choose size, colour and typeface

Backup: `backups/restore.zip` (re-taken at v11.36, before this release).

**Until now one LINE was the largest thing that could be edited.** That is fine
for a form field and useless for a sentence: changing "twelve" to "twenty-four"
in the middle of a paragraph left that line short and every line below it
untouched, so the text stopped reading as a paragraph. Tapping any line of a
paragraph now offers to edit the whole thing, and re-wraps it.

- **Finding the paragraph is the hard part, and the risk is being too eager.**
  A grouping that over-reaches is worse than none at all: it would sweep a
  heading, a caption or the next column into the edit and re-flow them away. A
  paragraph is therefore only a run of lines that overlap horizontally, are set
  at the same size *and* the same colour, are spaced at a consistent pitch, and
  are not separated by a paragraph-sized gap. Anything less clear comes back as
  the single line it started from, which is exactly the pre-v11.37 behaviour.
- **Side-by-side columns needed their own fix.** Sorting a page by baseline
  interleaves them — a two-column layout gives left1, right1, left2, right2 at
  equal baselines — so a walk down that list stops at the very first neighbour
  and a paragraph in a two-column document could never be found at all. The
  candidate lines are now filtered to the tapped line's own column *before* the
  walk, which also makes the pitch check meaningful: it then measures the gap
  to the next line of this column rather than to whatever sits beside it. This
  was found by a test (ED8), not by reasoning.
- **The block width comes from the full lines, not the short last one.** Taking
  the widest extent would work; taking the last line's would re-wrap every
  paragraph to the width of its own final line and make it a line taller on
  every single edit. The 75th percentile of the line widths is used instead.
- **Leading is the median step between baselines**, not the mean, so one line
  carrying a superscript cannot stretch the whole paragraph's setting.
- **A paragraph that outgrows its space is shrunk, not spilled.** Text that
  needs more lines than the original had is set progressively smaller, down to
  70% of the original size. If even that will not fit, it is allowed to run on
  and the status line says so plainly, because text that silently lands on
  whatever is underneath is something the user cannot see coming.
- **The re-wrapped lines keep the paragraph's own first baseline and its own
  leading**, so an edited paragraph sits exactly where the old one did. Every
  line is measured in the face it will actually be drawn in — measuring in one
  font and drawing in another is the v11.29 bug, and it is not being repeated.
- The whole paragraph is erased in one redaction pass, using the same
  line-clamped bands as v11.30, so the lines above and below it survive.

**Type controls.** The edit sheet now has size (half-point steps, tap the
readout to return to the original), seven colours, and a typeface choice.
Choosing a typeface deliberately stops the document's own embedded font being
reused — that is the whole point of the choice — while "Same" keeps the v11.29
embedded-font path exactly as it was. Size and colour both default to the
original, so an edit that touches neither is byte-identical to v11.36.

### Tests

New `tests/editor-tests.mjs` (34 checks) added to `npm test`: paragraph grouping
against hand-built fixtures (heading, coloured line, paragraph gap, neighbouring
column, changed leading, short last line, tapping any line of the block,
malformed input), greedy wrapping, shrink-to-fit and honest overflow, plus the
grouping run against **real structured text** from a laid-out page, where the
four body lines must group and the heading and the caption must not.

Six mutations were checked and all six now fail the suite: dropping the size
check, the colour check, the column filter, the paragraph-gap check, taking the
block width from the last line, and removing shrink-to-fit. The size-check
mutation initially did *not* bite, which showed ED5 was passing for the wrong
reason — the heading was being rejected by the pitch guard rather than by the
size rule — so the fixture was re-cut to isolate the one rule under test.

**A note on process.** Bumping the version, I truncated `index.html` and `sw.js`
to zero bytes with a bad one-liner (`open(f,"w").write(open(f).read()…)` opens
for writing, and therefore truncates, before it reads). The test suite caught it
one command later and both files were restored from `backups/restore.zip`. This
is recorded because it is the clearest argument yet for keeping the restore
point current and the suite fast.

Whole suite green: 13 + 15 + 59 + 34 + 60 + 67 + 30 + 17 + 104.

## [v11.36] — 2026-07-27 — Compress shrinks the pictures, not the text

Backup: `backups/restore.zip` (re-taken at v11.35, before this release).

**The old compressor had two moves and nothing in between.** A lossless
structural pass, worth a few percent on a typical file and nothing at all on an
already-optimised one; and rasterising every page to a picture, which hits any
target but destroys selectable text. A document whose bulk is a handful of
oversized images — a report with screenshots, a scan, an invoice with a logo —
therefore had no useful option: you got 5%, or you got your text destroyed.

**What actually makes those files big is that their images are stored at far
higher resolution than they are ever drawn at.** A 12-megapixel phone photo
placed in a 5cm box on the page carries roughly 25 times the pixels that box can
show. Compress now recompresses each image individually and in place, against
the size it is actually drawn at, and leaves everything else in the file
byte-for-byte alone: text, fonts, vectors, links, annotations, form fields, the
page tree. Rasterisation still exists but is demoted to what it should always
have been — a last resort, reached only if the file is still over target after
the images have been dealt with.

Measured on a synthetic photo-heavy A4 page (a 1200×1600 photo drawn at 400pt
wide, plus real text): **2.92 MB → 705 KB, 76% smaller, with every character of
text still selectable and searchable.** The old pipeline on the same file
offered 5% or a rasterised page.

- **The drawn size is read off the content stream's own transformation matrix.**
  This is the number the whole feature turns on and it cannot be read from the
  image object — it lives in the page's drawing instructions. Rather than parse
  content streams, each page is run through a MuPDF render device that draws
  nothing and only notes the matrix it is handed. For an image that matrix maps
  the unit square onto the placed rectangle, so its column lengths *are* the
  drawn width and height in points. Effective DPI is then just pixels over
  inches. This is the same vendored MuPDF that was already in the app; the JS
  device interface it exposes was simply never used.
- **Images are keyed by their intrinsic shape** (pixels, components, bit depth),
  because the device is handed a decoded image rather than the object number it
  came from. Two genuinely different images sharing all four properties
  therefore share an entry and the largest placement wins — deliberately, since
  a larger placement means a higher DPI target, which means *less* reduction. A
  collision can only ever be conservative.
- **Downsampling is an area average, not a canvas `drawImage`.** The browser's
  scaler is bilinear, which on a 3–4× reduction samples a sparse subset of
  source pixels and turns small type into a shimmer; a one-pixel rule can vanish
  entirely. Averaging every source pixel that falls inside a destination cell is
  both correct and visibly cleaner. It is also pure JavaScript over the pixmap
  bytes, so it runs identically in the tests.
- **Nothing is rewritten unless the saving is real.** A replacement must be at
  most 90% of the stream it replaces, or the original is kept. Re-encoding a
  JPEG costs a generation of quality, and spending that for a 3% gain is a bad
  trade. An image already at a sensible resolution *and* already a JPEG is
  skipped outright; one stored as Flate or uncompressed is still re-encoded at
  full size, because that is a large one-generation win.
- **Skipped on purpose, each for a reason:** stencil masks (`/ImageMask true` —
  1-bit by definition, already tiny, and JPEG cannot represent them), JPEG 2000
  (`/JPXDecode` — round-tripping one can shift colour, and they are too rare to
  be worth that risk), anything whose pixmap carries an alpha channel (JPEG has
  no alpha; soft masks live in a separate `/SMask` object, which is left alone
  and keeps working because the PDF spec allows it to differ in size from the
  image it masks), and anything under 6 KB.
- **`/Decode` and the old `/DecodeParms` are cleared before rewriting.** They
  describe the *old* encoding; leaving either behind is exactly how an image
  comes back inverted or unreadable.
- **The whole pass runs on a separate copy of the document.** If anything throws
  — one unreadable image, one page that will not render — the lossless result
  from step one is still there untouched, and a single bad image never abandons
  the other forty.
- **Images shared across pages are handled once.** Keyed by object number, so a
  logo on all forty pages is rewritten once and every reference picks up the
  smaller version. The resource walk follows Form XObjects too, with a
  seen-set so a self-referencing form cannot loop.
- **The status line now says what actually happened** — how many pictures were
  reduced, how many were stored as black-and-white, and whether text survived —
  instead of a bare percentage.

### CCITT Group 4 for images that are already black and white

Some images are *already* two-valued — a fax, a stamp, a signature, a line
drawing, a page someone thresholded long before it reached us — but are stored
as 8-bit grey or 24-bit colour, which is 8 to 24 times the data they carry. For
those, Group 4 (the fax standard) is the right container, and a full T.6 encoder
is now included.

- **Measured against the alternative it replaces, the win is large: 42 KB versus
  387 KB for the JPEG the pass would otherwise have written — about 9×** — and
  unlike JPEG it is *exact*, with none of the ringing that makes a JPEG of black
  text on white look dirty. Against a Flate-stored original the gain is a more
  modest ~23%: Flate already exploits long runs of identical pixels, so the
  "5–15×" figure usually quoted for fax compression is against raw bits, not
  against a zipped image. The changelog says the smaller number because it is
  the true one.
- **The test for "already bilevel" is deliberately severe**, because this is only
  safe as a change of container, not of appearance: at least 99.5% of pixels at
  the extremes, near-zero chroma, and an ink coverage between 0.2% and 45%. An
  anti-aliased grey scan — which is what this app's own scanner produces — has a
  broad spread of mid-tones, fails the test, and stays a JPEG; thresholding one
  would visibly wreck it. A two-valued *coloured* image (a blue stamp) is refused
  by the chroma guard rather than having its colour thrown away. A blank page and
  a solid black block are both refused: neither is a document.
- Group 4 legitimately *expands* random noise, which is why the never-grow guard
  is not optional.

### Tests

New `tests/compress-tests.mjs` (67 checks) added to `npm test`.

The Group 4 encoder is verified by handing its output to **MuPDF's own CCITT
decoder** and comparing every pixel — all white, all black, vertical and
horizontal stripes, diagonals at odd dimensions, random noise, a sparse
text-like page, a single row, a single column, and a run longer than 2560 that
exercises the extended makeup codes. That is the only honest way to check a
bit-level codec: a single wrong entry in the T.4 tables produces a stream that
decodes to plausible garbage rather than to an error, and the mutation test
below confirms it.

The rest covers the effective-DPI arithmetic (including the slack band, the
unmeasured-image ceiling, and degenerate input), the box filter, bilevel
detection across five image types, and end-to-end runs on real PDFs: a 60%+
reduction with text compared character by character before and after, the
picture genuinely smaller in pixels and landing near the requested DPI, the
three quality levels genuinely differing, a small image left completely
untouched, a shared image rewritten once, a text-and-vector document untouched,
and font objects compared byte for byte. Eleven source guards assert the call
sites.

Every fix was mutation-tested: removing the never-grow guard fails CP40;
replacing the box filter with point sampling fails CP10, CP11 and CP12;
flipping one bit in a single white run-length code fails four round-trips;
removing the chroma guard fails CP16; removing the DPI slack fails CP4; and
skipping the image pass in `runCompress` fails CP46. Two of these mutations
initially failed to bite, which exposed two weak tests — the box-filter check
and the coloured-bilevel check — and both were rewritten until they did.

Whole suite green: 13 + 15 + 59 + 60 + 67 + 30 + 17 + 104.

## [v11.32–v11.35] — 2026-07-27 — Scanner: hands-free capture, real paper sizes, two-sided ID cards, scan into an open document

Backup: `backups/restore.zip` (snapshot of v11.31, taken before this batch).

Housekeeping first: the `backups/` folder held 58 files and 138 MB of
per-version zips and dated per-file copies going back to v10.80. All deleted.
There is now exactly ONE rollback snapshot, `backups/restore.zip`, and
`backups/RESTORE.md` says how to roll back to it and how to take a new one. The
changelog is the version history; the backups folder is not. `.gitignore` was
rewritten to match: it now names every shape that junk took
(`*-restore-point.zip`, `*_pre_*.js`, the extension-less `zi……` temp files the
zip tool left behind) so none of it can return on a future branch. `tests/` is
no longer git-ignored — that was a deployment concern, and `npm test` depends on
it. The stale `AUDIT-v10.94.md` moved into `backups/`.

### v11.32 — Auto capture

The shutter now fires itself. Point the camera at a page, hold it steady, and
the page is taken and added — no tap, and no trip through the Adjust screen.
A ten-page document goes from about forty taps to about twelve.

- **The decision to fire is a separate, much stricter gate than the one that
  draws the green box.** `detectQuad` always returns its best candidate, which
  is right for an outline the user can correct on the next screen, but wrong as
  a licence to commit a page unreviewed. The new `autoCaptureReady` in
  `scan-core.js` re-checks the geometry from scratch and refuses: a quad
  touching the frame edge (the document is already cropped, and the outline
  running along the edge of the screen does not make that obvious), one covering
  under 22% or over 97% of the frame, any side under 18% of the short edge, a
  non-convex quad, and corner angles outside 72°–108° — tighter than the
  detector's 65°–115°, because a steep view stretches the far edge and softens
  its text, and that cannot be undone later without rescanning. The asymmetry is
  deliberate: a false negative costs one tap on the shutter, a false positive
  files a bad page the user may not notice until the PDF is built.
- **"Held still" needed a new measurement.** The existing `liveStable` counter
  looked like it was already there for this, and it is not: it counts frames the
  detection stayed within `quadClose`'s tolerance, which is 18% of the quad's
  span. That tolerance exists so the outline does not flicker, and it means a
  slow, steady hand drift keeps incrementing `liveStable` while the page is
  visibly moving. `smoothQuad` now also records the largest per-frame corner
  shift, and the gate requires it under 1.2% of the frame diagonal. A brand-new
  or re-snapped quad reports `Infinity` — no previous frame means "moving",
  which is the safe direction, since the first frame of a new document is
  exactly when the detection is least trustworthy.
- **A countdown ring, drawn on the overlay at the centre of the document**,
  fills over 0.9s on top of the ~0.9s lock. Every refusal path disarms, so the
  ring resets the instant you move: the shot is visible before it happens and is
  cancelled by moving. While the countdown runs, the detect loop stops skipping
  every other tick (a v10.94 battery optimisation) — halving the rate would
  halve the resolution of the motion check, the one gate that stops a moving
  page being taken. The ring itself is redrawn on animation frames only while
  armed, so the 300ms tick does not make it move in three visible jumps and
  there is no standing battery cost.
- **One page cannot be taken twice.** After firing, capture latches until the
  document is *released* — the detection is lost, or it jumps to a different
  quad. That covers both ways a person actually works: lifting the phone off the
  stack, and sliding the next sheet under it without moving the phone at all.
- **The Auto toggle sits in the scan title bar and is remembered.** On by
  default. The shutter still works by hand at any time, and a hand-tapped
  shutter still goes through the Adjust screen — Auto is for working through a
  stack, the shutter is for the one awkward page. The toggle hides itself on the
  native-camera fallback path, where there is no live preview to detect on and
  it would be a control that silently does nothing.
- Auto pages run the IDENTICAL pipeline as hand-cropped ones: `commitScanPage`
  was lifted out of the "Use page" handler and both callers share it, so the two
  differ only in where the quad came from.
- **A refusal that persists says why.** An automatic feature that declines in
  silence is the worst kind — nothing happens and there is no way to know what
  to change. When the same reason holds for about 1.8s, one plain-language line
  appears ("Hold the phone flatter over the page", "Move back a little — part of
  the page is outside the frame"), at most once every six seconds so it cannot
  become a running commentary on every camera wobble, and always ending with the
  reminder that the shutter is right there. Tapping the shutter cancels a
  countdown in progress: a deliberate tap means the user wants to frame this one
  themselves.

### v11.33 — Scanned pages are a real paper size

- **Every scanned page used to be a size that is not any real paper.** The page
  was built as `s = 842/max(w,h)`, then `addPage([w*s, h*s])` — which scales the
  long side to A4's 842pt but keeps whatever aspect ratio the detected quad
  happened to have. A hand-cropped A4 sheet is never exactly 1:1.414, so a
  typical scan came out 612.4 × 842 rather than 595.28 × 841.89. Three visible
  consequences: the print dialog rescales it and the margins come out uneven,
  merging a scan with a born-digital PDF gives a document whose pages are all
  slightly different sizes, and anything stamped or numbered later lands at
  inconsistent offsets.
- **The page is now a real size and the image is fitted inside it**, letterboxed
  with white where the aspect does not match. Nothing is cropped and nothing is
  stretched: the captured aspect ratio is preserved exactly. White margins are
  what a flatbed produces too, and they compress to almost nothing. The
  letterbox is explicitly painted white rather than left transparent, because a
  pdf-lib page has no background and a transparent margin prints as whatever the
  printer decides.
- **A new Page control in the Adjust filter bar** cycles A4 → Letter → Legal →
  As captured, and is remembered. A4 is the default. "As captured" reproduces
  the old behaviour exactly, for anyone who wants it.
- **A landscape capture turns the PAPER, not the image** — a landscape shot gets
  a landscape A4 page instead of being letterboxed into portrait with large
  white bands top and bottom.
- **Any scanned page can be turned a quarter at a time from its review sheet.**
  This matters more than it used to: with auto capture the Adjust screen, and
  its Rotate button, is skipped entirely, so previously a sideways page could
  only be fixed after the PDF was built. The turn is stored per page and written
  as `/Rotate` at build time, so it is lossless — the JPEG is never re-encoded
  to rotate it — and the thumbnail shows it (through the CSSOM, since the CSP is
  `style-src 'self'` with no `unsafe-inline`).
- **Auto-rotate-to-portrait was planned for this release and deliberately NOT
  built.** A landscape certificate, a spreadsheet printout and a sideways-held
  capture of a portrait sheet all produce exactly the same output shape; no
  amount of geometry distinguishes them, because telling them apart means
  reading the text direction, which is an OCR job. Rotating on aspect alone
  would have silently turned every genuinely landscape document on its side. The
  paper-turning above and the per-page manual turn cover the real cases without
  guessing. This is written down in the source at the point where the check
  would have gone.

### v11.34 — Both sides of an ID card on one page

- **"Both sides" in Photo ID mode** captures the front, holds it, then combines
  it with the back onto a single A4 page — what every print shop produces for an
  Aadhaar, PAN, licence or voter card. Before this each side became its own
  page, so a card came out as a two-page PDF with two-thirds of each page blank,
  which then had to be printed twice.
- The two sides are fitted independently. They are rarely framed identically,
  and a shared scale would shrink whichever side was photographed from further
  away; each is capped at 30% of the page height so a tall card (a passport page
  rather than an ID-1 card) still cannot overrun the sheet.
- **One-sided output is unchanged to the pixel.** `compositeCardOnA4` now
  delegates to the shared two-slot placement, and passing a single card
  reproduces the previous geometry exactly (46% width, 42% height cap, top at
  17% of the page) — asserted by a test.
- The toggle is hidden outside Photo ID mode rather than merely disabled, which
  also keeps the filter row from wrapping to a third line on a small phone. A
  held front side is dropped when ID mode or the toggle is switched off, and
  when the scan session ends, so a stale side can never be welded onto an
  unrelated card later. While a side is held the page counter says "Front held —
  scan the back", because otherwise the count not moving after a capture looks
  like the capture failed.

### v11.35 — Scan straight into the document you already have open

- **"Scan more pages"** in More → Create, and **"Scan more pages into this"** on
  a Recents card, start a scan session whose pages are added to the end of the
  open document instead of replacing it. The everyday case: a contract is open,
  one page comes back signed on paper, and it has to go on the end. That
  previously meant saving the scan as its own PDF, reopening the original, then
  Combine — three round trips through the Files app for one page.
- The button relabels itself to "Add to document (n)" so it is clear before you
  commit, and the append path skips the discard prompt, since nothing is being
  discarded.
- **Ordering is chosen so a failure cannot damage the open document.** The
  scanned pages are built and validated into a temporary PDF first; only then is
  the undo snapshot taken and the graft performed. If anything throws, the
  document is left exactly as it was — no undo step, no dirty flag, no
  half-appended file. Pages are grafted with mupdf's `graftPage`, the same
  primitive Combine uses, which carries page resources across properly instead
  of re-rasterising. If the document went away while the camera was up, the
  session falls back to creating a new PDF rather than losing the pages.
- Appended pages are built with the same `addScanPageTo` as a brand-new
  document, so a page added to an existing file is identical to a freshly
  scanned one.

### Tests

New `tests/scan-tests.mjs` (60 checks) added to `npm test`, running the shipped
helpers out of `app.js` and `scan-core.js`: the auto-capture gate (framing,
motion, off-frame, angle, convexity, malformed input, and that it is strictly
tighter than the detector), paper fitting (real sizes, aspect preservation,
centring, letterbox, landscape paper turn, "as captured" parity with the old
formula, degenerate input), end-to-end page geometry read back out of the built
PDF with MuPDF, `/Rotate` being used for turns, the one- and two-card layouts,
and the append graft. Fifteen source guards assert the call sites the features
depend on. Each fix was mutation-tested: removing the motion gate fails SC2 and
SC2c, reverting `fitToPaper` to the old formula fails SC11/12/14/16/17/18, and
collapsing the two-card layout fails SC28.

The harness and scenario tests were taught about the three new `scan-core.js`
exports. Whole suite green: 13 + 15 + 59 + 60 + 30 + 17 + 104.

## [v11.31] — 2026-07-27 — Green document outline no longer dies after the first page

Backup: `backups/pypdf-pwa-v11.30-pre-v1131-scanoverlay-restore-point.zip`.

Reported: after adding the first page and returning to the camera to scan the
next one, the green detection box never appeared again.

- **Root cause: the overlay canvas was left at the wrong size, and a wrong-sized
  canvas draws nothing.** The outline is a canvas whose backing store is set
  from the live-preview box (`.scanview`). Adding page 1 makes the thumbnail
  strip appear, which takes ~72px off that box — and nothing re-sized the canvas
  when the box changed on its own. Worse, `sizeQuadCanvas` read
  `clientWidth`/`clientHeight` unconditionally, and a hidden element reports 0:
  the camera screen is `display:none` for the whole time the Adjust screen is
  up, so a layout event raised in that window wrote a 0×0 canvas. Nothing
  reported any of this, because the preview loop swallows every error by design.
- **The overlay now re-asserts its size on every detection frame.** One layout
  read, and it writes only when the box actually changed (assigning
  `canvas.width` resets the bitmap AND the 2D context state, so re-asserting
  blindly would erase the outline mid-draw). This heals the overlay after any
  layout change there is no callback for — the thumbnail strip appearing or
  disappearing, rotation, the iOS URL bar, returning from Adjust.
- **`sizeQuadCanvas` now refuses a zero size** rather than obeying it, so a
  mistimed call is a no-op instead of killing the overlay for the rest of the
  session. It returns whether the preview box is real, and `drawLiveQuad` uses
  that to skip drawing when the camera screen isn't on screen.
- **The `resize` handler is guarded like its neighbour.** `layoutCrop()` was
  already gated on the Adjust screen being visible; `sizeQuadCanvas()` was not,
  so a resize during Adjust measured a hidden element. Now belt-and-braces on
  top of the zero-size refusal.
- **A detection loop that fails every frame says so.** Five consecutive failures
  raise one warning that capture still works and edges can be dragged on the
  next screen, instead of the feature silently not existing.
- Tests: the harness now models two things it previously faked away — an element
  inside a `display:none` view reports a zero client box, and the thumbnail
  strip takes height off the preview box. It also presents the document as
  visible; jsdom reports `visibilityState: "prerender"`, which meant the live
  detect loop returned on every tick and **the entire green-outline feature was
  never executed by any test**. 13 new checks (S1–S12) drive the reported flow
  and assert the outline is drawn on a correctly-sized canvas; strokes on a
  zero-size canvas deliberately do not count as a draw. Each fix was mutation-
  tested: reverting the zero-size refusal fails S6/S6b, reverting the per-frame
  re-assert fails S10. Suite: 13 + 15 + 59 + 30 + 17 + 104.

## [v11.30] — 2026-07-27 — Text edit stops damaging the lines around it

Backup: `backups/pypdf-pwa-v11.29-pre-v1130-editfix-restore-point.zip`.

Reported with a before/after pair of an Amazon tax invoice: changing the billing
name from "Prasenjit Paul" to "Bandhana Paul" left the page with
`Billing Address :` reduced to `Bill`, `Shipping Address :` to `Ship`, and
`C/o Bharat Ch Paul, South Colony, Near Park` to `C/o Bharat Ch Paul, South Col`
— and the right-aligned address column no longer lined up.

- **The redaction was reaching into the neighbouring lines.** A structured-text
  span's box is the FONT box of its line, ascender to descender. At normal
  leading that box is TALLER than the line pitch — 15.45pt for 11.25pt text set
  on 13.0pt — so consecutive lines' boxes genuinely overlap by ~2.4pt, and the
  editor was redacting the whole box plus another 1pt of padding. MuPDF drops
  every glyph whose box intersects the redaction rect, so each edit silently
  deleted whatever sat above and below it within the same columns. The rect is
  now clamped to the clear gap between the lines above and below; a band through
  the x-height still intersects every glyph OF THIS LINE (MuPDF removes whole
  glyphs, ascenders and descenders included) while touching nothing else. The
  background fill was widened to match — it now covers exactly the erased band,
  where before it painted over the descenders of the line above. As a side
  effect an edit erases far less of whatever sits behind the text, so it no
  longer punches a white slot through a watermark or a coloured panel.
- **Block alignment is preserved.** The replacement was always re-typed from the
  original's LEFT edge, so in a right-aligned address block a longer name grew
  past the margin and broke the column. The editor now reads the alignment off
  the block itself — the lines stacked with this one are scored against the
  median of their left edges, right edges and centres — and anchors the
  replacement to whichever edge they agree on. Scoring by agreement-with-median
  rather than by spread means one line whose last glyph has an unusual side
  bearing can't veto an alignment the other four plainly share. Left stays the
  default and another mode has to win clearly, so ordinary left-aligned text is
  untouched.
- **Placement is expressed as a shift from the original pen position**, with
  both the old and new widths measured in the font actually being drawn. That
  makes re-typing a field unchanged an exact no-op in every alignment mode,
  which an absolute edge anchor cannot promise (a span's box is its ink extent,
  but text is laid out by advance width, and the two differ by the first and
  last glyph's side bearings — 1.3pt on the Cambria name field).
- **The document's own letter spacing is reproduced.** Publishers kern body
  text, stored as a TJ array of glyph runs with offsets we can't read back, so
  an un-kerned redraw of the same words came out ~3% wide (87.5pt against
  84.9pt on the Cambria name field) — enough to push a centred line visibly off
  centre. The replacement now carries a `Tc` character-spacing value derived
  from what the original actually measured. `Tc` was chosen over horizontal
  scaling (`Tz`) because it doesn't distort the glyphs and doesn't change the
  font size extractors report — `Tz` made the same field read back as 9.85pt
  instead of 10pt, and re-editing it would have ratcheted it smaller each time.
  The divisor is glyphs-1, not glyphs, because a span box is the union of its
  glyph quads and the spacing after the last glyph falls outside it; dividing by
  the glyph count left 0.16pt of slack that each re-edit added again.
- Verified on the reported invoice: re-running the exact edit changes 3 lines
  out of 209 across both pages, both pages keep their original line count, and a
  150dpi pixel diff against the untouched original shows changed pixels ONLY
  inside the two name fields (x 476.6–552.0pt) with page 2 bit-identical.
  Editing the same field five times in a row moves it 0.08pt in total and does
  not change its size.
- Tests: new `tests/textedit-tests.mjs` (59 checks) added to `npm test`, running
  the shipped helpers out of `app.js` against fixtures built at the leading that
  triggered the bug — redaction bleed, left/right/centre alignment, size
  preservation, deletion, embedded-font coverage and fallback, tracking maths,
  consecutive edits, repeat-edit creep, and source guards on the fixed call
  sites. Whole suite green: 13 + 15 + 59 + 30 + 17 + 91.

## [v11.29] — 2026-07-22 — Text edit keeps the document's own font and size

Backup: `backups/pypdf-pwa-v11.28-pre-v1129-fontmatch-restore-point.zip`.

Reported against a pathology report whose doctor-name field is Cambria 10pt:
after editing it came back in a different face and visibly smaller. Two separate
defects, both in `applyTextEdit`.

- **Replacement text now reuses the PDF's OWN embedded font.** Every edit was
  redrawn with a pdf-lib base-14 face (Helvetica / Times / Courier) picked by
  regex on the font name, so Cambria became Times-Roman and the edited field no
  longer matched the line above it. The editor now looks the span's font up in
  the page's `/Resources /Font`, inverts its `/ToUnicode` CMap to get
  Unicode → character-code, and emits the replacement as raw content-stream
  operators (`BT … Tf … Tm … Tj … ET`) against that same resource. No new bytes
  are embedded and the result stays real, selectable, searchable text. Verified
  on the report: the edited name re-extracts as `Cambria 10.0`, byte-identical
  in face and size to the original.
- **Safe fallback, unchanged behaviour where it can't help.** The embedded path
  declines — and the old base-14 path runs exactly as before — when the font
  can't be found in the page resources, when a Type0 font isn't `Identity-H`,
  when a simple font carries an `/Encoding /Differences` array, when metrics are
  missing, or when *any* character of the replacement is absent from the
  embedded subset. That last check is what stops a name typed with an accented
  or non-Latin letter from rendering as a blank box: the whole string falls back
  instead. Standard base-14 fonts (a plain `Times-Roman` resource) keep using
  substitution, which for them is already an exact match.
- **Fixed the silent font-size reduction.** `fitFontSize` measured the space
  available as the original text's own ink width, so a substitute font with
  different metrics failed the check on the *same words* — re-typing
  "Dr. SANDIPAN PAUL" unchanged shrank it from 10pt to 9.25pt (Times sets it
  ~8% wider than Cambria). The available width is now the real gap on that line:
  from the span's origin to the nearest neighbouring span to its right, or the
  page edge less a 4pt margin, and never tighter than the original box. Size now
  only drops when the text would genuinely collide with something — a 33-char
  name in an 85pt field still shrinks (to 8.6pt), a same-length correction does
  not.
- Tests: full suite green (91 passed). Verified end-to-end in Node against the
  real `app.js` helpers on the source PDF, comparing rendered crops of original
  / v11.28 / v11.29 output.

## [v11.28] — 2026-07-15 — Photo ID mode: yellow-cast fix (neutral-pixel white balance)

Backup: `backups/pypdf-pwa-v11.27-pre-v1128-idcard-tint-restore-point.zip`.

- **Fixed the yellowish tint on Photo ID scans of coloured cards/cheques.** The
  ID-mode white balance averaged ALL bright pixels (grey-world), so a large
  coloured subject — e.g. a blue bank cheque — cancelled a warm room cast in the
  average (or tripped the off-axis guard) and the yellow tint survived to the
  final page. The sample is now restricted to bright, unclipped, LOW-CHROMA
  pixels (true paper/laminate white), which the card's own colour cannot skew;
  that also makes a stronger 90% cast-removal blend safe (was 55%). Falls back
  to the old grey-world path when fewer than 2% of pixels are neutral.
- **New paper-whiten pass in ID mode:** bright near-neutral pixels are gently
  desaturated (feathered by luminance 185→225; full below 5% relative chroma,
  off at 10%), clearing residual cast off the paper while leaving real colour —
  skin tones, flags, security print — untouched. Pixels that were COOL-tinted
  (B>R with ≥5% chroma) before white balance are exempted outright: a warm cast
  always reads R>B, so B>R chroma is genuine card colour (PAN's blue wash,
  cheque security print, passport guilloché) and must survive even if WB pulls
  it near-neutral. Verified against the cancelled-cheque scan (warm margin RGB
  244/230/212 → 248/246/238, blue pattern hue intact) and a synthetic
  Aadhaar / PAN / passport / driving-licence / voter-card suite under both warm
  cast and neutral light: cast cut ~2.5-3x everywhere, skin-tone and card-colour
  hues stable within 1-5°, no pale-tint wash-out in good light.

## [v11.27] — 2026-07-12 — Share from the Recents long-press menu

Backup: `backups/pypdf-pwa-v11.26-pre-v1127-share-restore-point.zip`.

- The long-press card menu gains **Share… (WhatsApp, Mail, AirDrop)** — opens
  the native iOS share sheet via the existing saveOrShare path, without having
  to open the document first. The stored bytes are pre-loaded when the sheet
  opens so navigator.share still runs inside iOS's user-activation window
  (an async gap there silently voids the share sheet). Falls back to a normal
  download where file sharing is unsupported; disabled if the bytes are no
  longer stored on the device.

## [v11.26] — 2026-07-12 — Unsaved-changes dot + per-card Recents menu

Backup: `backups/pypdf-pwa-v11.25-pre-v1126-ux-restore-point.zip`.

- **Unsaved-changes dot:** the Save toolbar icon shows a small blue dot while
  the document has changes you haven't saved (every dirty transition now goes
  through one setDirty() helper, so the dot can never go stale).
- **Long-press a Recents card** for Open · Star · Remove — a single document
  can now be removed from Recents (entry + stored bytes) without clearing the
  whole list. A tap still just opens; the long-press fires after 550ms and is
  cancelled by lifting or moving the finger (scrolling).
- placeFindBar hardened: header height read from the layout box
  (offsetHeight) instead of getBoundingClientRect, which included the
  immersive-mode slide transform mid-animation.

## [v11.25] — 2026-07-11 — Recents cards are uniform blocks

- The two recents columns rendered at different widths (and so the 3:4
  thumbnails at different heights): a long no-wrap filename pushed its `1fr`
  column out to min-content width. Columns are now `minmax(0,1fr)` — always
  exactly equal — names ellipsise, and each card fills its grid row so the
  blocks match in both dimensions.

## [v11.24] — 2026-07-11 — Performance pass + More-sheet footer tiles

Backup: `backups/pypdf-pwa-v11.23-pre-v1124-perf-restore-point.zip`.

- **Scroll CPU (biggest win):** the "Page x of n" pill measured EVERY page with
  `getBoundingClientRect` on every scroll frame — 300 forced layout reads per
  frame on a 300-page book. Page geometry is now measured once per
  render/zoom/rotate and each scroll frame answers with a binary search over
  cached positions.
- **Recents byte rewrite skipped:** opening a file Recents already stores
  (same name + size — e.g. opened FROM the Recents grid) used to rewrite up to
  25MB into IndexedDB every time. The stored bytes are reused; only the
  timestamp/thumbnail/star refresh.
- **Double render on reopen fixed:** the saved zoom is adopted BEFORE the
  first render (it used to build every page at 100%, then rebuild the whole
  document at the remembered zoom). A new document also no longer inherits the
  previous document's zoom — it opens at a clean 100%.
- **Thumbnail cache trimmed** 400 → 150 entries (the grid lazy-loads near the
  viewport; the old cap could pin ~10–20MB of dataURLs on long documents).
- **Zoom reset UX:** the % readout in the zoom pill is now a button — tap it
  to snap straight back to fit-width 100%.
- **More sheet footer:** About and Cancel are tiles like every other action
  (icon over label, half-width pair) instead of stretched full-width rows.

## [v11.23] — 2026-07-11 — Fix pass over the v11.22 UI batch

Backup: `backups/pypdf-pwa-v11.22-pre-v1123-fixes-restore-point.zip`.

- **100% zoom no longer slides sideways (root cause).** `viewerCssWidth()`
  assumed the viewer's side gutters were 8px total, but the v11.22 large-phone
  media query set them to 20px — every page rendered 12px wider than the pane,
  so a fit-width document was horizontally scrollable and drifted on any touch.
  Page width is now computed from the viewer's REAL computed padding, and the
  viewer gets `overscroll-behavior:none` so it cannot rubber-band.
- **Toolbar bottom spacing reduced** on Pro Max-class phones (the v11.22 media
  query had increased it): the bar tucks into the home-indicator inset again;
  side gutters return to the 4px edge-to-edge hairline. Bigger icons/labels
  stay. Zoom/undo/markup pills track the new offsets.
- **Find bar sits flush under the measured header.** Its top offset was a
  hardcoded 30px guess that ran under the taller large-phone header, hiding the
  input's blue top border. `placeFindBar()` measures the header's actual bottom
  edge on open and on resize; the focus ring is now a solid accent border plus
  a 1px halo, on all four sides.
- **Markup preference is now obvious:** the last-used tool (e.g. Sign) shows
  the same blue-tinted fill as an active tool when the popover reopens, with a
  hairline ring to distinguish it from a live mode. Still session-only —
  cleared when the PDF is closed.
- **More sheet dedupe, pass 2:** "Copy pages" and "Go to page" removed — both
  already live in the toolbar's Pages grid (Select → Copy; tap a thumbnail to
  jump; the floating page pill also opens Go to page). Sheet is now Create
  (Scan, Photos → PDF) · Pages (Organize, Combine) · Document (Compress,
  Unlock, Save image) · About. Harness T5/T37c updated.
- Changelog backfilled for the undocumented v11.19–v11.22 builds (below).

## [v11.19–v11.22] — 2026-07-10/11 — (backfilled) find/markup exclusivity, view-mode text selection, recents grid

These builds shipped without changelog entries; reconstructed from source:

- **v11.19:** Find and Markup are mutually exclusive (opening one closes the
  other); the fixed chrome is pinned while the find keyboard is open so the
  header/find bar can't be scrolled off-screen.
- **v11.20:** minor/cache-bump release (no annotated changes in source).
- **v11.21:** born-digital documents get an always-on selectable text layer in
  VIEW mode (long-press to select/copy without entering Select); long-press
  selection no longer mis-fires the tap-to-hide-chrome path.
- **v11.22:** Recents grew to a 6-card grid with star/pin (max 3; starred float
  first and are never evicted); last-used markup tool hinted in the popover;
  find-input focus ring reworked; Find and "All pages" removed from the More
  sheet; first cut of the ≥428px (Pro Max) spacing media query — partially
  reworked in v11.23 above.

## [v11.18] — 2026-07-10 — Bigger centred icons, double-tap viewport zoom killed, keyboard hardening

- Toolbar icons 24px, content vertically centred (balanced top/bottom padding
  so the stack no longer hugs the top of the strip).
- **Serious fix:** a fast double-tap on any toolbar button (e.g. Markup) was
  triggering iOS's NATIVE double-tap smart-zoom of the whole viewport.
  `touch-action:manipulation` on all app chrome removes that gesture while
  keeping taps and pans (pages keep pan-x pan-y, so the app's own pinch and
  double-tap zoom of the PDF are untouched).
- Dark keyboard, second pass: added `supported-color-schemes` meta and a CSSOM
  root color-scheme set at boot, alongside v11.17's meta + input rules.

## [v11.17] — 2026-07-10 — Bigger glyphs (same bar height), Markup toggle polish, dark keyboard

- Bar back to the slim v11.15 height; icons grew to 22px inside the same box
  (each button is a sixth of the screen wide, so the touch target is ample).
- Markup lights up while its popover is open, not just while a mode is active;
  every close path re-syncs the highlight (hideMkMenu helper).
- Exiting a mode or closing Find no longer flashes a "Ready." toast.
- Dark iOS keyboard: `<meta name="color-scheme" content="dark">` plus explicit
  color-scheme:dark on inputs (WebKit reads the meta before CSS, which is what
  reliably flips the keyboard in a standalone PWA; iOS offers dark grey, not
  true black — that's the system limit).

## [v11.16] — 2026-07-10 — Touch-friendly toolbar buttons

- Buttons back to the full 44pt Apple HIG touch target (icons 20px, labels
  11px); viewer padding and floating pills moved to match (~8px page height
  traded for comfort).

## [v11.15] — 2026-07-10 — iOS tab-bar tint for the toolbar

- Idle items grey (#8e8e93), the ACTIVE item tinted blue with a bolder label
  (no pill), icons 18px / labels 10px. Disabled items are a dimmer grey rather
  than ghosted white, so the welcome screen reads calm instead of broken.
- Save's glyph is now the iOS share icon (the action opens the share sheet).

## [v11.14] — 2026-07-10 — Toolbar fixes: opaque bar, centred buttons, active highlights

- **Bar no longer greys out over pages.** The header/toolbar/find bar used the
  translucent `--chrome` material; with white pages scrolling beneath the now-
  fixed bars they washed out to grey. All three use near-opaque
  `rgba(16,16,18,.96)` (blur kept), so they stay dark over any content.
- **Buttons centre vertically** in the ribbon (`align-items:center` + balanced
  padding) and the ribbon is squeezed again (36px buttons).
- **Active highlights:** Find lights up while search is open, Pages while the
  thumbnail grid is open (Markup already lit while a mode is active).

## [v11.13] — 2026-07-10 — Squeezed chrome (more page height)

- Slimmer toolbar (smaller padding/icons) and header; viewer padding and all
  floating pills (zoom, undo, markup popover, page pill) moved to match.

## [v11.12] — 2026-07-10 — Toolbar sits at the bottom edge

- The bar's bottom padding tucks into the home-indicator safe area instead of
  reserving the full inset — no more dead strip under the labels.

## [v11.11] — 2026-07-10 — Toolbar diet (Preview-style, UX revamp part 2)

Backups: `backups/*_pre_toolbar_diet.*`.

- **Bottom bar reduced to six quiet icons:** Open · Pages · Markup · Find ·
  Save · More. Edit/Select/Sign fold into a floating **Markup popover** (same
  buttons/IDs, relocated); ✕ moved to the top bar (iOS Done position).
- **Compress and Unlock moved into More → Document.** Their original buttons
  stay hidden in the DOM with their handlers, so the build guard, tests and
  undo paths are untouched. Popover auto-closes on mode pick, sheet open,
  immersive mode, or document close; it is in the modal-inert list.
- Harness T5 updated: it asserted the OLD rule ("Unlock must not be in More"),
  which this redesign deliberately reverses.

## [v11.10] — 2026-07-10 — UX revamp part 1: home launcher, immersive reading, pages grid

Backups: `backups/*_pre_ux_revamp.*`.

- **Home screen:** action tiles side-by-side; recents are a two-column grid of
  thumbnail cards (small first-page JPEG stored per entry, best-effort).
- **Immersive reading:** header/toolbar float over pages as blurred bars and
  slide away on scroll-down or a single stationary tap (Books/Preview style);
  scroll-up, tap, or top-of-document brings them back. Modes/Find/close always
  restore the chrome. Single-tap detection never fires on drags or double-taps.
- **All pages grid:** near-full-height sheet, 3-across thumbnails; tap to jump,
  Select mode for Rotate / Copy-to-new-PDF / Delete (all undoable). Organize
  keeps the drag-reorder row UI; page pill still opens Go to page.

## [v11.06] — 2026-07-10 — Zoom/gesture polish round

- Pinch starting mid double-tap animation lands the animation instantly
  (no transform fight / rubber-banding).
- Double-tap zooms IN below 125% (Preview-like), out otherwise.
- Live pinch label snaps to 5s so it matches where setZoom lands.
- Rotation keeps the reading position (same page+fraction anchor as setZoom).
- What's-new banner reads from a WHATS_NEW constant kept beside APP_BUILD
  (the old one was hardcoded v10.97 text).
- Service worker no longer runtime-caches query-string URLs.

## [v11.05] — 2026-07-10 — Double-tap zoom page-jump fixed at the root

Backups: `backups/*_pre_dtzoom_fix.*`.

- **Root cause of "double-tap jumps to page 1":** `renderStage` swapped the
  sized holder for an unsized, still-decoding `<img>`, so pages collapsed to
  0px for a few frames and yanked the scroll upward AFTER setZoom had
  positioned correctly. New bitmaps are decoded first and inserted at the
  page's exact CSS size (footprint-neutral swap). Fixes pinch and −/+ too.
- **No more white flash while zooming:** the render fast path keeps the old
  bitmap on screen at the new size (briefly soft) instead of a blank holder;
  the sharp raster swaps in seamlessly.

## [v11.00] — 2026-07-06 — Live Text on scanned pages (iOS 16+)

Backups: `backups/*_pre_livetext.*`. **NEEDS ON-DEVICE VERIFICATION** —
Live Text behaviour inside a home-screen PWA is undocumented by Apple; it
works in Safari tabs, but confirm in the installed app on your iPhone.

- **Touch-and-hold text selection on scans (Live Text).** Pages already
  render as real `<img>` elements (MuPDF → JPEG), which is what iOS Live
  Text needs. The page image now explicitly allows the iOS callout and
  selection in view mode (`-webkit-touch-callout:default`,
  `user-select:auto` on `.stage img` only — app chrome keeps them off), so
  touch-and-hold on a scanned page gives Vision-powered select / copy /
  translate / look-up: the same on-device engine as Preview and Photos, with
  no OCR code, no downloads, fully offline. Edit (`textmode`), Select-overlay
  (`selmode`), and signature-placing (`.placing`) re-suppress the callout so
  app gestures keep priority.
- **One-time hint.** Opening a document with no text layer (sampled via the
  existing `docHasText()`) shows a single status tip — "touch and hold text
  on the page to select it" — remembered in localStorage, never repeated.
- Scope note (deliberate): Live Text is selection-in-the-moment only. It does
  NOT embed a text layer, so in-app Find still won't match scan text and a
  saved copy stays image-only. A real OCR pipeline in the PWA would need
  Tesseract.js (~12 MB+, slower, below Vision accuracy) — decided against
  for now; the Mac app covers full OCR.
- Verify on iPhone: 1. open a scan in the installed PWA → hold a word →
  selection handles appear; 2. copy/translate menu works; 3. pinch-zoom,
  double-tap, Edit, Sign, Select modes unaffected; 4. hint shows once.

## [v10.99] — 2026-07-06 — Storage budget, Scan shortcut, deploy hardening

- **Recents now respect a total-bytes budget (60 MB), not just a count.** Five
  25 MB documents used to pin ~125 MB of IndexedDB, hastening the storage-full
  warning (v10.88) and iOS eviction. Oldest entries (and their stored bytes)
  are dropped once the budget is exceeded; the newest always survives.
- **Home-screen "Scan" shortcut.** The manifest gains `shortcuts`; long-press
  the installed app icon → Scan a document opens the app straight into the
  scanner (`?action=scan`, handled after engine-ready; the session-restore
  prompt is suppressed because intent is clear). The service worker now
  matches navigations with `ignoreSearch`, so the shortcut also works offline.
  (iOS ignores manifest shortcuts today — this benefits Android/desktop
  installs for free and is inert elsewhere. Manifest `screenshots` were
  considered and skipped: they need real device captures to be honest.)
- **DEPLOY.md documents the two protections only a server can add** —
  `frame-ancestors 'none'` and `X-Content-Type-Options: nosniff` (the page's
  meta CSP can't express frame-ancestors). No app behaviour change.
- What's-new toast refreshed to summarise the v10.95–v10.99 round.

## [v10.98] — 2026-07-06 — Resilience: no blank pages, plain-language errors

- **A page that fails to rasterise is no longer permanently blank.** The first
  failure retries once automatically (transient memory pressure is the usual
  cause); a second failure turns the placeholder into a tappable "Couldn't
  show this page — tap to retry". Previously the failure was swallowed and the
  page stayed white with no way out short of re-zooming.
- **Unexpected error banners now speak plain language.** The global error
  handler showed raw engine/JS text ("RangeError: out of memory @ app.js:…");
  the visible banner now goes through the same `friendly()` translation as
  action errors (new pure `friendlyText()` helper). The raw message is still
  kept in the on-device log for diagnosis — which now retains 10 entries
  (was 3).
- **Very large files warn before opening.** Picks over 150 MB get a clear
  "may exceed this device's memory" confirm instead of a long stall that iOS
  could kill silently. Opening anyway remains one tap.
- **Native-camera fallback scans match live-scan sharpness.** The fallback
  path downscaled photos to 2600 px before cropping while the live path warps
  at 3200 px; both are 3200 now.
- Zoom hint updated: the floating − / + pill exists on phones since v10.73,
  so the "Opened" tip now mentions it there too.
- Still pending from the audit (manual, device-only): EXIF-orientation check
  of Photos → PDF with a portrait HEIC capture (expected fine — Safari applies
  EXIF orientation in canvas drawImage — but unverified on-device).

## [v10.97] — 2026-07-06 — Keyboard no longer covers sheet inputs

- **The iOS keyboard can no longer hide a sheet's input or buttons.** On
  SE-class iPhones, focusing the Save/rename, password, or go-to-page field
  raised the keyboard over the bottom sheet. The app now listens to
  `visualViewport` resize/scroll and lifts the sheet by exactly the keyboard
  overlap; the lift clears when the keyboard hides or the sheet closes. No
  effect on devices/browsers without `visualViewport` (guarded), and none
  while no sheet is open.
- Manual device test: Save sheet + rename field on a 375×667 viewport; password
  sheet on the same; rotate with the keyboard up.

## [v10.96] — 2026-07-06 — Accessibility: real modals for VoiceOver & keyboards

- **Sheets and scanner screens now behave as true modals for assistive tech.**
  Previously only pointer input was blocked (by the backdrop); VoiceOver and
  Tab could wander into the hidden toolbar/viewer behind an open sheet, or
  under the camera screen. Now everything behind an open layer is marked
  `inert` (header, toolbar, find bar, viewer, floating pills — and the scanner
  screens themselves when a sheet opens on top of them). One MutationObserver
  watches the three layer elements, so every open/close path stays correct.
- **Focus trap on the sheet.** Tab / Shift-Tab wrap inside the open sheet —
  containment even on engines without `inert` support.
- **Scanner screens get dialog semantics** (`role="dialog"`, `aria-modal`,
  labels "Scan document" / "Adjust edges").
- **Page pill is keyboard-reachable while visible** (tabIndex toggles with its
  visibility, Enter/Space opens Go to page) — previously `role="button"` with
  no way to focus it.
- **"N page(s) scanned" is now `aria-live`**, so VoiceOver hears each page
  being added during a scan session.

## [v10.95] — 2026-07-06 — Camera: no re-prompt after switching apps mid-scan

- **Switching apps mid-scan no longer re-asks for camera permission.** Hiding
  the app used to stop the camera tracks, so returning called `getUserMedia`
  afresh — and standalone iOS re-shows its permission prompt on every fresh
  call. The stream is now KEPT across brief hides (detection paused, exactly
  like the per-page pause from v10.52) and only released after 60 s hidden, or
  when the app really closes (`pagehide`/`releaseAll`, unchanged). iOS
  suspends camera capture in the background anyway, so keeping the muted
  stream costs no battery and no privacy indicator.
- **One-time explainer on installed iOS.** The cross-LAUNCH prompt is a WebKit
  platform limitation — getUserMedia grants are not persisted for standalone
  home-screen web apps (WebKit bugs 215884 / 185448) and no web API can change
  that. The first scan on an installed app now says so once, so the recurring
  prompt reads as an Apple limitation rather than an app fault. Shown only in
  standalone display mode; browser-tab use never sees it.
- Manual device test matrix: scan → home → return <10 s (no prompt, live box
  resumes); scan → home → return after >60 s (prompt expected — stream was
  released); scan → lock → unlock; crop screen → home → return → Retake.

## [v10.94.1] — 2026-07-05 — Regression round for v10.85–v10.94 (tests only)

- **Full regression + validation pass over everything added since v10.85.**
  Found and fixed: `tests/harness.mjs` (91 checks) was never wired into
  `npm test` and still asserted the old "scan.pdf" name — assertion updated to
  the dated pattern and the harness added to the test script.
- **New feature-regression checks (N1–N5 in scenario-tests):** recents list
  records/dedupes/orders correctly; undo budget scales 10→3 steps past 24MB;
  per-document view memory saves zoom and restores it on reopen; `docHasText`
  classifies a text PDF as text (PNG path) and a scan as image-only (JPEG
  path); the scanner quad locks after steady frames and unlocks on a jump.
- Suite totals: **170 checks across 6 files, all passing** (13 colour, 15
  detect, 4 guard, 30 scenario, 17 version, 91 harness). Static validation
  clean: build 10.94 consistent across app.js/sw.js/index.html, manifest and
  package.json valid JSON, all SW app-shell and referenced splash files
  present, all five JS files parse. No app code changed in this round.

## [v10.94] — 2026-07-05 — Instant open, faster scans, capture feedback

- **Open a PDF while the engine is still starting.** Open and the welcome
  button are enabled immediately (the file picker needs no engine); a file
  picked during the 1–3s WASM compile is stashed and opened the instant the
  engine is live, with a hint confirming it. The launch splash also fades as
  soon as the welcome screen exists, so the app is interactive during boot
  instead of hiding behind the logo. Perceived cold-start ≈ zero.
- **Scanned/image PDFs render as JPEG.** Lossless PNG rendering (v10.55) only
  pays off on born-digital text pages; on image-only documents it was 3–5×
  larger and slower with no visible gain. Text presence is sampled once per
  document version (`docHasText`); scans now take the JPEG q94 path — faster
  page display, less memory, on the app's main use case.
- **Capture feedback.** The shutter fires an iOS-camera-style white flash, and
  the green box gains a LOCKED state: after ~0.9s of holding steady it draws
  bolder with white corner ticks — the "safe to capture now" signal.
- **Battery:** once locked, live detection relaxes from every 300ms to every
  600ms (a steady scene needs no re-detection); any jump or miss restores full
  rate instantly. Detection already paused when the app is hidden.

## [v10.93] — 2026-07-05 — OLED visual refresh (styles.css only)

- **True-black chrome.** Header, toolbar and find bar now sit on pure #000 with
  0.5px translucent hairlines (`--line` is now the iOS separator colour) — on
  an OLED screen those pixel rows switch off entirely, the page becomes the
  only lit surface, and battery benefits slightly. Sheets and cards keep the
  elevated greys.
- **Floating pills get the iOS bar material.** Zoom and Undo pills use a
  translucent background with `backdrop-filter` blur+saturate, matching the
  status toast and page pill that already had it.
- **Page framing.** Each page has a 0.5px light outline and 4px radius, so
  pages read as floating sheets — dark scans no longer melt into the black
  background.
- **Clearer active mode.** The active Edit/Select/Sign segment is a soft
  accent-tinted pill instead of a solid gradient block.
- **Consistency pass.** Radius scale standardised (12 controls · 16 tiles ·
  24 sheets — was a mix of 9/10/11/13/15/20), all `--line` borders are now
  0.5px hairlines, and button press feedback is a uniform fast scale(0.96)
  (reduced-motion unchanged: no transforms).
- Zero logic changes — this release touches styles.css only (plus version
  bumps), so behaviour, tests and the scanner are untouched.

## [v10.92] — 2026-07-05 — Photos → PDF: size budget, dated name, welcome button

- **Photos → PDF output is dramatically smaller.** The feature embedded the
  original camera bytes untouched, so five 12MP photos made a ~15–20MB PDF.
  Photos over ~1.8MB are now downscaled to max 2200px and re-encoded (JPEG
  q85) — visually identical on a page, a fraction of the size. Small images
  and PNGs are still embedded untouched; on any processing error the original
  bytes are used, so nothing can fail that worked before.
- **Dated default name** ("Photos 5 Jul 2026 14.30.pdf") instead of every
  export being "images.pdf", matching the scan-name convention (v10.85), and
  the done message now shows the resulting file size.
- **"Photos to PDF" button on the welcome screen.** The feature existed only
  inside More → Create, invisible to new users; it's now a third big button
  under Open/Scan.

## [v10.91] — 2026-07-05 — Reopened documents return to where you left off

- **Per-document view memory.** Zoom level and reading position are now saved
  (throttled, on zoom/scroll, keyed by filename, last 20 documents) and
  restored when the same document is reopened from Recents or session restore
  — the file comes back at the exact page and zoom you left, like a proper
  reader. Best-effort: if nothing was stored the document opens at page 1 /
  100% exactly as before.
- Double-tap zoom already existed (toggles 100%↔200% centred on the tap); this
  completes the "viewer niceties" pair.

## [v10.90] — 2026-07-05 — Memory guard for large documents

- **The undo budget now scales with document size.** Previously a 20MB+ scanned
  file could hold up to 10 full snapshots (plus the working copy, engine and
  page rasters) — enough to breach WKWebView's hard memory limit on older
  iPhones, where iOS kills the app silently and the session is lost. Now: files
  over 24MB keep 3 undo steps (48MB budget), over 8MB keep 5 (80MB), small
  documents keep the full 10-step / 120MB history as before.
- **Stale thumbnails are dropped on every edit.** Page thumbnails were only
  evicted by a 400-entry LRU cap, so a long editing session kept hundreds of
  dataURLs from old document versions alive; the cache is now pruned to the
  current version whenever the bytes change.
- **Large-document notice on open.** Files over 24MB or 150 pages now say up
  front that undo history is shortened and rendering lightened, instead of
  applying the safeguards silently.
- Existing protections unchanged: >150-page docs render at 2× with a 2600px
  cap, offscreen pages release their bitmaps, snapshots are skipped entirely
  above 48MB per copy.

## [v10.89] — 2026-07-05 — Install polish: manifest, maskable icon, landscape splash

- **Manifest completed:** stable `id`, `categories` (productivity/utilities),
  and a dedicated `icon-maskable-512.png` — the app icon content scaled to the
  80% safe zone on a full-bleed background, so Android launchers no longer risk
  clipping the artwork (previously the plain icon doubled as maskable).
- **Landscape launch screens.** Ten landscape variants of the iOS startup
  images were generated (dimensions swapped, logo centred) and declared with
  `orientation: landscape` media queries — a landscape cold launch now shows
  the branded splash instead of a white flash.
- **Housekeeping:** stray write-test artifacts removed from `backups/`;
  `package.json` gains an `npm test` script running the full 5-file suite and
  moves jsdom to devDependencies. Confirmed `backups/` and `tests/` are already
  excluded from deployment via .gitignore + DEPLOY.md (nothing to fix there).
- Maskable icon added to the SW app-shell precache.

## [v10.88] — 2026-07-05 — Hardening: storage failures surfaced, SW cache constrained

- **Storage failures are no longer silent.** All persistence writes (session
  backup, incremental scan pages, recents) previously swallowed every error;
  on a storage-full iPhone they quietly stopped working. Quota-type failures
  now surface once per session as a clear warning toast ("device low on
  storage — unsaved-work backup and Recents are paused"); the app keeps
  running and explicit saves are unaffected. Audit note: user-initiated
  actions (open/save/export/compress) already reported failures via
  `friendly()` + status; the remaining ~50 empty catches are benign cleanup
  (destroy/focus/revoke) and were deliberately left alone.
- **`navigator.storage.persist()` requested at startup** so iOS is less likely
  to evict session-restore and recents data after periods of non-use.
- **Service worker runtime cache constrained.** The fetch handler cached ANY
  same-origin GET into the app cache forever (cache-first, no expiry). It now
  only caches known asset types (html/css/js/json/webmanifest/png/svg/wasm/
  fonts); anything else passes through to the network uncached.

## [v10.87] — 2026-07-05 — Scanner: stop the box landing on tables and beds

- **Work-table (wood) and bed surfaces no longer attract the green box.** The
  key observation: a document you're aiming at sits INSIDE the frame, while a
  table or bed runs OFF its edges. New `borderFrac` measures how much of a
  candidate's outline hugs the frame border:
  - **Off-frame surface penalty (soft):** score scaled down with border
    contact, and cut hard (×0.35) once >60% of the outline is on the border —
    so any real document elsewhere in frame always outranks the surface. Never
    a hard rejection: a lone page framed edge-to-edge (D6) still detects.
  - **Wood gate (hard):** a candidate that is BOTH >60% off-frame AND has a
    warm-saturated interior (brown/orange, R>G>B — wood tones) is rejected
    outright; that is never a page or an ID card.
  - **Stronger saturation penalty:** starts at 0.30 saturation (was 0.45) with
    more weight, so bare wood scores low even away from the borders.
- New tests: D13 off-frame wooden surface alone → no box; D14 page lying on a
  wooden table → page detected to 1px; D15 page beats a much larger off-frame
  bed-sheet region. Full 68-test suite green.
- Known limit (unchanged): an empty neutral bed sheet filling the whole frame
  with nothing else in view is geometrically a huge white page and may still
  box occasionally; the moment a document enters the frame it wins.

## [v10.86] — 2026-07-05 — Scanner: detect documents, not surfaces

- **The live green box now prefers things shaped and toned like a document**
  instead of latching onto any large bright/dark patch (a tabletop against the
  floor, a keyboard, a tile). Three "document priors" were added to the shared
  detector in `scan-core.js`:
  - **Corner-angle gate (hard):** all four corners must be within 90° ± 25° —
    real pages and cards seen by a hand-held phone are near-rectangular, while
    surface edges/shadows produce skewed trapezoids that now fail outright.
  - **Aspect-ratio prior (soft):** candidates near known document shapes score
    higher — A4/A5/Letter (~1.29–1.46) and ISO ID-1 cards (1.586 — PAN, Aadhaar
    card, voter card, driving licence all share this shape). Off-ratio shapes
    are down-weighted, never rejected, so receipts and odd sizes still detect.
  - **Tone prior (soft):** interior-vs-surround brightness contrast plus a
    low-saturation "paper/card face" preference — a patch of bare desk or a
    saturated mousepad scores low; a page or ID card scores high.
- Priors are deliberately soft (learned from the v10.40→10.41 over-eager
  detection revert): only the angle gate is hard, the gradient fallback keeps
  working for same-tone paper found by its shadow line (its tone prior is
  skipped by design), and manual crop is unchanged.
- New detector tests: D9 skewed trapezoid rejected, D10 ID-1 card detected,
  D11 A4 page beats a larger square distractor, D12 neutral page beats a larger
  saturated patch. All 12 detect tests and the full 65-test suite pass.

## [v10.85] — 2026-07-05 — UX: recent files, drag-reorder pages, dated scan names, what's-new

- **Recent files on the welcome screen.** The last 5 opened/saved PDFs are kept
  on-device (IndexedDB) and listed under the Open/Scan buttons — tap to reopen,
  or "Clear recents" to forget them. Password-unlocked documents and files over
  25 MB are never remembered (same privacy rule as session restore). A dead
  entry (storage evicted) removes itself when tapped.
- **Pages sheet: hold-and-drag to reorder.** Long-press (250 ms) a page row and
  drag it to its new position — neighbours slide out of the way live. The ↑ ↓
  buttons still work; a quick swipe before the hold matures still scrolls the
  sheet. Respects reduced-motion.
- **Scans get a dated default name** — "Scan 5 Jul 2026 14.30.pdf" instead of
  every scan being "scan.pdf", so saved scans are findable in Files. The save
  sheet still lets you rename before saving. (S9 test updated to match.)
- **"What's new" note after an update.** The first launch on a new build shows a
  one-line status toast saying what changed, instead of updating silently. Never
  shown on a fresh install.
- Version bumped to 10.85 (app.js, sw.js cache, index.html data-build).

## [v10.84] — 2026-06-28 — Header label: keep file size visible on long names

- **The header info label no longer hides the file size when the filename is
  long.** It was one string (`name • pages • size`) truncated with an ellipsis,
  so a long name cut off the size at the end. It is now two parts: the filename
  (which ellipsises as needed) and the size in its own non-shrinking span that is
  always shown. Page count was dropped per request — the label now reads
  `filename  •  size`.

## [v10.83] — 2026-06-28 — Crop: drag whole sides (edge handles)

- **The adjust screen now has a handle in the middle of each side**, in addition
  to the four corners. Grab a side's bar and the whole edge follows your finger
  (both of that side's corners move together, any direction), so you can pull a
  single side in/out without nudging two corners separately. Corners, whole-box
  drag, keyboard-arrow nudge and the magnifier loupe all work the same on the new
  edge handles, and adjusting an edge counts as a manual selection (honoured
  exactly, no auto-inset).

## [v10.82] — 2026-06-28 — Photo ID: fix wash-out on dark-surface captures

- **Photo ID cards shot on a dark surface no longer come out pale/washed.** On a
  dark background the camera over-exposes the card (it's already bright), and the
  old fixed brightening (gamma 0.72) pushed it further toward white, fading the
  flag colours and greying the text. `idCardEnhance` step 2 is now a
  BRIGHTNESS-ADAPTIVE shadow lift: it only lifts shadows/midtones (below a knee)
  and scales the strength down as the card's overall brightness rises — a
  dark/normal card still gets a strong face lift, an over-exposed card barely
  any, so it isn't blown out.
- Added a gentle hue-preserving contrast (+6%) and saturation (+15%) restore to
  bring back the faded colours and deepen grey text, tuned mild so a well-exposed
  card stays natural.
- Photo ID only; documents and every other mode untouched.

## [v10.81] — 2026-06-28 — Fix scan file size on iPhone (MuPDF encoder)

- **Scan pages now actually honour the size budget on iOS.** Root cause: iOS
  Safari's `canvas.toBlob('image/jpeg', q)` IGNORES the quality argument, so the
  adaptive `encodeUnderBudget` step-down produced the same large blob at every
  quality and pages stayed ~1.8 MB regardless. The page is now JPEG-encoded with
  the bundled MuPDF codec (`Pixmap.asJPEG(quality)`), which honours quality
  precisely, and the quality is stepped down (from 92, floor 78) until the page
  fits the ~1.4 MB budget. A dense form that used to come out 1.8 MB now lands
  ~1.0 MB at quality 78.
- Encoding only — the pixels (all colour/contrast, Photo ID, crop, whiten work)
  are unchanged; this just changes how the already-finished image is compressed.
  Falls back to the old canvas encoder if MuPDF is unavailable, so nothing breaks.

## [v10.80] — 2026-06-28 — Restore document colour depth

- **Document scans regain the v10.76 / v3 punch.** v10.77 had made the document
  auto-contrast hue-preserving and softened it (percentiles 2/98 → 1/99) — needed
  then because ID cards ran through this same path, but it left text pages
  brighter and washed (blue ink and red letterhead noticeably duller). Now that
  Photo ID has its own `idCardEnhance` path, `applyAutoContrast` is restored to
  the original PER-CHANNEL 2/98 stretch, which deepens coloured ink and gives
  documents their vivid scanned look. The document colour pipeline is now
  identical to the v10.76 build the scans were tuned to.
- Photo ID mode is unaffected (it does not use this path), so the ID-card colour
  fix stays.

## [v10.79] — 2026-06-28 — Photo ID mode (card on a white A4 page)

- **New "Photo ID" mode** on the adjust screen, beside Standard / Small / Whiten.
  Frame just the ID/photo card and tap Use page: the card is perspective-warped,
  processed light and colour-true — a partial (55%) white balance for accurate
  colour, a gentle midtone gamma lift so the FACE stays bright, a light unsharp,
  and crucially NO ink-deepen / no whiten — then composited centred in the upper
  third of a clean white A4 page, the way a flatbed (Epson) ID scan looks.
- Turning Photo ID on switches Whiten off (the document polish would fight the
  card look). The white A4 field compresses to almost nothing, so these pages are
  small despite the full-resolution card.

## [v10.78] — 2026-06-28 — Restore ink depth for handwriting (colour pen)

- **Handwriting and coloured pen are crisp and dark again.** v10.77's colour-safe
  `inkDeepen` gate skipped *any* chromatic pixel to protect photos — but blue and
  red PEN ink are chromatic too, so it stopped deepening handwriting and the
  prescription scans came out faded. The gate is removed: `inkDeepen` once more
  deepens all dark ink (strength back to 0.18) and the midtone lift is back to
  0.06. Because the pull is hue-preserving and tapers with brightness, a
  photographic mid-tone (an ID portrait) still only darkens a few percent and is
  never crushed — the heavy darkening that ruined the old ID scans came from the
  per-channel auto-contrast, which stays fixed (hue-preserving) from v10.77.
- Net result: ID cards keep the v10.77 natural colour, and text/handwriting
  regains its earlier depth.

## [v10.77] — 2026-06-28 — Fix colour cast on photos / ID cards

- **Captured colour is now preserved in the saved PDF.** On scans containing
  bright COLOURED content — a laminated ID/Aadhaar card, a photo — the output was
  coming out with a strong yellow cast, the portrait darkened and the QR code
  crushed to a solid black block, even though the live capture looked natural.
  Cause: `applyAutoContrast` stretched each R/G/B channel independently, which on
  coloured regions pulled the channels apart (toward vivid yellow) and crushed
  dark detail. It now computes the stretch on LUMINANCE and scales R/G/B by the
  same factor, so contrast still improves but hue and saturation are preserved.
  Percentiles eased 2/98 → 1/99 to stop dark crush.
- **`inkDeepen` is now colour-safe:** the dark-pixel deepening fades out on
  chromatic pixels, so photographs and coloured logos are left alone — only
  near-neutral ink is deepened. Strength trimmed 0.18 → 0.12 and the midtone lift
  0.06 → 0.04, so the result sits closer to the natural captured tone.
- Neutral text-on-white pages are mathematically unchanged (equal channels scale
  identically), so handwriting/prescription scans look exactly as before.

## [v10.76] — 2026-06-28 — Honour manual crop; tighter size budget

- **The adjust screen now honours your hand-placed edges exactly.** Previously
  "Use page" pulled all four corners 0.8% inward (`insetQuad`) to hide edge bleed
  from *auto*-detection — but when you positioned the corners yourself that inset
  was clipping wanted content near the page edge (e.g. the right-margin contact
  line). A new `cropUserAdjusted` flag is set the moment you move a corner, drag
  the whole box, or hit Reset; when set, the page is warped from your exact
  selection with no inset. The 0.8% trim still applies only to a fully
  auto-detected quad you didn't touch.
- **Size budget tightened to 1.4 MB** (from 1.45) with a slightly lower quality
  floor (0.78), so std pages land reliably under 1.5 MB.

## [v10.75] — 2026-06-28 — Natural "Lens" document enhance

- **Scans now get an Adobe Scan / Office Lens-style polish, but tone-preserving.**
  A new `documentEnhance` pass (scan-core.js) runs by default after the colour
  balance + illumination flatten, with three gentle steps: (1) *paperClean* —
  edge-preserving smoothing applied ONLY to bright, low-gradient paper pixels, so
  sensor grain on the blank page flattens (fewer JPEG bytes spent on noise → more
  quality per byte) while text/ink edges stay perfectly sharp; (2) *inkDeepen* —
  a soft tone pull on dark pixels only (≤18% at the darkest) so handwriting and
  print "pop"; (3) a light 1px luminance unsharp for crisp glyphs. The paper's
  natural cream tone and any watermark are deliberately NOT bleached to white.
- Gated on the existing "Whiten" toggle, so it can be turned off. Output stays
  under the ~1.45 MB budget via the adaptive JPEG step-down (a sparse page lands
  ~1.3–1.4 MB at high quality).

## [v10.74] — 2026-06-28 — Higher-resolution capture

- **The scanner now requests 4K (3840×2160) from the camera** with a graceful
  fallback chain (4K → 1440p → default) and a continuous-autofocus hint. On a
  Pro iPhone this is ~2.25× the pixels of the old 1440p request — the single
  biggest driver of scan sharpness (the warp + filters were never the bottleneck).
- **`std` mode warps to a 3200 px long side** (was 2560) so the higher-res frame
  keeps its detail, and a new **size-budgeted adaptive JPEG encoder** holds the
  file under ~1.45 MB (starts at q0.92 and only steps down if needed). `small`
  mode is unchanged.

## [v10.73] — 2026-06-27 — Consistent empty-state icons; review pass

- **The welcome screen now uses the app's own line-glyph icons** instead of the
  📄 / 📷 emoji. The two big buttons (Open a PDF, Scan a document) carry the same
  stroked SVG set as the toolbar and More menu, so the first thing you see on
  launch matches the rest of the app rather than rendering platform emoji.
- **Review confirmation (no behaviour change):** verified that destructive actions
  are recoverable — Undo keeps up to 10 steps (memory-capped), and delete-pages
  (Organize), Combine and Compress all push an Undo step; on very large files where
  a snapshot would risk the iOS per-tab memory limit the action still proceeds and
  says so. Rasterising a text PDF during Compress already asks first
  (Keep text / Make smallest). Rotated-page text edits and signature placement
  already warn before they run. The README "Known limits" note was updated to
  describe that warning rather than imply a silent limitation.
- Every long-running action shows specific spinner text (e.g. "Combining 3 PDFs…",
  "Compressing… page 4 of 12"); confirmed no action falls back to a bare
  "Working…".

## [v10.59] — 2026-06-24 — Find: fit, first-match, fresh box

- **The find bar now fits the screen.** The close ✕ was being clipped off the
  right edge on iPhone; the bar (and the main toolbar) are tightened so the whole
  row fits with no horizontal scroll.
- **The first match selected is now the topmost one.** Matches are sorted by
  reading position (top, then left) before navigation is built, so searching e.g.
  a name that appears above an email selects the name first instead of the second
  hit.
- **Reopening Find starts blank.** Closing with ✕ now clears the search box and
  count, so the next time you open Find it doesn't carry the previous term —
  matching iLovePDF / Acrobat behaviour.

## [v10.58] — 2026-06-24 — Find in document

- **New "Find in document" (More → Find).** Search the open PDF the way Acrobat
  or iLovePDF does: a slim search bar appears below the toolbar with a live count,
  prev/next arrows, and a close button. Type and every match is highlighted in
  amber across all pages; the current match is shown in a stronger amber with an
  outline and scrolled into view (centred by moving the viewer, never
  `scrollIntoView`, so the toolbar never gets pushed off screen on iPhone).
- **Matching** is case-insensitive substring (so "voic" finds "invoice"), powered
  by the on-device MuPDF engine — no regex, no whole-word mode, nothing leaves the
  device.
- **Visible pages are searched first** for instant feedback; the remaining pages
  are scanned in the background, so the count climbs in while you keep reading. The
  first match is selected automatically.
- Highlights stay aligned through pinch-zoom and width changes (they re-paint with
  the page), edits re-run the search so the count stays correct, and closing the
  bar or the document clears everything. 11 new automated checks cover count,
  navigation, substring matching, no-match, and teardown.

## [v10.57] — 2026-06-22 — Tighter, more precise text selection

- **Selection now hugs the glyphs.** v10.56 sized each line's highlight to the
  full text em-box (ascender to descender), so selecting a line of caps or digits
  — invoice number, dates, names — drew a box noticeably taller than the text.
  Each line is now clamped to its real visible band: from the cap/ascender top
  down to just below the baseline (a small descender allowance keeps letters like
  g, p and y covered). The result lines up with what is printed.
- Uses the per-line baseline and font size already returned by the on-device text
  engine, so there is no extra work and behaviour outside Select mode is unchanged.

## [v10.56] — 2026-06-22 — Select & copy text from a PDF

- **New "Select" tool in the toolbar.** Tap it to turn the open page into
  selectable text, then drag (or long-press on iPhone) over an invoice number,
  date, name or any other text and use the native Copy. Tap the button again to
  return to normal viewing.
- **How it works.** Pages are rasterised to images for crisp display, so there is
  no text to grab by default. Select mode lays an invisible, correctly positioned
  text layer over the page image (the standard PDF.js technique), reusing the same
  on-device structured text the editor already extracts — no extra engine work and
  nothing leaves the phone. The highlight you see sits over the real glyphs
  underneath, so selection lines up with what is printed.
- **Nothing else changed.** The layer is completely inert outside Select mode
  (not selectable, ignores pointer events), so scrolling, pinch-zoom, Edit, Sign,
  Unlock, Compress and Save behave exactly as before. Only text-based PDFs expose
  selectable text; a page that is purely a scanned image has no text to select.

## [v10.55] — 2026-06-22 — Sharper rendering (lossless PNG for normal docs)

- **Crisper text, closer to Preview/Acrobat.** The display bitmap for normal
  documents is now lossless PNG instead of JPEG, removing the faint compression
  ringing around thin glyphs and hairlines. At deep zoom (raster over ~2800px)
  and for very long documents (150+ pages) the renderer still uses fast JPEG q94
  to keep zooming and scrolling responsive and memory in check.
- **Sharper deep zoom.** The per-page pixel cap was raised from 3500 to 5000, so
  zoomed-in pages re-rasterise with more detail. (The page already rendered at the
  device pixel ratio, up to 3x, so fit-width viewing was retina-sharp; this mainly
  helps when you zoom in.)
- No quality was lost in the earlier edge-to-edge change — that slightly increased
  the render width, if anything.

## [v10.54] — 2026-06-22 — Edge-to-edge page view

- **The page now fills the width.** Viewer side gutters dropped from 12px to a
  4px hairline, top padding trimmed, and the gap between pages reduced, so a page
  uses essentially the full screen width for the largest readable size. Pages stay
  top-aligned and horizontally centred. (A portrait A4 on a portrait phone is
  width-limited, so some backdrop remains below a single short page — filling that
  too would require horizontal scrolling, which is worse.)

## [v10.53] — 2026-06-22 — Fix: editing encrypted invoices ("invalid page number")

- **Encrypted-but-openable PDFs now open editable.** Many invoices (banks, telcos
  such as amaysim) are encrypted with an *empty user password* plus an owner lock
  that disables copy/edit. mupdf opens them with no prompt, but the document is
  still encrypted, so the first in-place edit re-saved a broken encrypted copy —
  its pages collapsed, producing "Async error: invalid page number" and a
  "0 pages" header. On open the app now detects encryption
  (`getMetaData("encryption") !== "None"`) and decrypts the working copy with the
  same lossless transform as the Unlock action (`decrypt,garbage`). Empty-password
  decryption asks nothing of the user; it only strips an owner lock mupdf may
  already ignore. The decrypted copy is treated as sensitive (never auto-persisted).
- **Editing is now crash-safe on malformed PDFs.** `buildSpanBoxes` is
  bounds-checked against the live page count, and its (async) call from text mode
  is `.catch()`-guarded, so a page mupdf can't read is skipped quietly instead of
  surfacing an uncaught async-error banner.
- Root cause was confirmed against the real engine; this was not a regression from
  the toolbar redesign (the render/page/edit code was unchanged). Two regression
  tests added (VR16, VR17). All 129 tests pass.

## [v10.52] — 2026-06-22 — Fewer camera prompts, tighter chrome, toolbar #4

- **Scanning now asks for the camera once per session, not once per page.**
  `captureFrame()` used to fully stop the camera after every shot, so returning
  for the next page called `getUserMedia()` again and iOS re-showed its
  permission prompt each time. The stream is now kept alive across capture →
  crop → next page (edge-detection is paused, not the camera) and only released
  when you leave the scanner. Note: the prompt on each *cold launch* of the
  installed PWA is an iOS platform limitation — standalone PWAs can't persist
  camera permission and there's no web API to request a permanent grant (unlike
  Android). The camera indicator stays on while you're on the crop screen, as in
  native scanner apps.
- **More page, less chrome.** Header and toolbar padding/sizes were trimmed for
  roughly 18px more page-viewing height, without crowding the controls.
- **Sign and Unlock promoted to the toolbar.** The segment group is now
  Edit · Sign · Unlock · Compress · More (Unlock sits right before Compress).
  Both were removed from the More menu to avoid duplication.
- **Undo moved to a floating control.** It now appears as a pill (bottom-left)
  only when there's something to undo, freeing a top-bar slot. It still covers
  every undoable action (edits, signatures, compress, etc.), not just text edits.
- **More menu regrouped** into Create (Scan, Photos → PDF) · Pages (Combine,
  Organize, Copy pages, Go to page) · Export (Save image, About).
- All 127 tests pass; CSP unchanged (no inline styles, no network fetches).

## [v10.51] — 2026-06-21 — Toolbar redesign: icon + label, grouped More menu

- **Top toolbar is now icon + label.** Every action (Open, Edit, Undo, Compress,
  More, Save, Close) shows a line glyph above its caption, making the bar quicker
  to scan and the active Edit state clearer. Layout, button IDs, and behaviour are
  unchanged — purely a visual treatment, styled from `styles.css` (no inline
  styles, so `style-src 'self'` is preserved).
- **Zoom no longer disappears on iPhone.** The − / + zoom control moved out of the
  toolbar into a floating pill (bottom-right, above the page) that appears only
  while a document is open. Previously `@media(max-width:599px)` hid zoom on every
  phone, leaving pinch/double-tap as the only option.
- **More menu redesigned as a grouped icon grid** (Pages · Content · Export)
  instead of a flat list of full-width rows — the iLovePDF/Acrobat-style layout.
  All actions and their IDs are unchanged. Drops to 3 columns on narrow phones.
- Icons are inline SVG (vendored, `currentColor`), so nothing is fetched over the
  network and the strict CSP is untouched. All 127 tests pass.

## [v10.50] — 2026-06-21 — Unlock PDF: password retry + opens in the viewer

- **Wrong password no longer fails the whole flow.** The password dialog now
  stays open and shows an inline "Wrong password — N tries left" message, giving
  up to 3 attempts before it gives up. Applies to opening any protected PDF, not
  just the Unlock action.
- **A successful unlock now opens the PDF in the viewer** instead of going
  straight to a share sheet. Tap **Save** to keep the unlocked copy (still
  lossless — original quality and size). If you start another action first, the
  usual "Unsaved changes" prompt appears so you don't lose it, exactly like every
  other in-progress document.
- The decrypt itself is unchanged (mupdf `decrypt`, no image re-compression);
  this release only changes the password UX and where the result lands.

## [v10.49] — 2026-06-21 — New: Unlock PDF (remove password)

- **More ▾ → 🔓 Unlock PDF (remove password)** — added directly under "Add my
  signature". Pick a password-protected PDF, enter its password, and the app
  saves an unlocked copy (`<name>_unlocked.pdf`) with the encryption removed.
- **Lossless — original quality and size preserved.** The unlock uses mupdf's
  `decrypt` save, which rewrites the file WITHOUT re-compressing any image or
  content stream. Verified against a 256-bit AES-encrypted test PDF: every
  embedded image stream is byte-identical to the source and the output is within
  a few hundred bytes of the original size.
- Runs as a standalone utility — it does not disturb whatever is currently open
  in the editor, and is available even with no document open. Non-protected PDFs
  report "nothing to remove"; a wrong password reports clearly and changes
  nothing.

## [v10.48] — 2026-06-20 — Revert 4K capture (clean forward version) + quiet benign errors

- **Reverts the 10.47 higher-resolution scan capture** (the camera is back to the
  2560 request and 2560 output cap). Shipped as a version AHEAD of 10.47 rather
  than re-deploying 10.46, so the service-worker cache updates forward cleanly
  instead of backwards (a backwards version can leave a mix of old and new files
  during the update — a common cause of transient load errors). Build 10.47 is
  skipped on purpose.
- **No more alarming "Script error." banner.** iOS reports many benign
  cross-context errors as an opaque "Script error." with no detail while the app
  keeps running. Those are now ignored instead of shown in the status bar; when
  the browser does provide real detail it's still captured. A genuinely failed
  engine load is still surfaced by the watchdog.

## [v10.46] — 2026-06-20 — Fix: editing a scanned/image PDF balloons the file

- **Editing text on an image-based PDF no longer bloats the file ~10x.** When a
  page is a full-page image (a scan, or a card like the Amaron warranty), the
  redaction that removes the old glyphs re-rasterises the whole page image to
  UNCOMPRESSED RGB — a 2.3 MB file was ballooning to ~26 MB after one edit. The
  redaction save now re-compresses images, bringing it back to ~2.8 MB. Verified
  on the real Amaron PDF; harmless on ordinary text PDFs.

## [v10.45] — 2026-06-20 — Colour-fill sampling verified against a real card

- **Coloured-cell edits keep the panel colour — verified on the Amaron card.**
  Tested the background sampler against the actual warranty PDF: the median was
  always the right green, but short labels (Type, Code) fell just under the
  confidence bar and still went white. Widened the colour-match tolerance so a
  solid majority of the ring is recognised as the panel colour; now every field
  (Warranty, Date, Type, Code, Customer, Mobile) samples the green and fills
  green, while photos still keep the safe white fill.

## [v10.44] — 2026-06-20 — Crop-corner box bug + stronger colour-fill sampling

- **No more stray box in the corner while cropping.** The crop corner handles are
  keyboard-focusable (arrow-key nudge), and iOS was drawing a focus rectangle in
  the corner after a touch-drag. That outline is now suppressed; the white grip
  still shows the active corner.
- **Coloured-cell edits sample the colour more reliably.** The background sampler
  now renders at a higher resolution, samples a little further from the text's
  anti-aliased edge, and tolerates texture / a few border pixels — so editing a
  field on a textured colour panel keeps the panel colour instead of a white box.
  White backgrounds and photos are still handled as before.

Verified (no change needed): the scan warp/colour/quality pipeline is byte-for-byte
identical to 10.39, and PDF merge is lossless (the merged page images are identical
to the sources). Differences in scan sharpness come from capture resolution/framing
and the Whiten toggle, not the app.

## [v10.43] — 2026-06-20 — Edit mode: pinch-zoom + scroll + colour fill

- **Pinch-zoom now works in Edit mode.** You no longer have to leave Edit mode to
  zoom in on a small field — pinch (and the − / + buttons) work while editing, so
  you can zoom in, tap the field, and change it in place. Only Sign mode keeps
  pinch off (its one-finger box drag would clash).
- **Scrolling in Edit mode** works in any direction now (the text boxes were
  limited to vertical pans); a tap with no movement still opens the editor.
- **Coloured-cell edits keep their colour.** Editing a field on a coloured panel
  (e.g. the green warranty table) was still leaving a white box, because the
  background sampler distrusted the ring when it clipped a dark grid line or
  glyph. It now accepts the sampled colour when it's the dominant colour of the
  ring, so the fill matches the cell — while a genuine photo/mixed background
  still falls back to white.

Scanner edge detection is left as-is (it's detecting well now); the manual
Adjust-edges crop remains the reliable path for awkward scenes.

## [v10.42] — 2026-06-20 — Reliable manual crop (move the box + Reset)

Auto edge-detection stays a best-effort hint; the dependable path is now the
Adjust-edges screen, which got two big usability additions:

- **Drag the whole box.** Dragging the interior of the crop box slides all four
  corners together, so when the outline is the right shape but the wrong place
  (e.g. it grabbed a keyboard), you can just slide it onto the document and
  fine-tune the corners — instead of dragging each corner from scratch.
- **Reset button.** One tap snaps the crop to a near-full-page rectangle, a clean
  starting point when auto-detection grabbed the wrong thing or nothing. Drag the
  box / corners onto the document from there.

The corner handles keep their enlarged hit areas, magnifier loupe and arrow-key
nudge from before.

## [v10.41] — 2026-06-20 — Revert over-eager edge detection

- **Reverted the 10.40 relaxed detection fallback.** On cluttered desks it
  over-included — outlining a keyboard/laptop together with the paper. Detection
  is back to the conservative confident passes, keeping only the safe centre-bias
  (prefer the document aimed at the middle of frame over an off-centre rectangle).
  When the live outline is wrong or missing, drag the corners on the Adjust screen.

## [v10.40] — 2026-06-20 — Better scanner edge detection

Two fixes for the live document outline, from real failure captures.

- **Stops locking onto the wrong rectangle.** The detector now applies a centre
  bias when choosing between candidates, so it prefers the document you're aiming
  at in the middle of the frame over a strong off-centre rectangle like a
  trackpad, keyboard or phone at the edge.
- **Finds faint-edged paper more often.** A relaxed fallback pass runs only when
  the confident passes find nothing, so plain paper on a pale or busy desk (where
  the edges are low-contrast) gets an outline instead of none. It stays safe from
  false positives: the fallback relaxes only the region pass (its fill guard plus
  a new per-side outline check still reject L-shapes), and walls / blank frames /
  the whole-frame case are still rejected. The detect-test fixtures (including the
  L-shape, blank and wall rejections) all still pass, with new fixtures for the
  centre preference and a ragged-edge document.

Edge detection on arbitrary real-world scenes is inherently imperfect; when the
live outline is wrong or missing you can still drag the corners on the Adjust
screen.

## [v10.39] — 2026-06-20 — Text edits keep background colour + fit width; scan/engine polish

- **Text edits keep the background colour (item 7).** Editing text that sits on a
  coloured cell, banner or shaded box no longer leaves a white patch. Before the
  original glyphs are erased, the app samples the colour of a thin ring just
  outside the text and fills with that instead of white. It only does this when
  the surrounding colour is a trustworthy flat colour and clearly not white —
  ordinary white-page edits are byte-for-byte unchanged.
- **Replacement text shrinks to fit.** A single replacement line that's wider than
  the original now shrinks just enough to fit the original width (down to half
  size at most) instead of running off the right edge.
- **"Whiten" guards photo-heavy pages.** Illumination flattening is skipped when
  more than 40% of the page is genuinely dark (a photo or dark-filled page), so it
  can't lift a big dark region into grey. Normal text scans are well under that.
- **Engine downloads once on first load.** The ~10MB WASM engine is no longer
  precached by the service worker AND fetched by the engine separately; the
  progress fetch now caches it to the vendor cache, halving first-load bandwidth.
  Offline still works (the fetch handler serves and re-caches it on later loads).

## [v10.38] — 2026-06-20 — Simpler page pill label

- **Page pill reads just "7 of 524"** now — the ↕ icon and the word "Page" were
  dropped for a cleaner, e-reader-style label. It stays tappable (the accent
  outline is the cue) and keeps its descriptive "Go to page, currently page X of
  N" label for screen readers.

## [v10.37] — 2026-06-20 — Tappable page pill (shortcut to Go to page)

- **The page pill is now a shortcut.** The "Page 3 of 12" indicator that appears
  while you scroll a multi-page document is now tappable — it opens the same Go to
  page dialog as More → Go to page. It gets a subtle accent outline and a ↕ hint
  so its tappability is clear, stays visible a little longer (2.5s) so it's
  comfortable to hit, and won't fade while your finger is on it. Go to page also
  remains in the More menu.

## [v10.36] — 2026-06-20 — Whiten paper, multi-line edit fix, drop auto-capture

- **"Whiten" — optional illumination flattening.** A new toggle on the scanner's
  Adjust-edges screen evens out shadows and uneven lighting so crumpled or
  shadowed paper reads as uniform white. It's halo-free by design: the background
  is estimated at a coarse scale (far larger than any glyph, so text can't pull it
  down), then applied as a gentle, clamped, brighten-only luminance gain that
  leaves hue unchanged and keeps text dark. On by default; toggle it off on the
  Adjust screen to compare before tapping Use page. New colour tests (F1-F3) cover
  flattening, text darkness and the no-halo guarantee.
- **Multi-line text edits no longer overflow.** A text "span" is a single line;
  if you typed newlines into the editor the replacement used to flow downward past
  where the original sat and over the content below. Newlines are now collapsed to
  spaces so the replacement stays on its line.
- **Auto-capture removed for good.** Per your call, the scanner stays manual-shutter
  only; the unreachable "Hold still…" auto-capture overlay was deleted.
- **Lighter detection overlay & trimmed edge bleed** carried over from 10.35.

## [v10.35] — 2026-06-20 — Scanner polish: trim edge bleed, lighter preview

- **Cleaner scanned borders.** Before warping, the four corners are pulled a hair
  (~0.8%) toward the centre, so a thin sliver of desk/shadow just outside the page
  edge is no longer sampled into the scanned border. The page's own white margin
  means no real content is lost.
- **Lighter live-preview overlay.** The green detection fill was heavy enough to
  tint the whole document while framing; it's now a light wash with a slightly
  bolder, brighter outline, so you can see what you're capturing.

## [v10.34] — 2026-06-20 — Fix: yellow/green cast on captured scans

- **Captured pages no longer pick up a yellow/green cast.** The scanner's
  "grey-world over the paper" white balance assumed the bright region was neutral
  paper under a warm or cool light. When the brightest thing in frame was a
  strongly coloured surface instead (e.g. a pink/magenta wall), neutralising it
  injected the complementary colour — a green/yellow tint — across the rest of
  the image. The white balance is now skipped when the bright region is clearly
  an off-axis colour (green sitting well above or below the red-blue midpoint, as
  with pink/magenta or green surfaces); contrast and crispening still run, so a
  genuine warm/cool cast on real paper is still corrected exactly as before. A
  new colour test (C6) covers the coloured-surface case, and the warm-paper
  correction tests (C1-C3) still pass.

## [v10.33] — 2026-06-20 — Scanner detection, engine progress & detection pooling

- **Live edge detection is snappy again.** The green auto-detect outline is back
  on the main thread, where the 300px detection costs well under a frame. Moving
  it into the worker (v10.30) had added a round-trip plus cold-start/fallback lag
  that made the outline slow to appear. The heavy full-res warp on "Use page"
  still runs in the worker. This also removes the problem where a slow detect
  could disable the warp worker for the session — detection no longer touches it.
- **Documents framed large are detected.** The "whole frame isn't a document"
  area cap was raised from 92% to 95%, so a page that nearly fills the viewfinder
  now gets the green outline. The reject fixtures (blank frame, bright wall,
  L-shape) still pass, and a new fixture covers the large-framed case.
- **First-launch engine download shows real progress.** The ~10MB engine now
  loads behind a live percentage bar on the welcome screen instead of a static
  "Loading engine…". Implemented through MuPDF's `instantiateWasm` hook (a single
  download, no vendor files changed); it falls back to the engine's own loader on
  any error and shows no bar at all on instant cached loads.
- **Detection scratch buffers are pooled.** The per-frame `mask`/`seen`/`stack`/
  `boundary`/`mag`/`dil` arrays are reused across calls (with correct zeroing),
  cutting main-thread allocation churn now that detection runs there every 300ms.
  A new idempotency test guards against stale pooled state.

## [v10.32] — 2026-06-20 — Fix: "Go to page" box zooming in and hiding the toolbar

- **The "Go to page" number box no longer zooms the page in.** Its input is
  `type=number`, which wasn't covered by the rule that keeps text fields at a
  16px font. iOS Safari auto-zooms the whole page whenever you focus an input
  smaller than 16px, and that zoom was what pushed the header + toolbar off
  screen (so you couldn't get back to page 1) — not the page scroll. All sheet
  inputs, including number fields, now use a 16px font, so focusing the box no
  longer zooms and the toolbar stays put. A version test locks this in.

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
