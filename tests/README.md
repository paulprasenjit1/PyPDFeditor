# Integration tests

`harness.mjs` executes the real app (real MuPDF WASM + pdf-lib, faked
canvas/camera/Worker/IndexedDB) and click-drives every feature: open, render,
scan (capture, crop, filters, thumbnails, cancel/discard, create PDF),
organise + rotation, undo, text edit, merge, compress, save, close, and
session persistence. 31 checks.

`guard-tests.mjs` covers the build-mismatch guard (self-heal on first
occurrence, explicit server-side diagnosis on repeat) and the hung-worker
watchdog. 4 checks.

Run:
    npm install jsdom
    node tests/harness.mjs [path-to-app]

Keep `tests/` and `backups/` out of the web deployment.
