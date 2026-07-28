/* PyPDF Editor PWA service worker.
   Two caches:
   - APP_CACHE   (~100KB: html/css/js/icons) — bump on EVERY release. Installed
     with {cache:"reload"} so the HTTP cache can never mix old and new files
     into one build (a partial update used to brick handlers silently).
   - VENDOR_CACHE (~12MB: MuPDF wasm + pdf-lib) — bump ONLY when vendor/ files
     actually change. Kept across app releases, so updates no longer re-download
     the engine and the first load after an update is fast. */
const APP_CACHE    = "pypdf-app-v11.60";
const VENDOR_CACHE = "pypdf-vendor-v1";

const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./engine-watchdog.js",
  "./scan-core.js",
  "./scan-worker.js",
  "./manifest.webmanifest",
  "./icon-180.png",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
];
// NOTE: mupdf-wasm.wasm (~10MB) is deliberately NOT precached here. On first load
// engine-watchdog.js fetches it once (with a progress bar) and stores it in
// VENDOR_CACHE itself, so it is downloaded a SINGLE time instead of twice (once
// by this install, once by the engine). The fetch handler below still serves and
// caches it on later loads, so offline keeps working.
const VENDOR = [
  "./vendor/pdf-lib.min.js",
  "./vendor/mupdf/mupdf.js",
  "./vendor/mupdf/mupdf-wasm.js",
];

self.addEventListener("install", (e)=>{
  e.waitUntil((async ()=>{
    // app shell: always fetched fresh from the network, atomically
    const app = await caches.open(APP_CACHE);
    await app.addAll(APP_SHELL.map(u=>new Request(u, { cache:"reload" })));
    // vendor: only download what's missing (no-op on normal app updates)
    const ven = await caches.open(VENDOR_CACHE);
    for (const u of VENDOR){
      if (!(await ven.match(u))) await ven.add(new Request(u, { cache:"reload" }));
    }
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (e)=>{
  e.waitUntil((async ()=>{
    const keys = await caches.keys();
    await Promise.all(keys.filter(k=>k!==APP_CACHE && k!==VENDOR_CACHE).map(k=>caches.delete(k)));
    self.clients.claim();
  })());
});

self.addEventListener("fetch", (e)=>{
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // never intercept cross-origin requests; never serve or cache backups/
  if (url.origin !== location.origin) return;
  if (url.pathname.includes("/backups/")) return;
  e.respondWith((async ()=>{
    // v10.99: shortcut launches navigate to "./?action=scan" — same document,
    // different query. Match navigations ignoring the query string so the
    // cached app shell serves them (and shortcuts keep working offline).
    const cached = await caches.match(req, { ignoreSearch: req.mode === "navigate" });   // searches both caches
    if (cached) return cached;
    try {
      const res = await fetch(req);
      // v10.88: only runtime-cache known app/vendor asset types. Previously ANY
      // same-origin GET was stored in APP_CACHE forever (cache-first, no expiry),
      // so a stray request could pin a stale response across releases.
      // v11.48: .gz covers the OCR language data (vendor/ocr/eng.traineddata.gz)
      // so the recogniser, like the PDF engine, downloads once and then works
      // offline. It lands in VENDOR_CACHE via the /vendor/ rule below.
      const cacheable = /\.(html|css|js|mjs|json|webmanifest|png|svg|wasm|woff2?|gz)$/.test(url.pathname)
                     || url.pathname.endsWith("/");
      // v11.06: never runtime-cache query-string URLs (e.g. "./?action=scan")
      // — the shell already serves them via ignoreSearch, so caching each
      // variant would only add duplicate entries to APP_CACHE.
      if (res && res.ok && cacheable && !url.search){
        const cache = await caches.open(url.pathname.includes("/vendor/") ? VENDOR_CACHE : APP_CACHE);
        cache.put(req, res.clone());
      }
      return res;
    } catch (err){
      if (req.mode === "navigate") return caches.match("./index.html");
      throw err;
    }
  })());
});
