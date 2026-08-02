# Improvement plan — existing features

Written against v11.89. This is about making what is already there better, not
adding features. Ranked against the stated priorities: **edit, unlock, organise,
compress**.

Everything below is verified against the current source, not recalled.

---

## Blocking first — two open device bugs

Neither is a feature, but both are visible every time the app is used, and one
of them is in the scanner.

**B1. Black band below the bottom toolbar.** Intermittent, launch-time.
**B2. Camera preview opens small, then jumps to size.** Reproducible: force-quit
and reopen is clean (the permission prompt provides a layout settle); cancel and
reopen shows it.

Four attempts have failed on each. The next step should not be a fifth guess —
see **X1** below. Details are in `ISSUE-BRIEF.md`.

---

## Tier 1 — editing (the top priority, and the weakest feature)

### E1. Word wrap when a single-line edit outgrows its line
**The known outstanding gap.** `wrapLines` and `fitBlockSize` exist and the
paragraph path uses them; `applyTextEdit` — the single-line path — does not.
Type more than fits and the text runs past the line instead of wrapping or
shrinking.

Fix: measure the replacement at the original size; if it overflows, first try
shrink-to-fit down to a floor (the paragraph path already has this logic), and
only wrap to a second line when there is vertical room before the next line of
the document. Refuse and warn rather than overlap when there is neither.

Risk: low. Confined to the text-edit path; no capture or compression code.
Value: high — it is the single most-used feature and it visibly misbehaves.

### E2. Bold and italic in the typeface matcher
v11.54 matches the scanned typeface by rendering candidates and comparing ink
masks. It matches the *face* but not the *weight*: replacing a bold heading
gives regular text at the right size. The same ink-mask comparison can score a
bold and an italic variant as two more candidates.

Risk: low, and it degrades gracefully — a wrong pick is what happens today.
Value: medium-high. Bold headings are common in the documents being edited.

### E3. Show what will change before committing a scan edit
Editing a scanned word erases it from the image and redraws it. There is no
preview of the erase band, so a mismatch in the fill colour or the ink extent is
only visible after the fact. A cheap outline of the band being replaced, drawn
before you type, would make that judgement possible.

Risk: low. Value: medium — it is where this feature has gone wrong before.

---

## Tier 2 — organise

### O1. Multi-select in Organize
Every operation is one page at a time. Deleting six scanned blanks, or
extracting pages 4–9, means six trips. A selection mode with a count and the
existing actions applied to the set is the obvious upgrade.

Risk: medium — touches the organise model and its undo entries. Contained.
Value: high for any document over a few pages.

Deliberately *not* proposed: drag-to-reorder. Move earlier / move later was a
considered decision — a thumbnail is a poor drag target on a phone — and it
should stay.

---

## Tier 3 — compress

### C1. Predict the size before choosing
The Compress sheet offers five routes (High, Balanced, Smallest, Reach a size,
Scanned pages/MRC) with no indication of what each would produce. You commit,
look, and undo if unhappy.

Running each level against **one representative page** and extrapolating gives a
usable estimate for a few hundred milliseconds of work. Show it on each button:
*"Balanced — about 1.2 MB"*.

Risk: low. Read-only; the actual compression path is unchanged.
Value: high — it turns a guess-and-undo loop into a decision.

### C2. Show MRC's cost before applying it
MRC's saving is enormous and its cost is specific: small text is redrawn as a
1-bit stencil. That is exactly the thing a size number cannot convey. Render the
smallest text on the page both ways and show the pair before applying.

Risk: low. Value: high — it is the one compression option that can disappoint,
and it currently has to be judged after the fact.

---

## Tier 4 — scanner (beyond the open bug)

### S1. Reorder scanned pages before Create PDF
The thumbnail strip supports review, delete, retake and move — but only through
the per-page sheet. Given a stack scanned out of order, that is several taps per
page. Lower value than it looks, because retake-in-place already covers the
common case. **Listed for completeness; I would not do this before Tier 1–3.**

### S2. Blank-page detection is computed but passive
`looksBlank` already runs on capture and the result is stored on the page
record. It is not surfaced. Offering *"page 4 looks blank — remove it?"* at
Create PDF time costs nothing new, because the measurement already exists.

Risk: very low. Value: medium.

---

## Cross-cutting

### X1. A diagnostics recorder (do this before another attempt at B1/B2)
Both open bugs are transient and self-correcting, so any reading taken
afterwards shows healthy values. That is why four rounds of fixes have failed:
every one was built on inference from a screenshot rather than a measurement.

Record `getBoundingClientRect()`, `innerHeight`, `screen.height`, the video's
intrinsic size and its **rendered** rect, every frame for the first few seconds
after launch and after the scanner opens. One screen, one Copy button.

Risk: none — it only reads.
Value: it is the difference between fixing these and guessing again.

### X2. Retire the ad-hoc diagnostics into it
The camera timings live behind a press-and-hold on the scanner title and the
bottom-bar numbers live in About. Neither is discoverable. Fold both into X1.

---

## Suggested order

1. **X1** — the recorder. Cheap, no risk, and unblocks B1/B2.
2. **B1 + B2** — with real numbers rather than a fifth theory.
3. **E1** — word wrap. The known gap in the most important feature.
4. **C1** — size prediction. Small change, large everyday benefit.
5. **O1** — multi-select.
6. **C2**, **E2**, **S2** — in whichever order suits.

## Ground rules for all of it

- **No change to the capture path.** It is v11.77's and it is the version whose
  output was approved. Nothing in this plan needs to touch it.
- One change per release where quality could be affected.
- Snapshot before each; mark device-untested until confirmed.
