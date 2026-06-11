# Deploying to GitHub Pages — checklist

The #1 failure mode is a **partial deploy**: an old `index.html` served next to
a new `app.js`. The app detects this ("build mismatch") — but the cure is
always server-side: get ALL files of one build live together.

## Files that must ship together (one build)

- index.html        (must contain `data-build="9.2"` on the `<html>` tag)
- styles.css
- app.js
- scan-worker.js
- sw.js
- manifest.webmanifest
- icon-180.png, icon-192.png, icon-512.png
- vendor/  (only when the engine changes — rarely)

`backups/` and `tests/` should NOT be published (see .gitignore).

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
   View source — the first line must be:  `<html lang="en" data-build="9.2">`
   The `?check=1` bypasses the CDN cache for this check. If it still shows an
   old version after ~10 minutes, the push went to the wrong branch/folder.

## Then, on the iPhone (one-time clean-up)

1. Delete the installed app from the Home Screen.
2. Settings → Safari → Advanced → Website Data → search the site → delete.
3. Open the site in Safari, wait for "Engine ready", add to Home Screen.
4. More → About should show **version 9.2**.

From v9.2 onward this manual clean-up is never needed again: updates install
atomically, a mismatch self-heals with one automatic reload, and if the server
itself is stale the app says so explicitly instead of freezing.
