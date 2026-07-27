# Test corpus — real documents the app must never break

Every file in this folder is run through the full pipeline by
`npm run corpus` (open → render → text extraction → edit round-trip →
save → reopen → compress → independent re-parse). A release is not shippable
while any corpus file fails.

## What to put here

Drop in YOUR real files — that is the whole point. The four `SEED-*` files are
synthetic stand-ins from three different PDF producers (reportlab, PIL/JPEG,
pdf-lib) so the harness has something to chew on from day one, but they proved
nothing about the real world. Aim for:

- two or three real invoices/bills (the kind that broke v11.37)
- a bank or card statement
- a government/official form, ideally one with fillable fields
- a long scanned document (10+ pages)
- something exported from Word, and something made by Acrobat itself
- a password-protected PDF you know the password to (name it `locked-*.pdf`;
  the harness skips content checks it cannot do and just verifies detection)

## Privacy

These files never leave this folder. They are excluded from git
(`corpus/` is in `.gitignore`) and are read only by the local test harness.
`corpus/_out/` holds compressed/edited outputs for manual inspection in
Acrobat or Preview — open a few on your Mac/phone occasionally; that check is
the one no script can replace.
