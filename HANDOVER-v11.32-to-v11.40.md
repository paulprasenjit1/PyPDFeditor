# Handover: everything changed after v11.31

> **v11.41 addendum (independent review, 27 Jul 2026).** All three complaints
> were re-investigated. The v11.39 and v11.40 fixes were verified sound — v11.40
> by measurement on the shipped code (520px still-frame detection: 11.9px
> worst-corner error at 4K vs 25.6px for the live quad). Two further root causes
> were found and fixed in v11.41: (1) the video-frame capture source caps A4
> scans at ~156–180 dpi even with perfect framing, so the camera now requests
> the 4:3 sensor mode (3024px short side) and the auto-fire resolution gate was
> raised to bind at 0.75× the frame's short side; (2) "viewing quality reduced"
> was reproduced as v11.33's paper snapping letterboxing non-paper-shaped
> captures (receipts) into A4, drawing them ~30% smaller on screen — fitToPaper
> is now aspect-gated at 20%. §3.3 below is therefore RESOLVED, pending the
> user's confirmation on a real device. A dated v11.40 snapshot exists at
> `backups/v11.40-snapshot-2026-07-27.zip`; v11.31 remains untouched.

**Written for whoever picks this up next.** It is a complete, unflattering
account of nine releases (v11.32 → v11.40) made in one sitting, what each one
touched, which of them broke working behaviour, and exactly how to undo any of
it. Where I am unsure, it says so.

Baseline: **v11.31**. Current: **v11.40**.

---

## 0. FIRST: you can go back to v11.31

`backups/v11.31-BEFORE-ALL-CHANGES.zip` is a complete, verified snapshot of the
app as it was before any of this began. To revert completely:

```sh
cd <app folder>
# keep backups/, delete everything else
unzip backups/v11.31-BEFORE-ALL-CHANGES.zip -d .
npm install          # only needed to run the tests
```

Then on the phone: delete the installed PWA from the Home Screen, reopen Safari,
and re-add it, so the service worker picks up the v11.31 cache name.

**This file nearly did not exist.** The single-restore-point policy adopted at
the start of the session meant `backups/restore.zip` was overwritten at v11.36,
v11.38, v11.39 and v11.40, destroying the v11.31 snapshot. It was recovered from
a temporary copy that happened to survive. **Do not adopt a
one-restore-point-only policy.** Keep a snapshot per baseline you might want to
return to, and never overwrite the one that represents "last known good".

`backups/restore.zip` is v11.40 (current). `backups/unused-assets/` holds 10
light-mode splash PNGs and `splash/_links.html`, removed from the published tree
because the app forces dark mode.

---

## 1. What was asked for, and what actually happened

The user asked for a plan to close the gap with Adobe Acrobat Pro DC and
iLovePDF, with priorities: **edit PDFs (most important), unlock, organise pages,
compress**, later adding **scan documents and ID cards**. He explicitly asked
for "solid daily frequently used operations", not niche features.

Nine releases were shipped in one session against a test suite of **406
assertions**, all green. **Two of those releases broke on the first real
document they met.** Both regressions were caught by the user, not by the tests,
because every fixture was invented rather than taken from his files.

That is the single most important thing to carry forward: **the test suite is
large and it is not a safety net for this kind of change.** It tests the rules
that were written, against the content those rules were designed for.

---

## 2. Release-by-release

### v11.32 — Auto capture (scanner)
**New:** the shutter fires itself when the document is framed and held still.
An Auto toggle in the scan title bar (persisted). A countdown ring on the
preview overlay. Refusal hints ("Hold still", "Move closer").

**Files:** `scan-core.js` gained `autoCaptureReady()`, `quadMaxCornerShift()`,
`AUTO` constants. `app.js` gained `evalAutoCapture`, `autoFire`, `disarmAuto`,
`startAutoRing`, `autoHint`, `flashCapture`, and `commitScanPage` /
`pushScanPage` (extracted from the "Use page" handler so auto and manual share
one pipeline). `index.html` gained `#autoBtn`.

**Behaviour change that matters:** with Auto on, a captured page **skips the
Adjust screen entirely**. The user never sees or corrects the crop.

**⚠ REGRESSION (fixed in v11.40, see §3.2).** The auto path warped from the
*live preview quad*, which is detected at a 300px working size and exponentially
smoothed. The Adjust screen detects at 520px on the still frame. Corner accuracy
was therefore ~12.8 source px instead of ~7.4 on a 4K frame, and corner error
**shears** a scan because those four points define the homography. Auto scans
came out visibly skewed. Reported by the user with a sample file.

### v11.33 — Real paper sizes for scanned pages
**Fixed a genuine pre-existing bug.** Pages were built as
`s = 842/max(w,h); addPage([w*s, h*s])`, which scales the long side to A4's
842pt but keeps the *captured* aspect ratio, so no scanned page was ever a real
paper size. Now `fitToPaper()` produces true A4/Letter/Legal with the image
letterboxed inside (nothing cropped, aspect preserved). A "Page:" control cycles
A4 → Letter → Legal → **As captured** (the old behaviour, still available).
Per-page rotation added to the scanned-page review sheet, stored as `/Rotate`
so it is lossless.

**Files:** `app.js` gained `PAPER_SIZES`, `fitToPaper`, `normaliseRot`,
`addScanPageTo`, `refreshPaperBtn`, `setScanPaper`. `index.html` gained
`#paperBtn`.

**Deliberately NOT done:** auto-rotate-to-portrait. A landscape certificate and
a sideways capture of a portrait sheet produce identical geometry; distinguishing
them needs to read text direction. This is documented in the source at the point
where the check would have gone.

**Note on a user complaint:** a scan that comes out landscape now produces a
landscape A4 page. v11.31 produced a landscape-aspect page from the same capture
(842 × 587.3pt vs 841.89 × 595.28pt), so this is not a change in shape. A
landscape page on a portrait phone is fitted to width and therefore shown
smaller and softer. **I could not find a v11.32+ change that reduces viewing
quality.** If a specific document still reads worse than at v11.31, it needs its
own investigation with a sample.

### v11.34 — Both sides of an ID card on one A4
**New:** a "Both sides" toggle inside Photo ID mode holds the front and
composites it with the back onto a single A4 page. One-sided output is unchanged
to the pixel (`compositeCardOnA4` delegates to the new two-slot
`compositeCardsOnA4`, and a single card reproduces the old geometry exactly).

**Files:** `app.js` gained `compositeCardsOnA4`, `takeIdSide`, `clearIdPending`,
`refreshIdTwoSideBtn`, `setIdTwoSide`. `index.html` gained `#idBothToggle`.

No regression reported.

### v11.35 — Scan into the open document
**New:** "Scan more pages" (More → Create) and "Scan more pages into this"
(Recents long-press) graft scanned pages onto the end of the open PDF instead of
replacing it. The pages are built and validated *before* the undo snapshot and
the graft, so a failure leaves the document untouched.

**Files:** `app.js` gained `scanAppendTo`, `appendScanToDoc`; `startScan` gained
an `append` argument.

No regression reported.

### v11.36 — Compress rewritten (per-image recompression)
**Fixed a genuine pre-existing limitation.** The old compressor had two moves: a
lossless structural pass worth a few percent, or rasterising every page to a
picture (destroying selectable text). Images are now recompressed individually
and in place, against the size they are actually **drawn** at, with everything
else in the file left byte-for-byte alone. Rasterisation demoted to a last
resort.

Effective DPI is read from the content stream's transformation matrix by running
each page through a MuPDF JS render device that draws nothing and only notes the
matrix. A CCITT Group 4 (T.6) encoder was written from scratch for images that
are *already* black and white.

**Files:** `app.js` gained `IMG_LEVELS`, `imageTargetSize`, `boxDownsample`,
`bilevelProfile`, `toBilevelBits`, the CCITT tables and `ccittG4Encode`,
`collectImageXObjects`, `measureImagePlacements`, `csNameFor`,
`recompressImages`; `runCompress` was rewired.

**Measured:** 2.92 MB → 620 KB (79%) on a synthetic photo-heavy page with text
compared character-for-character before and after. The G4 encoder is verified by
round-tripping through MuPDF's own CCITT decoder on ten generated bitmaps
including random noise and runs over 2560px.

**Not reported broken, but NOT verified on a real document.** It has never been
run against one of the user's actual PDFs. Treat that as untested.

### v11.37 — Paragraph editing + type controls
**New:** tapping a line could offer to edit the whole paragraph and re-wrap it.
Size, colour and typeface controls in the edit sheet.

**Files:** `app.js` gained `paragraphBlock`, `wrapLines`, `fitBlockSize`,
`pickFontKeyed`, `applyBlockEdit`, `TE_COLOURS`, `TE_FONTS`; `applyTextEdit`
gained an `opts` argument. `styles.css` gained `.teseg`, `.segb`, `.telbl`.

**⚠ REGRESSION (fixed in v11.39, see §3.1).** The grouping rules — same size,
same colour, even pitch, same column — are satisfied by address blocks,
label/value stacks and table rows. On a pharmacy invoice the editor grouped
unrelated fields into one "paragraph" and re-flowed them into a sentence.
Compounded by two further mistakes: paragraph mode was the **default** whenever a
block was detected, so one tap committed to it; and the overflow was reported
*after* the damage. Reported by the user with screenshots.

### v11.38 — Finger-drawn signatures
**New:** draw a signature with a finger instead of importing a photo. Up to
three kept on-device (IndexedDB), with a "Forget saved signatures" button. The
stroke tapers with speed; the export is cropped to the ink with a transparent
background. Placement is completely unchanged.

**Files:** `app.js` gained `sigsLoad/Save/Add`, `openSignSheet`, `openSignPad`,
`signPadToPng`; `startSign` now opens a sheet. `styles.css` gained `.sigpad`,
`.sigcard`.

No regression reported. **Untested on a real touchscreen** — the pad is driven by
pointer events and has only been exercised through a stub.

### v11.39 — Fix for the v11.37 regression
- Paragraph mode is now **opt-in**. A tap edits one line, as before v11.37.
- Any block with a **neighbour on its own baseline** is refused outright (that is
  the shape of a table row and of a label/value pair). This also declines genuine
  two-column magazine prose — a deliberate trade.
- The **body lines must agree on a right edge** within 4% of the measure. Prose
  has that margin because it caused the wrap; a list of values does not.
- **Overflow is asked about before anything is redacted**, via a dry run using
  the same font metrics the real pass will use. Declining leaves the document
  untouched. The undo snapshot moved after that decision.

### v11.40 — Fix for the v11.32 regression
- Auto capture **re-detects the edges on the captured frame** through a shared
  `detectQuadOnFrame()` at the shared 520px working size. The smoothed live quad
  is now only a fallback. Measured on a synthetic page with a known quad:
  **7.4px worst-corner error at 520px vs 12.6px at 300px.**
- A **resolution gate**: the warp's own long side must reach 1600px, capped at
  `min(frameW, frameH) * 0.75` so it stays reachable on 1080p. The submitted
  sample scan was 2142px at 183 dpi because the document filled only half the
  frame. Surfaces as "Move closer — fill the screen with the page".

---

## 3. The two regressions, in detail

### 3.1 Text editing on forms (v11.37, fixed v11.39)
**Symptom:** tapping text on a tax invoice re-flowed a block of unrelated fields
and pushed them past the space they had.
**Root cause:** geometric grouping rules with no test of whether the content is
the *kind of thing* that can be re-wrapped, combined with making the destructive
mode the default and reporting the failure after the fact.
**Fix:** §v11.39 above. **Verify with:** the user's `Bandana Bill 24Jul.pdf`.

### 3.2 Auto-captured scans cut with the wrong outline (v11.32, fixed v11.40)
**Symptom:** "scan quality also ruined than before"; sample file measured at
2142 × 1494px, 183 dpi, visibly skewed crop.
**Root cause:** warping from a low-resolution, deliberately-smoothed preview
quad; and no lower bound on output resolution.
**Fix:** §v11.40 above. **Verify with:** a fresh scan of a printed A4 page.

### 3.3 Open, unresolved
**"pdf reading viewing quality reduced".** Not reproduced. The submitted file is
the same page shape and the same 183 dpi that v11.31 would have produced from the
same capture, and nothing in the render path (`renderStage`, `viewerCssWidth`,
the PNG-vs-JPEG choice) was touched in any of these releases. **Needs a
side-by-side sample** — the same source PDF opened on v11.31 and on v11.40 — to
go further.

---

## 4. How to undo individual features without a full revert

| Feature | Turn off at runtime | Remove from code |
|---|---|---|
| Auto capture | Auto toggle in the scan title bar (persisted) | delete `evalAutoCapture` call in `startLiveDetect`; `autoFire`; `#autoBtn` |
| Paper snapping | "Page: As captured" in the crop filter row | `fitToPaper` returns the `auto` branch unconditionally |
| Two-sided ID | "Both sides" toggle (only shown in Photo ID mode) | `idTwoSide = false` and hide `#idBothToggle` |
| Paragraph editing | already opt-in; never offered on forms | `paragraphBlock` returns `single` unconditionally |
| Image recompression | no UI toggle | in `runCompress`, skip the step-2 block |
| Drawn signatures | choose "Use a photo of a signature" | `startSign` → `$("sigInput").click()` |

**To get exactly the v11.31 scanner behaviour without reverting code:** turn Auto
**off** and set Page to **As captured**. Both settings persist.

---

## 5. Test suite

`npm test` runs nine files, currently **406 assertions, 0 failures**:

| File | Checks | Notes |
|---|---|---|
| colour-tests | 13 | pre-existing |
| detect-tests | 15 | pre-existing |
| guard-tests | — | build-mismatch self-heal, pre-existing |
| textedit-tests | 59 | pre-existing (v11.29–v11.30) |
| editor-tests | 46 | **new** — paragraphs, signature crop |
| scan-tests | 72 | **new** — auto capture, paper, ID, append, resolution |
| compress-tests | 67 | **new** — DPI maths, CCITT round-trip, end-to-end |
| scenario-tests | 30 | pre-existing, boots app.js in jsdom |
| version-tests | 17 | pre-existing, version agreement |
| harness | 104 | pre-existing, end-to-end in jsdom |

**Conventions worth keeping:** helpers are sliced out of the shipped `app.js` by
comment marker and executed, so the tests measure the real source. Use
`new Function`, not `vm.runInContext` — a vm context has its own `Array`
intrinsic and pdf-lib's cross-realm-unsafe `instanceof` rejects arrays built
inside one.

**Convention worth fixing:** the fixtures are invented. The two regressions above
are now covered by fixtures cut from the user's real invoice, but everything else
is synthetic. **Before trusting any of this, run it against real documents.**

---

## 6. Untested / risky areas

- **Nothing has been run on an iPhone.** All 406 assertions are Node and jsdom.
  Camera behaviour, auto capture against a real lens, the signature pad under
  touch, and iOS PWA install behaviour are all unverified.
- **The compressor has never been run on a real PDF.** Verified only against
  synthetic fixtures.
- **The CCITT G4 encoder** round-trips through MuPDF's decoder but has never
  produced a file opened in Acrobat or Preview.
- **`measureImagePlacements`** keys images by `w:h:components:bpc`. Two different
  images sharing all four share an entry; the largest placement wins, which is
  conservative but not exact.
- **Paragraph editing** now declines two-column prose by design.

## 7. What was planned and never built

Annotations (highlight, underline, strikeout, ink, free text) via the unused
`PDFAnnotation` API; form filling via `PDFWidget`; true redaction UI on
`applyRedactions`; split into separate files; insert blank / duplicate page; add
a password; permissions-only unlock; bookmarks via `loadOutline`; new text boxes;
image insert/move/delete in the editor. OCR was excluded by the user's choice.

The vendored MuPDF build exposes `PDFAnnotation`, `PDFWidget`,
`applyRedactions`, `loadOutline` and full `PDFObject` stream access, none of
which the app uses.

---

## 8. If you are picking this up

1. Take a snapshot of whatever you consider "last known good" and **do not
   overwrite it**.
2. Get real documents from the user before writing any test fixture.
3. Ship one release at a time and have it used on a real phone before starting
   the next. Nine in one sitting is how both regressions above happened.
4. Prefer declining to acting. Both regressions were features that acted before
   the user agreed to what they would do.
