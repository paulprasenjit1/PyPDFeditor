# PyPDF Editor PWA — Full Production Review (build 10.94 / 10.94.1)

Reviewed: 6 Jul 2026. Reviewer role: App Store reviewer + iOS QA + staff engineer + UX + security + release management perspective.
Scope: index.html, app.js (3,527 lines), scan-core.js, scan-worker.js, sw.js, engine-watchdog.js, styles.css, manifest, tests, CHANGELOG.md (v8 → v10.94.1 read in full to avoid re-recommending completed work).
Baseline verification: `npm test` run on this exact tree — **170 checks across 6 files, all passing**. No code was changed for this report.

---

## 1. Executive summary

This is an unusually mature codebase for a solo PWA. The last thirty releases show repeated audit rounds, and it shows: strict CSP with structural XSS-safe templating, memory budgets tuned for WKWebView, offline-first service worker with a build-mismatch self-heal, session restore, a scan pipeline with a worker fallback chain, and a real regression suite that exercises the actual app against real MuPDF WASM. Most findings from a typical production audit are already fixed and documented in the changelog.

What remains falls into four themes. First, the camera permission question you asked about is confirmed to be an iOS platform limitation for the cross-launch prompt (details in §16), but there is one genuinely fixable in-session case: switching away from the app mid-scan releases the stream, so returning triggers a fresh prompt. Second, modal accessibility is the weakest area — the bottom sheet and the two full-screen scanner views are not focus-trapped and the background is not made inert, so VoiceOver and keyboard users can escape into hidden content. Third, a handful of resilience gaps: a page that fails to rasterise stays blank forever with no retry, and the on-screen keyboard can cover bottom-sheet inputs on small iPhones. Fourth, strategic: MuPDF.js is AGPL-3.0, which is fine for a self-hosted PWA but is a blocker the day this is wrapped for the App Store (§6).

There are no critical defects. The app is production-quality today for its current distribution model (installable PWA). The plan in §15 sequences the remaining work.

---

## 2. Critical issues

None found. No crash paths, data-loss paths, or security holes were identified that are reachable in normal or adversarial use. The historical crashers (WKWebView memory kills on large docs, stale-build frozen buttons, password-sheet hangs) are all already fixed per CHANGELOG v10.90, v10.25, and the build guard.

---

## 3. High priority issues

**H1 — Mid-scan camera re-prompt after app switch.** `visibilitychange` (app.js ~3437) calls `stopCamera()` when the app is hidden, ending the tracks. On return, `startCamera()` issues a fresh `getUserMedia`, and in a standalone iOS PWA that re-shows the permission prompt. A user who switches to Messages mid-scan and comes back is prompted again, and it feels like a bug. Root cause: full track stop where a pause would do. iOS auto-mutes camera tracks while a page is hidden anyway, so the current code buys little battery and costs a prompt. Recommended: on hide, stop the detect loop and keep the stream; release the stream only after a grace window (about 60 seconds hidden) or on `pagehide`. `resumeCamera()` already handles both outcomes (live track resumes, ended track falls back to `startCamera`), so the change is contained to the visibility handler plus one timer. Impact: removes the most common surprise prompt. Effort: small (roughly 15 lines). Risk: low; worst case iOS ends the track anyway and behaviour equals today's.

**H2 — Sheets and scanner screens are not true modals for assistive tech.** The bottom sheet sets `role=dialog` and `aria-modal`, moves focus in, and restores focus on close — good. But nothing traps Tab/VoiceOver inside it, and the toolbar/viewer behind stay in the accessibility tree. The full-screen scanner views (`#scanCam`, `#scanCrop`) have no dialog semantics at all, so a VoiceOver user can swipe onto the hidden toolbar under the camera. Recommended: a small focus-trap on the sheet (wrap Tab at the edges) and `inert` on `header`, `.toolbar`, `.viewer` while a sheet or scanner screen is shown (`inert` is supported on the iOS 16.4+ baseline this app already assumes). Impact: WCAG 2.1 conformance; App Store accessibility review parity. Effort: small-medium. Risk: low.

**H3 — On-screen keyboard can cover bottom-sheet inputs.** Save/rename, password entry, and go-to-page are inputs inside a bottom-anchored sheet. On small iPhones the iOS keyboard can cover the input and the action buttons; the app never listens to `visualViewport`. Recommended: on `visualViewport.resize`, add bottom padding (or translate the sheet up) equal to the keyboard overlap while a sheet input is focused. Impact: prevents a blocked core flow (saving) on SE-class devices. Effort: small. Risk: low. Needs on-device confirmation first — flagging as high because Save is on the path.

---

## 4. Medium priority issues

**M1 — A failed page render is permanently blank.** `renderStage` catches all errors and leaves the placeholder with `data-rendered` unset — but the IntersectionObserver only fires again on re-intersection, so a transient failure (memory pressure during a big allocation) leaves a white page until the user zooms. Recommended: on failure, clear the rendered flag and schedule one retry; after repeated failure show a tappable "couldn't show this page — tap to retry" label. Effort: small.

**M2 — Page pill is `role=button` but not keyboard-focusable.** `#pagePill` has a role and label but no `tabindex` or key handler, so external-keyboard and switch users can't open go-to-page from it (it is reachable via More → Go to page, so this is a parity gap, not a dead end). Effort: trivial.

**M3 — Recents can hold ~125 MB of IndexedDB.** Five entries × 25 MB cap, plus session doc, plus per-page scan blobs. On a storage-constrained phone this makes the quota warning fire sooner and invites iOS eviction. Recommended: a total-bytes budget for recents (for example 60 MB, evicting oldest), not just an entry count. Effort: small.

**M4 — Raw engine errors reach the status bar.** `reportError` (window.onerror / unhandledrejection path) prints the raw message; the `friendly()` translator is only used on action paths. A WASM abort mid-session shows the user an internal string. Recommended: route the visible half of `reportError` through `friendly()`, keep the raw text in the on-device log. Effort: trivial.

**M5 — Fallback-camera scans are softer than live-camera scans.** `loadPhotoToCrop` downscales to 2600 px before the crop screen, while the live path warps from the full 4K frame with `maxDim` 3200. Users on the native-camera fallback (permission denied, older devices) get measurably softer output. Recommended: raise the fallback cap to 3200 to match `SCAN_Q.std.maxDim`. Effort: trivial. Memory note: a 3200 px RGBA frame is ~40 MB transient, same order as the live path.

**M6 — Photos → PDF EXIF orientation needs a verification pass.** Modern iOS Safari applies EXIF orientation when drawing to canvas, so portrait photos should come out upright, but the HEIC→JPEG conversion path on "large photo" downscale has not been explicitly tested here. One manual test with a portrait HEIC photo would close this. Effort: test-only unless it fails.

**M7 — No guard on absurdly large file opens.** A 400 MB PDF goes straight to `arrayBuffer()` and the WASM heap; the failure surfaces as the friendly "too large" message only after a long stall (and possibly a WKWebView kill). Recommended: check `file.size` up front and warn/confirm above ~150 MB. Effort: trivial.

---

## 5. Low priority issues

**L1 — app.js is a 3,527-line monolith.** Everything works and the section comments are excellent, but viewer, scanner, persistence, find, and UI plumbing belong in separate modules. See §13.
**L2 — No linter or type layer.** Plain untyped JS with no ESLint config. The test suite compensates at runtime, but a linter plus `// @ts-check` with JSDoc would catch a class of typos before tests. Effort: medium (one-time noise cleanup).
**L3 — Stale zoom hint.** `zoomTip()` says the − / + buttons are hidden on phones; since the floating zoom pill was introduced they are visible. Wording-only.
**L4 — Error log keeps only 3 entries.** For a support-by-screenshot workflow, 10 entries costs nothing and diagnoses more.
**L5 — Manifest could add `screenshots` and `shortcuts`.** Ignored by iOS, but improves the Android/desktop install surface for free.
**L6 — Repo hygiene.** `.DS_Store` files present; `backups/` and `tests/` are correctly excluded from deploy per DEPLOY.md, but `.DS_Store` should join .gitignore.
**L7 — Dynamic Type / large-text is not honoured.** All type is fixed px. iOS Safari's text-size adjust interacts poorly with app-like layouts, so this is a deliberate trade-off common to PWAs — noting it for the record with VoiceOver already well covered.
**L8 — English-only.** No i18n layer; all strings are inline. Fine for now; a future extraction is easier post-L1.

---

## 6. App Store rejection risks (if this is ever wrapped as a native app)

Today this is a PWA and none of this applies to Safari/home-screen distribution. If you later wrap it (Capacitor/WKWebView shell) for the App Store:

1. **MuPDF.js is AGPL-3.0.** Shipping it inside an App Store binary effectively requires either full source disclosure under AGPL terms (practically incompatible with App Store distribution) or a commercial licence from Artifex. This is the single biggest strategic blocker and worth deciding early. The About dialog's licence disclosure is correct for the web today.
2. **Guideline 4.2 (minimum functionality).** Pure web wrappers get rejected; you would need some native integration (Files provider, share extension, print).
3. **Privacy manifest + `NSCameraUsageDescription`** and App Privacy "data not collected" declarations (easy — the app collects nothing, no analytics, no network egress; this is a genuine strength).
4. **A privacy policy URL is required** at submission even for no-collection apps; the app currently has none anywhere (worth adding a line to About regardless).

---

## 7. UX improvements (ranked)

1. Camera-permission expectation setting: the first time a scan session starts on iOS standalone, show a one-time hint — "iOS asks for camera access each time you open the app; this is an Apple limitation, not a fault." Turns a perceived bug into an understood quirk (§16).
2. H3 keyboard avoidance (above) — the save sheet is the flow users hit most.
3. Scanner: an optional auto-capture when the quad has been LOCKED for ~1.5 s would remove the two-hand juggle; the lock state (v10.94) already provides the signal. Keep it opt-in — manual-first was a deliberate v10.36 decision.
4. Offer "Use native camera instead" inside the scanner (not only as an automatic fallback) for users who prefer no live prompt; it also sidesteps the permission prompt entirely since `<input capture>` uses the OS camera.
5. Empty-recents welcome is good; consider showing the three big buttons plus a single line about privacy — already done. No change.
6. After Create PDF, the status suggests Save; consider auto-opening the Save sheet since that is the only sensible next action.

## 8. Performance improvements

The heavy lifting is already right (lazy raster window, released offscreen bitmaps, worker warp, JPEG-vs-PNG heuristic, epoch caches, 300→600 ms detect backoff). Remaining candidates, none urgent: replace the `setInterval` live-detect with `requestVideoFrameCallback` where available (aligns detection to real frames, skips duplicates, slightly better battery); move scan JPEG encode fully off-thread with `OffscreenCanvas` on the worker (removes a 4K `getImageData` on the main thread per page); `pageThumb`'s base64 conversion could use `FileReader` on the JPEG blob to avoid the `String.fromCharCode` loop. Bundle size is fine: app shell ~100 KB, the 10 MB WASM is downloaded once with real progress UI and cached separately from app releases — that design is exactly right.

## 9. Security improvements

Current posture is excellent: `default-src 'none'` CSP, no third-party code, no network egress, structural HTML escaping (`h` template), filename sanitisation both for downloads and for the persisted error log, decrypted PDFs never persisted. Remaining: (a) `frame-ancestors` cannot be set via meta CSP — add `Content-Security-Policy: frame-ancestors 'none'` (or `X-Frame-Options: DENY`) plus `X-Content-Type-Options: nosniff` at the web server; document in DEPLOY.md. (b) Consider `Cross-Origin-Opener-Policy: same-origin` at the server for isolation hygiene. (c) The About link to GitHub is the app's only external navigation; it already carries `rel="noopener noreferrer"`. Nothing further.

## 10. Accessibility improvements

H2 (focus trap + inert) and M2 (page pill) above are the substance. Smaller: the scanner shutter, Cancel and Create PDF buttons are fine, but the live "N page(s) scanned" counter should be `aria-live=polite` so VoiceOver hears pages being added; the crop-corner keyboard nudging (already implemented) is genuinely better than most commercial scanner apps. Reduced-motion is handled throughout styles.css. Contrast on `--line` hairlines is decorative-only, fine.

## 11. Code quality improvements

Add ESLint (flat config, `eslint:recommended`) and run it in `npm test`; adopt `// @ts-check` + JSDoc on scan-core.js first (it is pure functions and will type cleanly); delete the vestigial `cropFilter` constant and confirm `toPng()` is still referenced (it appears unused); align the two stale comments (zoom hint, index.html zoomctl note). The changelog discipline and comment quality are already exemplary — keep exactly that style.

## 12. Suggested refactoring

Split app.js along its existing section comments into ES modules: `state.js` (workingBytes/MDOC/epoch/dirty), `persist.js` (idb + recents + views), `viewer.js` (render/observe/zoom/pill), `find.js`, `editor.js` (spans/text-edit/sign), `scanner.js` (camera/crop/pipeline), `sheets.js` (h template, sheet plumbing), `app.js` (wiring only). Constraint: the harness drives the app by element IDs and the build guard checks IDs, so a pure module split is test-safe if IDs and load order are preserved. Do this after the functional fixes, not before — it churns every line and should land in a quiet release by itself.

## 13. Future roadmap

Near term: OCR via Tesseract-WASM as an optional download (same progress-bar pattern as the engine) to make scans searchable — the single biggest feature gap versus Adobe Scan/Microsoft Lens. Mid term: highlight/freehand annotation (pdf-lib can draw; the overlay plumbing from Sign mode generalises), page insert (blank/from camera), and a Print action via a hidden iframe + `window.print()`. Long term: the App Store decision (§6) — if yes, budget for the Artifex commercial licence conversation first, code second.

## 14. Risk assessment

Regression risk is the dominant risk in this codebase because so much is tuned (scanner priors, memory budgets, iOS quirks encoded in comments). Mitigations already in place: restore-point zips per release, 170-check suite, build-consistency tests. Rules for the work below: one theme per release, version bump + restore point every time, run `npm test` before and after, and never touch scan-core.js maths in the same release as UI work. The riskiest single proposed change is H1 (camera lifecycle) — it interacts with iOS backgrounding — so it ships alone with a manual on-device test script (scan → home → return within 10 s; scan → home → wait 2 min → return; scan → lock screen → return).

## 15. Step-by-step implementation plan (awaiting approval)

Each step = one release, restore point first, tests after, CHANGELOG entry.

1. **v10.95 — Camera lifecycle (H1) + permission explainer (§7.1).** Files: app.js only. Keep stream on hide with 60 s grace; one-time standalone-iOS hint. Manual device tests as in §14.
2. **v10.96 — Modal accessibility (H2, M2, §10).** Files: app.js, index.html, styles.css. Focus trap, `inert` background, scanner dialog semantics, page-pill tabindex, aria-live scan counter.
3. **v10.97 — Keyboard avoidance (H3).** Files: app.js, styles.css. visualViewport-driven sheet lift. Device test on an SE-size viewport.
4. **v10.98 — Resilience batch (M1, M4, M5, M7, L3, L4).** Files: app.js. Small, independent, individually testable.
5. **v10.99 — Storage budget (M3) + manifest polish (L5) + server-header docs (§9, DEPLOY.md).**
6. **v11.0 — Module split (§12) + ESLint (L2).** No behaviour change; suite must stay 170/170.
7. Separately, an EXIF verification test (M6) can ride along with step 4.

Steps 1–4 are each roughly an hour of change plus device verification; steps 5–6 are larger. I will not start any of them without your explicit approval, and each begins by creating `backups/pypdf-pwa-vX.XX-restore-point.zip` following your existing convention.

---

## 16. Camera permission investigation (requested deep-dive)

**Observed behaviour:** the installed PWA asks for camera permission every time it is closed and reopened.

**Root cause — platform, not app code.** In iOS home-screen (standalone) web apps, WebKit does not persist `getUserMedia` permission grants across app launches. Each cold launch is a new browsing session and the first `getUserMedia` call re-prompts. This is long-standing, tracked WebKit behaviour (bugs 215884 and 185448) and is confirmed still current by vendor documentation as of 2025–26. There is no web API to request a permanent grant on iOS (Android Chrome persists grants; iOS does not). Settings app exposes no per-PWA camera toggle that changes this.

**What the app already does right (verified in code, CHANGELOG v10.52):** one prompt per scan session, not per page — the stream is kept alive across capture → crop → next page via `pauseCamera()`/`resumeCamera()`, and released only when the scanner closes. The Permissions API cannot help further here: `navigator.permissions.query({name:"camera"})` reports state but cannot suppress the standalone re-prompt. Requesting the camera at boot would be worse UX (prompt before intent) and is correctly not done.

**The one fixable case (H1):** hiding the app mid-scan currently stops the tracks, so returning re-prompts within the same launch. Keeping the muted stream across brief hides eliminates that prompt legitimately — no security-model workaround involved, since the grant for that session already exists.

**Best-possible UX under the constraint:** the one-time explainer (§7.1), the H1 fix, and the optional native-camera path (§7.4, which never shows a web permission prompt because the OS camera app handles capture). Anything beyond that — hidden persistent streams across launches, prompt pre-triggering — would violate the browser security model and is not proposed.

Sources: [WebKit bug 215884](https://bugs.webkit.org/show_bug.cgi?id=215884), [WebKit bug 185448](https://bugs.webkit.org/show_bug.cgi?id=185448), [STRICH KB: Camera access issues in iOS PWAs](https://kb.strich.io/article/29-camera-access-issues-in-ios-pwa), [Scandit FAQ: Why does iOS keep asking for camera permissions](https://support.scandit.com/hc/en-us/articles/360008443011-Why-does-iOS-keep-asking-for-camera-permissions).
