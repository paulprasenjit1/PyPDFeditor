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
