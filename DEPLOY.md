# Deploying to GitHub Pages — checklist

The #1 failure mode is a **partial deploy**: an old `index.html` served next to
a new `app.js`. The app detects this ("build mismatch") — but the cure is
always server-side: get ALL files of one build live together.

## Files that must ship together (one build)

- index.html        (its `data-build="<BUILD>"` must equal `APP_BUILD` in app.js
                      and the version in `APP_CACHE` in sw.js — e.g. all `10.26`.
                      `tests/version-tests.mjs` enforces that they match.)
- styles.css
- app.js
- scan-core.js      (shared scanner math; imported by app.js AND scan-worker.js)
- scan-worker.js    (module worker — imports scan-core.js)
- sw.js
- manifest.webmanifest
- icon-180.png, icon-192.png, icon-512.png
- vendor/  (only when the engine changes — rarely)

`backups/` and `node_modules/` should NOT be published — the app never fetches
anything from them, and both are git-ignored. `tests/` IS tracked and published
(v11.35): `npm test` depends on it, it is 250 KB of text, and nothing loads it
at runtime, so it costs nothing to leave in place.

## GitHub Pages notes

- **`.nojekyll` must stay in the repo root.** Without it, Pages runs the site
  through Jekyll, which silently drops any file or folder whose name starts with
  an underscore and can rewrite others. Nothing in the app needs Jekyll.
- **Every path in the app is relative** (`./app.js`, `./vendor/…`, `./sw.js`, and
  `"start_url": "."` / `"scope": "."` in the manifest), so the app works
  unchanged at a user page (`user.github.io`) or a project page
  (`user.github.io/repo/`). Do not "tidy" any of these into absolute `/…` paths:
  on a project page that would resolve to the wrong origin root and the service
  worker would fail to register.
- **Pages is case-sensitive** where macOS is not. A reference typed as
  `Icon-192.png` works locally and 404s once deployed.
- The 10 MB `vendor/mupdf/mupdf-wasm.wasm` is well inside Pages' 100 MB
  per-file and 1 GB per-repo limits. It is fetched on first launch and then
  lives in `VENDOR_CACHE`, so it is downloaded once per vendor-version, not once
  per release.
- Pages serves `.wasm` as `application/wasm` and `.webmanifest` correctly; no
  custom headers are needed. The app requires no COOP/COEP headers (which Pages
  cannot set), because the engine does not use `SharedArrayBuffer`.

## Deploy steps

1. `git status` — confirm index.html, app.js, styles.css, scan-worker.js,
   sw.js all show as modified/added. **If index.html isn't in the commit,
   the deploy will brick.**
2. Commit and push to the branch GitHub Pages serves
   (Settings → Pages → check whether it's `main` root, `main /docs`, or `gh-pages`).
3. Wait for the "pages build and deployment" workflow (repo → Actions tab)
   to finish — usually under a minute.
4. Verify what the CDN is actually serving (private/incognito window):
       https://<your-site>/index.html?check=1
   View source — the `<html>` tag's `data-build` must equal the build you just
   shipped (the current `APP_BUILD` in app.js), e.g. `data-build="10.25"`.
   The `?check=1` bypasses the CDN cache for this check. If it still shows an
   old version after ~10 minutes, the push went to the wrong branch/folder.
5. Also verify the worker file exists (a missing one degrades scan speed and
   used to leak a "Script error." banner):
       https://<your-site>/scan-worker.js
   must show JavaScript code, NOT a GitHub 404 page.

## Then, on the iPhone (one-time clean-up)

1. Delete the installed app from the Home Screen.
2. Settings → Safari → Advanced → Website Data → search the site → delete.
3. Open the site in Safari, wait until it says "Ready", add to Home Screen.
4. More → About should show the build you just shipped (the current
   `APP_VERSION`, which tracks `APP_BUILD` — e.g. **10.25**).

From v9.2 onward this manual clean-up is never needed again: updates install
atomically, a mismatch self-heals with one automatic reload, and if the server
itself is stale the app says so explicitly instead of freezing.

## Recommended security headers (v10.99)

The page's own CSP lives in a `<meta>` tag in index.html, but two protections
can only be set as real HTTP RESPONSE HEADERS by the web server / CDN:

    Content-Security-Policy: frame-ancestors 'none'
    X-Content-Type-Options: nosniff

`frame-ancestors 'none'` stops any other site embedding the app in an iframe
(clickjacking); `nosniff` stops MIME-type guessing. GitHub Pages cannot set
custom headers — these apply if the app is ever hosted on Netlify, Cloudflare
Pages, nginx, etc. (e.g. a `_headers` file on Netlify/CF Pages). Optional
extra: `Cross-Origin-Opener-Policy: same-origin`. None of these affect the
app's behaviour; they only harden the hosting.
