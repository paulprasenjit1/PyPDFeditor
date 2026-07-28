# Roadmap — matching Adobe Acrobat Pro DC and iLovePDF

Written 27 Jul 2026, against **v11.41**. Goal: cover the everyday paid features
of Acrobat Pro DC and iLovePDF well enough that the subscriptions are never
missed, in priority order: **edit PDFs, unlock, organise pages, compress**,
plus **fill & sign forms** and **OCR**.

---

## 1. Where the app already stands

The app is further along than it may feel after the v11.32–v11.40 session.
Editing existing text is genuinely Acrobat-grade in approach: it reuses the
document's own embedded fonts, respects block alignment, redacts only the
edited band, re-wraps whole paragraphs on request, and offers size, colour and
typeface control. Unlock opens password-protected files and saves them
decrypted. Page organisation covers reorder (drag or buttons), quarter-turn
rotation and deletion, plus Combine and scan-into-document. Compress is a real
per-image recompression engine with a from-scratch CCITT G4 encoder, not a
blunt rasteriser. The scanner does hands-free capture, real paper sizes, and
two-sided ID cards. All of it runs on-device, offline, with no account.

The honest weaknesses, from the v11.41 review: almost nothing has been
verified on real documents or a real iPhone; the compressor's output has never
been opened in Acrobat or Preview; and the test fixtures are largely invented.
Correctness against the real world — Acrobat's actual strength — is the gap,
more than missing features.

## 2. Gap analysis for the four priorities

| Capability | Acrobat / iLovePDF | This app (v11.41) | Gap |
|---|---|---|---|
| Edit existing text | Yes | Yes (line + paragraph, own fonts) | Harden on real producers |
| Add NEW text anywhere | Yes | No | Build |
| Insert / move / delete images | Yes | No (sign-image only) | Build |
| Whiteout / erase area | Yes | Only via editing text | Build |
| Edit scanned pages | Via OCR | No | Needs OCR |
| Unlock (open password) | Yes | Yes | Verify breadth |
| Unlock (permissions/owner) | Yes | No | Build |
| Reorder / rotate / delete pages | Yes | Yes | — |
| Split / extract pages to new PDF | Yes | No | Build |
| Insert blank / duplicate page | Yes | No | Build |
| Combine | Yes | Yes | — |
| Compress, text-safe | Yes | Yes (v11.36) | Verify on real files |
| Compress to target size | iLovePDF | No | Build |
| Fill AcroForm fields | Yes | No (draw-on-top only) | Build |
| Sign | Yes | Yes (drawn + photo) | — |
| OCR searchable scans | Yes | No (Live Text on screen only) | Build |

## 3. The plan, phase by phase

Each phase is one or two releases, shipped alone, used on the phone with real
documents before the next begins. That discipline comes straight from the
handover: both regressions of the last session came from shipping nine
releases against invented fixtures.

### Phase 0 — Ground truth (before any new feature)

Build a private corpus from your real files: a few invoices, a bank statement,
a government form, a long scan, something from Word, something from Acrobat
itself. Add a testing page in the app (hidden behind About) that runs open →
edit → save → reopen across the corpus. Then verify the two things shipped
blind: run Compress on real files and open the results in Acrobat or Preview
(especially the CCITT G4 output), and retest text edit on the invoice that
broke v11.37. Nothing else proceeds until this passes, because every later
phase leans on it.

### Phase 1 — Editing to Acrobat level (most important)

First release: **new text boxes** — tap empty space in edit mode, type,
choose size/colour/face (the v11.37 controls already exist), drag to
position. Second release: **images** — insert from Photos, move/resize/delete
existing page images (MuPDF exposes them), plus a **whiteout** tool (draw a
rectangle that erases, using the existing redaction plumbing). Third:
hardening — run the corpus, fix the producer-specific edit failures that
surface. That closes the everyday editing gap; what remains beyond Acrobat
parity (editing vector artwork, prepress) is not worth chasing on a phone.

### Phase 2 — Organise pages, completed

One release: **split and extract** (pick pages → new PDF via the same
graftPage path Combine uses), **insert blank page**, **duplicate page**, and
extract-range from the existing pages grid. The grid UI already exists, so
this is mostly wiring; the risk is low and the iLovePDF parity gain is large.

### Phase 3 — Unlock, completed

One release: **permissions-only unlock** — files that open fine but forbid
editing/printing (owner password only). MuPDF can rewrite these without the
password; Acrobat charges for this daily-life feature. Also clearer messages
distinguishing "needs the password" from "restrictions removed".

### Phase 4 — Compress to iLovePDF level

After Phase 0 has proven correctness: a **target-size mode** ("get under
2 MB" — binary-search the existing quality levels), a **before/after report**
(pictures reduced, text kept), and font subsetting via MuPDF's clean options.

**Done, and extended in v11.68 with MRC** (mixed raster content) — the
technique the paid scanners actually use for small files. A scanned page is
stored as two layers: a 1-bit 300 dpi CCITT G4 stencil of the text, over a
100 dpi colour background carrying the photographs and paper. Measured on the
corpus: `USER-hq-scan.pdf` 3,965 KB → 261 KB (93% smaller),
`SEED-scan-200dpi.pdf` 881 KB → 167 KB (81%).

It is a candidate rather than a rule — `shrinkScanPdf` weighs it against the
ordinary image pass and keeps whichever is smaller — and it refuses three
cases outright, each of which would fail *silently*: any page carrying real
text (rasterising it would break search, copy and the editor), pages that are
mostly photograph (smaller **and worse**, which no size check detects), and
pages over 14 MP (memory).

Still open here: MRC is currently wired into the scan-creation path only.
Offering it in **Compress** for an already-scanned file would need the text
layer from a previous OCR run to be carried across rather than discarded.

### Phase 5 — Fill & sign forms

Two releases. First: read AcroForm fields via the vendored `PDFWidget` API
(already shipped in the engine, unused), render tap-to-fill text fields,
checkboxes and radio groups, save field values properly so other apps see
them. Second: dropdowns, date helper, an optional **flatten** on export, and
signature placement snapping into signature fields. This is the feature that
most often sends people back to Acrobat; the engine support already being
present makes it cheaper than it looks.

### Phase 6 — OCR

**A plain statement first: Adobe's OCR engine is proprietary.** It cannot be
licensed into this app, and "building the same engine" is a multi-year
research project — no open replica exists. What every serious non-Adobe tool
uses instead is **Tesseract 5 (LSTM)** compiled to WASM: on-device, offline,
free, cached once like the PDF engine (~15 MB with English).

The realistic quality story: on a clean printed page captured at the ~250 dpi
the v11.41 camera work now reaches, Tesseract's accuracy is close to
Acrobat's. Acrobat's edge is on poor input — and this app controls its own
capture pipeline, which is the better place to win: the deskew, illumination
flattening and binarisation already built for the scanner are exactly the
preprocessing OCR wants. Ship it as: OCR button on scanned docs → invisible
text layer under the image (searchable, selectable, copyable — Acrobat's
"searchable PDF") → auto-rotate pages using detected text direction (which
also fixes the v11.33 rotation ambiguity properly). English first, other
languages as downloadable packs.

### Ongoing rules (from the handover, kept deliberately)

One release at a time, used on the phone before the next. Real documents
before fixtures. A dated last-known-good snapshot per baseline, never
overwritten. Features decline rather than act when unsure, and destructive
modes are opt-in.

## 4. What will never match, said honestly

A PWA cannot do Acrobat's cloud sync, certified signatures with identity
verification, prepress/preflight, or batch automation across hundreds of
files. iOS Safari's memory ceiling means 500+ page scanned books will always
need the lazy-render care the app already takes. None of these touch the four
priorities, but knowing where the line is stops the roadmap chasing it.

## 5. Suggested order and size

Phase 0 first and alone (one session). Then 1 → 2 → 3 → 4 → 5 → 6: roughly
ten releases across six phases, each independently shippable and each leaving
the app strictly better than the last. Phases 2 and 3 are small and could
follow quickly after Phase 1; OCR is deliberately last because capture
quality (already improved in v11.41) determines its results more than the
engine does.
