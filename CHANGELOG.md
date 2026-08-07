# Changelog — PyPDF Editor (iPhone PWA)

All notable changes to the on-device iPhone PWA. The "version" tag matches the
service-worker cache name (`CACHE` in `sw.js`); bumping it forces phones to fetch
the new build.

## [v12.15] — 2026-08-07 — Shadow patches: local paper level, page-relative cast guard

Reported: shadow spots and uneven lighting survive on every page. Measured on
that scan — **13–22% of each page reads as shaded paper** (luma 170–245) while
the page's own paper level is 255.

Two causes, both mine:

1. **One global paper level.** A patch whose paper sits at 200 is only ~30%
   whitened against a global 255, so it stays a grey wash. The whitening now
   uses a **local** level — an 88th-percentile grid (up to 24×24), smoothed,
   floored at 60% of the global level so a genuinely dark region can never be
   read as paper. This is what a flatbed's background removal does.

2. **A fixed colour guard.** A shadow carries a cast: 65% of the shaded pixels
   measured chroma ≥ 20, so v12.01's fixed guard refused to whiten them. Printed
   colour is far more saturated than a cast, so the guard is now relative to the
   page's own ink chroma ceiling — `clamp(0.45 × cCeil, 20, 60)`.

Measured with the whitening alone, on the reported pages:

| page | shaded paper |
|---|---|
| 1 | 13.7% → 8.0% |
| 2 | 21.9% → 11.4% |
| 4 | 12.6% → 4.9% |

Printed colour is untouched throughout — mean shift **0.0/255** on the pale
yellow letterhead band and on the MEDIMALL navy/red, the two things the fixed
guard existed to protect. No seams: in blank paper the largest row-to-row step
is 0.24 and column-to-column 0.41 (a visible seam would be > 3).

Blown highlights are not recoverable — where the capture clipped to white there
is nothing left to restore.

### Tests
277 in the scanner suite, all passing unchanged.

---

## [v12.14] — 2026-08-07 — Undo v12.02's additive lift; cap colour at the capture

Compared against daylight photos of five documents, run through both the
session-start build and today's:

| | photo | v11.90 (session start) | v12.13 | **v12.14** |
|---|---|---|---|---|
| MEDIMALL colour | L 60 c 54 | L 53 c 57 | L 81 c 54 | **L 53 c 53** |
| Kartick colour | L 65 c 67 | L 65 c 96 | L 111 c 66 | **L 83 c 75** |
| IgE colour | L 183 c 52 | L 205 c 83 | L 216 c 52 | **L 214 c 58** |
| total error | — | — | 1.27 | **0.80** |

The pattern: **v11.90 had the brightness right and too much saturation; v12.13
had the saturation right and was far too bright.** My own change caused the
second half.

### What I broke, in v12.02
That release made the three tone lifts **additive** to stop the contrast work
inflating chroma. It does stop it — but an added lift raises a *dark* colour far
more than a gain does. A navy logo that should sit at L 53 came out at L 81.

### The fix
1. The three lifts (white balance, midtone lift, illumination flatten) are
   **multiplicative again**, exactly as before this session. A dark colour stays
   dark.
2. The chroma a gain inflates is **taken back at the end**, against the level
   the camera actually captured. `measureColour` runs first, before anything
   touches pixels; `capColour` runs last, after `paperCrisp`. It scales chroma
   about each pixel's own luminance — hue and brightness untouched — and it
   **only ever takes back, never boosts**.

The page may be brighter and crisper than the paper. It may not be more
colourful than the camera saw it.

### Tests
277 in the scanner suite. SC304–SC308: inflated chroma is taken back to the
captured level, brightness is unchanged by the cap, a duller page is left alone,
the capture is measured before any pixel work, and all three lifts are
multiplicative. SC261/SC262 were rewritten — they pinned the additive behaviour
this release reverts.

---

## [v12.13] — 2026-08-07 — The sharpener stops manufacturing grain

Reported as "blackish grain over the entire page", on a five-page scan.
Measured on page 1 of it, in a blank area:

```
flecks (pixels < 200)                    1.667% of the area
their deviation from the local blur      mean -66.6, p10 -103.0
undershoot beyond -40                    1.485% of the area
```

Paper does not do that by itself. An unsharp mask carving flat texture does —
and since v12.03 the final pass runs at **SH 1.50**, where the pass before
v12.01 used 0.35. On a creased or shadowed sheet, fibre that the whitening ramp
only partly reaches gets driven into hard black flecks.

It is not JPEG (block-to-block std 6.2 against within-block 11.2) and not
colour (chroma 0 across the affected area). Both were checked first.

### The guard
```js
if (diff < 0 && L2[i] >= paper*0.72) continue;
```
The ink side of a real edge is well below the paper level, so it is untouched;
the paper side of an edge is only ever *brightened*, which still happens. What
is refused is the one operation with no legitimate use: making an
already-near-paper pixel darker.

On a synthetic page carrying paper fibre and a shadow gradient:

| | blank std | flecks | undershoot |
|---|---|---|---|
| v12.12 | 5.76 | 0.225% | 0.225% |
| **v12.13** | **2.55** | **0.008%** | **0.008%** |

28× fewer flecks, and the ink edge still sharpens (SC300) with its ink side
still deepening (SC301).

### Tests
272 in the scanner suite. SC298–SC302: a speck on paper is never carved darker,
no part of a blank page is driven dark, a real edge still sharpens, its ink side
still deepens, and the guard is expressed against the page's own paper level.

### Still open: colour accuracy
The second half of the report — "colour is not accurate to the original" — is
not addressed here. Measured against the camera photo of the same document:

| | true photo | v12.13 |
|---|---|---|
| paper | 193 | 255 |
| black print | 46 | 13 |
| grey mid-tone | 116 | 158 |
| green banner | 120 | 213 |

Neutral mid-tones rise 42 and the green rises 93. But the photo is a dim
room-light exposure, so "brighter than the photo" is not automatically "wrong",
and no digital original of that document exists in the project to compare
against. Guessing at it is what produced v12.09 and v12.10, so it waits for a
reference rather than another theory.

---

## [v12.12] — 2026-08-07 — Checked against every sample, not the latest one

Fair criticism, and correct: v12.08 through v12.11 were each tuned on whichever
file had just been sent, and each one broke a different document. v12.09 spared
the handwriting along with the letterhead; v12.10 spared neither; both were
"measured", on one file.

So this release measures the whole sample set: **34 page images** recovered from
every scan PDF in the project — the owner's own scans back to v11.73, three
iPhone Preview scans of the same documents, and the source photos. 24 of them
carry coloured ink.

### What the sweep found
The purely proportional gate from v12.11 (`0.60×cMax` to `0.95×cMax`) fails on
**one** page: a near-monochrome pharmacy bill whose most saturated ink is only
chroma 27. At 0.60× the gate collapses onto ordinary ink at 21, and its print
would have been lightened as though it were a logo — the v12.09 failure again,
on a document nobody had looked at.

### The fix: a floor under the gate
```js
const CH_LO = Math.max(28, cMax*0.60);
const CH_HI = Math.max(CH_LO + 8, cMax*0.95);
```
Across the sample set biro and printed black measure **15–24**, so nothing that
is merely ink reaches 28. With the floor the gate separates ink from printed
colour on **24 of 24** pages.

| | ink spared | printed colour spared |
|---|---|---|
| every page in the set | **0%** | **100%** |

Output on the reference page is unchanged from v12.11 — navy 48.5, pen 72.6,
black text 5.0 — because the floor only binds on pages the earlier gate got
wrong.

### The check is now permanent
SC293–SC297 carry the measured profile of all 20 coloured pages (cMax, ink
chroma, print chroma) and assert against the **shipped formula, read out of
scan-core.js**: ink spared on no page, printed colour spared on every page. Two
of them re-run the failed gates as tests —

- SC296: the v12.09 gate (18–40) spares handwriting → caught
- SC297: the v12.10 gate (35–70) spares nothing on our own scans → caught

Either release would have failed this suite before it shipped. That is the point
of it.

### Tests
267 in the scanner suite (was 262). All eighteen suites pass.

---

## [v12.11] — 2026-08-07 — The gate is read off the page, not off a reference image

v12.10 did not fix it, and the device output shows why. Measured on real scans
of the same prescription:

| build | navy logo (luma) | pen strokes (median) |
|---|---|---|
| v12.07 | 38.7 | 74.0 |
| v12.09 | 73.8 | 90.7 ← writing faded |
| v12.10 | **22.6** ← darker than ever | 72.6 |

### The mistake, twice
Both ramps were calibrated against an **iPhone Preview** scan, where the
letterhead measures chroma 66 and the biro 24. Our own pipeline does not produce
those numbers — by the time `applyAutoContrast` runs, the same letterhead is
31–38 and the same biro 20–22:

```
image             ink chroma p95    biro    logo
Preview                 83           24      66
device v12.07           40           22      34
device v12.09           55           19      38
device v12.10           39           20      31
```

So 18–40 spared the handwriting along with the logo, and 35–70 spared neither.
Both were measured — on the wrong image. Twice.

### What travels between captures
Not the absolute chroma, but the **relationship**: on any page, printed colour
is the most saturated ink there is and biro sits well below it. So the ramp is
now derived from the page's own **95th-percentile ink chroma** (`cMax`), running
`0.60 × cMax` to `0.95 × cMax`. Applied to the four images above:

| | gate | biro spared | logo spared |
|---|---|---|---|
| device v12.07 | 24.0 – 38.0 | **0%** | 71% |
| device v12.10 | 23.4 – 37.0 | **0%** | 56% |
| Preview | 49.8 – 78.8 | **0%** | 56% |

It lands between the two every time, whatever the capture looked like.
`documentEnhance`'s ink deepen computes the same measure, so the two cannot
drift apart. A page with no coloured ink (`cMax < 20`) spares nothing at all and
the curve is exactly as it was.

### Tests
262 in the scanner suite. The old SC288 pinned the two constants — it is
replaced by tests that pin the *derivation*, and SC289–SC292 run a page whose
colours sit where OUR pipeline puts them rather than where Preview does: the
logo is spared, the biro lands exactly where a neutral grey of the same
brightness lands (which is what "not spared" means), black print takes the curve
in full, and a black-and-white page is untouched.

Device-untested: the gate self-calibrates, so it should hold on a real capture,
but only a scan can confirm it.

---

## [v12.10] — 2026-08-07 — The colour ramp was catching the handwriting

Reported on a v12.09 scan: the pipeline had been ruined. It had — the
handwriting faded, and on a prescription the handwriting **is** the content.

Measured on the same input through three builds:

| | navy logo | pen strokes (median) | black text |
|---|---|---|---|
| v12.07 | 8,9,53 | **71.8** | 5.0 |
| v12.09 | 62,68,121 | **95.0** | 7.0 |
| **v12.10** | 47,54,107 | **69.9** | 5.5 |

### The mistake
v12.08's chroma ramp ran 18 → 40. Measured chroma on a real prescription:

```
black print   3       blue pen  24       navy logo  67       red subtitle  87
```

A pen stroke at 24 sat inside that ramp and was spared 27% of the contrast
darkening **as though it were a logo**. Blue biro is not print colour — it is
ink, and it has to darken like ink. The letterhead is two to three times more
saturated, so the two separate cleanly; the ramp was simply drawn in the wrong
place.

The ramp is now **35 → 70**, and `documentEnhance`'s ink deepen uses the same
figures — otherwise the pen would still be spared there.

### Result
Pen strokes are back to v12.07 darkness (69.9 against 71.8 — a shade darker),
black text is unmoved at 5.5, and coloured print keeps most of what v12.08/09
recovered: navy 47,54,107 against v12.07's 8,9,53.

The lesson is the one this project keeps relearning: a gate tuned on one thing
(a letterhead) has to be measured against everything else it will catch. The
chroma of the handwriting was never checked, and it was one measurement away.

### Tests
258 in the scanner suite. SC288b pins that the ramp starts above pen ink,
SC288c that it still covers printed colour, and SC288d that the ink deepen uses
the same gate — the three facts that, taken together, are this bug.

---

## [v12.09] — 2026-08-06 — Coloured ink at 25%, after seeing all three side by side

`COLOUR_KEEP` 0.40 → **0.25**. One constant; nothing else in the pipeline moved.

Simulated on all three reported documents against their iPhone Preview
counterparts before changing anything — coloured ink as a share of Preview's
brightness, with the neutral black text beside it:

| | prescription | med bill | doctor's bill | black text |
|---|---|---|---|---|
| keep 0.40 (v12.08) | 67% | 75% | 70% | 7.1 / 5.2 / 13.9 |
| **keep 0.25 (this)** | **78%** | **84%** | **82%** | **7.2 / 5.3 / 13.9** |
| keep 0.00 | 96% | 99% | 103% | 7.4 / 5.3 / 13.9 |

Verified on the shipped build, not just in simulation:

```
prescription   iPhone 117,115,154   v12.09  92, 89,127   78%   black text 7.2
med bill       iPhone 128,132,169   v12.09 107,111,147   84%   black text 5.3
doc bill       iPhone 170,132,104   v12.09 145,107, 79   82%   black text 13.9
```

**Black text does not move at any setting** — 7.2 / 5.3 / 13.9 at 0.25 against
7.1 / 5.2 / 13.9 at 0.40. This axis touches coloured pixels only, so nothing
from v12.01's paper flatten or v12.03's ink flatten and sharpening is at stake.

### Why not 0.00, which matches Preview almost exactly
At zero a coloured pixel takes **no** contrast recovery at all. On a well-lit
page that is exactly right, and the numbers say so — 96/99/103%. On a dim
capture a pale stamp or a light-red header would then stay as washed out as the
camera saw it, because the stretch that would have rescued it no longer applies
to it. 0.25 keeps that safety net and is visibly the same colour.

The 96–103% figures also flatter themselves: the simulation's input *is*
Preview's own image, so removing all the darkening returns roughly where it
started. On a real capture the same setting would land a few points lower.

### Tests
255 in the scanner suite, unchanged — SC287 pins the share as a named constant
between 0 and 1 rather than a literal, which is why the value could move without
rewriting a test.

---

## [v12.08] — 2026-08-06 — Coloured ink stops being blackened

Three documents scanned twice — once with this app, once with iPhone Preview —
put a number on "you have messed up the colour":

| | PyPDF ink | iPhone ink |
|---|---|---|
| prescription | 33,30,45 | 72,79,131 |
| med bill | 18,16,16 | 85,77,84 |
| doctor's bill | 21,21,41 | 98,85,75 |

Paper matched at 255 on all six. Our ink was 2–4× darker, and coloured ink had
lost half its saturation: the navy MEDIMALL wordmark measured 35,35,69 (chroma
34) against the iPhone's 80,87,144 (chroma 64); the red subtitle 131,83,81
against 209,137,123.

### One stage was doing all of it
Running the pipeline stage by stage over a faithful capture:

```
input                navy  82, 89,145   red 209,138,124   ink 98
+ colourBalanceCore  navy   7,  8, 60   red 126, 56, 47   ink 36   <- here
+ flattenIllumination navy  8,  8, 61   red 129, 58, 49   ink 36
+ documentEnhance    navy   7,  7, 52   red 119, 55, 47   ink 25
```

The 2–98% stretch inside `colourBalanceCore` maps the darkest 2% of the page to
pure black and slides everything above it down. For print that is exactly right
— it is what makes text crisp, and the curve is v11.31's byte for byte, which
v11.73 already proved is not the thing to touch. A navy logo or a blue pen was
simply never meant to be black.

### What changed
The stretch keeps its **full** strength on neutral pixels — text, rules, paper —
and a coloured pixel takes only `COLOUR_KEEP = 0.40` of the **downward** push,
ramped by chroma (full effect below 18, fully spared above 40). Brightening is
untouched: the white point still goes exactly where it went.

`documentEnhance`'s ink deepen is gated the same way, for the same reason: a
blue pen darkened another 18% on top of the stretch is how it stopped reading as
blue.

### Result, measured on all three pairs
| | navy / coloured ink | neutral black text |
|---|---|---|
| iPhone | 82,89,145 | 82 |
| v12.07 | 7,7,52 | 5.1 |
| **v12.08** | **47,54,107** | **7.1** |

| document | coloured ink before | after | iPhone |
|---|---|---|---|
| med bill | 56,55,90 | **95,99,135** | 128,132,169 |
| doctor's bill | 67,33,20 | **127,90,63** | 170,132,104 |

Neutral black text moved 5.1 → 7.1 and paper stayed at 255 — the two things
every earlier release was tuned on did not move. The result sits deliberately
between the two: coloured ink reads as its own colour again, while text keeps
the contrast and crispness of v12.03.

### Tests
255 in the scanner suite. SC280–SC288 pin that neutral print still takes the
full stretch, that paper still reaches white, that navy and red are spared and
keep their hue, that brightening is unaffected, that ink deepen leans harder on
neutral ink, and that the share and its chroma ramp are named constants.

---

## [v12.07] — 2026-08-05 — Read the ink, not the darkest sixth of the box

v12.06's colour reading was wrong in a way a screenshot showed immediately: the
replaced name came out **grey** beside black neighbours.

It averaged the darkest sixth of the span's **box**. That is right only when the
box is mostly ink — and on a re-edit it is not. The previous edit leaves a white
patch behind, so the darkest sixth is antialiased fringe. Reproduced on a box
holding a white patch, 3% ink and fringe:

| | measured |
|---|---|
| darkest sixth of the box (v12.06) | **139,139,140** |
| darkest 40% of the ink (v12.07) | **11,11,15** |

### What it does now
Threshold against the page's own paper level first, then average only what is
below it:

```js
const paper  = lum[order[N*0.90]];          // the page, not a constant
const inkMax = Math.min(200, paper*0.55);   // what counts as ink here
if (ink < N*0.04) return null;              // too little to read a colour off
const take = Math.max(6, Math.round(ink*0.40));   // the core, not the fringe
```

Both guards decline rather than guess, and the span's own colour stands. The old
flat ceiling of 170 is gone — it passed grey at 139 happily, which is the bug.

Measured against the four cases that matter:

| box | result |
|---|---|
| white patch, fringe only | declined |
| white patch + 3% ink + fringe | 13,13,17 |
| ordinary black print | 23,21,28 |
| navy heading | 26,35,120 |
| blank | declined |

### Tests
117 in the editor suite. ED97–ED101 run the shipped sampler over each of those
boxes; ED95/ED95b pin both guards. The synthetic fringe case is the one that
would have caught this before it shipped.

### Also
`N4b` in the scenario suite was still flaky under load — `createScanPdf` returns
in ~11ms but the reopen and first render that follow are async and get starved
when the whole battery runs at once. The wait went 3s → 10s; it still fails if
the document never switches, which is what it is testing.

---

## [v12.06] — 2026-08-05 — A picture of a document is a scan, whoever OCRed it

Reported: a patient name replaced on a photographed prescription came out in a
face, weight and size that matched nothing else on the sheet.

The file says why. The page is one 1800×1937 image with an **invisible** text
layer over it:

```
3 Tr 1 0 0 1 125.97615 712.9732 Tm (28/Female)Tj      <- render mode 3
```

Everything that makes an edit match a scan — matching the face and weight to the
printed ink, fitting the size and baseline to it — was gated on `docIsOcr()`,
which recognises **PyPDF's own OCR marker and nothing else**. This layer was
made by another tool, so none of it ran: the replacement was styled from a layer
that is drawn invisibly and describes no appearance at all. Its "Helvetica
10.8pt black" is not what the page looks like; it is what the OCR engine wrote
down.

### The condition was wrong, not the code behind it
The honest test is not *who made the text layer* but *is the visible page a
picture*. `pageIsImageBacked()` runs the page through a device that notes image
placements and asks whether one covers ≥60% of it. Measured across the files to
hand:

```
SCAN  100% covered   Photos 5 Aug 2026 21.34.pdf
SCAN  100% covered   Scan 5 Aug 2026 10.22.pdf
TEXT    2% covered   sample test.pdf
TEXT    3% covered   merged.pdf
```

`editingOnScan()` is `docIsOcr() || pageIsImageBacked()`, and every place that
meant "this page is a picture" now uses it — the face match, the ink size fit,
the patch geometry (on a picture the redaction blanks the image, so the patch
must cover exactly) and the fill colour.

### Colour is read off the ink too
The same reasoning applies to colour, which the invisible layer also gets wrong:
it is black whatever the page looks like. `inkColourRGB()` averages the darkest
sixth of the pixels in the span's box — that is the ink. Measured on the
reported file:

| span | ink measured |
|---|---|
| `28/Female` | 23,21,28 |
| `9681401719` | 14,12,19 |
| our replacement | 0,0,0 |

Near-black here, so the visible gain on this page is small — but a navy heading
or a red stamped field would have come back black, and now does not. It declines
rather than guesses when the box holds no real ink, and never overrides a colour
the caller asked for.

### Tests
111 in the editor suite. ED90–ED96 pin the image-backed test and its threshold,
that all five call sites share one condition, and that the ink colour declines
on an empty box and never overrides an explicit colour. ED64 and MX9 were
rewritten for the new gate rather than deleted.

---

## [v12.05] — 2026-08-05 — The edit sheet asks only what it cannot work out

Colour and Typeface are gone from Edit text. Both were offered with **Same**
preselected, and Same is not a compromise there: it is the colour and the face
the app **reads off the span being replaced**, so the edit matches the page by
construction. Two rows of choices to arrive back at what the document already
said — nine buttons of noise between tapping a line and replacing it.

The sheet is now: the text, **Size** (A− / A+), **Weight** (Same / Bold),
Replace.

- **Colour** stays automatic — `sp.color`, the span's own colour, which on a
  real document is nearly always black, grey or blue anyway.
- **Typeface** stays automatic — the document's own embedded font is reused
  where it can be, and where it cannot, `pickFont` matches the face from the
  original font's name.
- **Size** keeps A− / A+ stepping in half points from the size the PDF reports
  for that span. The `10.8 pt` chip is now part of the SIZE label rather than a
  button: it is information, not a control.
- **Weight** is the one thing the page genuinely cannot tell us when the
  original is a picture — see v12.04.

Add text and the watermark keep their own colour and typeface pickers: there is
no original span there to read anything off, so those really are choices.

### Tests
104 in the editor suite. ED80–ED86 pin both rows gone, both values still fixed
at "keep", the size chip demoted to a label, A−/A+ still stepping from the
span's own size, and that the other two sheets kept their pickers.

---

## [v12.04] — 2026-08-05 — Bold, as a choice rather than a guess

Reported on a prescription: the printed patient name is bold, and replacing it
through Edit text produced regular Helvetica that did not match the page.

Reading the file explained it exactly. The page is a photo with a text layer,
and the app's own patch is in there:

```
1 1 1 rg  ...  f          <- the white rectangle over the old name
BT 0 0 0 rg
/Helvetica-9742682568 10.81 Tf
<44656261736D697461205061756C> Tj    <- "Debasmita Paul", regular
```

Every font in that document is plain Helvetica, so "Same" faithfully reproduced
regular — there was no bold face to inherit. The bold faces have existed since
v11.54, but only `matchScanFace` could reach them, and only on an OCRed page.

### What changed
A **Weight** row in the edit sheet — `Same` / `Bold` — sitting under Typeface,
because weight and face are separate choices. It combines with everything:

| | regular | bold |
|---|---|---|
| Sans | Helvetica | Helvetica-Bold |
| Serif | Times-Roman | Times-Bold |
| Mono | Courier | Courier-Bold |
| Same | face implied by the original name | ...its bold cut |

`pickFont` takes a `forceBold` argument and `pickFontKeyed` a `bold` one, so
"Same + Bold" keeps the face the original name implies and only changes weight.

Asking for bold also **stops the document's own embedded font being reused** —
an embedded regular subset has no bold glyphs, so the request has to take the
base-14 substitution path, exactly as an explicit typeface choice already did.
Both the single-line and paragraph editors, plus Add text and the watermark,
pass the flag through.

### Tests
97 in the editor suite. ED32a–ED32f resolve every face × weight combination,
including that an already-bold font name is still honoured on its own and that
nothing moves when bold is off; ED32g–ED32j pin the embedded-font rule for both
edit paths, and that the sheet passes the weight through and has a row to set it.
ED26 and ED67 were rewritten for the new signature rather than deleted.

---

## [v12.03] — 2026-08-05 — The ink side, and sharpening only where the text is

v12.01 cleaned the paper. This does the same to the ink.

Measured on a finished page, a text band is **8.7% solid ink, 4.2% transition
grey, 87% paper**. That grey skirt around every stroke is what reads as soft —
and it is also the most expensive thing in the file.

| | daylight scan (294 dpi) | night scan (266 dpi) |
|---|---|---|
| body-text edge | 0.317 mm → **0.211 mm** | 0.287 mm → **0.218 mm** |
| transition greys | 3.8% → **1.5%** | 3.0% → **1.1%** |
| flat grey fills | std 9.2 → 9.2 | unchanged |

### What changed
1. **Ink flatten** — neutral pixels below 55% of the local paper level are pulled
   toward solid black on a smoothstep ramp, the mirror of what v12.01 does to
   paper. A stroke becomes ink plus a thin edge instead of ink plus a wide grey
   skirt, and solid black compresses almost free, which is what pays for (2).
2. **The unsharp is weighted by neutrality** (chroma < 24, 8-unit ramp) and
   raised 1.20 → 1.50 with the threshold 2 → 3. A letterhead, a photo or a
   watermark gains nothing from being edgier and would spend real bytes on it;
   text is neutral by definition, so the sharpening goes where it is wanted.

Both guards from the paper side carry over: **chroma**, so a blue signature or a
red stamp is untouched, and a **smoothstep** rather than a threshold, so nothing
posterises. A mid-grey table fill sits above the ramp and is left exactly alone —
verified, 150 → 150.

### The byte budget is now per megapixel
`budget: 900000` → `budgetPerMP: 120000`. A flat number meant the quality a page
got depended on how close the phone happened to be: the same report at 6.8 MP
got 116 KB/MP and kept q0.80, while at 8.3 MP it got 108 KB/MP, hit the ceiling
and stepped down to **q0.69**. Framing distance should not decide encoder
quality. 120 KB/MP is what those two real captures actually used, so nothing
grows; if the ink flatten frees bytes the way the paper flatten did, quality
holds at 0.80 and the files get smaller.

`jpeg:0.80`, `maxDim:3500` and `qFloor:0.70` are unchanged and pinned by test.

### Also in this release: a correction
A focus/tilt warning was planned, on the strength of a sharpness grid showing
the bottom third of every page 8× softer than the middle. **That was wrong.**
The metric was Laplacian variance per cell, and the bottom third of the test
page is nearly blank — 3–10% ink against 11–20% at the top — so it was measuring
how much was there, not how sharp it was. Restricted to small body-text strokes:

| | daylight | night |
|---|---|---|
| upper | 0.392 mm | 0.470 mm |
| middle | 0.315 mm | 0.319 mm |
| lower | 0.329 mm | 0.226 mm |

No gradient. The softness is uniform, the blur is symmetric (horizontal edge
energy 8.29 vs vertical 8.39, so not shake), and a warning built on that metric
would have fired on blank regions and banner text on every page. The feature was
dropped before a line of it was written, which is the cheapest place to drop it.

### Tests
246 in the scanner suite, 124 in compress. SC266–SC270 pin the ink pull, the
mid-grey fill it must not touch, coloured ink, and that sharpening favours
neutral areas. SC271–SC274 pin the per-megapixel budget and that the capture
constants did not move with it. CP64b–CP64e were rewritten for the new budget
shape rather than deleted.

Device-untested.

---

## [v12.02] — 2026-08-04 — Brightening a page should not saturate it

Reported against the camera's own photo of the same page: the lime-green
letterhead came out far more saturated than the document really is. Measured on
that photo, through this exact pipeline, stage by stage:

| stage | green RGB | chroma |
|---|---|---|
| as captured (after warp) | 123, 134, 44 | **90.6** |
| after `colourBalanceCore` | 149, 167, 25 | 142.1 |
| after `flattenIllumination` | 200, 222, 30 | **192.2** |
| after `documentEnhance` + `paperCrisp` | 199, 221, 29 | 192.0 |

Saturation more than doubled, and the blue channel was crushed from 44 to 29.
v12.01's sharpening contributed **nothing** to it — that was checked first.

### The cause: every brightening step multiplied
White balance, the 2–98% stretch, the midtone lift and the illumination flatten
all multiply R, G and B. A gain of *g* scales the **distance between the
channels** by *g* as well, so brightness and saturation rise together. On a text
document it is invisible — paper is neutral, R=G=B, and a gain and a delta agree
exactly — which is why four multiplications survived this long.

### The fix: brighten with a delta, correct colour with a ratio
Same targets, same caps, same clamps, applied differently.

- **`applyAutoContrast`** — the curve is untouched, still v11.31's byte for
  byte. It is now applied to *luminance*, and that delta is added to all three
  channels.
- **`crispenAndLift`** — the 1.06 midtone gain becomes `+ luma × 0.06`.
- **`flattenIllumination`** — additive lift instead of a gain, capped at
  `AMAX=90` where the old ceiling was `GMAX=2.0`.
- **White balance** — the interesting one. Its three gains measured
  1.293 / 1.291 / 1.333: the **cast** correction is only the *ratio* between
  them (3% of blue), and the other 29% is a common brightening that exists only
  because `TGT` drags the paper mean to 245. Those two jobs are now separated —
  the ratio multiplies (that is what removes a cast), the common part is added.

### Result on the reported page
| | chroma | paper |
|---|---|---|
| as captured | 90.6 | 213 |
| v12.01 | 192.0 | 254 |
| **v12.02** | **89.3** | **255** |

The colour is now the camera's, and the paper is still white.

### Checked for regressions
- a warm cast (200,190,150) is still neutralised — the ratio still does its job
- a dark corner still lifts: 89 → 165 in the unit test, 52 → 115 on the real photo
- ink still deepens (62 → 53), edges unchanged from v12.01
- Photo ID is a separate path and is untouched

### Tests
236 in the scanner suite. SC260–SC265 pin each stage separately: brighten
without saturating, then the whole chain end to end, plus the two things the fix
could have broken — cast correction and dark-corner lift.

Device-untested.

---

## [v12.01] — 2026-08-04 — Crisper text at the same file size

Reported on a 300dpi colour lab report: "texts are not clear and crisp".
Measured on that exact file before changing anything:

| | before | after |
|---|---|---|
| ink edge transition (10–90%) | 2.0 / **3.32 px** | 1.0 / **1.91 px** |
| blank paper | RGB 242,240,246, grain std **6.2** | white, grain std **3.1** |
| page size | 1.43 MB | **1.37 MB** |

A crisp 300dpi scan has ~1.0–1.5px edges. Resolution was never the problem: the
page is 2504×3500 = 299dpi, and chroma is 4:4:4.

### Why the size did not go up
The two halves pay for each other. Sensor grain on blank paper is expensive to
encode; flattening it frees exactly the bytes the sharpening then spends on
edges. Sharpening alone measured **+15%** for less gain, so it is not shipped
alone.

It also explains the original file: `SCAN_Q.std` targets 900 KB, which a colour
300dpi A4 page cannot meet, so the encoder walked down to its `qFloor` of 0.70
and produced 1.34 MB anyway. With the paper cleaned it no longer has to.

### What changed — `paperCrisp()`, the last step of documentEnhance
1. **Neutral paper to white** on a smoothstep ramp (0.72 → 0.90 of the local
   paper level, a 90th-percentile histogram read). A ramp, never a threshold: a
   hard cut-off posterises the shading round a fold, which is how an earlier
   release turned a grey panel into a black smear.
2. **Unsharp** on the cleaned result — two box passes ≈ gaussian, amount 1.20,
   threshold 2. After the whitening, not before: sharpening first would amplify
   the grain the whitening has just removed.

The two gentler steps it replaces (`paperClean`'s 0.6 blend, a 0.35 unsharp)
were doing measurably too little — the numbers above are what they produced.

### The guard that matters
The first attempt pushed **every** bright pixel to white and bleached a pale
yellow letterhead strip off the page. Paper is bright *and neutral*; a pale tint
is bright and coloured. The whitening is therefore gated on chroma (< 20, with a
6-unit ramp):

```
pale yellow band  243,243,163  →  243,243,163
```

### Rejected while tuning
- **A gradient gate** to protect faint table rules: rules kept more contrast
  (10.7 → 14.3) but edges went **1.0 → 3.0px** and the file grew 0.68 → 0.96 MB,
  because the whitening stopped exactly where the text is and left grainy haloes
  round every glyph.
- **A tighter ramp** (0.86/0.97): rules 10.7 → 12.6, but paper grain 3.1 → 10.1,
  edges 1.91 → 2.45px and size 1.37 → 1.62 MB.

### The honest cost
Very faint table rules lose contrast: 16.9 → 10.7 on the v11.77 report. They
remain clearly visible, and every alternative measured worse overall.

### Not affected
**Photo ID** goes through `idCardEnhance`, which is deliberately colour-faithful
and does not call this. Verified by test. `SCAN_Q`, the warp, the detector and
the capture path are unchanged.

### Cost on device
327ms for an 8.8-megapixel page, once, at save time.

### Tests
230 in the scanner suite. SC250–SC257: grainy paper flattens to white, a pale
coloured band survives, ink is never lifted, a soft edge is measurably steeper,
a dark page is refused byte-identically, random input stays in range, and Photo
ID is not wired to it.

Device-untested.

---

## [v12.00] — 2026-08-02 — Clearing out what did not work

A cleanup release. Two device bugs were chased today: one was solved, one was
not, and this removes everything built for the one that was not.

### Removed
**The rotation-lag gate (v11.97/98).** `previewIntrinsic`, `previewRotationLag`,
the extra reveal condition, and `CAM_FIRST_FRAME_MS` back from 2000 to **1200**.
It was a correct diagnosis — two screen recordings measured the preview at
330.00×440.33 and then 440.00×440.33, both consequences of iOS delivering the
camera's rotation metadata a beat late — but the gate did not fix it on the
device and cost ~600ms of extra black on every open. The preview again appears
as soon as the fit is stable.

**The layout recorder and the Diagnostics sheet (v11.90–95).** `diagSample`,
`diagRecord`, `diagText`, `diagVerdict`, the `paint=`/`sty=`/`boot=`/`OFF-FIT`/
`SMALL`/`ROT-LAG` labels, More → Diagnostics, and `.diagdump`. It did its job:
the trace `win=440x894 scr=440x956` is what proved the black band was outside
the web view, which is what led to the fix. Both bugs it was built for are now
closed or parked, so it goes. ~200 lines of app.js, 7 of CSS, 28 tests.

**`ISSUE-BRIEF.md`**, written to hand the two bugs to someone else, and **eight
intermediate `pre-*.zip` backups** plus one stray temp file — about 3.2 MB.

The older press-and-hold camera diagnostic (`camDiag`, gUM and first-frame
timings on the Scan button) is **untouched**; it predates today.

### Kept
Everything that works: Compress size prediction (v11.92), Pages multi-select
(v11.93), the bottom-band fix (v11.91), the full safe-area inset on a
full-screen web view (v11.95) and the measurement it depends on, the About
"Web view" row that says whether an install needs re-adding, and the
`loadedmetadata` fit (v11.96).

### Verified
All eighteen suites pass: 222 scanner, 124 compress, 123 harness, 87 editor, 65
text edit, 58 corpus, 57 scenario, and the rest. `scan-core.js`, `scan-worker.js`,
`SCAN_Q` and every capture, MRC, compress, organise, unlock and text-edit
function remain byte-identical to v11.90.

---

## [v11.98] — 2026-08-02 — Wait for iOS to agree which way up the camera is

v11.97's `object-fit:fill` is **rejected**. A second recording of the same open,
measured at device resolution, shows the fault simply changed shape:

```
v11.96  object-fit:contain   330.00 x 440.33 at x55.00, y216.00   ~370ms
v11.97  object-fit:fill      440.00 x 440.33 at x 0.00, y216.00   ~583ms
```

Both are **correct renderings of the wrong intrinsic**, so no value of
`object-fit` can fix it — and `fill` distorts and crops, which for a document
scanner is worse than a small preview. `contain` is back, because it is the fit
that cannot distort.

### The actual fix: measure the disagreement
iOS carries the camera buffer's rotation as metadata. For a few hundred
milliseconds WebKit lays out against the **unrotated** landscape buffer while
`videoWidth`/`videoHeight` already report the **rotated** portrait size. The
preview now waits for those two to agree:

```js
function previewRotationLag(v){
  const i = previewIntrinsic(v);             // width:auto → WebKit's own belief
  return (i.w > i.h) !== (v.videoWidth > v.videoHeight);
}
const stable = fitLast && same >= 3 && !lagging;
```

`previewIntrinsic` reads the belief rather than inferring it: sized `auto`, an
absolutely positioned video lays out at its intrinsic size. It runs only while
the preview is hidden and restores the geometry in a `finally`, so it can never
disturb anything on screen.

No constants, no timing guess — the app now asks the question five releases were
trying to answer by arithmetic.

`CAM_FIRST_FRAME_MS` **1200 → 2000**. The lag was measured at 583ms *after* the
first frame, so the old ceiling could expire mid-lag and reveal the very frame
this exists to hide. It is still a bounded promise that the preview can never
stay black.

### Cost
The preview appears roughly 600ms later on a cold camera open — black with
"Starting camera…", then correct. That was v11.87's intent; it had the wrong
predicate.

### In the trace
Each hidden frame now records `int=` (WebKit's laid-out intrinsic) and is
labelled `ROT-LAG(stream 3024x4032)` when it disagrees. The verdict adds
"rotation lag held the reveal for N frame(s), which is it working" — so the next
trace confirms the fix by showing the bug being *caught*, not by showing nothing.

### Tests
248 in the scanner suite. SC232–SC244 pin `contain`, record `fill` as tried and
rejected (the rule is gone, the explanation stays), reproduce both measured
geometries from the recordings, and pin the predicate, the probe's restore, the
ceiling and the trace label.

Device-untested.

---

## [v11.97] — 2026-08-02 — The small preview diagnosed (the fix was wrong; see v11.98)

A ten-second screen recording, measured at device resolution (1320×2868, dpr 3),
ended a bug that had survived five attempted fixes. Every open, for ~370ms:

```
small stage   330.00 x 440.33  at x 55.00, y 216.00
correct       440.00 x 586.67  at x  0.00, y 142.67
```

Exactly **3/4 scale, centred**. And the reason nothing found it: **the element
was correct the whole time.** `fitPreviewBox` had written 440×586.67, and the
v11.95 trace recorded exactly that, frame after frame. Every fix since v11.84
measured the element, so every fix measured the one thing that was right.

### What was actually wrong
What WebKit *painted inside* the element. `object-fit: contain` of a
**landscape** 4032×3024 intrinsic in a 440×586.67 box is 440×330; the picture is
then rotated into that area, and what you see is 330×440 centred:

| | predicted | measured |
|---|---|---|
| painted size | 330.00 × 440.00 | 330.00 × 440.33 |
| x offset, `(440−330)/2` | 55.00 | 55.00 |
| y offset, `(586.67−440.33)/2 + 142.67` | 215.84 | 216.00 |

Agreement to a third of a pixel. iOS carries the camera buffer's rotation as
metadata: for the first few hundred milliseconds the layout uses the
**unrotated** aspect while `videoWidth`/`videoHeight` already report the
**rotated** one. That is why the element's own numbers looked perfect in every
trace, and why v11.87's "hold the reveal until the fit is stable" did not help —
the fit *was* stable and correct; the paint was not.

### The fix
Stop depending on the intrinsic aspect at all. `fitPreviewBox` already computes
the exact contain geometry from `videoWidth`/`videoHeight` and writes it to the
element, so **the element's aspect is the stream's aspect** — filling it is
precisely what `contain` would have produced had the intrinsic been right, and a
wrong intrinsic can no longer shrink the picture.

```css
.scanview video         { object-fit:contain; }   /* unsized: cannot distort */
.scanview video.fitted  { object-fit:fill;    }   /* sized by us: fills exactly */
```

`.fitted` is added by `fitPreviewBox` itself, at the moment it writes the
geometry, and cleared in `startScan` alongside `fitLast` — the two describe the
same fact, so they must never disagree. An element we have not sized keeps
`contain` and can never stretch.

### Why five releases missed it
Every one of them reasoned about the element's box. The recorder added in v11.90
recorded that box; v11.95 added `paint=` and still computed it from
`videoWidth`/`videoHeight`, which were the *rotated* values — so it agreed with
the element and reported "every frame matched the fit" while the screen showed
otherwise. The only instrument that could see this was a camera pointed at the
screen. **Ask for the recording sooner.**

### Tests
241 in the scanner suite. SC232–SC238 pin both `object-fit` rules, reproduce the
330×440 arithmetic and its centring from the recorded numbers, and require
`.fitted` to be written by the fit and cleared with `fitLast`.

Device-untested: the fix is a one-line change to what fills a box whose size is
already verified, but only the phone can confirm the 370ms is gone.

---

## [v11.96] — 2026-08-02 — Fit when the size is known, not when the picture is

The v11.95 trace, on the reported repro (open, cancel, reopen), caught a real
defect — though not the one being reported. First open, frame by frame:

```
30879..32067 x71  vid=0x0        drawn=440x672  sty=-              ready=0
32084..32226 x10  vid=3024x4032  drawn=440x672  sty=-              ready=0  OFF-FIT(want 440x587)
32242..32275 x3   vid=3024x4032  drawn=440x587  sty=440pxx587px    ready=0
32275..34198 x87  vid=3024x4032  drawn=440x587  sty=440pxx587px    ready=1  <revealed:stable>
```

For **143ms — ten frames — the stream reported 3024×4032 and the element was
still at the CSS default 440×672**. `sty=-` is the proof: our own code had not
written a size yet. Nothing called `fitPreviewBox` between metadata arriving and
the first frame callback arriving; the settle loop only starts at the latter.

Fixed by fitting on `loadedmetadata` as well. The later `resize` listener stays —
a resolution change after the first frame is a genuinely separate moment.

This was invisible on screen, because v11.87's reveal already holds the preview
back until the fit is stable. It was the app being wrong while knowing enough to
be right, which is the kind of thing that becomes visible one refactor later.

### What the trace says about the reported bug: still not reproduced
Two opens, including the cancel-and-reopen sequence, both revealed at exactly
440×587 in a 440×672 box — the correct contain fit — and `paint=` never fell
short on both axes, so the new SMALL detector never fired.

One hypothesis remains, and it is a consequence of the v11.95 viewport fix:

| | box | image | bars top/bottom |
|---|---|---|---|
| before re-add | 440×610 | 440×587 | **11px** |
| after re-add | 440×672 | 440×587 | **42px** |

The 62px the web view gained went entirely into the preview box, and the camera
is 3:4 while the box is now 0.65 — so the letterbox nearly quadrupled. The image
sits in a visibly larger black area than it did last week.

A screen recording was requested to settle it before any layout change.

### Tests
234 in the scanner suite. SC230–SC231 pin both fit triggers, with the trace
numbers in the comment.

---

## [v11.95] — 2026-08-02 — The band is gone; the toolbar reclaims its inset

Re-adding the app to the Home Screen fixed the black band, and the trace proves
it rather than describing it:

```
win=440x956  scr=440x956  vv=440x956@0  barBot=956  barTop=903  drop=0
```

`innerHeight` now equals `screen.height`, `drop=0`, and the toolbar's own bottom
edge is at 956 — the true bottom of the display. The cause was the one proposed
in v11.91: iOS snapshots a web app's appearance metadata when it is added to the
Home Screen, and that install predated the correct `viewport-fit=cover`.

### The consequence, fixed in the same release
`--botpad` was `max(2px, env(safe-area-inset-bottom) - 30px)`. That subtraction
existed only because the **short** web view still reported a 34px bottom inset
for a strip it did not own — honouring it left 34px of dead space above a black
band. Now that the web view owns the whole screen the inset is real, and only
4px of it was being honoured: the buttons sat on top of the home indicator.

`html.fullvp` gives back the full inset, and the class is set from the
measurement that diagnosed the band in the first place — `screen.height` versus
`innerHeight`, already running on the existing ladder of checks:

```js
document.documentElement.classList.toggle("fullvp", shortfall <= 2);
```

Toggled, not set once, so an install that changes — which is exactly what
re-adding to the Home Screen does — converges without a reload, and a short web
view keeps the old correction. Every floating control (`.zoomctl`, `.undofab`,
`.mkmenu`, the page pill) and the viewer's own bottom padding are already
expressed in `var(--botpad)`, so they all move together.

### The scanner: the last trace was measuring the wrong rectangle
Two clean opens, every frame matching the fit — and the preview still reported
as opening small every time. Both can be true, because `object-fit:contain`
paints the stream **inside** the element. An element of exactly the right size
showing a stream of a different aspect paints smaller than itself, and the
recorder was measuring the element.

Each scanner frame now also records:

| field | what |
|---|---|
| `paint=` | the image as painted inside the element — what the eye sees |
| `sty=` | the inline size `fitPreviewBox` asked for, so intent and result can disagree visibly |
| `boot=` | whether "Starting camera…" is still showing underneath |

And the label that matters: a correct contain fit is short on **one** axis (the
letterbox). Short on **both** is a small window floating in black, which is the
reported symptom, so it is labelled **`SMALL(paints 200x150 in 390x600)`** and
counted in the verdict.

Device-untested for the scanner: this release adds no fix for it, only the
measurement that can tell the two explanations apart.

### Tests
69 in the scenario suite (was 65). D8b–D8e cover the painted size, that a
one-axis letterbox is *not* flagged, that a both-axes shortfall is, and that the
verdict reports it.

---

## [v11.94] — 2026-08-02 — The trace now records change, and reads itself

The second device trace came back 700 rows long, of which **690 were
byte-identical**. It covered eight seconds of a session and a fifty-three second
gap, and the scanner open it was meant to catch had already been evicted. A
still layout is one fact, not seven hundred.

### Only change is recorded
Identical consecutive frames collapse into the row they repeat, with a count and
an end time:

```
t=15120..16505 x84 win=440x894 scr=440x956 barBot=894 barTop=841 drop=62
```

A **tagged** frame always gets its own row, so `<scanner-open>`, `<resume>` and
`<revealed:…>` can never be swallowed by a collapse. Same 700-row buffer, now
covering minutes of real use instead of seconds.

### The trace answers its own question
Two traces have now been read by recomputing `containFit` by hand to find out
whether anything was actually wrong. The recorder does that arithmetic itself:

- any frame whose rendered video rect is more than 2px from the contain fit of
  its box is labelled **`OFF-FIT(want 440x587)`** inline;
- a **verdict** line at the top of the report says whether the web view owns the
  whole screen, how many scanner opens were recorded, and how many frames were
  off-fit.

```
verdict: web view SHORT by 62px — the band below the bar is outside the page;
         re-add to Home Screen · 2 scanner open(s), 14 frame(s) OFF-FIT
```

### What the v11.93 trace said
Every one of its 700 rows was `win=440x894 scr=440x956 barBot=894 drop=62`.

- **The bar is now correct.** `barBot=894` equals `innerHeight`: it sits flush
  with the bottom of the web view. In v11.90 it read 894 against a box pushed to
  956 — clipped. Removing `--vvdrop` did what it was meant to.
- **The web view is still 62px short of the screen**, so the black band remains.
  The PWA had not been removed and re-added at the time of this trace.
- **The scanner was correct in all 154 frames it was up**: `view=440x610`,
  `vid=3024x4032`, `drawn=440x587@0,112` — the exact contain fit — from the
  first frame, with the reveal tagged `<revealed:stable>` 446ms after open. Only
  one open was recorded, and the bug did not occur in it.

`diagText` also no longer calls the global `getComputedStyle` unguarded — a
report that throws when asked for it is worse than no report.

### Tests
65 in the scenario suite (was 57). D1–D8 cover the collapse, that a tagged frame
survives it, that a change starts a new row, the OFF-FIT label, and both halves
of the verdict.

---

## [v11.93] — 2026-08-02 — Pages: take a range, move a block, select the lot

Selection existed in the Pages grid but was one tap per page, and reordering was
one page per tap in Organise. Deleting pages 4–9 was six taps; moving them up
three places was eighteen.

### Press and hold to take a range
Tap page 4, hold page 9: everything between is selected. Two gestures instead of
six taps. The header says how many are selected and the hint line says how.

Deliberately **not** drag-to-select — a thumbnail is a poor drag target on a
phone and the sheet itself pans. The hold is 420ms, long enough not to fire on a
scroll flick, and the click that follows a hold is swallowed so the page it
landed on is not immediately toggled back off.

### Move a whole selection
**← Earlier** and **Later →** move every selected page one step. Two rules make
repeated taps behave rather than scatter the document:

- a page at the edge stays put;
- a page blocked by an already-moved sibling stays put.

So a selection driven into the top closes up and then stops. The traversal order
is what makes this work: moving earlier walks the selection left-to-right,
moving later walks it right-to-left. Walk it the wrong way and `012345` with
pages 3–4 selected becomes `012453` — the block torn apart — instead of
`012534`. That case is now test **O3a**, and it was confirmed to fail against a
deliberately reversed traversal before being accepted.

The moved pages stay selected, so the next tap continues the move.

### Select all / Select none
One button, and the label says which it will do.

### Applied, not queued
A move commits immediately, like Rotate already did, rather than being staged
until Done. The thumbnails have to show the new order for the next tap to mean
anything. Undo covers it.

### Tests
57 in the scenario suite (was 39). O1–O6 are the arithmetic — blocks, edges,
non-contiguous selections, and ten repeated taps converging; O7–O17 drive the
real sheet in jsdom, including that the click after a hold is swallowed and that
a moved page is still selected afterwards.

**Also fixed a flaky test.** `N4b` slept a flat 150ms after building a scan and
then asked whether the document had text — on a loaded machine it lost that race
about one run in four and read the previous document's cached answer. It now
waits for a *different* signal (the open file actually changing) before asking
the question. Seven consecutive clean runs since.

---

## [v11.92] — 2026-08-02 — Compress tells you what each level would produce

Compress offered three levels and no way to tell what any of them would do. You
committed, looked, and undid. Each button now carries the answer:

```
High quality — pictures at 200 dpi
about 2.8 MB  ·  6% smaller

Balanced — pictures at 150 dpi
about 590 KB  ·  80% smaller

Smallest — pictures at 110 dpi
about 240 KB  ·  92% smaller
```

### How the number is arrived at
Not by compressing three times — that would cost more than the compression
itself. The largest handful of images are **genuinely encoded** at each level,
and the rest of the document is scaled from the bytes-per-pixel those samples
measured. The expensive step, decoding the pixmap, happens **once per image and
is shared by all three levels**, so three answers cost barely more than one.

Because a few big images carry nearly all of a PDF's weight, the sampled part
is usually most of the answer and the extrapolation is the tail.

Every skip rule in `recompressImages` is mirrored, so an image the real pass
leaves alone is predicted as unchanged: under `IMG_MIN_BYTES`, already a JPEG at
a sensible dpi, or a saving below the 10% floor. What is *not* mirrored — the
lossless structural pass, font subsetting, CCITT on bilevel images — can only
make the real result **smaller** than predicted, which is the safe direction.

### Measured accuracy
| document | level | estimated | actual | error |
|---|---|---|---|---|
| one 1200×1600 photo | high | 2856 KB | 2856 KB | 0% |
| | balanced | 604 KB | 605 KB | 0% |
| | smallest | 247 KB | 247 KB | 0% |
| fourteen images (extrapolated) | balanced | 2710 KB | 2653 KB | +2% |

The fourteen-image case is the one that tests the extrapolation, since only
eight images are sampled.

### One thing the first attempt got wrong
Undecoded images were treated as *unplaced*, which sends them down the
`IMG_UNMEASURED_MAX` path and predicts **no reduction at all**: 7.2 MB against
an actual 2.6 MB, 178% out. The placement map is keyed by
pixels:components:depth and the object dictionary does not reliably give the
last two, so `placementByDims` now matches on pixel size alone and takes the
largest match. 178% → 2%. Conservative is not the same as useful.

### Behaviour
- The sheet **opens immediately**; the numbers arrive a moment later. A sheet
  that cannot be used until an estimate finishes would be worse than one with
  no estimate.
- Closing the sheet, or pressing a level, abandons the work at the next image.
- Documents over 60 MB or 60 pages are declined outright, and the lines stay
  blank rather than the sheet freezing.
- Read-only throughout: it runs directly on `MDOC` without a copy because it
  never writes. A test asserts there is no `.put(` anywhere in it.
- A text-only document now reads **"about the same size"** — which is itself
  useful, since it says Compress has nothing to work with here.

### Not estimated yet
**Scanned pages (MRC)** and **Reach a size…** carry no number. MRC's cost is
not a size — it is that small text is redrawn as a stencil, and no byte count
conveys that. That is C2's job: render the smallest text both ways and show the
pair.

### Tests
124 in the compress suite (was 90). CP70–CP99 cover the arithmetic, the
comparison against real compression at all three levels, the extrapolated tail,
cancellation, the size ceiling, and that the estimator never mutates.

---

## [v11.91] — 2026-08-02 — The black band is outside the page, and no CSS can reach it

The recorder shipped in v11.90 was run on the device. One line of the trace ends
four releases of theorising:

```
win=440x894   scr=440x956   vv=440x894@0   barBot=956   barTop=841   drop=62
```

`innerHeight` is **894** on a **956** screen. The web view is 62px shorter than
the display, and 62px is exactly the top safe-area inset of a 16 Pro Max. The
black band is not a gap the toolbar failed to fill — it is **the part of the
screen the document does not occupy at all**.

That also explains why three separate corrections failed in the same way. With
`drop=62` the bar's box sat at viewport-y **956**, while the web view ends at
**894**: 62px of the bar was outside the renderable area and was clipped, never
painted. Every value of the correction has this property. Anything below
`innerHeight` does not exist to paint into.

### What changed
- `--vvdrop` is **gone** — removed from `:root` and from every rule that read it.
- `.toolbar` is back to plain `position:fixed; bottom:0` with `var(--botpad)`.
- The measurement that diagnosed this **stays**. `bottomShortfall()` still runs;
  its result is reported in About and in the trace, and applied to nothing.
- About gains a **Web view** row reading either `full screen` or
  `SHORT by 62px — re-add to Home Screen`, so the condition is visible without
  opening a trace.

### The likely cause, and the test for it
`viewport-fit=cover` is present in `index.html`, and with it in effect
`innerHeight` should equal the screen height. iOS snapshots a web app's
appearance metadata when it is added to the Home Screen; an instance installed
before that meta was correct keeps the old, inset-avoiding viewport for the life
of the installation, no matter how many times the service worker updates.

**To test:** delete the PyPDF icon from the Home Screen, open the site in
Safari, Add to Home Screen again, then More → About. If Web view reads
`full screen`, the band is gone and the cause is confirmed.

### Scanner preview
The same trace covered a scanner open, and it was **correct**:

```
view=440x610   vid=3024x4032   drawn=440x587@0,112
```

`containFit(3024, 4032, 440, 610)` gives 440×587 with offY 11.5, and
`.scanview` top 112 − 11.5 = 100.5 — an exact match. This open did not
reproduce the bug, so nothing was changed for it. A trace captured during a
**broken** open is still needed.

### Tests
232 in the scanner suite. SC180–SC185b were rewritten: they no longer pin a
correction, they pin its absence and record the trace numbers that justify it.

---

## [v11.90] — 2026-07-29 — A recorder, so the next fix is not a fifth guess

Two device-only bugs — the black band below the toolbar, and the camera preview
opening small — have each survived four attempted fixes. Every one of those was
built on **inference from a screenshot**, because both bugs are transient and
self-correcting: any reading taken afterwards shows healthy numbers.

This release measures nothing new about the bugs and fixes neither. It records
the layout **while they are happening**.

### What it captures
Every animation frame, for six seconds after launch, after a resume, and after
the scanner opens:

| field | why |
|---|---|
| `win` / `scr` / `vv` | innerWidth×Height, screen, visualViewport — the three references the bottom-bar fix has been choosing between |
| `barBot` / `barTop` / `drop` | the toolbar's own rect and the correction currently applied |
| `panel` / `view` | the scanner panel and viewfinder boxes |
| `vid` | the stream's intrinsic size |
| **`drawn`** | **the video's rendered `getBoundingClientRect`** |

`drawn` is the one that matters most. Four releases have reasoned about what
the fit *intended*; nothing has ever recorded what actually ended up on screen.
The arithmetic from the screenshot never reconciled — 690×920 in a 920×1420 box
is not a contain fit, a CSS `object-fit:contain` result, or a transposition of
either — which means the model was wrong, not the constants. This settles it
with a number instead of a deduction.

The exact frame the preview is revealed is tagged (`revealed:stable` or
`revealed:timeout`), so the trace shows whether the wrong size was on screen
before or after the reveal.

### Reading it
**More → Diagnostics.** A plain monospace dump with a Copy button, deliberately
not a summary — a summary would be my interpretation, and misinterpreting these
numbers is what has cost four releases. There is also *Record again (6s)* for
reproducing on demand.

### Constraints
- It only reads. Nothing here changes layout.
- `diagSample` cannot throw into the app it is measuring (`SC211`).
- Capped at 700 rows and 6-second windows, and overlapping starts cannot spawn
  two loops (`SC218`, `SC219`).

scan 233 → 243. Seventeen suites green, corpus green.

**How to use it:** reproduce either bug, then open More → Diagnostics and Copy.
The trace is what the next fix will be built on.

## [v11.89] — 2026-07-29 — Bottom bar: the ladder could miss the settle

You asked whether v11.87/88 broke the v11.86 bottom-bar fix. **They did not.**
The only change to that code across three releases is:

```
- const recheck = ()=> requestAnimationFrame(pinBottomChrome);
+ const recheck = ()=> nextFrame(pinBottomChrome);
```

`nextFrame` calls `requestAnimationFrame` in Safari, so it is functionally
identical, and the CSS is byte-identical. Verified by diff.

The honest conclusion is therefore that **v11.86 probably never fixed it on the
device either** — the scanner issue was reported next, so the bottom bar was
never re-confirmed in between.

### The weakness that is fixable without guessing
The correction ran on a fixed ladder — 0, 150, 400, 900, 1800ms — plus events.
A fixed ladder can only catch a settle it happens to land on. If the viewport
reaches its final size after the last rung, nothing re-measures and the gap
stays for the rest of the session.

It now also polls every 500ms for the first ten seconds. `pinBottomChrome` is
one `getBoundingClientRect` and returns immediately when the bar is already
flush, so twenty of them cost nothing — and it removes the dependence on
guessing the right moment to look.

### What would settle this in one round
About shows `Bottom bar 898/898/956 drop 58px` and `Display mode`. Those numbers
say which of the two measurement terms is failing:

- **bar/viewport differ** → term 1 should have fired
- **viewport < screen** → term 2 should have fired
- **all three equal, gap still visible** → both terms are blind to it, and the
  cause is something neither measures

Without that reading the next attempt is another guess, and there have been
three.

Seventeen suites green, corpus green.

## [v11.88] — 2026-07-29 — The permission prompt was hiding the bug

**No scan-quality code touched.** `scan-core.js` is byte-identical to v11.86.

### You found the discriminating case
Close the app completely and reopen: the camera permission prompt appears, and
the preview opens correctly. Cancel the scan, reopen the scanner: the small
preview is back.

That is the whole answer, and it is a **race**, not a geometry problem:

```
$("scanCam").classList.add("show");   // panel becomes display:flex
await startCamera();                  // getUserMedia
```

On a **first** open, `getUserMedia` blocks for seconds behind the iOS permission
prompt. Dozens of frames pass, the panel lays out completely, and by the time
anything measures the viewfinder the answer is right. On a **reopen** the grant
is already held and the camera returns in milliseconds — measuring a panel that
was made visible microseconds earlier.

**The permission prompt was accidentally providing the settle.** Every version
of this app has depended on it without anyone knowing, which is why it looked
intermittent and why it survived four attempts: v11.84 and v11.85 corrected the
fit *afterwards* (real corrections — that is what "becomes normal" was), and
v11.87 waited for stability *after* the panel was already being measured wrong.

### The fix
`afterLayout()` — two frames, a style recalc and a layout pass — after the panel
is shown and before anything can measure it. About 32ms, once per scanner open.

Applied in `startScan`, and in `resumeCamera`, which needs it **more**: the
stream is already live there, so there is nothing whatsoever to wait for. Every
route back to the viewfinder (Retake, Use page, retake-a-page) goes through
`resumeCamera`, so one wait covers them all — `SC203` checks no path bypasses it.

The v11.87 settle loop stays as a safety net, and v11.85's per-tick re-fit stays
as a backstop. But the ordering is now correct at the source rather than being
repaired downstream.

scan 229 → 233. Seventeen suites green, corpus green.

## [v11.87] — 2026-07-29 — The preview is not shown until it has stopped moving

Fourth report of the same thing: the scanner opens small and grows to full size
a fraction of a second later.

**No scan-quality code touched.** `scan-core.js` is byte-identical to v11.86,
and every quality call site (`SCAN_Q`, `applyAutoContrast`, `colourBalanceCore`,
`documentEnhance`, `flattenIllumination`, `warpCore`, `encodeUnderBudget`,
`idCardEnhance`) is unchanged — verified by diff, not by memory.

### Why the three previous attempts all failed the same way
v11.84 re-fitted on a ResizeObserver. v11.85 re-fitted on every live tick. Both
corrections are real and both work — **which is exactly why it "becomes
normal"**. The correction lands *after* the preview is already on screen. I was
fixing the second half of the symptom and leaving the first half visible.

### What changed
The preview is no longer revealed on the first fit. It stays hidden — showing
"Starting camera…" — until the fit is **unchanged for three animation frames**
(~50ms), or the existing 1200ms hard timeout fires, whichever comes first. You
see black, then the correct size, never the wrong one. Both reveal paths (first
frame, and returning from the Adjust screen where the thumbnail strip has just
changed the box) go through the same helper.

### Stated plainly
I still cannot explain *why* the first measurement is wrong. I worked the
arithmetic from the screenshot and the small size is not a `containFit` result
against the full box, so my model of it is incomplete. This release does not
fix that — it stops the unsettled state being visible. If the preview ever
appears at the wrong size and *stays* there, the cause is still unfound and the
diagnostic will show it.

### The harness caught a real bug
Adding the settle loop broke the headless harness: `requestAnimationFrame` is
not defined there. That is not merely a test-environment quirk — the reveal now
depends on that tick, and a preview that is never revealed is a **permanently
black scanner**. It now falls back to a timer. A genuine robustness hole, found
because the harness runs the real app rather than grepping it.

### Diagnostic
Press and hold "Scan document": `… settled 48ms (stable)` or `… settled 1201ms
(timeout)`. A timeout there means the fit never stopped changing, which would
be a different and worse bug than the one being fixed.

scan 225 → 229. Seventeen suites green, corpus green.

## [v11.86] — 2026-07-29 — Measuring against the screen, not against the viewport

Third attempt at the bottom gap, and the first with the right reference.

### Why the previous two could not work
v11.83 and v11.85 both measured the toolbar against `window.innerHeight`. On an
iPhone 16 Pro Max in standalone that reads **zero while the gap is plainly on
screen** — because the bar IS exactly where `bottom:0` puts it. The layout
viewport itself is short. Measuring the bar against the very thing that is too
small can never see it.

### The clue was in the screenshots
Three screenshots, and the gap correlates perfectly with the **"Ready…" toast
being visible**. The toast is not a cause — it is `position:fixed` and cannot
push anything. It is a **clock**: it shows for a few seconds after launch and
fades. So the gap is a launch-time state that settles by itself, which is
exactly why it appears "sometimes" — it depends on when you look.

### Two references
| term | question | catches |
|---|---|---|
| 1 | is the bar where the viewport says the bottom is? | a mis-positioned bar |
| 2 | does the **viewport** reach the bottom of the **screen**? | the real case |

Term 2 uses `screen.height`, which does not move. It is gated hard:

- **installed standalone only.** In a Safari tab `innerHeight` is legitimately
  far smaller than the screen, and pushing the bar down there would put it
  under the browser UI.
- **shortfall ≤ 120px only.** A large difference is a genuinely smaller window
  (iPad multitasking), not this bug.
- the screen axis is picked by orientation, since iOS does not swap
  `screen.width`/`height` on rotation.

### The convergence is simulated, not asserted
With the correction applied, term 1 reads `-drop` and term 2 reads `+short`, so
the next value is exactly `short` — no oscillation, and it unwinds itself when
iOS later expands the viewport. `SC185c`–`SC185e` run that loop and check it:
converges to a flush bar in one step and holds; unwinds when the viewport
catches up; never touches a device that was correct from the start.

### If it is still wrong
About now shows `Bottom bar 898/898/956 drop 58px` — the bar's edge, the
viewport, the screen — and `Display mode: standalone`. Those three numbers
identify which term is failing without another round of guessing.

scan 218 → 225. Seventeen suites green, corpus green.

## [v11.85] — 2026-07-29 — Both of those, actually fixed

You reported both again. v11.83 and v11.84 did not work, and in each case I can
say exactly why.

### The bottom gap: v11.83 could not have worked
Two independent mistakes, either of which alone was fatal.

**1. It measured the wrong thing.** `visualViewport.height + offsetTop -
innerHeight`. On your device those agree *even when the gap is on screen*, so it
read `0px` and did nothing at all.

**2. Even with a correct number, it could not have moved the bar.** I applied
the correction as **padding** on an element with `bottom:0`. Padding on a
bottom-anchored element grows it **upward** — the bar would have got taller and
its bottom edge would have stayed exactly where it was.

My own test `SC183` asserted "the toolbar grows downwards rather than moving
down", which is a description of the defect. Writing a confident sentence about
a thing does not make the thing true, and a test that agrees with the sentence
rather than the behaviour is worse than no test.

Now: the correction is measured on **the toolbar's own bottom edge** against
`window.innerHeight` — the symptom itself, requiring no theory about why the
layout viewport is short — and applied as a **negative `bottom`** plus matching
padding. The bar moves down onto the real screen bottom; the buttons stay put;
its top edge is unchanged, which is why the floating controls above it are
deliberately *not* shifted (`SC183b`).

### The scanner preview: v11.84 assumed the change would be observed
A `ResizeObserver` on the viewfinder only helps if the box change is what the
observer sees. It shipped on that assumption and did not fix it.

`fitPreviewBox()` is now called from the **live-detect tick that already runs
while the camera is up**. It no-ops unless the box or the stream size actually
changed — two integer reads — so it costs nothing and converges within one tick
*whatever* moved the preview and *whenever*. The observer stays, but nothing
depends on it any more.

### Also
`Scan a document` → `Scan Document`.

### The diagnostic is now the measurement
About shows `Bottom bar 812/866 drop 54px` — the bar's own edge, the window
height, and the correction being applied. If the gap appears and it reads
`drop 0px`, the measurement is wrong and that says so directly.

scan 214 → 218. Seventeen suites green, corpus green.

## [v11.84] — 2026-07-29 — The preview follows its box

Reported: the scanner opens with the picture drawn small — about 75% of the
width it should be — with "Starting camera…" showing through the letterbox
beside it, then it snaps to normal.

### This was my own v11.71 fix biting back
`fitPreviewBox()` writes explicit pixel geometry, which is what made the
preview fill the viewfinder in the first place. But it ran **once, at the first
frame**, so anything that resized the container afterwards left the video at
the old size. At least three things do:

- the Type row appearing (v11.80 put it under the viewfinder)
- the thumbnail strip appearing after page 1
- **iOS settling the standalone viewport a beat after launch** — which v11.83
  established, one release ago, really does happen on this device

A `ResizeObserver` now watches the viewfinder itself. It does not matter which
of those moved it: any change to the box re-fits. Re-fits are coalesced per
animation frame, so a layout settle cannot feed itself, and the window
listeners remain for engines without ResizeObserver.

`resumeCamera` — the path back from the Adjust screen — bypasses the first-frame
code entirely, and that is precisely when the box has just changed because the
thumbnail strip appeared. It now re-fits for itself.

### The label was showing through
"Starting camera…" sits UNDER the preview, on the assumption the video covers
it. While the video was drawn too small it showed through the letterbox beside
it. It is now hidden explicitly once there is a picture, on both reveal paths,
and restored when the camera stops so the next open still explains itself.

### Two tests were brittle rather than wrong
`SC105` read a fixed 400 characters of `stopCamera` and `SC133` required two
lines to be adjacent. Adding a line between them broke both while the
behaviour they guard was untouched. `SC105` now reads the whole function, and
`SC133` asserts that **every** reveal path reaches `sizeQuadCanvas` — which is
the actual invariant, and is stronger than the adjacency it replaced.

scan 207 → 214. Seventeen suites green, corpus green.

## [v11.83] — 2026-07-29 — The bottom bar reaches the bottom

Reported with two screenshots taken minutes apart: sometimes a band of black
sits below the toolbar, sometimes it does not.

### What the screenshots say
The header is in exactly the same place in both. So the page is not shifted —
the **layout viewport is ending about 52px short of the screen**, and a
`position:fixed; bottom:0` bar is honestly obeying it. That is an iOS
standalone-PWA behaviour, and it is intermittent, which puts it in the same
class as three other device-only bugs this session that I diagnosed wrongly
from a screenshot.

### So this measures rather than guesses
A new `--vvdrop` is computed from `visualViewport.height + offsetTop -
innerHeight` — how far the visible bottom sits below where `bottom:0` lands —
and added to every bottom-anchored control. Re-measured on resize, rotation,
visual-viewport scroll, and on **resume from background**, which is when iOS
settles the standalone viewport.

Two properties make it safe to ship without being able to reproduce it:

- **It is a no-op when nothing is wrong.** With the viewports in agreement the
  value is `0px` and every rule reads exactly as it did in v11.82. A blind fix
  for an intermittent bug must not be able to break the common case.
- **It is clamped to 0–120px**, so a transient measurement mid-rotation cannot
  push the toolbar off the screen.

The correction is applied as **padding** on the toolbar rather than as a
negative `bottom`. Growing the bar downwards keeps its background covering the
gap; moving it would only relocate the black band.

### A tidy-up that came with it
The bottom inset was the same 40-character expression repeated six times. It is
now `--botpad` (and `--botpad2` for the short-screen media query), named once.
That is what made adding the correction in one place possible rather than six.

### Confirming it on the phone
**About now shows the viewport numbers** — `visualViewport/innerHeight drop
Npx`. If the gap appears and About reads `drop 0px`, my diagnosis is wrong and
the numbers will say so in one round rather than several.

scan 199 → 207. Seventeen suites green, corpus green.

## [v11.82] — 2026-07-29 — Both sides / Single side, and the held front reappears

Interface only. The scan pipeline is still v11.77's, untouched.

### Both sides · Single side
The old control was an on/off toggle: "Both sides" lit meant two sides, unlit
meant one — which the button never actually said. It is now a one-of pair, with
**Both sides first and selected by default**, in the same segmented styling as
Type directly above it.

Both halves are set together in `refreshIdTwoSideBtn`. Lighting one without
clearing the other is exactly how a segmented control ends up showing two
selections at once, so `SC139f` pins it.

Like Type and Auto, the choice is now a **default rather than a remembered
preference** — reset each time the scanner opens. In v11.81 I deliberately left
this one alone because you had not asked about it; now that you have specified
the default, it joins the others.

### The held front side shows a thumbnail again
You reported this twice, and you were right both times. It was fixed in v11.78
and **lost when I reverted that release wholesale** — the fix was UI-only and
could not have affected image quality, but I rolled back the whole build rather
than picking it apart, and this went with it.

The thumbnail strip only ever mapped `scanPages`, and a held card side is not a
page yet. The front now appears the moment it is taken, marked with a dashed
edge and the word "front" instead of a number: it is not a page, and tapping it
discards the side rather than opening a review sheet for something that does
not exist.

### The test now drives your exact repro
`T13d`–`T13k` in the harness do what you described: scan a document page, then
switch to Photo ID **inside the same session**, capture the front, and assert
the strip shows it immediately. It also checks that leaving Photo ID drops both
the held side and its thumbnail, so a ghost front cannot survive into the next
card, and that the block leaves the scanner back on Document for the tests
after it.

`SC173` counts clear-sites: every place that sets `idPendingCard = null` must
clear `idPendingThumb` too. That is the invariant a piecemeal re-application
would most easily miss.

scan 188 → 199, harness 115 → 123. Seventeen suites green, corpus green.

## [v11.81] — 2026-07-29 — The scanner opens the same way every time

Interface only, again. The scan pipeline is still v11.77's, untouched.

### Type and Auto are defaults, not preferences
Tapping Scan now always starts at **Type = Document** with **Auto off**,
whatever the last session did. Neither is read back from storage any more, and
a value stored by an older build is cleared on load.

This matters more than it sounds for Type: a remembered **Photo ID** would
ambush the next document scan with card framing and A4 compositing, which is a
surprising way to lose a page. Auto is off because it takes the shutter out of
your hands — a reasonable thing to switch on for a stack of pages on a desk,
and a poor thing to inherit silently.

`idTwoSide` is deliberately **not** reset with them: it is a Photo ID
sub-choice, not one of the two defaults asked for, and resetting it would be a
behaviour change nobody requested.

### Both sides moved below Photo ID
It sits directly beneath the Photo ID half of the segmented pair, in the same
column and with the same button styling, so it reads as a sub-option of that
type rather than a separate control. The whole row hides when Photo ID is not
chosen — hiding only the button would have left an empty segmented track
floating under it.

### Delete removed
You were right that it duplicated Retake. Both dropped the capture being
reviewed and returned to the camera; the only difference was that Retake also
reopened the shutter on the fallback path. One action does not need two
buttons, so the action row is back to **Retake · Rotate · Use page**.

### Tests
`SC127d` asserted Delete sat beside Rotate; it now asserts no such button
exists and that Retake still occupies that role. `T9e2`/`T9e3` in the harness
drive Retake instead, and check it leaves already-accepted pages alone.

`T9e0a` is the one worth naming: it reads the **live state** after the scanner
opens rather than grepping the source, because a default that is written and
then overwritten by a stored preference would still pass a source check. That
is exactly the failure this release is about.

scan 180 → 188, harness 113 → 115. Seventeen suites green, corpus green.

## [v11.80] — 2026-07-29 — Type before the shutter, and three fewer choices

Interface only. **No change to how a captured page is processed or encoded** —
the scan pipeline is v11.77's, untouched, which is the build whose output was
good.

### Type is chosen before you capture, not after
It used to sit on the Adjust screen, after the shot. That was backwards: in
Photo ID the type decides how the page is framed, warped and composited, so
picking it afterwards meant the live preview and the auto-capture gate were
working to different rules from the result. It now sits under the viewfinder,
where it is a decision about what you are about to photograph.

### Look becomes Type, and loses a value
| was | now |
|---|---|
| Plain · Whiten · Photo ID | **Document** · Photo ID |

- **Plain is gone.** It was the unprocessed capture; every document scan now
  gets the illumination flattening that used to be called Whiten.
- **Whiten becomes Document**, and is the default. The old name described the
  filter; the new one describes what you are scanning.
- **Photo ID is unchanged**, and **Both sides** now sits beside it rather than
  in the row below — it is a property of that type and means nothing for a
  document, so it appears only when Photo ID is chosen.
- Leaving Photo ID lands on Document. With no third state there is nothing else
  to fall into, and the code says so explicitly rather than relying on a flag
  happening to be true.

### Delete, beside Rotate
Throws away the capture you are looking at and returns you to the viewfinder.
Deliberately not the same as Retake, which reshoots immediately — that is what
you want when the shot was bad; Delete is for when you did not want the page.

It discards only the capture being reviewed. Pages already accepted are
untouched, and a cancelled *retake* clears its pending slot so the page it was
started from survives (`SC127e`).

### HQ is removed
It routed the shutter to the iPhone's own camera for a full-resolution still.
That did give more pixels — but it cost the live green outline and hands-free
capture, and it caused a run of "two cameras" bugs across v11.62, v11.65 and
v11.66, because a native camera and a live preview can never both be on screen.
Since v11.76 the 4:3 sensor request recovers most of that resolution inside the
normal preview, so the trade stopped being worth it.

`camInput` deliberately **survives**: it is also the fallback for a device with
no live camera, which has nothing to do with HQ. `SC78c` pins that.

### Tests rewritten rather than deleted
Eighteen assertions pinned features this release removes. Each now states the
removal instead:

- `SC75`–`SC78` asserted how HQ behaved; they now assert no trace of it
  survives — measured against a **comment-stripped** view of the source, since
  the comments legitimately still explain why it went.
- `SC100`–`SC104` pinned the machinery keeping two cameras apart. `SC100` now
  counts every `camInput.click()` call site and requires all of them to be
  fallback-guarded, which is a stronger statement than the three releases of
  fixes it replaces.
- `SC123`–`SC127` followed Look to Type, plus new checks that Type is on the
  camera screen *before* the shutter and that Delete sits beside Rotate.
- `T9e` in the harness drives the real DOM: Document lit by default and alone,
  Photo ID exclusive, Document not un-choosable, and Delete leaving accepted
  pages alone.

Seventeen suites green (scan 177 → 180, harness 108 → 113).

## [v11.79] — 2026-07-29 — Restore point: v11.77, renumbered

Code identical to v11.77 in every respect — only `APP_BUILD`, the service
worker cache name and `data-build` change. It exists so the PWA on the phone
sees a NEW version and refetches, since v11.78 had already been installed under
a higher number and a straight rollback to "11.77" would look like an older
build to anyone reading the About sheet.

Nothing else in this release. It is the known-good scanner, renumbered, and the
baseline the v11.80 interface work is built on.

## [v11.78] — 2026-07-29 — REVERTED, DO NOT RE-APPLY WITHOUT A DEVICE TEST

> **Reverted on 2026-07-29.** On the phone this made scans worse again. The
> tree is back to v11.77 byte for byte, verified by comparing every shipped
> file against `backups/v11.77-2026-07-28.zip`.
>
> Everything below shipped together in one release, which is exactly why it
> cannot be salvaged piecemeal from here — I do not know which of the four
> changes did the damage. The candidates, in the order I would suspect them:
>
> 1. **JPEG budget 900 KB → 780 KB.** Most likely. I judged q0.80 against
>    q0.72 "indistinguishable" from a Pillow re-encode of an already-compressed
>    page. That is a re-compression of a compression — not the same thing as
>    the phone encoding once at q0.72 — and I had already been caught out once
>    this session assuming Safari's encoder matches Pillow's.
> 2. **Photo ID card 46% → 78% of the sheet.** Affects ID scans only.
> 3. **`maxDim` 3500 → 3508.** Should be inert; the capture does not reach it.
> 4. **The held-side thumbnail.** UI only, cannot touch image data.
>
> If any of this is wanted again it should go back **one change at a time**,
> each tested on the phone before the next. The size reduction in particular
> was my suggestion, not a request, and it was not worth it.

## [v11.78 — original entry] — Photo ID gets its pixels back, and a correction

### Correcting v11.77
I said raising `maxDim` to 3500 would give 300 dpi. It gave **278**. The real
v11.77 page came out **3255px — below the cap**, so the sensor was the limit
after all, not the constant. The cap is harmless where it is (it no longer
binds; it is now 3508, exactly 300 dpi on A4, for when a future capture can
reach it) but it is not what improved the picture.

What improved was quality, and not the way I described either. v11.76's 714 KB
was against a **700 KB** budget, so it had already been stepped down to the
q0.70 floor — my earlier claim that it "settled at q0.80 and never stepped
down" was wrong, based on comparing Safari's encoder output against Pillow's.
v11.77's 900 KB budget let it hold q0.80. That is the whole 714 → 869 KB
difference.

### Size: 869 KB → about 760 KB, invisibly
The same v11.77 page re-encoded at q0.72 is **indistinguishable from q0.80** at
100% on this text. The budget is now **780 KB**, which lets a sparse page hold
q0.80 and eases a dense one down a notch nobody can see.

### Photo ID: the card was being drawn small
The two-sided output had the card at **46%** of the sheet — roughly life size
for an ID-1 card — and the fine print on a driving licence read as mush, with
**37% of the page blank underneath**. The pixels were already captured; they
were being thrown away at the drawing step.

| | before | after |
|---|---|---|
| card width on the sheet | 1141 px | **1934 px** |
| height cap | 30% of page | 38% |
| blank at the bottom | 37% | **13%** |

A single card is now centred on the sheet too, instead of sitting 17% down with
half the page empty below it. An ID scan exists to be read, not to be a
facsimile at life size.

### The held front side now shows a thumbnail
Reported: in both-sides mode nothing appeared in the strip after capturing the
front — it filled in only when the back was done. The strip only ever mapped
`scanPages`, and a held side is not a page yet, so the one capture that most
needs confirming gave no confirmation at all.

The front now appears immediately, marked with a dashed edge and the word
"front" rather than a number, because it is not a page: tapping it discards the
side rather than opening a review sheet for a page that does not exist.

### A test caught a gap in my own fix
`SC155` checks that every place clearing the held card also clears its
thumbnail — otherwise a ghost front survives into the next card. It failed at
first (4 of 5), which sent me looking; the fifth match turned out to be the
`let` declaration, so the *test* was wrong, not the code. Fixed to exclude the
declaration and it now genuinely covers all four clear-sites.

`CP64e` was also rewritten rather than repaired: it asserted the budget was
large enough to *never* step quality down, and that premise is now deliberately
false. It checks the thing that still matters — that the floor stays at the
q0.70 that was measured as invisible, and that the budget is not so tight every
page hits it.

Seventeen suites green (scan 177 → 185, compress 90 → 91), corpus green.

## [v11.77] — 2026-07-28 — 300 dpi, because v11.76 proved the ceiling had moved

### v11.76 worked, and that is measurable
Comparing five real scans of the same document:

| version | size | resolution | text |
|---|---|---|---|
| v11.73 MRC | 201 KB | 133 dpi bg + 1-bit | redrawn, small print merged |
| v11.74 | 1,139 KB | 219 dpi | good — and 4× the size for nothing |
| v11.75 | 605 KB | 222 dpi | identical to v11.74 at half the size |
| **v11.76** | **714 KB** | **274 dpi** | **crispest of the five** |

The 4:3 request paid off — 222 → 274 dpi — and, importantly, **it did not
over-expose**: blown-highlight fraction 0.321 against v11.75's 0.459. The
fallback never had to fire, which is the outcome v11.41 assumed and never
checked.

### The ceiling had moved from the camera to a constant
v11.76's page came out **2272 × 3200** — exactly `maxDim`. The sensor was
handing over more than was being kept, so the limit was no longer the camera.

`maxDim` 3200 → **3500**, which is 299 dpi on an A4 long edge: the figure
Acrobat and Adobe Scan treat as standard for a document.

The budget rises 700 KB → 900 KB with it, because otherwise it would undo the
resolution it had just been given. Measured: the same page at 3500px and q0.80
is about 860 KB. Worth noting v11.76 was *not* being stepped down — its 714 KB
re-encodes to 697 KB at q0.80 — so the old budget was exactly at its useful
edge, not past it.

Expect about **860 KB a page at 300 dpi**, against 714 KB at 274.

### One thing found while making the change
The capture path had a hardcoded `3200` sitting beside a constant of the same
value: `const cap = scanHiQ ? HQ_MAX_DIM : 3200`. Raising one and not the other
would have quietly left the native-photo path a resolution behind the live one.
It now reads `SCAN_Q.std.maxDim`, and `SC76b` asserts the number is not
duplicated as a literal anywhere.

### Tests
`CP64c` follows the new figures, and two new assertions check the *intent*
rather than the digits: `CP64d` computes that `maxDim` really is ~300 dpi on
A4, and `CP64e` that the budget is large enough not to step it back down. Those
would have caught raising one without the other.

Seventeen suites green (scan 176 → 177, compress 87 → 90), corpus green.

## [v11.76] — 2026-07-28 — The last gap to Adobe Scan was resolution, not encoding

Reviewing the v11.73/74/75 scans side by side put the remaining difference in
one place. It is not the filter chain, the JPEG quality or the format — it is
how many pixels the capture has in the first place.

`corpus/USER-hq-scan.pdf` happens to contain both paths in one document:

| capture | pixels | dpi on A4 |
|---|---|---|
| HQ — the iPhone's own still photo | 2633 × 3598 | **308** |
| preview frame — the default | 1975 × 2599 | **222** |

Adobe Scan takes a full still photo, which is how it reaches ~300. A portrait
page inside a 16:9 preview is bounded by the **2160** short side, and that is
the entire ceiling. Everything tuned since v11.72 has been downstream of it.

### Asking for the 4:3 sensor mode again — this time with a check
iPhones expose a 4:3 mode at 4032×**3024**. A portrait page bounded by 3024
instead of 2160 is about **+40% linear, roughly 310 dpi**, with the live
outline and auto capture intact.

v11.41 asked for exactly this and shipped it. On a real iPhone the capture mode
it selects over-exposed white paper and scans came back burnt, so v11.55
reverted it and pinned the revert. **What was missing then was not the idea but
the check** — nothing measured the result before trusting it.

v11.63 added `frameStats()`, which reports the blown-highlight fraction, and
`AUTO.MAX_BLOWN` already defines "too blown" for the auto-capture gate. So the
request is now made *and verified*: 900 ms in, once auto-exposure has settled,
the preview is sampled; if the paper is burning out, `applyConstraints` puts
the stream back to the 16:9 mode that was known to expose correctly and says
so. Once per scanning session, and any failure leaves the working preview
alone — resolution is worth nothing on paper that is white.

The camera diagnostic (press and hold "Scan document") now reports it:
`… blown 2.3% (high-res mode kept)` or `… blown 11.4% -> FELL BACK to 16:9`.

### SC69 changed meaning, deliberately
That test existed to stop the 4:3 request coming back. It is rewritten rather
than deleted, because what it protects still matters — the invariant is no
longer "4:3 is absent" but **"4:3 is never trusted unchecked"**: the 16:9 mode
stays reachable by name, the check uses the same measure as the auto-capture
gate, a failure cannot break the preview, and it re-runs each session.
`SC69`, `SC69b`, `SC69d`–`SC69h`.

### Honestly stated risk
This is the change that burnt us once. It is now self-correcting and tested in
Node, but the failure mode only appears on a real iPhone. **Scan one page and
press-and-hold the title**: if it reads "high-res mode kept" the page should be
around 300 dpi; if it says it fell back, the guard worked and nothing is worse
than v11.75.

Seventeen suites green (scan 171 → 176), corpus green.

## [v11.75] — 2026-07-28 — Half the size of v11.74, and identical to look at

v11.74 restored v11.31's quality and, with it, v11.31's file sizes — about four
times v11.73. Comparing the two real scans showed the size was not coming from
the *format* at all. It was the JPEG quality.

A standard scan started at **q0.92** against a 1.4 MB budget, so a page that
came in under 1.4 MB never stepped down and was simply stored at q92 — far more
than a document needs. Re-encoding a real v11.74 page (a 219 dpi endoscopy
report) at its own resolution:

| quality | page image |
|---|---|
| q92 — what v11.74 shipped | 1,138 KB |
| q85 | 749 KB |
| **q80** | **561 KB** |
| q74 | 501 KB |

The same line of text at q92, q82 and q74 is **indistinguishable at 100%**, and
the endoscopy photograph shows no blocking at q78. The top of that range was
buying nothing.

Standard scans now start at **q0.80 against a 700 KB budget**, with the floor at
q0.70 so a dense page can still ease down rather than blow past. Nothing else
changes: same resolution, same continuous tone, same processing as v11.74.

Measured on your own file: **1,140 KB → about 563 KB**, settling at q80 without
needing to step down at all.

`HQ_BUDGET` moved 1.1 MB → 1.3 MB, which is a loosening and deliberate: an HQ
page carries about 2.1× the pixels, so at the new quality it lands near 1.2 MB
by itself. Holding the old ceiling would have made the encoder spend HQ's extra
detail on meeting a budget, which is the one thing HQ exists not to do. `CP64`
now also asserts it stays under 2 MB, so the guard against the v11.61 balloon
(2.73 MB for one page) is still real.

### Where that leaves the three options
| | size | text |
|---|---|---|
| v11.74 | ~1,140 KB | continuous tone |
| **v11.75 (now)** | **~563 KB** | **identical to v11.74** |
| MRC, under Compress | ~200 KB | redrawn 1-bit |

Seventeen suites green, corpus green.

## [v11.74] — 2026-07-28 — The scanner goes back to what v11.31 did

You were right, and diffing v11.31 against today says exactly what changed.

### The pixel processing never changed
`colourBalanceCore`, `applyAutoContrast`, `flattenIllumination`,
`documentEnhance` — all identical to v11.31, called in the same order, from the
same place. **Nothing about how a captured page is processed has changed since
the build you liked.**

Which also means my v11.73 diagnosis was wrong. I softened `applyAutoContrast`
because it clipped 12.6% of the page to pure white. The measurement was right;
the conclusion was not. That function is byte-for-byte identical in v11.31, so
the clipping was never the fault — it only became *visible* once a 1-bit
stencil was laid over it. **Reverted, byte for byte.** I was changing
known-good behaviour to compensate for something added later.

### What actually changed: two compression stages that v11.31 did not have
v11.31's `createScanPdf` writes the captured pages into the PDF and stops. No
`shrinkScanPdf`, no `recompressImages`, no MRC. Since then:

| added | what it did to every new scan |
|---|---|
| v11.62 `shrinkScanPdf` | re-encoded the page at **q68 / 300 dpi**, down from the captured **q92 / 3200px** (~387 dpi) |
| v11.68 MRC | replaced continuous-tone text with a **1-bit stencil**, which merged 6pt print |

Both applied automatically, to every scan, with no way to decline. Everything I
have been tuning for the last several rounds has been *inside those two
stages* — trying to make a lossy step look lossless.

### The fix
`shrinkScanPdf` is **removed**. A new scan is written exactly as captured —
q92, up to 3200px, continuous tone — which is what v11.31 did.

Making a file smaller is a decision with a cost, so it now lives where you make
decisions: **Compress → "Scanned pages — much smaller, text redrawn"**. It says
what it does before running, reports the saving, and leaves Undo available. On
the endoscopy report that is still 3,965 KB → ~450 KB, but only when asked for.

The MRC tuning from v11.72–73 is kept, because it is real and it makes that
option better when you choose it: grey fills stay grey, the stencil is 400 dpi,
strokes are not fattened, and the ink tone is measured rather than assumed.

### What this costs
A scan is now about **1.9 MB a page** instead of ~130 KB. That is the v11.31
number, and it is the price of the v11.31 quality you asked for. If a
particular file needs to be small, Compress is one tap.

### Tests
`CP63` and `SC141`–`SC142` pinned the removed stage; they now pin the opposite
invariant — that nothing compresses a freshly created scan, and that MRC is
reachable only as a deliberate action. `MR29`–`MR30` pin `applyAutoContrast`
back to the exact v11.31 curve, so it cannot drift again.

Seventeen suites green, corpus green.

## [v11.73] — 2026-07-28 — Measured against the camera, not against itself

The original 24MP photo of the page made this diagnosable for the first time.
Every previous round compared a scan against my idea of what it should look
like; this one compares it against the same page as the camera actually saw it
(414 dpi of real detail).

| | camera photo | v11.72 scan | v11.73 |
|---|---|---|---|
| paper | 214 | 254 | 247 |
| ink | 36 | 8 | 14 |
| blown to pure white | 0.0% | **12.6%** | **0.0%** |
| text resolution | 414 dpi, greyscale | 300 dpi, 1-bit | 400 dpi, 1-bit |

### It was not MRC — it was two filters that run in every mode
`applyAutoContrast` stretched the **2nd–98th** luminance percentiles onto the
full 0–255. That is fine on a wide-range image, but the photo's whole page
spans 47–219: the curve mapped 219 to 255 and clipped **12.6% of the page to
pure white**, while everything below 47 crushed to pure black. That is the
harshness, and it happens in *plain* mode too, which is why "plain" looked no
gentler than "whiten".

It now maps the 0.5th–99.5th percentiles into **6–248**, so neither end clips.
Same curve, headroom at both ends.

### Why the letters were merging
Crushed ink also broke the text. Once the halo around each glyph is pushed
toward black, more of it passes the ink threshold — and the stencil then
fattened every stroke by up to two pixels a side. On 6pt lab-report print that
is wider than the stroke itself, so letters ran together: **"Total" came out as
"Totaf"**. Three changes, tested against the photo:

- stencil **300 → 400 dpi** (500 cost another 100 KB for no visible gain — the
  capture is downsampled to 3200px, about 387 dpi, anyway)
- soft ink threshold **18 → 26**, so less of the halo qualifies
- core reach **2 → 1 pixel**, so a stroke stops growing

### Memory, because 400 dpi on A4 is 15.5 megapixels
Naively this pass would hold about 230 MB on the phone. The blur scratch is now
Uint8 rather than Float32 (62 MB → 15 MB), the soft mask is refined in place
instead of allocating another, and spent temporaries are released. The guard
rose to 26 MP so A4@400 passes and A3@400 is still refused.

Cost: the endoscopy scan goes 293 KB → 455 KB, still **89% below** the 3,965 KB
original.

### What is still different from the photo, deliberately
Paper is lifted to 247 and ink deepened to 14, against 214 and 36 in the photo —
a scan is meant to look like the document, not like a photo of it under room
light. The grey-world white balance also neutralises the paper's warm cast
(chroma 10.5 → 8.0). If you would rather keep the paper's real tone, that is one
constant and I can relax it.

### Tests
mrc-tests 29 → 40. `MR29`–`MR31` drive the real `applyAutoContrast` with the
same narrow tonal range as the photo and assert nothing clips at either end;
`MR32`–`MR35` pin the resolution, the two threshold changes, and that A4@400
fits the memory guard while A3@400 does not.

Seventeen suites green, corpus green.

## [v11.72] — 2026-07-28 — Grey is not ink

Three scans from the phone (plain, whiten, HQ) came back harsh, with a
blackish hue. All three had the same defect, and it was mine — introduced with
MRC in v11.68.

### What was happening
On the lab report, the light-grey screened band behind the header came back as
a **mottled black smear**. Pulling the two MRC layers apart showed why: in the
background layer the band had been **erased to paper**. Its tone was not stored
there at all — the whole band had been claimed by the 1-bit stencil, which then
painted it as speckled black.

The cause was a single ink threshold. `gray < paper - 18` asks only "is this
darker than the paper", and a 20% grey screen sits about **45 below paper**, so
all of it qualified. And because a screened band is a halftone pattern plus
sensor noise rather than a flat tone, it did not fail cleanly — **37%** of it
crossed the line, which is exactly what produces mottle rather than a solid
block.

### The fix: two thresholds instead of one
| | test | meaning |
|---|---|---|
| core | below **60%** of local paper | unambiguously ink |
| soft | **18** below local paper | ink, or a grey fill, or noise |

A soft pixel joins the stencil only within 2px of a core pixel. A glyph keeps
its anti-aliased edge; a grey fill, which contains no core ink anywhere, stays
in the background and keeps its real tone. Reproduced first as a failing test —
band **37.3% → 0.0%**, body text still 100%, and dark text sitting *on* the
band still 100%.

### Two other causes of "harsh"
- **The stencil painted pure black.** Real scanned ink is not black: measured
  on these files it is **46/255** (endoscopy) and **53/255** (200dpi scan). The
  stencil now paints the page's own measured ink tone, clamped so a faint scan
  cannot wash out. Text stays crisp without the laser-print hardness.
- **Background quality 58 → 68.** Grey fills now live in that layer, so it
  carries more of what the page looks like and is worth spending on. The
  endoscopy scan goes 258 KB → 293 KB — still **93% below** the 3,965 KB
  original. A 2.5× background instead of 3× cost +47% for no visible gain on a
  text page, so it stopped there.

### Tests
mrc-tests 22 → 29. `MR22`–`MR25` build a halftoned grey band with text on it
and on the page below it, and assert on the segmentation directly; `MR26`–`MR28`
pin the mechanism. The grey-band case is now part of the suite, so this cannot
come back quietly.

Seventeen suites green, corpus green.

**Please re-scan the same report and compare.** The band is the thing to look
at: it should be a smooth grey with black text on it, not a dark smear.

## [v11.71] — 2026-07-28 — The viewfinder fills the viewfinder

### What I got wrong in v11.69
I read "opens as a small window, then becomes normal" as a *transient* — iOS
switching capture mode mid-open — and fixed it by hiding the preview until the
first frame. A screenshot then showed the real problem: the preview is a small
narrow window in a large black area **permanently**. The fade-in was a fix for
something that was at most half the story.

### The actual geometry
The stream is 9:16 — iOS returns the 4K capture rotated to portrait — and the
viewfinder box is roughly 0.61 wide-to-tall. A contain fit should therefore
letterbox it slightly at the *sides* and fill the height. On the device it was
doing neither, which means `height:100%` was resolving against something
smaller than the box on screen.

I could not determine what, from a screenshot, and guessing again was not worth
another round. So the preview no longer depends on it: `fitPreviewBox()`
measures the viewfinder box, computes the fit, and sets explicit pixel
geometry. Whatever the percentage was resolving against, the result is now the
same everywhere. It is recomputed on rotation and when the box changes, not set
once.

### The part that may explain an older report
The preview is now positioned with **`containFit()` — the same function the
green document outline is positioned with.** The outline is drawn at
`containFit(video, canvas)` on a canvas matching the viewfinder box, so if the
video is drawn to any *other* fit, the outline lands somewhere other than the
image. That is indistinguishable from "the green box never appears", which was
reported back in v11.55 and never fully explained. One fit function for both
now, pinned by `SC144`.

### The diagnostic I shipped was unreachable
v11.69 put the camera diagnostic on a long-press of the page counter. That
counter is **empty until a page has been captured** — so on the screen where
you need it, there was nothing to press. It is now on the "Scan document"
title, and also reports the viewfinder box, the stream size, and the size the
preview was actually drawn at.

**Press and hold "Scan document"** to see, for example:
`gUM 210ms · frame 480ms (frame) · 2160x3840 @480ms · box 398x650 · video
2160x3840 · drawn 366x650`.

### Tests
scan-tests 160 → 171. `SC143` runs the real `containFit` from app.js against
the reported geometry (a 9:16 stream in a 398×650 box) and asserts it fills the
height at 366×650 with zero vertical offset — a computed result, not a source
grep. `SC144` pins that the preview and the outline share one fit function.

Seventeen suites green, corpus green.

**Still device-untested** from v11.63 onward — and this one in particular needs
your eyes, since the cause was never reproduced here.

## [v11.70] — 2026-07-28 — Four settings become one, because MRC did their job

The scanner's review row is now a single **Look** control (Plain · Whiten ·
Photo ID) and a **Page** chip. Quality and Colour are gone — not hidden,
removed — because v11.68's MRC compression made both of them cost quality for
no saving.

### Quality: measured, then deleted
The question was whether "Small file" still earns its place. It does not.
Measured on a 38-line A4 document, straight through the shipped code path:

| capture | scan | after MRC |
|---|---|---|
| Standard (maxDim 3200, q0.92) | 181 KB | **37 KB** |
| Small file (maxDim 1400, q0.62) | 71 KB | **38 KB** |

Small file is not even smaller once MRC has run — and it gets there by
capturing at 1400px, roughly **120 dpi** on A4, which is *below* the 300 dpi
MRC renders its text stencil at. It was throwing away the resolution MRC needs
in exchange for a kilobyte in the wrong direction. `scanQuality` is now a
constant pinned to `"std"`.

### Colour: removed for the same reason
Greyscale and black & white existed to make a text page small. MRC does that
by storing the text as a 1-bit 300 dpi stencil **while keeping the colour of
everything else**, so choosing B&W now only loses the colour. Scans are always
colour. `toGreyscale` and `toBlackAndWhite` stay in `scan-core.js` — the
bilevel compressor still uses them, and they are still tested.

### Page: A4 or as captured
Letter and Legal left the scanner's cycle. They remain in `PAPER_SIZES` and are
still offered under Resize pages for documents that need them; on a phone scan
they were only ever taps to get past.

### Defaults
- **Whiten** is the default Look (unchanged, now stated).
- **Photo ID captures both sides by default.** A card has two sides worth
  keeping far more often than not, and the old default meant scanning the back
  separately and merging afterwards.

### Photo ID now opts out of MRC
Found while checking the above, and worth stating plainly because it was nearly
missed. An ID card is only about a tenth of an A4 sheet, so a Photo ID page is
**not** "mostly picture" — MRC's existing guard does not fire, and it would
happily store the card in the 100 dpi background.

On a synthetic card the fine print actually came out *sharper* than the
original, because it is near-neutral and went into the 300 dpi stencil. But a
real ID also carries a face photograph and a hologram, and those are exactly
the pictorial parts that would be softened. Photo ID exists to be colour-true
and lightly processed, so pages captured in it are tagged, and one such page
opts the whole document out of MRC. `shrinkScanPdf` gained an `allowMrc`
parameter that defaults to running it, so no other caller changed.

This is a judgement call made on a synthetic card, not on a real ID. If a Photo
ID scan looks worse than it should, that safeguard is the first thing to
revisit.

### Tests
scan-tests 145 → 160, harness 104 → 108. `T13b` checks the Photo ID tag on the
real captured record rather than by grepping source — a typo in the property
name would leave every page silently un-tagged and the opt-out would never
fire. `SC117`, `SC128`, `CP63` and `T10` were rewritten rather than deleted:
each pinned a control that no longer exists, so they now pin what replaced it,
including that a `small` or `bw` setting stored by an older build is cleared
rather than left stranded with no UI to change it.

Seventeen suites green, corpus green.

**Not yet verified on the phone.** v11.63–v11.70 are all still device-untested.

## [v11.69] — 2026-07-28 — Opening the camera once, and controls that admit what they are

### The camera no longer opens twice
Reported: the viewfinder appears as a small window, then becomes a normal one.

The preview is `object-fit:contain`, so it is letterboxed to the stream's
aspect ratio — and iOS starts the camera in a lower-resolution mode before
switching up to the 3840×2160 we ask for. Every `videoWidth`/`videoHeight`
change resizes the letterboxed image, which is the resize you can see.

The preview is now held at `opacity:0` until the first real frame arrives
(`requestVideoFrameCallback`, falling back to `loadeddata`), with "Starting
camera…" in the reserved space underneath, then fades in over 180 ms. Nothing
here makes the camera start faster — it stops the half-started states being
visible, which is the actual complaint.

Two supporting changes:

- The three-rung `getUserMedia` ladder is now two. Every constraint in it is
  `ideal`, and an ideal constraint *degrades* rather than rejects, so the
  middle rung could never run — it was startup cost for nothing. The 16:9 4K
  request is still first, and `SC69` still pins that, since the 4:3 mode
  over-exposed paper back in v11.41.
- The reveal is a CSS class, and JS adds it on a 1200 ms timeout regardless of
  events, so a device quirk cannot leave the scanner permanently black.

**This is a blind fix.** The behaviour only happens on the phone, so rather
than guess twice, v11.69 also records what the camera actually did — how long
`getUserMedia` took, when the first frame landed, and every resolution the
stream reported. **Press and hold the page counter in the scanner** to read it
back. If the sizes list shows one resolution and no changes, my diagnosis is
wrong and the numbers will say so.

### The review controls say what they are
The row under the preview was five identically-styled pills that were in fact
**four different kinds of control**:

| Looked like | Actually was |
|---|---|
| Standard · Small file | a one-of pair |
| Whiten · Photo ID | two toggles that silently cancelled each other |
| Colour | a three-way cycler showing no value |
| Page: A4 | a picker |

Now the shape carries the rule. **Look** (Plain · Whiten · Photo ID) and
**Quality** (Standard · Small file) are labelled segmented controls, and
**Colour** and **Page** are chips that show the value they hold.

The substantive fix is Look. Whiten and Photo ID were separate booleans, and
turning Photo ID on quietly switched Whiten off — correct behaviour, but
nothing on screen said so, and the pair could be read as "both on", a state
that never existed. Three segments make the exclusivity visible, and choosing
Plain now leaves Photo ID *properly* (releasing a held front side) rather than
just unlighting a button. `setScanEnhance` and `setScanIdMode` keep their
signatures and storage keys, so nothing downstream changed.

"Colour" also used to read as an instruction — *make it colour* — rather than
a statement that colour is what it currently is. It now shows `Colour · Black
& white`.

### Tests
scan-tests 132 → 145. `harness.mjs` caught the real behaviour change on its
own: `T9e` tapped Whiten twice and expected it to switch off. That is exactly
what stopped being true, so the test now asserts the new invariant — exactly
one of the three lit, Whiten stays on when re-tapped, and Plain clears it.
`SC69` was rewritten rather than deleted: the ladder changed shape, but what
it guards (16:9 first, 4:3 never) is pinned again.

Seventeen suites green, corpus green.

**Not yet verified on the phone.** v11.63–v11.69 are all still device-untested.

## [v11.68] — 2026-07-28 — MRC: the compression the paid scanners use

### The problem
An HQ scan of a two-page endoscopy report came to **3,965 KB**. The v11.62
image pass got it to around 1.4 MB by re-encoding, and could go no further
without either blurring the text or destroying the photographs — because a
scan is one big JPEG, where a letter and a photograph cost exactly the same
per pixel.

### The fix — two layers instead of one
**MRC (mixed raster content)** splits the page:

| layer | what | how stored |
|---|---|---|
| stencil | the text, and only the text | 1-bit at 300 dpi, CCITT G4 |
| background | photographs, colour, paper texture | colour at 100 dpi, JPEG q58 |

Text keeps sharp 300 dpi edges for a few KB. Photographs and paper texture,
where softening is invisible, are stored small. Measured, whole documents,
through the shipped code path:

```
corpus/USER-hq-scan.pdf      2pg   3,965 KB  ->  261 KB   (93% smaller)
corpus/SEED-scan-200dpi.pdf  2pg     881 KB  ->  167 KB   (81% smaller)
```

MRC is a **candidate, not a rule**: `shrinkScanPdf` now runs both it and the
ordinary image pass and keeps whichever is smaller, starting from the input
itself, so a scan can never come back bigger than it went in.

### What it refuses to touch, and why
Three refusals matter more than the ratio, because each failure would be
silent — a file that opens fine and is quietly worse.

- **Any page carrying real text.** MRC rasterises. Applying it to a typed PDF
  would turn selectable text into a picture and break search, copy and the
  text editor at once. Verified: `USER-merged.pdf`, `SEED-photo-heavy.pdf` and
  `SEED-invoice-reportlab.pdf` are all declined in under 25 ms.
- **Pages that are mostly photograph.** The one case where MRC actively hurts:
  little text to sharpen, and the whole picture stored at a third of its
  resolution. It would get *smaller and worse*, which no size check can
  detect, so it is refused and the image pass keeps full resolution.
- **Pages too large to segment safely** (>14 MP), as a memory guard.

### What went wrong on the way, since it shaped the code
The first working build produced numbers that looked good — 4.4% ink, 91 KB
stencil, 216 KB total — and a page that was **wrecked**: the text tore into
horizontal stripes partway down and the photographs came out as solid black
blocks. Three things were wrong, and none of them threw an error:

1. **`ccittG4Encode` takes one byte per pixel, not a packed bitmap.** Fed a
   packed bitmap it emits a stream that decodes for a few hundred rows and
   then loses sync. The stencil is now round-tripped through **libtiff**, an
   independent decoder — 9.0 M pixels, zero mismatches.
2. **A picture is a region, not a pixel.** Deciding per pixel let scattered
   dark pixels inside an endoscopy photograph into the stencil, where they
   painted black speckle across the image. Classification is now done on
   16-px blocks, with an opening to drop lone false positives and a one-block
   dilation to cover photo edges.
3. **Ink fraction cannot separate text from pictures.** A block inside a bold
   stroke measures 1.0 — higher than any photographic block — so using it
   dragged the headings into the background and blurred them. Measured on the
   real file, the cues that *do* separate are colour (text 0–10, photographs
   98–164) and solid mid-tone content.

A fourth, smaller one: the stencil paints a single colour, so coloured ink is
now left to the background. Otherwise the navy hospital logo rendered black.

### Tests
New suite `tests/mrc-tests.mjs`, **22 assertions**, asserting on *rendered
pixels* rather than byte counts — every failure above produced a file of
plausible size. Both historical bugs were re-injected to confirm the suite
catches them: removing the region test fails MR6 with "3341 leaked", and
restoring the packed bitmap fails five tests including MR14 "93% dark", which
is exactly the black-blob damage seen on screen.

`CP63` was rewritten rather than deleted: `shrinkScanPdf` changed shape, but
the invariant it guards — never hand back something larger — is pinned again
in the new form, plus two assertions that each candidate wins only when
strictly smaller.

Seventeen suites green.

**Not yet verified on the phone.** v11.63–v11.68 are all still device-untested.

## [v11.67] — 2026-07-28 — Colour modes, and fixing one page without redoing the stack

### Colour · Greyscale · Black & white
The choice every scanner app puts in front of the user, and the one this app
never had. It is not a filter — it decides how the page is **encoded**, which
is where nearly all of a scan's size lives. New button in the crop row, beside
the paper size, remembered between sessions.

**Black & white is the interesting one.** It thresholds against the page's
*own local paper level* rather than a fixed grey, which is what stops a
shadowed corner turning solid black — measured on a page with a shadow across
it, ink comes out at 22% on the bright side and 21% on the shadowed side,
where a fixed threshold would have flooded one end. Once the page really is
two-tone, the compress pass written back in v11.36 recognises it and stores it
as **CCITT G4**: a text page ends up a fraction of the size, with *sharper*
letters than a photograph of it gives. That is the same route the paid
scanners take, arrived at through machinery the app already had.

Photo ID mode keeps its own colour-true treatment and is deliberately untouched.

### Retake one page, and reorder
Both previously meant deleting and scanning the whole stack again.

- **Retake this page** reshoots into *that position*, not onto the end — which
  is the entire point; otherwise it is delete-and-rescan with extra steps. It
  works in every capture mode, opening the phone camera in HQ and resuming the
  preview otherwise, and a pending retake cannot leak into the next session.
- **Move earlier / Move later** reorders a page that went in out of turn.
  Buttons rather than a drag: a thumbnail strip on a phone is a poor drag
  target, and one tap per position is unambiguous. The sheet follows the page
  you moved rather than staying on the position.

scan-tests 120 → 132. All sixteen suites green.

## [v11.66] — 2026-07-28 — HQ: the empty screen now explains itself

The consequence of v11.65 that I flagged but did not solve. HQ takes each page
with the iPhone's own camera, so between shots there is nothing to put in the
preview area — and a full-screen black rectangle with a shutter under it reads
as a broken camera, not as a mode that works differently.

That space now carries a camera mark, "High quality", and a line saying to tap
there or the shutter to photograph the next page. **It is a button as well as a
sign**: tapping the empty area is the first thing anyone tries, so it opens the
camera rather than doing nothing.

It appears only where it belongs — HQ on, the scan screen up, no live stream,
and no page waiting on the Adjust screen — and every path that starts or stops
a camera now refreshes it, so it cannot be left showing over a working preview
or missing over a dead one.

scan-tests 115 → 120.

## [v11.65] — 2026-07-28 — HQ: one camera, from wherever you turn it on

The two-camera problem again, and the screenshots showed exactly why my v11.62
fix missed it. That fix only handled HQ being **already on when Scan was
tapped**. Turn it on from *inside* the scanner — which is the natural thing to
do, since the button is right there in the scan title bar — and the live
preview carried on running, so the shutter opened the iPhone's camera on top of
it. The first screenshot is the app's own preview with the green outline; the
second is iOS's camera over it.

- Turning **HQ on inside the scanner** now stops the live preview immediately
  (which also clears the green outline, so nothing is left frozen on a dead
  screen) and goes straight to the camera. Still one tap.
- Turning **HQ off** brings the preview back, rather than leaving a black
  rectangle where the camera used to be.
- **Asking for Auto turns HQ off**, the mirror of the existing rule that HQ
  turns Auto off. Hands-free capture needs a preview to watch; leaving Auto lit
  with nothing to fire from would be a toggle that silently does nothing.
- Neither swap is attempted while the Adjust screen is up, so a page waiting to
  be cropped is never disturbed.

The preview and the native camera are alternatives, never both — that is now
the rule, wherever the switch is thrown from. scan-tests 109 → 115.

## [v11.64] — 2026-07-28 — Blank pages, and files that name themselves

### Blank pages
Feeding a stack through by hand means scanning the backs of sheets. A page is
now judged blank as it is taken, and called out at once — catching it there
costs one tap, catching it after the PDF is built costs a reprint. At Create
PDF the count is offered as a single choice: leave them out, or keep every
page.

Blankness is judged against the page's **own paper**, not a fixed grey: the
paper level is read off the luminance histogram at the 85th percentile, so a
scan on cream stock, or one the whitening has not fully lifted, is not called
blank merely for being dark. The bar is deliberately conservative —

| page | ink measured | verdict |
|---|---|---|
| clean sheet | 0.00000 | blank |
| cream stock | 0.00000 | blank |
| one speck of dust | 0.00002 | blank |
| **one line of writing** | **0.01689** | **not blank** |
| full page of text | 0.2679 | not blank |

— because a page with a single handwritten line on it must never be thrown
away. The offer is also skipped when *every* page looks blank, since that is
far more likely to be a scanning fault than an empty stack.

### Files that name themselves
"Scan 28 Jul 2026 13.29.pdf" records when you scanned it and nothing about what
it is, which is what makes a folder of scans unsearchable. On Save, a document
whose name still says nothing is offered a name taken from its own first
heading — chosen the way a reader would: among the lines in the top third,
prefer the ones set largest, and among those the first that reads like a title
rather than a reference number or a date.

Run against the two real documents in the corpus, it produces
**"Tax Invoice_Bill of Supply_Cash Memo.pdf"** and **"Tax Invoice.pdf"**. The
name is editable before it is used, is offered once per document rather than on
every save, and a name you typed yourself is never second-guessed. A scan that
has not been recognised has no text to read, and is left alone.

scan-tests 99 → 109, mixed-tests 12 → 20. All sixteen suites green.

## [v11.63] — 2026-07-28 — Waiting for a good moment, and saying why

Capture resolution set the ceiling (v11.61–62). This is about not wasting it.
Three faults spoil a scan that geometry cannot see, and all three are now
measured on the preview frame the detector already holds — so it costs a
fraction of a frame and needs no second capture.

**Sharpness.** A hand at rest still drifts, and the difference between the
sharpest and blurriest frame of a "steady" hold is plainly visible in the
result. When the countdown finishes, the shutter now waits for a frame as good
as this scene has recently managed, up to 700ms, then takes what there is —
refusing forever would be worse than a soft scan. Sharpness is judged
*relative* to the scene, because a page of dense print scores several times
higher than a mostly-blank one and neither is wrong; the benchmark decays after
2.5s so moving from a dense page to a sparse one cannot leave an unreachable
bar behind.

**Glare.** More than 6% of the frame at full brightness is a window or a lamp
reflected off the paper, not paper itself. Auto capture refuses, because glare
does not merely look bad — it erases the letters underneath and nothing
downstream brings them back. This is what spoilt the envelope scans.

**Darkness.** A dim scan can be lifted; a black one cannot. Below a mean of 55
the shot is refused with a suggestion to add light or use the torch.

Each refusal names itself in plain language through the existing hint
mechanism, which already waits ~1.8s and speaks at most once every 6s, so this
cannot become a running commentary on every wobble.

Measured on frames built to contain each fault: a crisp frame scores **51.3
against 6.8** for the same page out of focus; a glared frame reads 22% blown
against a 6% bar. scan-tests 89 → 99. All sixteen suites green.

## [v11.62] — 2026-07-28 — HQ: one camera, and a third of the size

Both faults reported from a real HQ scan, and the supplied file measured:
page 1 (HQ) came out **2633×3598 at 308 dpi — 2.73 MB**; page 2 (normal)
1901×2669 at 228 dpi, 1.14 MB. The resolution claim held. The rest did not.

### Two camera screens for one photo
v11.61 opened the live preview and *then* handed over to the iPhone's camera
when the shutter was tapped, so scanning a page in HQ meant meeting two camera
screens. In HQ the preview no longer starts at all: the camera opens straight
from the Scan button, and after each page the shutter opens it again. One tap
per page, one camera.

### 2.73 MB for a single page
Two causes, both mine:

- **The HQ byte budget was 3.2 MB.** I set it in v11.61 to "match the extra
  detail" and it simply let a page balloon. It is now 1.1 MB — the encoder
  steps quality down only as far as the budget requires, so a sparse page is
  unaffected and a dense one stops running away.
- **A freshly built scan was never re-encoded.** The image pass skips an
  existing JPEG on principle: re-encoding someone else's work costs a
  generation of quality for nothing. But a scan's JPEG is *ours*, written at
  q92 — so for that one case the rule is now lifted, and the page is
  re-encoded at the same **size**. Resolution is not touched.

Measured on the supplied file, end to end: **3.87 MB → 1.70 MB, 56% smaller,
with 308 dpi and 228 dpi both preserved exactly.** On a generated 300 dpi A4
page the pass gives 1271 KB → 427 KB with the pixel dimensions identical.

Where the page is genuinely near black-and-white the pass stores it as CCITT
G4 instead, which is the same route the paid scanners take to small files —
that is the reachable half of Adobe's trick. The other half is MRC proper
(text as a bilevel layer over a low-resolution colour background), which is
not built and would be the next real step if size still matters.

compress-tests 76 → 83, scan-tests 89. All sixteen suites green.

## [v11.61] — 2026-07-28 — HQ: scanning at the resolution the phone can afford

The scanner's quality ceiling was never the processing — it was that a page is
captured as a frame lifted off the video preview. **HQ** hands the shutter to
the iPhone's own camera instead, so the page arrives as a full 12-megapixel
photo. Measured, for an A4 page filling 90% of the frame:

| capture path | phone held to match the page | held the other way |
|---|---|---|
| preview frame, 4K 16:9, cap 3200 (before) | 274 dpi | **166 dpi** |
| 12MP photo, cap 3200 | 274 dpi | 233 dpi |
| **12MP photo, cap 4600 (HQ)** | **310 dpi** | **233 dpi** |

Adobe Scan aims at 300. Two things were in the way, and both are fixed:

- **The 3200px cap threw most of the photo away the moment it arrived.** It
  existed to match the preview frame's ceiling, and cost 37 dpi on its own.
  In HQ it rises to 4600, with the JPEG budget raised to match — at 4600px the
  old 1.4 MB budget would simply have re-lost the detail as artefacts.
- **16:9 is a poor shape for a page.** That is where the 166 comes from: hold
  the phone the "wrong" way and the frame's short side bounds the page. A 4:3
  still is a much better fit, which is why HQ raises the *floor* by 40% —
  worth more in daily use than the peak.

**The cost is stated plainly in the app, because it is real:** the iPhone's
camera UI replaces ours, so there is no green outline and no hands-free
capture, and it is two more taps per page. Turning HQ on therefore turns Auto
off rather than leaving a toggle that silently does nothing. Auto remains the
right choice for working through a stack; HQ is for the page that matters.

**Every scan now reports the resolution it actually reached** ("Page 1 added at
286 dpi"), and says so when a page lands under 200 dpi, where small print
starts to break up. The argument for this feature is a number, so the number is
on screen rather than buried in a changelog.

scan-tests 80 → 89, including the arithmetic above. All sixteen suites green.

## [v11.60] — 2026-07-28 — Selecting text on a scan

"Nothing highlights, it selects the entire page and offers Copy — just like an
image." That description named the fault: the page *image* was winning the
touch, not the invisible word layer. Three things were wrong, one of them
measured on the supplied file.

- **48 of the 189 recognised lines on that scanned page had no usable box** —
  zero width, zero height or zero size, the stray marks any recogniser
  produces. Each became a zero-sized element sitting in the middle of the
  selection order, which is enough to break the run iOS walks when a selection
  is dragged. They are now skipped.
- **Select mode never marked the page as having text.** The rule that stops
  iOS treating a page as a picture is keyed on that mark, and only view mode
  set it — so on a recognised scan the image callout could still take the
  touch. Select mode now sets it, and only when the layer really has words.
- **The image is now inert in Select mode** and the word layer sits above it,
  so the touch can only land on the words.

And when there is genuinely nothing to select — a scan that has never been
recognised — the app now says so and offers to fix it, instead of leaving a
page that behaves like a photograph with no explanation.

**Not verified by me:** I cannot drive an iOS text selection here. The stray-box
defect is measured and certain; the two callout changes are reasoned from the
CSS and from the symptom you described. If a recognised scan still selects as
a picture, the next thing to check is whether the words highlight but the
copied text is empty, which would point somewhere different again.

## [v11.59] — 2026-07-28 — Four fixes from a real merged PDF

The user supplied the file, tested on an iPhone: born-digital invoice pages
mixed with scans, carrying page numbers this app had stamped on it four times
over. It is now `corpus/USER-merged.pdf` and drives a new suite.

### Editing removed a table's top border
Not the redaction — the **repaint**. The white patch covered the whole redacted
band, and the band reaches a hair above the glyphs, far enough to rub out the
cell rule running just over the text. On a type page the redaction has already
removed the glyphs as vectors, so the patch only needs to cover where they
were: it is now pulled in by 0.6pt and hairline rules survive. On a scan the
redaction blanks the image itself, so there the patch still covers exactly.

### "Recognise text" did nothing on a mixed document
Pages were judged by character count, and that is not enough. Measured on the
supplied file: page 2 is a near-blank sheet carrying **32 characters — nothing
but the page numbers this app stamped on it** — which cleared the old
20-character bar. Pages 3–5 are genuine scans that already carried an OCR
layer. Every page therefore fell into "skip" and the run reported *nothing to
recognise*.

Pages are now judged by what they **are**: a page-filling raster is a scan
(measured — a scan's image is 1.2–1.4× the page's own pixel count at 150 dpi,
a letterhead logo 0.07). Four outcomes, and each is acted on honestly: scans
without text are recognised, scans that already have text are offered a redo
rather than skipped in silence, type is left alone, and a blank page says so.

### Page numbers were stamped over the top of existing ones
Nothing ever checked. The app now reads the top and bottom margins for text
that reads as a number ("Page 2 of 5", "7", "3 / 12", "- 4 -") and, when it
finds any, offers to number **only the pages without one**, to number every
page anyway, or to cancel.

### Watermark wording
Any wording is accepted, up to two words. A watermark is set across the
diagonal at a single size, so a third word shrinks it past readability — the
limit now says that rather than silently mangling the result.

New suite: mixed-tests (12), all against the supplied file. All sixteen suites
green; corpus 53/53.

### Still open
**Selecting text to copy on a scanned page** is reported not working and is
NOT fixed here. The layer is built, the CSS enables it, and the pages carry no
rotation — three theories checked and eliminated, none of them the answer. It
needs a proper look rather than another guess.

## [v11.58] — 2026-07-28 — The green outline finds pale pages; sizing steadied

### The outline never appeared on a white page on a pale surface

Not a regression — a limit that had always been there and only showed up now.
`detectQuad` separates page from background by brightness, so it needs the desk
to be darker than the paper. Measured at the live preview's working size:

| scene | before | after |
|---|---|---|
| white page, dark desk | found | found |
| white page, mid-grey desk | found | found |
| white page, **light** desk | **missed** | found |
| white page, **white** desk | **missed** | found |
| page filling the frame | found | found |
| **blown-out** page, light desk | **missed** | found |

A white medical report on a pale table hits three of those rows at once, which
is why no green box ever appeared, in either document or Photo ID mode.

The fix leaves `detectQuad` untouched and adds a fallback used only when it
finds nothing: subtract a heavily blurred copy of the frame from itself. That
removes the overall lightness the page and the desk have in common and leaves
the step at the paper's edge, amplified ×8 — a gain chosen by sweeping gain
against blur radius over all six scenes, the lowest that finds every one.
Applied to both the live preview and the still frame.

### Retyped words on a scan were sometimes too big

v11.57 measured a word's height between its outermost ink pixels, so one stray
row — the descender of the line above, a table rule, a speck of scanner noise —
stretched the measurement and the replacement came out oversized. The height is
now taken from the row profile: start at the densest row (always part of the
word) and grow outwards, stopping at a genuinely blank row. Ascenders and
descenders join that band with no gap so they are kept in full; a speck beyond a
blank row is left out. A first attempt at this thresholded rows by density
instead and trimmed the sparse cap rows — 9.3pt for 11pt print — so it was
replaced rather than shipped.

### The harness caught a mistake mid-fix

Adding `detectQuadRobust` broke five harness tests — the ones that check the
green outline is actually drawn — because the test rig injects scan-core
functions by name and the new one was not in the list. A test-rig gap rather
than a product fault, but worth recording: **the outline is covered by tests,
and they did their job.**

editor-tests 85 → 87. All fifteen suites green.

## [v11.57] — 2026-07-28 — Editing a scan: right face, right size, right baseline

Reported from a real endoscopy report: a retyped word came out in the wrong
typeface *and* visibly larger than the print around it. Two separate causes,
both found by measurement.

### The face matcher was rasterising the whole page for one word
`spanInkMask` rendered the **entire page** at up to 8× to inspect a single
word — 3570×5052 pixels (tens of MB) to look at a patch of 77×45. On a phone
that fails or is killed for memory, and because the caller swallows the error
the only symptom was the typeface quietly reverting to plain Helvetica. So
v11.54's matcher, which tested perfectly in Node, was **largely dead on the
device**. It now renders only the word's own rectangle through a clipped draw
device: same picture, **530× less of it**.

### The OCR box is the wrong ruler for type size
The size came from the recogniser's bounding box, but that box depends on
which letters a word happens to contain — a word of capitals and a word with a
descender at the same point size give very different boxes. On the test
fixture the box implies **8.8pt for text printed at 11pt, a fifth out**.

The replacement is now fitted to the **ink that is actually printed**: the
word's ink height is measured off the page, the chosen face is measured at a
reference size, and the point size is scaled so the two match. The baseline is
placed from the ink's own bottom edge (allowing for the face's descender)
rather than from the OCR origin. Measured on a real JPEG'd scan of 11pt Times:

| | result |
|---|---|
| OCR box (old) | 8.79pt — 20% out |
| fitted to ink (new) | **11.29pt — 3% out** |
| face | serif, correctly matched through the JPEG |

Guards kept: a size the user types still wins over everything; the fit is
refused if it lands more than a third away from what the box implied; and on
any page that is not a scan the behaviour is byte-for-byte what it was.

editor-tests 78 → 85. All fifteen suites green.

## [v11.56] — 2026-07-28 — The box was never ours; reverting the wrong fix

The user supplied the actual file. Reproducing on it settles the question that
v11.55 guessed at:

**The box around the name is printed in the document.** It is the invoice's own
field border, present in the untouched original. Measured on the supplied file:

| | faint-grey border pixels |
|---|---|
| untouched original | 1683 |
| after a full edit | 1736 (anti-aliasing of the new text) |

Every pixel the edit changes lies inside the text band — bounding box
(75,87)–(386,126) of the crop — and none on the border. Rendering the page with
the redaction applied and *nothing else* still shows the border intact.
Sampling the background around that name returns **pure white with 0.88
agreement**, so the patch the app paints was white all along. At 300% zoom a
hairline cell border simply becomes visible.

**So v11.55's fix for this was wrong and is reverted.** Lowering the
"treat as white" floor from 245 to 232 fixed nothing and risked something real:
a genuinely light-grey shaded cell (say 235) would have been painted white,
creating exactly the visible patch the rule exists to prevent. The floor is
back at 245, and a test now pins that a 235-grey cell keeps its own shade.

The scan half of v11.55 **stays** — it was independently reported and is real:
on a scan the sampled ring is textured, fails the uniformity test, and used to
fall through to white, leaving a white rectangle on pink paper.

`corpus/USER-invoice-fieldbox.pdf` is the supplied file, now part of the
corpus, so this document is checked on every run.

## [v11.55] — 2026-07-28 — Six fixes from the first real-device use

Twelve releases shipped between v11.42 and v11.54 without once running on a
phone. The first session on real documents found six faults, two of them
regressions I introduced. Recorded plainly, because the pattern matters more
than the individual bugs: **every one of these was invisible to a green test
suite and obvious within minutes of real use.**

### 1. A grey box appeared around edited text
On a born-digital invoice the paper sampled at ~244, just under the old
"treat as white" floor of 245 — so the patch behind the edit was painted
244-grey on a 255-white page, drawing a visible rectangle around every edited
word. The floor is now 232, and a sampled colour is used only when it differs
from white enough to be a real colour (a panel, a coloured cell).

### 2. Straighten pages failed with "a file couldn't be loaded"
The orientation model runs on tesseract's **legacy** engine, which lives in
`tesseract-core-simd.wasm` — a file v11.53 never vendored, because only the
LSTM cores were copied. The browser asked for it and got a 404.
**My Node test passed for the wrong reason**: Node resolved the installed npm
package instead of `vendor/ocr`, so it never exercised the shipped bytes. The
core is now vendored (+7 MB; `vendor/ocr` is 28 MB).

### 3. Find highlighted into the next word on scanned pages
Searching "money" drew a box reaching into "RECEIPT". The invisible OCR word
was drawn at the font's *natural* width, which is wider than the ink it stands
for. Each word is now laid into exactly its own box with a horizontal scale
(`Tz`), and drawn in **render mode 3** — the way a searchable PDF is supposed
to be built, rather than an alpha of 0. Measured: a hit is now 32.8pt against
32.4pt of actual ink (1%), and the layer is still pixel-for-pixel invisible.
A second fault surfaced while fixing it: the run was being encoded UTF-16 for
a font that takes single bytes, which extracted as nonsense. Also fixed.

### 4. Editing a scan left a white patch
On a scan the ring sampled around a word is textured — creases, shadows, JPEG
noise — so it failed the "uniform" test and fell through to white, leaving a
white rectangle on pink paper. On a scan the median *is* the paper tone, so
the uniformity requirement is dropped there and the patch matches the page.

### 5 & 6. Scanning spoilt: over-exposed and boxed in white — REVERTED
Two v11.41 changes are reverted wholesale to the v11.40 behaviour:
- **The 4:3 camera request.** The arithmetic was right (a portrait page is
  bounded by the frame's short side, so 3024 beats 2160) and the result was
  wrong: on a real iPhone that constraint selects a capture mode whose
  auto-exposure burnt bright paper to white. Resolution is worth nothing if
  the paper is over-exposed. Back to the 16:9 4K request.
- **`MIN_LONG_PX` 2400 → 1600.** With the camera reverted, the higher floor
  only stopped auto capture firing on a normally-framed page.
- **Scanned pages default to "As captured" again.** A4 snapping put white bars
  down both sides of receipts and envelopes and made the page draw smaller.
  A4 remains one tap away and the choice persists.

Both reverts are now pinned by tests (SC68, SC69, SC69b, SC69c) so they cannot
be quietly re-applied. The lesson is recorded in `scan-core.js` rather than the
numbers defended: **these constants were tuned against a simulated frame and
never against a lens.**

Tests: textedit 59 → 65, ocr 30 → 34, scan 78 → 80. All fifteen suites green,
corpus 41/41 and 13/13 external.

## [v11.54] — 2026-07-28 — Editing a scan matches its typeface

v11.50 made scanned words editable but retyped every one in Helvetica, so a
change on a serif or typewriter document stood out — the one visible weakness
in that release, and it was disclosed rather than hidden.

Adobe closes this with proprietary font synthesis, which cannot be licensed or
rebuilt. What *can* be done honestly is to pick the closest face the app
already has, **by measurement rather than by guessing**: the scanned word's own
ink is compared against the same word rendered in each candidate (Helvetica,
Helvetica Bold, Times, Times Bold, Courier), and the best fit wins.

- The comparison crops to the ink and normalises by **height only**, keeping
  the aspect — Courier's wide advance is a real signal, and normalising width
  away would have thrown the monospace case out with the noise.
- **Declining is a feature.** A word under three characters, ink that fits
  nothing well (< 0.45), or a coin toss between two faces (< 0.02 apart) all
  return *no match* and keep the plain face. Guessing wrong is exactly the
  complaint this reduces.
- It runs only on an OCRed scan, and never overrides a typeface the user chose
  themselves. On a scan the span's own "font" is the invisible Helvetica laid
  down by v11.48, which says nothing about the printed word — so that is
  deliberately not reused.

Measured: **10 of 10** correct across all five faces on clean print, and serif
and monospace are still identified through a deliberately degraded low-quality
JPEG scan (0.77 and 0.81 agreement). editor-tests 65 → 78. All fifteen suites
green.

## [v11.53] — 2026-07-28 — Straighten sideways pages

**A promise from v11.33, finally kept.** That release deliberately did *not*
auto-rotate, and wrote down why: "a landscape certificate and a sideways
capture of a portrait sheet produce identical geometry; distinguishing them
needs to read text direction, which is an OCR job." The OCR arrived in v11.48,
so **More → Straighten pages** now does it — from the words, not the shape, so
a genuinely landscape page is left alone.

- Tesseract's orientation model (`osd`, 4 MB, vendored beside the recogniser
  and cached the same way) reads each page at ~150 dpi.
- The correction is applied as `/Rotate` — **recorded, not re-drawn** — so a
  scan loses not one pixel of quality, and Undo reverses it.
- The detected turn is *added* to the page's existing rotation, because the
  render the model saw already had that rotation applied.
- Pages whose text is too faint to judge (confidence < 2) are left alone and
  counted in the message rather than guessed at, and straightening nothing
  leaves no undo step behind.

Measured, not assumed: a real scan turned 90°, 180° and 270° is detected at
confidence 11–13 and **every one comes back upright**; the model's reported
value is exactly the `/Rotate` to apply. ocr-tests 22 → 30. All fourteen
suites green.

## [v11.52] — 2026-07-28 — Crop and resize pages

**More → Crop & resize**, on this page or all of them.

- **Trim the blank margins.** The margin is *found*, not guessed: the page is
  rendered and the ink located, with the white threshold taken relative to the
  page's own brightest tone (scanned paper is never pure white). A small
  breathing margin is kept so the trim never shaves the ink. Cropping sets the
  crop box, so nothing is deleted and Undo restores the full page.
  A crop that would remove almost nothing (>96.5% of the page kept) or almost
  everything (<2%) is refused, and a page with no margin to trim leaves **no
  undo step behind**.
- **Resize to A4 / Letter / Legal.** The content is scaled *uniformly* — never
  stretched — and centred, with the paper turning to match a landscape page.
  Pages already at the target size are skipped.

Rotation is handled by reusing v11.51's measured mapping rather than guessing
at it a second time: `cropBoxFromVisual` turns a visual rectangle into a PDF
crop box, and on a quarter-turned page the box's sides swap with it.

stamp-tests 17 → 28, including end-to-end proof that a cropped page really is
smaller *and* still holds its text (crop hides, it does not delete), and that
a resized page comes out true A4 with its content intact. All fourteen suites
green.

## [v11.51] — 2026-07-28 — Watermarks and page numbers

Two iLovePDF/Acrobat staples, both in **More**.

- **Watermark** — text across every page (DRAFT, CONFIDENTIAL, COPY…),
  diagonal or straight, three shades, six colours. Sized to each page's own
  diagonal rather than a fixed guess, and translucent by default so it never
  hides the text underneath.
- **Page numbers** — `1`, `1 of 12` or `Page 1 of 12`; left/centre/right, top
  or bottom; optionally skipping the first page so a cover stays clean (and
  numbering then starts at 2, matching what the reader expects).

**Both stamps land where the reader sees them, not where the page's own
coordinates put them.** A page carrying `/Rotate 90` — every sideways scan
this app makes — is displayed turned, so PDF bottom-left appears at the visual
*top*-left. The four-way mapping was **measured**, not assumed: a mark drawn
at PDF (5,5) was rendered through MuPDF at each rotation and located, giving
`visualToPdf`, and the text is counter-rotated so it reads upright.

New suite: stamp-tests (17). The geometry helpers are pure and sliced from the
shipped app.js; the decisive tests render a numbered *rotated* page and find
the ink — it sits at 50% across, 92% down, i.e. the reader's bottom edge.
All fourteen suites green.

## [v11.50] — 2026-07-28 — Scanned pages are editable

Acrobat's "make a scan editable". v11.48 gave scans a recognised text layer;
this makes that layer *editable*, so tapping a word on a photograph of a page
erases it from the image and lets you retype it.

**It was verified before it was built**, on the real engines: redact the word's
band on an OCRed scan and the printed pixels measure 47.6 ink → 0.0 (gone, not
covered); retype and the replacement is visible and extractable. The existing
edit path already did the right thing — the work was making it reachable and
honest.

- **Edit text on a scan** now explains itself instead of highlighting nothing:
  "This document is a picture… recognise text first and every word becomes
  editable", with a one-tap route into OCR. The typeface caveat is stated
  *before* the user commits, not after.
- **After OCR**, edit mode says what a tap will do: the word is erased from
  the scan and retyped.
- **OCRed documents are marked** in their own metadata (`PyPDF-OCR` in
  Keywords), which survives save and reopen. Two things depend on it: the
  renderer must keep the **fast JPEG path** for these pages — `usePng` is
  gated on `docHasText()`, which OCR flips to true, and PNG on a full-page
  scan is 3–5× larger and slower for no visible gain (the v10.94 finding) —
  and the edit messages need to know the text came from recognition.

**The honest limit, unchanged:** Adobe matches the scanned typeface with
proprietary font synthesis. This retypes in a standard face, so a changed word
may not match the print around it. Everything else on the page is untouched.

Tests: scenario-tests 34 → 39 — builds a page with printed ink plus an
invisible recognised layer (what OCR really leaves), then drives the app's own
`applyTextEdit` and measures the page: old word gone from the text, new word
real (not invisible), and the printed ink measurably replaced (83.1 → 19.7).
ocr-tests 15 → 22. All thirteen suites green.

## [v11.49] — 2026-07-28 — Clear recents keeps starred documents

A star means "keep this around", and one tap on Clear must not silently break
that promise.

- **Clear recents** now removes only unstarred entries (and their stored
  bytes). Starred documents stay, and the status says how many were kept.
- A **starred** document leaves the list exactly one way: long-press its card
  → **Remove from Recents** (which always worked and is unchanged), or unstar
  it first, after which Clear applies.
- Clearing when everything is starred does nothing and says why instead of
  pretending.

Tested behaviourally in the booted app (scenario-tests 30 → 34): star an
entry, click the real Clear button, starred survives with its bytes while the
rest are gone; a second Clear is a no-op; recentsRemove still takes the
starred one off.

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
