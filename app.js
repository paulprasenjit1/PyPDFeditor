"use strict";
import * as mupdf from "./vendor/mupdf/mupdf.js";
// shared scanner pixel math + edge detection (also imported by the scan worker
// — one source of truth for the warp, filters and document edge detection)
// NOTE: keep this on ONE line. tests/harness.mjs and tests/scenario-tests.mjs
// evaluate app.js by stripping `^import .*$` line by line, so a wrapped import
// statement leaves a dangling `... } from "./scan-core.js";` behind.
import { warpCore, colourBalanceCore, detectQuad, detectQuadRobust, frameStats, sharpEnough, inkFraction, looksBlank, toGreyscale, toBlackAndWhite, flattenIllumination, documentEnhance, idCardEnhance, autoCaptureReady, quadMaxCornerShift, AUTO } from "./scan-core.js";

const $ = id => document.getElementById(id);
// v11.18: belt-and-braces dark keyboard — set color-scheme on the root via the
// CSSOM too (some WebKit builds consult the element style chain at focus time).
try { document.documentElement.style.colorScheme = "dark"; } catch(e){}
const PDFLib = window.PDFLib;

// ---------------- build guard (with self-heal) ----------------
// If index.html and app.js come from different builds (stale HTTP/CDN copy,
// missed upload), wiring would crash silently and buttons would appear
// "frozen". Detect it, then: first occurrence per session → purge every cache,
// unregister the service worker and reload (heals a stale DEVICE copy).
// If it happens again right after healing, the SERVER itself is serving an old
// index.html — say so explicitly, since no amount of device clearing fixes that.
const APP_BUILD = "11.95";
(function buildGuard(){
  const pageBuild = document.documentElement.getAttribute("data-build") || "pre-9.2";
  const need = ["openBtn","moreBtn","signBtn","unlockBtn","undoBtn","status","sheet","sheetBg","spin","bigOpen","bigScan","welcomeHint","loupe","pageWrap","pagePill","closeBtn",
    "scanCam","scanShot","scanCancel","scanDone","scanThumbs","torchBtn",
    "scanCrop","cropPoly","g0","g1","g2","g3","h0","h1","h2","h3","enhToggle","idToggle","cropReset","cropRetake","cropUse",
    "autoBtn","paperBtn","idBothToggle","idSingleToggle","paperVal","camBoot",
    "whiteBtn","imgPlaceBtn","insImgInput","formBtn",
    "ge0","ge1","ge2","ge3","he0","he1","he2","he3"];
  const missing = need.filter(id=>!document.getElementById(id));
  if (!missing.length && pageBuild === APP_BUILD){
    try { sessionStorage.removeItem("pypdf-healed"); } catch(e){}
    return;                                            // page and script match
  }
  const s = document.getElementById("status");
  let alreadyTried = false;
  try { alreadyTried = sessionStorage.getItem("pypdf-healed") === "1"; } catch(e){}
  if (!alreadyTried){
    try { sessionStorage.setItem("pypdf-healed","1"); } catch(e){}
    if (s){ s.textContent = "Finishing update — reloading…"; s.className = "status warn"; }
    (async ()=>{
      try { const regs = await navigator.serviceWorker.getRegistrations();
            for (const r of regs) await r.unregister(); } catch(e){}
      try { const keys = await caches.keys();
            for (const k of keys) await caches.delete(k); } catch(e){}
      location.reload();
    })();
  } else if (s){
    s.textContent = "Update problem: this page is build "+pageBuild+" but the app code is build "+APP_BUILD
      + ". Your WEB SERVER is still serving an old index.html — re-upload ALL app files to the host"
      + " (and purge its CDN cache if it has one). Clearing the phone won't fix this.";
    s.className = "status err";
  }
  throw new Error("build mismatch (page "+pageBuild+" vs code "+APP_BUILD+"), missing: "+missing.join(","));
})();

// Surface unexpected errors in the status bar — a visible message instead of
// silently dead buttons — and keep the last few in a small on-device log
// (shown in More → About) so problems can be reported precisely.
// Remove the open document's name (and anything that looks like a filename)
// before a message is written to the persisted on-device error log, so a
// document title can't linger in localStorage on a shared device.
function scrubForLog(s){
  s = String(s==null ? "" : s);
  try { if (fileName && fileName!=="document.pdf") s = s.split(fileName).join("[file]"); } catch(e){}
  return s.replace(/[^\s/\\]+\.(pdf|png|jpe?g|gif|webp|heic|docx?)/gi, "[file]");
}
function reportError(kind, msg, src){
  const text = kind+": "+(msg||"unknown")+(src ? " @ "+src : "");
  try {
    const log = JSON.parse(localStorage.getItem("pypdf-errlog")||"[]");
    log.unshift(new Date().toISOString().slice(0,16).replace("T"," ")+" "+scrubForLog(text));
    localStorage.setItem("pypdf-errlog", JSON.stringify(log.slice(0,10)));   // v10.98: keep 10 (was 3) for better diagnosis
  } catch(e){}
  // v10.98: the banner shows the PLAIN-LANGUAGE translation; the raw message
  // is kept above in the on-device log (More → About) for diagnosis.
  try { setStatus(kind+": "+friendlyText(String(msg||"unknown"))+" — the app keeps running; if something stops working, close and reopen it.", "err"); } catch(e){}
}
window.addEventListener("error", (e)=>{
  // iOS reports many benign cross-context errors as an opaque "Script error."
  // with NO detail (no e.error, no filename) while the app keeps running — they
  // carry zero diagnostic value and need no user action, so ignore them rather
  // than alarming with a red banner. A genuinely failed engine load is surfaced
  // separately by engine-watchdog.js.
  if (!e.error && !e.filename && /^\s*script error/i.test(String(e.message||""))) return;
  const src = e.filename ? e.filename.split("/").pop()+":"+e.lineno+":"+e.colno : "";
  // prefer the real message/stack when the browser exposes it
  const detail = (e.error && (e.error.message || e.error.stack)) || e.message;
  reportError("Error", detail, src);
});
window.addEventListener("unhandledrejection", (e)=>{
  reportError("Async error", (e.reason && e.reason.message) || String(e.reason||""), "");
});

// ---------------- app version (shown in the About dialog) ----------------
// Bump these together with the CACHE name in sw.js on every release.
const APP_VERSION = APP_BUILD;          // single source of truth: always tracks APP_BUILD
const BUILD_DATETIME = "28 Jul 2026";   // v11.71
// One-line release note shown once after an update (keep in sync with APP_BUILD,
// so the banner never describes an older release).
const WHATS_NEW = "two scanner additions: a Colour / Greyscale / Black & white button (black & white makes a text page a fraction of the size, with sharper letters), and in the page review you can now retake a single page in place or move it earlier or later.";
// PDFName/PDFNumber/PDFHexString/PDFOperator (v11.29) are the low-level pieces
// used to redraw edited text with the PDF's OWN embedded font — see drawWithPdfFont.
const { PDFDocument, StandardFonts, rgb, degrees, PDFName, PDFNumber, PDFHexString, PDFOperator } = PDFLib;

// ---------------- state ----------------
let workingBytes = null;       // Uint8Array — single source of truth
let MDOC = null;               // live mupdf PDFDocument for the current bytes
let epoch = 0;                 // bumps on every change (invalidates caches)
let fileName = "document.pdf";
let zoomPct = 100;             // 50–300, 25% steps; 100% = fit to viewer width
let mergeSources = null;       // staged docs awaiting a chosen merge order
let signImgDataUrl = null;     // processed signature PNG dataURL
let mode = null;               // null | "sign" | "text" | "select" | "white" (v11.43)
let insImgPlacing = false;     // v11.43: sign flow is placing a PICTURE, not a signature
// v11.22: remember the last markup tool used this session (until the PDF is
// closed) so reopening the Markup popover highlights it as the preferred tool.
let lastMarkupMode = null;
const spanCache = new Map();   // key `${epoch}:${page}` -> spans[]
let pageObserver = null;       // single lazy-render observer (disconnected on hide/close)
const liveURLs = new Set();    // outstanding object URLs, revoked on teardown
let lastViewerW = 0;           // last width we rendered at (skip no-op resize re-renders)

// HTML-escape any value before putting it in innerHTML. File names are
// attacker-influenced, so this prevents DOM-based XSS in the sheets.
function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g,
  c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }
// Auto-escaping HTML template: every ${interpolation} is escaped by default,
// so XSS-safety is structural rather than per-call-site discipline. Markup
// that is itself built with h\`\` can be passed through with raw().
function raw(s){ return { __raw: String(s==null?"":s) }; }
function h(strings, ...vals){
  let out = strings[0];
  for (let i=0;i<vals.length;i++){
    const v = vals[i];
    out += (v && typeof v==="object" && v.__raw!==undefined) ? v.__raw : esc(v);
    out += strings[i+1];
  }
  return out;
}
// ---------------- inline SVG icon set (CSP-safe) ----------------
// Line glyphs used by the More-menu tiles. They are styled by `svg.ic` in
// styles.css (stroke:currentColor), so no per-icon style attribute is needed
// and style-src can stay 'self'. ic(name) returns a raw() so the h\`\` template
// passes the markup through unescaped.
const ICONS = {
  combine: '<path d="M12 4l8 4l-8 4l-8 -4z"/><path d="M4 12l8 4l8 -4"/>',
  grid:    '<path d="M5 5h5v5h-5z"/><path d="M14 5h5v5h-5z"/><path d="M5 14h5v5h-5z"/><path d="M14 14h5v5h-5z"/>',
  copy:    '<path d="M9 9h10v10h-10z"/><path d="M15 9v-4h-10v10h4"/>',
  camera:  '<path d="M5 8h3l2 -2h4l2 2h3a1 1 0 0 1 1 1v9a1 1 0 0 1 -1 1h-14a1 1 0 0 1 -1 -1v-9a1 1 0 0 1 1 -1z"/><path d="M12 17a3 3 0 1 0 0 -6a3 3 0 0 0 0 6z"/>',
  hash:    '<path d="M5 9h14M5 15h14M10 4l-2 16M16 4l-2 16"/>',
  sign:    '<path d="M4 18c3 0 5 -10 7 -10c1 0 1 4 2 4c1 0 2 -2 3 -2"/><path d="M4 21h16"/>',
  photo:   '<path d="M5 5h14v14h-14z"/><path d="M9 11a1.2 1.2 0 1 0 0 -2.4a1.2 1.2 0 0 0 0 2.4z"/><path d="M5 16l4 -4l3 3l3 -3l4 4"/>',
  unlock:  '<path d="M7 11h10v8h-10z"/><path d="M9 11v-3a3 3 0 0 1 6 0"/>',
  compress:'<path d="M5 9h4v-4"/><path d="M3 3l6 6"/><path d="M5 15h4v4"/><path d="M3 21l6 -6"/><path d="M19 9h-4v-4"/><path d="M15 9l6 -6"/><path d="M19 15h-4v4"/><path d="M15 15l6 6"/>',
  download:'<path d="M12 4v10M8 11l4 4l4 -4"/><path d="M5 19h14"/>',
  info:    '<path d="M12 21a9 9 0 1 0 0 -18a9 9 0 0 0 0 18z"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
  search:  '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4 -4"/>',
  close:   '<path d="M6 6l12 12M18 6l-12 12"/>'
};
function ic(name){
  return raw('<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">' + (ICONS[name]||"") + '</svg>');
}
// Strip path separators / control chars from a download file name.
function safeFileName(n){
  return String(n||"document.pdf").replace(/[\/\\\x00-\x1f]/g,"_").slice(0,128) || "document.pdf";
}

let statusTimer = null;
// Transient confirmations behave like an iOS toast: they appear, then fade after
// a few seconds so the bar collapses and returns the space to the viewer. Errors
// and warnings persist until the next action, since the user may need to read
// them. aria-live still announces every message because the text is set first.
function setStatus(msg, cls=""){
  const s=$("status"); s.textContent=msg; s.className="status "+cls;
  clearTimeout(statusTimer);
  if (msg && cls!=="err" && cls!=="warn"){
    statusTimer = setTimeout(()=>{ s.textContent=""; s.className="status"; }, 3600);
  }
}
// Translate raw engine errors into plain language. The raw message is kept in
// the on-device error log (More → About) for diagnosis. friendlyText is the
// pure translation (no logging) — used by reportError, which logs separately.
function friendly(err){
  const m = String((err && err.message) || err || "");
  try {
    const log = JSON.parse(localStorage.getItem("pypdf-errlog")||"[]");
    log.unshift(new Date().toISOString().slice(0,16).replace("T"," ")+" "+scrubForLog(m).slice(0,120));
    localStorage.setItem("pypdf-errlog", JSON.stringify(log.slice(0,10)));   // v10.98: keep 10 (was 3)
  } catch(e){}
  return friendlyText(m);
}
function friendlyText(m){
  if (/password/i.test(m))                                   return "this PDF is password-protected.";
  if (/format error|cannot recognize|trailer|startxref|xref|no objects found|no pages found|not a PDF|repair/i.test(m))
                                                             return "this file appears damaged, or isn't really a PDF.";
  if (/memory|alloc/i.test(m))                               return "the file is too large for this device's memory. Try closing other apps, or use a smaller file.";
  if (/encrypt/i.test(m))                                    return "this PDF is protected and can't be changed.";
  if (/network|fetch|load failed/i.test(m))                  return "a file couldn't be loaded. Check the connection and try again.";
  return m || "something went wrong. Please try again.";
}
function showSpin(on, txt){ const s=$("spin"); if(txt) s.textContent=txt; s.classList.toggle("show", !!on); }
// Promises that wait on a sheet (e.g. askPassword) register a dismiss handler
// here. closeSheet() fires it so a backdrop tap or Esc resolves the awaited
// value as "cancelled" instead of leaving the caller hanging forever.
let sheetOnDismiss = null;
let sheetLastFocus = null;     // element focused before the sheet opened (restored on close)
// Always drop the working spinner before opening a modal, otherwise its
// full-screen overlay would sit on top and swallow the modal's taps.
function openSheet(){
  showSpin(false);
  hideMkMenu();                                  // v11.11: popover never sits over a sheet
  sheetOnDismiss = null;                       // clear any stale pending-dismiss handler
  sheetLastFocus = document.activeElement;     // remember focus to restore on close
  $("sheetBg").classList.add("show");
  // expose the sheet as a modal dialog to assistive tech, label it from its
  // heading, and move focus inside so VoiceOver/keyboard land in the dialog
  const sheet = $("sheet");
  const hd = sheet.querySelector("h3");
  sheet.setAttribute("aria-label", hd ? hd.textContent : "Dialog");
  const focusTarget = sheet.querySelector("input,textarea,button") || sheet;
  setTimeout(()=>{ try{ focusTarget.focus(); }catch(e){} }, 0);
}
function fmtKB(b){ return b>=1048576 ? (b/1048576).toFixed(2)+" MB" : (b/1024).toFixed(1)+" KB"; }
// Header label: filename (ellipsises when long) + size (always kept visible). The
// size lives in its own non-shrinking span so a long name can't push it off.
function setMeta(name, info){
  const a=$("metaName"), b=$("metaInfo");
  if (a) a.textContent = name || "";
  if (b) b.textContent = info ? "  •  "+info : "";
}
function baseName(){ return (fileName||"document.pdf").replace(/\.[^.]+$/,""); }
// MuPDF's asUint8Array/asJPEG/asPNG return VIEWS into WASM memory; any later WASM
// allocation can grow the heap and detach them. Copy into a JS-owned buffer at once.
const u8 = v => new Uint8Array(v);

// ---------------- engine ready ----------------
(function engineReady(){
  // The module only runs after mupdf's WASM has initialised (top-level await
  // inside mupdf.js), so by here the engine is live.
  $("openBtn").disabled = false;
  $("moreBtn").disabled = false;
  $("unlockBtn").disabled = false;   // Unlock works without an open doc (picks a file)
  $("bigOpen").disabled = false;
  $("bigScan").disabled = false;
  $("bigPhotos").disabled = false;
  $("welcomeHint").textContent = "Everything stays on your phone — nothing is uploaded.";
  setMeta("No document open", "");
  // fade out the first-paint launch splash now the engine is live, then remove
  // it from the layer so it never intercepts taps
  const lh = document.getElementById("launch");
  if (lh){ lh.classList.add("gone"); setTimeout(()=>{ try{ lh.remove(); }catch(e){} }, 450); }
  setStatus("Ready. Open a PDF or scan a document.", "ok");
  // tell the engine-load watchdog the engine is live, so it cancels its timer
  window.__pypdfEngineReady = true;
  try { window.dispatchEvent(new Event("pypdf-engine-ready")); } catch(e){}
  // v10.94: a file picked during engine boot (engine-watchdog early open)
  // opens right now — the user never waited on the compile.
  const pf = window.__pypdfPendingFile;
  if (pf){
    window.__pypdfPendingFile = null;
    window.__pypdfHadPendingFile = true;   // suppresses the session-restore prompt
    (async ()=>{
      showSpin(true, "Opening "+pf.name+" …");
      try { await openBytes(new Uint8Array(await pf.arrayBuffer()), pf.name); }
      catch(err){ setStatus("Could not open: "+friendly(err),"err"); }
      showSpin(false);
    })();
  }
  // v10.99: home-screen "Scan" shortcut (manifest `shortcuts`) — launching the
  // app with ?action=scan goes straight to the scanner. Deferred one tick so
  // the module finishes initialising (scanner state lives further down the
  // file); the session-restore prompt is suppressed because intent is clear.
  try {
    const act = new URLSearchParams((window.location && window.location.search) || "").get("action");
    if (act === "scan" && !pf){
      window.__pypdfHadPendingFile = true;
      setTimeout(()=>{ try { startScan(); } catch(e){} }, 0);
    }
  } catch(e){}
})();
$("bigOpen").onclick = ()=> confirmDiscard("open another PDF", ()=>$("fileInput").click());
$("bigScan").onclick = ()=> startScan();
$("bigPhotos").onclick = ()=> $("imgInput").click();   // no confirm needed: welcome = nothing open

// ---------------- session persistence (IndexedDB, on-device only) ----------------
// The working document and any in-progress scan survive iOS evicting the PWA.
// Everything is wrapped in try/catch so private-browsing modes that block
// storage can never break the app. Password-unlocked PDFs are NEVER persisted
// (the decrypted copy must not outlive the session).
const DB_NAME="pypdf-state", DB_STORE="kv";
let docSensitive = false;     // true when the open doc came from a password unlock
let dirty = false;            // true when the document has changes not yet Saved
// v11.26: every dirty transition goes through here so the Save icon can show
// a small "unsaved changes" dot (iOS-style) the moment there is work to save.
function setDirty(v){
  dirty = !!v;
  try { $("saveBtn").classList.toggle("dirty", dirty && !!workingBytes); } catch(e){}
}

// Before any action that would REPLACE or close the open document, warn if
// there are unsaved changes. Offers Save first / Continue / Cancel.
function confirmDiscard(actionLabel, proceed){
  if (!workingBytes || !dirty){ proceed(); return; }
  $("sheet").innerHTML = h`
    <h3>Unsaved changes</h3>
    <p class="hint">“${fileName}” has changes you haven't saved. If you ${actionLabel} now, those changes will be lost.</p>
    <div class="row"><button class="full" id="udSave">Save first</button></div>
    <div class="row"><button class="ghost full" id="udGo">Continue without saving</button></div>
    <div class="row"><button class="ghost full" id="udCancel">Cancel</button></div>`;
  $("udSave").onclick   = ()=>{ closeSheet(); openSaveSheet(proceed); };
  $("udGo").onclick     = ()=>{ closeSheet(); proceed(); };
  $("udCancel").onclick = closeSheet;
  openSheet();
}
let persistT = 0;             // debounce timer for document persistence
// One cached connection, reused for every read/write. Opening (and closing) a
// fresh connection on every persist/scan-page write was wasteful churn; a single
// long-lived handle is the normal IndexedDB pattern. Cleared if it ever closes.
let _idb = null;
function idbOpen(){
  if (_idb) return Promise.resolve(_idb);
  return new Promise((res,rej)=>{
    const r=indexedDB.open(DB_NAME,1);
    r.onupgradeneeded=()=>r.result.createObjectStore(DB_STORE);
    r.onsuccess=()=>{ _idb=r.result; try{ _idb.onclose=()=>{ _idb=null; }; }catch(e){} res(_idb); };
    r.onerror=()=>rej(r.error);
  });
}
async function idbSet(key,val){
  const db=await idbOpen();
  return new Promise((res,rej)=>{
    const tx=db.transaction(DB_STORE,"readwrite");
    tx.objectStore(DB_STORE).put(val,key);
    tx.oncomplete=()=>res();
    tx.onerror=()=>rej(tx.error);
  });
}
async function idbGet(key){
  const db=await idbOpen();
  return new Promise((res,rej)=>{
    const tx=db.transaction(DB_STORE,"readonly");
    const rq=tx.objectStore(DB_STORE).get(key);
    rq.onsuccess=()=>res(rq.result);
    rq.onerror=()=>rej(rq.error);
  });
}
async function idbDel(key){
  const db=await idbOpen();
  return new Promise((res,rej)=>{
    const tx=db.transaction(DB_STORE,"readwrite");
    tx.objectStore(DB_STORE).delete(key);
    tx.oncomplete=()=>res();
    tx.onerror=()=>rej(tx.error);
  });
}
// ---- storage failure funnel (v10.88) ----
// Persist writes used to swallow every failure silently; on a full iPhone that
// meant session-restore / scan pages / recents quietly stopped working. Quota
// problems now surface ONCE per session as a warning toast (the app keeps
// running — persistence is a convenience, not a requirement).
let storageWarned = false;
function storageWarn(e){
  const quota = e && (e.name === "QuotaExceededError" || /quota|storage/i.test(String(e.message||e)));
  if (!quota || storageWarned) return;
  storageWarned = true;
  setStatus("Your device is low on storage — unsaved-work backup and Recents are paused. Saved PDFs are not affected.", "warn");
}
// Ask the browser to protect our storage from automatic eviction (iOS clears
// unprotected site data after periods of non-use — that silently wiped
// session-restore and recents). Best-effort; denial is fine.
try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(()=>{}); } catch(e){}

// very large documents are not auto-persisted: cloning ~100MB to storage on
// every change caused multi-second stalls and memory spikes. The original
// file already exists in Files, so nothing is lost — only session-restore.
const PERSIST_MAX_BYTES = 25*1024*1024;
function persistDocNow(){
  persistT=0;
  try {
    if (workingBytes && !docSensitive && workingBytes.length <= PERSIST_MAX_BYTES)
      idbSet("doc",{ name:fileName, bytes:workingBytes, ts:Date.now(), dirty }).catch(storageWarn);
    else idbDel("doc").catch(()=>{});
  } catch(e){}
}
function schedulePersistDoc(){ clearTimeout(persistT); persistT=setTimeout(persistDocNow,800); }
function flushPersistDoc(){ if (persistT){ clearTimeout(persistT); persistDocNow(); } }
// scan pages are persisted incrementally: each page under its own key, plus a
// small meta record. Adding page 12 writes one page, not all twelve again.
let scanPersistPrev = [];
function persistScan(){
  try {
    if (!scanPages.length){
      const had = scanPersistPrev.length;
      scanPersistPrev = [];
      idbDel("scan").catch(()=>{});
      for (let i=0;i<had;i++) idbDel("scan:p"+i).catch(()=>{});
      return;
    }
    const prev = scanPersistPrev;
    const appendOnly = scanPages.length >= prev.length && prev.every((p,i)=>scanPages[i]===p);
    if (!appendOnly)
      for (let i=scanPages.length;i<prev.length;i++) idbDel("scan:p"+i).catch(()=>{});
    for (let i=(appendOnly?prev.length:0); i<scanPages.length; i++)
      idbSet("scan:p"+i, scanPages[i]).catch(storageWarn);
    idbSet("scan", { count:scanPages.length, ts:Date.now() }).catch(storageWarn);
    scanPersistPrev = scanPages.slice();
  } catch(e){}
}
// Fully remove a persisted scan session from storage, including every per-page
// blob. Used when the user discards a restorable session — otherwise the
// scan:p0…pN page blobs were orphaned in IndexedDB and accumulated forever.
function dropScanStorage(count){
  try {
    idbDel("scan").catch(()=>{});
    const upTo = Math.max(count||0, scanPersistPrev.length);
    for (let i=0;i<upTo;i++) idbDel("scan:p"+i).catch(()=>{});
    scanPersistPrev = [];
  } catch(e){}
}

// ---------------- recent files (welcome screen, most-recent-first) ----------------
// A small MRU list so the app opens to your work, not a blank screen. Bytes are
// stored per entry under their own key; sensitive (password-unlocked) documents
// and very large files are never remembered, same rule as session persistence.
const RECENTS_MAX = 6;         // v11.22: fills the 2-col grid (3 rows)
const RECENTS_PIN_MAX = 3;     // v11.22: at most 3 starred/pinned documents
// v10.99: also cap TOTAL recents bytes — five 25MB documents pinned ~125MB of
// IndexedDB, which hastened the storage-full warning and iOS eviction. The
// newest entry always survives even if it alone exceeds the budget.
const RECENTS_MAX_BYTES = 60*1024*1024;
async function recentsGet(){ try { return (await idbGet("recents")) || []; } catch(e){ return []; } }
// v11.10: a small first-page JPEG (≈200px wide, a few KB) stored with each
// recents entry, so the welcome screen shows Files-style thumbnail cards.
// Best-effort: any failure just means the card shows a blank placeholder.
function recentFirstThumb(){
  try {
    if (!MDOC) return null;
    const page = MDOC.loadPage(0);
    const [x0,y0,x1,y1] = page.getBounds();
    const s = 200/(x1-x0);
    const pix = page.toPixmap(mupdf.Matrix.scale(s,s), mupdf.ColorSpace.DeviceRGB, false);
    const jpg = u8(pix.asJPEG(72)); pix.destroy(); page.destroy();
    let bin=""; for (let k=0;k<jpg.length;k+=8192) bin += String.fromCharCode.apply(null, jpg.subarray(k,k+8192));
    return "data:image/jpeg;base64,"+btoa(bin);
  } catch(e){ return null; }
}
function recentsRemember(){
  if (!workingBytes || docSensitive || workingBytes.length > PERSIST_MAX_BYTES) return;
  const bytes = workingBytes, name = fileName;
  const thumb = recentFirstThumb();
  (async ()=>{ try {
    let list = await recentsGet();
    const wasPinned = list.some(r=>r.name===name && r.pinned);   // v11.22: keep the star
    // v11.24: opening a file that Recents ALREADY stores (same name + size —
    // e.g. reopened from the Recents grid itself) used to rewrite the full
    // 25MB into IndexedDB every time. Reuse the stored bytes: refresh the
    // timestamp/thumb/star on the existing entry and skip the byte write.
    const same = list.find(r=>r.name===name && r.size===bytes.length);
    if (same){
      same.ts = Date.now(); same.pinned = wasPinned;
      if (thumb) same.thumb = thumb;
      list = [same, ...list.filter(r=>r!==same)];
      await idbSet("recents", list);
      renderRecents();
      return;
    }
    for (const r of list.filter(r=>r.name===name)) idbDel(r.id).catch(()=>{});
    list = list.filter(r=>r.name!==name);
    const id = "recent:"+Date.now();
    list.unshift({ id, name, size:bytes.length, ts:Date.now(), thumb, pinned:wasPinned });
    // v11.22: cap the count but never evict a starred entry; starred float first
    const pinned = list.filter(r=>r.pinned);
    const unpinned = list.filter(r=>!r.pinned);
    const slots = Math.max(0, RECENTS_MAX - pinned.length);
    for (const r of unpinned.slice(slots)) idbDel(r.id).catch(()=>{});
    list = pinned.concat(unpinned.slice(0, slots));
    // byte cap: always keep starred + the just-opened file, then fill by recency
    let tot = 0; const keep = [];
    for (const r of list){
      const mustKeep = r.pinned || r.id === id;
      if (mustKeep || !keep.length || tot + r.size <= RECENTS_MAX_BYTES){ keep.push(r); tot += r.size; }
      else idbDel(r.id).catch(()=>{});
    }
    list = keep;
    await idbSet(id, bytes);
    await idbSet("recents", list);
    renderRecents();
  } catch(e){ storageWarn(e); } })();
}
async function renderRecents(){
  const box = $("recents"); if (!box) return;
  const list = await recentsGet();
  if (!list.length){ box.hidden = true; box.innerHTML = ""; return; }
  // v11.22: starred documents float to the front, each group newest-first
  const ordered = list.slice().sort((a,b)=>
    (b.pinned?1:0)-(a.pinned?1:0) || (b.ts||0)-(a.ts||0));
  const rows = ordered.map(r=>{
    const d = new Date(r.ts);
    const when = d.toLocaleDateString(undefined, { day:"numeric", month:"short" });
    // v11.10: thumbnail card (first page) instead of a text row
    const img = (r.thumb && /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(r.thumb))
      ? h`<img class="rcthumb" src="${r.thumb}" alt="">`
      : h`<span class="rcthumb rcph" aria-hidden="true"></span>`;
    // v11.22: star overlay lives beside the open button (buttons can't nest)
    const star = h`<button class="rcstar ${r.pinned?"on":""}" data-star="${r.id}"
        aria-pressed="${r.pinned?"true":"false"}" aria-label="${r.pinned?"Unstar":"Star"} ${r.name}">
        <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l2.9 5.9l6.5 .9l-4.7 4.6l1.1 6.5l-5.8 -3.1l-5.8 3.1l1.1 -6.5l-4.7 -4.6l6.5 -.9z"/></svg>
      </button>`;
    return h`<div class="rccell">
      <button class="rccard" data-rc="${r.id}" aria-label="Open ${r.name}">
        ${raw(img)}
        <span class="rcname">${r.name}</span>
        <span class="rcinfo">${fmtKB(r.size)} · ${when}</span>
      </button>
      ${raw(star)}
    </div>`;
  }).join("");
  box.innerHTML = h`<p class="rctitle">Recent</p><div class="rcgrid">${raw(rows)}</div>
    <button class="rcclear" id="rcClear">Clear recents</button>`;
  box.hidden = false;
  // v11.22: star / unstar (max 3). stopPropagation so it never opens the file.
  box.querySelectorAll("[data-star]").forEach(b=>b.onclick = async (e)=>{
    e.stopPropagation(); e.preventDefault();
    recentsToggleStar(b.dataset.star);
  });
  // v11.26: long-press a card for Open / Star / Remove — so ONE document can
  // be removed without wiping the whole list. Pointer-based: fires after
  // 550ms unless the finger lifts or moves >12px (i.e. it was a tap/scroll).
  box.querySelectorAll("[data-rc]").forEach(b=>{
    let lpT = 0, sx = 0, sy = 0;
    b.addEventListener("pointerdown", (e)=>{
      sx = e.clientX; sy = e.clientY;
      clearTimeout(lpT);
      lpT = setTimeout(()=>{ b.dataset.lp = "1"; openRecentSheet(b.dataset.rc); }, 550);
    });
    b.addEventListener("pointermove", (e)=>{
      if (Math.abs(e.clientX-sx) > 12 || Math.abs(e.clientY-sy) > 12) clearTimeout(lpT);
    });
    ["pointerup","pointercancel","pointerleave"].forEach(ev=>
      b.addEventListener(ev, ()=>clearTimeout(lpT)));
  });
  box.querySelectorAll("[data-rc]").forEach(b=>b.onclick = async ()=>{
    if (b.dataset.lp){ delete b.dataset.lp; return; }   // v11.26: long-press consumed this tap
    if ($("bigOpen").disabled){ setStatus("One moment — the engine is still loading.","warn"); return; }
    const id = b.dataset.rc;
    try {
      const bytes = await idbGet(id);
      if (!bytes || !bytes.length) throw new Error("no longer stored on this device");
      const entry = (await recentsGet()).find(r=>r.id===id);
      showSpin(true,"Opening…");
      await openBytes(bytes, (entry && entry.name) || "document.pdf");
    } catch(e){
      setStatus("Could not open it: "+friendly(e),"err");
      // drop the dead entry so the list stays honest
      try { const list=(await recentsGet()).filter(r=>r.id!==id); await idbSet("recents", list); idbDel(id).catch(()=>{}); renderRecents(); } catch(e2){}
    }
    showSpin(false);
  });
  // v11.49: Clear recents spares STARRED documents. A star means "keep this
  // around", and one tap on Clear must not silently break that promise — so
  // only unstarred entries (and their stored bytes) are removed. A starred
  // document leaves the list exactly one way: long-press it → Remove from
  // Recents (or unstar it first, after which Clear applies).
  $("rcClear").onclick = async ()=>{
    try {
      const list = await recentsGet();
      const starred = list.filter(r=>r.pinned);
      const gone = list.filter(r=>!r.pinned);
      if (!gone.length){
        setStatus(starred.length
          ? "All "+starred.length+" are starred, so Clear keeps them. Long-press a card and choose Remove from Recents to take one off."
          : "Nothing to clear.","warn");
        return;
      }
      for (const r of gone) idbDel(r.id).catch(()=>{});
      if (starred.length) await idbSet("recents", starred);
      else await idbDel("recents");
      setStatus("Cleared "+gone.length+" recent"+(gone.length>1?"s":"")
        + (starred.length ? " — "+starred.length+" starred kept. Long-press a starred card to remove it." : "."),"ok");
    } catch(e){}
    renderRecents();
  };
}
// v11.26: shared star toggle (star button + long-press sheet use the same path)
async function recentsToggleStar(id){
  try {
    const cur = await recentsGet();
    const entry = cur.find(r=>r.id===id);
    if (!entry) return;
    if (!entry.pinned && cur.filter(r=>r.pinned).length >= RECENTS_PIN_MAX){
      setStatus("You can star up to "+RECENTS_PIN_MAX+" documents.","warn"); return;
    }
    entry.pinned = !entry.pinned;
    await idbSet("recents", cur);
    renderRecents();
  } catch(e){}
}
// v11.26: remove ONE recent (entry + stored bytes) without clearing the rest
async function recentsRemove(id){
  try {
    const list = (await recentsGet()).filter(r=>r.id!==id);
    await idbSet("recents", list);
    idbDel(id).catch(()=>{});
    renderRecents();
  } catch(e){}
}
// v11.26: long-press sheet for a recents card — Open / Share / Star / Remove
async function openRecentSheet(id){
  const entry = (await recentsGet()).find(r=>r.id===id);
  if (!entry) return;
  // v11.27: pre-load the stored bytes NOW (sheet open is itself a user
  // gesture), so tapping Share calls navigator.share with no async gap —
  // iOS voids the share sheet if user activation has expired by then.
  let shareBytes = null;
  try { shareBytes = await idbGet(id); } catch(e){}
  $("sheet").innerHTML = h`
    <h3>${entry.name}</h3>
    <p class="hint">${fmtKB(entry.size)} · stays only on this phone.</p>
    <div class="row"><button class="full" id="rsOpen">Open</button></div>
    <!-- v11.35: open it and go straight to the camera, so pages land on the end
         of THIS document. Needs the stored bytes, same as Share. -->
    <div class="row"><button class="ghost full" id="rsScanAdd" ${shareBytes && shareBytes.length ? "" : "disabled"}>Scan more pages into this</button></div>
    <div class="row"><button class="ghost full" id="rsShare" ${shareBytes && shareBytes.length ? "" : "disabled"}>Share… (WhatsApp, Mail, AirDrop)</button></div>
    <div class="row"><button class="ghost full" id="rsStar">${entry.pinned ? "Remove star" : "Star"}</button></div>
    <div class="row"><button class="ghost danger full" id="rsDel">Remove from Recents</button></div>
    <div class="row"><button class="ghost full" id="rsCancel">Cancel</button></div>`;
  $("rsShare").onclick = async ()=>{
    closeSheet();
    // native iOS share sheet — WhatsApp, Mail, AirDrop, Save to Files…
    try { await saveOrShare(shareBytes, entry.name || "document.pdf"); }
    catch(e){ setStatus("Could not share it: "+friendly(e),"err"); }
  };
  $("rsOpen").onclick = async ()=>{
    closeSheet();
    if ($("bigOpen").disabled){ setStatus("One moment — the engine is still loading.","warn"); return; }
    try {
      const bytes = await idbGet(id);
      if (!bytes || !bytes.length) throw new Error("no longer stored on this device");
      showSpin(true,"Opening…");
      await openBytes(bytes, entry.name || "document.pdf");
    } catch(e){ setStatus("Could not open it: "+friendly(e),"err"); }
    showSpin(false);
  };
  $("rsScanAdd").onclick = async ()=>{
    closeSheet();
    if ($("bigOpen").disabled){ setStatus("One moment — the engine is still loading.","warn"); return; }
    try {
      const bytes = await idbGet(id);
      if (!bytes || !bytes.length) throw new Error("no longer stored on this device");
      showSpin(true,"Opening…");
      await openBytes(bytes, entry.name || "document.pdf");
      showSpin(false);
      // only enter the scanner once the document is genuinely open, so a failed
      // open can't leave the camera pointing at nothing to append to
      if (workingBytes) await startScan(true);
      else setStatus("Could not open that document, so there is nothing to add pages to.","err");
    } catch(e){ showSpin(false); setStatus("Could not open it: "+friendly(e),"err"); }
  };
  $("rsStar").onclick = ()=>{ closeSheet(); recentsToggleStar(id); };
  $("rsDel").onclick  = ()=>{ closeSheet(); recentsRemove(id); setStatus("Removed from Recents.","ok"); };
  $("rsCancel").onclick = closeSheet;
  openSheet();
}

// ---------------- mupdf doc lifecycle ----------------
function closeDoc(){ if (MDOC){ try{ MDOC.destroy(); }catch(e){} MDOC=null; } }
function reopen(){
  closeDoc();
  // mupdf reads the buffer up front; hand it a fresh copy so workingBytes stays intact
  MDOC = mupdf.Document.openDocument(workingBytes.slice(0), "application/pdf").asPDF();
  epoch++;
  spanCache.clear();
  // v10.90: drop thumbnails from previous epochs immediately. They were only
  // evicted by the 400-entry LRU cap, so a long editing session on a big
  // document kept hundreds of stale dataURLs alive.
  for (const k of [...thumbCache.keys()]) if (!k.startsWith(epoch+":")) thumbCache.delete(k);
  schedulePersistDoc();        // every byte change flows through here
  // an edit changes the bytes → previously found matches are stale. Re-run the
  // search against the new document so highlights and the count stay correct.
  if (SEARCH.open && SEARCH.needle) runFind(SEARCH.needle);
}

function enableDocButtons(has){
  for (const id of ["textBtn","selectBtn","signBtn","whiteBtn","imgPlaceBtn","formBtn","compBtn","saveBtn","closeBtn","pagesBtn","markupBtn","findBtn"]) $(id).disabled = !has;
  if (!has) hideMkMenu();                      // v11.11: no doc → no markup popover
  refreshZoomButtons(); refreshUndo();
}
function refreshUndo(){
  const has = !!undoStack.length;
  $("undoBtn").disabled = !has;
  $("undoBtn").classList.toggle("show", has);   // floating pill: visible only when there's something to undo
}
function refreshZoomButtons(){
  $("zoomOut").disabled = !workingBytes || zoomPct<=50;
  $("zoomIn").disabled  = !workingBytes || zoomPct>=300;
  // the floating zoom pill only appears while a document is open
  const zc = $("zoomctl"); if (zc) zc.classList.toggle("show", !!workingBytes);
}
// set the zoom and re-render, keeping the content under the anchor point
// (a pinch centre, a double-tap, or the viewer middle) visually in place
let zooming = false;
// v11.03: find the page under a screen point and the fractional position within
// it. Anchoring on a real page (not a global scroll ratio) is exact regardless
// of the fixed 10px gaps between pages, so a zoom can't drift to another page.
function anchorStage(cx, cy){
  const stages = $("pageWrap").querySelectorAll(".stage");
  let contain = null, nearest = null, nd = Infinity;
  for (const s of stages){
    const rc = s.getBoundingClientRect();
    if (cy >= rc.top && cy <= rc.bottom){ contain = { s, rc }; break; }
    const d = cy < rc.top ? rc.top - cy : cy - rc.bottom;   // gap between pages
    if (d < nd){ nd = d; nearest = { s, rc }; }
  }
  const hit = contain || nearest;
  if (!hit) return null;
  const rc = hit.rc;
  const fx = rc.width  ? Math.max(0, Math.min(1, (cx - rc.left) / rc.width))  : 0.5;
  const fy = rc.height ? Math.max(0, Math.min(1, (cy - rc.top)  / rc.height)) : 0.5;
  return { page: +hit.s.dataset.page, fx, fy };
}
async function setZoom(newPct, anchorX, anchorY){
  newPct = Math.max(50, Math.min(300, Math.round(newPct/5)*5));
  if (newPct === zoomPct || !workingBytes || zooming){ refreshZoomButtons(); return; }
  zooming = true;
  const v = $("viewer"), r = v.getBoundingClientRect();
  const ax = (anchorX==null ? r.width/2  : anchorX - r.left);
  const ay = (anchorY==null ? r.height/2 : anchorY - r.top);
  const px = r.left + ax, py = r.top + ay;      // anchor point in screen coords
  const anchor = anchorStage(px, py);           // page + fraction under the anchor
  const ratio = newPct / zoomPct;
  const sx = v.scrollLeft, sy = v.scrollTop;
  zoomPct = newPct;
  $("zoomLbl").textContent = zoomPct + "%";
  refreshZoomButtons();
  await render();
  const maxL = Math.max(0, v.scrollWidth  - v.clientWidth);
  const maxT = Math.max(0, v.scrollHeight - v.clientHeight);
  const stg = anchor && $("pageWrap").querySelector('.stage[data-page="'+anchor.page+'"]');
  if (stg){
    // exact: put the same fraction of the same page back under the anchor point
    const rc = stg.getBoundingClientRect();
    const curX = rc.left + anchor.fx * rc.width;
    const curY = rc.top  + anchor.fy * rc.height;
    v.scrollLeft = Math.max(0, Math.min(maxL, v.scrollLeft + (curX - px)));
    v.scrollTop  = Math.max(0, Math.min(maxT, v.scrollTop  + (curY - py)));
  } else {
    // fallback: ratio math, clamped so it never snaps to the first page (v11.01)
    v.scrollLeft = Math.max(0, Math.min(maxL, (sx + ax) * ratio - ax));
    v.scrollTop  = Math.max(0, Math.min(maxT, (sy + ay) * ratio - ay));
  }
  zooming = false;
  saveViewState();               // v10.91: remember zoom for this document
}

// ---------------- per-document view memory (v10.91) ----------------
// Remember zoom + reading position per document (keyed by filename, LRU 20)
// so a file reopened from Recents or session restore comes back exactly where
// you left it. Throttled; best-effort — failures never surface.
let viewSaveT = 0;
function saveViewState(){
  if (!workingBytes || !MDOC) return;
  clearTimeout(viewSaveT);
  viewSaveT = setTimeout(async ()=>{
    try {
      const v = $("viewer");
      const range = v.scrollHeight - v.clientHeight;
      const frac = range > 0 ? v.scrollTop/range : 0;
      const views = (await idbGet("views")) || {};
      views[fileName] = { zoom: zoomPct, frac, ts: Date.now() };
      const keys = Object.keys(views);
      if (keys.length > 20){
        keys.sort((a,b)=>views[a].ts-views[b].ts);
        for (const k of keys.slice(0, keys.length-20)) delete views[k];
      }
      idbSet("views", views).catch(()=>{});
    } catch(e){}
  }, 800);
}
async function restoreViewState(){
  try {
    const views = await idbGet("views");
    const st = views && views[fileName];
    if (!st) return;
    if (st.zoom && st.zoom !== zoomPct) await setZoom(st.zoom);
    if (st.frac){
      const v = $("viewer");
      v.scrollTop = st.frac * (v.scrollHeight - v.clientHeight);
    }
  } catch(e){}
}
function applyZoom(delta){ setZoom(zoomPct + delta); }
// v10.98: the floating − / + zoom pill is visible on every screen size now, so
// the hint mentions it everywhere; phones lead with the gestures.
function zoomTip(){
  const phone = (typeof window.matchMedia === "function") && window.matchMedia("(max-width:599px)").matches;
  return phone ? "Pinch, double-tap, or − / + to zoom." : "Pinch or use − / + to zoom.";
}
$("undoBtn").onclick = ()=> doUndo();
$("closeBtn").onclick = ()=> confirmDiscard("close this PDF", closeFile);
$("zoomOut").onclick = ()=> applyZoom(-25);
$("zoomIn").onclick  = ()=> applyZoom(25);
// v11.24: tapping the % readout snaps straight back to fit-width (100%)
$("zoomLbl").onclick = ()=>{ if (workingBytes && zoomPct !== 100) setZoom(100); };
// v11.11 toolbar diet: the new core actions. Pages opens the thumbnail grid,
// Find opens search, Markup toggles a popover holding the three mode buttons
// (whose IDs and handlers are unchanged — tapping one also closes the popover).
$("pagesBtn").onclick  = ()=> openPagesGrid();
$("findBtn").onclick   = ()=> openFind();
// v11.17: single place to hide the Markup popover and re-sync its bar highlight
function hideMkMenu(){
  try {
    $("mkMenu").hidden = true;
    $("markupBtn").classList.toggle("on", !!mode);
  } catch(e){}
}
// v11.17: the bar item lights up while the popover is open OR a mode is active
$("markupBtn").onclick = ()=>{
  if (SEARCH.open) closeFind();        // v11.19: markup and search are exclusive
  const m = $("mkMenu"); m.hidden = !m.hidden;
  $("markupBtn").classList.toggle("on", !m.hidden || !!mode);
  if (!m.hidden){
    // v11.22: when no tool is active, hint the last-used tool as the preferred one
    ["textBtn","selectBtn","signBtn"].forEach(id=>$(id).classList.remove("pref"));
    if (!mode && lastMarkupMode){
      const id = lastMarkupMode==="text" ? "textBtn"
               : lastMarkupMode==="select" ? "selectBtn" : "signBtn";
      $(id).classList.add("pref");
    }
  }
};
$("mkMenu").addEventListener("click", (e)=>{ if (e.target.closest("button")) hideMkMenu(); });

// ---------------- immersive reading (v11.10) ----------------
// The header + toolbar float over the pages (translucent blur) and slide away
// while reading: scroll down or single-tap the page to hide them, scroll up,
// tap again, or return to the top to bring them back — Books/Preview style.
function setImmersive(on){
  if (on && (!workingBytes || mode || SEARCH.open)) on = false;
  if (on) hideMkMenu();                            // v11.11: popover follows the chrome
  document.body.classList.toggle("immersive", !!on);
}
let imLastY = 0, imAcc = 0, chromeTapT = 0;
$("viewer").addEventListener("scroll", ()=>{
  clearTimeout(chromeTapT);                        // a scroll is never a tap
  if (!workingBytes || mode || SEARCH.open) return;
  const y = $("viewer").scrollTop;
  const dy = y - imLastY; imLastY = y;
  if ((dy > 0) !== (imAcc > 0)) imAcc = 0;         // direction changed → restart
  imAcc += dy;
  if (y < 40){ setImmersive(false); imAcc = 0; }
  else if (imAcc > 28){ setImmersive(true);  imAcc = 0; }
  else if (imAcc < -28){ setImmersive(false); imAcc = 0; }
}, { passive:true });

// ---------------- pinch-to-zoom + double-tap (iOS-style) ----------------
// During the pinch the already-rendered pages are scaled instantly with a CSS
// transform (60fps, no engine work); when the fingers lift, the pages
// re-render sharp at the new zoom, anchored at the pinch centre.
(function wirePinch(){
  const v = $("viewer"), wrap = $("pageWrap");
  let pinch = null;            // { d0, k, cx, cy }
  let lastTap = 0, lastX = 0, lastY = 0;
  const dist = (t)=>Math.hypot(t[0].clientX-t[1].clientX, t[0].clientY-t[1].clientY);

  v.addEventListener("touchstart", (e)=>{
    // allow pinch-zoom in Edit (text) mode too, so you can zoom in to tap a small
    // field without leaving edit mode; only Sign mode (one-finger box drag) keeps
    // it off to avoid a stray signature box
    if (e.touches.length===2 && workingBytes && mode!=="sign"){
      e.preventDefault();
      // v11.06: a pinch that starts mid double-tap animation must not fight the
      // cosmetic transform (or inherit the .dtzoom transition, which would make
      // the live pinch rubber-band). Land the animation instantly first.
      if (dtFinish) dtFinish();
      const cx=(e.touches[0].clientX+e.touches[1].clientX)/2;
      const cy=(e.touches[0].clientY+e.touches[1].clientY)/2;
      const wr=wrap.getBoundingClientRect();
      wrap.style.transformOrigin = (cx-wr.left)+"px "+(cy-wr.top)+"px";
      wrap.classList.add("pinching");     // promote to a GPU layer ONLY now
      pinch = { d0:dist(e.touches), k:1, cx, cy };
    }
  }, { passive:false });

  v.addEventListener("touchmove", (e)=>{
    if (!pinch || e.touches.length!==2) return;
    e.preventDefault();
    let k = dist(e.touches)/pinch.d0;
    k = Math.max(50/zoomPct, Math.min(300/zoomPct, k));     // clamp to 50–300%
    pinch.k = k;
    wrap.style.transform = "scale("+k+")";
    // v11.06: show the value setZoom will actually land on (multiples of 5),
    // so the label doesn't tick to a different number when the fingers lift
    $("zoomLbl").textContent = Math.max(50, Math.min(300, Math.round(zoomPct*k/5)*5))+"%";
  }, { passive:false });

  const endPinch = (e)=>{
    if (!pinch) return;
    if (e.touches && e.touches.length>=2) return;            // still pinching
    const { k, cx, cy } = pinch;
    pinch = null;
    wrap.style.transform = "";
    wrap.classList.remove("pinching");
    if (Math.abs(k-1) < 0.02){ $("zoomLbl").textContent = zoomPct+"%"; return; }
    setZoom(zoomPct*k, cx, cy);
  };
  v.addEventListener("touchend", endPinch);
  v.addEventListener("touchcancel", endPinch);

  // double-tap: toggle 100% <-> 150%, centred on the tap (v11.01: was 200%).
  // setZoom anchors on the tap point and clamps scroll, so the same page stays
  // in view — double-tap never jumps to the first/previous page.
  //
  // v11.02: smooth, iOS-Preview-style transition. Instead of an instant
  // re-render we reuse the pinch GPU-layer trick — animate a CSS transform
  // scale on pageWrap around the tap point, then render sharp at the end.
  // Because both the transform-origin and the setZoom anchor sit on the tap
  // point, the tapped content stays visually fixed through the whole
  // animation and the re-render, so the handoff is seamless.
  const reduceMotion = (typeof window.matchMedia === "function") &&
                       window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let dtAnimating = false;
  let dtFinish = null;         // v11.06: lets a new gesture land the animation instantly

  // v11.04: render-truth-first, animate-second. The earlier version animated the
  // old bitmap and THEN re-rendered + repositioned, so the re-render was a visible
  // "second stage" and any tiny anchor error showed as a page jump. Now we do the
  // real zoom first (sharp, page-accurate scroll via setZoom), so the final state
  // is already correct. Then we play a purely cosmetic transform that starts at
  // the OLD size (scaled around the tap) and animates to identity — i.e. to the
  // already-correct render. Because the animation ENDS at the real pixels, there
  // is no handoff jump, and because setZoom set the page, it can't drift a page.
  async function smoothDoubleZoom(targetPct, tx, ty){
    if (dtAnimating || zooming) return;
    const from = zoomPct;
    if (from === targetPct) return;
    dtAnimating = true;
    await setZoom(targetPct, tx, ty);           // 1) real zoom: sharp + correct page
    if (reduceMotion || from === zoomPct){ dtAnimating = false; return; }

    // 2) cosmetic scale: begin at the old apparent size, centred on the tap,
    //    then animate back to identity (the true, already-rendered new size)
    const inv = from / zoomPct;                 // <1 when zooming in, >1 when out
    const wr = wrap.getBoundingClientRect();
    wrap.style.transformOrigin = (tx-wr.left)+"px "+(ty-wr.top)+"px";
    wrap.classList.add("pinching");             // GPU layer (no transition yet)
    wrap.style.transform = "scale("+inv+")";    // instant: looks like the old zoom
    void wrap.offsetWidth;                       // commit the start frame
    wrap.classList.add("dtzoom");               // enable the CSS transition
    requestAnimationFrame(()=>{ wrap.style.transform = ""; });  // animate -> identity

    let done = false;
    const finish = ()=>{
      if (done) return; done = true;
      wrap.removeEventListener("transitionend", finish);
      clearTimeout(fallback);
      wrap.classList.remove("pinching", "dtzoom");
      wrap.style.transform = "";
      wrap.style.transformOrigin = "";
      dtAnimating = false;
      dtFinish = null;
    };
    dtFinish = finish;
    wrap.addEventListener("transitionend", finish);
    const fallback = setTimeout(finish, 420);   // guard if transitionend never fires
  }

  // v11.10: remember where a single touch started, so a drag that happens to
  // end without momentum isn't mistaken for a tap (chrome toggle) below
  let t0x = 0, t0y = 0;
  v.addEventListener("touchstart", (e)=>{
    if (e.touches.length===1){ t0x = e.touches[0].clientX; t0y = e.touches[0].clientY; }
  }, { passive:true });

  // NOTE (deliberate): double-tap zoom and the single-tap chrome toggle are
  // DISABLED while a mode (Edit/Select/Sign) is active — taps there place
  // text boxes, select spans, or drop signatures, so they must never zoom.
  // Pinch-zoom still works in Edit/Select. Not a bug.
  v.addEventListener("touchend", (e)=>{
    if (pinch || mode || !workingBytes) return;
    if (e.touches.length || e.changedTouches.length!==1) return;
    const t = e.changedTouches[0], now = Date.now();
    if (now-lastTap < 300 && Math.hypot(t.clientX-lastX, t.clientY-lastY) < 30){
      lastTap = 0;
      clearTimeout(chromeTapT);          // second tap of a double-tap: zoom, not chrome
      e.preventDefault();
      // v11.06: Preview-style direction — zoom IN unless already meaningfully
      // zoomed (a light pinch to 110% then double-tap should go closer, not out)
      smoothDoubleZoom(zoomPct < 125 ? 150 : 100, t.clientX, t.clientY);
    } else {
      lastTap = now; lastX = t.clientX; lastY = t.clientY;
      // v11.10: a stationary single tap (no second tap within the double-tap
      // window) toggles the chrome, Books/Preview style
      clearTimeout(chromeTapT);
      if (Math.hypot(t.clientX-t0x, t.clientY-t0y) < 12){
        chromeTapT = setTimeout(()=>{
          // v11.21: a long-press that selected text ends in a touchend too —
          // never treat that as a chrome toggle
          try { const s = window.getSelection(); if (s && String(s).length) return; } catch(err){}
          setImmersive(!document.body.classList.contains("immersive"));
        }, 330);
      }
    }
  });
})();

// ---------------- open (with password support) ----------------
$("openBtn").onclick = ()=> confirmDiscard("open another PDF", ()=>$("fileInput").click());
// v10.98: warn before loading a file likely to breach WKWebView's memory limit
// — previously a 300MB pick stalled with no explanation and iOS could kill the
// app mid-open. The user can still proceed knowingly.
const OPEN_WARN_BYTES = 150*1024*1024;
$("fileInput").onchange = async e=>{
  const f=e.target.files[0]; e.target.value="";
  if(!f) return;
  if (f.size > OPEN_WARN_BYTES){
    $("sheet").innerHTML = h`
      <h3>Very large file</h3>
      <p class="hint">“${f.name}” is ${fmtKB(f.size)}. Files this large can exceed this device's memory, and iOS may close the app while it opens. Continue?</p>
      <div class="row"><button class="full" id="lgGo">Open anyway</button></div>
      <div class="row"><button class="ghost full" id="lgNo">Cancel</button></div>`;
    $("lgGo").onclick = ()=>{ closeSheet(); openPickedFile(f); };
    $("lgNo").onclick = ()=>{ closeSheet(); setStatus("Open cancelled.","warn"); };
    openSheet();
    return;
  }
  openPickedFile(f);
};
async function openPickedFile(f){
  showSpin(true,"Opening "+f.name+" …"); setStatus("Opening "+f.name+" …");
  try { await openBytes(new Uint8Array(await f.arrayBuffer()), f.name); }
  catch(err){ setStatus("Could not open: "+friendly(err),"err"); }
  showSpin(false);
}

async function openBytes(bytes, name){
  let wasEncrypted = false, ownerOnly = false;
  // probe for encryption first
  let probe = mupdf.Document.openDocument(bytes.slice(0), "application/pdf");
  // mupdf can open other formats (e.g. HTML) through their own handlers —
  // asPDF() returns null for those. Reject before touching the open document.
  if (!probe.needsPassword()){
    const pdfp = probe.asPDF();
    if (!pdfp){
      probe.destroy();
      throw new Error("not a PDF file");
    }
    if (probe.countPages() === 0){
      probe.destroy();
      throw new Error("no pages found in this file");
    }
    // Some PDFs (bank/telco invoices, e.g. amaysim) are encrypted with an EMPTY
    // user password plus owner-only permission locks (copy/edit disabled). mupdf
    // opens them with no prompt, but the document is still encrypted: an in-place
    // edit then re-saves a broken encrypted copy whose pages collapse, surfacing
    // as "invalid page number" and a "0 pages" header. Decrypt the working copy
    // up front — exactly what the Unlock action does — so editing and rendering
    // behave normally. Empty-password decryption asks nothing of the user; it
    // only strips an owner lock that mupdf is already permitted to ignore.
    const enc = probe.getMetaData("encryption");
    if (enc && enc !== "None"){
      showSpin(true, "Preparing a secured PDF…");
      bytes = new Uint8Array(pdfp.saveToBuffer("decrypt,garbage").asUint8Array());
      wasEncrypted = true;
      ownerOnly = true;    // v11.45: no password was needed — restrictions only
    }
  }
  if (probe.needsPassword()){
    wasEncrypted = true;
    probe.destroy();
    // Ask for the password with inline retry (up to 3 tries). The validator
    // authenticates a fresh document each attempt and keeps the one that works.
    let authed = null;
    const res = await askPassword(name, (pw)=>{
      const d = mupdf.Document.openDocument(bytes.slice(0), "application/pdf");
      if (d.authenticatePassword(pw)){ authed = d; return true; }
      d.destroy(); return false;
    });
    if (res !== true){
      if (authed){ try{ authed.destroy(); }catch(e){} }
      showSpin(false);
      setStatus(res === null
        ? "Open cancelled — file is password protected."
        : "Could not unlock — too many wrong passwords.","warn");
      return;
    }
    showSpin(true,"Unlocking…");
    // re-save WITHOUT encryption so the working copy is freely editable/saveable
    const clean = authed.asPDF().saveToBuffer("decrypt,garbage").asUint8Array();
    authed.destroy();
    bytes = new Uint8Array(clean);
    name = baseFrom(name)+"_unlocked.pdf";
    setStatus("Unlocked.","ok");
  } else { probe.destroy(); }

  undoStack = [];
  nameSuggestShown = false;      // v11.64: one naming offer per document
  workingBytes = bytes;
  if (name) fileName = name;
  docSensitive = wasEncrypted;     // decrypted copies are never persisted
  setDirty(false);                 // freshly opened = nothing to lose yet
  reopen();
  setMode(null);
  // v11.24: adopt the remembered zoom BEFORE the first render. It used to
  // render every page at 100% and then restoreViewState re-rendered the whole
  // document at the saved zoom — two full builds on every reopen.
  try {
    const views = await idbGet("views");
    const st = views && views[fileName];
    // saved zoom for this document, else a clean 100% (a doc opened straight
    // after zooming another no longer inherits the previous doc's zoom)
    zoomPct = (st && st.zoom && st.zoom >= 50 && st.zoom <= 300)
            ? Math.round(st.zoom/5)*5 : 100;
    $("zoomLbl").textContent = zoomPct + "%";
  } catch(e){}
  await render();
  enableDocButtons(true);
  recentsRemember();               // welcome screen shows it next launch
  await restoreViewState();        // v10.91: back to where you left off
  // v10.90: level with the user on very large documents — some safeguards
  // (shorter undo history, lighter rendering) kick in to keep iOS from
  // killing the app for memory.
  if (workingBytes.length > 24*1024*1024 || MDOC.countPages() > 150)
    setStatus("Opened "+fileName+" — large document, so undo history is shortened and rendering is lightened to keep things smooth.","ok");
  else if (ownerOnly)
    // v11.45: say what actually happened. These files (bank/telco invoices are
    // the classic case) open without a password but carry owner-set locks on
    // editing/printing/copying. The working copy has had those removed; Save
    // writes the unrestricted copy.
    setStatus("Opened "+fileName+" — it had editing/printing restrictions (no password), and this working copy has them removed. Tap Save to keep an unrestricted copy.","ok");
  else
  setStatus("Opened "+fileName+". "+zoomTip(),"ok");
  maybeLiveTextHint();
}
// Live Text hint (iOS 16+): scanned/image PDFs have no text layer, so the
// app's own Select mode has nothing to grab — but the OS can. Pages render as
// real <img> and the CSS enables the callout in view mode, so touch-and-hold
// gives Vision-powered select / copy / translate, same engine as Preview and
// Photos. Mention it once, and only for documents that actually need it.
function maybeLiveTextHint(){
  try {
    if (docHasText()) return;                      // has a text layer — Select mode works
    if (localStorage.getItem("ltHinted")) return;  // said it once already
    localStorage.setItem("ltHinted", "1");
    setTimeout(()=> setStatus("Tip: this looks like a scanned PDF — touch and hold text on the page to select or copy it (Live Text).", "ok"), 2500);
  } catch(e){}
}
function baseFrom(n){ return (n||"document.pdf").replace(/\.[^.]+$/,""); }

// Password sheet with inline retry. `tryPassword(pw)` must return truthy when
// the password is correct. On a wrong password the sheet STAYS OPEN, shows an
// inline error, and lets the user try again — up to `maxTries` attempts, after
// which it gives up. Resolves: true on success, false when attempts run out,
// null when the user cancels (Cancel button / backdrop / Esc).
function askPassword(name, tryPassword, maxTries=3){
  return new Promise(resolve=>{
    $("sheet").innerHTML = h`
      <h3>Password required</h3>
      <p class="hint" id="pwHint">“${name||"This PDF"}” is protected. Enter its password to unlock it.</p>
      <div class="row"><input type="password" id="pwIn" placeholder="Password" autocomplete="off"></div>
      <div class="row"><button class="full" id="pwOk">Unlock</button></div>
      <div class="row"><button class="ghost full" id="pwCancel">Cancel</button></div>`;
    let settled=false, tries=0;
    const done=v=>{ if(settled) return; settled=true; sheetOnDismiss=null; closeSheet(); resolve(v); };
    const attempt=()=>{
      if (settled) return;
      let ok=false;
      try { ok = !!tryPassword($("pwIn").value || ""); } catch(e){ ok=false; }
      if (ok){ done(true); return; }
      tries++;
      const left = maxTries - tries;
      if (left <= 0){ done(false); return; }     // out of attempts
      const hint=$("pwHint");
      if (hint){
        hint.textContent = "Wrong password — "+left+" "+(left===1?"try":"tries")+" left. Please try again.";
        hint.classList.add("pwerr");
      }
      const inp=$("pwIn"); if(inp){ inp.value=""; inp.focus(); }
    };
    $("pwOk").onclick = attempt;
    $("pwIn").addEventListener("keydown", e=>{ if(e.key==="Enter"){ e.preventDefault(); attempt(); } });
    $("pwCancel").onclick = ()=> done(null);
    openSheet();
    sheetOnDismiss = ()=> done(null);   // backdrop / Esc dismiss = cancel, never hang the flow
    setTimeout(()=>{ const i=$("pwIn"); if(i) i.focus(); }, 100);
  });
}

// ---------------- Unlock PDF (remove password, lossless) ----------------
// Standalone utility: pick a password-protected PDF, supply its password, and
// save a copy with the encryption removed. Uses mupdf's "decrypt" save, which
// rewrites the file WITHOUT re-compressing any image or content stream, so the
// output keeps the original's quality and (within a few bytes) its size. It
// does NOT touch or replace whatever is currently open in the editor.
async function unlockPdfFile(f){
  showSpin(true, "Opening "+f.name+" …");
  try {
    const bytes = new Uint8Array(await f.arrayBuffer());
    // probe first: is it a PDF, and is it actually password-protected?
    const probe = mupdf.Document.openDocument(bytes.slice(0), "application/pdf");
    const isProtected = probe.needsPassword();
    const isPdf = isProtected || !!probe.asPDF();
    // v11.45: a file can be locked WITHOUT a password — encrypted with an
    // owner password only, so it opens fine but forbids editing, printing or
    // copying. Acrobat charges for removing exactly this. needsPassword() is
    // false for these, so check the encryption metadata too.
    const ownerLocked = !isProtected && isPdf &&
      (()=>{ try { const e = probe.getMetaData("encryption"); return !!e && e !== "None"; } catch(_){ return false; } })();
    probe.destroy();
    if (!isPdf){ showSpin(false); setStatus("That file isn’t a PDF, so it can’t be unlocked.","err"); return; }
    if (!isProtected && !ownerLocked){ showSpin(false); setStatus("“"+f.name+"” has no password and no restrictions — there’s nothing to remove.","warn"); return; }
    if (ownerLocked){
      // No password to ask for: decrypt losslessly and open the clean copy.
      const d = mupdf.Document.openDocument(bytes.slice(0), "application/pdf").asPDF();
      const clean = new Uint8Array(d.saveToBuffer("decrypt,garbage").asUint8Array());
      d.destroy();
      const prev2 = workingBytes;
      await openBytes(clean, baseFrom(f.name)+"_unlocked.pdf");
      if (workingBytes && workingBytes !== prev2){
        setDirty(true);
        setStatus("Restrictions removed — “"+f.name+"” had editing/printing locks but no password. Tap Save to keep the unrestricted copy at the original quality.","ok");
      }
      showSpin(false);
      return;
    }
    // Protected → use the normal open path: it asks for the password (with up to
    // 3 inline retries), decrypts LOSSLESSLY (no image re-compression, original
    // quality & size), and renders the result into the viewer. We then mark it
    // unsaved so Save writes the unlocked copy and any other action first warns
    // with the usual discard prompt.
    const prev = workingBytes;
    await openBytes(bytes, f.name);
    if (workingBytes && workingBytes !== prev){
      setDirty(true);
      setStatus("Password removed — “"+fileName+"” is open at the original quality. Tap Save to keep it.","ok");
    }
  } catch(err){
    setStatus("Could not unlock that PDF: "+friendly(err),"err");
  }
  showSpin(false);
}
$("unlockInput").onchange = e=>{ const f=e.target.files[0]; e.target.value=""; if(f) unlockPdfFile(f); };

// ---------------- render (mupdf -> JPEG -> <img>) ----------------
function viewerCssWidth(){
  // v11.23: read the REAL side padding instead of assuming 8px total. The
  // v11.22 large-phone media query widened the gutters, so the hardcoded 8
  // made 100% pages 12px wider than the pane — the document slid sideways on
  // every touch. Computed style keeps this correct for any future padding.
  const v = $("viewer");
  let gutters = 8;
  try {
    const cs = getComputedStyle(v);
    gutters = (parseFloat(cs.paddingLeft)||4) + (parseFloat(cs.paddingRight)||4);
  } catch(e){}
  const avail = v.clientWidth - gutters;
  return Math.max(280, Math.min(1100, avail)) * (zoomPct/100);
}
// Render at the TRUE device pixel ratio (modern iPhones are 3×). The old cap
// of 2 rendered pages at two-thirds of native resolution and upscaled them —
// the main reason text looked softer than Acrobat. Lazy rendering +
// content-visibility keep the extra pixels affordable: only visible pages are
// ever rasterised.
const DPR = Math.min(window.devicePixelRatio || 1, 3);
// Cap a rendered page bitmap so high zoom on a large page can't allocate a
// huge canvas. Raised with the DPR so zoomed-in text stays sharp. 5000 gives
// noticeably crisper deep zoom than the old 3500 while staying within memory.
const MAX_RENDER_PX = 5000;

// Build (or rebuild) the single lazy-render observer and watch every page that
// hasn't been rasterised yet. Reusing one observer avoids leaking observers on
// each re-render and lets us cleanly disconnect it when the app is hidden.
// Rasterisation window: pages near the viewport are rendered; pages that
// scroll far away are RELEASED back to lightweight placeholders. Memory stays
// flat (~a dozen live bitmaps) no matter how long the document is — the fix
// for 500-page scanned books crashing the tab.
function observeStages(){
  const v = $("viewer");
  if (pageObserver) pageObserver.disconnect();
  pageObserver = new IntersectionObserver((entries)=>{
    for (const en of entries){
      const stage = en.target;
      if (en.isIntersecting){
        if (!stage.dataset.rendered){
          stage.dataset.rendered = "1";
          renderStage(stage, +stage.dataset.page);
        }
      } else if (stage.dataset.rendered){
        derasterStage(stage);
      }
    }
  }, { root: v, rootMargin: "1500px 0px" });
  v.querySelectorAll(".stage").forEach(s=>pageObserver.observe(s));
}
// release a far-away page's bitmap, keeping its exact footprint in the layout
function derasterStage(stage){
  const img = stage.querySelector("img");
  if (!img) return;
  const holder = document.createElement("div");
  holder.className = "holder";
  holder.style.width  = parseFloat(stage.style.width)+"px";
  holder.style.height = (stage.dataset.dh||0)+"px";
  img.replaceWith(holder);
  delete stage.dataset.rendered;
}

// page sizes are asked from the engine once per document version, not on
// every zoom — zooming a 500-page book no longer makes 500 engine calls
let boundsCache = null, boundsEpoch = -1;
let renderToken = 0;             // cancels a stale in-flight chunked build
async function render(){
  const tok = ++renderToken;
  const v = $("viewer");
  const wrap = $("pageWrap");
  if (!workingBytes || !MDOC){
    wrap.querySelectorAll(".stage").forEach(s=>s.remove());
    revokeURLs();
    $("emptyMsg").style.display="block";
    return;
  }
  $("emptyMsg").style.display="none";
  const n = MDOC.countPages();
  const cssW = viewerCssWidth();
  const existing = wrap.querySelectorAll(".stage");

  // FAST PATH — same document (page sizes already cached, stage count matches):
  // a zoom or width change. Resize the existing page nodes in place instead of
  // tearing down and rebuilding all of them (O(n) DOM work on long books). The
  // lazy-render observer then re-rasterises the visible pages at the new scale.
  // Editing bumps `epoch`, so this never runs after a content change.
  if (existing.length === n && boundsEpoch === epoch && boundsCache && boundsCache.length === n){
    revokeURLs();
    existing.forEach((stage,i)=>{
      const b = boundsCache[i];
      const dispW = Math.round(cssW), dispH = Math.round(cssW * (b.h/b.w));
      stage.style.width = dispW+"px";
      stage.style.containIntrinsicSize = dispW+"px "+dispH+"px";
      stage.dataset.dh = dispH;
      // v11.22: keep the existing bitmap on screen, just resized (momentarily
      // soft), instead of swapping in a blank white holder. The lazy observer
      // re-rasterises it sharp at the same size, so a zoom never flashes white
      // and the page's height never changes under the scroll position.
      let cur = stage.querySelector("img") || stage.querySelector(".holder");
      if (cur && cur.tagName === "IMG" && !cur.complete){
        // its blob URL was just revoked mid-load — fall back to a clean holder
        const holder = document.createElement("div");
        holder.className = "holder";
        cur.replaceWith(holder); cur = holder;
      }
      if (cur){ cur.style.width = dispW+"px"; cur.style.height = dispH+"px"; }
      delete stage.dataset.rendered;
      stage.querySelectorAll(".span").forEach(s=>s.remove());
      const tx = stage.querySelector(".txt"); if (tx) tx.textContent = "";
      const hl = stage.querySelector(".hl"); if (hl) hl.textContent = "";
    });
    lastViewerW = v.clientWidth;
    observeStages();
    return;
  }

  // SLOW PATH — first render, or after an edit / page-count change.
  existing.forEach(s=>s.remove());
  revokeURLs();
  showSpin(true,"Preparing the pages…");
  try {
    lastViewerW = v.clientWidth;
    const bc = (boundsEpoch === epoch && boundsCache && boundsCache.length === n)
             ? boundsCache : new Array(n);

    for (let i=0;i<n;i++){
      // long documents: yield every 80 pages so the UI never freezes
      if (i && i % 80 === 0 && n > 80){
        showSpin(true, "Preparing page "+i+" of "+n+"…");
        await new Promise(r=>setTimeout(r,0));
        if (tok !== renderToken) return;           // superseded by a newer render
      }
      let b = bc[i];
      if (!b){
        const page = MDOC.loadPage(i);
        const [x0,y0,x1,y1] = page.getBounds();
        page.destroy();
        b = bc[i] = { w:x1-x0, h:y1-y0 };
      }
      const wPt = b.w, hPt = b.h;
      const dispW = Math.round(cssW), dispH = Math.round(cssW * (hPt/wPt));
      const stage = document.createElement("div");
      stage.className = "stage" + (mode ? " placing" : "");
      stage.dataset.page = i;
      stage.dataset.wpt = wPt; stage.dataset.hpt = hPt;
      stage.dataset.dh = dispH;
      stage.style.width = dispW+"px";
      // tell the browser each page's size up-front so content-visibility:auto
      // can skip painting offscreen pages without the layout jumping
      stage.style.containIntrinsicSize = dispW+"px "+dispH+"px";
      // built via DOM + CSSOM (no style attributes) so style-src can be 'self'
      stage.innerHTML = h`<span class="plabel">Page ${i+1}</span><div class="holder"></div><div class="hl"></div><div class="ovl"></div><div class="txt"></div>`;
      const holder = stage.querySelector(".holder");
      holder.style.width = dispW+"px"; holder.style.height = dispH+"px";
      attachOverlay(stage, i);
      wrap.appendChild(stage);
    }
    boundsCache = bc; boundsEpoch = epoch;
    if (tok !== renderToken) return;
    observeStages();
    setMeta(fileName, fmtKB(workingBytes.length));
  } catch(e){ setStatus("Could not show this PDF: "+friendly(e), "err"); }
  if (tok === renderToken) showSpin(false);
}

async function renderStage(stage, i){
  try {
    const cssW = parseFloat(stage.style.width);
    const page = MDOC.loadPage(i);
    const [x0,y0,x1,y1] = page.getBounds();
    const wPt = x1-x0, hPt = y1-y0;
    // adaptive sharpness: very long documents (scanned books) render at 2×
    // instead of 3× — indistinguishable while reading, half the work/memory
    const bigDoc = MDOC.countPages() > 150;
    let scale = (cssW / wPt) * (bigDoc ? Math.min(DPR,2) : DPR);
    const maxPx = bigDoc ? 2600 : MAX_RENDER_PX;
    // clamp so neither dimension blows past the pixel cap (battery / memory)
    const cap = maxPx / Math.max(wPt*scale, hPt*scale);
    if (cap < 1) scale *= cap;
    const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false);
    // Quality: lossless PNG for normal docs gives Preview/Acrobat-like text edges
    // with no JPEG ringing on thin glyphs and hairlines. At deep zoom the bitmap
    // gets large, where PNG encode time and size balloon, so past ~2800px (and
    // for very long documents) fall back to fast JPEG q94 to keep zoom snappy.
    const rasterMax = Math.max(wPt*scale, hPt*scale);
    // v10.94: lossless PNG only pays off on born-digital TEXT pages (crisp
    // glyph edges). On scanned/image-only documents PNG is 3–5× larger and
    // slower to encode/decode than JPEG q94 with no visible gain, so those
    // take the JPEG path. Text presence is sampled once per document version.
    // v11.50: ...and NOT when the only text is our own OCR layer. Those pages
    // are photographs with invisible words over them: PNG would triple the
    // size and the encode time for a bitmap that has no crisp glyph edges to
    // preserve.
    const usePng = !bigDoc && rasterMax <= 2800 && docHasText() && !docIsOcr();
    const bin = usePng ? u8(pix.asPNG()) : u8(pix.asJPEG(94));
    pix.destroy(); page.destroy();
    const url = URL.createObjectURL(new Blob([bin], {type: usePng ? "image/png" : "image/jpeg"}));
    liveURLs.add(url);
    const img = document.createElement("img");
    img.decoding = "async";
    img.onload = ()=> setTimeout(()=>{ URL.revokeObjectURL(url); liveURLs.delete(url); }, 1000);
    img.src = url;
    // v11.22 (root cause of the double-tap page jump): decode BEFORE inserting,
    // and give the img the page's exact CSS size. Previously an unsized img
    // replaced the sized holder while still decoding, so the page collapsed to
    // 0px for a few frames, pulling the scroll position up towards page 1 right
    // after setZoom had positioned it correctly. Sizing + decode-first means a
    // page's height never changes during a swap, so zoom can't drift pages.
    try { await img.decode(); } catch(e){}
    // size from the stage's CURRENT dimensions (a zoom may have landed while
    // the bitmap was decoding), so the swap is always footprint-neutral
    img.style.width  = parseFloat(stage.style.width)+"px";
    img.style.height = (stage.dataset.dh||0)+"px";
    const cur = stage.querySelector(".holder") || stage.querySelector("img");
    if (cur && cur.isConnected && cur !== img) cur.replaceWith(img);
    delete stage.dataset.rtry;               // rendered fine — reset retry count
    if (mode === "text") await buildSpanBoxes(stage, i);
    else if (mode === "select"){
      // v11.60: mark the stage in select mode too. The rule that stops iOS
      // treating the page as a picture ("Copy" on the whole image) is keyed on
      // .hastext, and select mode never set it — so on a page whose text came
      // from recognition the image callout could still win the touch.
      buildTextLayer(stage, i);
      if (stage.querySelector(".txt") && stage.querySelector(".txt").childElementCount)
        stage.classList.add("hastext");
    }
    else if (mode === "form") buildFormBoxes(stage, i).catch(()=>{});
    // v11.21: born-digital documents get a selectable text layer in VIEW mode
    // too, so touch-and-hold selects real text (with the iOS Copy menu) instead
    // of offering to save the page as an image. Scans keep the image callout —
    // that's the Live Text path (Show Text / Look Up).
    else if (docHasText()){
      try { buildTextLayer(stage, i); stage.classList.add("hastext"); } catch(e){}
    }
    if (SEARCH.open) paintPageHighlights(stage, i);
  } catch(e){
    // v10.98: a failed rasterisation is no longer a permanently blank page.
    // The first failure retries once automatically (transient memory pressure
    // is the usual cause); after that the placeholder becomes a tappable
    // "retry", so the user is never stuck with white space and no way out.
    delete stage.dataset.rendered;
    const tries = (+stage.dataset.rtry || 0) + 1;
    stage.dataset.rtry = tries;
    const holder = stage.querySelector(".holder");
    if (tries <= 1){
      setTimeout(()=>{
        if (stage.isConnected && !stage.dataset.rendered && MDOC){
          stage.dataset.rendered = "1";
          renderStage(stage, i);
        }
      }, 800);
    } else if (holder){
      holder.classList.add("failed");
      holder.textContent = "Couldn't show this page — tap to retry";
      holder.onclick = ()=>{
        holder.classList.remove("failed");
        holder.textContent = "";
        holder.onclick = null;
        stage.dataset.rtry = 0;
        if (MDOC){ stage.dataset.rendered = "1"; renderStage(stage, i); }
      };
    }
  }
}

function revokeURLs(){ for (const u of liveURLs){ try{ URL.revokeObjectURL(u); }catch(e){} } liveURLs.clear(); }

// ---------------- structured-text spans (for in-place editing) ----------------
function getSpans(pageIndex){
  const key = epoch+":"+pageIndex;
  if (spanCache.has(key)) return spanCache.get(key);
  const page = MDOC.loadPage(pageIndex);
  const st = page.toStructuredText("preserve-spans");
  const spans = []; let cur = null;
  st.walk({
    beginLine(){ cur = { text:"", x0:1e9,y0:1e9,x1:-1e9,y1:-1e9, origin:null, font:"", size:11, color:[0,0,0] }; },
    onChar(c, origin, font, size, quad, argb){
      cur.text += c;
      if (!cur.origin){
        cur.origin = [origin[0], origin[1]];
        cur.font = (font && font.getName) ? font.getName() : "";
        cur.size = size || 11;
        if (argb && argb.length>=3) cur.color = [argb[0],argb[1],argb[2]];
      }
      const pts = [[quad[0],quad[1]],[quad[2],quad[3]],[quad[4],quad[5]],[quad[6],quad[7]]];
      for (const p of pts){ cur.x0=Math.min(cur.x0,p[0]); cur.y0=Math.min(cur.y0,p[1]);
                            cur.x1=Math.max(cur.x1,p[0]); cur.y1=Math.max(cur.y1,p[1]); }
    },
    endLine(){ if (cur && cur.text.trim()!=="") spans.push(cur); cur=null; }
  });
  st.destroy(); page.destroy();
  spanCache.set(key, spans);
  return spans;
}

async function buildSpanBoxes(stage, pageIndex){
  // Guard against a malformed PDF whose page tree over-reports its length: a
  // stale/out-of-range index makes mupdf's loadPage throw "invalid page
  // number", which (when this runs un-awaited from setMode) surfaced as an
  // uncaught "Async error" banner. Bail quietly instead — that page just won't
  // get editable text boxes.
  if (!MDOC || !Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= MDOC.countPages()) return;
  stage.querySelectorAll(".span").forEach(s=>s.remove());
  const ovl = stage.querySelector(".ovl");
  const wPt = +stage.dataset.wpt;
  const dispW = parseFloat(stage.style.width);
  const s = dispW / wPt;                         // points -> css px
  const spans = getSpans(pageIndex);
  spans.forEach((sp, idx)=>{
    const b = document.createElement("div");
    b.className = "span";
    // keyboard + VoiceOver reachable: each span is a real button you can Tab to
    // and activate with Enter/Space (the CSS already styles .span:focus-visible)
    b.tabIndex = 0;
    b.setAttribute("role", "button");
    const lbl = sp.text.length > 40 ? sp.text.slice(0,40)+"…" : sp.text;
    b.setAttribute("aria-label", "Edit text: "+lbl);
    b.style.left   = (sp.x0*s)+"px";
    b.style.top    = (sp.y0*s)+"px";
    b.style.width  = ((sp.x1-sp.x0)*s)+"px";
    b.style.height = ((sp.y1-sp.y0)*s)+"px";
    b.onclick = (ev)=>{ ev.stopPropagation(); openTextEditor(pageIndex, idx); };
    b.onkeydown = (ev)=>{ if (ev.key==="Enter" || ev.key===" "){ ev.preventDefault(); ev.stopPropagation(); openTextEditor(pageIndex, idx); } };
    ovl.appendChild(b);
  });
}

// ---------------- selectable text layer (for copying text out of the PDF) ----------------
// Lays an invisible, real-text overlay over the rendered page image so the
// native browser/iOS selection + Copy works — exactly the PDF.js text-layer
// technique. Reuses the same structured-text spans the editor uses, so no new
// engine work. Only built while the viewer is in "select" mode; in every other
// mode the layer is empty and pointer-events:none, so scrolling, editing and
// signing are untouched.
function buildTextLayer(stage, pageIndex){
  if (!MDOC || !Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= MDOC.countPages()) return;
  const txt = stage.querySelector(".txt");
  if (!txt) return;
  txt.textContent = "";
  let spans;
  try { spans = getSpans(pageIndex); } catch(e){ return; }
  const wPt = +stage.dataset.wpt;
  const dispW = parseFloat(stage.style.width);
  if (!wPt || !dispW) return;
  const s = dispW / wPt;                          // points -> css px
  const els = [];
  for (const sp of spans){
    if (!sp.text || !sp.text.trim()) continue;
    // v11.60: skip spans with no usable box. Measured on a real OCRed scan,
    // 48 of 189 lines came back with zero width, zero height or zero size —
    // recognition artefacts and stray marks. Each became a zero-sized element
    // sitting in the middle of the selection order, which is enough to break
    // the run iOS walks when you drag a selection across the page.
    if (!isFinite(sp.x0) || !isFinite(sp.y0) || !isFinite(sp.x1) || !isFinite(sp.y1)) continue;
    if (!(sp.x1 - sp.x0 > 0.2) || !(sp.y1 - sp.y0 > 0.2)) continue;
    const el = document.createElement("span");
    el.className = "tline";
    el.textContent = sp.text;
    // Precise vertical fit. The text quad spans the full em (ascender→descender),
    // so sizing the highlight to the quad makes a line of caps/digits — invoice
    // number, dates, names — look ~40% too tall. Instead clamp each box to the
    // visible band: from the quad top (≈ cap/ascender top) down to a little below
    // the baseline, so the highlight hugs the glyphs. fontSize stays the real
    // glyph size; the box height drives the selection rectangle.
    const fs   = Math.max(4, (sp.size || (sp.y1 - sp.y0)) * s);
    const topPx  = sp.y0 * s;                       // quad top (just above caps)
    const basePx = (sp.origin ? sp.origin[1] : sp.y1) * s;  // text baseline
    // band: cap-top → baseline + small descender allowance (~14% of the glyph)
    const bandH = Math.max(fs * 0.5, (basePx - topPx) + fs * 0.16);
    el.style.left   = (sp.x0 * s) + "px";
    el.style.top    = topPx + "px";
    el.style.fontSize  = fs + "px";
    el.style.height    = bandH + "px";
    el.style.lineHeight = bandH + "px";
    txt.appendChild(el);
    els.push({ el, w: (sp.x1 - sp.x0) * s });
  }
  // second pass: scale each line horizontally so the invisible glyphs line up
  // with the rasterised ones (measure-then-transform, batched to limit reflow)
  for (const it of els){
    const natural = it.el.offsetWidth;
    if (natural > 0 && it.w > 0){
      it.el.style.transform = "scaleX(" + (it.w / natural) + ")";
    }
  }
}

// ---------------- find in document (MuPDF page.search) ----------------
// Acrobat/iLovePDF-style find: case-insensitive substring, every match
// highlighted, a live count, and prev/next that selects the current match.
// Per the agreed design, visible pages are searched first (instant feedback)
// and the remaining pages are scanned lazily in the background, so the count
// climbs in while you keep reading. All matches are stored as point-space
// quads; the per-page .hl layer draws them scaled to the current zoom, so they
// stay aligned through pinch-zoom and width changes (renderStage re-paints).
const SEARCH = {
  open: false,
  needle: "",
  pages: new Map(),     // pageIndex -> [ { boxes:[[x0,y0,x1,y1],…] }, … ]
  order: [],            // flat nav list: [ {page, mi}, … ] sorted by page then mi
  activeKey: null,      // { page, mi } of the current match
  scanned: new Set(),   // pages already searched for the current needle
  token: 0,             // bumps on every new query → cancels stale background scans
  debounce: 0
};

// v11.19: when the keyboard opens for the find input, iOS scrolls the layout
// viewport up, shoving the fixed header + find bar off the top of the screen —
// you were typing into an invisible box. Pin the window to the top whenever
// the visual viewport changes while search is open.
(function pinChromeWhileFinding(){
  const pin = ()=>{ if (SEARCH.open) window.scrollTo(0,0); };
  if (typeof window.visualViewport !== "undefined" && window.visualViewport){
    window.visualViewport.addEventListener("resize", pin);
    window.visualViewport.addEventListener("scroll", pin);
  }
  window.addEventListener("scroll", pin);
  $("findInput").addEventListener("focus", ()=>{ setTimeout(()=>window.scrollTo(0,0), 60); });
})();
// v11.23: position the find bar EXACTLY below the real header instead of the
// old hardcoded 30px guess — on large phones the header ran taller than the
// guess and covered the bar's top edge, hiding the input's blue focus border.
// Measured via CSSOM (CSP-safe) on open and on every viewport resize.
function placeFindBar(){
  try {
    // offsetHeight, not getBoundingClientRect: the header slides via a CSS
    // transform (immersive mode), and gBCR mid-animation would place the bar
    // too high. The layout box is transform-immune; header is fixed at top:0,
    // so its bottom edge is exactly its offsetHeight.
    const hb = document.querySelector("header").offsetHeight;
    if (hb > 0) $("findbar").style.top = Math.round(hb) + "px";
  } catch(e){}
}
window.addEventListener("resize", ()=>{ if (SEARCH.open) placeFindBar(); });
function openFind(){
  if (!workingBytes || !MDOC){ setStatus("Open a PDF first, then search it.","warn"); return; }
  SEARCH.open = true;
  setImmersive(false);           // v11.10: search needs the chrome visible
  $("findBtn").classList.add("on");   // v11.14: bar shows Find is active
  placeFindBar();                // v11.23: sit flush under the measured header
  const bar = $("findbar"); bar.hidden = false;
  const inp = $("findInput");
  inp.focus(); inp.select();
  if (inp.value.trim()) runFind(inp.value);
  else updateFindCount();
}

function closeFind(){
  SEARCH.open = false;
  $("findBtn").classList.remove("on");   // v11.14
  SEARCH.token++;                     // cancel any in-flight background scan
  SEARCH.needle = "";
  SEARCH.pages.clear(); SEARCH.order = []; SEARCH.activeKey = null; SEARCH.scanned.clear();
  clearTimeout(SEARCH.debounce);
  $("findbar").hidden = true;
  // clear the box so reopening Find starts blank (same as iLovePDF / Acrobat)
  const inp = $("findInput"); if (inp) inp.value = "";
  const fc = $("findClear"); if (fc) fc.hidden = true;
  $("findCount").textContent = "";
  document.querySelectorAll(".stage .hl").forEach(hl=>{ hl.textContent = ""; });
  setStatus("");                 // v11.17: closing Find clears the toast — no "Ready." flash
}

// quads → point-space bounding boxes, grouped one entry per match (a match can
// wrap onto several lines, hence several boxes that navigate/scroll as a unit)
function searchPage(i, needle){
  const out = [];
  let page = null;
  try {
    page = MDOC.loadPage(i);
    const matches = page.search(needle) || [];
    for (const quads of matches){
      const boxes = [];
      for (const q of quads){
        const xs = [q[0],q[2],q[4],q[6]], ys = [q[1],q[3],q[5],q[7]];
        boxes.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
      }
      if (boxes.length) out.push({ boxes });
    }
  } catch(e){ /* unreadable page → no matches */ }
  finally { if (page) try{ page.destroy(); }catch(e){} }
  // MuPDF returns hits in its internal structured-text order, which isn't always
  // strictly top-to-bottom (a name block and an email field can come back out of
  // visual order). Sort by reading position — top edge, then left edge — so
  // "next/previous" follows the page and the FIRST match selected is the topmost
  // one, matching Acrobat / iLovePDF.
  out.sort((a,b)=>{
    const ay=a.boxes[0][1], by=b.boxes[0][1];
    if (Math.abs(ay-by) > 2) return ay-by;        // different lines → top first
    return a.boxes[0][0]-b.boxes[0][0];           // same line → left first
  });
  return out;
}

// rebuild the flat, page-ordered navigation list from whatever's scanned so far
function rebuildOrder(){
  const order = [];
  const pages = [...SEARCH.pages.keys()].sort((a,b)=>a-b);
  for (const p of pages){
    const arr = SEARCH.pages.get(p);
    for (let mi=0; mi<arr.length; mi++) order.push({ page:p, mi });
  }
  SEARCH.order = order;
}

function visiblePageIndexes(){
  const out = [];
  document.querySelectorAll(".stage").forEach(s=>{
    if (s.dataset.rendered) out.push(+s.dataset.page);
  });
  return out;
}

// debounced entry point from the input box
function scheduleFind(){
  clearTimeout(SEARCH.debounce);
  const v = $("findInput").value;
  SEARCH.debounce = setTimeout(()=>runFind(v), 160);
}

async function runFind(rawNeedle){
  const needle = (rawNeedle||"").trim();
  const tok = ++SEARCH.token;          // invalidate previous query's background scan
  SEARCH.needle = needle;
  SEARCH.pages.clear(); SEARCH.order = []; SEARCH.activeKey = null; SEARCH.scanned.clear();
  document.querySelectorAll(".stage .hl").forEach(hl=>{ hl.textContent = ""; });
  if (!needle || !MDOC){ updateFindCount(); return; }

  const n = MDOC.countPages();
  // 1) visible pages first — instant feedback
  const vis = visiblePageIndexes();
  for (const i of vis){
    if (tok !== SEARCH.token) return;
    if (SEARCH.scanned.has(i)) continue;
    SEARCH.scanned.add(i);
    const res = searchPage(i, needle);
    if (res.length) SEARCH.pages.set(i, res);
  }
  rebuildOrder();
  // select the first match found so far and reveal it
  if (SEARCH.order.length){ SEARCH.activeKey = { ...SEARCH.order[0] }; }
  paintAllHighlights();
  updateFindCount();
  if (SEARCH.activeKey) revealActive();

  // 2) lazily scan the rest, in chunks, so the count climbs without freezing UI
  for (let i=0; i<n; i++){
    if (SEARCH.scanned.has(i)) continue;
    if (i % 12 === 0){
      await new Promise(r=>setTimeout(r,0));
      if (tok !== SEARCH.token) return;     // a newer query superseded this one
    }
    SEARCH.scanned.add(i);
    const res = searchPage(i, needle);
    if (res.length){
      SEARCH.pages.set(i, res);
      rebuildOrder();
      // if nothing was selected yet (no hits on visible pages), select the first
      if (!SEARCH.activeKey && SEARCH.order.length){ SEARCH.activeKey = { ...SEARCH.order[0] }; revealActive(); }
      paintPageByIndex(i);
      updateFindCount();
    }
  }
  if (tok === SEARCH.token) updateFindCount();
}

function findActiveIndex(){
  if (!SEARCH.activeKey) return -1;
  return SEARCH.order.findIndex(o=>o.page===SEARCH.activeKey.page && o.mi===SEARCH.activeKey.mi);
}

function updateFindCount(){
  const el = $("findCount");
  const total = SEARCH.order.length;
  const has = !!SEARCH.needle;
  if (!has){ el.textContent = ""; }
  else if (!total){ el.textContent = "0/0"; }
  else { const cur = findActiveIndex(); el.textContent = (cur<0?0:cur+1) + "/" + total; }
  const none = total===0;
  $("findPrev").disabled = none;
  $("findNext").disabled = none;
}

function gotoFind(delta){
  const total = SEARCH.order.length;
  if (!total) return;
  let cur = findActiveIndex();
  if (cur < 0) cur = 0;
  else cur = (cur + delta + total) % total;
  SEARCH.activeKey = { ...SEARCH.order[cur] };
  paintAllHighlights();
  updateFindCount();
  revealActive();
}

// Scroll the current match into view by moving the VIEWER directly (never
// Element.scrollIntoView — on iOS that bubbles up and hides the toolbar, the
// same reason scrollToPage exists). We centre the active match's box when its
// page is laid out, falling back to scrolling to the page top otherwise.
function revealActive(){
  if (!SEARCH.activeKey) return;
  const p = SEARCH.activeKey.page;
  const v = $("viewer");
  const centre = ()=>{
    const stage = $("pageWrap").querySelector('.stage[data-page="'+p+'"]');
    if (!stage){ scrollToPage(p); return; }
    const box = stage.querySelector(".hl .hlbox.on");
    const ref = box || stage;
    const refTop = ref.getBoundingClientRect().top;
    const vRect = v.getBoundingClientRect();
    // place the match roughly a third of the way down the viewer
    const target = Math.max(0, v.scrollTop + (refTop - vRect.top) - vRect.height/3);
    try { if (typeof v.scrollTo === "function"){ v.scrollTo({ top:target, behavior:"smooth" }); return; } } catch(e){}
    v.scrollTop = target;
  };
  // ensure the page is rendered first; getBoundingClientRect is valid for
  // not-yet-rasterised stages too (they carry their intrinsic size)
  scrollToPage(p);
  const raf = (typeof window!=="undefined" && window.requestAnimationFrame)
    ? window.requestAnimationFrame.bind(window) : (fn)=>setTimeout(fn,16);
  raf(()=>raf(centre));
}

function paintAllHighlights(){
  document.querySelectorAll(".stage").forEach(stage=>{
    if (stage.dataset.rendered) paintPageHighlights(stage, +stage.dataset.page);
  });
}
function paintPageByIndex(i){
  const stage = $("pageWrap").querySelector('.stage[data-page="'+i+'"]');
  if (stage && stage.dataset.rendered) paintPageHighlights(stage, i);
}

function paintPageHighlights(stage, i){
  const hl = stage.querySelector(".hl");
  if (!hl) return;
  hl.textContent = "";
  if (!SEARCH.open) return;
  const matches = SEARCH.pages.get(i);
  if (!matches || !matches.length) return;
  const wPt = +stage.dataset.wpt, dispW = parseFloat(stage.style.width);
  if (!wPt || !dispW) return;
  const s = dispW / wPt;
  const ak = SEARCH.activeKey;
  matches.forEach((m, mi)=>{
    const on = !!(ak && ak.page===i && ak.mi===mi);
    for (const b of m.boxes){
      const d = document.createElement("div");
      d.className = on ? "hlbox on" : "hlbox";
      d.style.left   = (b[0]*s)+"px";
      d.style.top    = (b[1]*s)+"px";
      d.style.width  = ((b[2]-b[0])*s)+"px";
      d.style.height = ((b[3]-b[1])*s)+"px";
      hl.appendChild(d);
    }
  });
}

// wire the find bar
// show the inline clear (✕) only while the field has text
function refreshFindClear(){ const inp=$("findInput"); $("findClear").hidden = !inp.value.length; }
$("findInput").addEventListener("input", ()=>{ refreshFindClear(); scheduleFind(); });
$("findInput").addEventListener("keydown", (e)=>{
  if (e.key==="Enter"){ e.preventDefault(); gotoFind(e.shiftKey ? -1 : 1); }
  else if (e.key==="Escape"){ e.preventDefault(); closeFind(); }
});
$("findPrev").onclick  = ()=> gotoFind(-1);
$("findNext").onclick  = ()=> gotoFind(1);
$("findClose").onclick = ()=> closeFind();
// clear the query but stay in Find, refocus the field, and reset results
$("findClear").onclick = ()=>{
  const inp=$("findInput"); inp.value=""; refreshFindClear();
  scheduleFind(); inp.focus();
};

// ---------------- font matching ----------------
// Two tiers, best first:
//   1. drawWithPdfFont — redraw using the PDF's OWN font resource (the exact
//      embedded face, e.g. Cambria), so an edited field is visually identical
//      to its neighbours. Used whenever the font can be located and every
//      character of the replacement is present in the embedded subset.
//   2. pickFont — the old base-14 substitution (Helvetica/Times/Courier). Still
//      the fallback for image-only fonts, exotic encodings and missing glyphs.
// Before v11.29 tier 2 was the only path, so a Cambria 10pt name field came
// back as Times-Roman AND shrank (Times is wider, so it failed the fit check).

// pickFont mirrors the macOS pick_font.
function pickFont(name){
  const n = (name||"").toLowerCase();
  const bold   = /bold|black|heavy|semibold|demi/.test(n);
  const italic = /italic|oblique/.test(n);
  const mono   = /mono|courier|consol/.test(n);
  const serif  = /times|serif|roman|georgia|minion|garamond|cambria/.test(n);
  const F = StandardFonts;
  if (mono)  return bold&&italic?F.CourierBoldOblique : bold?F.CourierBold : italic?F.CourierOblique : F.Courier;
  if (serif) return bold&&italic?F.TimesRomanBoldItalic : bold?F.TimesRomanBold : italic?F.TimesRomanItalic : F.TimesRoman;
  return bold&&italic?F.HelveticaBoldOblique : bold?F.HelveticaBold : italic?F.HelveticaOblique : F.Helvetica;
}

// ---- v11.29: reuse the PDF's own embedded font for replacement text ----------
// A /ToUnicode CMap maps character CODES (what goes in the content stream) to
// Unicode. Inverting it gives us Unicode -> code, i.e. how to type a character
// in this font. A character missing from the map is missing from the embedded
// SUBSET too, so the inverse map doubles as an exact coverage test.
function invertToUnicode(txt){
  const map = new Map();
  const put = (code, uniHex)=>{
    if (uniHex.length !== 4) return;                // surrogate pairs / ligatures: skip
    const u = parseInt(uniHex,16);
    if (!u || map.has(u)) return;
    map.set(u, code);
  };
  let m;
  const bf = /beginbfchar([\s\S]*?)endbfchar/g;
  while ((m = bf.exec(txt))){
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g; let p;
    while ((p = re.exec(m[1]))) put(p[1].toLowerCase(), p[2].toLowerCase());
  }
  const br = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = br.exec(txt))){
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g; let p;
    while ((p = re.exec(m[1]))){
      const lo = parseInt(p[1],16), hi = parseInt(p[2],16), u0 = parseInt(p[3],16), w = p[1].length;
      for (let c = lo; c <= hi && c-lo < 1024; c++)
        put(c.toString(16).padStart(w,"0"), (u0 + (c-lo)).toString(16).padStart(4,"0"));
    }
  }
  return map;
}
// /W of a CIDFont: [ cFirst [w w w…] ] and/or [ cFirst cLast w ], mixed freely.
function parseCidWidths(wObj){
  const W = new Map();
  if (!wObj || (wObj.isNull && wObj.isNull())) return W;
  let arr = null;
  try { arr = wObj.asJS({}); } catch(e){ return W; }
  if (!Array.isArray(arr)) return W;
  let i = 0;
  while (i < arr.length){
    const a = arr[i];
    if (Array.isArray(arr[i+1])){ arr[i+1].forEach((w,k)=>W.set(a+k, w)); i += 2; }
    else { const b = arr[i+1], w = arr[i+2];
           for (let c=a; c<=b && c-a<65536; c++) W.set(c, w);
           i += 3; }
  }
  return W;
}
// Locate the span's font in the page resources and gather everything needed to
// type with it. MUST run BEFORE the redaction, because saving with "garbage"
// can renumber (or drop) objects. Returns null whenever anything is unusual —
// every caller then falls back to the base-14 path.
function capturePdfFont(pageIndex, fontName){
  try {
    if (!MDOC || !MDOC.findPage || !fontName) return null;
    const base = String(fontName).replace(/^\//,"");
    const res = MDOC.findPage(pageIndex).get("Resources");
    if (!res || res.isNull()) return null;
    const fonts = res.get("Font");
    if (!fonts || fonts.isNull()) return null;
    let hit = null;
    fonts.forEach((v,k)=>{
      if (hit) return;
      const bf = String(v.get("BaseFont")||"").replace(/^\//,"");
      if (bf && bf === base) hit = { key:k, obj:v };
    });
    if (!hit) return null;
    const subtype = String(hit.obj.get("Subtype")||"").replace(/^\//,"");
    const info = { key:hit.key, type0:(subtype==="Type0"), uni:null, W:null, dw:1000, widths:null, firstChar:0 };
    const tu = hit.obj.get("ToUnicode");
    if (tu && !tu.isNull() && tu.isStream())
      info.uni = invertToUnicode(new TextDecoder().decode(tu.readStream().asUint8Array()));
    if (info.type0){
      // only Identity-H, where the 2-byte code IS the CID; any other CMap needs
      // a lookup we don't carry
      if (String(hit.obj.get("Encoding")||"").replace(/^\//,"") !== "Identity-H") return null;
      if (!info.uni || !info.uni.size) return null;
      const df = hit.obj.get("DescendantFonts").get(0);
      if (!df || df.isNull()) return null;
      const dw = df.get("DW");
      info.dw = (dw && !dw.isNull()) ? dw.asNumber() : 1000;
      info.W  = parseCidWidths(df.get("W"));
    } else {
      if (subtype !== "Type1" && subtype !== "TrueType" && subtype !== "MMType1") return null;
      // a /Differences encoding remaps codes, so a plain byte would type the
      // wrong glyph — hand those to the fallback
      const enc = hit.obj.get("Encoding");
      if (enc && !enc.isNull()){
        if (enc.isDictionary()){
          const d = enc.get("Differences");
          if (d && !d.isNull()) return null;
        } else {
          const en = String(enc).replace(/^\//,"");
          if (en !== "WinAnsiEncoding" && en !== "MacRomanEncoding" && en !== "StandardEncoding") return null;
        }
      }
      const wid = hit.obj.get("Widths"), fc = hit.obj.get("FirstChar");
      if (wid && !wid.isNull()) { try { info.widths = wid.asJS({}); } catch(e){} }
      if (fc && !fc.isNull()) info.firstChar = fc.asNumber();
    }
    return info;
  } catch(e){ return null; }
}
// Encode text in that font. Returns null the moment a character has no glyph in
// the embedded subset — better to fall back for the whole string than to emit
// one blank box in the middle of a name.
function encodeWithPdfFont(info, text){
  if (!info || !text) return null;
  const codes = []; let w = 0;
  for (const ch of text){
    const u = ch.codePointAt(0);
    if (info.type0){
      const hex = info.uni.get(u);
      if (hex === undefined) return null;
      const cid = parseInt(hex,16);
      codes.push(hex.padStart(4,"0"));
      w += info.W.has(cid) ? info.W.get(cid) : info.dw;
    } else {
      if (u > 255) return null;                      // simple fonts are single-byte
      if (info.uni && info.uni.size && !info.uni.has(u)) return null;
      codes.push(u.toString(16).padStart(2,"0"));
      const idx = u - info.firstChar;
      const known = info.widths && idx >= 0 && idx < info.widths.length;
      if (!known) return null;                       // no metric: can't check the fit
      w += info.widths[idx];
    }
  }
  // width is per 1pt of font size; glyphs is what Tc gets multiplied by
  return { hex: codes.join("").toUpperCase(), width: w/1000, glyphs: codes.length };
}
// Emit the text as raw content-stream operators against the page's existing
// font resource. pdf-lib appends to the page content stream, so /key resolves
// through the page's own (or inherited) /Resources — the same dictionary the
// original text used.
// `tc` is character spacing in points (the Tc operator), used to reproduce how
// tightly the original line was set. Publishers kern body text, which a PDF
// stores as a TJ array of glyph runs with offsets between them. We redraw with
// a single Tj and have no access to those offsets, so the same words in the
// same font come out a few percent wider than the text they replace — 87.5pt
// against 84.9pt on the Cambria name field, enough to push a centred line
// visibly off centre. Tc adds a fixed amount to every glyph's advance, which is
// what kerning is; it does NOT distort the glyphs, and unlike horizontal
// scaling (Tz) it leaves the font size that extractors report untouched — so
// editing the same field twice can't ratchet it smaller. Text state belongs to
// the graphics state, so the q/Q pair stops it leaking into later content.
function drawWithPdfFont(pg, info, hex, x, y, size, colour, tc){
  const O = PDFOperator.of.bind(PDFOperator), N = PDFNumber.of.bind(PDFNumber);
  const ops = [
    O("q",  []),
    O("BT", []),
    O("rg", [N(colour[0]), N(colour[1]), N(colour[2])]),
    O("Tf", [PDFName.of(info.key), N(size)])
  ];
  if (tc && Math.abs(tc) > 0.0005) ops.push(O("Tc", [N(+tc.toFixed(4))]));
  ops.push(
    O("Tm", [N(1), N(0), N(0), N(1), N(x), N(y)]),
    O("Tj", [PDFHexString.of(hex)]),
    O("ET", []),
    O("Q",  [])
  );
  pg.pushOperators.apply(pg, ops);
}
// Per-glyph spacing that makes our un-kerned run occupy the width the original
// actually occupied. Returns 0 unless the string is long enough for the
// estimate to mean anything and the correction is small enough to be tracking
// rather than a sign that we mis-measured something.
//
// Divided by glyphs-1, not glyphs: a span's box is the UNION of its glyph
// quads, and the last quad ends at that glyph's advance — the spacing added
// after it falls outside the box. Dividing by the glyph count instead leaves a
// systematic 0.2pt of slack that each re-edit of the same field would add
// again, so a field edited five times crept 0.8pt wider.
function trackingFor(sp, naturalWidth, glyphs, size){
  const ink = sp.x1 - sp.x0;
  if (!(naturalWidth > 1) || !(ink > 1) || !(glyphs > 1)) return 0;
  if ((sp.text || "").trim().length < 4) return 0;
  const tc = (ink - naturalWidth) / (glyphs - 1);
  return Math.abs(tc) <= 0.12*(size || 11) ? tc : 0;
}
// The width a run will MEASURE as once drawn — same union-of-quads convention,
// so it can be compared directly against a span box read back out of the page.
function trackedWidth(enc, size, tc){
  return enc.width*size + tc*Math.max(enc.glyphs - 1, 0);
}
// Does the captured resource still exist on the page after the redact + save?
// ("garbage" collection drops a font whose only user was the text we erased.)
function pdfFontStillOnPage(pg, key){
  try {
    const res = pg.node.Resources();
    if (!res) return false;
    const fonts = res.lookup(PDFName.of("Font"));
    return !!(fonts && fonts.lookup && fonts.lookup(PDFName.of(key)));
  } catch(e){ return false; }
}

// ---------------- in-place text edit (redact original glyphs, reinsert text) ----------------
// page rotations (cached per document version) — text editing assumes an
// upright page, so warn before editing a rotated one
let rotCache = null, rotCacheEpoch = -1;
async function pageRotation(idx){
  if (rotCacheEpoch !== epoch){
    try {
      const d = await PDFDocument.load(workingBytes, { ignoreEncryption:true });
      rotCache = d.getPages().map(p=>(p.getRotation().angle||0)%360);
    } catch(e){ rotCache = []; }
    rotCacheEpoch = epoch;
  }
  return (rotCache && rotCache[idx]) || 0;
}
async function openTextEditor(pageIndex, spanIndex){
  const sp = getSpans(pageIndex)[spanIndex];
  if (!sp) return;
  const rot = await pageRotation(pageIndex);
  if (rot){
    $("sheet").innerHTML = h`
      <h3>This page is rotated</h3>
      <p class="hint">Text editing works best on upright pages — on a rotated page the new text can land in the wrong place. You can rotate the page back first (More → Pages), or continue anyway.</p>
      <div class="row"><button class="full" id="rwGo">Edit anyway</button></div>
      <div class="row"><button class="ghost full" id="rwNo">Cancel</button></div>`;
    $("rwGo").onclick = ()=>{ closeSheet(); openTextEditorSheet(pageIndex, sp); };
    $("rwNo").onclick = closeSheet;
    openSheet();
    return;
  }
  openTextEditorSheet(pageIndex, sp);
}
// v11.37: the edit sheet gained a paragraph mode and real type controls.
// Colours are the six that actually get used on a document; an arbitrary
// picker on a phone is fiddly and almost always ends in "black" anyway.
const TE_COLOURS = [
  { k:"keep",  label:"Same",   rgb:null },
  { k:"black", label:"Black",  rgb:[0,0,0] },
  { k:"grey",  label:"Grey",   rgb:[0.42,0.45,0.5] },
  { k:"red",   label:"Red",    rgb:[0.78,0.11,0.11] },
  { k:"blue",  label:"Blue",   rgb:[0.11,0.32,0.78] },
  { k:"green", label:"Green",  rgb:[0.08,0.5,0.24] },
  { k:"white", label:"White",  rgb:[1,1,1] },
];
const TE_FONTS = [
  { k:"keep",    label:"Same" },
  { k:"sans",    label:"Sans" },
  { k:"serif",   label:"Serif" },
  { k:"mono",    label:"Mono" },
];
function openTextEditorSheet(pageIndex, sp){
  const spans = getSpans(pageIndex);
  const idx = spans.indexOf(sp);
  const block = idx >= 0 ? paragraphBlock(spans, idx) : null;
  const canBlock = !!(block && block.multi);
  // v11.39: paragraph mode is OPT-IN. v11.37 defaulted it on whenever a block
  // was detected, which meant one tap on an invoice re-flowed a stack of
  // fields into a sentence before the user had agreed to anything. Editing one
  // line is the safe, predictable, pre-v11.37 behaviour and is therefore what
  // a tap does; re-wrapping a paragraph is a deliberate second choice.
  let asBlock = false;
  let size = null;            // null = keep the original
  let colour = "keep", fontK = "keep";

  const draw = ()=>{
    const body = asBlock ? block.lines.map(l=>l.text).join(" ") : sp.text;
    $("sheet").innerHTML = h`
      <h3>Edit text · page ${pageIndex+1}</h3>
      <p class="hint">${asBlock
        ? "The whole paragraph ("+block.lines.length+" lines) is replaced and re-wrapped to its own width."
        : "This line is replaced, keeping its position, size and colour."} Leave it empty to delete the text.</p>
      ${raw(canBlock ? `<div class="row teseg" id="teScope">
          <button class="segb${asBlock?"":" on"}" data-v="0">This line only</button>
          <button class="segb${asBlock?" on":""}" data-v="1">Whole paragraph (${block.lines.length} lines)</button>
        </div>` : "")}
      <div class="row"><textarea id="teIn"></textarea></div>
      <div class="row telbl">Size</div>
      <div class="row teseg" id="teSize">
        <button class="segb" data-d="-1">A −</button>
        <button class="segb" id="teSizeNow">${(size==null ? (sp.size||11) : size).toFixed(1)} pt</button>
        <button class="segb" data-d="1">A +</button>
      </div>
      <div class="row telbl">Colour</div>
      <div class="row teseg tewrap" id="teCol">
        ${raw(TE_COLOURS.map(c=>`<button class="segb${colour===c.k?" on":""}" data-k="${c.k}">${c.label}</button>`).join(""))}
      </div>
      <div class="row telbl">Typeface</div>
      <div class="row teseg" id="teFont">
        ${raw(TE_FONTS.map(f=>`<button class="segb${fontK===f.k?" on":""}" data-k="${f.k}">${f.label}</button>`).join(""))}
      </div>
      <div class="row"><button class="full" id="teOk">Replace</button></div>
      <div class="row"><button class="ghost full" id="teCancel">Cancel</button></div>`;
    $("teIn").value = body;
    if (canBlock) $("teScope").querySelectorAll("[data-v]").forEach(b=>
      b.onclick = ()=>{ asBlock = b.dataset.v === "1"; draw(); });
    $("teSize").querySelectorAll("[data-d]").forEach(b=>
      b.onclick = ()=>{
        const cur = size == null ? (sp.size||11) : size;
        size = Math.min(96, Math.max(4, Math.round((cur + (+b.dataset.d)*0.5)*2)/2));
        $("teSizeNow").textContent = size.toFixed(1)+" pt";
      });
    $("teSizeNow").onclick = ()=>{ size = null; $("teSizeNow").textContent = (sp.size||11).toFixed(1)+" pt"; };
    $("teCol").querySelectorAll("[data-k]").forEach(b=>
      b.onclick = ()=>{ colour = b.dataset.k;
        $("teCol").querySelectorAll("[data-k]").forEach(o=>o.classList.toggle("on", o===b)); });
    $("teFont").querySelectorAll("[data-k]").forEach(b=>
      b.onclick = ()=>{ fontK = b.dataset.k;
        $("teFont").querySelectorAll("[data-k]").forEach(o=>o.classList.toggle("on", o===b)); });
    $("teOk").onclick = async ()=>{
      const t = $("teIn").value;
      const opts = { size, colour: (TE_COLOURS.find(c=>c.k===colour)||{}).rgb, font: fontK };
      closeSheet();
      if (asBlock && canBlock) await applyBlockEdit(pageIndex, block, t, opts);
      else await applyTextEdit(pageIndex, sp, t, opts);
    };
    $("teCancel").onclick = closeSheet;
  };
  draw();
  openSheet();  setTimeout(()=>{ const i=$("teIn"); if(i) i.focus(); }, 100);
}

// Estimate the background colour immediately AROUND a text span by rendering the
// page and sampling a thin ring just outside the span (top/bottom/left/right),
// where there are no glyphs from this span. Returns { r,g,b, uniform } in 0–255,
// or null. `uniform` is false when the ring is mixed (text-dense / an image edge)
// — in that case the caller keeps the safe white fill. Used so a text edit on a
// coloured cell or banner reconstructs that colour instead of leaving a white
// patch. White pages sample near-white, so they're unaffected.
function sampleSpanBg(pageIndex, sp){
  let page=null, pix=null;
  try {
    page = MDOC.loadPage(pageIndex);
    const s = 2.0;                                   // ~144 dpi: more pixels for small fields
    pix = page.toPixmap(mupdf.Matrix.scale(s,s), mupdf.ColorSpace.DeviceRGB, false);
    const W=pix.getWidth(), Hh=pix.getHeight(), stride=pix.getStride(), n=pix.getNumberOfComponents();
    const ox=pix.getX(), oy=pix.getY();
    const data = pix.getPixels();                    // heap VIEW — read into rs[] before any wasm alloc
    const rs=[], pad=3;                              // sample just clear of the text's anti-aliased edge
    const at=(X,Y)=>{ const x=Math.round(X*s)-ox, y=Math.round(Y*s)-oy;
      if (x<0||y<0||x>=W||y>=Hh) return; const i=y*stride+x*n; rs.push([data[i],data[i+1],data[i+2]]); };
    const line=(x0,y0,x1,y1)=>{ for(let k=0;k<=12;k++) at(x0+(x1-x0)*k/12, y0+(y1-y0)*k/12); };
    line(sp.x0, sp.y0-pad, sp.x1, sp.y0-pad);        // above
    line(sp.x0, sp.y1+pad, sp.x1, sp.y1+pad);        // below
    line(sp.x0-pad, sp.y0, sp.x0-pad, sp.y1);        // left
    line(sp.x1+pad, sp.y0, sp.x1+pad, sp.y1);        // right
    if (rs.length < 8) return null;
    const med = ch => { const a=rs.map(c=>c[ch]).sort((u,v)=>u-v); return a[a.length>>1]|0; };
    const r=med(0), g=med(1), b=med(2);
    // Trust the sampled colour when it is the DOMINANT colour of the ring (a
    // majority of pixels are close to the median). This holds for a flat coloured
    // cell even when the ring clips a few dark grid lines or glyphs — the median
    // stays the cell colour and most pixels match it — but fails on a photo /
    // mixed background, where we keep the safe white fill.
    let close=0;
    for (const c of rs){ if (Math.abs(c[0]-r)<85 && Math.abs(c[1]-g)<85 && Math.abs(c[2]-b)<85) close++; }
    // accept the median when it's clearly the panel colour (a solid majority of
    // the ring is near it). The wide tolerance lets in the panel's own texture and
    // anti-aliased edges around short labels; a real photo still has no such
    // majority, so it keeps the safe white fill.
    return { r, g, b, uniform: close/rs.length >= 0.6 };
  } catch(e){ return null; }
  finally { try{ if(pix) pix.destroy(); }catch(e){} try{ if(page) page.destroy(); }catch(e){} }
}
// ---- what colour to paint over an erased word ------------------------------
// v11.56: the born-digital half of this was reverted. v11.55 lowered the
// "treat as white" floor from 245 to 232 to explain a box the user saw around
// an edited name — and that explanation was WRONG. Reproducing it on the
// user's own file settled it: the box is the invoice's own field border, it is
// in the untouched original (1683 faint-grey pixels before the edit, 1736
// after, the difference being anti-aliasing of the new text), and every pixel
// the edit changes lies inside the text band. Sampling on that file returns
// pure white with 0.88 agreement, so the patch was always white.
//
// Lowering the floor therefore fixed nothing and risked something real: a
// genuinely light-grey shaded cell (say 235) would have been painted white,
// creating exactly the visible patch the floor exists to prevent. Back to 245.
//
// What DOES stay is the scan half, which was independently reported and is
// real: on a scan the ring around a word is textured — creases, shadows, JPEG
// noise — so `uniform` comes back false and the patch fell through to white,
// leaving a white rectangle on pink paper. There the median IS the paper tone,
// and matching it matters more than the ring being tidy.
function editFillColourRGB(bg, isScan){
  if (!bg) return [1,1,1];
  const { r, g, b } = bg;
  if (r >= 245 && g >= 245 && b >= 245) return [1,1,1];   // paper: paint it white
  if (!bg.uniform && !isScan) return [1,1,1];             // untrustworthy sample
  return [r/255, g/255, b/255];
}
function editFillColour(bg){
  const c = editFillColourRGB(bg, (()=>{ try { return docIsOcr(); } catch(e){ return false; } })());
  return rgb(c[0], c[1], c[2]);
}

// ---- v11.30: edit geometry (redaction band, alignment, available width) -----
// Everything here works off ONE fact about structured-text spans: a span's box
// is the FONT box of its line (ascender to descender), not the ink. At normal
// leading that box is TALLER than the line pitch — 11.25pt Helvetica reports a
// 15.45pt box on 13.0pt leading — so the boxes of consecutive lines genuinely
// OVERLAP by ~2.4pt. Any geometry that treats a span box as "just this line"
// silently reaches into its neighbours.

// The rectangle to redact. MuPDF drops every glyph whose box INTERSECTS this
// rect, so the old rect (the span box, plus 1pt of padding all round) deleted
// whatever sat above and below within the same columns:
//   "Billing Address :" -> "Bill",  "C/o …, Near Park" -> "C/o …, South Col".
// Clamp the rect vertically to the gap between the neighbouring lines. A band
// through the x-height still intersects every glyph OF THIS LINE — mupdf
// removes the whole glyph, ascenders and descenders included — while no longer
// touching the lines above or below. It also shrinks the area whose background
// gets erased, which is why an edit no longer punches a white slot through a
// watermark or a coloured panel.
function redactBandFor(pageIndex, sp){
  let top = sp.y0 - 1, bot = sp.y1 + 1;
  const cy = (sp.y0 + sp.y1) / 2;
  try {
    for (const o of getSpans(pageIndex)){
      if (o === sp) continue;
      if (o.x1 <= sp.x0 - 1 || o.x0 >= sp.x1 + 1) continue;   // different column
      const ocy = (o.y0 + o.y1) / 2;
      if (ocy < cy && o.y1 > top) top = o.y1;                 // nearest line above
      if (ocy > cy && o.y0 < bot) bot = o.y0;                 // nearest line below
    }
  } catch(e){}
  // Safety net for pathologically tight or overlapping typesetting: the band
  // MUST still cross this line's x-height, or the redaction would remove
  // nothing and the old text would survive under the new. Widening here can
  // clip a neighbour, but it is still far tighter than the pre-v11.30 box.
  const size = sp.size || 11, base = sp.origin ? sp.origin[1] : (sp.y0+sp.y1)/2;
  const xhTop = base - 0.55*size, xhBot = base - 0.05*size;
  if (!(bot - top > 0.2*size) || top > xhTop || bot < xhBot){
    top = Math.min(top, xhTop);
    bot = Math.max(bot, xhBot);
  }
  return [sp.x0 - 1, top, sp.x1 + 1, bot];
}

// Which edge of the block the line is anchored to. A right-aligned address
// block was being re-typed from its LEFT edge, so a longer name grew past the
// margin and the column stopped lining up ("Bandhana Paul" ran 7.5pt beyond the
// 552.5pt right edge every other line shares). Decide from the block's own
// evidence: gather the lines stacked with this one and see which edge they
// agree on. Deliberately conservative — "left" (the pre-v11.30 behaviour) is
// the default, and another mode has to win clearly to be used.
function blockAlignFor(pageIndex, sp){
  const out = { mode:"left", x:(sp.origin ? sp.origin[0] : sp.x0) };
  try {
    const size = sp.size || 11;
    const cy = (sp.y0 + sp.y1) / 2;
    const peers = [];
    for (const o of getSpans(pageIndex)){
      if (o === sp) continue;
      if (Math.abs((o.y0+o.y1)/2 - cy) > 3.2*size) continue;       // not stacked with us
      if (o.x1 <= sp.x0 - 1 || o.x0 >= sp.x1 + 1) continue;        // different column
      peers.push(o);
    }
    if (peers.length < 2) return out;                              // not enough evidence
    const all = peers.concat([sp]);
    // Score each edge by how many lines sit on it, measured against the MEDIAN
    // rather than as a max-min spread: one line whose last glyph has an unusual
    // side bearing (or a producer whose metrics differ a hair from ours) must
    // not veto an alignment the other four lines plainly share.
    const tol = Math.max(1.5, 0.16*size);
    const score = f => {
      const v = all.map(f).sort((a,b)=>a-b);
      const med = v[v.length>>1];
      return v.filter(x=>Math.abs(x-med) <= tol).length / v.length;
    };
    const sL = score(s=>s.x0), sR = score(s=>s.x1), sC = score(s=>(s.x0+s.x1)/2);
    // "left" is the pre-v11.30 behaviour and the default: another edge has to
    // fit clearly better to be used. A block that agrees on BOTH edges is a
    // fixed-width column, where left is already correct — don't churn it.
    if (sR >= 0.8 && sR > sL + 0.3){ out.mode = "right";  out.x = sp.x1; }
    else if (sC >= 0.8 && sC > sL + 0.3 && sC > sR + 0.3){ out.mode = "center"; out.x = (sp.x0+sp.x1)/2; }
  } catch(e){}
  return out;
}

// ---- v11.37: paragraphs (pure) -------------------------------------------
// Until v11.37 a "span" — one line — was the largest thing that could be
// edited. That is fine for a form field and useless for a sentence: changing
// "twelve" to "twenty-four" in the middle of a paragraph left the rest of the
// line short and every line below it untouched, so the text no longer read as
// a paragraph. Editing a paragraph means re-wrapping it, which first means
// knowing which lines belong to it.
//
// Pure on purpose: it takes the spans array rather than a page index, so the
// grouping can be driven directly by tests with hand-built fixtures.
//
// A paragraph is a run of lines that: overlap horizontally (same column), are
// set at the same size, are spaced at a consistent pitch, and are not
// separated by a gap large enough to be a paragraph break. Deliberately
// conservative — a block that is not clearly one paragraph comes back as the
// single line it started from, which is the pre-v11.37 behaviour.
function paragraphBlock(spans, idx){
  const sp = spans && spans[idx];
  if (!sp) return null;
  const size = sp.size || 11;
  const single = { lines:[sp], indexes:[idx], size, leading:size*1.2, x0:sp.x0, x1:sp.x1, multi:false };
  if (spans.length < 2) return single;

  const sameFamily = (a,b)=>{
    if (Math.abs((a.size||11) - (b.size||11)) > 0.6) return false;
    // Colour must match too: a heading or a highlighted term re-wrapped into
    // the body would silently lose its colour.
    for (let c=0;c<3;c++) if (Math.abs((a.color?a.color[c]:0) - (b.color?b.color[c]:0)) > 0.02) return false;
    return true;
  };
  const overlaps = (a,b)=>{
    const lo = Math.max(a.x0, b.x0), hi = Math.min(a.x1, b.x1);
    return (hi - lo) > 0.35 * Math.min(a.x1-a.x0, b.x1-b.x0);
  };
  // Restrict to the seed's OWN column before walking. Sorting the whole page by
  // baseline interleaves side-by-side columns — a two-column layout gives
  // left1, right1, left2, right2… with equal baselines — and a walk over that
  // list stops at the very first neighbour, so a paragraph in a two-column
  // document could never be found at all. Filtering first is also what makes
  // the pitch check meaningful: it then measures the gap to the next line of
  // THIS column rather than to whatever sits beside it.
  const order = spans.map((s,i)=>({ s, i }))
                     .filter(o=> o.s && o.s.origin && (o.i === idx || overlaps(sp, o.s)))
                     .sort((a,b)=> a.s.origin[1] - b.s.origin[1]);
  const at = order.findIndex(o=>o.i === idx);
  if (at < 0) return single;
  // Pitch: the gap between consecutive baselines. Normal leading is 1.0x to
  // 1.6x the size; anything looser is a paragraph break, and anything tighter
  // means the two lines are not stacked at all (side-by-side columns whose
  // boxes happen to overlap).
  const pitchOk = (dy)=> dy > size*0.85 && dy < size*2.1;

  const picked = [order[at]];
  for (let dir of [-1, 1]){
    let k = at, guardPitch = 0;
    for (;;){
      const j = k + dir;
      if (j < 0 || j >= order.length) break;
      const a = order[k].s, b = order[j].s;
      const dy = Math.abs(b.origin[1] - a.origin[1]);
      if (!pitchOk(dy) || !sameFamily(a,b) || !overlaps(a,b)) break;
      // Once a pitch is established, a later line must keep it: a tighter or
      // looser step is a different block even if everything else matches.
      if (guardPitch && Math.abs(dy - guardPitch) > Math.max(1.2, size*0.28)) break;
      guardPitch = guardPitch || dy;
      picked.push(order[j]);
      k = j;
    }
  }
  if (picked.length < 2) return single;
  picked.sort((a,b)=> a.s.origin[1] - b.s.origin[1]);
  const lines = picked.map(p=>p.s);

  // ---- v11.39: is this actually PROSE? ------------------------------------
  // v11.37 shipped without this and it was wrong on the first real document it
  // met: a pharmacy invoice. Address blocks, label/value pairs and table rows
  // all satisfy every rule above — same size, same colour, even pitch, same
  // column — so the editor grouped a stack of unrelated fields into one
  // "paragraph" and re-flowed them into a running sentence. Getting the
  // grouping rules right is not enough; the content has to be the KIND of
  // thing that can be re-wrapped at all.
  //
  // Two tests, both of which a form fails and prose passes.

  // 1) Is anything sitting BESIDE these lines? A table row and a label/value
  //    pair have a neighbour on the same baseline; a paragraph never does.
  //    This is the single strongest signal on an invoice, where every row is
  //    "Payment Method | Transaction Time | Amount".
  for (const l of lines){
    const cy = (l.y0 + l.y1) / 2, half = (l.y1 - l.y0) / 2;
    for (const o of spans){
      if (o === l || !o.origin) continue;
      const ocy = (o.y0 + o.y1) / 2;
      if (Math.abs(ocy - cy) > half*0.7) continue;          // not on this line
      if (o.x1 <= l.x0 + 1 || o.x0 >= l.x1 - 1) return single;   // beside it
    }
  }
  // 2) Do the non-final lines AGREE on a right edge? Wrapped prose runs to the
  //    same right margin on every line but its last, because that margin is
  //    what caused the wrap. A stacked address, or any list of values, is a set
  //    of lines each as long as its own content, which stop wherever they stop.
  //    That is the difference between
  //        "…intact for" / "…and customer." / "…terms-and-conditions."   (prose)
  //    and "Ground floor,, Block F, Godown No 7," / "Plinth Area, 153F, S.M
  //    Bose Road," / "Duckback Factory. P.O"                            (address)
  //    whose first two lines differ by 15pt on a 250pt measure.
  //
  //    The tolerance is 4% of the measure and deliberately tight. It will
  //    occasionally decline a real paragraph whose lines end on an unusually
  //    long word, and that is the right way to be wrong: declining costs the
  //    user nothing but a line-by-line edit, whereas accepting a form re-flows
  //    it into a sentence and destroys the layout.
  if (lines.length >= 2){
    const body  = lines.slice(0, -1);
    const left  = Math.min(...lines.map(l=>l.x0));
    const rights = body.map(l=>l.x1);
    const maxR  = Math.max(...rights);
    const measure = Math.max(1, maxR - left);
    for (const r of rights) if ((maxR - r) > measure*0.04) return single;
  }
  // Leading is the MEDIAN step, not the mean: one line carrying a superscript
  // or an inline image can stretch a single gap without changing the setting.
  const steps = [];
  for (let i=1;i<lines.length;i++) steps.push(lines[i].origin[1] - lines[i-1].origin[1]);
  steps.sort((a,b)=>a-b);
  const leading = steps[steps.length>>1] || size*1.2;
  return {
    lines, indexes: picked.map(p=>p.i), size, leading, multi:true,
    x0: Math.min(...lines.map(l=>l.x0)),
    // The right edge of a paragraph is where the FULL lines end, not where the
    // last (short) line happens to stop — otherwise every paragraph would be
    // re-wrapped to the width of its own final line and grow taller each time.
    x1: (()=>{ const w = lines.map(l=>l.x1).sort((a,b)=>a-b); return w[Math.floor(w.length*0.75)] || w[w.length-1]; })(),
  };
}
// Greedy line breaking. `measure` returns the width of a string at the size
// being laid out. Words longer than the line are given their own line rather
// than being broken mid-word: hyphenation needs a dictionary, and a wrong
// hyphen is worse than a long line.
function wrapLines(text, maxWidth, measure){
  const out = [];
  const paras = String(text == null ? "" : text).split(/\r?\n/);
  for (const para of paras){
    const words = para.split(/\s+/).filter(w=>w.length);
    if (!words.length){ out.push(""); continue; }
    let line = "";
    for (const word of words){
      const cand = line ? line + " " + word : word;
      if (line && measure(cand) > maxWidth){ out.push(line); line = word; }
      else line = cand;
    }
    if (line) out.push(line);
  }
  return out.length ? out : [""];
}
// Largest size at or below `start` whose wrapped text still fits in `maxLines`.
// Shrinking is preferred to overflowing: text that runs past the bottom of a
// paragraph lands on whatever is underneath it, which the user cannot see
// coming and cannot easily undo.
function fitBlockSize(text, maxWidth, maxLines, start, measureAt, floor){
  const lo = Math.max(floor || start*0.7, 1);
  let size = start;
  for (let i=0; i<14; i++){
    const n = wrapLines(text, maxWidth, s=>measureAt(s, size)).length;
    if (n <= maxLines) return { size, lines: wrapLines(text, maxWidth, s=>measureAt(s, size)), overflow:false };
    if (size <= lo + 0.01) break;
    size = Math.max(lo, size - Math.max(0.25, start*0.05));
  }
  const lines = wrapLines(text, maxWidth, s=>measureAt(s, size));
  return { size, lines, overflow: lines.length > maxLines };
}

// How much room the replacement actually has, measured in the direction the
// text grows. Before v11.29 this was the span's OWN ink width, so a substitute
// font with different metrics failed the fit test on the very same words; since
// v11.29 it is the real gap to the next span, and as of v11.30 that gap is
// measured leftwards for a right-aligned line and both ways for a centred one.
function availWidthFor(pageIndex, sp, pageW, align){
  const own = Math.max(sp.x1 - sp.x0, 1);
  const mode = align ? align.mode : "left";
  const pageR = (pageW > 0 ? pageW : sp.x1 + own) - 4;      // small page margin
  let right = pageR, left = 4;
  try {
    for (const o of getSpans(pageIndex)){
      if (o === sp) continue;
      if (o.y1 <= sp.y0 + 1 || o.y0 >= sp.y1 - 1) continue;         // not on this line
      if (o.x0 >= sp.x1 - 0.5) right = Math.min(right, o.x0 - 2);   // 2pt gutter
      if (o.x1 <= sp.x0 + 0.5) left  = Math.max(left,  o.x1 + 2);
    }
  } catch(e){}
  let avail;
  if (mode === "right")       avail = align.x - left;
  else if (mode === "center") avail = 2 * Math.min(align.x - left, right - align.x);
  else                        avail = right - (sp.origin ? sp.origin[0] : sp.x0);
  return Math.max(avail, own);                             // never tighter than the original
}
// Where to start drawing, once the final width is known.
//
// Expressed as a SHIFT from the original pen position rather than as an
// absolute edge, and both widths are measured with the same font we are about
// to draw with. That makes re-typing a field unchanged an exact no-op in every
// alignment mode: delta is 0, so the text goes back on its original origin. An
// absolute anchor can't promise that, because a span's box is the ink extent
// while text is laid out by advance width, and the two differ by the first and
// last glyph's side bearings (1.3pt on the Cambria name field — visible).
function drawXFor(align, originX, origWidth, newWidth){
  const delta = newWidth - origWidth;
  if (!align || align.mode === "left") return originX;
  if (align.mode === "right")  return originX - delta;        // right edge pinned
  return originX - delta/2;                                   // centre pinned
}
// Shrink the draw size so a one-line replacement fits the space available
// (pdf-lib doesn't wrap). Never shrink below half — better a slight overflow
// than illegible text. Only shrinks; never enlarges.
function fitFontSize(font, text, size, avail){
  if (!(avail>1) || !text) return size;
  try { const wAt = font.widthOfTextAtSize(text, size);
    if (wAt>avail) return Math.max(size*0.5, size*avail/wAt);
  } catch(e){}
  return size;
}
// Same rule for the embedded-font path, where the width comes from the PDF's
// own /W or /Widths metrics (already normalised to 1pt of font size).
function fitFontSizeWidth(width1pt, size, avail){
  if (!(avail>1) || !(width1pt>0)) return size;
  const wAt = width1pt * size;
  return wAt > avail ? Math.max(size*0.5, size*avail/wAt) : size;
}

// v11.37: an explicit typeface choice overrides the name-matching in pickFont.
function pickFontKeyed(name, key){
  if (key === "sans")  return StandardFonts.Helvetica;
  if (key === "serif") return StandardFonts.TimesRoman;
  if (key === "mono")  return StandardFonts.Courier;
  // v11.54: the bold variants exist only as results of the scanned-face match,
  // so they are resolved here rather than offered in the typeface picker.
  if (key === "sansb")  return StandardFonts.HelveticaBold;
  if (key === "serifb") return StandardFonts.TimesRomanBold;
  return pickFont(name);
}
// ---- v11.37: edit a whole paragraph, re-wrapping it -----------------------
// The single-line path (applyTextEdit, below) is unchanged and still handles a
// form field. This one exists because a sentence is not a line: changing a word
// in the middle of a paragraph has to re-flow every line after it, or the
// paragraph stops reading as one.
//
// The ordering is the same as the single-line path and for the same reason:
// everything that reads getSpans is read BEFORE the redaction, because the
// redaction invalidates that cache.
// v11.39: ask BEFORE anything is changed. v11.37 reported an overflow in the
// status bar after the paragraph had already been re-flowed past its bounds,
// which is a report, not a choice.
function confirmOverflow(need, had){
  return new Promise(resolve=>{
    $("sheet").innerHTML = h`
      <h3>That text needs more room</h3>
      <p class="hint">The replacement needs ${need} lines but the paragraph only had ${had}, even after reducing the size as far as it safely goes. Going ahead will push the extra lines over whatever sits below the paragraph.</p>
      <div class="row"><button class="full" id="ovBack">Go back and shorten it</button></div>
      <div class="row"><button class="ghost danger full" id="ovGo">Do it anyway</button></div>`;
    let settled = false;
    const done = v=>{ if (settled) return; settled = true; sheetOnDismiss = null; closeSheet(); resolve(v); };
    $("ovBack").onclick = ()=> done(false);
    $("ovGo").onclick   = ()=> done(true);
    openSheet();
    sheetOnDismiss = ()=> done(false);      // backdrop / Esc = don't do it
  });
}

async function applyBlockEdit(pageIndex, block, newText, opts){
  opts = opts || {};
  showSpin(true, "Editing paragraph…");
  try {
    const first = block.lines[0];
    const bg    = sampleSpanBg(pageIndex, first);
    const fres  = (opts.font && opts.font !== "keep") ? null : capturePdfFont(pageIndex, first.font);
    const align = blockAlignFor(pageIndex, first);
    const bands = block.lines.map(l=> redactBandFor(pageIndex, l));

    // 0) v11.39: DRY RUN. Work out whether the replacement fits BEFORE anything
    //    is redacted, so "it doesn't fit" is a question we can still answer with
    //    "then don't do it". A throwaway load of the current bytes gives the
    //    same font metrics the real pass will use, and costs one parse.
    const dryText = String(newText == null ? "" : newText);
    if (dryText.trim() !== ""){
      try {
        const probe = await PDFDocument.load(workingBytes, { ignoreEncryption:true });
        const ppg   = probe.getPage(pageIndex);
        const pEnc  = fres && pdfFontStillOnPage(ppg, fres.key);
        const pB14  = pEnc ? null : await probe.embedFont(pickFontKeyed(first.font, opts.font));
        const pMeasure = (s, size)=>{
          if (pEnc){ const e = encodeWithPdfFont(fres, s); return e ? e.width*size : Infinity; }
          try { return pB14.widthOfTextAtSize(sanitizeForFont(s), size); } catch(e){ return Infinity; }
        };
        const startSize = opts.size != null ? opts.size : (block.size || first.size || 11);
        const pFit = fitBlockSize(dryText, Math.max(12, block.x1 - block.x0),
                                  block.lines.length, startSize, pMeasure, startSize*0.7);
        if (pFit.overflow){
          showSpin(false);
          const go = await confirmOverflow(pFit.lines.length, block.lines.length);
          if (!go){ setStatus("Left unchanged.","warn"); return; }
          showSpin(true, "Editing paragraph…");
        }
      } catch(e){ /* if the probe fails, fall through and edit as before */ }
    }

    // 1) erase every line of the paragraph in ONE redaction pass. The undo
    //    snapshot is taken HERE, not at the top: everything above this line is
    //    measurement, and a cancelled edit must not leave an undo step behind.
    pushUndo();
    const page = MDOC.loadPage(pageIndex);
    for (const b of bands){
      const an = page.createAnnotation("Redact");
      an.setRect(b);
      an.update();
    }
    page.applyRedactions(false);
    page.destroy();
    workingBytes = u8(MDOC.saveToBuffer("compress-images,garbage").asUint8Array());

    // 2) repaint the erased bands, then set the new text into the same shape
    const doc = await PDFDocument.load(workingBytes, { ignoreEncryption:true });
    const pg  = doc.getPage(pageIndex);
    const H   = pg.getHeight();
    const fillCol = editFillColour(bg);
    // v11.59: on a born-digital page the redaction has already removed the
    // glyphs as vectors, so the repaint only has to cover where they WERE.
    // Painting the full band was rubbing out the table rule that runs a hair
    // above the text — "editing Admenta 5 removes the top border". Pulling the
    // patch in by 0.6pt leaves hairline rules alone. On a scan the redaction
    // blanks the image itself, so there the patch must still cover it exactly.
    const fillIn = (()=>{ try { return docIsOcr() ? 0 : 0.6; } catch(e){ return 0.6; } })();
    const shrink = r => {
      const w = r[2]-r[0], h = r[3]-r[1];
      const ix = Math.min(fillIn, Math.max(0, w/2 - 0.2));
      const iy = Math.min(fillIn, Math.max(0, h/2 - 0.2));
      return [r[0]+ix, r[1]+iy, r[2]-ix, r[3]-iy];
    };
    for (const b0 of bands){
      const b = shrink(b0);
      pg.drawRectangle({ x:b[0], y:H-b[3], width:b[2]-b[0], height:b[3]-b[1], color:fillCol });
    }

    const text = String(newText == null ? "" : newText);
    let overflow = false, substituted = false, usedLines = 0;
    if (text.trim() !== ""){
      const startSize = opts.size != null ? opts.size : (block.size || first.size || 11);
      const colour = opts.colour || first.color || [0,0,0];
      const width  = Math.max(12, block.x1 - block.x0);
      const maxLines = block.lines.length;

      // Measure in whatever face the text will actually be drawn in — measuring
      // in one font and drawing in another is the v11.29 bug all over again.
      let b14 = null;
      const encOK = fres && pdfFontStillOnPage(pg, fres.key);
      if (!encOK) b14 = await doc.embedFont(pickFontKeyed(first.font, opts.font));
      const measureAt = (s, size)=>{
        if (encOK){ const e = encodeWithPdfFont(fres, s); return e ? e.width*size : Infinity; }
        try { return b14.widthOfTextAtSize(sanitizeForFont(s), size); } catch(e){ return Infinity; }
      };
      const fit = fitBlockSize(text, width, maxLines, startSize, measureAt, startSize*0.7);
      overflow = fit.overflow;
      usedLines = fit.lines.length;

      // Baselines: keep the paragraph's own first baseline and its own leading,
      // so a re-wrapped paragraph sits exactly where the old one did.
      const y0 = first.origin[1], lead = block.leading || fit.size*1.2;
      for (let i=0; i<fit.lines.length; i++){
        const line = fit.lines[i];
        if (!line) continue;
        const y = H - (y0 + i*lead);
        const w = measureAt(line, fit.size);
        // A wrapped line is a full line: it is anchored on the block's own
        // edges, not on the old line's ink extent, which is where the text
        // happened to stop before.
        const x = align.mode === "right"  ? block.x1 - w
                : align.mode === "center" ? block.x0 + (width - w)/2
                                          : block.x0;
        if (encOK){
          const e = encodeWithPdfFont(fres, line);
          if (e) drawWithPdfFont(pg, fres, e.hex, x, y, fit.size, colour, 0);
        } else {
          const safe = sanitizeForFont(line);
          if (safe !== line) substituted = true;
          pg.drawText(safe, { x, y, size:fit.size, font:b14,
                              color:rgb(colour[0],colour[1],colour[2]) });
        }
      }
    }
    workingBytes = new Uint8Array(await doc.save());
    reopen();
    setMode("text");
    await render();
    setStatus("Paragraph updated on page "+(pageIndex+1)+"."
      + (overflow ? " It is longer than the space it had, so it now runs past where the paragraph ended — undo if that is wrong."
                  : (usedLines && usedLines < block.lines.length ? " It now takes "+usedLines+" line(s) instead of "+block.lines.length+"." : ""))
      + (substituted ? " Some characters aren't available in that typeface and were shown as “?”." : ""),
      overflow ? "warn" : "ok");
  } catch(e){ setStatus("Could not change the paragraph: "+friendly(e),"err"); }
  showSpin(false);
}

async function applyTextEdit(pageIndex, sp, newText, opts){
  opts = opts || {};
  showSpin(true,"Editing text…");
  try {
    pushUndo();
    // sample the original background colour BEFORE redaction erases the area
    const bg = sampleSpanBg(pageIndex, sp);
    // v11.29: and grab the span's real font BEFORE the save renumbers objects,
    // plus the room it has on the line (getSpans is cache-backed; after the
    // redaction the cache is stale, so both have to be read now)
    // v11.37: an explicit typeface choice means the document's own embedded
    // font is deliberately NOT reused — that is the whole point of the choice.
    let fres = (opts.font && opts.font !== "keep") ? null : capturePdfFont(pageIndex, sp.font);
    // v11.54: on an OCRed SCAN the span's "font" is the invisible Helvetica we
    // laid down in v11.48, which tells us nothing about the printed word. Look
    // at the ink instead and retype in the closest face we have. Only when the
    // user has not chosen a typeface themselves, and only when the match is
    // clear — matchScanFace returns null rather than guess.
    let scanFace = null, scanFit = null;
    if (docIsOcr()){
      const eng = { PDFDocument, mupdf };
      if (!opts.font || opts.font === "keep"){
        try {
          scanFace = await matchScanFace(sp.text, spanInkMask(pageIndex, sp), eng);
        } catch(e){ scanFace = null; }
        if (scanFace){ opts = Object.assign({}, opts, { font: scanFace.key }); fres = null; }
      }
      // Fit the SIZE (and baseline) to the printed ink, in whichever face is
      // going to be used — the fit depends on the face's own proportions.
      const faceKey = (opts.font && opts.font !== "keep") ? opts.font : "sans";
      const shown = String(newText == null ? "" : newText).replace(/[\r\n]+/g, " ").trim();
      try { scanFit = await scanEditFit(pageIndex, sp, shown || sp.text, faceKey, eng); }
      catch(e){ scanFit = null; }
    }
    let pageW = 0;
    try { const mp = MDOC.loadPage(pageIndex); const b = mp.getBounds(); pageW = b[2]-b[0]; mp.destroy(); } catch(e){}
    // v11.30: which edge the block lines up on, how much room the text has in
    // that direction, and a redaction band that can't reach the lines above and
    // below. All three read getSpans, whose cache the redaction invalidates.
    const align = blockAlignFor(pageIndex, sp);
    const avail = availWidthFor(pageIndex, sp, pageW, align);
    const band  = redactBandFor(pageIndex, sp);
    // 1) remove the original glyphs with a MuPDF redaction (no black box)
    const page = MDOC.loadPage(pageIndex);
    const an = page.createAnnotation("Redact");
    an.setRect(band);
    an.update();
    page.applyRedactions(false);          // false => erase content, don't paint a box
    page.destroy();
    // compress-images: on an image-based / scanned PDF the redaction re-rasterises
    // the whole page image to UNCOMPRESSED RGB (a 2MB file balloons to ~26MB).
    // Re-compressing it brings the file back to normal size; harmless on text PDFs.
    workingBytes = u8(MDOC.saveToBuffer("compress-images,garbage").asUint8Array());

    // 2) reinsert real, selectable text with pdf-lib at the same place/size/colour
    const doc = await PDFDocument.load(workingBytes, { ignoreEncryption:true });
    const pg = doc.getPage(pageIndex);
    const H = pg.getHeight();
    // fill the erased area with the original background colour so an edit on a
    // coloured cell/banner doesn't leave a white patch. Keep pure white when the
    // background is (near-)white or not a trustworthy flat colour — so ordinary
    // white-page edits are byte-for-byte unchanged.
    // v11.30: fill EXACTLY the band that was erased, not the whole span box —
    // painting the full box would cover the descenders of the line above and
    // the ascenders of the line below, which the tighter redaction now spares.
    const fillCol = editFillColour(bg);
    // v11.59: on a born-digital page the redaction has already removed the
    // glyphs as vectors, so the repaint only has to cover where they WERE.
    // Painting the full band was rubbing out the table rule that runs a hair
    // above the text — "editing Admenta 5 removes the top border". Pulling the
    // patch in by 0.6pt leaves hairline rules alone. On a scan the redaction
    // blanks the image itself, so there the patch must still cover it exactly.
    const fillIn = (()=>{ try { return docIsOcr() ? 0 : 0.6; } catch(e){ return 0.6; } })();
    const shrink = r => {
      const w = r[2]-r[0], h = r[3]-r[1];
      const ix = Math.min(fillIn, Math.max(0, w/2 - 0.2));
      const iy = Math.min(fillIn, Math.max(0, h/2 - 0.2));
      return [r[0]+ix, r[1]+iy, r[2]-ix, r[3]-iy];
    };
    { const fb = shrink(band);
      pg.drawRectangle({ x:fb[0], y:H-fb[3], width:fb[2]-fb[0], height:fb[3]-fb[1], color:fillCol }); }
    // a text span is a single line; collapse any newlines the user typed so the
    // replacement stays on that line and can't flow downward past where the
    // original sat (and over the content below it)
    const text = (newText||"").replace(/[\r\n]+/g, " ");
    let substituted = false;
    if (text.trim() !== ""){
      // v11.37: the sheet can override size and colour. Both default to the
      // original, so an edit that touches neither is byte-identical to v11.36.
      // v11.57: on a SCAN, fit to the ink rather than to the OCR box (see
      // scanEditFit). scanFit is null unless this is an OCRed page and the
      // measurement succeeded, so every other document is untouched.
      const baseSize = opts.size != null ? opts.size
                     : (scanFit ? scanFit.size : (sp.size || 11));
      const colour = opts.colour || sp.color || [0,0,0];
      const y = H - (scanFit ? scanFit.originY : sp.origin[1]);   // baseline
      // TIER 1 (v11.29): type it in the document's own embedded font, so the
      // edited field is indistinguishable from the text around it. Silently
      // declines (returns null) for exotic encodings or a character the
      // embedded subset doesn't carry.
      const enc = fres && pdfFontStillOnPage(pg, fres.key) ? encodeWithPdfFont(fres, text) : null;
      if (enc){
        // v11.30: match the original's letter density, then shift by how much
        // longer/shorter the replacement is, so a right-aligned or centred
        // field stays lined up. Both widths are measured the same way, which
        // makes re-typing a field unchanged an exact no-op.
        const eo = encodeWithPdfFont(fres, sp.text);
        const natural = eo ? eo.width*baseSize : 0;
        const tc = eo ? trackingFor(sp, natural, eo.glyphs, baseSize) : 0;
        // the replacement carries the same per-glyph spacing
        const widthAt = s => trackedWidth(enc, s, tc);
        let drawSize = fitFontSizeWidth(enc.width, baseSize, avail);
        if (widthAt(drawSize) > avail && widthAt(drawSize) > 0)
          drawSize = Math.max(baseSize*0.5, drawSize * avail / widthAt(drawSize));
        const newW  = widthAt(drawSize);
        const origW = tc ? (sp.x1 - sp.x0) : (eo ? natural : (sp.x1 - sp.x0));
        drawWithPdfFont(pg, fres, enc.hex, drawXFor(align, sp.origin[0], origW, newW),
                        y, drawSize, colour, tc);
      } else {
        // TIER 2: base-14 substitution, as before
        const font = await doc.embedFont(pickFontKeyed(sp.font, opts.font));
        const safe = sanitizeForFont(text);
        substituted = safe !== text;     // some glyphs fell outside the base font
        const drawSize = fitFontSize(font, safe, baseSize, avail);   // shrink only if it would collide
        let drawn = sp.x1 - sp.x0, origW = drawn;
        try { drawn = font.widthOfTextAtSize(safe, drawSize);
              origW = font.widthOfTextAtSize(sanitizeForFont(sp.text), baseSize); } catch(e){}
        pg.drawText(safe, { x:drawXFor(align, sp.origin[0], origW, drawn), y, size:drawSize,
                            font, color:rgb(colour[0],colour[1],colour[2]), lineHeight:drawSize*1.15 });
      }
    }
    workingBytes = new Uint8Array(await doc.save());
    reopen();
    setMode("text");
    await render();
    setStatus("Text updated on page "+(pageIndex+1)+"."
      + (substituted ? " Note: some characters aren't available in the matched font and were shown as “?”." : ""), "ok");
  } catch(e){ setStatus("Could not change the text: "+friendly(e),"err"); }
  showSpin(false);
}
// pdf-lib standard fonts are WinAnsi; drop characters they can't encode so a
// stray glyph never aborts the whole edit.
function sanitizeForFont(t){ return t.replace(/[^\x09\x0A\x0D\x20-\xFF]/g, "?"); }

// ---- v11.47 (Phase 5): fill real form fields (AcroForm) --------------------
// Until now a fillable form could only be drawn on top of. This fills the
// ACTUAL fields via pdf-lib's form API, so the values are readable by
// Acrobat, Preview, and every system the form gets submitted to. Field types
// covered: text, checkbox, radio group, dropdown / option list. Push buttons
// and signature fields are shown but reported as not fillable here.
//
// The vendored pdf-lib is minified, so field TYPE is detected by capability
// (duck typing), never by constructor name.
let formFields = null, formFieldsEpoch = -1;
function formKindOf(f){
  if (typeof f.setText === "function" && typeof f.getText === "function") return "text";
  if (typeof f.check === "function" && typeof f.isChecked === "function") return "checkbox";
  if (typeof f.select === "function" && typeof f.getOptions === "function")
    return (typeof f.isEditable === "function" || typeof f.isMultiselect === "function") ? "dropdown" : "radio";
  return "other";
}
async function collectFormFields(){
  if (formFields && formFieldsEpoch === epoch) return formFields;
  formFields = []; formFieldsEpoch = epoch;
  if (!workingBytes) return formFields;
  try {
    const doc = await PDFDocument.load(workingBytes, { ignoreEncryption:true });
    const pages = doc.getPages();
    const refTag = r => r ? String(r) : "";
    const pageIdxOf = ref=>{
      const t = refTag(ref);
      for (let i=0;i<pages.length;i++) if (refTag(pages[i].ref) === t) return i;
      return 0;
    };
    let form = null;
    try { form = doc.getForm(); } catch(e){ return formFields; }
    for (const f of form.getFields()){
      const kind = formKindOf(f);
      let value = "", options = null;
      try {
        if (kind === "text") value = f.getText() || "";
        else if (kind === "checkbox") value = f.isChecked() ? "on" : "";
        else if (kind === "radio"){ value = f.getSelected() || ""; options = f.getOptions(); }
        else if (kind === "dropdown"){
          const s = f.getSelected(); value = Array.isArray(s) ? (s[0]||"") : (s||"");
          options = f.getOptions();
        }
      } catch(e){}
      let widgets = [];
      try { widgets = f.acroField.getWidgets(); } catch(e){}
      widgets.forEach((w, wi)=>{
        try {
          const r = w.getRectangle();
          let pg = 0;
          try { pg = pageIdxOf(w.P()); } catch(e){}
          const pageH = pages[pg].getHeight();
          formFields.push({
            name: f.getName(), kind, value, options,
            // radio: each widget is one option; exported value comes from the
            // widget's appearance states so the right option can be shown
            widget: wi, page: pg,
            x: r.x, w: r.width, h: r.height,
            yTop: pageH - (r.y + r.height),      // top-based, like css
          });
        } catch(e){}
      });
    }
  } catch(e){ /* an unreadable form reads as no fields */ }
  return formFields;
}
async function enterFormMode(){
  const ff = await collectFormFields();
  if (mode !== "form") return;                       // user already left
  if (!ff.length){
    setStatus("No fillable form fields in this document. (Use Edit text to add text, or Sign to place a signature.)","warn");
    return;
  }
  document.querySelectorAll(".stage").forEach(s=>{
    if (s.dataset.rendered) buildFormBoxes(s, +s.dataset.page).catch(()=>{});
  });
  setStatus(ff.length+" form field"+(ff.length>1?"s":"")+" — tap one to fill it. Values are saved into the real field, readable by any PDF app.","ok");
}
async function buildFormBoxes(stage, pageIndex){
  const ff = await collectFormFields();
  const ovl = stage.querySelector(".ovl");
  if (!ovl) return;
  ovl.querySelectorAll(".fbox").forEach(b=>b.remove());
  const wPt = +stage.dataset.wpt, dispW = parseFloat(stage.style.width);
  if (!wPt || !dispW) return;
  const s = dispW / wPt;
  for (const fd of ff){
    if (fd.page !== pageIndex) continue;
    const b = document.createElement("button");
    b.className = "fbox";
    b.setAttribute("aria-label", "Fill field: "+fd.name);
    b.style.left = (fd.x*s)+"px";
    b.style.top  = (fd.yTop*s)+"px";
    b.style.width  = Math.max(14, fd.w*s)+"px";
    b.style.height = Math.max(14, fd.h*s)+"px";
    b.onclick = (ev)=>{ ev.stopPropagation(); openFormFieldSheet(fd); };
    ovl.appendChild(b);
  }
}
function openFormFieldSheet(fd){
  if (fd.kind === "checkbox"){
    // a checkbox is one tap — no sheet, exactly like a real form
    applyFormFill(fd, fd.value ? "" : "on");
    return;
  }
  if (fd.kind === "other"){
    setStatus("“"+fd.name+"” is a button or signature field — it holds no fillable value. Use Sign to place a signature image.","warn");
    return;
  }
  if (fd.kind === "text"){
    $("sheet").innerHTML = h`
      <h3>Fill: ${fd.name}</h3>
      <p class="hint">Typed into the real form field — any PDF app will read it.</p>
      <div class="row"><textarea id="ffIn"></textarea></div>
      <div class="row"><button class="full" id="ffOk">Save into the form</button></div>
      <div class="row"><button class="ghost full" id="ffCancel">Cancel</button></div>`;
    $("ffIn").value = fd.value || "";
    $("ffOk").onclick = ()=>{ const v=$("ffIn").value; closeSheet(); applyFormFill(fd, v); };
    $("ffCancel").onclick = closeSheet;
    openSheet();
    setTimeout(()=>{ try{ $("ffIn").focus(); }catch(e){} }, 100);
    return;
  }
  // radio / dropdown: pick one option. Option strings come from the document,
  // so they are escaped before being placed in markup.
  const esc = s => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  const opts = (fd.options||[]).map(o=>
    `<div class="row"><button class="${o===fd.value?"":"ghost "}full" data-o="${esc(o)}">${o===fd.value?"✓ ":""}${esc(o)}</button></div>`).join("");
  $("sheet").innerHTML = h`
    <h3>Choose: ${fd.name}</h3>
    ${raw(opts || '<p class="hint">This field lists no options.</p>')}
    <div class="row"><button class="ghost full" id="ffCancel">Cancel</button></div>`;
  $("sheet").querySelectorAll("[data-o]").forEach(b=>
    b.onclick = ()=>{ const v=b.dataset.o; closeSheet(); applyFormFill(fd, v); });
  $("ffCancel").onclick = closeSheet;
  openSheet();
}
async function applyFormFill(fd, value){
  showSpin(true,"Saving into the form…");
  try {
    pushUndo();
    const doc = await PDFDocument.load(workingBytes, { ignoreEncryption:true });
    const form = doc.getForm();
    const f = form.getFields().find(x=>x.getName() === fd.name);
    if (!f) throw new Error("field not found: "+fd.name);
    const kind = formKindOf(f);
    if (kind === "text") f.setText(String(value||""));
    else if (kind === "checkbox"){ value ? f.check() : f.uncheck(); }
    else if (kind === "radio" || kind === "dropdown"){ if (value) f.select(value); }
    // regenerate appearances so the value is VISIBLE everywhere, not only in
    // apps that honour NeedAppearances
    try { form.updateFieldAppearances(await doc.embedFont(StandardFonts.Helvetica)); } catch(e){}
    workingBytes = new Uint8Array(await doc.save());
    formFields = null;                       // reparse next build
    reopen(); setMode("form"); await render();
    setStatus("Saved “"+fd.name+"” — tap more fields, or Save the document when done.","ok");
  } catch(e){ setStatus("Could not fill that field: "+friendly(e),"err"); }
  showSpin(false);
}
// Flatten: fields become permanent page content. The one-way door is stated,
// and it is a separate deliberate action, never a side effect.
async function flattenForm(){
  showSpin(true,"Flattening the form…");
  try {
    const doc = await PDFDocument.load(workingBytes, { ignoreEncryption:true });
    let form = null;
    try { form = doc.getForm(); } catch(e){}
    if (!form || !form.getFields().length){
      showSpin(false); setStatus("No form fields to flatten in this document.","warn"); return;
    }
    pushUndo();
    try { form.updateFieldAppearances(await doc.embedFont(StandardFonts.Helvetica)); } catch(e){}
    form.flatten();
    workingBytes = new Uint8Array(await doc.save());
    formFields = null;
    reopen(); setMode(null); await render();
    setStatus("Form flattened — the values are now permanent page content and the fields are gone. Undo reverses it.","ok");
  } catch(e){ setStatus("Could not flatten the form: "+friendly(e),"err"); }
  showSpin(false);
}
$("formBtn").onclick = ()=> setMode(mode==="form" ? null : "form");

// ---- v11.48 (Phase 6): OCR — recognise text in scanned pages ---------------
// On-device Tesseract (LSTM, WASM), vendored like the PDF engine: no cloud,
// no account, cached after the first use. The output is Acrobat's "searchable
// PDF": an INVISIBLE text layer laid word-by-word over the page image, so the
// scan looks identical but Find, Select, and copy all work — in this app and
// in every other PDF viewer.
//
// A plain statement, kept from the roadmap: Adobe's own OCR engine is
// proprietary and cannot be licensed or rebuilt; Tesseract 5 is what every
// serious non-Adobe tool uses. On clean ~250dpi captures its accuracy is
// close; capture quality (v11.41's work) matters more than the engine.
const OCR_RENDER_MAX = 2600;    // raster long side for recognition (memory cap)
const OCR_SKIP_CHARS = 20;      // a page already carrying this much text is skipped
let ocrBusy = false;
function loadScriptOnce(src){
  return new Promise((res, rej)=>{
    if (document.querySelector('script[src="'+src+'"]')) return res();
    const s = document.createElement("script");
    s.src = src; s.onload = ()=>res(); s.onerror = ()=>rej(new Error("could not load "+src));
    document.head.appendChild(s);
  });
}
// Convert one recognised word into the drawText call that places its
// invisible twin. Pure, so the maths is testable in Node: bbox is in raster
// px, scale is raster px per PDF pt, pageH in pt. The word is drawn at the
// box's baseline (slightly above its bottom edge) at the box's own height.
// v11.55: draw a run in PDF render mode 3 (invisible) with a horizontal scale,
// so an OCR word occupies exactly the width of the ink it stands for. Render
// mode 3 is what a searchable PDF is meant to use; an alpha of 0 relies on the
// viewer honouring transparency, and it also left the run at its natural width,
// which is what made Find highlight into the next word.
function drawInvisibleText(pg, fontKey, text, x, y, size, zoomPct){
  const O = PDFOperator.of.bind(PDFOperator), N = PDFNumber.of.bind(PDFNumber);
  const z = Math.max(1, Math.min(1000, zoomPct || 100));
  // Helvetica here is a SIMPLE font, so its strings are single-byte
  // (WinAnsi). PDFHexString.fromText would encode UTF-16, which such a font
  // decodes as nonsense — the layer would exist and extract as garbage. Build
  // the hex a byte at a time instead.
  let hex = "";
  for (let i=0;i<text.length;i++){
    const c = text.charCodeAt(i) & 0xFF;
    hex += (c < 16 ? "0" : "") + c.toString(16);
  }
  if (!hex) return;
  pg.pushOperators(
    O("q",  []),
    O("BT", []),
    O("Tr", [N(3)]),                       // invisible: no fill, no stroke
    O("Tz", [N(+z.toFixed(2))]),           // fit the run to the printed word
    O("Tf", [fontKey, N(size)]),
    O("Tm", [N(1), N(0), N(0), N(1), N(x), N(y)]),
    O("Tj", [PDFHexString.of(hex)]),
    O("ET", []),
    O("Q",  [])
  );
}
function ocrWordPlacement(bbox, scale, pageH){
  const hPt = Math.max(2, (bbox.y1 - bbox.y0) / scale);
  return {
    x: bbox.x0 / scale,
    y: pageH - (bbox.y1 / scale) + hPt * 0.18,   // baseline ≈ 18% above box bottom
    size: hPt,
  };
}
// v11.59: is this page a photograph of something (a scan), or type?
// Counting characters is not enough, and a real document proved it: a mixed
// PDF had a scanned page carrying nothing but the page numbers this app had
// stamped on it — 32 characters, over the 20-character "already has text"
// line, so OCR skipped the page and reported nothing to do. A scan is
// identified by what it IS: a raster covering the sheet.
function pageHasBigImage(i){
  try {
    const dict = MDOC.findPage(i);
    const res = dict && dict.get("Resources");
    if (!res || res.isNull()) return false;
    const xo = res.get("XObject");
    if (!xo || xo.isNull()) return false;
    const p = MDOC.loadPage(i);
    const [x0,y0,x1,y1] = p.getBounds();
    p.destroy();
    const pageAt150 = ((x1-x0)/72*150) * ((y1-y0)/72*150);
    if (!(pageAt150 > 0)) return false;
    let biggest = 0;
    xo.forEach((v)=>{
      try {
        if (String(v.get("Subtype")||"").replace(/^\//,"") !== "Image") return;
        const w = v.get("Width").asNumber(), h = v.get("Height").asNumber();
        if (w*h > biggest) biggest = w*h;
      } catch(e){}
    });
    // a page-filling scan measured 1.2–1.4 of the page's own pixel count at
    // 150dpi; a letterhead logo measured 0.07
    return biggest >= pageAt150 * 0.35;
  } catch(e){ return false; }
}
function pageCharCount(i){
  try {
    const page = MDOC.loadPage(i);
    const st = page.toStructuredText("preserve-spans");
    let c = 0; st.walk({ onChar(ch){ if (ch && ch.trim()) c++; } });
    st.destroy(); page.destroy();
    return c;
  } catch(e){ return 0; }
}
//   "scan"      a photographed page with no real text  -> recognise
//   "scan-done" a photographed page that already has text (ours, or another
//               app's) -> offer to do it again rather than silently skipping
//   "text"      type, not a photograph -> leave alone
//   "blank"     neither -> nothing to recognise
function pageOcrKind(i){
  const big = pageHasBigImage(i), chars = pageCharCount(i);
  if (!big) return chars < OCR_SKIP_CHARS ? "blank" : "text";
  return chars < OCR_SKIP_CHARS ? "scan" : "scan-done";
}
async function runOcr(){
  if (!workingBytes || ocrBusy) return;
  const n = MDOC.countPages();
  const todo = [], redo = [];
  for (let i=0;i<n;i++){
    const k = pageOcrKind(i);
    if (k === "scan") todo.push(i);
    else if (k === "scan-done") redo.push(i);
  }
  if (!todo.length && !redo.length){
    setStatus(n > 1
      ? "No scanned pages found — every page in this document is already type, not a photograph."
      : "This page is already type, not a photograph — there is nothing to recognise.","ok");
    return;
  }
  if (!todo.length && redo.length){
    // everything scanned has been done before; offer the redo rather than
    // reporting "nothing to do", which is what the old code did
    $("sheet").innerHTML = h`
      <h3>Already recognised</h3>
      <p class="hint">All ${redo.length} scanned page${redo.length>1?"s":""} in this document already carry recognised text. You can run it again — useful if the first pass was poor, or was done by an older version of this app.</p>
      <div class="row"><button class="full" id="ocAgain">Recognise ${redo.length} page${redo.length>1?"s":""} again</button></div>
      <div class="row"><button class="ghost full" id="ocNo2">Cancel</button></div>`;
    $("ocAgain").onclick = ()=>{ closeSheet(); doOcr(redo); };
    $("ocNo2").onclick = closeSheet;
    openSheet();
    return;
  }
  $("sheet").innerHTML = h`
    <h3>Recognise text (OCR)</h3>
    <p class="hint">${todo.length} of ${n} page${n>1?"s":""} ${todo.length===1?"is a scan with":"are scans with"} no text yet. Each gets an invisible text layer laid over the image, so the document becomes searchable and selectable — here and in any PDF app. Pages that are already type are left alone. Runs entirely on this device (English). The first use downloads the recogniser (~17 MB, kept for next time). Roughly a few seconds per page.</p>
    ${raw(redo.length ? `<p class="hint">${redo.length} other scanned page${redo.length>1?"s":""} already ${redo.length>1?"carry":"carries"} recognised text.</p>` : "")}
    <div class="row"><button class="full" id="ocGo">Recognise ${todo.length} page${todo.length>1?"s":""}</button></div>
    ${raw(redo.length ? `<div class="row"><button class="full" id="ocAll">Do those ${redo.length} again as well</button></div>` : "")}
    <div class="row"><button class="ghost full" id="ocNo">Cancel</button></div>`;
  $("ocGo").onclick = ()=>{ closeSheet(); doOcr(todo); };
  if (redo.length) $("ocAll").onclick = ()=>{ closeSheet(); doOcr(todo.concat(redo).sort((a,b)=>a-b)); };
  $("ocNo").onclick = closeSheet;
  openSheet();
}
async function doOcr(todo){
  ocrBusy = true;
  let worker = null;
  showSpin(true,"Loading the text recogniser…");
  try {
    await loadScriptOnce("./vendor/ocr/tesseract.min.js");
    worker = await Tesseract.createWorker("eng", 1, {
      workerPath: "./vendor/ocr/worker.min.js",
      corePath:   "./vendor/ocr",
      langPath:   "./vendor/ocr",
      gzip: true,
    });
    const doc = await PDFDocument.load(workingBytes, { ignoreEncryption:true });
    const helv = await doc.embedFont(StandardFonts.Helvetica);
    // resource name for the raw-operator draws below (one per page, cached)
    const helvKeyFor = new Map();
    const keyOf = pg => {
      if (!helvKeyFor.has(pg)) helvKeyFor.set(pg, pg.node.newFontDictionary(helv.name, helv.ref));
      return helvKeyFor.get(pg);
    };
    let words = 0, pagesDone = 0;
    for (let k=0;k<todo.length;k++){
      const i = todo[k];
      showSpin(true,"Recognising… page "+(k+1)+" of "+todo.length);
      await new Promise(r=>setTimeout(r,0));
      // render the page for recognition
      const page = MDOC.loadPage(i);
      const [x0,y0,x1,y1] = page.getBounds();
      const wPt = x1-x0, hPt = y1-y0;
      const scale = Math.min(300/72, OCR_RENDER_MAX/Math.max(wPt,hPt));
      const pix = page.toPixmap(mupdf.Matrix.scale(scale,scale), mupdf.ColorSpace.DeviceRGB, false);
      const pngBin = u8(pix.asPNG());
      pix.destroy(); page.destroy();
      const blobUrl = URL.createObjectURL(new Blob([pngBin], { type:"image/png" }));
      let data = null;
      try {
        const r = await worker.recognize(blobUrl, {}, { blocks:true });
        data = r.data;
      } finally { URL.revokeObjectURL(blobUrl); }
      const pg = doc.getPage(i);
      const pageH = pg.getHeight();
      const ws = (data && data.blocks || []).flatMap(b=>(b.paragraphs||[])
        .flatMap(p=>(p.lines||[]).flatMap(l=>l.words||[])));
      for (const wd of ws){
        const t = (wd.text||"").trim();
        if (!t || (wd.confidence||0) < 40) continue;   // noise threshold
        const pl = ocrWordPlacement(wd.bbox, scale, pageH);
        try {
          // v11.55: lay the word into EXACTLY the width the printed word
          // occupies. Drawing it at its natural width made the invisible run
          // wider than the ink, so searching "money" highlighted a box that
          // reached into "RECEIPT" beside it. Horizontal scaling (Tz) fits the
          // run to its own box, and render mode 3 is the proper way to make
          // OCR text invisible — it is what a searchable PDF is supposed to
          // use, and unlike an alpha of 0 it cannot be defeated by a viewer
          // that ignores transparency.
          const safe = sanitizeForFont(t);
          const boxW = Math.max(0.5, (wd.bbox.x1 - wd.bbox.x0) / scale);
          const natural = helv.widthOfTextAtSize(safe, pl.size) || boxW;
          drawInvisibleText(pg, keyOf(pg), safe, pl.x, pl.y, pl.size, (boxW/natural)*100);
          words++;
        } catch(e){}
      }
      pagesDone++;
    }
    if (!words){
      setStatus("No readable text was found on the scanned page"+(todo.length>1?"s":"")+" — if the scan is faint or skewed, rescan closer and straighter.","warn");
      return;
    }
    pushUndo();
    // v11.50: mark the document as OCRed, in its own metadata so the mark
    // survives save/reopen. Two things depend on knowing this:
    //   * the renderer must keep using JPEG. usePng is gated on docHasText(),
    //     which OCR flips to true — and PNG on a full-page scan is 3–5x larger
    //     and slower to encode for no visible gain (the v10.94 finding).
    //   * Edit text can explain that a tapped word came from recognition and
    //     will be retyped in a standard face.
    try {
      const kw = (doc.getKeywords ? (doc.getKeywords()||"") : "");
      if (!/PyPDF-OCR/.test(kw))
        doc.setKeywords([kw, "PyPDF-OCR"].filter(Boolean).join(" "));
    } catch(e){}
    workingBytes = new Uint8Array(await doc.save());
    reopen(); await render();
    setStatus("Recognised "+words+" word"+(words>1?"s":"")+" across "+pagesDone+" page"
      +(pagesDone>1?"s":"")+" — Find, Select and copy now work here and in any PDF app, and Edit text can now change the words on the scan. Undo removes it.","ok");
  } catch(e){ setStatus("Could not recognise text: "+friendly(e),"err"); }
  finally {
    try { if (worker) await worker.terminate(); } catch(e){}
    ocrBusy = false;
    showSpin(false);
  }
}

// ---- v11.54: match the scanned typeface when editing a scan ---------------
// v11.50 made scanned words editable but retyped every one in Helvetica, so a
// changed word on a serif document stood out. Adobe solves this with
// proprietary font synthesis, which cannot be licensed or rebuilt. What CAN
// be done honestly is to pick the closest of the faces we do have, and to
// pick it by MEASUREMENT rather than by guessing: the word's own ink is
// compared against the same word rendered in each candidate, and the best fit
// wins. Everything below is pure or engine-injected, so the matcher is driven
// directly by tests.
const SCAN_FACES = [
  { key:"sans",   font:"Helvetica" },
  { key:"sansb",  font:"Helvetica-Bold" },
  { key:"serif",  font:"Times-Roman" },
  { key:"serifb", font:"Times-Bold" },
  { key:"mono",   font:"Courier" },
];
function scanFaceFont(key){
  const F = StandardFonts;
  return key === "sansb"  ? F.HelveticaBold
       : key === "serif"  ? F.TimesRoman
       : key === "serifb" ? F.TimesRomanBold
       : key === "mono"   ? F.Courier
                          : F.Helvetica;
}
// Ink mask from raw RGB(A) bytes: 1 where there is ink. The cut is relative to
// the brightest tone present, because scanned paper is never pure white.
function inkMaskFrom(bytes, w, h, stride, n){
  let peak = 0;
  for (let y=0;y<h;y++) for (let x=0;x<w;x++){
    const i=y*stride+x*n, g=(bytes[i]*77+bytes[i+1]*151+bytes[i+2]*28)>>8;
    if (g > peak) peak = g;
  }
  const cut = Math.max(24, peak - 60);
  const m = new Uint8Array(w*h);
  for (let y=0;y<h;y++) for (let x=0;x<w;x++){
    const i=y*stride+x*n, g=(bytes[i]*77+bytes[i+1]*151+bytes[i+2]*28)>>8;
    m[y*w+x] = g < cut ? 1 : 0;
  }
  return { m, w, h };
}
// Crop to the ink, then scale to a fixed HEIGHT while keeping the aspect —
// keeping width is the point: Courier's wide advance is a real signal, and
// normalising it away would throw the monospace case out with the noise.
function normaliseInk(mask, H){
  const { m, w, h } = mask;
  let x0=w, y0=h, x1=-1, y1=-1;
  for (let y=0;y<h;y++) for (let x=0;x<w;x++) if (m[y*w+x]){
    if (x<x0) x0=x; if (x>x1) x1=x; if (y<y0) y0=y; if (y>y1) y1=y;
  }
  if (x1 < 0) return null;
  const cw = x1-x0+1, ch = y1-y0+1;
  const TH = H, TW = Math.max(1, Math.round(cw * H / ch));
  const out = new Uint8Array(TW*TH);
  for (let y=0;y<TH;y++){
    const sy = y0 + Math.min(ch-1, Math.floor(y*ch/TH));
    for (let x=0;x<TW;x++){
      const sx = x0 + Math.min(cw-1, Math.floor(x*cw/TW));
      out[y*TW+x] = m[sy*w+sx];
    }
  }
  return { m:out, w:TW, h:TH };
}
// Intersection over union of two normalised masks, compared on a shared
// canvas so a width difference counts against the match rather than being
// silently cropped away.
function inkAgreement(a, b){
  if (!a || !b) return 0;
  const W = Math.max(a.w, b.w), H = Math.max(a.h, b.h);
  let inter = 0, uni = 0;
  for (let y=0;y<H;y++) for (let x=0;x<W;x++){
    const av = (x<a.w && y<a.h) ? a.m[y*a.w+x] : 0;
    const bv = (x<b.w && y<b.h) ? b.m[y*b.w+x] : 0;
    if (av && bv) inter++;
    if (av || bv) uni++;
  }
  return uni ? inter/uni : 0;
}
// Render `text` in one candidate face and return its normalised ink mask.
async function faceInkMask(text, key, eng, H){
  const doc = await eng.PDFDocument.create();
  const size = 48;
  const font = await doc.embedFont(scanFaceFont(key));
  const tw = Math.max(4, font.widthOfTextAtSize(text, size));
  const pg = doc.addPage([tw + 20, size*1.8]);
  pg.drawText(text, { x:10, y:size*0.5, size, font });
  const bytes = new Uint8Array(await doc.save());
  const d = eng.mupdf.Document.openDocument(bytes.slice(0), "application/pdf").asPDF();
  const p = d.loadPage(0);
  const pix = p.toPixmap(eng.mupdf.Matrix.scale(2,2), eng.mupdf.ColorSpace.DeviceRGB, false);
  const mask = inkMaskFrom(pix.getPixels(), pix.getWidth(), pix.getHeight(),
                           pix.getStride(), pix.getNumberOfComponents());
  pix.destroy(); p.destroy(); d.destroy();
  return normaliseInk(mask, H);
}
// Which of our faces does this scanned word look most like? Returns null when
// the answer is not clear enough to act on — declining is free, and guessing
// wrong is exactly the complaint this feature exists to reduce.
async function matchScanFace(text, targetMask, eng){
  const t = String(text||"").trim();
  if (t.length < 3 || !targetMask) return null;      // too little shape to judge
  const H = 40;
  const target = normaliseInk(targetMask, H);
  if (!target) return null;
  const scored = [];
  for (const c of SCAN_FACES){
    try { scored.push({ key:c.key, score: inkAgreement(target, await faceInkMask(t, c.key, eng, H)) }); }
    catch(e){}
  }
  if (scored.length < 2) return null;
  scored.sort((a,b)=>b.score-a.score);
  const best = scored[0], next = scored[1];
  if (best.score < 0.45) return null;                 // nothing fits well
  if (best.score - next.score < 0.02) return null;    // a coin toss between two
  return best;
}
// v11.57: render ONLY the word's own rectangle, through a draw device clipped
// to it. The v11.54 version rasterised the WHOLE PAGE at up to 8× to look at
// one word — 3570×5052 pixels (≈72 MB) to inspect a patch of 398×85. On a
// phone that either failed outright or was killed for memory, and because the
// caller swallows exceptions the only symptom was the typeface silently
// falling back to plain Helvetica. Same picture, 530× less of it.
// Returns the mask plus where it sits on the page, so sizes can be measured
// in points rather than guessed from the OCR box.
function clipInkMask(pageIndex, rectPt, targetInkPx){
  let page = null, pm = null, dev = null;
  try {
    page = MDOC.loadPage(pageIndex);
    const hPt = Math.max(0.5, rectPt[3]-rectPt[1]);
    const s = Math.max(2, Math.min(12, (targetInkPx || 44) / hPt));
    const bbox = [Math.floor(rectPt[0]*s), Math.floor(rectPt[1]*s),
                  Math.ceil(rectPt[2]*s),  Math.ceil(rectPt[3]*s)];
    if (bbox[2]-bbox[0] < 4 || bbox[3]-bbox[1] < 4) return null;
    pm = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, bbox, false);
    pm.clear(255);
    dev = new mupdf.DrawDevice(mupdf.Matrix.scale(s,s), pm);
    page.run(dev, mupdf.Matrix.identity);
    dev.close();
    const W = pm.getWidth(), H = pm.getHeight(), St = pm.getStride(), n = pm.getNumberOfComponents();
    const mask = inkMaskFrom(pm.getPixels(), W, H, St, n);
    return mask ? Object.assign(mask, { s, x0Pt: bbox[0]/s, y0Pt: bbox[1]/s }) : null;
  } catch(e){ return null; }
  finally {
    try{ if(dev) dev.close(); }catch(e){}
    try{ if(pm) pm.destroy(); }catch(e){}
    try{ if(page) page.destroy(); }catch(e){}
  }
}
// The ink of one span, straight off the page, ready for matchScanFace.
function spanInkMask(pageIndex, sp){
  return clipInkMask(pageIndex, [sp.x0-1, sp.y0-1, sp.x1+1, sp.y1+1], 44);
}
// Where the printed word's ink actually sits, in page points.
//
// v11.58: measured from the ROW PROFILE, not from the outermost ink pixel.
// The outermost pixel is whatever strayed into the box — the descender of the
// line above, a table rule, a speck of scanner noise — and one such row made
// the measured height too large, which is how a retyped word came out
// noticeably bigger than its neighbours. Rows carrying less than a twelfth of
// the busiest row's ink are treated as strays and skipped; the real body of a
// word is many rows of substantial ink, so this cannot trim the word itself.
function inkExtentPt(mask){
  if (!mask) return null;
  const { m, w, h, s, x0Pt, y0Pt } = mask;
  const rows = new Int32Array(h);
  let left=w, right=-1, any=0;
  for (let y=0;y<h;y++){
    let c = 0;
    for (let x=0;x<w;x++) if (m[y*w+x]){
      c++;
      if (x<left) left=x; if (x>right) right=x;
    }
    rows[y] = c; if (c) any++;
  }
  if (!any || right < 0) return null;
  // Grow outwards from the densest row — the x-height band, which is always
  // part of the word — and stop at the first genuinely blank row. Ascenders
  // and descenders are joined to that band with no gap, so they are kept in
  // full; a speck from the line above sits beyond a blank row, so it is left
  // out. Thresholding by row density instead would have trimmed the sparse
  // cap and ascender rows, which measured 9.3pt for 11pt print.
  let peakRow = 0;
  for (let y=1;y<h;y++) if (rows[y] > rows[peakRow]) peakRow = y;
  let top = peakRow, bot = peakRow;
  while (top > 0 && rows[top-1] > 0) top--;
  while (bot < h-1 && rows[bot+1] > 0) bot++;
  return { topPt: y0Pt + top/s, botPt: y0Pt + (bot+1)/s,
           leftPt: x0Pt + left/s, rightPt: x0Pt + (right+1)/s,
           hPt: (bot-top+1)/s, wPt: (right-left+1)/s };
}
// How tall is `text` in this face, and how far does it fall below the
// baseline? Measured by drawing it and looking, because the answer depends on
// the actual letters: "Antra" has no descender, "Payment" does.
async function measureFaceInk(text, key, eng, size){
  const doc = await eng.PDFDocument.create();
  const font = await doc.embedFont(scanFaceFont(key));
  const w = Math.max(8, font.widthOfTextAtSize(text, size));
  const base = size*1.5;
  const pg = doc.addPage([w + size, size*3]);
  pg.drawText(text, { x:size*0.5, y:base, size, font });
  const bytes = new Uint8Array(await doc.save());
  const d = eng.mupdf.Document.openDocument(bytes.slice(0), "application/pdf").asPDF();
  const p = d.loadPage(0);
  const S = 4;
  const pix = p.toPixmap(eng.mupdf.Matrix.scale(S,S), eng.mupdf.ColorSpace.DeviceRGB, false);
  const W=pix.getWidth(), H=pix.getHeight(), St=pix.getStride(), n=pix.getNumberOfComponents(), px=pix.getPixels();
  let top=H, bot=-1;
  for (let y=0;y<H;y++) for (let x=0;x<W;x++){
    const i=y*St+x*n;
    if (((px[i]*77+px[i+1]*151+px[i+2]*28)>>8) < 140){ if(y<top)top=y; if(y>bot)bot=y; }
  }
  pix.destroy(); p.destroy(); d.destroy();
  if (bot < 0) return null;
  const pageH = size*3;
  // page y of the ink, converted back to "distance from the baseline"
  const inkTopY = pageH - top/S, inkBotY = pageH - (bot+1)/S;
  return { hPt: (bot-top+1)/S, above: inkTopY - base, below: base - inkBotY };
}
// Size and baseline for a replacement on a SCAN, fitted to the ink that is
// actually printed rather than to the OCR box. The OCR box is the wrong ruler:
// it is the recogniser's bounding box, so a word of capitals and a word with a
// descender of the same point size get very different boxes — which is how a
// retyped word ended up visibly larger than its neighbours.
async function scanEditFit(pageIndex, sp, text, faceKey, eng){
  try {
    const mask = spanInkMask(pageIndex, sp);
    const ink = inkExtentPt(mask);
    if (!ink || !(ink.hPt > 0.5)) return null;
    const REF = 40;
    const ref = await measureFaceInk(text, faceKey, eng, REF);
    if (!ref || !(ref.hPt > 0.5)) return null;
    let size = REF * (ink.hPt / ref.hPt);
    if (!(size > 1) || size > 400) return null;
    // a sanity band: never more than a third away from what the OCR box implied
    const implied = sp.size || size;
    if (size > implied*2.2 || size < implied*0.45) return null;
    const below = ref.below * (size/REF);
    return { size, originY: ink.botPt - below };
  } catch(e){ return null; }
}

// ---- v11.53: straighten sideways pages ------------------------------------
// v11.33 wrote down why this could not be done then: "a landscape certificate
// and a sideways capture of a portrait sheet produce identical geometry;
// distinguishing them needs to read text direction, which is an OCR job." The
// OCR arrived in v11.48, so the job is now doable — and it is done with
// Tesseract's orientation model (osd), not with the page's shape.
//
// The correction is applied as /Rotate, which is lossless: no pixel is
// re-encoded, the scan keeps every bit of its quality, and Undo reverses it.
//
// Measured on a page turned each way: the model's orientation_degrees IS the
// /Rotate value to apply, and all four cases come back upright afterwards.
const AUTOROT_MIN_CONF = 2;    // below this the model is guessing; leave the page alone
async function runAutoRotate(){
  if (!workingBytes || !MDOC || ocrBusy) return;
  const n = MDOC.countPages();
  $("sheet").innerHTML = h`
    <h3>Straighten pages</h3>
    <p class="hint">Reads the direction of the text on each of the ${n} page${n>1?"s":""} and turns any that are sideways or upside down. It decides from the words, not the page shape, so a genuinely landscape page is left alone.</p>
    <p class="hint">The turn is recorded, not re-drawn, so a scan loses no quality. Undo reverses it. Runs on this device; the first use downloads the orientation model (~4 MB, kept for next time).</p>
    <div class="row"><button class="full" id="arGo">Straighten</button></div>
    <div class="row"><button class="ghost full" id="arNo">Cancel</button></div>`;
  $("arGo").onclick = ()=>{ closeSheet(); doAutoRotate(); };
  $("arNo").onclick = closeSheet;
  openSheet();
}
async function doAutoRotate(){
  ocrBusy = true;
  let worker = null;
  showSpin(true,"Loading the orientation model…");
  try {
    await loadScriptOnce("./vendor/ocr/tesseract.min.js");
    worker = await Tesseract.createWorker("osd", 0, {
      workerPath: "./vendor/ocr/worker.min.js",
      corePath:   "./vendor/ocr",
      langPath:   "./vendor/ocr",
      gzip: true,
    });
    const doc = await PDFDocument.load(workingBytes, { ignoreEncryption:true });
    const pages = doc.getPages();
    const n = MDOC.countPages();
    let fixed = 0, unsure = 0;
    for (let i=0;i<n;i++){
      showSpin(true,"Straightening… page "+(i+1)+" of "+n);
      await new Promise(r=>setTimeout(r,0));
      let deg = 0, conf = 0;
      try {
        const page = MDOC.loadPage(i);
        const [x0,y0,x1,y1] = page.getBounds();
        // ~150dpi: enough for the model to read letter shapes, cheap enough
        // to run over a long document
        const s = Math.min(150/72, 2000/Math.max(x1-x0, y1-y0));
        const pix = page.toPixmap(mupdf.Matrix.scale(s,s), mupdf.ColorSpace.DeviceRGB, false);
        const bin = u8(pix.asPNG());
        pix.destroy(); page.destroy();
        const url = URL.createObjectURL(new Blob([bin], { type:"image/png" }));
        try {
          const det = await worker.detect(url);
          deg  = (det && det.data && det.data.orientation_degrees) | 0;
          conf = (det && det.data && det.data.orientation_confidence) || 0;
        } finally { URL.revokeObjectURL(url); }
      } catch(e){ continue; }          // a page the model refuses is left alone
      if (!deg) continue;              // already upright
      if (conf < AUTOROT_MIN_CONF){ unsure++; continue; }
      // the render already had the page's existing /Rotate applied, so what
      // the model reports is the turn still NEEDED on top of it
      const pg = pages[i];
      const cur = (pg.getRotation && pg.getRotation().angle) || 0;
      pg.setRotation(degrees((((cur + deg) % 360) + 360) % 360));
      fixed++;
    }
    if (!fixed){
      setStatus(unsure
        ? "Left as they are — the text on "+unsure+" page"+(unsure>1?"s":"")+" was too faint to judge the direction."
        : "Every page is already the right way up.","ok");
      return;
    }
    pushUndo();
    workingBytes = new Uint8Array(await doc.save());
    reopen(); await render();
    setStatus("Straightened "+fixed+" page"+(fixed>1?"s":"")
      + (unsure ? " ("+unsure+" too faint to judge, left alone)" : "")
      + " — the turn is recorded, so no quality was lost. Undo reverses it.","ok");
  } catch(e){ setStatus("Could not straighten the pages: "+friendly(e),"err"); }
  finally {
    try { if (worker) await worker.terminate(); } catch(e){}
    ocrBusy = false;
    showSpin(false);
  }
}

// ---------------- modes ----------------
function setMode(m){
  mode = m;
  if (m !== "sign") insImgPlacing = false;   // v11.43: picture placement ends with the mode
  if (m) lastMarkupMode = m;           // v11.22: remember preferred tool for the session
  if (m && SEARCH.open) closeFind();   // v11.19: entering a mode closes search
  setImmersive(false);           // v11.10: entering any mode brings the chrome back
  $("textBtn").classList.toggle("on", m==="text");
  $("selectBtn").classList.toggle("on", m==="select");
  $("signBtn").classList.toggle("on", m==="sign");
  $("whiteBtn").classList.toggle("on", m==="white");           // v11.43
  $("formBtn").classList.toggle("on", m==="form");             // v11.47
  ["textBtn","selectBtn","signBtn"].forEach(id=>$(id).classList.remove("pref"));  // v11.22
  $("markupBtn").classList.toggle("on", !!m);    // v11.11: bar shows a mode is active
  $("mkMenu").hidden = true;
  $("viewer").classList.toggle("textmode", m==="text");
  $("viewer").classList.toggle("selmode", m==="select");
  $("viewer").classList.toggle("formmode", m==="form");        // v11.47
  // "white" (v11.43) shares the sign placement affordance: drag a box on a page
  document.querySelectorAll(".stage").forEach(s=>s.classList.toggle("placing", m==="sign" || m==="white"));
  if (m==="text"){
    // buildSpanBoxes is async; contain any rejection (e.g. a page that mupdf
    // can't read in a malformed PDF) so it never escapes as an uncaught
    // "Async error" — text editing simply skips that page.
    document.querySelectorAll(".stage").forEach(s=>{
      if (s.dataset.rendered) buildSpanBoxes(s, +s.dataset.page).catch(()=>{});
    });
    setStatus(docIsOcr()
      ? "Tap any recognised word to change it — it is erased from the scan and retyped. The new text uses a standard typeface, so it may not match the scanned print exactly."
      : "Tap any highlighted text to change it.","ok");
  } else if (m==="select"){
    // build the invisible selectable text layer over every already-rendered
    // page; pages scrolled into view later get theirs in renderStage
    let anyText = false;
    document.querySelectorAll(".stage").forEach(s=>{
      if (!s.dataset.rendered) return;
      try {
        buildTextLayer(s, +s.dataset.page);
        const t = s.querySelector(".txt");
        if (t && t.childElementCount){ s.classList.add("hastext"); anyText = true; }
      } catch(e){}
    });
    // v11.60: a scan that has never been recognised has nothing to select, and
    // iOS then treats the page as a picture — touch-and-hold grabs the whole
    // image and offers Copy, which is what "select text doesn't work" looked
    // like. Say what is actually going on and offer the thing that fixes it.
    if (!anyText && workingBytes && MDOC){
      setStatus("These pages are pictures, so there is no text to select yet — run More → Recognise text first.","warn");
      setTimeout(()=>{ if (mode === "select" && !ocrBusy) offerOcrForSelect(); }, 400);
    } else setStatus("Select any text, then copy it.","ok");
  } else if (m==="sign"){ setStatus(insImgPlacing
      ? "Drag a box where the picture should go."
      : "Drag a box where the signature should go.","ok"); }
  else if (m==="white"){ setStatus("Drag a box over what you want covered — it is painted solid white.","ok"); }
  else if (m==="form"){
    // async: the field list is parsed on first entry (cached per epoch)
    enterFormMode().catch(()=>{ setStatus("Could not read the form fields.","err"); });
  }
  else {
    setStatus("");               // v11.17: exiting a mode just clears the toast — no "Ready." flash
    // v11.21: back in view mode — rebuild the always-on text layer on pages
    // that lost it (e.g. edit mode replaced it with span boxes)
    if (workingBytes && MDOC && docHasText()){
      document.querySelectorAll(".stage").forEach(s=>{
        if (s.dataset.rendered) try { buildTextLayer(s, +s.dataset.page); s.classList.add("hastext"); } catch(e){}
      });
    }
  }
}

$("textBtn").onclick = ()=>{
  if (mode === "text"){ setMode(null); return; }
  setMode("text");
  maybeOfferOcrForEditing();          // v11.50
};
// v11.50: entering Edit text on a SCAN. Before this, edit mode on a scanned
// page simply highlighted nothing and said "tap any highlighted text" — with
// nothing to tap and no explanation. A scan has no text to edit until it is
// recognised, which the app can now do (v11.48), so say that and offer it.
// v11.60: the same offer, from Select mode.
function offerOcrForSelect(){
  if (!workingBytes || !MDOC || ocrBusy) return;
  $("sheet").innerHTML = h`
    <h3>Nothing to select yet</h3>
    <p class="hint">These pages are photographs, so there are no words for the app to hand you — touching and holding just picks up the whole picture. Recognising the text lays real, invisible words over the image; after that you can select and copy normally, and Find works too.</p>
    <div class="row"><button class="full" id="soGo">Recognise text</button></div>
    <div class="row"><button class="ghost full" id="soNo">Not now</button></div>`;
  $("soGo").onclick = async ()=>{ closeSheet(); await runOcr(); };
  $("soNo").onclick = ()=>{ closeSheet(); setStatus("You can still touch and hold to use the iPhone's own Live Text.","ok"); };
  openSheet();
}
function maybeOfferOcrForEditing(){
  if (!workingBytes || !MDOC || ocrBusy) return;
  if (docHasText()) return;                     // there IS text to tap
  $("sheet").innerHTML = h`
    <h3>This document is a picture</h3>
    <p class="hint">Its pages are scans, so there is no text to tap yet. Recognise text first and every word becomes editable: tapping one erases it from the scan and lets you retype it.</p>
    <p class="hint">One caveat, and it is the same in every app that is not Adobe: the replacement is typed in a standard typeface, so a retyped word may not match the scanned print exactly. Everything around it is untouched.</p>
    <div class="row"><button class="full" id="eoGo">Recognise text, then edit</button></div>
    <div class="row"><button class="ghost full" id="eoNo">Not now</button></div>`;
  $("eoGo").onclick = async ()=>{
    closeSheet();
    await runOcr();                              // its own confirm sheet follows
  };
  $("eoNo").onclick = ()=>{ closeSheet(); setStatus("Left as a picture. You can still add text, cover areas or sign it.","ok"); };
  openSheet();
}
$("selectBtn").onclick = ()=> setMode(mode==="select" ? null : "select");
// v11.43: whiteout mode + insert image (image reuses the sign placement flow)
$("whiteBtn").onclick = ()=> setMode(mode==="white" ? null : "white");
$("imgPlaceBtn").onclick = ()=>{ if (!$("imgPlaceBtn").disabled) $("insImgInput").click(); };
$("insImgInput").onchange = async e=>{
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  showSpin(true,"Loading picture…");
  try {
    const im = await loadImage(await fileToDataURL(f));
    // cap the placed image at 2000px on its long side — plenty for a photo
    // drawn on a page, and keeps the saved file reasonable
    const s = Math.min(1, 2000/Math.max(im.naturalWidth, im.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(im.naturalWidth*s));
    c.height = Math.max(1, Math.round(im.naturalHeight*s));
    c.getContext("2d").drawImage(im, 0, 0, c.width, c.height);
    signImgDataUrl = c.toDataURL("image/png");
    insImgPlacing = true;
    setMode("sign");
  } catch(err){ setStatus("Could not load that picture: "+friendly(err),"err"); }
  showSpin(false);
};
// Sign and Unlock were promoted from the More menu to the toolbar (v10.52).
// Handlers are identical to the old menu items so behaviour is unchanged.
$("signBtn").onclick = ()=> startSign();
$("unlockBtn").onclick = ()=> confirmDiscard("unlock another PDF", ()=>$("unlockInput").click());

// ---------------- sign (entered from the More sheet) ----------------
// ---- v11.38: draw a signature with your finger ---------------------------
// Until v11.38 signing REQUIRED an image file: you had to sign paper, photograph
// it, get the photo onto the phone, and pick it here. Every competitor lets you
// draw with a finger and remembers what you drew. This is the same placement
// path as before — only where the picture comes from is new.
const SIG_MAX = 3;                          // saved signatures kept on device
let savedSigs = [];                         // [{ id, png, ts }] newest first
async function sigsLoad(){
  try { savedSigs = (await idbGet("sigs")) || []; } catch(e){ savedSigs = []; }
  return savedSigs;
}
async function sigsSave(){ try { await idbSet("sigs", savedSigs); } catch(e){ storageWarn(e); } }
async function sigsAdd(png){
  savedSigs.unshift({ id: "s"+Date.now(), png, ts: Date.now() });
  savedSigs = savedSigs.slice(0, SIG_MAX);
  await sigsSave();
}

function startSign(){
  if (mode==="sign"){ setMode(null); return; }   // toggling off cancels sign mode
  openSignSheet();
}
// Pick a saved signature, draw a new one, or import an image. Saved ones come
// first because after the first use that is what people want every time.
async function openSignSheet(){
  await sigsLoad();
  const cards = savedSigs.map(s=>
    `<button class="sigcard" data-id="${esc(s.id)}" aria-label="Use this signature">
       <img src="${esc(s.png)}" alt="">
     </button>`).join("");
  $("sheet").innerHTML = h`
    <h3>Sign</h3>
    <p class="hint">${savedSigs.length ? "Tap a signature to place it, or draw a new one."
                                       : "Draw your signature once and it is kept on this phone for next time."}</p>
    ${raw(savedSigs.length ? `<div class="row sigrow">${cards}</div>` : "")}
    <div class="row"><button class="full" id="sgDraw">Draw a signature</button></div>
    <div class="row"><button class="ghost full" id="sgPick">Use a photo of a signature</button></div>
    ${raw(savedSigs.length ? `<div class="row"><button class="ghost danger full" id="sgClear">Forget saved signatures</button></div>` : "")}
    <div class="row"><button class="ghost full" id="sgCancel">Cancel</button></div>`;
  $("sheet").querySelectorAll("[data-id]").forEach(b=> b.onclick = ()=>{
    const s = savedSigs.find(x=>x.id === b.dataset.id);
    closeSheet();
    if (s){ signImgDataUrl = s.png; setMode("sign");
            setStatus("Drag a box on the page to place your signature.","ok"); }
  });
  $("sgDraw").onclick  = ()=>{ closeSheet(); openSignPad(); };
  $("sgPick").onclick  = ()=>{ closeSheet(); $("sigInput").click(); };
  if ($("sgClear")) $("sgClear").onclick = async ()=>{
    closeSheet(); savedSigs = []; await sigsSave();
    setStatus("Saved signatures removed from this phone.","ok");
  };
  $("sgCancel").onclick = closeSheet;
  openSheet();
}
// The pad itself. Strokes are captured as points and drawn with a rounded,
// slightly speed-tapered line so it reads as ink rather than as a mouse trail.
function openSignPad(){
  $("sheet").innerHTML = h`
    <h3>Draw your signature</h3>
    <p class="hint">Sign with your finger. It is saved on this phone only.</p>
    <div class="row"><canvas id="sgPad" class="sigpad" width="1000" height="380" aria-label="Signature pad"></canvas></div>
    <div class="row teseg">
      <button class="segb" id="sgUndo">Undo stroke</button>
      <button class="segb" id="sgWipe">Clear</button>
    </div>
    <div class="row"><button class="full" id="sgOk" disabled>Use this signature</button></div>
    <div class="row"><button class="ghost full" id="sgBack">Back</button></div>`;
  const cv = $("sgPad"), ctx = cv.getContext("2d");
  const strokes = [];
  let cur = null;
  const repaint = ()=>{
    ctx.clearRect(0,0,cv.width,cv.height);
    ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#0b1220";
    for (const st of strokes){
      if (st.length < 2){
        if (st.length === 1){ ctx.beginPath(); ctx.arc(st[0].x, st[0].y, 3.2, 0, Math.PI*2);
                              ctx.fillStyle="#0b1220"; ctx.fill(); }
        continue;
      }
      for (let i=1;i<st.length;i++){
        const a = st[i-1], b = st[i];
        // Taper with speed: a fast stroke is thinner, which is what a pen does
        // and what stops finger-drawn signatures looking like rope.
        const v = Math.hypot(b.x-a.x, b.y-a.y);
        ctx.lineWidth = Math.max(2.2, 7.5 - v*0.28);
        ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
      }
    }
    $("sgOk").disabled = !strokes.some(s=>s.length > 1);
  };
  const pt = (e)=>{
    const r = cv.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (cv.width / r.width),
             y: (e.clientY - r.top)  * (cv.height / r.height) };
  };
  cv.addEventListener("pointerdown", e=>{
    e.preventDefault();
    try { cv.setPointerCapture(e.pointerId); } catch(err){}
    cur = [pt(e)]; strokes.push(cur); repaint();
  });
  cv.addEventListener("pointermove", e=>{ if (!cur) return; e.preventDefault(); cur.push(pt(e)); repaint(); });
  const end = ()=>{ cur = null; };
  cv.addEventListener("pointerup", end);
  cv.addEventListener("pointercancel", end);
  cv.addEventListener("pointerleave", end);
  $("sgUndo").onclick = ()=>{ strokes.pop(); repaint(); };
  $("sgWipe").onclick = ()=>{ strokes.length = 0; repaint(); };
  $("sgBack").onclick = ()=>{ closeSheet(); openSignSheet(); };
  $("sgOk").onclick = async ()=>{
    const png = signPadToPng(cv, strokes);
    closeSheet();
    if (!png){ setStatus("Nothing was drawn, so there is nothing to place.","warn"); return; }
    await sigsAdd(png);
    signImgDataUrl = png;
    setMode("sign");
    setStatus("Signature saved on this phone. Drag a box on the page to place it.","ok");
  };
  openSheet();
  repaint();
}
// Trim the pad to the ink and export it with a transparent background, so the
// signature sits on the page rather than in a white rectangle. Cropping matters
// as much as transparency: an untrimmed pad places a mostly-empty box, and the
// user then has to fight the aspect ratio to make the signature the right size.
function signPadToPng(cv, strokes){
  let x0=1e9, y0=1e9, x1=-1e9, y1=-1e9, any=false;
  for (const st of strokes) for (const p of st){
    any = true;
    if (p.x<x0) x0=p.x; if (p.y<y0) y0=p.y;
    if (p.x>x1) x1=p.x; if (p.y>y1) y1=p.y;
  }
  if (!any) return null;
  const pad = 12;
  x0 = Math.max(0, x0-pad); y0 = Math.max(0, y0-pad);
  x1 = Math.min(cv.width,  x1+pad); y1 = Math.min(cv.height, y1+pad);
  const w = Math.max(8, Math.round(x1-x0)), hh = Math.max(8, Math.round(y1-y0));
  const out = document.createElement("canvas");
  out.width = w; out.height = hh;
  const octx = out.getContext("2d");
  // The pad is drawn on transparent already; copying the crop keeps that.
  octx.drawImage(cv, x0, y0, w, hh, 0, 0, w, hh);
  return out.toDataURL("image/png");
}
$("sigInput").onchange = async e=>{
  const f=e.target.files[0]; if(!f) return;
  showSpin(true,"Loading signature…");
  try {
    const url = await fileToDataURL(f);
    // Remove the white paper background so the signature blends onto the PDF
    // page colour (like Adobe Sign), instead of sitting in a visible white box.
    signImgDataUrl = await signatureToTransparentPng(url);
    setMode("sign");
  } catch(err){ setStatus("Could not load that image: "+friendly(err),"err"); }
  showSpin(false); e.target.value="";
};

function attachOverlay(stage, pageIndex){
  const ovl = stage.querySelector(".ovl");
  let start=null, rectEl=null;
  ovl.addEventListener("pointerdown", e=>{
    if (mode!=="sign" && mode!=="white") return;
    start={x:e.offsetX,y:e.offsetY};
    rectEl=document.createElement("div"); rectEl.className="selrect"; ovl.appendChild(rectEl);
    ovl.setPointerCapture(e.pointerId);
  });
  ovl.addEventListener("pointermove", e=>{
    if (!start||!rectEl) return;
    const x=e.offsetX,y=e.offsetY;
    rectEl.style.left=Math.min(start.x,x)+"px"; rectEl.style.top=Math.min(start.y,y)+"px";
    rectEl.style.width=Math.abs(x-start.x)+"px"; rectEl.style.height=Math.abs(y-start.y)+"px";
  });
  ovl.addEventListener("pointerup", async e=>{
    if (!start||!rectEl) return;
    const x=e.offsetX,y=e.offsetY;
    const px=Math.min(start.x,x), py=Math.min(start.y,y), pw=Math.abs(x-start.x), ph=Math.abs(y-start.y);
    start=null; rectEl.remove(); rectEl=null;
    if (pw<10||ph<10) return;
    const wPt=+stage.dataset.wpt, dispW=parseFloat(stage.style.width), s=dispW/wPt;
    if (mode==="white") await applyWhiteout(pageIndex, px/s, py/s, pw/s, ph/s);
    else await placeSignature(pageIndex, px/s, py/s, pw/s, ph/s);
  });
  // v11.43: in Edit text mode, tapping EMPTY page space adds a new text box
  // there. Taps on existing text land on the .span buttons (which stop
  // propagation), so a click that reaches the overlay itself is empty space.
  ovl.addEventListener("click", e=>{
    if (mode!=="text" || e.target!==ovl) return;
    const wPt=+stage.dataset.wpt, dispW=parseFloat(stage.style.width), s=dispW/wPt;
    if (!wPt || !dispW) return;
    openNewTextSheet(pageIndex, e.offsetX/s, e.offsetY/s);
  });
}

// ---- v11.43: whiteout ------------------------------------------------------
// Paints an opaque white rectangle over the drawn box. Deliberately a COVER,
// not a removal: the content underneath is untouched (and on a text PDF is
// still selectable), which is why the status says so. True removal of text is
// what Edit text does; true redaction (content destroyed) is a later,
// deliberately separate feature so nobody mistakes one for the other.
async function applyWhiteout(pageIndex, xPt, yTopPt, wPt, hPt){
  showSpin(true,"Covering…");
  try {
    pushUndo();
    const doc = await PDFDocument.load(workingBytes, { ignoreEncryption:true });
    const pg = doc.getPage(pageIndex);
    const H = pg.getHeight();
    pg.drawRectangle({ x:xPt, y:H-(yTopPt+hPt), width:wPt, height:hPt, color:rgb(1,1,1) });
    workingBytes = new Uint8Array(await doc.save());
    reopen(); await render();
    setStatus("Covered with white on page "+(pageIndex+1)+" — note it is painted over, not removed: "
      +"text underneath can still be selected or extracted. Use Edit text to truly change text. Undo reverses it.","ok");
  } catch(e){ setStatus("Could not cover that area: "+friendly(e),"err"); }
  showSpin(false);
}

// ---- v11.43: add a new text box -------------------------------------------
// The one Acrobat edit feature the app lacked entirely: putting text where the
// document has none (filling an unlabelled gap, adding a note, completing a
// flat form). Multi-line, size/colour/typeface from the same controls the
// editor uses. The text is inserted with pdf-lib exactly like an edit's
// replacement text, so Save/undo/compress treat it identically.
async function addNewText(pageIndex, xPt, yTopPt, text, opts){
  const t = String(text == null ? "" : text).replace(/\r\n?/g, "\n").split("\n");
  while (t.length && !t[t.length-1].trim()) t.pop();
  if (!t.length || !t.join("").trim()) return false;
  showSpin(true,"Adding text…");
  try {
    pushUndo();
    const doc = await PDFDocument.load(workingBytes, { ignoreEncryption:true });
    const pg = doc.getPage(pageIndex);
    const H = pg.getHeight();
    const size = opts && opts.size ? opts.size : 12;
    const colour = (opts && opts.colour) || [0,0,0];
    const font = await doc.embedFont(pickFontKeyed("", (opts && opts.font) || "sans"));
    const lead = size * 1.25;
    let substituted = false;
    t.forEach((line, i)=>{
      const safe = sanitizeForFont(line);
      if (safe !== line) substituted = true;
      if (!safe.trim()) return;
      // yTopPt is where the finger tapped; treat it as the TOP of the first
      // line, so the text appears just under the tap instead of straddling it.
      pg.drawText(safe, { x:xPt, y:H-(yTopPt + size + i*lead), size,
                          font, color:rgb(colour[0],colour[1],colour[2]) });
    });
    workingBytes = new Uint8Array(await doc.save());
    reopen();
    setMode("text");                      // stay in edit mode; boxes rebuild
    await render();
    setStatus("Text added on page "+(pageIndex+1)+"."
      + (substituted ? " Some characters aren't available in that typeface and were shown as “?”." : ""),"ok");
    return true;
  } catch(e){ setStatus("Could not add the text: "+friendly(e),"err"); return false; }
  finally { showSpin(false); }
}
function openNewTextSheet(pageIndex, xPt, yTopPt){
  let size = 12, colour = "black", fontK = "sans";
  const draw = ()=>{
    $("sheet").innerHTML = h`
      <h3>Add text · page ${pageIndex+1}</h3>
      <p class="hint">New text is placed where you tapped. Use Return for more lines.</p>
      <div class="row"><textarea id="ntIn" placeholder="Type here…"></textarea></div>
      <div class="row telbl">Size</div>
      <div class="row teseg" id="ntSize">
        <button class="segb" data-d="-1">A −</button>
        <button class="segb" id="ntSizeNow">${size.toFixed(1)} pt</button>
        <button class="segb" data-d="1">A +</button>
      </div>
      <div class="row telbl">Colour</div>
      <div class="row teseg tewrap" id="ntCol">
        ${raw(TE_COLOURS.filter(c=>c.k!=="keep").map(c=>`<button class="segb${colour===c.k?" on":""}" data-k="${c.k}">${c.label}</button>`).join(""))}
      </div>
      <div class="row telbl">Typeface</div>
      <div class="row teseg" id="ntFont">
        ${raw(TE_FONTS.filter(f=>f.k!=="keep").map(f=>`<button class="segb${fontK===f.k?" on":""}" data-k="${f.k}">${f.label}</button>`).join(""))}
      </div>
      <div class="row"><button class="full" id="ntOk">Add text</button></div>
      <div class="row"><button class="ghost full" id="ntCancel">Cancel</button></div>`;
    $("ntSize").querySelectorAll("[data-d]").forEach(b=>
      b.onclick = ()=>{
        size = Math.min(96, Math.max(4, Math.round((size + (+b.dataset.d)*0.5)*2)/2));
        $("ntSizeNow").textContent = size.toFixed(1)+" pt";
      });
    $("ntCol").querySelectorAll("[data-k]").forEach(b=>
      b.onclick = ()=>{ colour = b.dataset.k;
        $("ntCol").querySelectorAll("[data-k]").forEach(o=>o.classList.toggle("on", o===b)); });
    $("ntFont").querySelectorAll("[data-k]").forEach(b=>
      b.onclick = ()=>{ fontK = b.dataset.k;
        $("ntFont").querySelectorAll("[data-k]").forEach(o=>o.classList.toggle("on", o===b)); });
    $("ntOk").onclick = async ()=>{
      const t = $("ntIn").value;
      closeSheet();
      await addNewText(pageIndex, xPt, yTopPt, t,
        { size, colour:(TE_COLOURS.find(c=>c.k===colour)||{}).rgb, font: fontK });
    };
    $("ntCancel").onclick = closeSheet;
  };
  draw();
  openSheet();
  setTimeout(()=>{ const i=$("ntIn"); if(i) i.focus(); }, 100);
}

// Signature placement assumes an upright (0°) page, exactly like text editing.
// On a rotated page the signature can land in the wrong place or orientation,
// so warn first and let the user proceed or back out. Resolves true = place.
function confirmRotatedSign(){
  return new Promise(resolve=>{
    $("sheet").innerHTML = h`
      <h3>This page is rotated</h3>
      <p class="hint">Signature placement works best on upright pages — on a rotated page the signature can land in the wrong place. You can rotate the page back first (More → Pages), or place it anyway.</p>
      <div class="row"><button class="full" id="sgGo">Place anyway</button></div>
      <div class="row"><button class="ghost full" id="sgNo">Cancel</button></div>`;
    let settled=false;
    const done=v=>{ if(settled) return; settled=true; sheetOnDismiss=null; closeSheet(); resolve(v); };
    $("sgGo").onclick = ()=> done(true);
    $("sgNo").onclick = ()=> done(false);
    openSheet();
    sheetOnDismiss = ()=> done(false);   // backdrop / Esc = cancel
  });
}

async function placeSignature(pageIndex, xPt, yTopPt, wPt, hPt){
  if (!signImgDataUrl){ setStatus("Pick a signature image first (Sign button).","err"); return; }
  if (await pageRotation(pageIndex)){
    const ok = await confirmRotatedSign();
    if (!ok){ setStatus("Signature cancelled.","warn"); return; }
  }
  showSpin(true,"Placing signature…");
  try {
    pushUndo();
    const doc = await PDFDocument.load(workingBytes, { ignoreEncryption:true });
    const pg = doc.getPage(pageIndex);
    const H = pg.getHeight();
    const pngBytes = await (await fetch(signImgDataUrl)).arrayBuffer();
    const img = await doc.embedPng(pngBytes);
    // keep aspect ratio, fit inside the drawn box
    const ar = img.width/img.height, boxAr = wPt/hPt;
    let dw=wPt, dh=hPt;
    if (ar>boxAr) dh = wPt/ar; else dw = hPt*ar;
    const yPt = H - (yTopPt + hPt) + (hPt-dh)/2;
    const xPt2 = xPt + (wPt-dw)/2;
    pg.drawImage(img, { x:xPt2, y:yPt, width:dw, height:dh });
    workingBytes = new Uint8Array(await doc.save());
    const wasPicture = insImgPlacing;           // v11.43: same flow places pictures
    reopen(); setMode(null); await render();
    setStatus((wasPicture ? "Picture" : "Signature")+" placed on page "+(pageIndex+1)+".","ok");
  } catch(e){ setStatus("Could not place the signature: "+friendly(e),"err"); }
  showSpin(false);
}

// ---------------- jump to a page (long documents) ----------------
function scrollToPage(i){
  const v = $("viewer");
  const stage = $("pageWrap").querySelector('.stage[data-page="'+i+'"]');
  if (!stage) return;
  // Scroll the VIEWER itself, not the element scroll-into-view helper: on iOS
  // that helper can bubble up and scroll the whole app, pushing the fixed header
  // + toolbar off screen (so you couldn't get back to page 1). Moving the viewer
  // directly keeps the toolbar put. Offsets are valid even for not-yet-rendered
  // pages because each stage carries its intrinsic size.
  const target = Math.max(0, v.scrollTop + (stage.getBoundingClientRect().top - v.getBoundingClientRect().top) - 8);
  try { if (typeof v.scrollTo === "function"){ v.scrollTo({ top:target, behavior:"smooth" }); return; } } catch(e){}
  v.scrollTop = target;
}
function openJumpToPage(){
  const n = (workingBytes && MDOC) ? MDOC.countPages() : 0;
  if (n < 2) return;
  $("sheet").innerHTML = h`
    <h3>Go to page</h3>
    <p class="hint">This document has ${n} pages. Enter a page number.</p>
    <div class="row"><input type="number" id="jpIn" min="1" max="${n}" inputmode="numeric" placeholder="1–${n}"></div>
    <div class="row"><button class="full" id="jpGo">Go</button></div>
    <div class="row"><button class="ghost full" id="jpCancel">Cancel</button></div>`;
  const go = ()=>{ const v=Math.max(1,Math.min(n, parseInt($("jpIn").value,10)||1)); closeSheet(); scrollToPage(v-1); };
  $("jpGo").onclick = go;
  $("jpIn").onkeydown = e=>{ if (e.key==="Enter"){ e.preventDefault(); go(); } };
  $("jpCancel").onclick = closeSheet;
  openSheet();
  setTimeout(()=>{ try{ $("jpIn").focus(); }catch(e){} }, 100);
}

// ---------------- More ▾ sheet ----------------
$("moreBtn").onclick = ()=>{
  const has = !!workingBytes, d = has?"":"disabled";
  // v11.23 dedupe pass 2: "Copy pages" and "Go to page" removed — both already
  // live in the toolbar's Pages grid (Select → Copy; tap a thumbnail to jump).
  // openJumpToPage/openExtract stay wired to the grid, so nothing is lost.
  // v11.22: Find removed (it lives on the toolbar); "All pages" removed (it is
  // the toolbar Pages button). Groups ordered by use; About moved to the footer.
  $("sheet").innerHTML = h`
    <h3>More actions</h3>
    <div class="mgrp-l">Create</div>
    <div class="mgrid">
      <button class="mtile" id="mScan">${ic("camera")}<span>Scan</span></button>
      <!-- v11.35: scan straight into the open document (a signed page coming
           back on paper is the everyday case) instead of scan → save → combine -->
      <button class="mtile" id="mScanAdd" ${d}>${ic("camera")}<span>Scan more pages</span></button>
      <button class="mtile" id="mImg">${ic("photo")}<span>Photos → PDF</span></button>
    </div>
    <div class="mgrp-l">Pages</div>
    <div class="mgrid">
      <button class="mtile" id="mOrg" ${d}>${ic("grid")}<span>Organize</span></button>
      <button class="mtile" id="mMerge" ${d}>${ic("combine")}<span>Combine</span></button>
      <button class="mtile" id="mNum" ${d}>${ic("grid")}<span>Page numbers</span></button>
      <button class="mtile" id="mWater" ${d}>${ic("info")}<span>Watermark</span></button>
      <button class="mtile" id="mCrop" ${d}>${ic("grid")}<span>Crop &amp; resize</span></button>
      <button class="mtile" id="mStraight" ${d}>${ic("grid")}<span>Straighten pages</span></button>
    </div>
    <div class="mgrp-l">Document</div>
    <div class="mgrid">
      <button class="mtile" id="mComp" ${d}>${ic("compress")}<span>Compress</span></button>
      <button class="mtile" id="mUnlock">${ic("unlock")}<span>Unlock a PDF</span></button>
      <button class="mtile" id="mFlat" ${d}>${ic("grid")}<span>Flatten form</span></button>
      <button class="mtile" id="mOcr" ${d}>${ic("info")}<span>Recognise text</span></button>
      <button class="mtile" id="mPng" ${d}>${ic("download")}<span>Save image</span></button>
    </div>
    <div class="mgrid mgrid2 mt12">
      <button class="mtile" id="mAbout">${ic("info")}<span>About</span></button>
      <button class="mtile" id="mDiag">${ic("info")}<span>Diagnostics</span></button>
      <button class="mtile" id="mClose">${ic("close")}<span>Cancel</span></button>
    </div>`;
  $("mDiag").onclick  = ()=>{ openDiagnostics(); };
  $("mScan").onclick  = ()=>{ closeSheet(); startScan(false); };
  $("mScanAdd").onclick = ()=>{ closeSheet(); if (workingBytes) startScan(true); };
  $("mOrg").onclick   = ()=>{ closeSheet(); openOrganise(); };
  $("mNum").onclick   = ()=>{ closeSheet(); openPageNumberSheet(); };     // v11.51
  $("mWater").onclick = ()=>{ closeSheet(); openWatermarkSheet(); };      // v11.51
  $("mCrop").onclick  = ()=>{ closeSheet(); openPageSizeSheet(); };       // v11.52
  $("mStraight").onclick = ()=>{ closeSheet(); runAutoRotate(); };        // v11.53
  $("mMerge").onclick = ()=>{ closeSheet(); $("mergeInput").click(); };
  $("mImg").onclick   = ()=>{ closeSheet(); confirmDiscard("turn photos into a new PDF", ()=>$("imgInput").click()); };
  // v11.11: Compress and Unlock left the toolbar; their original (now hidden)
  // buttons keep the handlers, so these tiles just forward to them
  $("mComp").onclick  = ()=>{ closeSheet(); if (!$("compBtn").disabled) $("compBtn").onclick(); };
  $("mUnlock").onclick= ()=>{
    closeSheet();
    if ($("unlockBtn").disabled){ setStatus("One moment — the engine is still loading.","warn"); return; }
    $("unlockBtn").onclick();
  };
  $("mPng").onclick   = ()=>{ closeSheet(); exportVisiblePng(); };
  $("mOcr").onclick   = ()=>{ closeSheet(); runOcr(); };       // v11.48
  // v11.47: flatten asks first — it is a one-way door (undo aside)
  $("mFlat").onclick  = ()=>{
    if (!workingBytes) return;
    $("sheet").innerHTML = h`
      <h3>Flatten this form?</h3>
      <p class="hint">Every filled value becomes permanent page content and the fields stop being editable — useful before sending to systems that can't read form fields. Undo can reverse it while the document is open.</p>
      <div class="row"><button class="full" id="flGo">Flatten</button></div>
      <div class="row"><button class="ghost full" id="flNo">Cancel</button></div>`;
    $("flGo").onclick = ()=>{ closeSheet(); flattenForm(); };
    $("flNo").onclick = closeSheet;
    openSheet();
  };
  $("mAbout").onclick = ()=>{ closeSheet(); openAbout(); };
  $("mClose").onclick = closeSheet;
  openSheet();
};

// ---------------- About dialog ----------------
function openAbout(){
  const cache = "pypdf-app-v"+APP_BUILD;   // derived; sw.js APP_CACHE must match (version-tests enforces)
  let errs = [];
  try { errs = JSON.parse(localStorage.getItem("pypdf-errlog")||"[]"); } catch(e){}
  const errRows = errs.length
    ? h`<div class="abrow"><span>Recent errors</span><b>${errs.join("  •  ")}</b></div>`
    : h`<div class="abrow"><span>Recent errors</span><b>none</b></div>`;
  $("sheet").innerHTML = h`
    <h3>About PyPDF</h3>
    <div class="about">
      <div class="abrow"><span>Version</span><b>${APP_VERSION}</b></div>
      <div class="abrow"><span>Build</span><b>${BUILD_DATETIME}</b></div>
      <div class="abrow"><span>Bottom bar</span><b>${(vvLast || "-")}</b></div>
      <div class="abrow"><span>Web view</span><b>${(window.innerHeight >= (window.screen ? Math.max(window.screen.width,window.screen.height) : 0) - 2
          ? "full screen" : "SHORT by " + (Math.max(window.screen.width,window.screen.height) - window.innerHeight) + "px — re-add to Home Screen")}</b></div>
      <div class="abrow"><span>Display mode</span><b>${((window.navigator && window.navigator.standalone===true)
          || (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches)
          ? "standalone" : "browser tab")}</b></div>
      <div class="abrow"><span>Cache</span><b>${cache}</b></div>
      <div class="abrow"><span>Engine</span><b>MuPDF.js (WASM) + pdf-lib</b></div>
      <div class="abrow"><span>Licence</span><b>MuPDF.js is AGPL-3.0 — <a href="https://github.com/ArtifexSoftware/mupdf.js" target="_blank" rel="noopener noreferrer">engine source</a></b></div>
      ${raw(errRows)}
    </div>
    <p class="hint mt12">
      A private, on-device PDF editor. Everything runs in your browser — nothing
      you open is ever uploaded. Edit text in place, sign, compress, merge,
      organise pages, and convert images to PDF.<br><br>
      If the version above doesn't match your latest upload, fully close and
      reopen the app so it fetches the new build.
    </p>
    <div class="row mt8"><button class="full" id="abSelfTest" ${workingBytes ? "" : "disabled"}>Run self-test on this document</button></div>
    <div class="row"><button class="ghost full" id="abClose">Close</button></div>`;
  $("abSelfTest").onclick = ()=> runSelfTest();
  $("abClose").onclick = closeSheet;
  openSheet();
}

// ---------------- v11.42 (Phase 0): self-test on the open document ----------
// The whole pipeline — parse, render, text, edit plumbing, save round-trip,
// lossless compress — run against the CURRENTLY OPEN document, on copies, so
// real files can be verified on the real phone in one tap. Nothing the test
// does can touch the document: workingBytes, MDOC, undo and the dirty flag are
// never written. This exists because the v11.32–v11.40 regressions all passed
// a green fixture suite and failed on the first real document: the corpus
// harness (tests/corpus-tests.mjs) covers real files on the desktop, and this
// covers them on the device itself.
//
// selfTestCore is pure on purpose (bytes in, results out, engines injected) so
// tests/selftest-tests.mjs can run the SAME code in Node against corpus files.
async function selfTestCore(bytes, eng, onStep){
  const res = [];
  const step = async (name, fn)=>{
    if (onStep) await onStep(name);
    try { const info = await fn(); res.push({ name, ok:true, info:String(info==null?"":info) }); }
    catch(e){ res.push({ name, ok:false, info:String(e && e.message || e).slice(0,120) }); }
  };
  const open = b => eng.mupdf.Document.openDocument(b.slice(0), "application/pdf").asPDF();
  let pages = 0, chars = 0;
  await step("Opens and parses", ()=>{
    const raw = eng.mupdf.Document.openDocument(bytes.slice(0), "application/pdf");
    if (raw.needsPassword && raw.needsPassword()) { raw.destroy(); throw new Error("password-protected (open it unlocked to test)"); }
    // Mirror the app's open path exactly: an owner-locked file (encrypted, no
    // password) is decrypted up front, because every later stage — pdf-lib
    // edits above all — must never see still-encrypted bytes. The first
    // corpus run of an owner-locked seed caught precisely this.
    let note = "";
    try {
      const enc = raw.getMetaData("encryption");
      if (enc && enc !== "None"){
        bytes = new Uint8Array(raw.asPDF().saveToBuffer("decrypt,garbage").asUint8Array());
        note = ", owner restrictions removed on open";
      }
    } catch(e){}
    raw.destroy();
    const d = open(bytes);
    pages = d.countPages(); d.destroy();
    if (!(pages > 0)) throw new Error("no pages");
    return pages + " page" + (pages>1?"s":"") + note;
  });
  if (!pages) return res;
  await step("Page 1 renders", ()=>{
    const d = open(bytes);
    const p = d.loadPage(0);
    const [x0,y0,x1,y1] = p.getBounds();
    const pix = p.toPixmap(eng.mupdf.Matrix.scale(300/(x1-x0), 300/(x1-x0)), eng.mupdf.ColorSpace.DeviceRGB, false);
    const ok = pix.getWidth() > 0 && pix.getHeight() > 0;
    const wh = pix.getWidth()+"×"+pix.getHeight();
    pix.destroy(); p.destroy(); d.destroy();
    if (!ok) throw new Error("empty raster");
    return wh;
  });
  await step("Text extraction", ()=>{
    const d = open(bytes);
    for (let i=0; i<Math.min(3, pages); i++){
      const p = d.loadPage(i);
      const st = p.toStructuredText("preserve-spans");
      st.walk({ onChar(c){ if (c && c.trim()) chars++; } });
      st.destroy(); p.destroy();
    }
    d.destroy();
    return chars ? chars + " characters found" : "no text (scanned pages)";
  });
  await step("Edit/save round-trip", async ()=>{
    const lib = await eng.PDFDocument.load(bytes, { ignoreEncryption:true });
    const out = new Uint8Array(await lib.save());
    const d = open(out);
    const same = d.countPages() === pages; d.destroy();
    if (!same) throw new Error("page count changed on save");
    return "reopened, " + pages + " page" + (pages>1?"s":"");
  });
  if (chars > 0) await step("Text-edit plumbing (on a copy)", ()=>{
    const d = open(bytes);
    let band = null, bp = 0;
    for (let i=0; i<Math.min(3, pages) && !band; i++){
      const p = d.loadPage(i);
      const st = p.toStructuredText("preserve-spans");
      st.walk({ onChar(c, origin, font, size, quad){
        if (band || !c || !c.trim()) return;
        band = [quad[0]-1, quad[1]-1, quad[4]+1, quad[5]+1]; bp = i;
      }});
      st.destroy(); p.destroy();
    }
    if (!band){ d.destroy(); return "no editable span found"; }
    const p = d.loadPage(bp);
    const an = p.createAnnotation("Redact");
    an.setRect(band); an.update();
    p.applyRedactions(false);
    p.destroy();
    const out = u8(d.saveToBuffer("compress-images,garbage").asUint8Array());
    d.destroy();
    const d2 = open(out);
    const same = d2.countPages() === pages; d2.destroy();
    if (!same) throw new Error("pages lost in redaction save");
    return "redact + save + reopen OK";
  });
  await step("Lossless compress pass", ()=>{
    const d = open(bytes);
    const out = u8(d.saveToBuffer("compress,compress-images,compress-fonts,subset-fonts,garbage").asUint8Array());
    d.destroy();
    const d2 = open(out);
    const n2 = d2.countPages();
    d2.destroy();
    if (n2 !== pages) throw new Error("page count changed");
    return (bytes.length/1024|0) + " → " + (out.length/1024|0) + " KB";
  });
  return res;
}
async function runSelfTest(){
  if (!workingBytes || selfTestBusy) return;
  selfTestBusy = true;
  const big = workingBytes.length > 60*1024*1024;
  const paint = (lines, running)=>{
    $("sheet").innerHTML = h`
      <h3>Self-test · ${fileName}</h3>
      <p class="hint">Runs the whole pipeline on a COPY of this document — nothing is changed, saved or kept.</p>
      <div class="about">${raw(lines.join(""))}</div>
      ${raw(running ? "" : '<div class="row mt8"><button class="ghost full" id="stClose">Close</button></div>')}`;
    const c = $("stClose"); if (c) c.onclick = closeSheet;
  };
  const row = (name, ok, info) =>
    h`<div class="abrow"><span>${name}</span><b>${ok===null ? "…" : (ok ? "✓" : "✗")} ${info||""}</b></div>`;
  try {
    if (big){
      paint([row("Self-test", false, "document too large to test in memory on a phone")], false);
      return;
    }
    const done = [];
    await selfTestCore(workingBytes, { mupdf, PDFDocument }, async (name)=>{
      paint(done.concat(row(name, null, "")), true);
      await new Promise(r=>setTimeout(r, 30));      // let the row paint
    }).then(res=>{
      const fails = res.filter(r=>!r.ok).length;
      res.forEach(r=> done.push(row(r.name, r.ok, r.info)));
      done.push(row("Result", !fails, fails ? fails + " step(s) failed — please report" : "all steps passed"));
      paint(done, false);
    });
  } catch(e){
    paint([row("Self-test", false, String(e && e.message || e))], false);
  } finally {
    selfTestBusy = false;
  }
}
let selfTestBusy = false;

// Close the open document and return to the empty state, releasing all memory.
function closeFile(){
  setImmersive(false);           // v11.10: welcome screen always shows the chrome
  if (SEARCH.open) closeFind();
  if (pageObserver) pageObserver.disconnect();
  $("viewer").querySelectorAll(".stage").forEach(s=>s.remove());
  revokeURLs();
  closeDoc();                       // destroy the mupdf doc -> frees WASM memory
  workingBytes = null;
  docSensitive = false;
  setDirty(false);
  try{ idbDel("doc").catch(()=>{}); }catch(e){}   // closed on purpose: forget it
  fileName = "document.pdf";
  undoStack = [];
  spanCache.clear();
  thumbCache.clear();
  lastMarkupMode = null;           // v11.22: forget the preferred tool on close
  setMode(null);
  zoomPct = 100; $("zoomLbl").textContent = "100%";
  $("pagePill").classList.remove("show"); $("pagePill").tabIndex = -1;
  $("emptyMsg").style.display = "block";
  setMeta("No document open", "");
  enableDocButtons(false);
  renderRecents();                 // welcome screen is visible again
  setStatus("Closed. Open a PDF or scan a document.", "ok");
}

// ---------------- page thumbnails (cached + lazy) ----------------
// Thumbnails are rasterised once per document version and kept as small JPEG
// data URLs, so the Pages / Copy-pages sheets open instantly and redraw with
// no engine work even on 100-page documents. Images load lazily as the sheet
// scrolls.
const thumbCache = new Map();          // `${epoch}:${page}` -> dataURL
function pageThumb(i){
  const key = epoch+":"+i;
  if (thumbCache.has(key)) return thumbCache.get(key);
  const page = MDOC.loadPage(i);
  const [x0,y0,x1,y1] = page.getBounds();
  const s = (46*DPR)/(x1-x0);
  const pix = page.toPixmap(mupdf.Matrix.scale(s,s), mupdf.ColorSpace.DeviceRGB, false);
  const jpg = u8(pix.asJPEG(82)); pix.destroy(); page.destroy();   // q82: crisper thumbs on dense pages
  let bin=""; for (let k=0;k<jpg.length;k+=8192) bin += String.fromCharCode.apply(null, jpg.subarray(k,k+8192));
  const url = "data:image/jpeg;base64,"+btoa(bin);
  thumbCache.set(key, url);
  // v11.24: 150 (was 400) — the grid lazy-loads thumbnails near the viewport,
  // so a big cap only pinned ~10-20MB of dataURLs on long documents.
  if (thumbCache.size > 150){ thumbCache.delete(thumbCache.keys().next().value); }
  return url;
}
let sheetThumbObs = null;
function lazyThumbs(){
  if (sheetThumbObs) sheetThumbObs.disconnect();
  const root = $("sheet");
  sheetThumbObs = new IntersectionObserver((ents)=>{
    for (const en of ents){
      if (!en.isIntersecting) continue;
      sheetThumbObs.unobserve(en.target);
      try { en.target.src = pageThumb(+en.target.dataset.pthumb); } catch(e){}
    }
  }, { root, rootMargin:"300px 0px" });
  root.querySelectorAll("img[data-pthumb]").forEach(im=>sheetThumbObs.observe(im));
}

// ---------------- organise pages (reorder + delete) ----------------
async function openOrganise(){
  const n = MDOC.countPages();
  // order: array of original page indices; del: set of original indices to
  // remove; rot: original index -> extra rotation in degrees (0/90/180/270)
  let order = Array.from({length:n}, (_,i)=>i);
  const del = new Set();
  const rot = {};

  function draw(){
    const rows = order.map((orig,pos)=>{
      const isdel = del.has(orig);
      const deg = rot[orig]||0;
      return h`<div class="porow ${isdel?'del':''}" data-pos="${pos}">
        <img data-pthumb="${orig}" alt="">
        <span class="pn">Page ${orig+1}${deg?` · ⟳${deg}°`:""}</span>
        <button class="ghost" data-up="${pos}" aria-label="Move page ${orig+1} up">↑</button>
        <button class="ghost" data-dn="${pos}" aria-label="Move page ${orig+1} down">↓</button>
        <button class="ghost" data-rot="${orig}" aria-label="Rotate page ${orig+1}">⟳</button>
        <button class="ghost" data-del="${orig}">${isdel?'Keep':'Delete'}</button>
      </div>`;
    }).join("");
    $("sheet").innerHTML = h`<h3>Pages</h3>
      <p class="hint">Hold a page and drag to move it, or use ↑ ↓. ⟳ turns a page a quarter. Nothing changes until you tap Apply.</p>
      <div id="orgRows">${raw(rows)}</div>
      <div class="sheetfoot">
        <div class="row"><button class="full" id="orgApply">Apply</button></div>
        <div class="row"><button class="ghost full" id="orgCancel">Cancel</button></div>
      </div>`;
    $("sheet").querySelectorAll("[data-up]").forEach(b=>b.onclick=()=>{const p=+b.dataset.up; if(p>0){[order[p-1],order[p]]=[order[p],order[p-1]]; draw();}});
    $("sheet").querySelectorAll("[data-dn]").forEach(b=>b.onclick=()=>{const p=+b.dataset.dn; if(p<order.length-1){[order[p+1],order[p]]=[order[p],order[p+1]]; draw();}});
    $("sheet").querySelectorAll("[data-rot]").forEach(b=>b.onclick=()=>{const o=+b.dataset.rot; rot[o]=((rot[o]||0)+90)%360; draw();});
    $("sheet").querySelectorAll("[data-del]").forEach(b=>b.onclick=()=>{const o=+b.dataset.del; del.has(o)?del.delete(o):del.add(o); draw();});
    $("orgApply").onclick = async ()=>{ closeSheet(); await applyOrganise(order.filter(o=>!del.has(o)), rot); };
    $("orgCancel").onclick = closeSheet;
    // live preview: rotate each thumbnail by its pending turn (on top of the
    // page's existing orientation, which the base thumbnail already shows) so
    // the result is visible immediately, not only after Apply.
    $("sheet").querySelectorAll("img[data-pthumb]").forEach(im=>{
      const deg = rot[+im.dataset.pthumb]||0;
      im.style.transform = deg ? "rotate("+deg+"deg)" : "";
    });
    // long-press (250ms) drag-to-reorder — the ↑ ↓ buttons still work, this is
    // just faster for big moves. Before the hold matures, a >8px move is treated
    // as a normal sheet scroll and the drag is abandoned.
    $("sheet").querySelectorAll(".porow").forEach(row=>{
      row.addEventListener("pointerdown", (ev)=>{
        if (ev.target.closest("button")) return;
        const pos = +row.dataset.pos;
        const rows = [...$("orgRows").children];
        const rh = row.offsetHeight + 7;                 // row height + margin
        let dragging=false, startY=ev.clientY, curY=startY;
        const timer = setTimeout(()=>{
          dragging = true;
          row.classList.add("drag");
          try { row.setPointerCapture(ev.pointerId); } catch(e){}
        }, 250);
        const clampShift = ()=> Math.max(-pos, Math.min(order.length-1-pos, Math.round((curY-startY)/rh)));
        const move = (e)=>{
          curY = e.clientY;
          if (!dragging){ if (Math.abs(curY-startY) > 8) cleanup(); return; }
          e.preventDefault();                            // stop sheet scroll while dragging
          row.style.transform = "translateY("+(curY-startY)+"px)";
          const target = pos + clampShift();
          rows.forEach((r,i)=>{
            if (r===row) return;
            let dy = 0;
            if (i>pos && i<=target) dy = -rh;
            if (i<pos && i>=target) dy =  rh;
            r.style.transform = dy ? "translateY("+dy+"px)" : "";
          });
        };
        const up = ()=>{
          const wasDragging = dragging, shift = clampShift();
          cleanup();
          if (wasDragging && shift){
            const [m] = order.splice(pos,1);
            order.splice(pos+shift, 0, m);
            draw();
          }
        };
        const cleanup = ()=>{
          clearTimeout(timer); dragging=false;
          row.classList.remove("drag"); row.style.transform="";
          rows.forEach(r=>r.style.transform="");
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          window.removeEventListener("pointercancel", cleanup);
        };
        window.addEventListener("pointermove", move, { passive:false });
        window.addEventListener("pointerup", up);
        window.addEventListener("pointercancel", cleanup);
      });
    });
    lazyThumbs();
  }
  draw();
  openSheet();}

async function applyOrganise(finalOrder, rot){
  if (!finalOrder.length){ setStatus("Cannot delete every page.","err"); return; }
  showSpin(true,"Updating pages…");
  try {
    pushUndo();
    // 1) rotations first (pdf-lib /Rotate), keyed by ORIGINAL page indices
    const hasRot = rot && Object.keys(rot).some(k=>(rot[k]||0)%360);
    if (hasRot){
      const doc = await PDFDocument.load(workingBytes, { ignoreEncryption:true });
      for (const k of Object.keys(rot)){
        const deg = (rot[k]||0)%360;
        if (!deg) continue;
        const pg = doc.getPage(+k);
        pg.setRotation(degrees(((pg.getRotation().angle||0) + deg) % 360));
      }
      workingBytes = new Uint8Array(await doc.save());
      reopen();                                // MDOC now reflects rotations
    }
    // 2) then reorder + delete in one step (mupdf)
    MDOC.rearrangePages(finalOrder);
    workingBytes = u8(MDOC.saveToBuffer("garbage").asUint8Array());
    reopen(); await render();
    setStatus("Pages updated. Now "+MDOC.countPages()+" pages.","ok");
  } catch(e){ setStatus("Could not change the pages: "+friendly(e),"err"); }
  showSpin(false);
}

// ---------------- copy pages -> brand-new PDF (extract) ----------------
function openExtract(){
  const n = MDOC.countPages();
  const sel = new Set();
  function draw(){
    const rows = Array.from({length:n},(_,i)=> h`<div class="porow">
        <img data-pthumb="${i}" alt="">
        <span class="pn">Page ${i+1}</span>
        <button class="${sel.has(i)?"":"ghost"}" data-t="${i}" aria-label="Pick page ${i+1}">${sel.has(i)?"✓ Picked":"Pick"}</button>
      </div>`).join("");
    $("sheet").innerHTML = h`<h3>Copy pages → new PDF</h3>
      <p class="hint">Pick the pages you want. They are copied into a brand-new PDF file — this document stays exactly as it is.</p>
      <div>${raw(rows)}</div>
      <div class="sheetfoot">
        <div class="row"><button class="full" id="exGo" ${raw(sel.size?"":"disabled")}>Save ${sel.size||0} page${sel.size===1?"":"s"} as a new PDF</button></div>
        <div class="row"><button class="ghost full" id="exCancel">Cancel</button></div>
      </div>`;
    $("sheet").querySelectorAll("[data-t]").forEach(b=>b.onclick=()=>{ const i=+b.dataset.t; sel.has(i)?sel.delete(i):sel.add(i); draw(); });
    $("exGo").onclick = async ()=>{ closeSheet(); await doExtract([...sel].sort((a,b)=>a-b)); };
    $("exCancel").onclick = closeSheet;
    lazyThumbs();
  }
  draw(); openSheet();
}
async function doExtract(pages){
  if (!pages.length) return;
  showSpin(true,"Copying "+pages.length+" page(s)…");
  try {
    const copy = mupdf.Document.openDocument(workingBytes.slice(0), "application/pdf").asPDF();
    copy.rearrangePages(pages);
    const bytes = u8(copy.saveToBuffer("garbage").asUint8Array());
    copy.destroy();
    // share sheet first (reliable in a standalone iOS PWA, where <a download>
    // often does nothing); download is the fallback when sharing isn't possible
    const ok = await saveOrShare(bytes, baseName()+"_pages.pdf");
    setStatus(ok ? pages.length+" page(s) saved as a new PDF — pick where to keep it."
                 : "Save cancelled.","ok");
  } catch(err){ setStatus("Could not copy the pages: "+friendly(err),"err"); }
  showSpin(false);
}

// ---- v11.93: moving a selection (pure) ------------------------------------
// Reordering was one page at a time: ↑ or ↓ on a single row in Organise. Moving
// pages 4-9 up by three meant eighteen taps. This moves a whole selection one
// step and returns both the new order AND where the selection ended up, since
// the caller has to keep the same pages selected afterwards.
//
// The rules are the ones that make repeated taps behave: a page at the edge
// stays put, and a page blocked by an already-moved sibling stays put too —
// so a selection that reaches the top simply stops, and a non-contiguous
// selection closes up against the edge instead of scattering.
//
// Order of traversal is what makes that work: moving earlier, the leftmost
// selected page goes first, so the one behind it sees the vacated slot.
function moveSelection(order, sel, dir){
  const n = order.length;
  const out = order.slice();
  const placed = new Set();
  const positions = [...sel].filter(p=> p>=0 && p<n).sort((a,b)=> dir < 0 ? a-b : b-a);
  for (const p of positions){
    const q = p + dir;
    if (q < 0 || q >= n || placed.has(q)){ placed.add(p); continue; }
    const t = out[p]; out[p] = out[q]; out[q] = t;
    placed.add(q);
  }
  return { order: out, sel: placed };
}

// Does this selection have anywhere left to go? Both buttons grey out at the
// end rather than looking live and doing nothing.
function canMoveSelection(order, sel, dir){
  if (!sel || !sel.size) return false;
  const r = moveSelection(order, sel, dir);
  return r.order.some((v,i)=> v !== order[i]);
}

// The pages between two taps, inclusive. Selecting 4-9 was six taps; this is
// two — tap 4, hold 9.
function rangeBetween(a, b){
  const lo = Math.min(a,b), hi = Math.max(a,b), out = [];
  for (let i=lo; i<=hi; i++) out.push(i);
  return out;
}

// ---------------- all pages: Preview-style thumbnail grid (v11.10) ----------------
// A near-full-height sheet with every page as a thumbnail. Tap a page to jump
// to it; Select mode allows rotate / copy-to-new-PDF / delete on a selection.
// Reordering keeps its dedicated Organize sheet (drag needs the row layout).
function openPagesGrid(keepSel){
  if (!workingBytes || !MDOC) return;
  const n = MDOC.countPages();
  let selecting = !!(keepSel && keepSel.size);
  const sel = new Set(keepSel || []);
  // v11.93: the last page tapped on its own. Holding another page fills the
  // range between the two, which is the difference between six taps and two
  // when you want pages 4-9.
  let anchor = (keepSel && keepSel.size) ? Math.max(...keepSel) : null;
  let held = false;                       // a long-press fired: swallow its click
  function draw(){
    const cells = Array.from({length:n},(_,i)=> h`<button class="pgcell ${sel.has(i)?'sel':''}" data-pg="${i}"
        aria-label="Page ${i+1}${sel.has(i)?', selected':''}">
        <img data-pthumb="${i}" alt="">
        <span class="pgnum">${i+1}</span>
      </button>`).join("");
    const ord = Array.from({length:n},(_,i)=>i);
    const acts = selecting ? h`<div class="pgacts">
        <div class="pgrow">
          <button class="ghost" id="pgRot" ${sel.size?"":"disabled"}>⟳ Rotate</button>
          <button class="ghost" id="pgDup" ${sel.size?"":"disabled"}>Duplicate</button>
          <button class="ghost" id="pgBlank" ${sel.size===1?"":"disabled"}>+ Blank</button>
          <button class="ghost" id="pgExt" ${sel.size?"":"disabled"}>Copy</button>
          <button class="ghost danger" id="pgDel" ${sel.size?"":"disabled"}>Delete</button>
        </div>
        <div class="pgrow">
          <button class="ghost" id="pgUp" ${canMoveSelection(ord, sel, -1)?"":"disabled"}>← Earlier</button>
          <button class="ghost" id="pgDown" ${canMoveSelection(ord, sel, 1)?"":"disabled"}>Later →</button>
          <button class="ghost" id="pgAll">${sel.size === n ? "Select none" : "Select all"}</button>
        </div>
      </div>` : "";
    $("sheet").innerHTML = h`
      <div class="pghead">
        <button class="ghost mini" id="pgDone">Done</button>
        <h3 class="pgttl">${selecting ? (sel.size ? sel.size+" selected" : "Select pages") : "All pages"}</h3>
        <button class="ghost mini" id="pgSel">${selecting ? "Cancel" : "Select"}</button>
      </div>
      ${raw(selecting ? '<p class="pghint">Tap to select · hold a second page to take the whole range</p>' : "")}
      <div class="pggrid">${raw(cells)}</div>${raw(acts)}`;
    $("sheet").classList.add("fullpage");
    $("pagesBtn").classList.add("on");     // v11.14: bar shows Pages is open
    $("pgDone").onclick = closeSheet;
    $("pgSel").onclick = ()=>{ selecting = !selecting; sel.clear(); anchor = null; draw(); };
    $("sheet").querySelectorAll("[data-pg]").forEach(b=>{
      const i = +b.dataset.pg;
      b.onclick = ()=>{
        if (held){ held = false; return; }        // the hold already acted
        if (!selecting){ closeSheet(); scrollToPage(i); return; }
        sel.has(i) ? sel.delete(i) : sel.add(i);
        anchor = sel.has(i) ? i : null;
        draw();
      };
      // Press and hold to extend from the last single tap. Deliberately not a
      // drag: a thumbnail is a poor drag target on a phone, and the sheet
      // itself pans. 420ms is long enough not to fire on a scroll flick.
      let timer = null;
      const cancel = ()=>{ if (timer){ clearTimeout(timer); timer = null; } };
      b.onpointerdown = ()=>{
        if (!selecting) return;
        cancel();
        timer = setTimeout(()=>{
          timer = null; held = true;
          const from = (anchor === null) ? i : anchor;
          for (const p of rangeBetween(from, i)) sel.add(p);
          anchor = i;
          draw();
        }, 420);
      };
      b.onpointerup = cancel; b.onpointercancel = cancel; b.onpointerleave = cancel;
      b.onpointermove = cancel;
    });
    if (selecting){
      const ident = ()=>Array.from({length:MDOC.countPages()},(_,i)=>i);
      $("pgAll").onclick = ()=>{
        if (sel.size === n) sel.clear();
        else for (let i=0;i<n;i++) sel.add(i);
        anchor = null;
        draw();
      };
      // Moving is applied straight away, like Rotate, rather than queued: the
      // thumbnails have to show the new order for the next tap to make sense.
      const move = async (dir)=>{
        const r = moveSelection(ident(), sel, dir);
        if (!r.order.some((v,i)=> v !== i)) return;
        closeSheet();
        await applyOrganise(r.order, {});
        openPagesGrid(r.sel);
      };
      $("pgUp").onclick   = ()=> move(-1);
      $("pgDown").onclick = ()=> move(1);
      $("pgRot").onclick = async ()=>{
        const rot = {}; for (const i of sel) rot[i] = 90;
        closeSheet();
        await applyOrganise(ident(), rot);
        openPagesGrid(sel);                    // page count unchanged → keep selection
      };
      $("pgExt").onclick = async ()=>{
        const pages = [...sel].sort((a,b)=>a-b);
        closeSheet();
        await doExtract(pages);
      };
      // v11.44: duplicate each selected page in place (copy lands right after
      // its original), and insert a blank page after a single selected page.
      $("pgDup").onclick = async ()=>{
        const pages = [...sel].sort((a,b)=>a-b);
        closeSheet();
        await duplicatePages(pages);
        openPagesGrid();
      };
      $("pgBlank").onclick = async ()=>{
        const after = [...sel][0];
        closeSheet();
        await insertBlankAfter(after);
        openPagesGrid();
      };
      $("pgDel").onclick = async ()=>{
        if (sel.size >= n){ setStatus("Cannot delete every page.","err"); return; }
        const keep = ident().filter(i=>!sel.has(i));
        closeSheet();
        await applyOrganise(keep, {});
        setStatus("Deleted "+sel.size+" page"+(sel.size>1?"s":"")+" — Undo brings them back.","ok");
        openPagesGrid();
      };
    }
    lazyThumbs();
  }
  draw();
  openSheet();
}

// ---- v11.44: duplicate pages / insert a blank page ------------------------
// Duplicate uses the same graftPage primitive Combine and scan-append use: the
// page is grafted from a COPY of the document into the live one, right after
// its original, so resources (fonts, images) are carried across properly
// rather than re-rasterised. Grafting runs in reverse index order so earlier
// insertion points stay valid.
async function duplicatePages(pages){
  if (!pages || !pages.length) return;
  showSpin(true,"Duplicating "+pages.length+" page(s)…");
  try {
    pushUndo();
    const src = mupdf.Document.openDocument(workingBytes.slice(0), "application/pdf").asPDF();
    try {
      for (const i of [...pages].sort((a,b)=>b-a)) MDOC.graftPage(i+1, src, i);
    } finally { try{ src.destroy(); }catch(e){} }
    workingBytes = u8(MDOC.saveToBuffer("garbage").asUint8Array());
    reopen(); await render();
    setStatus("Duplicated "+pages.length+" page"+(pages.length>1?"s":"")
      +" — each copy sits right after its original. Now "+MDOC.countPages()+" pages.","ok");
  } catch(e){ setStatus("Could not duplicate: "+friendly(e),"err"); }
  showSpin(false);
}
// The blank page matches its neighbour's size, so an A4 document stays all-A4.
async function insertBlankAfter(i){
  showSpin(true,"Inserting a blank page…");
  try {
    pushUndo();
    const doc = await PDFDocument.load(workingBytes, { ignoreEncryption:true });
    const ref = doc.getPage(i);
    doc.insertPage(i+1, [ref.getWidth(), ref.getHeight()]);
    workingBytes = new Uint8Array(await doc.save());
    reopen(); await render();
    setStatus("Blank page added after page "+(i+1)+" — Undo removes it.","ok");
  } catch(e){ setStatus("Could not add a blank page: "+friendly(e),"err"); }
  showSpin(false);
}

// ---- v11.51: stamping (watermark, page numbers) ---------------------------
// Both stamps have to land where the reader SEES them, which is not where the
// page's own coordinates put them: a page carrying /Rotate 90 (every sideways
// scan this app produces) is displayed turned, so PDF bottom-left appears at
// the visual TOP-left. The mapping below was measured, not assumed — a mark
// drawn at PDF (5,5) was rendered through MuPDF at each rotation and located:
//
//   /Rotate   PDF origin (bottom-left) appears at
//     0       visual bottom-left
//    90       visual top-left
//   180       visual top-right
//   270       visual bottom-right
//
// which inverts to the four cases in visualToPdf. Pure functions, so the
// geometry is checked directly by tests rather than by eye.
function pageVisualSize(w, h, rot){
  const r = ((Math.round((rot||0)/90)*90)%360+360)%360;
  return (r === 90 || r === 270) ? { VW:h, VH:w, r } : { VW:w, VH:h, r };
}
// visual (vx from left, vy from TOP) -> PDF (x, y-up)
function visualToPdf(w, h, rot, vx, vy){
  const r = ((Math.round((rot||0)/90)*90)%360+360)%360;
  if (r === 90)  return { x: vy,     y: vx };
  if (r === 180) return { x: w - vx, y: vy };
  if (r === 270) return { x: w - vy, y: h - vx };
  return { x: vx, y: h - vy };
}
// pdf-lib rotates text about its draw origin, so to CENTRE a run at (cx,cy)
// we walk back half its width along the baseline and half its height across it
function textOriginFor(cx, cy, textW, textH, deg){
  const a = (deg||0) * Math.PI/180, c = Math.cos(a), s = Math.sin(a);
  return {
    x: cx - (textW/2)*c + (textH/2)*s,
    y: cy - (textW/2)*s - (textH/2)*c,
  };
}
async function applyWatermark(text, opts){
  const t = String(text||"").trim();
  if (!t) return;
  const o = opts || {};
  showSpin(true,"Adding the watermark…");
  try {
    pushUndo();
    const doc = await PDFDocument.load(workingBytes, { ignoreEncryption:true });
    const font = await doc.embedFont(pickFontKeyed("", o.font || "sans"));
    const col = o.colour || [0.5,0.5,0.5];
    const pages = doc.getPages();
    for (const pg of pages){
      const w = pg.getWidth(), h = pg.getHeight();
      const rot = (pg.getRotation && pg.getRotation().angle) || 0;
      const V = pageVisualSize(w, h, rot);
      // size so the run spans ~72% of the visual diagonal
      const unit = Math.max(0.01, font.widthOfTextAtSize(sanitizeForFont(t), 1));
      const diag = Math.hypot(V.VW, V.VH);
      const size = Math.max(8, Math.min(240, (diag*0.72)/unit));
      const tw = font.widthOfTextAtSize(sanitizeForFont(t), size), th = size*0.7;
      // the visual centre of the page, in PDF coordinates
      const c = visualToPdf(w, h, rot, V.VW/2, V.VH/2);
      // 45° up the visual diagonal, plus whatever the page rotation adds
      const deg = (o.diagonal === false ? 0 : 45) + (((Math.round(rot/90)*90)%360)+360)%360;
      const org = textOriginFor(c.x, c.y, tw, th, deg);
      pg.drawText(sanitizeForFont(t), {
        x:org.x, y:org.y, size, font, rotate: degrees(deg),
        color: rgb(col[0], col[1], col[2]),
        opacity: o.opacity == null ? 0.18 : o.opacity,
      });
    }
    workingBytes = new Uint8Array(await doc.save());
    reopen(); await render();
    setStatus("Watermark added to all "+pages.length+" page"+(pages.length>1?"s":"")+". Undo removes it.","ok");
  } catch(e){ setStatus("Could not add the watermark: "+friendly(e),"err"); }
  showSpin(false);
}
function pageNumberText(fmt, n, total){
  if (fmt === "of")   return n + " of " + total;
  if (fmt === "page") return "Page " + n + " of " + total;
  return String(n);
}
async function applyPageNumbers(o){
  o = o || {};
  showSpin(true,"Numbering the pages…");
  try {
    pushUndo();
    const doc = await PDFDocument.load(workingBytes, { ignoreEncryption:true });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const pages = doc.getPages();
    const from = Math.max(1, Math.min(pages.length, o.from || 1));   // first page to STAMP
    const startAt = o.startAt == null ? 1 : o.startAt;               // number shown on it
    const size = o.size || 10;
    const total = pages.length - from + startAt;
    let stamped = 0;
    const skipSet = new Set(o.skip || []);
    for (let i = from-1; i < pages.length; i++){
      if (skipSet.has(i)) continue;      // v11.59: already has a number
      const pg = pages[i];
      const w = pg.getWidth(), h = pg.getHeight();
      const rot = (pg.getRotation && pg.getRotation().angle) || 0;
      const V = pageVisualSize(w, h, rot);
      const label = pageNumberText(o.format || "plain", startAt + (i - (from-1)), total);
      const tw = font.widthOfTextAtSize(label, size), th = size*0.7;
      const margin = 28;
      // visual position: bottom of the page as the READER sees it
      const vx = o.align === "right" ? V.VW - margin - tw/2
               : o.align === "left"  ? margin + tw/2
                                     : V.VW/2;
      const vy = (o.edge === "top" ? margin : V.VH - margin);
      const c = visualToPdf(w, h, rot, vx, vy);
      const deg = (((Math.round(rot/90)*90)%360)+360)%360;
      const org = textOriginFor(c.x, c.y, tw, th, deg);
      pg.drawText(label, { x:org.x, y:org.y, size, font, rotate: degrees(deg), color: rgb(0.25,0.25,0.28) });
      stamped++;
    }
    workingBytes = new Uint8Array(await doc.save());
    reopen(); await render();
    setStatus("Numbered "+stamped+" page"+(stamped>1?"s":"")
      + (from > 1 ? " (starting on page "+from+", so a cover stays clean)" : "")+". Undo removes it.","ok");
  } catch(e){ setStatus("Could not number the pages: "+friendly(e),"err"); }
  showSpin(false);
}
function openWatermarkSheet(){
  let colour = "grey", strength = "light", diagonal = true;
  const draw = ()=>{
    $("sheet").innerHTML = h`
      <h3>Watermark</h3>
      <p class="hint">Stamped across every page, under nothing — it sits on top, so it prints. Undo removes it.</p>
      <div class="row"><input type="text" id="wmIn" placeholder="DRAFT, CONFIDENTIAL, COPY…" value="DRAFT"></div>
      <div class="row telbl">Shade</div>
      <div class="row teseg" id="wmStr">
        ${raw(["light","medium","strong"].map(k=>`<button class="segb${strength===k?" on":""}" data-k="${k}">${k[0].toUpperCase()+k.slice(1)}</button>`).join(""))}
      </div>
      <div class="row telbl">Colour</div>
      <div class="row teseg tewrap" id="wmCol">
        ${raw(TE_COLOURS.filter(c=>c.k!=="keep"&&c.k!=="white").map(c=>`<button class="segb${colour===c.k?" on":""}" data-k="${c.k}">${c.label}</button>`).join(""))}
      </div>
      <div class="row telbl">Angle</div>
      <div class="row teseg" id="wmAng">
        <button class="segb${diagonal?" on":""}" data-d="1">Diagonal</button>
        <button class="segb${diagonal?"":" on"}" data-d="0">Straight across</button>
      </div>
      <div class="row"><button class="full" id="wmOk">Add watermark</button></div>
      <div class="row"><button class="ghost full" id="wmCancel">Cancel</button></div>`;
    $("wmStr").querySelectorAll("[data-k]").forEach(b=> b.onclick = ()=>{ strength=b.dataset.k; draw(); });
    $("wmCol").querySelectorAll("[data-k]").forEach(b=> b.onclick = ()=>{ colour=b.dataset.k; draw(); });
    $("wmAng").querySelectorAll("[data-d]").forEach(b=> b.onclick = ()=>{ diagonal=b.dataset.d==="1"; draw(); });
    $("wmOk").onclick = async ()=>{
      // v11.59: any wording is allowed, but a watermark is set across the
      // diagonal at one size — a third word shrinks it to the point of being
      // unreadable, so two is the limit and the reason is given.
      const t = String($("wmIn").value||"").trim().replace(/\s+/g, " ");
      if (!t){ setStatus("Type the word you want stamped across the pages.","warn"); return; }
      if (t.split(" ").length > 2){
        setStatus("Up to two words — a longer phrase has to be set so small across the page that it stops being readable.","warn");
        return;
      }
      closeSheet();
      await applyWatermark(t, {
        colour: (TE_COLOURS.find(c=>c.k===colour)||{}).rgb || [0.5,0.5,0.5],
        opacity: strength==="light" ? 0.12 : strength==="medium" ? 0.22 : 0.38,
        diagonal,
      });
    };
    $("wmCancel").onclick = closeSheet;
  };
  draw(); openSheet();
  setTimeout(()=>{ try{ $("wmIn").focus(); }catch(e){} }, 100);
}
// v11.59: does this page already carry a page number? Judged the way a reader
// would: a short run of text sitting in the top or bottom margin that reads as
// a number. The document that prompted this had "Page 2 of 5" stamped on it
// FOUR times, because nothing ever checked.
function looksLikePageNumber(t){
  const s = String(t||"").trim();
  if (!s || s.length > 24) return false;
  return /^(page\s*)?\d{1,4}(\s*(of|\/)\s*\d{1,4})?$/i.test(s)
      || /^[-–—]\s*\d{1,4}\s*[-–—]$/.test(s);
}
function pagesWithNumbers(){
  const hits = [];
  const n = MDOC.countPages();
  for (let i=0;i<n;i++){
    try {
      const p = MDOC.loadPage(i);
      const [x0,y0,x1,y1] = p.getBounds();
      const hPt = y1-y0, margin = Math.max(24, hPt*0.09);
      const st = p.toStructuredText("preserve-spans");
      let cur = null, found = false;
      st.walk({
        beginLine(){ cur = { t:"", y:0 }; },
        onChar(c, origin){ if (!cur) return; cur.t += c; if (!cur.y) cur.y = origin[1];
          if (!found && looksLikePageNumber(cur.t) &&
              (cur.y <= y0 + margin || cur.y >= y1 - margin)) found = true; },
      });
      st.destroy(); p.destroy();
      if (found) hits.push(i);
    } catch(e){}
  }
  return hits;
}
function openPageNumberSheet(){
  const n = MDOC.countPages();
  const already = pagesWithNumbers();
  if (already.length){
    const all = already.length === n;
    $("sheet").innerHTML = h`
      <h3>Numbers are already there</h3>
      <p class="hint">${already.length} of ${n} page${n>1?"s":""} already ${already.length>1?"carry":"carries"} what looks like a page number${all?"":" — page"+(already.length>1?"s ":" ")+already.map(i=>i+1).join(", ")}. Adding another set would stack a second number on top of the first.</p>
      <div class="row"><button class="full" id="pnSkip" ${all?"disabled":""}>Number only the ${n-already.length} page${n-already.length===1?"":"s"} without one</button></div>
      <div class="row"><button class="full" id="pnAnyway">Number every page anyway</button></div>
      <div class="row"><button class="ghost full" id="pnStop">Cancel</button></div>`;
    $("pnAnyway").onclick = ()=> pageNumberOptions(null);
    if (!all) $("pnSkip").onclick = ()=> pageNumberOptions(already);
    $("pnStop").onclick = closeSheet;
    openSheet();
    return;
  }
  pageNumberOptions(null);
}
// `skip` is a list of page indexes to leave alone, or null for all pages.
function pageNumberOptions(skip){
  const n = MDOC.countPages();
  let format = "plain", align = "center", edge = "bottom", skipCover = false;
  const draw = ()=>{
    $("sheet").innerHTML = h`
      <h3>Page numbers</h3>
      <p class="hint">Added to all ${n} pages, at the bottom as the reader sees it — sideways pages are numbered the right way up.</p>
      <div class="row telbl">Style</div>
      <div class="row teseg" id="pnFmt">
        <button class="segb${format==="plain"?" on":""}" data-k="plain">1</button>
        <button class="segb${format==="of"?" on":""}" data-k="of">1 of ${n}</button>
        <button class="segb${format==="page"?" on":""}" data-k="page">Page 1 of ${n}</button>
      </div>
      <div class="row telbl">Position</div>
      <div class="row teseg" id="pnAlign">
        ${raw(["left","center","right"].map(k=>`<button class="segb${align===k?" on":""}" data-k="${k}">${k==="center"?"Centre":k[0].toUpperCase()+k.slice(1)}</button>`).join(""))}
      </div>
      <div class="row teseg" id="pnEdge">
        <button class="segb${edge==="bottom"?" on":""}" data-k="bottom">Bottom</button>
        <button class="segb${edge==="top"?" on":""}" data-k="top">Top</button>
      </div>
      ${raw(n > 1 ? `<div class="row teseg" id="pnSkip">
        <button class="segb${skipCover?" on":""}" data-k="1">Skip the first page</button>
      </div>` : "")}
      <div class="row"><button class="full" id="pnOk">Add numbers</button></div>
      <div class="row"><button class="ghost full" id="pnCancel">Cancel</button></div>`;
    $("pnFmt").querySelectorAll("[data-k]").forEach(b=> b.onclick = ()=>{ format=b.dataset.k; draw(); });
    $("pnAlign").querySelectorAll("[data-k]").forEach(b=> b.onclick = ()=>{ align=b.dataset.k; draw(); });
    $("pnEdge").querySelectorAll("[data-k]").forEach(b=> b.onclick = ()=>{ edge=b.dataset.k; draw(); });
    if ($("pnSkip")) $("pnSkip").querySelectorAll("[data-k]").forEach(b=> b.onclick = ()=>{ skipCover=!skipCover; draw(); });
    $("pnOk").onclick = async ()=>{
      closeSheet();
      await applyPageNumbers({ format, align, edge, from: skipCover ? 2 : 1,
                               startAt: skipCover ? 2 : 1, skip });
    };
    $("pnCancel").onclick = closeSheet;
  };
  draw(); openSheet();
}

// ---- v11.52: crop and resize pages ----------------------------------------
// Two everyday jobs Acrobat charges for. Crop is offered as "trim the white
// margins", which is what people actually want on a scan or a printout — the
// margin is found by RENDERING the page and looking for ink, not guessed.
// Resize rescales the content into a real paper size, so a mixed pile of A4,
// Letter and captured shapes prints as one consistent document.

// Ink bounds of a page, in VISUAL coordinates (as the reader sees it, with
// /Rotate applied by the renderer), returned as fractions of the visual page.
// null when the page is blank — cropping a blank page to nothing is a trap.
function inkBoundsFrac(pageIndex, working){
  let page = null, pix = null;
  try {
    page = MDOC.loadPage(pageIndex);
    const [x0,y0,x1,y1] = page.getBounds();
    const s = Math.min(1.4, 900/Math.max(x1-x0, y1-y0));   // ~100dpi is plenty
    pix = page.toPixmap(mupdf.Matrix.scale(s,s), mupdf.ColorSpace.DeviceRGB, false);
    const W = pix.getWidth(), H = pix.getHeight(), St = pix.getStride(), n = pix.getNumberOfComponents();
    const px = pix.getPixels();
    // Paper is rarely pure white on a scan, so the threshold is relative to
    // the page's own brightest tone rather than to 255.
    let peak = 0;
    for (let y=0;y<H;y+=3) for (let x=0;x<W;x+=3){
      const g = (px[y*St+x*n]*77 + px[y*St+x*n+1]*151 + px[y*St+x*n+2]*28) >> 8;
      if (g > peak) peak = g;
    }
    const cut = Math.max(24, peak - 42);
    let minX=W, minY=H, maxX=-1, maxY=-1;
    for (let y=0;y<H;y++) for (let x=0;x<W;x++){
      const i = y*St + x*n;
      const g = (px[i]*77 + px[i+1]*151 + px[i+2]*28) >> 8;
      if (g < cut){
        if (x<minX) minX=x; if (x>maxX) maxX=x;
        if (y<minY) minY=y; if (y>maxY) maxY=y;
      }
    }
    if (maxX < 0) return null;                       // nothing on the page
    return { x0:minX/W, y0:minY/H, x1:(maxX+1)/W, y1:(maxY+1)/H };
  } catch(e){ return null; }
  finally { try{ if(pix) pix.destroy(); }catch(e){} try{ if(page) page.destroy(); }catch(e){} }
}
// A visual rectangle (fractions) -> a PDF-space crop box, honouring /Rotate.
// Reuses the measured mapping from v11.51 rather than a second guess at it.
function cropBoxFromVisual(w, h, rot, f){
  const V = pageVisualSize(w, h, rot);
  const a = visualToPdf(w, h, rot, f.x0*V.VW, f.y0*V.VH);
  const b = visualToPdf(w, h, rot, f.x1*V.VW, f.y1*V.VH);
  return {
    x: Math.min(a.x,b.x), y: Math.min(a.y,b.y),
    w: Math.abs(b.x-a.x), h: Math.abs(b.y-a.y),
  };
}
async function applyCropMargins(o){
  o = o || {};
  showSpin(true,"Trimming the margins…");
  try {
    const n = MDOC.countPages();
    const targets = o.allPages ? Array.from({length:n},(_,i)=>i) : [Math.max(0, Math.min(n-1, o.page||0))];
    // measure BEFORE the undo snapshot: a page with nothing to trim must not
    // leave an undo step (or a "done" message) behind
    const found = [];
    for (const i of targets){
      const f = inkBoundsFrac(i);
      if (!f) continue;
      // keep a small breathing margin so the trim never shaves the ink itself
      const pad = (o.pad == null ? 0.012 : o.pad);
      const g = {
        x0: Math.max(0, f.x0 - pad), y0: Math.max(0, f.y0 - pad),
        x1: Math.min(1, f.x1 + pad), y1: Math.min(1, f.y1 + pad),
      };
      // refuse a crop that would remove almost nothing, or almost everything
      const area = (g.x1-g.x0)*(g.y1-g.y0);
      if (area > 0.965 || area < 0.02) continue;
      found.push({ i, g });
    }
    if (!found.length){
      showSpin(false);
      setStatus(targets.length > 1
        ? "Nothing to trim — these pages have no wide blank margins."
        : "Nothing to trim — this page has no wide blank margins.","warn");
      return;
    }
    pushUndo();
    const doc = await PDFDocument.load(workingBytes, { ignoreEncryption:true });
    for (const { i, g } of found){
      const pg = doc.getPage(i);
      const mb = pg.getMediaBox();
      const rot = (pg.getRotation && pg.getRotation().angle) || 0;
      const box = cropBoxFromVisual(mb.width, mb.height, rot, g);
      pg.setCropBox(mb.x + box.x, mb.y + box.y, box.w, box.h);
    }
    workingBytes = new Uint8Array(await doc.save());
    reopen(); await render();
    setStatus("Trimmed the margins on "+found.length+" page"+(found.length>1?"s":"")
      +". Nothing was deleted — the crop can be undone.","ok");
  } catch(e){ setStatus("Could not trim the margins: "+friendly(e),"err"); }
  showSpin(false);
}
async function applyResizePages(paperKey, allPages){
  const paper = PAPER_SIZES[paperKey];
  if (!paper) return;
  showSpin(true,"Resizing…");
  try {
    pushUndo();
    const doc = await PDFDocument.load(workingBytes, { ignoreEncryption:true });
    const pages = doc.getPages();
    const list = allPages ? pages : [pages[0]];
    let changed = 0;
    for (const pg of list){
      const mb = pg.getMediaBox();
      const w = mb.width, h = mb.height;
      // turn the PAPER to match the page, so a landscape page stays landscape
      const tw = (w > h) ? paper.h : paper.w;
      const th = (w > h) ? paper.w : paper.h;
      if (Math.abs(w-tw) < 0.5 && Math.abs(h-th) < 0.5) continue;
      // uniform scale keeps the content's proportions; the remainder becomes
      // an even margin rather than a stretch
      const s = Math.min(tw/w, th/h);
      pg.scaleContent(s, s);
      pg.translateContent((tw - w*s)/2, (th - h*s)/2);
      pg.setSize(tw, th);
      changed++;
    }
    if (!changed){
      showSpin(false);
      setStatus("Already "+paper.label+" — nothing to resize.","ok");
      return;
    }
    workingBytes = new Uint8Array(await doc.save());
    reopen(); await render();
    setStatus("Resized "+changed+" page"+(changed>1?"s":"")+" to "+paper.label
      +" — the content keeps its proportions and is centred. Undo reverses it.","ok");
  } catch(e){ setStatus("Could not resize: "+friendly(e),"err"); }
  showSpin(false);
}
function openPageSizeSheet(){
  const n = MDOC.countPages();
  let allPages = true;
  const draw = ()=>{
    $("sheet").innerHTML = h`
      <h3>Crop &amp; resize</h3>
      <p class="hint">Trimming finds the ink on the page and cuts the blank border to it — nothing is deleted, so it undoes cleanly. Resizing rescales the content into a real paper size and centres it.</p>
      ${raw(n > 1 ? `<div class="row teseg" id="csScope">
        <button class="segb${allPages?" on":""}" data-a="1">All ${n} pages</button>
        <button class="segb${allPages?"":" on"}" data-a="0">This page only</button>
      </div>` : "")}
      <div class="row telbl">Trim</div>
      <div class="row"><button class="full" id="csTrim">Trim the blank margins</button></div>
      <div class="row telbl">Resize to</div>
      <div class="row"><button class="full" id="csA4">A4</button></div>
      <div class="row"><button class="full" id="csLetter">Letter</button></div>
      <div class="row"><button class="full" id="csLegal">Legal</button></div>
      <div class="row"><button class="ghost full" id="csCancel">Cancel</button></div>`;
    if ($("csScope")) $("csScope").querySelectorAll("[data-a]").forEach(b=>
      b.onclick = ()=>{ allPages = b.dataset.a === "1"; draw(); });
    $("csTrim").onclick = ()=>{ closeSheet(); applyCropMargins({ allPages, page: currentPageIndex() }); };
    $("csA4").onclick     = ()=>{ closeSheet(); applyResizePages("a4", allPages); };
    $("csLetter").onclick = ()=>{ closeSheet(); applyResizePages("letter", allPages); };
    $("csLegal").onclick  = ()=>{ closeSheet(); applyResizePages("legal", allPages); };
    $("csCancel").onclick = closeSheet;
  };
  draw(); openSheet();
}
// Which page is the reader looking at? Used so "this page only" means the one
// on screen. Falls back to the first page when nothing is measurable.
function currentPageIndex(){
  try {
    const v = $("viewer"), vr = v.getBoundingClientRect();
    let best = 0, bestArea = -1;
    v.querySelectorAll(".stage").forEach(s=>{
      const r = s.getBoundingClientRect();
      const overlap = Math.max(0, Math.min(r.bottom, vr.bottom) - Math.max(r.top, vr.top));
      if (overlap > bestArea){ bestArea = overlap; best = +s.dataset.page || 0; }
    });
    return best;
  } catch(e){ return 0; }
}

// ---------------- merge (mupdf graftPage, with chosen order) ----------------
$("mergeInput").onchange = async e=>{
  const files=[...e.target.files]; e.target.value="";
  if(!files.length) return;
  showSpin(true,"Reading "+files.length+" file(s)…");
  try {
    const picked = [];
    for (const f of files) picked.push({ name:f.name, bytes:new Uint8Array(await f.arrayBuffer()) });
    // the currently-open document plus the picked files; user chooses the order
    mergeSources = [{ name:(fileName||"document.pdf")+" (current)", bytes:workingBytes }, ...picked];
    showSpin(false);
    openMergeOrder();
  } catch(err){ setStatus("Could not combine: "+friendly(err),"err"); showSpin(false); }
};

function openMergeOrder(){
  function draw(){
    const rows = mergeSources.map((s,pos)=>h`
      <div class="porow" data-pos="${pos}">
        <span class="pn"><b>PDF ${pos+1}</b> · ${s.name}</span>
        <button class="ghost" data-up="${pos}" aria-label="Move PDF ${pos+1} up">↑</button>
        <button class="ghost" data-dn="${pos}" aria-label="Move PDF ${pos+1} down">↓</button>
      </div>`).join("");
    $("sheet").innerHTML = h`<h3>Combine — choose the order</h3>
      <p class="hint">Pages are combined top to bottom — PDF 1 first, then PDF 2, and so on. Reorder with ↑ ↓.</p>
      ${raw(rows)}
      <div class="sheetfoot">
        <div class="row"><button class="full" id="mgApply">Combine in this order</button></div>
        <div class="row"><button class="ghost full" id="mgCancel">Cancel</button></div>
      </div>`;
    $("sheet").querySelectorAll("[data-up]").forEach(b=>b.onclick=()=>{const p=+b.dataset.up; if(p>0){[mergeSources[p-1],mergeSources[p]]=[mergeSources[p],mergeSources[p-1]]; draw();}});
    $("sheet").querySelectorAll("[data-dn]").forEach(b=>b.onclick=()=>{const p=+b.dataset.dn; if(p<mergeSources.length-1){[mergeSources[p+1],mergeSources[p]]=[mergeSources[p],mergeSources[p+1]]; draw();}});
    $("mgApply").onclick = ()=>{ const s=mergeSources.slice(); closeSheet(); doMerge(s); };
    $("mgCancel").onclick = ()=>{ mergeSources=null; closeSheet(); };
  }
  draw();
  openSheet();
}

async function doMerge(sources){
  showSpin(true,"Combining "+sources.length+" PDFs…");
  try {
    // Parse and validate EVERY source first. If any input PDF is unreadable we
    // bail out here, before pushUndoGuarded()/dirty are touched, so a failed
    // merge can't leave a stale "unsaved changes"/undo step on an unchanged doc.
    const docs = [];
    try {
      for (const s of sources)
        docs.push(mupdf.Document.openDocument(s.bytes.slice(0), "application/pdf").asPDF());
    } catch(err){
      for (const d of docs){ try{ d.destroy(); }catch(e){} }
      throw err;
    }
    const undoKept = pushUndoGuarded();   // now committed; skip the snapshot on very large files (#5)
    // first source is the base; graft the rest onto its end, in order
    const base = docs[0];
    for (let k=1;k<docs.length;k++){
      const c = docs[k].countPages();
      for (let i=0;i<c;i++) base.graftPage(-1, docs[k], i);
      docs[k].destroy();
    }
    workingBytes = u8(base.saveToBuffer("garbage").asUint8Array());
    base.destroy();
    fileName = "merged.pdf";
    reopen(); await render(); enableDocButtons(true);
    setStatus("Combined "+sources.length+" PDFs — now "+MDOC.countPages()+" pages."
      + (undoKept ? "" : " (Too large to keep an undo step.)"),"ok");
  } catch(err){ setStatus("Could not combine: "+friendly(err),"err"); }
  mergeSources=null; showSpin(false);
}

// ---------------- images -> PDF (always a brand-new file) ----------------
$("imgInput").onchange = async e=>{
  const files=[...e.target.files]; e.target.value="";
  if(!files.length) return;
  showSpin(true,"Turning "+files.length+" photo(s) into a PDF…");
  try {
    const doc = await PDFDocument.create();         // fresh document, ignores any open file
    for (const f of files){
      // v10.92: size budget. Original camera bytes went straight into the PDF —
      // five 12MP photos made a ~15–20MB file. Photos larger than ~1.8MB or
      // 2600px are now downscaled to max 2200px and re-encoded as JPEG q85,
      // which reads identically on a page but keeps documents shareable.
      // Small images and PNGs with transparency are embedded untouched.
      let buf = new Uint8Array(await f.arrayBuffer());
      const isPng = /png$/i.test(f.type)||/\.png$/i.test(f.name);
      let img = null;
      if (!isPng && buf.length > 1.8*1024*1024){
        try {
          const url = await fileToDataURL(f);
          const im = await loadImage(url);
          if (Math.max(im.width, im.height) > 2600 || buf.length > 1.8*1024*1024){
            const s = Math.min(1, 2200/Math.max(im.width, im.height));
            const c = document.createElement("canvas");
            c.width = Math.round(im.width*s); c.height = Math.round(im.height*s);
            c.getContext("2d").drawImage(im, 0, 0, c.width, c.height);
            const jpg = c.toDataURL("image/jpeg", 0.85);
            buf = new Uint8Array(await (await fetch(jpg)).arrayBuffer());
          }
        } catch(e){ /* fall through: embed the original bytes */ }
      }
      if (isPng) img = await doc.embedPng(buf);
      else img = await doc.embedJpg(buf).catch(async()=>{
        const jpg = await toJpeg(await fileToDataURL(f), 0.92);
        return doc.embedJpg(await (await fetch(jpg)).arrayBuffer());
      });
      // scale the page to A4-ish point sizes (long side = 842pt) instead of
      // 1px-per-point, which would make a phone photo a ~55-inch page (#2).
      const sPt = 842/Math.max(img.width, img.height);
      const pw = img.width*sPt, ph = img.height*sPt;
      const page = doc.addPage([pw, ph]);
      page.drawImage(img, { x:0, y:0, width:pw, height:ph });
    }
    // replace whatever was open — behaves like opening a new document
    workingBytes = new Uint8Array(await doc.save());
    // dated default name, same convention as scans (v10.85)
    const d=new Date();
    fileName="Photos "+d.getDate()+" "+d.toLocaleString("en",{month:"short"})+" "+d.getFullYear()
      +" "+String(d.getHours()).padStart(2,"0")+"."+String(d.getMinutes()).padStart(2,"0")+".pdf";
    undoStack = [];
    setMode(null);
    reopen(); setDirty(true); await render(); enableDocButtons(true);
    setStatus("Done — your photos are now a PDF ("+fmtKB(workingBytes.length)+"). Tap Save to keep it.","ok");
  } catch(err){ setStatus("Could not turn the photos into a PDF: "+friendly(err),"err"); }
  showSpin(false);
};

// ---- v11.33: real paper sizes for scanned pages ---------------------------
// Before v11.33 every scanned page was built as
//     sPt = 842/max(w,h);  addPage([w*sPt, h*sPt])
// which scales the LONG side to A4's 842pt but keeps whatever aspect ratio the
// detected quad happened to have. A hand-cropped A4 sheet is never exactly
// 1:1.414, so the page came out a near-A4 size that is not any real paper at
// all. That shows up three ways: the print dialog scales it ("fit to page")
// giving uneven margins, merging a scan with a born-digital PDF produces a
// document whose pages are all slightly different sizes, and page numbering or
// stamping later lands at inconsistent offsets.
//
// Now the page is a REAL size and the image is fitted inside it, letterboxed
// with white where the aspect does not match. Nothing is cropped and nothing is
// distorted: the aspect ratio of the captured pixels is preserved exactly.
// White margins are what a flatbed scanner produces too, and they compress to
// almost nothing.
const PAPER_SIZES = {
  auto:   null,                       // keep the captured shape (pre-v11.33)
  a4:     { w:595.28, h:841.89, label:"A4" },
  letter: { w:612,    h:792,    label:"Letter" },
  legal:  { w:612,    h:1008,   label:"Legal" },
};
// Fit a w×h image (px) into a paper size, honouring orientation. Returns the
// page box in points and the image rect inside it, both ready for pdf-lib.
//   key "auto"  → the old behaviour: page == image, long side 842pt.
// The paper is rotated to landscape when the image is wider than it is tall, so
// a landscape capture does not end up letterboxed into a portrait page with
// huge white bands top and bottom.
function fitToPaper(imgW, imgH, key){
  if (!(imgW > 0) || !(imgH > 0)) return null;
  const paper = PAPER_SIZES[key];
  if (!paper){                                     // "auto" / unknown key
    const s = 842/Math.max(imgW, imgH);
    return { pageW:imgW*s, pageH:imgH*s, x:0, y:0, w:imgW*s, h:imgH*s, letterboxed:false };
  }
  const landscape = imgW > imgH;
  const pageW = landscape ? paper.h : paper.w;
  const pageH = landscape ? paper.w : paper.h;
  // v11.41: snap to the paper only when the capture is actually SHAPED like
  // that paper. A capture of a real A4/Letter sheet lands within a few percent
  // of the paper's aspect (perspective + corner error account for the spread),
  // and those pages print and merge best on a true paper size. But a receipt,
  // an ID slip or a deliberately part-page crop is nowhere near it — forcing
  // one into A4 buries a 337pt-wide strip of image in a 595pt page of white,
  // and the viewer (which fits the PAGE to the screen width) then shows the
  // image ~30% smaller than v11.31 did. That is the "viewing quality reduced"
  // complaint: same pixels, drawn smaller inside a sea of letterbox. Odd
  // shapes now keep their own page size (exactly the pre-v11.33 behaviour);
  // paper-shaped captures still snap. The 20% tolerance is set by the papers
  // themselves: an A4-shaped capture with Legal selected is 16.5% off and must
  // still snap (the user chose Legal), while the nearest common non-paper
  // shapes — a 2:1 till roll (41% off), a square label (41%), an ISO ID card
  // (12% off A4 landscape, but ID has its own mode) — stay well outside it.
  // v11.55: the tolerance stays at 20%. It was briefly tightened to 10% to
  // stop an envelope snapping to A4, but that also stopped an A4-shaped
  // capture snapping when the user had explicitly ASKED for Legal (16.5%
  // apart), which is worse: an explicit choice must be honoured. The envelope
  // case is solved properly by the default now being "As captured", so this
  // gate only ever sees a paper size the user deliberately picked.
  const imgAspect  = imgW / imgH, pageAspect = pageW / pageH;
  const ratio = imgAspect / pageAspect;
  if (Math.max(ratio, 1/ratio) > 1.20){
    const s = 842/Math.max(imgW, imgH);
    return { pageW:imgW*s, pageH:imgH*s, x:0, y:0, w:imgW*s, h:imgH*s, letterboxed:false };
  }
  // contain-fit: the larger of the two scale factors would crop, so take the smaller
  const s = Math.min(pageW/imgW, pageH/imgH);
  const w = imgW*s, h = imgH*s;
  const x = (pageW-w)/2, y = (pageH-h)/2;
  // "letterboxed" is true only when the gap is big enough to see (>0.5pt on
  // either axis); a rounding-level difference is not worth reporting.
  return { pageW, pageH, x, y, w, h, letterboxed: x > 0.5 || y > 0.5 };
}
// v11.33 note on auto-rotation. The plan for this release said "auto rotate to
// portrait when the page is wider than tall". That is NOT implemented, on
// purpose, because it is wrong: a landscape certificate, a spreadsheet
// printout and a sideways-held capture of a portrait sheet all produce exactly
// the same output shape, and no amount of geometry can tell them apart —
// distinguishing them needs to read the text direction, which is an OCR job.
// Rotating on aspect alone would silently turn every genuinely landscape
// document on its side.
//
// What IS done instead, and is unambiguously correct:
//   * fitToPaper turns the PAPER to match the image, so a landscape capture
//     gets a landscape A4 page instead of being letterboxed into portrait with
//     large white bands, and
//   * every scanned page can be turned a quarter at a time from the review
//     sheet (see openScanPageSheet). That matters more now than it did: with
//     auto capture the Adjust screen — and its Rotate button — is skipped.
// The turn is stored per page and applied at PDF build time with /Rotate, so
// it is lossless: the JPEG is never re-encoded to rotate it.
function normaliseRot(r){ return ((Math.round((r||0)/90)*90)%360+360)%360; }

// ---------------- document scanner (camera → edges → crop → PDF) ----------------
// Everything runs on-device: getUserMedia camera preview, document edge
// detection in plain JS (Otsu threshold + largest connected component), a
// drag-the-corners adjust screen, true perspective correction (homography with
// bilinear sampling), optional B&W "document" filter, then pdf-lib builds the
// PDF. Multi-page: scan as many pages as you like before creating the file.
let scanStream = null;        // live MediaStream (null when off)
let scanLive = 0;             // live edge-detect interval id
let scanFallback = false;     // true => no stream; use native camera <input capture>
let scanWasLive = false;      // camera was on when the app got hidden
let scanPages = [];           // confirmed pages: [{bytes:Uint8Array(JPEG), w, h, thumb}]
let capFrame = null;          // canvas holding the full-res captured photo
let cropQuad = null;          // 4 corners in image px, order TL,TR,BR,BL
let cropUserAdjusted = false; // v10.76: true once the user moves a corner / the
                              // whole box, so "Use page" honours their selection
                              // EXACTLY (no 0.8% auto-inset, which was clipping
                              // content near the page edge).
let cropFit = null;           // image→display fit for the crop screen
const cropFilter = "colour";  // scanner is colour-only (B&W removed in v10.20)
// v11.70: "Small file" is gone, and scanQuality is pinned to "std".
// MRC made it pointless and then harmful. Measured on a 38-line A4 document:
//
//   Standard   (maxDim 3200, q0.92)   181 KB scan  ->  MRC  37 KB
//   Small file (maxDim 1400, q0.62)    71 KB scan  ->  MRC  38 KB
//
// Small file was NOT smaller once MRC ran, and it got there by capturing at
// 1400px — about 120dpi on A4 — which is below the 300dpi MRC renders its text
// stencil at. So it threw away the resolution MRC needs in exchange for
// nothing. The constant stays (SCAN_Q, encodeUnderBudget and the HQ path all
// read it) but there is no longer a way to set it to "small".
const scanQuality = "std";
// v11.81: Type and Auto are DEFAULTS, not preferences. Both are reset every
// time the scanner opens — see resetScanDefaults() — so tapping Scan always
// starts from Document with Auto off, whatever the last session did. A stored
// Photo ID from an earlier build would otherwise ambush the next document scan
// with card framing, which is a surprising way to lose a page.
let scanEnhance = true;       // "Document": flatten illumination so paper reads white
let scanIdMode = false;       // v10.79 "Photo ID": light, colour-true card placed on a white A4 page
try { localStorage.removeItem("scanEnhance"); localStorage.removeItem("scanIdMode"); } catch(e){}
// v11.32 auto capture. v11.81: OFF by default and no longer persisted. It fires
// the shutter by itself once the page looks framed and still, which is faster
// for a stack on a desk but takes the shot out of your hands — a poor thing to
// inherit silently from a previous session. Turn it on per session when it
// suits the job.
let scanAuto = false;
try { localStorage.removeItem("scanAuto"); } catch(e){}
// Called from startScan: every scanning session begins from the same place.
function resetScanDefaults(){
  scanEnhance = true;         // Type = Document
  scanIdMode  = false;
  scanAuto    = false;        // Auto off
  idTwoSide   = true;         // v11.82: Photo ID captures both sides
}
// v11.61 "HQ": take the page with the iPhone's OWN camera rather than lifting a
// frame off the live preview. This is the only change that raises the ceiling
// on scan sharpness rather than polishing underneath it.
//
// Measured, for an A4 page filling 90% of the frame (long side / short side):
//   preview frame, 4K 16:9, capped at 3200 ....... 274 / 166 dpi
//   native photo, 12MP, capped at 3200 ........... 274 / 233 dpi
//   native photo, 12MP, cap raised to 4600 ....... 310 / 233 dpi
// Adobe Scan aims at 300. The two numbers differ because 16:9 is a poor shape
// for a page: hold the phone the "wrong" way and the frame's short side bounds
// the page, which is where the 166 comes from. A 4:3 still is a far better fit,
// and that is the bigger part of the win — the floor rises, not just the peak.
//
// The cost is real and is why this is a MODE, not the default: the iPhone's
// camera UI replaces ours, so there is no green outline and no hands-free
// capture, and it is two more taps per page. Auto stays the right choice for
// working through a stack; HQ is for the page that matters.
// v11.80: HQ is gone. It routed the shutter to the iPhone's own camera app for
// a full-resolution still, which did give more pixels — but it cost the live
// green outline, hands-free capture, and it caused a run of "two cameras"
// bugs (v11.62, v11.65, v11.66) because a native camera and a live preview can
// never both be on screen. Since v11.76 the 4:3 sensor request gets most of
// that resolution back inside the normal preview, so the trade stopped being
// worth it. The constant remains only so nothing reads an undefined value.
try { localStorage.removeItem("scanHiQ"); } catch(e){}   // v11.80: drop a stored preference
// v11.33 output paper size for scanned pages. "auto" keeps the captured shape
// (the pre-v11.33 behaviour) and is deliberately NOT the default: a scan of an
// A4 sheet should come out A4 so it prints with even margins and merges
// cleanly with born-digital pages.
// v11.55: the DEFAULT is back to "As captured". v11.33 made A4 the default so
// scans printed with even margins; on a real stack of receipts, envelopes and
// part-pages that means white bars down both sides of nearly every scan, and
// the page then draws smaller on screen because the viewer fits the PAGE, not
// the image. A4 is still one tap away in the crop filter row for anyone who
// wants it, and the choice persists.
let scanPaper = "auto";
// v11.70: colour is no longer a choice — scans are always stored in colour.
// Greyscale and black & white existed to make text pages small, and MRC does
// that better: it stores the text as a 1-bit 300dpi stencil while KEEPING the
// colour of everything else, so B&W now costs colour for no saving. toGreyscale
// and toBlackAndWhite stay in scan-core (still tested, still used by the
// bilevel compressor) but nothing sets scanColour away from "colour".
const scanColour = "colour";
try { localStorage.removeItem("scanColour"); } catch(e){}   // drop any stored B&W
try { const p=localStorage.getItem("scanPaper"); if (p && PAPER_SIZES[p]) scanPaper=p; } catch(e){}
// v11.70: Letter and Legal are gone from the scanner's cycle. They stay in
// PAPER_SIZES because Resize pages still offers them for documents that need
// them; they were simply never the right answer for a phone scan here.
if (scanPaper !== "a4" && scanPaper !== "auto") scanPaper = "auto";
// v11.34 "Both sides": front and back of one card composited onto a single A4
// page. Declared here with the rest of the scanner state because the toggle is
// wired up (and refreshed) further down the file, well before the compositing
// code that uses it — a `let` beside that code would be in its dead zone.
// v11.70: both sides is now the default. An ID card has two sides worth
// keeping far more often than not, and the old default meant scanning the back
// as a separate page and merging it afterwards.
// v11.82: Both sides is the default and, like Type and Auto, is a DEFAULT
// rather than a remembered preference — the scanner starts the same way every
// session. A card has two sides worth keeping far more often than not.
let idTwoSide = true;
try { localStorage.removeItem("scanIdTwoSide"); } catch(e){}
let idPendingCard = null;     // canvas of side 1, held until side 2 arrives
// v11.82: a thumbnail for that held side. Without it the strip stayed empty
// after capturing the FRONT of a card and only filled in once the back was
// done — so the one capture that most needs confirming showed nothing. (This
// shipped in v11.78 and was lost when that release was reverted wholesale; it
// is UI only and cannot affect image data.)
let idPendingThumb = null;
// v11.67: index a retake will replace, or -1 for "add to the end"
let scanRetakeAt = -1;
// v10.74: std now warps to a larger long side (was 2560) so the higher-res 4K
// capture keeps its detail instead of being shrunk away. File size is held in
// check by encodeUnderBudget() (size-budgeted adaptive JPEG) rather than a
// fixed quality, so sparse document pages stay well under ~1.45 MB while dense
// pages settle to a slightly lower quality automatically. "small" is unchanged.
// v11.75: the starting quality drops 0.92 -> 0.80 and the budget 1.4MB ->
// 700KB. Nothing else about the page changes — same resolution, same
// continuous tone, same processing.
//
// Measured by re-encoding a real v11.74 scan (a 219dpi endoscopy report, one
// page) at its own resolution:
//
//   q92  967 KB   <- what v11.74 shipped, and it never stepped down because
//   q85  749 KB      the page was already inside the old 1.4MB budget
//   q80  590 KB
//   q74  501 KB
//
// The same line of text at q92, q82 and q74 is indistinguishable at 100%, and
// the endoscopy photograph shows no blocking at q78. So the top of that range
// was buying nothing. qFloor stays at 0.70 so a dense page can still ease down
// to meet the budget rather than blowing past it.
// v11.77: maxDim 3200 -> 3500 and the budget 700KB -> 900KB.
//
// v11.76's 4:3 request worked — measured on a real scan, the page came out
// 2272x3200, which is EXACTLY the old cap. The sensor was handing over more
// than was being kept, so the ceiling had moved from the camera to this
// constant. 3500px on the long side is 299 dpi on A4: the figure Acrobat and
// Adobe Scan treat as standard for a document.
//
// The budget rises with it, because it must not undo the resolution it was
// just given. Measured: the same page at 3500px and q0.80 is about 860KB, so
// 900KB leaves the encoder at its starting quality instead of stepping down.
// v11.76's page was 714KB against a 700KB budget and had NOT been stepped down
// (q0.80 re-encodes to 697KB), so the budget was already at its useful edge.
const SCAN_Q = { std:{ jpeg:0.80, maxDim:3500, budget:900000, qFloor:0.70 },
                 small:{ jpeg:0.62, maxDim:1400 } };
// Encode a canvas to JPEG, stepping quality down only if the blob exceeds the
// byte budget (document scans are mostly white and compress well, so a sparse
// page keeps the top quality; a dense page eases down to fit). No budget → a
// single encode at the given quality (preserves "small" mode behaviour).
async function encodeUnderBudget(canvas, q0, budget, qFloor){
  const enc = q => new Promise(res=>canvas.toBlob(res,"image/jpeg",q));
  let blob = await enc(q0);
  if (!budget) return blob;
  let q = q0;
  while (blob && blob.size > budget && q > (qFloor||0.80) + 0.001){
    q = Math.max(qFloor||0.80, q - 0.04);
    blob = await enc(q);
  }
  return blob;
}
// v10.81: encode a scan page to JPEG using MuPDF's real codec, stepping quality
// down to fit the byte budget. WHY: iOS Safari's canvas.toBlob() IGNORES the JPEG
// quality argument, so encodeUnderBudget() above could never actually shrink a
// page on iPhone (every quality produced the same large blob). MuPDF.asJPEG()
// honours quality precisely, so the budget works. This only changes the bytes —
// the pixels (all colour/contrast/ID enhancements) are already baked into the
// canvas before this runs. Falls back to encodeUnderBudget() if MuPDF can't be
// used (e.g. desktop test harness without a real canvas), so nothing breaks.
async function encodeScanJpeg(canvas, q0, budget, qFloor){
  try {
    const w=canvas.width, h=canvas.height;
    const rgba=canvas.getContext("2d").getImageData(0,0,w,h).data;
    const pix=new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0,0,w,h], false);  // RGB, no alpha
    const stride=pix.getStride(), dst=pix.getPixels();
    for (let y=0;y<h;y++){
      let s=y*w*4, d=y*stride;
      for (let x=0;x<w;x++){ dst[d]=rgba[s]; dst[d+1]=rgba[s+1]; dst[d+2]=rgba[s+2]; s+=4; d+=3; }
    }
    const floor=Math.round((qFloor||0.78)*100);
    let q=Math.round((q0||0.92)*100);
    let bytes=u8(pix.asJPEG(q));
    if (budget){
      while (bytes.length>budget && q>floor){ q=Math.max(floor, q-6); bytes=u8(pix.asJPEG(q)); }
    }
    pix.destroy();
    return new Blob([bytes], {type:"image/jpeg"});
  } catch(e){
    return encodeUnderBudget(canvas, q0, budget, qFloor);   // safe fallback
  }
}
let dragIdx = -1;             // corner handle being dragged
let torchOn = false;          // rear-camera torch state

// ---- off-thread processing (scan-worker.js) ----
// Full-res warp + filter run in a Web Worker so the UI never freezes.
// If the worker can't start or fails, we silently fall back to the
// identical synchronous code below.
let scanWorker = null;        // Worker | false (failed) | null (not tried)
let scanJobId = 0;
function getScanWorker(){
  if (scanWorker === null){
    try {
      // module worker: it imports the shared scan-core.js (ES modules in
      // workers are supported on iOS 15+/the app's iOS 16.4+ baseline).
      scanWorker = new Worker("./scan-worker.js", { type:"module" });
      // A worker that fails to load (e.g. scan-worker.js missing from a
      // deploy, served as a 404 HTML page, or module import unsupported) must
      // not leak a global "Script error." banner — absorb it here and use the
      // main-thread fallback instead.
      scanWorker.addEventListener("error", (e)=>{
        if (e && e.preventDefault) e.preventDefault();
        scanWorker = false;
      });
    } catch(e){ scanWorker = false; }
  }
  return scanWorker;
}
function processPageOffThread(srcIm, quad, filter, maxDim, enhance){
  const w = getScanWorker();
  if (!w) return Promise.resolve(null);
  return new Promise((resolve)=>{
    const id = ++scanJobId;
    // watchdog: if the worker never answers (hung, killed, bad deploy), fall
    // back to the main-thread path instead of freezing behind the spinner
    const wd = setTimeout(()=>{ w.removeEventListener("message", onMsg); scanWorker = false; resolve(null); }, 15000);
    const onMsg = (e)=>{
      if (!e.data || e.data.id !== id) return;
      clearTimeout(wd);
      w.removeEventListener("message", onMsg);
      resolve(e.data.ok ? new ImageData(new Uint8ClampedArray(e.data.buf), e.data.w, e.data.h) : null);
    };
    const onErr = (e)=>{ if (e && e.preventDefault) e.preventDefault();
      clearTimeout(wd); w.removeEventListener("message", onMsg); scanWorker = false; resolve(null); };
    w.addEventListener("message", onMsg);
    w.addEventListener("error", onErr, { once:true });
    // transfer the pixels (zero-copy); the canvas still holds its own copy
    w.postMessage({ id, buf:srcIm.data.buffer, w:srcIm.width, h:srcIm.height, quad, filter, maxDim, enhance },
                  [srcIm.data.buffer]);
  });
}

let _scratch = null;          // small reusable canvas for detection downscales
function scratch(w,h){
  if (!_scratch) _scratch = document.createElement("canvas");
  _scratch.width = w; _scratch.height = h;
  return _scratch;
}
function containFit(srcW,srcH,boxW,boxH){
  const scale = Math.min(boxW/srcW, boxH/srcH);
  return { scale, dispW:srcW*scale, dispH:srcH*scale,
           offX:(boxW-srcW*scale)/2, offY:(boxH-srcH*scale)/2 };
}

// ---- session ----
// v11.35: when set, "Create PDF" becomes "Add to document" and the scanned
// pages are grafted onto the end of whatever is open instead of replacing it.
// Holds the target's name for the on-screen wording; the bytes come from
// workingBytes at append time, since the scanner is modal and nothing else can
// change the open document while it is up.
let scanAppendTo = null;

async function startScan(append){
  // scanPages is kept as-is: it is always [] here except when a previous
  // session was restored from IndexedDB, in which case we continue it
  // v11.76: the exposure check runs once per scanning session, not once per app
  // launch — a different room, or a different phone camera state, deserves a
  // fresh look at whether the high-resolution mode is behaving.
  capFrame = null; scanFallback = false; scanRetakeAt = -1; exposureChecked = false; fitLast = "";
  resetScanDefaults();        // v11.81: Document, Auto off, every time
  scanAppendTo = (append && workingBytes) ? { name: fileName } : null;
  idPendingCard = null; idPendingThumb = null;
  disarmAuto(); autoBusy = false; autoNeedsRelease = false;
  refreshAutoBtn(); refreshPaperBtn(); refreshIdTwoSideBtn();
  updateScanCount();
  $("scanCrop").classList.remove("show");
  $("scanCam").classList.add("show");
  diagRecord("scanner-open");   // v11.90: record across the whole open sequence
  await afterLayout();     // v11.88: lay the panel out before the camera arrives
  // v10.95: one-time expectation-setting on installed iOS web apps — WebKit
  // does not persist getUserMedia grants for standalone PWAs (bugs 215884 /
  // 185448), so the OS re-asks on every app launch. Say so once, so the
  // recurring prompt reads as an Apple limitation rather than an app fault.
  let camHint = false;
  try {
    const standalone = window.navigator.standalone === true ||
      (typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches);
    if (standalone && !localStorage.getItem("pypdf-cam-hint")){
      localStorage.setItem("pypdf-cam-hint","1");
      camHint = true;
      setStatus("Note: iOS asks for camera access on each app launch — an Apple limit of installed web apps, not a fault.","warn");
    }
  } catch(e){}
  if (!camHint) setStatus(
    scanAppendTo ? "Scanning into “"+scanAppendTo.name+"” — the pages will be added to the end."
    : scanAuto   ? "Hold the camera over a page — it is taken automatically once framed and steady."
                 : "Point the camera at a document and tap the shutter.", "ok");
  // v11.62: in HQ do NOT open the live preview at all. v11.61 started it and
  // then handed over to the iPhone's camera when the shutter was tapped, so
  // the user met two camera screens for one photo — "confusing", and rightly
  // so. There is only ever one camera in HQ, and it opens straight away: the
  // page is one tap from the Scan button, not two.
  await startCamera();
}
function endScan(){
  stopCamera();
  scanPages = []; capFrame = null; scanRetakeAt = -1;
  scanAppendTo = null;           // v11.35: forget any append target
  idPendingCard = null; idPendingThumb = null;   // v11.34: drop a half-finished card pair
  disarmAuto(); autoBusy = false; autoNeedsRelease = false;
  updateScanCount();
  $("scanCam").classList.remove("show");
  $("scanCrop").classList.remove("show");
}
function updateScanCount(){
  // v11.34: while one side of a card is held, say so — otherwise the page
  // count not moving after a capture looks like the capture failed.
  $("scanCount").textContent = idPendingCard
    ? "Front held — scan the back"
    : (scanPages.length ? scanPages.length+" page(s) scanned" : "");
  const d = $("scanDone");
  d.disabled = !scanPages.length;
  // v11.35: the button says what it will actually do — make a new PDF, or add
  // these pages to the document already open.
  const verb = scanAppendTo ? "Add to document" : "Create PDF";
  d.textContent = scanPages.length ? verb+" ("+scanPages.length+")" : verb;
  renderScanThumbs();
  persistScan();                 // scan session survives the app being killed
}
// thumbnail strip above the shutter: tap a page to review or delete it
function renderScanThumbs(){
  const strip=$("scanThumbs");
  // v11.82: a held card side counts as something to show, even with no
  // finished pages yet.
  strip.classList.toggle("has", scanPages.length>0 || !!idPendingThumb);
  strip.innerHTML = scanPages.map((p,i)=>
    h`<button class="sthumb" data-pg="${i}" aria-label="Review scanned page ${i+1}"><img src="${p.thumb}" alt="Page ${i+1}"><span class="num">${i+1}</span></button>`).join("")
    // Marked as waiting rather than numbered: it is not a page yet, and tapping
    // it discards the side rather than opening a review sheet for a page that
    // does not exist.
    + (idPendingThumb
        ? h`<button class="sthumb pending" id="idPendingThumb" aria-label="Front of the card, waiting for the back — tap to discard it"><img src="${idPendingThumb}" alt="Front of the card"><span class="num">front</span></button>`
        : "");
  strip.querySelectorAll("[data-pg]").forEach(b=>{
    const i = +b.dataset.pg;
    b.onclick = ()=> openScanPageSheet(i);
    // v11.33: show the page's rotation on its thumbnail. Set through the CSSOM,
    // not a style attribute — the CSP is style-src 'self' with no unsafe-inline.
    const r = normaliseRot(scanPages[i] && scanPages[i].rot);
    const im = b.querySelector("img");
    if (im && r) im.style.transform = "rotate("+r+"deg)";
  });
  const pend = $("idPendingThumb");
  if (pend) pend.onclick = ()=> clearIdPending(false);
  strip.scrollLeft = strip.scrollWidth;          // keep the newest page in view
}
function openScanPageSheet(i){
  const p=scanPages[i]; if(!p) return;
  const url=URL.createObjectURL(new Blob([p.bytes],{type:"image/jpeg"}));
  const rot = normaliseRot(p.rot);
  $("sheet").innerHTML = h`
    <h3>Scanned page ${i+1} of ${scanPages.length}</h3>
    <div class="row"><img class="pgprev" id="pgPrev" alt="Page ${i+1}"></div>
    <div class="row"><button class="full" id="pgRot">⟳ Rotate${rot?" (now "+rot+"°)":""}</button></div>
    <!-- v11.67: fix one bad page without starting the stack again. Retake puts
         the new photo back in THIS position, and the arrows move a page that
         went in out of order — both previously meant deleting and rescanning. -->
    <div class="row"><button class="full" id="pgRetake">Retake this page</button></div>
    ${raw(scanPages.length > 1 ? `<div class="row teseg" id="pgMove">
      <button class="segb" data-mv="-1" ${i===0?"disabled":""}>← Move earlier</button>
      <button class="segb" data-mv="1" ${i===scanPages.length-1?"disabled":""}>Move later →</button>
    </div>` : "")}
    <div class="row"><button class="full" id="pgDel">Delete this page</button></div>
    <div class="row"><button class="ghost full" id="pgClose">Close</button></div>`;
  // v11.33: the preview is turned with CSS so the stored JPEG is never
  // re-encoded; the same angle is written into the PDF with /Rotate on save.
  const img = $("pgPrev");
  img.src=url;
  if (rot) img.style.transform = "rotate("+rot+"deg)";
  const done=()=>{ URL.revokeObjectURL(url); closeSheet(); };
  // v11.33: rotation moved here from the Adjust screen alone. With auto capture
  // the Adjust screen (and its Rotate button) is skipped entirely, so without
  // this a sideways page could only be fixed after the PDF was built.
  $("pgRot").onclick=()=>{
    p.rot = normaliseRot(rot + 90);
    done();
    renderScanThumbs(); persistScan();
    openScanPageSheet(i);                    // reopen so the change is visible
  };
  $("pgDel").onclick=()=>{
    done();
    scanPages.splice(i,1);
    updateScanCount();
    setStatus(scanPages.length ? "Page removed — "+scanPages.length+" page(s) left."
                               : "Page removed — no pages scanned yet.","ok");
  };
  // v11.67: reorder. Buttons rather than a drag: a thumbnail strip on a phone
  // is a poor drag target, and one tap per position is unambiguous.
  if ($("pgMove")) $("pgMove").querySelectorAll("[data-mv]").forEach(b=>{
    b.onclick = ()=>{
      const dir = +b.dataset.mv, j = i + dir;
      if (j < 0 || j >= scanPages.length) return;
      const [m] = scanPages.splice(i,1);
      scanPages.splice(j,0,m);
      done();
      renderScanThumbs(); persistScan(); updateScanCount();
      setStatus("Page moved to position "+(j+1)+" of "+scanPages.length+".","ok");
      openScanPageSheet(j);                 // follow the page the user moved
    };
  });
  // v11.67: retake. The replacement goes back into THIS slot rather than onto
  // the end, which is the whole point — otherwise it is delete-and-rescan with
  // extra steps.
  $("pgRetake").onclick=()=>{
    done();
    scanRetakeAt = i;
    $("scanCrop").classList.remove("show");
    $("scanCam").classList.add("show");
    setStatus("Retaking page "+(i+1)+" — the new photo replaces it in place.","ok");
    if (scanFallback){ refreshScanIdle(); $("camInput").click(); }
    else { refreshScanIdle(); resumeCamera(); }
  };
  $("pgClose").onclick=done;
  openSheet();
  sheetOnDismiss = ()=>{ try{ URL.revokeObjectURL(url); }catch(e){} };  // backdrop/Esc: don't leak the blob URL
}

// ---- camera ----
// v11.69: what actually happened when the camera opened. Filled in by
// startCamera/awaitFirstFrame and read back by the hidden diagnostic (long-press
// the page counter). This exists because the "opens small, then normal" report
// cannot be reproduced anywhere except on the phone: rather than guess a second
// time, the numbers come off the device.
let camDiag = null;
const CAM_FIRST_FRAME_MS = 1200;   // never hide the preview longer than this
// v11.71: size the preview OURSELVES instead of trusting `width:100%;
// height:100%` plus object-fit inside a flex column.
//
// Reported symptom: the viewfinder is a small window floating in a large black
// area — permanently, not as a transient. The stream is 9:16 (iOS hands back
// the 4K capture rotated to portrait) and the viewfinder box is about 0.61, so
// contain should letterbox it slightly at the sides and fill the height. It
// does not, which means the percentage height is resolving against something
// smaller than the box we can see. I could not determine what from a
// screenshot, so this stops depending on it: measure the box, compute the
// contain fit, and set explicit pixel geometry. Whatever the percentages were
// doing, the result is now the same on every device.
//
// Styles are set through the CSSOM (el.style.x), never a style attribute, so
// the strict style-src 'self' CSP still holds.
let fitLast = "";
function fitPreviewBox(){
  const view = $("scanView"), v = $("scanVideo");
  if (!view || !v) return null;
  const bw = view.clientWidth|0, bh = view.clientHeight|0;
  const vw = v.videoWidth|0, vh = v.videoHeight|0;
  if (bw <= 0 || bh <= 0 || vw <= 0 || vh <= 0) return null;
  // v11.85: cheap enough to call every tick of the live-detect loop, which is
  // what makes the fit SELF-HEALING rather than event-driven. v11.84 hung it
  // off a ResizeObserver, which still assumes the box change is observed —
  // this converges within one tick no matter what moved, or when.
  const key = bw+"x"+bh+"/"+vw+"x"+vh;
  if (key === fitLast) return null;
  fitLast = key;
  // Deliberately the SAME function the green outline is positioned with. The
  // outline is drawn at containFit(video, canvas) on a canvas that matches the
  // viewfinder box, so if the video is drawn to any other fit the outline lands
  // somewhere other than the image — which would look exactly like "the green
  // box never appears".
  const f = containFit(vw, vh, bw, bh);
  const w = Math.round(f.dispW), h = Math.round(f.dispH);
  v.style.left   = Math.round(f.offX) + "px";
  v.style.top    = Math.round(f.offY) + "px";
  v.style.width  = w + "px";
  v.style.height = h + "px";
  v.style.right = "auto"; v.style.bottom = "auto";
  sizeQuadCanvas();
  return { bw, bh, vw, vh, w, h };
}
// v11.84: the fit has to follow the BOX, not just the stream.
//
// Reported: the preview opens small — drawn at about 75% of the width it should
// be, with "Starting camera…" showing through the letterbox — and then snaps to
// normal. fitPreviewBox() was setting explicit pixel geometry once, at the first
// frame, so anything that resized the container afterwards left the video at the
// old size. There are at least three such things: the Type row and the thumbnail
// strip appearing, and iOS settling the standalone viewport a beat after launch
// (which v11.83 established really does happen here).
//
// A ResizeObserver watches the viewfinder itself, so it does not matter WHICH of
// those moved it — any change re-fits. The window listeners stay as a fallback
// for engines without ResizeObserver.
function refitPreview(){ fitPreviewBox(); sizeQuadCanvas(); }
window.addEventListener("resize", refitPreview);
window.addEventListener("orientationchange", ()=> setTimeout(refitPreview, 250));
(function watchPreviewBox(){
  if (typeof ResizeObserver !== "function") return;
  const view = $("scanView");
  if (!view) return;
  // rAF-coalesced: a resize can fire many times during a layout settle, and
  // each fit writes styles that could otherwise feed the next observation.
  let queued = false;
  const ro = new ResizeObserver(()=>{
    if (queued) return;
    queued = true;
    nextFrame(()=>{ queued = false; refitPreview(); });
  });
  ro.observe(view);
})();
// v11.87: a frame tick that cannot be missing. The reveal below depends on it,
// and a preview that is never revealed is a permanently black scanner — so it
// must not rest on an optional API. Caught by the headless harness, which has
// no requestAnimationFrame.
const nextFrame = (fn)=> (typeof requestAnimationFrame === "function")
  ? requestAnimationFrame(fn) : setTimeout(fn, 16);
// v11.88: wait for the scanner panel to be LAID OUT before anything measures it.
//
// This is the difference the user found: opening the scanner for the first time
// works, cancelling and reopening does not. On the first open getUserMedia
// blocks for seconds on the iOS permission prompt, so by the time any code
// measures the viewfinder the panel has long since laid out. On a reopen the
// grant is already held and the camera returns in milliseconds — measuring a
// panel that was made visible microseconds earlier.
//
// The permission prompt was accidentally providing the settle. This provides it
// deliberately: two frames after `.show`, which is a style recalc and a layout
// pass. About 32ms, once per scanner open.
function afterLayout(){
  return new Promise(res=> nextFrame(()=> nextFrame(res)));
}
// reveal only once the fit has stopped changing — see the note in
// awaitFirstFrame. Used by BOTH reveal paths: the first frame, and returning
// from the Adjust screen (where the thumbnail strip has just changed the box,
// which is precisely a moment the fit moves).
function revealPreviewWhenSettled(v){
  let lastKey = "", same = 0;
  const started = Date.now();
  const settle = ()=>{
    fitPreviewBox();
    if (fitLast && fitLast === lastKey) same++;
    else { same = 0; lastKey = fitLast; }
    const stable  = fitLast && same >= 3;          // ~50ms unchanged
    const timedUp = Date.now() - started > CAM_FIRST_FRAME_MS;
    if (!stable && !timedUp){ nextFrame(settle); return; }
    if (camDiag){
      camDiag.settleMs = Date.now() - started;
      camDiag.settledBy = stable ? "stable" : "timeout";
    }
    v.classList.add("ready");
    // The label sits UNDER the preview, so while the video was drawn too small
    // it showed through the letterbox beside it. Hide it explicitly.
    const boot = $("camBoot"); if (boot) boot.hidden = true;
    sizeQuadCanvas();
    diagSample("revealed:" + (stable ? "stable" : "timeout"));
  };
  nextFrame(settle);
}
function awaitFirstFrame(v){
  let done = false;
  const show = (why)=>{
    if (done) return;
    done = true;
    if (camDiag){
      camDiag.first = Date.now() - camDiag.t0;
      camDiag.why = why;
      camDiag.sizes.push(v.videoWidth + "x" + v.videoHeight + " @" + camDiag.first + "ms");
    }
    // v11.87: do not reveal on the FIRST fit — wait until the fit stops
    // changing.
    //
    // Reported four times: the preview opens small and grows to full size a
    // fraction of a second later. Every previous attempt tried to make the
    // first measurement correct — re-fit on resize (v11.84), re-fit on every
    // live tick (v11.85). Those do correct it, which is exactly why it "becomes
    // normal": the correction is real, it just happens after the preview is
    // already on screen.
    //
    // I still cannot explain from a screenshot WHY the first measurement is
    // wrong; the small size is not a containFit result against the full box, so
    // my model of it is incomplete. So this stops trying to be right first time
    // and instead refuses to show anything until the answer has settled: the
    // same fit three animation frames running (~50ms), or the existing hard
    // timeout, whichever comes first. The user sees black, then the correct
    // size — never the wrong one.
    revealPreviewWhenSettled(v);
  };
  // Track later resolution changes so the diagnostic can show whether iOS really
  // is switching capture mode after the first frame.
  const onResize = ()=>{
    if (camDiag) camDiag.sizes.push(v.videoWidth + "x" + v.videoHeight + " @" + (Date.now()-camDiag.t0) + "ms");
    const f = fitPreviewBox();
    if (camDiag && f) camDiag.fit = f;
    sizeQuadCanvas();
  };
  v.addEventListener("resize", onResize);
  if (typeof v.requestVideoFrameCallback === "function"){
    try { v.requestVideoFrameCallback(()=> show("frame")); }
    catch(e){ /* fall through to the listeners below */ }
  }
  v.addEventListener("loadeddata", ()=> show("loadeddata"), { once:true });
  // Belt and braces: a preview that never fires either event must still appear,
  // otherwise a device quirk turns into a permanently black scanner.
  setTimeout(()=> show("timeout"), CAM_FIRST_FRAME_MS);
}
// v11.76: the check that v11.41 did not have.
//
// The high-resolution 4:3 mode is worth ~40% more detail on a portrait page,
// but on some iPhones it selects a capture mode whose auto-exposure burns out
// white paper. That is not a thing to reason about — it is a thing to measure.
// A few frames in, once auto-exposure has settled, the preview is sampled and
// the blown-highlight fraction read with the same frameStats()/AUTO.MAX_BLOWN
// the auto-capture gate already uses. Too blown, and the stream is put back to
// the 16:9 mode that was known to expose correctly, and the user is told.
//
// Deliberately conservative: only a clearly over-exposed frame triggers the
// fallback, it is tried once per session, and any failure leaves the working
// stream alone. Resolution is worth nothing on paper that is burnt white.
const EXPOSURE_SETTLE_MS = 900;   // let auto-exposure finish before judging it
let exposureChecked = false;
async function verifyExposure(v, safeConstraint){
  if (exposureChecked) return;
  exposureChecked = true;
  await new Promise(r=> setTimeout(r, EXPOSURE_SETTLE_MS));
  let blown = 0;
  try {
    if (!v.videoWidth || !scanStream) return;
    const W = 240, H = Math.max(1, Math.round(W * v.videoHeight / v.videoWidth));
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const ctx = c.getContext("2d", { willReadFrequently:true });
    ctx.drawImage(v, 0, 0, W, H);
    const st = frameStats(ctx.getImageData(0, 0, W, H));
    blown = st ? st.blown : 0;
    if (camDiag) camDiag.blown = blown;
    if (blown <= AUTO.MAX_BLOWN) return;              // the mode is behaving
  } catch(e){ return; }                               // never break a working preview
  // Over-exposed: go back to the mode that was known good.
  try {
    const track = scanStream.getVideoTracks()[0];
    if (!track || !track.applyConstraints) return;
    await track.applyConstraints(safeConstraint);
    if (camDiag) camDiag.exposureFallback = true;
    fitPreviewBox(); sizeQuadCanvas();
    setStatus("The camera's high-resolution mode was over-exposing the page, so it has "
            + "been switched back. Scans stay correctly exposed at slightly lower detail; "
            + "use HQ for maximum resolution.", "warn");
  } catch(e){ /* the high-res stream still works — leave it running */ }
}
async function startCamera(){
  stopCamera();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){ enterFallback(); return; }
  // v10.74: request the full sensor resolution the device can give — capture
  // resolution is the single biggest driver of scan sharpness (the warp +
  // filters were never the bottleneck).
  // v11.55: REVERTED to the v11.40 request order. v11.41 asked for the 4:3
  // sensor mode (4032×3024) first on the reasoning that a portrait page is
  // bounded by the frame's short side, so 3024 beats 2160. The arithmetic was
  // right and the result was wrong: on a real iPhone that constraint selects a
  // different capture mode, whose auto-exposure blew out bright paper — scans
  // came back burnt white. Resolution on paper is worth nothing if the paper
  // is over-exposed, so the 16:9 4K request that was working is back.
  // Anything further here must be tested on a phone before it ships.
  // `continuous` focus keeps handheld captures crisp.
  // v11.69: ONE request, not a ladder. Every constraint here is `ideal`, and an
  // ideal constraint degrades rather than rejects — so the first call already
  // succeeds on essentially every device and the two fallbacks below it were
  // dead weight paid for at startup. They are kept only for the case where the
  // first call genuinely throws (a device with no environment-facing camera).
  // v11.76: ask for the 4:3 sensor mode FIRST — but verify it, and back out if
  // it misbehaves.
  //
  // A portrait page in a 16:9 stream is bounded by the 2160 short side, which
  // caps a scan at about 222dpi. Measured on the same document, the native
  // still-photo path reaches 308dpi and the preview path 222dpi, so the video
  // mode is the whole ceiling. The 4:3 mode is 3024 on the short side: roughly
  // +40% linear, about 310dpi, with the live outline and auto capture intact.
  //
  // v11.41 asked for exactly this and shipped it, and on a real iPhone the
  // capture mode it selects over-exposed white paper — scans came back burnt.
  // v11.55 reverted it and pinned the revert. What was missing then was not the
  // idea but the CHECK: nothing measured the result before trusting it.
  // v11.63 added frameStats(), which reports the blown-highlight fraction, and
  // AUTO.MAX_BLOWN already defines "too blown". So the request is now made and
  // then verified against the picture it actually produces — see verifyExposure().
  const camTries = [
    { facingMode:{ideal:"environment"}, width:{ideal:4032}, height:{ideal:3024}, focusMode:"continuous" },
    { facingMode:{ideal:"environment"}, width:{ideal:3840}, height:{ideal:2160}, focusMode:"continuous" },
    { facingMode:{ideal:"environment"} }
  ];
  // the 16:9 request, kept by name so the fallback cannot drift from the mode
  // that was known to expose correctly
  const CAM_SAFE = camTries[1];
  scanStream = null;
  camDiag = { t0: Date.now(), gum: 0, first: 0, sizes: [] };
  for (const v of camTries){
    try { scanStream = await navigator.mediaDevices.getUserMedia({ audio:false, video:v }); break; }
    catch(e){ /* try the next, less-demanding constraint set */ }
  }
  if (!scanStream){ enterFallback(); return; }
  camDiag.gum = Date.now() - camDiag.t0;
  const v = $("scanVideo");
  // Hold the preview back until there is a real frame to show. iOS starts the
  // camera in a lower-resolution mode and switches up to the requested one, and
  // because the preview is object-fit:contain, every videoWidth/videoHeight
  // change resizes the letterboxed image — which is the "opens small, then
  // becomes normal" the scanner has always done. Nothing here makes the camera
  // start faster; it stops the half-started states being visible.
  v.classList.remove("ready");
  v.srcObject = scanStream;
  try { await v.play(); } catch(e){ /* autoplay is allowed: muted+playsinline */ }
  awaitFirstFrame(v);
  sizeQuadCanvas();
  refreshScanIdle();
  verifyExposure(v, CAM_SAFE);
  // torch: only offer the button when the camera actually supports it
  torchOn = false;
  try {
    const track = scanStream.getVideoTracks()[0];
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    $("torchBtn").hidden = !caps.torch;
    $("torchBtn").classList.remove("on");
  } catch(e){ $("torchBtn").hidden = true; }
  startLiveDetect();
}
// v11.69 diagnostic: press and hold the page counter in the scanner to read back
// what the camera actually did on THIS device — how long getUserMedia took, when
// the first frame arrived, and every resolution the stream reported after that.
// If the preview really is switching capture mode mid-open, the sizes list shows
// it; if it is not, the cause is something else and this says so rather than
// letting me guess a second time.
function camDiagText(){
  if (!camDiag) return "Camera has not been started yet.";
  const s = camDiag.sizes.length ? camDiag.sizes.join(" -> ") : "(no size reported)";
  const f = camDiag.fit
    ? " · box " + camDiag.fit.bw + "x" + camDiag.fit.bh
      + " · video " + camDiag.fit.vw + "x" + camDiag.fit.vh
      + " · drawn " + camDiag.fit.w + "x" + camDiag.fit.h
    : " · fit not computed";
  const e = camDiag.blown === undefined ? " · exposure not checked yet"
          : " · blown " + (100*camDiag.blown).toFixed(1) + "%"
            + (camDiag.exposureFallback ? " -> FELL BACK to 16:9" : " (high-res mode kept)");
  const st = camDiag.settleMs === undefined ? ""
           : " · settled " + camDiag.settleMs + "ms (" + camDiag.settledBy + ")";
  return "gUM " + camDiag.gum + "ms · frame " + (camDiag.first || "-") + "ms"
       + " (" + (camDiag.why || "-") + ")" + st + " · " + s + f + e;
}
(function bindCamDiag(){
  // v11.71: this was bound to the page counter, which is EMPTY until a page has
  // been captured — so on the screen where you actually need it there was
  // nothing to press. The title is always there.
  const el = $("scanTitle") || $("scanCount");
  if (!el) return;
  let timer = 0;
  const start = ()=>{ clearTimeout(timer); timer = setTimeout(()=> setStatus(camDiagText(), "ok"), 600); };
  const stop  = ()=>{ clearTimeout(timer); timer = 0; };
  el.addEventListener("touchstart", start, { passive:true });
  el.addEventListener("touchend", stop);
  el.addEventListener("touchcancel", stop);
  el.addEventListener("mousedown", start);
  el.addEventListener("mouseup", stop);
  el.addEventListener("mouseleave", stop);
})();
async function toggleTorch(){
  if (!scanStream) return;
  try {
    const track = scanStream.getVideoTracks()[0];
    torchOn = !torchOn;
    await track.applyConstraints({ advanced:[{ torch:torchOn }] });
    $("torchBtn").classList.toggle("on", torchOn);
  } catch(e){ torchOn=false; $("torchBtn").classList.remove("on");
              setStatus("Torch not available.","warn"); }
}
$("torchBtn").onclick = toggleTorch;
function stopCamera(){
  if (scanLive){ clearInterval(scanLive); scanLive = 0; }
  if (scanStream){ for (const t of scanStream.getTracks()){ try{ t.stop(); }catch(e){} } scanStream = null; }
  const v = $("scanVideo"); v.srcObject = null; v.classList.remove("ready"); fitLast = "";
  const boot = $("camBoot"); if (boot) boot.hidden = false;
  const q = $("scanQuad");
  if (q.width) q.getContext("2d").clearRect(0,0,q.width,q.height);
  refreshScanIdle();
}
// Pause WITHOUT releasing the camera: stop the live edge-detect loop but keep
// the MediaStream (and its permission grant) alive. iOS shows the camera
// permission prompt on every fresh getUserMedia call, so by reusing one stream
// across capture → crop → next page we prompt once per scan session instead of
// once per page. The stream is only fully released by stopCamera() when the
// scanner is closed (Create PDF / Cancel-discard / leaving the scanner).
// NB: the cross-launch prompt (each cold start of the installed PWA) is an iOS
// platform limitation — standalone PWAs cannot persist camera permission, and
// there is no web API to request a one-time/permanent grant.
function pauseCamera(){
  if (scanLive){ clearInterval(scanLive); scanLive = 0; }
}
async function resumeCamera(){
  // v11.88: same settle as startScan, and this path needs it MORE — the stream
  // is already live, so there is nothing at all to wait for and the fit would
  // otherwise run against a panel shown microseconds ago. Every route back to
  // the viewfinder (Retake, Use page, Delete, retake-a-page) comes through
  // here, so one wait covers them all.
  await afterLayout();
  const track = (scanStream && scanStream.getVideoTracks) ? scanStream.getVideoTracks()[0] : null;
  if (track && track.readyState === "live"){
    const v = $("scanVideo");
    if (v.srcObject !== scanStream) v.srcObject = scanStream;
    try { await v.play(); } catch(e){}
    // the stream is already running at its settled resolution, so there is no
    // half-started state to hide — show it immediately rather than fading in
    // again between every page
    // v11.87: settle before revealing here too. Returning from the Adjust
    // screen changes the box — the thumbnail strip is there now — which is
    // exactly when a stale fit would be shown.
    revealPreviewWhenSettled(v);
    startLiveDetect();
    return;
  }
  await startCamera();   // stream was released (or never started) — request once
}
function enterFallback(){
  scanFallback = true;
  // v11.32: there is no live preview to detect on in the fallback path, so
  // auto capture has nothing to work from. Hide the toggle rather than leave a
  // control on screen that silently does nothing.
  disarmAuto(); refreshAutoBtn();
  setStatus("Live camera unavailable — using the native camera instead.","warn");
  $("camInput").click();
}
// Match the overlay canvas to the live-preview box. Returns false when there is
// no box to match — which is the whole point of the guard:
//
// A hidden element reports clientWidth/clientHeight 0, and the camera screen IS
// hidden for the entire time the Adjust screen is up. The old version wrote
// those zeros straight into the canvas, and a 0×0 canvas draws nothing at all —
// silently, because the preview loop swallows every error. That is how the
// green outline could disappear for the rest of a scan session: one layout
// event at the wrong moment and the overlay was dead until something happened
// to re-size it. Refusing to write a zero size means a mistimed call is now a
// no-op instead of a kill.
//
// Only writing on an actual change matters too: assigning canvas.width resets
// the bitmap AND the whole 2D context state, so re-asserting the same size
// every frame would throw away the outline mid-draw.
function sizeQuadCanvas(){
  const view = $("scanView"), q = $("scanQuad");
  if (!view || !q) return false;
  const w = view.clientWidth|0, h = view.clientHeight|0;
  if (w <= 0 || h <= 0) return false;          // hidden or not laid out yet
  if (q.width !== w || q.height !== h){ q.width = w; q.height = h; }
  return true;
}

// live preview: detect the document every 300ms and outline it in green.
// The raw detection jitters frame to frame, so the shown quad is smoothed:
// it appears only after 2 consistent detections, eases toward each new
// detection (lerp), and survives up to 2 missed frames before vanishing.
let liveQuad=null, livePend=null, liveHits=0, liveMiss=0;
function resetLiveQuad(){
  liveQuad=null; livePend=null; liveHits=0; liveMiss=0; liveStable=0;
  resetFrameStats();
  liveMotionPx=Infinity;
  // losing the document IS the "release" auto capture waits for after taking a
  // page, so clear the latch here as well as on a jump (see autoNeedsRelease).
  autoNeedsRelease=false;
  disarmAuto();
}
// v11.32: per-frame corner drift of the SMOOTHED quad. liveStable is not a
// substitute — it counts frames the detection stayed within quadClose's 18%
// tolerance, which a slow steady hand drift never breaks. See autoCaptureReady.
let liveMotionPx = Infinity;
// v10.94: consecutive stable frames — >=3 (~0.9s) means the box has "locked"
// onto the document: drawn bolder with corner ticks, and detection relaxes to
// every other tick (600ms) to save battery while nothing is changing.
let liveStable = 0;
const quadLocked = ()=> liveStable >= 3;
function smoothQuad(q){
  const before = liveQuad;                  // v11.32: measure how far it moved
  const out = smoothQuadCore(q);
  // A brand-new or re-snapped quad has no meaningful "previous", so drift is
  // Infinity — which reads as "moving" and cannot arm an auto capture. That is
  // the safe direction: the very first frame of a new document is exactly when
  // the detection is least trustworthy.
  liveMotionPx = (before && out) ? quadMaxCornerShift(before, out) : Infinity;
  return out;
}
function smoothQuadCore(q){
  if (!q){
    if (++liveMiss>2) resetLiveQuad();
    return liveQuad;
  }
  liveMiss=0;
  if (!liveQuad){
    liveHits = (livePend && quadClose(livePend,q)) ? liveHits+1 : 1;
    livePend = q;
    if (liveHits>=2) liveQuad=q.map(p=>({x:p.x,y:p.y}));
    return liveQuad;
  }
  if (!quadClose(liveQuad,q)){              // detection jumped to something else: snap
    liveQuad=q.map(p=>({x:p.x,y:p.y}));
    liveStable=0;                           // lock is lost on a jump
    // v11.32: a jump is the other way the user "releases" after an auto
    // capture — sliding the next sheet under the camera without lifting the
    // phone lands here rather than in resetLiveQuad. Both must clear the latch
    // or the second page of a stack would never be taken automatically.
    autoNeedsRelease=false;
    disarmAuto();
    return liveQuad;
  }
  liveStable++;                             // same document, holding steady
  const a=0.35;                             // ease toward the new detection
  liveQuad=liveQuad.map((p,i)=>({x:p.x+(q[i].x-p.x)*a, y:p.y+(q[i].y-p.y)*a}));
  return liveQuad;
}

// ---- v11.32: auto capture ------------------------------------------------
// With Auto on, the shutter fires itself once the document has been locked
// (liveStable) AND passes the stricter autoCaptureReady gate AND has been held
// still for AUTO_HOLD_MS. The page is then processed straight from the
// auto-detected quad and the camera stays live — the Adjust screen is skipped
// entirely. Tapping the shutter by hand still goes through Adjust, so a
// deliberate shot can always be reviewed. That split is the whole design: Auto
// is for working through a stack, the shutter is for the one awkward page.
const AUTO_HOLD_MS = 900;
// v11.63: how long the countdown will keep waiting for a sharp frame before
// taking the shot regardless. Long enough for a hand to settle, short enough
// that it never feels stuck.
const AUTO_SHARP_WAIT_MS = 700;      // steady-hold before firing (on top of the ~0.9s lock)
let autoArmedAt = 0;           // Date.now() when the hold started; 0 = not armed
let autoProgress = -1;         // 0..1 ring progress; -1 = draw no ring
let autoNeedsRelease = false;  // set after a capture: the document must be lost
                               // or replaced before the next one can arm
let autoBusy = false;          // a capture is being processed right now
let autoRaf = 0;               // rAF id for the countdown ring
// Why the last frame was refused, and for how many frames running. A refusal is
// invisible by design — the ring simply does not appear — and "nothing happens
// and I don't know why" is the worst failure mode an automatic feature has. So
// a reason that persists gets said once, in plain language.
let autoWhy = "", autoWhyRun = 0, autoHintAt = 0;
const AUTO_HINTS = {
  "off-frame":   "Move back a little — part of the page is outside the frame.",
  "too-small":   "Move closer, or fit more of the page in the frame.",
  "whole-frame": "Point at a page on a contrasting surface — no edges found.",
  "angled":      "Hold the phone flatter over the page.",
  "not-convex":  "The detected shape isn't a page — try moving the phone.",
  "moving":      "Hold still for a moment.",
  "too-far":     "Move closer — fill the screen with the page for a sharper scan.",
  // v11.63
  "glare":       "There's a bright reflection on the page — tilt the phone or move away from the light. Glare erases the words underneath.",
  "dark":        "Too dark to read — more light, or switch the torch on.",
  "blurry":      "Waiting for a steady moment — rest your elbows, or brace the phone.",
};
function autoHint(why){
  // Only after the same reason has held for ~1.8s, and at most once every 6s,
  // so this cannot become a flickering commentary on every camera wobble.
  if (!why || why === autoWhy){ autoWhyRun++; } else { autoWhy = why; autoWhyRun = 1; }
  if (!why || autoWhyRun < 6) return;
  const now = Date.now();
  if (now - autoHintAt < 6000) return;
  autoHintAt = now; autoWhyRun = 0;
  const msg = AUTO_HINTS[why];
  if (msg) setStatus(msg + " Or tap the shutter to take it yourself.", "warn");
}

function disarmAuto(){
  autoArmedAt = 0; autoProgress = -1;
  if (autoRaf){ try{ cancelAnimationFrame(autoRaf); }catch(e){} autoRaf = 0; }
}
// The detect loop only ticks every 300ms, which would make the ring move in
// three visible jumps. While armed — and only while armed, so there is no
// standing battery cost — redraw it on animation frames instead.
function startAutoRing(){
  if (autoRaf) return;
  const step = ()=>{
    if (!autoArmedAt){ autoRaf = 0; return; }
    autoProgress = Math.min(1, (Date.now()-autoArmedAt)/AUTO_HOLD_MS);
    try { drawLiveQuad(liveQuad); } catch(e){}
    autoRaf = requestAnimationFrame(step);
  };
  autoRaf = requestAnimationFrame(step);
}
// Decide, once per detect tick, whether the countdown may run. Every failure
// path disarms, so the ring resets the instant the user moves — which is the
// feedback that makes auto capture feel trustworthy rather than random.
function evalAutoCapture(v){
  if (!scanAuto || scanFallback || autoBusy || capFrame || !liveQuad || !quadLocked()){
    disarmAuto(); return;
  }
  // "held" is not a fault — it means the page just taken is still under the
  // camera — so it never produces a hint.
  if (autoNeedsRelease){ disarmAuto(); autoWhy = "held"; autoWhyRun = 0; return; }
  const diag = Math.hypot(v.videoWidth, v.videoHeight) || 1;
  const r = autoCaptureReady(liveQuad, v.videoWidth, v.videoHeight, liveMotionPx/diag);
  if (!r.ok){ disarmAuto(); autoHint(r.why); return; }
  // v11.63: geometry is right — but glare wipes out the letters underneath and
  // no processing brings them back, and a dark frame is not worth committing
  // to either. Both refuse rather than take the shot.
  if (liveBlown > AUTO.MAX_BLOWN){ disarmAuto(); autoHint("glare"); return; }
  if (liveMean < AUTO.MIN_MEAN){ disarmAuto(); autoHint("dark"); return; }
  autoWhy = ""; autoWhyRun = 0;
  if (!autoArmedAt){ autoArmedAt = Date.now(); startAutoRing(); }
  autoProgress = Math.min(1, (Date.now()-autoArmedAt)/AUTO_HOLD_MS);
  if (autoProgress >= 1){
    // v11.63: the countdown has finished, but take the shot on a SHARP frame
    // rather than on this particular millisecond. A hand at rest still drifts,
    // and the difference between the sharpest and blurriest frame of a steady
    // hold is plainly visible in the result. Wait up to AUTO_SHARP_WAIT_MS for
    // a frame as good as this scene has recently managed; past that, take what
    // there is, because refusing forever would be worse than a soft scan.
    const waited = Date.now() - (autoArmedAt + AUTO_HOLD_MS);
    if (!sharpEnough(liveSharp, liveSharpBest, AUTO.SHARP_RATIO)
        && waited < AUTO_SHARP_WAIT_MS){
      autoHint("blurry");
      return;                              // stay armed; the ring stays full
    }
    disarmAuto();
    autoNeedsRelease = true;               // do not re-fire on the same page
    autoFire();
  }
}
// Take the page without going anywhere near the Adjust screen.
async function autoFire(){
  const v = $("scanVideo");
  if (autoBusy || capFrame || !liveQuad || !v || !v.videoWidth) return;
  autoBusy = true;
  try {
    const c = document.createElement("canvas");
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext("2d").drawImage(v,0,0);
    flashCapture();
    // v11.40: RE-DETECT the edges on the captured frame at full working
    // resolution. v11.32 warped straight from the live preview quad, and that
    // was the cause of "auto scans look worse than manual ones":
    //
    //   * the live quad is detected at a 300px working size, the Adjust
    //     screen's at 520px. On a 4K frame that is a corner accuracy of ~12.8
    //     source pixels against ~7.4 — and corner error does not blur the
    //     image, it SHEARS it, because those four points define the homography
    //     the whole page is warped through; and
    //   * the live quad is an exponential average of successive detections
    //     (a = 0.35), which by design lags the truth and rounds corners, so it
    //     is deliberately the wrong thing to crop by.
    //
    // The live quad's job is to decide WHEN to fire. Where to cut is a
    // different question and now gets the same answer the manual path gets.
    // The smoothed quad is kept only as a fallback for the case where the
    // still-frame detector finds nothing at all.
    const live = orderQuad(liveQuad.map(p=>({x:p.x,y:p.y})));
    const q = insetQuad(detectQuadOnFrame(c) || live, 0.008);
    // Keep the preview running while the page is processed. The worker does the
    // heavy warp, so the camera does not need to stop — and not stopping is
    // what makes a stack of pages feel continuous instead of stuttery.
    await commitScanPage(c, q, { returnToCamera:false });
  } catch(err){
    setStatus("Auto capture could not finish that page: "+friendly(err),"err");
  }
  autoBusy = false;
}
function flashCapture(){
  const fl = document.getElementById("scanFlash");
  if (fl && typeof requestAnimationFrame === "function"){
    fl.classList.add("go");
    requestAnimationFrame(()=>requestAnimationFrame(()=>fl.classList.remove("go")));
  }
}
function quadClose(a,b){
  let span=0;
  for (let i=0;i<4;i++) span=Math.max(span, Math.hypot(a[i].x-a[(i+1)&3].x, a[i].y-a[(i+1)&3].y));
  const tol=Math.max(20, span*0.18);
  for (let i=0;i<4;i++) if (Math.hypot(a[i].x-b[i].x, a[i].y-b[i].y)>tol) return false;
  return true;
}
let liveErrs = 0;                  // consecutive failing detect frames (v11.31)
function startLiveDetect(){
  if (scanLive) clearInterval(scanLive);
  resetLiveQuad();
  liveErrs = 0;
  let tick = 0;
  scanLive = setInterval(()=>{
    try {
      const v = $("scanVideo");
      if (!v.videoWidth || document.hidden) return;
      // v11.85: re-fit every tick. fitPreviewBox() no-ops unless the box or the
      // stream size actually changed, so this costs two integer reads — and it
      // means the preview corrects itself whatever moved it and whenever,
      // instead of relying on an observer or a listener to notice.
      fitPreviewBox();
      // battery: once the box has locked, detect every other tick (600ms) —
      // a steady scene doesn't need re-detection 3×/second. Any jump or miss
      // clears the lock (in smoothQuad/resetLiveQuad) and full rate resumes.
      // v11.32: never skip while an auto capture is counting down. The motion
      // gate is measured BETWEEN detections, so halving the rate would halve
      // the resolution of the one check that stops a moving page being taken.
      if (quadLocked() && !autoArmedAt && (tick++ & 1)) return;
      drawLiveQuad(smoothQuad(detectOnVideoFrame(v)));
      evalAutoCapture(v);
      liveErrs = 0;
    } catch(e){
      // one bad camera frame must not kill the preview loop — but a loop that
      // is failing EVERY frame used to look exactly like "the green box just
      // doesn't appear", with nothing anywhere to say why. Say it once, and say
      // what still works.
      if (++liveErrs === 5)
        setStatus("Live edge detection isn't working on this device — capture still works, then drag the corners on the next screen.","warn");
    }
  }, 300);
}
// Live-preview detection runs SYNCHRONOUSLY on the main thread. At the 300px
// working size it costs well under one frame, and keeping it inline makes the
// green outline track the camera with no worker round-trip, cold-start or
// fallback lag (that latency was why the outline felt slow to appear). The
// heavy full-res warp on "Use page" still runs in the worker. detectQuad is the
// shared detector from scan-core.js.
function detectOnVideoFrame(v){
  const vw=v.videoWidth, vh=v.videoHeight;
  const s = 300/Math.max(vw,vh);   // v10.20: higher working res = finer edges
  const sw=Math.max(2,Math.round(vw*s)), sh=Math.max(2,Math.round(vh*s));
  const ctx = scratch(sw,sh).getContext("2d",{willReadFrequently:true});
  ctx.drawImage(v,0,0,sw,sh);
  const im = ctx.getImageData(0,0,sw,sh);
  // v11.63: the frame is already in hand and already downscaled, so measuring
  // its quality here costs almost nothing and saves grabbing it twice.
  try { noteFrameStats(frameStats(im)); } catch(e){}
  const q = detectQuadRobust(im);
  return q ? q.map(p=>({x:p.x/s, y:p.y/s})) : null;   // → video px
}
// v11.63: a short rolling memory of how sharp this scene can get. Sharpness is
// only meaningful against itself — a page of dense print scores several times
// higher than a mostly-blank one — so the bar is "as good as this scene has
// recently managed", not a fixed number.
let liveSharp = 0, liveBlown = 0, liveMean = 255, liveSharpBest = 0, liveSharpAt = 0;
function noteFrameStats(st){
  if (!st) return;
  liveSharp = st.sharp; liveBlown = st.blown; liveMean = st.meanL;
  const now = Date.now();
  // let the benchmark decay, or moving from a dense page to a sparse one would
  // leave an unreachable bar behind and auto capture would never fire again
  if (now - liveSharpAt > 2500) liveSharpBest = st.sharp;
  if (st.sharp > liveSharpBest){ liveSharpBest = st.sharp; liveSharpAt = now; }
}
function resetFrameStats(){ liveSharp = 0; liveBlown = 0; liveMean = 255; liveSharpBest = 0; liveSharpAt = 0; }
// Draw the detected document outline on the live preview, plus (v11.32) the
// auto-capture countdown ring at the centre of the document once the hold has
// started. Capture is manual OR automatic depending on the Auto toggle.
function drawLiveQuad(q){
  const cnv=$("scanQuad");
  // v11.31: re-assert the overlay size on every frame. It costs one layout read
  // and writes nothing unless the preview box actually changed, so it is
  // effectively free — but it means the outline heals itself after ANY layout
  // change we don't get a callback for. The one that broke this in practice:
  // adding the first page makes the thumbnail strip appear, which shortens the
  // preview box. Anything else that resizes it — rotation, the iOS URL bar,
  // returning from the Adjust screen — is covered by the same line.
  if (!sizeQuadCanvas()) return;               // camera screen isn't on screen
  const ctx=cnv.getContext("2d");
  ctx.clearRect(0,0,cnv.width,cnv.height);
  if (!q) return;
  const v=$("scanVideo");
  const fit=containFit(v.videoWidth, v.videoHeight, cnv.width, cnv.height);
  ctx.beginPath();
  q.forEach((p,i)=>{ const x=p.x*fit.scale+fit.offX, y=p.y*fit.scale+fit.offY;
                     i ? ctx.lineTo(x,y) : ctx.moveTo(x,y); });
  ctx.closePath();
  // light fill so the document stays clearly visible while framing; the outline
  // carries the signal (a touch bolder/brighter to compensate for less fill)
  ctx.fillStyle="rgba(63,185,80,.07)"; ctx.fill();
  // locked (stable ~0.9s): bolder line + corner ticks say "safe to capture";
  // still settling: the regular thinner outline
  const locked = quadLocked();
  ctx.lineWidth = locked ? 4 : 3;
  ctx.strokeStyle = locked ? "#5dff78" : "#46d65c";
  ctx.stroke();
  if (locked){
    const pts = q.map(p=>({ x:p.x*fit.scale+fit.offX, y:p.y*fit.scale+fit.offY }));
    ctx.lineWidth = 5; ctx.strokeStyle = "#ffffff";
    const L = 14;
    for (let i=0;i<4;i++){
      const c=pts[i], a=pts[(i+3)&3], b=pts[(i+1)&3];
      for (const o of [a,b]){
        const d=Math.hypot(o.x-c.x,o.y-c.y)||1;
        ctx.beginPath(); ctx.moveTo(c.x,c.y);
        ctx.lineTo(c.x+(o.x-c.x)/d*L, c.y+(o.y-c.y)/d*L); ctx.stroke();
      }
    }
  }
  // v11.32: countdown ring, centred on the document. Drawn last so it sits over
  // the outline. It exists to make the capture PREDICTABLE — the user can see
  // the shot coming and can cancel it just by moving, which is why every
  // refusal path in evalAutoCapture disarms rather than pausing.
  if (autoProgress >= 0){
    const cx = q.reduce((s,p)=>s+p.x,0)/4*fit.scale+fit.offX;
    const cy = q.reduce((s,p)=>s+p.y,0)/4*fit.scale+fit.offY;
    const R = 26;
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(255,255,255,.28)";
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI*2); ctx.stroke();
    ctx.strokeStyle = "#5dff78";
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(cx, cy, R, -Math.PI/2, -Math.PI/2 + Math.PI*2*Math.min(1,autoProgress));
    ctx.stroke();
    ctx.lineCap = "butt";
  }
}

// ---- capture ----
function captureFrame(){
  if (capFrame) return;                       // already on the crop screen
  const v=$("scanVideo");
  if (!v.videoWidth){ setStatus("Camera not ready yet.","warn"); return; }
  const c=document.createElement("canvas");
  c.width=v.videoWidth; c.height=v.videoHeight;
  c.getContext("2d").drawImage(v,0,0);
  pauseCamera();   // keep the stream alive (no re-prompt when we return)
  enterCrop(c);
}
$("scanShot").onclick = ()=>{
  if (scanFallback){ $("camInput").click(); return; }
  // v11.61: in HQ the shutter hands over to the iPhone's camera, which returns
  // a full-resolution photo instead of a preview frame.
  // v11.32: a deliberate tap cancels any countdown in progress — the user has
  // decided to frame this one themselves, and it goes through Adjust.
  disarmAuto();
  flashCapture();      // v10.94: iOS-camera-style confirmation — snap, fade out
  captureFrame();
};
// shared: load a photo file (native camera fallback, or library import)
// into the same edge-detect → crop → filter pipeline
async function loadPhotoToCrop(f){
  showSpin(true,"Loading photo…");
  try {
    const im = await loadImage(await fileToDataURL(f));
    // v10.98: 3200 (was 2600) so the native-camera fallback and photo imports
    // match the live path's SCAN_Q.std.maxDim — fallback scans were softer.
    // v11.61: and in HQ the cap rises to 4600, because 3200 was throwing away
    // most of a 12-megapixel photo the moment it arrived. On an A4 page that
    // cap alone is the difference between 274 and 310 dpi.
    // v11.77: read the cap from SCAN_Q rather than repeating it. This was a
    // hardcoded 3200 sitting beside a constant of the same value — raising one
    // and not the other would have quietly left the native-photo path a
    // resolution behind the live one.
    const cap = SCAN_Q.std.maxDim;
    const s = Math.min(1, cap/Math.max(im.naturalWidth, im.naturalHeight));
    const c=document.createElement("canvas");
    c.width=Math.round(im.naturalWidth*s); c.height=Math.round(im.naturalHeight*s);
    c.getContext("2d").drawImage(im,0,0,c.width,c.height);
    $("scanCam").classList.add("show");
    enterCrop(c);
  } catch(err){ setStatus("Could not load that photo: "+friendly(err),"err"); }
  showSpin(false);
}
// fallback path: native camera app returns a photo file
$("camInput").onchange = e=>{
  const f=e.target.files[0]; e.target.value="";
  if (f) loadPhotoToCrop(f);
};

// ---- adjust / crop screen ----
// auto-detect the document edges on the current capFrame (downscaled), falling
// back to a 6% inset rectangle. Sets cropQuad. Returns true if edges were found.
// v11.40: edge detection on a STILL frame, at the 520px working size. Shared by
// the Adjust screen and by auto capture, so an automatic page is cut exactly as
// accurately as a hand-tapped one. Returns the quad in frame pixels, ordered,
// or null when nothing was found.
const CROP_DETECT_PX = 520;         // v10.20: finer edges for low-contrast docs
function detectQuadOnFrame(frame){
  try {
    const s = CROP_DETECT_PX/Math.max(frame.width, frame.height);
    const sw=Math.max(2,Math.round(frame.width*s)), sh=Math.max(2,Math.round(frame.height*s));
    const ctx = scratch(sw,sh).getContext("2d",{willReadFrequently:true});
    ctx.drawImage(frame,0,0,sw,sh);
    const q = detectQuadRobust(ctx.getImageData(0,0,sw,sh));
    return q ? orderQuad(q.map(p=>({x:p.x/s, y:p.y/s}))) : null;
  } catch(e){ return null; }
}
function autoDetectCropQuad(){
  const frame = capFrame;
  let q = detectQuadOnFrame(frame);
  const found = !!q;
  if (!q){
    const mx=frame.width*0.06, my=frame.height*0.06;
    q=[{x:mx,y:my},{x:frame.width-mx,y:my},
       {x:frame.width-mx,y:frame.height-my},{x:mx,y:frame.height-my}];
  }
  cropQuad = q;
  return found;
}
function enterCrop(frame){
  capFrame = frame;
  cropUserAdjusted = false;     // fresh auto-detected quad until the user edits it
  const found = autoDetectCropQuad();
  $("scanCam").classList.remove("show");
  $("scanCrop").classList.add("show");
  refreshScanIdle();
  layoutCrop();
  setStatus(found ? "Edges detected — drag the corners to fine-tune." : "Drag the corners onto the document edges.","ok");
}
// Rotate the captured page a quarter-turn clockwise, before it becomes a PDF
// page — for scans that came out sideways. Re-detects edges on the rotated
// frame and re-lays out the adjust screen.
function rotateCropFrame(){
  if (!capFrame) return;
  const src = capFrame;
  const c = document.createElement("canvas");
  c.width = src.height; c.height = src.width;          // dimensions swap on a 90° turn
  const ctx = c.getContext("2d");
  ctx.translate(c.width, 0);
  ctx.rotate(Math.PI/2);
  ctx.drawImage(src, 0, 0);
  capFrame = c;
  autoDetectCropQuad();
  layoutCrop();
  setStatus("Rotated. Drag the corners to fine-tune.","ok");
}
function layoutCrop(){
  if (!capFrame) return;
  const wrap=$("cropWrap");
  const fit=containFit(capFrame.width, capFrame.height, wrap.clientWidth-12, wrap.clientHeight-12);
  cropFit=fit;
  const left=(wrap.clientWidth-fit.dispW)/2, top=(wrap.clientHeight-fit.dispH)/2;
  const ph=$("cropPhoto");
  // preview runs the filter at reduced resolution (capped DPR) — ~4× faster
  // filter switching with no visible difference; the final page is always
  // processed at full resolution
  const pDPR = Math.min(DPR, 1.5);
  ph.width=Math.round(fit.dispW*pDPR); ph.height=Math.round(fit.dispH*pDPR);
  ph.style.width=fit.dispW+"px"; ph.style.height=fit.dispH+"px";
  ph.style.left=left+"px"; ph.style.top=top+"px";
  renderCropPreview();
  const svg=$("cropSvg");
  svg.setAttribute("width",fit.dispW); svg.setAttribute("height",fit.dispH);
  svg.setAttribute("viewBox","0 0 "+fit.dispW+" "+fit.dispH);
  svg.style.left=left+"px"; svg.style.top=top+"px";
  updateCropOverlay();
}
function updateCropOverlay(){
  const s=cropFit.scale;
  $("cropPoly").setAttribute("points", cropQuad.map(p=>(p.x*s)+","+(p.y*s)).join(" "));
  cropQuad.forEach((p,i)=>{
    const grip=$("g"+i), hit=$("h"+i);          // visible grip + enlarged hit area
    grip.setAttribute("cx",p.x*s); grip.setAttribute("cy",p.y*s);
    hit.setAttribute("cx",p.x*s);  hit.setAttribute("cy",p.y*s);
  });
  // edge (side-midpoint) grips: bar centred on each side, hit area on top
  for (let i=0;i<4;i++){
    const a=cropQuad[i], b=cropQuad[(i+1)%4];
    const mx=(a.x+b.x)/2*s, my=(a.y+b.y)/2*s;
    const grip=$("ge"+i), hit=$("he"+i);
    if (grip){ const gw=+grip.getAttribute("width")||0, gh=+grip.getAttribute("height")||0;
      grip.setAttribute("x", mx-gw/2); grip.setAttribute("y", my-gh/2); }
    if (hit){ hit.setAttribute("cx",mx); hit.setAttribute("cy",my); }
  }
}
// magnifier loupe: a zoomed look at the pixels under the dragged corner
function showLoupe(p){
  const lp=$("loupe"), Z=120;
  lp.hidden=false;
  const ctx=lp.getContext("2d");
  ctx.fillStyle="#000"; ctx.fillRect(0,0,Z,Z);
  const srcW=Z/(cropFit.scale*2.4);                  // ~2.4× screen zoom
  // clamp the source window to the image so edges show black, not garbage
  let sx=p.x-srcW/2, sy=p.y-srcW/2, sw2=srcW, sh2=srcW, dx=0, dy=0;
  const k=Z/srcW;
  if (sx<0){ dx=-sx*k; sw2+=sx; sx=0; }
  if (sy<0){ dy=-sy*k; sh2+=sy; sy=0; }
  if (sx+sw2>capFrame.width)  sw2=capFrame.width-sx;
  if (sy+sh2>capFrame.height) sh2=capFrame.height-sy;
  if (sw2>0 && sh2>0) ctx.drawImage(capFrame, sx, sy, sw2, sh2, dx, dy, sw2*k, sh2*k);
  ctx.strokeStyle="#4f8cff"; ctx.lineWidth=1.5;
  ctx.beginPath(); ctx.moveTo(Z/2,8); ctx.lineTo(Z/2,Z-8); ctx.moveTo(8,Z/2); ctx.lineTo(Z-8,Z/2); ctx.stroke();
  // place the loupe above the finger, kept inside the crop area
  const svg=$("cropSvg");
  const left=(parseFloat(svg.style.left)||0)+p.x*cropFit.scale;
  const top =(parseFloat(svg.style.top) ||0)+p.y*cropFit.scale;
  lp.style.left=Math.max(4, Math.min($("cropWrap").clientWidth -Z-4, left-Z/2))+"px";
  lp.style.top =Math.max(4, top-Z-36)+"px";
}
function hideLoupe(){ $("loupe").hidden=true; }

// draggable corner handles (with loupe)
(function wireCropHandles(){
  for (let i=0;i<4;i++){
    const hEl=$("h"+i);
    // keyboard accessible: Tab to a corner, then nudge with the arrow keys
    // (Shift = bigger steps). Mirrors the drag, for VoiceOver / external keyboards.
    hEl.setAttribute("tabindex","0");
    hEl.addEventListener("keydown", e=>{
      if (!cropFit || !capFrame) return;
      const step = e.shiftKey ? 10 : 2;
      let dx=0, dy=0;
      if (e.key==="ArrowLeft") dx=-step; else if (e.key==="ArrowRight") dx=step;
      else if (e.key==="ArrowUp") dy=-step; else if (e.key==="ArrowDown") dy=step;
      else return;
      e.preventDefault();
      cropQuad[i]={ x:Math.max(0,Math.min(capFrame.width , cropQuad[i].x+dx)),
                    y:Math.max(0,Math.min(capFrame.height, cropQuad[i].y+dy)) };
      cropUserAdjusted = true;
      updateCropOverlay();
    });
    hEl.addEventListener("pointerdown", e=>{
      dragIdx=i; hEl.setPointerCapture(e.pointerId); e.preventDefault();
      if (cropFit && capFrame) showLoupe(cropQuad[i]);
    });
    hEl.addEventListener("pointermove", e=>{
      if (dragIdx!==i || !cropFit || !capFrame) return;
      const r=$("cropSvg").getBoundingClientRect();
      const x=(e.clientX-r.left)/cropFit.scale, y=(e.clientY-r.top)/cropFit.scale;
      cropQuad[i]={ x:Math.max(0,Math.min(capFrame.width ,x)),
                    y:Math.max(0,Math.min(capFrame.height,y)) };
      cropUserAdjusted = true;
      updateCropOverlay();
      showLoupe(cropQuad[i]);
    });
    const end=()=>{ dragIdx=-1; hideLoupe(); };
    hEl.addEventListener("pointerup",end);
    hEl.addEventListener("pointercancel",end);
  }
})();

// draggable EDGE handles (v10.83): grab the middle of a side and move that whole
// side — both of its corners shift together by the drag amount (free direction).
(function wireCropEdges(){
  const clampX=v=>Math.max(0,Math.min(capFrame.width ,v));
  const clampY=v=>Math.max(0,Math.min(capFrame.height,v));
  for (let i=0;i<4;i++){
    const hEl=$("he"+i); if (!hEl) continue;
    const ia=i, ib=(i+1)%4;                 // the two corners this side connects
    let start=null, baseA=null, baseB=null;
    const mid=()=>({ x:(cropQuad[ia].x+cropQuad[ib].x)/2, y:(cropQuad[ia].y+cropQuad[ib].y)/2 });
    hEl.setAttribute("tabindex","0");
    hEl.addEventListener("keydown", e=>{
      if (!cropFit || !capFrame) return;
      const step = e.shiftKey ? 10 : 2;
      let dx=0, dy=0;
      if (e.key==="ArrowLeft") dx=-step; else if (e.key==="ArrowRight") dx=step;
      else if (e.key==="ArrowUp") dy=-step; else if (e.key==="ArrowDown") dy=step;
      else return;
      e.preventDefault();
      cropQuad[ia]={ x:clampX(cropQuad[ia].x+dx), y:clampY(cropQuad[ia].y+dy) };
      cropQuad[ib]={ x:clampX(cropQuad[ib].x+dx), y:clampY(cropQuad[ib].y+dy) };
      cropUserAdjusted = true;
      updateCropOverlay();
    });
    hEl.addEventListener("pointerdown", e=>{
      if (!cropFit || !capFrame) return;
      hEl.setPointerCapture(e.pointerId); e.preventDefault();
      const r=$("cropSvg").getBoundingClientRect();
      start={ x:(e.clientX-r.left)/cropFit.scale, y:(e.clientY-r.top)/cropFit.scale };
      baseA={ x:cropQuad[ia].x, y:cropQuad[ia].y };
      baseB={ x:cropQuad[ib].x, y:cropQuad[ib].y };
      showLoupe(mid());
    });
    hEl.addEventListener("pointermove", e=>{
      if (!start || !cropFit || !capFrame) return;
      const r=$("cropSvg").getBoundingClientRect();
      const dx=(e.clientX-r.left)/cropFit.scale - start.x;
      const dy=(e.clientY-r.top)/cropFit.scale - start.y;
      cropQuad[ia]={ x:clampX(baseA.x+dx), y:clampY(baseA.y+dy) };
      cropQuad[ib]={ x:clampX(baseB.x+dx), y:clampY(baseB.y+dy) };
      cropUserAdjusted = true;
      updateCropOverlay();
      showLoupe(mid());
    });
    const end=()=>{ start=null; hideLoupe(); };
    hEl.addEventListener("pointerup",end);
    hEl.addEventListener("pointercancel",end);
  }
})();

// Reset the crop to a near-full-page rectangle — a clean starting point for the
// reliable manual path when auto-detection grabbed the wrong thing (a keyboard,
// the desk) or nothing at all.
function resetCropQuad(){
  if (!capFrame || !cropFit) return;
  const mx=capFrame.width*0.04, my=capFrame.height*0.04;
  cropQuad=[{x:mx,y:my},{x:capFrame.width-mx,y:my},
            {x:capFrame.width-mx,y:capFrame.height-my},{x:mx,y:capFrame.height-my}];
  cropUserAdjusted = true;     // manual control — honour this box exactly, no auto-inset
  updateCropOverlay();
  setStatus("Reset to the full page — drag the box or its corners onto the document.","ok");
}
$("cropReset").onclick = ()=> resetCropQuad();

// Drag the WHOLE crop box (move all 4 corners together) by dragging its interior,
// so a correctly-shaped box can be slid onto the document and then fine-tuned at
// the corners. The corner hit-circles sit on top, so grabbing near a corner still
// drags just that corner.
(function wireCropBody(){
  const poly=$("cropPoly");
  let start=null, base=null;
  poly.addEventListener("pointerdown", e=>{
    if (!cropFit || !capFrame) return;
    try{ poly.setPointerCapture(e.pointerId); }catch(_){}
    e.preventDefault();
    const r=$("cropSvg").getBoundingClientRect();
    start={ x:(e.clientX-r.left)/cropFit.scale, y:(e.clientY-r.top)/cropFit.scale };
    base=cropQuad.map(p=>({x:p.x,y:p.y}));
  });
  poly.addEventListener("pointermove", e=>{
    if (!start || !base) return;
    const r=$("cropSvg").getBoundingClientRect();
    let dx=(e.clientX-r.left)/cropFit.scale - start.x;
    let dy=(e.clientY-r.top)/cropFit.scale - start.y;
    const xs=base.map(p=>p.x), ys=base.map(p=>p.y);
    const minX=Math.min(...xs), maxX=Math.max(...xs), minY=Math.min(...ys), maxY=Math.max(...ys);
    dx=Math.max(-minX, Math.min(capFrame.width -maxX, dx));   // keep the box inside the image
    dy=Math.max(-minY, Math.min(capFrame.height-maxY, dy));
    cropQuad=base.map(p=>({x:p.x+dx, y:p.y+dy}));
    cropUserAdjusted = true;
    updateCropOverlay();
  });
  const end=()=>{ start=null; base=null; };
  poly.addEventListener("pointerup",end);
  poly.addEventListener("pointercancel",end);
})();

// v11.70: the Quality control is gone (see scanQuality above for the numbers).
// Any "small" left in storage from an earlier build is cleared, otherwise a
// phone that had it set would keep capturing at 1400px with no way to change it.
try { localStorage.removeItem("scanQuality"); } catch(e){}
// "Whiten": flatten illumination so shadowed/crumpled paper reads as white.
// Re-renders the crop preview so you can compare before tapping Use page.
// v11.69: Plain / Whiten / Photo ID are one setting with three values, and the
// segmented control now says so. They always WERE exclusive — turning Photo ID
// on quietly switched Whiten off — but as two look-alike toggles the rule was
// invisible, so the pair could be read as "both on" when that state never
// existed. setScanEnhance and setScanIdMode keep their old signatures and
// storage keys so everything downstream (and the tests) is unaffected.
// v11.80: Type has two values, Document and Photo ID. "Plain" is gone — it was
// the unprocessed capture, and every document scan now gets the illumination
// flattening and polish that used to be called Whiten. Document is the default.
function scanType(){ return scanIdMode ? "id" : "document"; }
function refreshTypeSeg(){
  const t = scanType();
  const set = (id, on)=>{
    const b = $(id); if (!b) return;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
  };
  set("enhToggle", t === "document");
  set("idToggle",  t === "id");
}
try { refreshTypeSeg(); } catch(e){}
$("enhToggle").onclick = ()=>{
  if (scanIdMode) setScanIdMode(false);      // also clears any held front side
  setScanEnhance(true);
};
function setScanEnhance(on){
  scanEnhance = !!on;
  try { localStorage.setItem("scanEnhance", scanEnhance ? "1" : "0"); } catch(e){}
  refreshTypeSeg();
  renderCropPreview();
}
// "Photo ID": treat the selected region as an ID/photo card — process it light and
// colour-true (no ink-deepen/whiten) and drop it onto a clean white A4 page, like
// a flatbed ID scan. Mutually exclusive with Whiten (the document polish).
$("idToggle").onclick = ()=> setScanIdMode(true);
function setScanIdMode(on){
  scanIdMode = !!on;
  try { localStorage.setItem("scanIdMode", scanIdMode ? "1" : "0"); } catch(e){}
  if (scanIdMode){            // Whiten/document polish would fight the ID look
    scanEnhance = false;
    try { localStorage.setItem("scanEnhance","0"); } catch(e){}
    setStatus(idTwoSide
      ? "Photo ID, both sides: scan the front, then the back — they go on one A4 page."
      : "Photo ID mode: the card will be placed on a white A4 page. Frame just the card.","ok");
  } else {
    clearIdPending(true);     // leaving ID mode abandons any held front side
    // v11.80: there is no unprocessed type any more, so leaving Photo ID must
    // land on Document rather than on nothing.
    scanEnhance = true;
    try { localStorage.setItem("scanEnhance","1"); } catch(e){}
  }
  refreshTypeSeg();
  refreshIdTwoSideBtn();
  renderCropPreview();
}
// v11.34: "Both sides" — only relevant inside Photo ID mode, so it is hidden
// rather than merely disabled when ID mode is off. Hiding it also keeps the
// filter row from wrapping to a third line on a small phone.
function refreshIdTwoSideBtn(){
  const b = $("idBothToggle"); if (!b) return;
  // v11.82: a one-of pair, so BOTH buttons are set — lighting one without
  // clearing the other is how a segmented control ends up showing two
  // selections at once.
  const one = $("idSingleToggle");
  if (one){
    one.classList.toggle("on", !idTwoSide);
    one.setAttribute("aria-pressed", String(!idTwoSide));
  }
  // v11.81: the whole row hides, not just the button — the button now lives
  // inside a segmented track, and hiding only the button would leave an empty
  // track sitting under Photo ID.
  const row = $("bothRow"); if (row) row.hidden = !scanIdMode;
  b.hidden = false;
  b.classList.toggle("on", idTwoSide);
  b.setAttribute("aria-pressed", String(idTwoSide));
}
$("idBothToggle").onclick   = ()=> setIdTwoSide(true);
$("idSingleToggle").onclick = ()=> setIdTwoSide(false);
function setIdTwoSide(on){
  idTwoSide = !!on;
  try { localStorage.setItem("scanIdTwoSide", idTwoSide ? "1" : "0"); } catch(e){}
  if (!idTwoSide) clearIdPending(true);   // a held side has nothing to pair with now
  refreshIdTwoSideBtn();
  setStatus(idTwoSide
    ? "Both sides: scan the front, then the back — they go on one A4 page."
    : "One card per page.","ok");
}
refreshIdTwoSideBtn();

// v11.33: output paper size — cycles through the sizes that actually get used.
// v11.70: two values, not four. Letter and Legal are still in PAPER_SIZES for
// Resize pages, but a phone scan is either a real A4 page or the shape it was
// captured at — the other two were only ever taps to get past.
$("paperBtn").onclick = ()=>{
  setScanPaper(scanPaper === "a4" ? "auto" : "a4");
};
function paperLabel(key){
  const p = PAPER_SIZES[key];
  return "Page: " + (p ? p.label : "As captured");
}
function setScanPaper(key){
  if (!(key in PAPER_SIZES)) key = "a4";
  scanPaper = key;
  try { localStorage.setItem("scanPaper", key); } catch(e){}
  refreshPaperBtn();
  setStatus(PAPER_SIZES[key]
    ? "Scanned pages will be "+PAPER_SIZES[key].label+" — the image is fitted inside, never cropped or stretched."
    : "Scanned pages keep the shape they were captured at.","ok");
}
function refreshPaperBtn(){
  const b = $("paperBtn"); if (!b) return;
  // v11.69: the chip carries a fixed "Page" label and a separate value span, so
  // only the value is rewritten. Writing textContent here would wipe out both
  // spans and leave a chip that no longer says what it is.
  const v = $("paperVal"), p = PAPER_SIZES[scanPaper];
  if (v) v.textContent = p ? p.label : "As captured";
  else b.textContent = paperLabel(scanPaper);
  b.classList.toggle("on", scanPaper !== "auto");
}
refreshPaperBtn();

// v11.70: the colour cycler is gone. Greyscale and B&W were there to shrink a
// text page; MRC now does that while keeping the colour, so the choice only
// cost fidelity. The labels stay because the compress report still names the
// mode a stored image is in.
const COLOUR_LABEL = { colour:"Colour", grey:"Greyscale", bw:"Black & white" };

// v11.32: auto capture toggle.
$("autoBtn").onclick = ()=> setScanAuto(!scanAuto);
function setScanAuto(on){
  scanAuto = !!on;
  try { localStorage.setItem("scanAuto", scanAuto ? "1" : "0"); } catch(e){}
  refreshAutoBtn();
  if (!scanAuto) disarmAuto();
  setStatus(scanAuto
    ? "Auto capture on — hold the camera steady over a page and it will be taken for you."
    : "Auto capture off — tap the shutter for each page.","ok");
}
function refreshAutoBtn(){
  const b = $("autoBtn"); if (!b) return;
  b.classList.toggle("on", scanAuto);
  b.setAttribute("aria-pressed", String(scanAuto));
  // the fallback path has no live preview to detect on, so there is nothing to
  // automate — hide the control rather than leave a dead toggle on screen
  b.hidden = scanFallback;
}
refreshAutoBtn();
// v11.80: the high-quality toggle, its button and its idle sign are removed with the
// mode itself. refreshScanIdle survives as a no-op guard because it is called
// from several places in the capture flow; leaving those calls pointing at a
// missing function would break the scanner rather than the button.
function refreshScanIdle(){ /* nothing to show: there is only one camera now */ }
// ---- v11.34: both sides of a card on ONE page ----------------------------
// "Both sides" is the single most-requested shape of an ID scan and the one
// every print shop produces: front and back of the same card, stacked on one
// A4 sheet. Before v11.34 each capture became a page of its own, so an Aadhaar
// or PAN card came out as a two-page PDF with two-thirds of each page blank —
// which then had to be printed twice.
// Only meaningful inside Photo ID mode; the toggle is hidden otherwise.
// (`idTwoSide` and `idPendingCard` are declared with the rest of the scanner
// state, above — the toggle wiring runs before this point and a `let` here
// would be in its temporal dead zone.)
//
// A4 @ 300 dpi. The white field costs almost nothing once JPEG-compressed, so
// a full-size page here does not blow the size budget.
const ID_PAGE_W = 2480, ID_PAGE_H = 3508;

// Shared placement maths for one or two cards on a white A4 portrait page.
// Returns the page canvas. Passing a single card reproduces the pre-v11.34
// geometry EXACTLY (46% width, 42% max height, top at 17% of the page), so the
// existing one-sided output is unchanged to the pixel.
function compositeCardsOnA4(cards){
  const list = cards.filter(Boolean);
  const c = document.createElement("canvas"); c.width=ID_PAGE_W; c.height=ID_PAGE_H;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0,0,ID_PAGE_W,ID_PAGE_H);
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
  if (!list.length) return c;

  const TARGET_W = Math.round(ID_PAGE_W*0.46);          // card width ≈ 46% of the page
  // Each side is fitted independently: the two captures are rarely framed
  // identically, and forcing a shared scale would shrink whichever side
  // happened to be photographed from further away.
  const fit = (card, maxH)=>{
    const cw=card.width, ch=card.height;
    let dw=TARGET_W, dh=Math.round(TARGET_W*ch/cw);
    if (dh > maxH){ dh = maxH; dw = Math.round(maxH*cw/ch); }
    return { dw, dh };
  };
  if (list.length === 1){
    const { dw, dh } = fit(list[0], Math.round(ID_PAGE_H*0.42));
    ctx.drawImage(list[0], Math.round((ID_PAGE_W-dw)/2), Math.round(ID_PAGE_H*0.17), dw, dh);
    return c;
  }
  // Two sides: stack them in the upper two-thirds with a clear gap, both
  // horizontally centred. Height cap is per card so a tall card (a passport
  // page rather than an ID-1 card) still cannot overrun the sheet.
  const maxH = Math.round(ID_PAGE_H*0.30);
  const a = fit(list[0], maxH), b = fit(list[1], maxH);
  const gap = Math.round(ID_PAGE_H*0.055);
  const total = a.dh + gap + b.dh;
  // centre the pair in the upper 78% of the page, never higher than a 9% margin
  let y = Math.max(Math.round(ID_PAGE_H*0.09), Math.round((ID_PAGE_H*0.78-total)/2));
  ctx.drawImage(list[0], Math.round((ID_PAGE_W-a.dw)/2), y, a.dw, a.dh);
  y += a.dh + gap;
  ctx.drawImage(list[1], Math.round((ID_PAGE_W-b.dw)/2), y, b.dw, b.dh);
  return c;
}
function compositeCardOnA4(cardCanvas){ return compositeCardsOnA4([cardCanvas]); }

// Hold side 1, or combine with the held side 1 and return the finished page.
// Returns null while still waiting for the second side.
function takeIdSide(card, returnToCamera){
  if (!idPendingCard){
    idPendingCard = card;
    try {
      const t = document.createElement("canvas");
      const sc = Math.min(1, 220/Math.max(card.width, card.height));
      t.width  = Math.max(1, Math.round(card.width*sc));
      t.height = Math.max(1, Math.round(card.height*sc));
      t.getContext("2d").drawImage(card, 0, 0, t.width, t.height);
      idPendingThumb = t.toDataURL("image/jpeg", 0.7);
    } catch(e){ idPendingThumb = null; }
    capFrame = null;
    if (returnToCamera){
      $("scanCrop").classList.remove("show");
      $("scanCam").classList.add("show");
      if (!scanFallback) resumeCamera();
    }
    updateScanCount();          // refreshes the "side 1 held" hint
    renderScanThumbs();         // ...and shows the front that is being held
    setStatus("Front captured. Turn the card over and scan the back.","ok");
    return null;
  }
  const page = compositeCardsOnA4([idPendingCard, card]);
  idPendingCard = null; idPendingThumb = null;
  return page;
}
// Drop a half-finished card pair. Called when ID mode or the two-side toggle is
// switched off and when the scan session ends, so a stale side can never be
// silently welded onto an unrelated card later.
function clearIdPending(quiet){
  if (!idPendingCard) return;
  idPendingCard = null; idPendingThumb = null;
  updateScanCount(); renderScanThumbs();
  if (!quiet) setStatus("The held front side was discarded.","warn");
}
// draw the captured photo onto the crop canvas with the active filter applied,
// so Colour / B&W switch what you see instantly (preview runs at display
// resolution — the final page is processed at full resolution on "Use page")
function renderCropPreview(){
  if (!capFrame) return;
  const ph=$("cropPhoto");
  if (!ph.width || !ph.height) return;
  const ctx=ph.getContext("2d",{willReadFrequently:true});
  ctx.drawImage(capFrame,0,0,ph.width,ph.height);
  const im=ctx.getImageData(0,0,ph.width,ph.height);
  if (scanIdMode){ idCardEnhance(im.data, im.width, im.height); ctx.putImageData(im,0,0); return; }
  colourBalanceCore(im.data, im.width, im.height);
  if (scanEnhance){ flattenIllumination(im.data, im.width, im.height);
    documentEnhance(im.data, im.width, im.height); }   // natural Lens polish (v10.75)
  ctx.putImageData(im,0,0);
}

$("cropRotate").onclick = ()=> rotateCropFrame();
$("cropRetake").onclick = async ()=>{
  capFrame=null;
  $("scanCrop").classList.remove("show");
  $("scanCam").classList.add("show");
  if (scanFallback) $("camInput").click(); else await resumeCamera();
};
// v11.81: the Delete button is removed. Retake does the same job — it drops
// the capture being reviewed and puts you back at the camera — so two buttons
// for one action was a choice with no difference behind it.
$("scanCancel").onclick = ()=>{
  if (!scanPages.length){ endScan(); setStatus("Scan cancelled.","warn"); return; }
  // in-app sheet instead of the native confirm() dialog
  $("sheet").innerHTML = h`
    <h3>Discard scan?</h3>
    <p class="hint">${scanPages.length} scanned page(s) will be lost. This cannot be undone.</p>
    <div class="row"><button class="full" id="dsYes">Discard pages</button></div>
    <div class="row"><button class="ghost full" id="dsNo">Keep scanning</button></div>`;
  $("dsYes").onclick=()=>{ closeSheet(); endScan(); setStatus("Scan cancelled.","warn"); };
  $("dsNo").onclick=closeSheet;
  openSheet();
};

// confirm the page: perspective-correct, filter, JPEG-encode, back to camera
let cropBusy = false;          // re-entrancy guard: one processing at a time

// v11.32: the page pipeline, lifted out of the "Use page" handler so the auto
// capture path can run the IDENTICAL processing without the Adjust screen. The
// two callers differ only in where the quad came from and whether there is a
// screen to come back from — every pixel decision below is shared, so an auto
// page and a hand-cropped page are byte-for-byte comparable.
//   frame  : canvas holding the full-res capture
//   q      : 4 corners in frame px, already ordered and inset as appropriate
//   opts.returnToCamera : true when we are on the Adjust screen and must go back
async function commitScanPage(frame, q, opts){
  const returnToCamera = !!(opts && opts.returnToCamera);
  const Q0 = SCAN_Q[scanQuality] || SCAN_Q.std;
  const Q = Q0;                       // v11.80: no HQ branch left to choose
  let out, c;
  if (scanIdMode){
    // Photo ID: warp just the card, enhance it light + colour-true, then
    // composite it onto a clean white A4 page (Epson-style ID scan).
    showSpin(true,"Placing ID on a white page…");
    out = warpPerspective(frame, q, 1800);              // card long side ≤1800
    idCardEnhance(out.data, out.width, out.height);
    const card=document.createElement("canvas"); card.width=out.width; card.height=out.height;
    card.getContext("2d").putImageData(out,0,0);
    if (idTwoSide){
      // v11.34: the first side is held back and composited with the second, so
      // the pair lands on ONE page. Returns null while still waiting.
      const both = takeIdSide(card, returnToCamera);
      if (!both) return;
      c = both;
    } else {
      c = compositeCardOnA4(card);
    }
    out = { width:c.width, height:c.height };           // page dims for the record
  } else {
    // preferred path: warp + filter in the worker (UI stays responsive)
    const sctx = frame.getContext("2d",{willReadFrequently:true});
    out = await processPageOffThread(
      sctx.getImageData(0,0,frame.width,frame.height), q, cropFilter, Q.maxDim, scanEnhance);
    if (!out){                                 // fallback: same math, main thread
      out = warpPerspective(frame, q, Q.maxDim);
      colourBalanceCore(out.data, out.width, out.height);
      if (scanEnhance){ flattenIllumination(out.data, out.width, out.height);
        documentEnhance(out.data, out.width, out.height); }   // natural Lens polish (v10.75)
    }
    // v11.67: store the page the way the user asked for. Photo ID mode keeps
    // its own colour-true treatment and is deliberately not touched here.
    if (scanColour === "grey") toGreyscale(out.data, out.width, out.height);
    else if (scanColour === "bw") toBlackAndWhite(out.data, out.width, out.height);
    c=document.createElement("canvas"); c.width=out.width; c.height=out.height;
    c.getContext("2d").putImageData(out,0,0);
  }
  await pushScanPage(c, out.width, out.height);
  capFrame=null;
  updateScanCount();
  if (returnToCamera){
    $("scanCrop").classList.remove("show");
    $("scanCam").classList.add("show");
    // v11.62: in HQ there is no preview to resume — the next page comes from
    // the iPhone's camera, opened again by the shutter (one tap per page).
    if (!scanFallback) await resumeCamera();
    refreshScanIdle();
  }
  // v11.61: say what the page actually came out at. 300dpi is the mark the
  // paid scanners aim for; below about 200 small print starts to break up, and
  // that is worth knowing BEFORE the paper goes back in the drawer.
  const dpi = scanPageDpi(out.width, out.height);
  const dpiNote = dpi ? " at " + dpi + " dpi" + (dpi < 200 ? " — a bit soft; fill the screen with the page, or turn HQ on" : "") : "";
  // v11.64: say so at once when a page comes out blank. Catching it here costs
  // one tap to remove; catching it after the PDF is made costs a reprint.
  const last = scanPages[scanPages.length-1];
  if (last && last.blank){
    setStatus("Page "+scanPages.length+" looks blank — tap it in the strip below to remove it, or carry on if that is the back of a sheet.","warn");
  } else {
    setStatus("Page "+scanPages.length+" added"+dpiNote+" — "
      + (scanAuto && !returnToCamera ? "hold the camera over the next one."
                                     : "scan the next page or tap Create PDF."), "ok");
  }
}
// The resolution a finished page actually reached, as dots per inch across its
// long side once it is laid out on paper. v11.61 shows this after every scan:
// the whole argument for HQ is a number, so the number is on screen rather
// than in a changelog.
function scanPageDpi(w, h){
  try {
    const box = fitToPaper(w, h, scanPaper);
    if (!box) return 0;
    const longPx = Math.max(w, h), longPt = Math.max(box.w, box.h);
    if (!(longPt > 0)) return 0;
    return Math.round(longPx / (longPt/72));
  } catch(e){ return 0; }
}
// encode + record one finished page canvas
async function pushScanPage(c, w, h){
  const QQ0 = SCAN_Q[scanQuality] || SCAN_Q.std;
  const QQ = QQ0;                     // v11.80: no HQ branch left to choose
  const blob = await encodeScanJpeg(c, QQ.jpeg, QQ.budget, QQ.qFloor);
  // small thumbnail (112px tall ≈ 56 css px at 2×) for the review strip
  const tc=document.createElement("canvas");
  tc.height=112; tc.width=Math.max(8,Math.round(w*112/h));
  tc.getContext("2d").drawImage(c,0,0,tc.width,tc.height);
  // v11.64: judge blankness from the finished page, on a small copy — a full
  // 4600px page would cost more to inspect than it did to make.
  let blank = false;
  try {
    const bw = 160, bh = Math.max(8, Math.round(h*160/w));
    const bc = document.createElement("canvas"); bc.width=bw; bc.height=bh;
    bc.getContext("2d",{willReadFrequently:true}).drawImage(c,0,0,bw,bh);
    blank = looksBlank(bc.getContext("2d").getImageData(0,0,bw,bh));
  } catch(e){}
  // v11.70: remember that this page came from Photo ID mode. MRC would accept
  // such a page — a card is only about a tenth of an A4 sheet, so the page is
  // not "mostly picture" — and store the card in the 100dpi background. On a
  // synthetic card the fine print survived (it is near-neutral, so it goes to
  // the 300dpi stencil), but a real ID also carries a face photograph and a
  // hologram, and those are exactly the pictorial parts that would be softened.
  // Photo ID exists to be colour-true and lightly processed, so it opts out.
  const rec = { bytes:new Uint8Array(await blob.arrayBuffer()), w, h,
                thumb:tc.toDataURL("image/jpeg",0.7), rot:0, blank, id:scanIdMode };
  // v11.67: a retake replaces the page it was started from, keeping its place
  // in the stack; anything else goes on the end.
  if (scanRetakeAt >= 0 && scanRetakeAt < scanPages.length){
    scanPages[scanRetakeAt] = rec;
    scanRetakeAt = -1;
  } else {
    scanRetakeAt = -1;
    scanPages.push(rec);
  }
}

$("cropUse").onclick = async ()=>{
  if (!capFrame || cropBusy) return;
  cropBusy = true;
  showSpin(true,"Straightening page…");
  try {
    await new Promise(r=>setTimeout(r,30));    // let the spinner paint first
    // Honour a hand-placed selection EXACTLY. The 0.8% inset only ever existed
    // to hide edge bleed on a FULLY auto-detected quad; when the user has moved
    // a corner or the box it was clipping wanted content near the page edge.
    const q = cropUserAdjusted
      ? orderQuad(cropQuad)
      : insetQuad(orderQuad(cropQuad), 0.008);
    await commitScanPage(capFrame, q, { returnToCamera:true });
  } catch(err){ setStatus("Could not finish this page: "+friendly(err),"err"); }
  showSpin(false);
  cropBusy = false;
};

// build the PDF (pages on a real paper size) and open it in the editor — or,
// when the session was started with "Scan more pages", append to what's open.
$("scanDone").onclick = ()=>{
  if (!scanPages.length) return;
  // v11.64: a stack fed through by hand often carries blank backs. Offer to
  // leave them out ONCE, here, rather than letting them into the document and
  // making the user delete them page by page afterwards.
  const blanks = scanPages.filter(p=>p.blank).length;
  if (blanks && blanks < scanPages.length){
    $("sheet").innerHTML = h`
      <h3>${blanks} page${blanks>1?"s look":" looks"} blank</h3>
      <p class="hint">Of the ${scanPages.length} pages scanned, ${blanks} ${blanks>1?"have":"has"} nothing on ${blanks>1?"them":"it"} — usually the back of a sheet. They can be left out of the PDF.</p>
      <div class="row"><button class="full" id="sbDrop">Leave ${blanks===1?"it":"them"} out</button></div>
      <div class="row"><button class="full" id="sbKeep">Keep every page</button></div>
      <div class="row"><button class="ghost full" id="sbCancel">Cancel</button></div>`;
    $("sbDrop").onclick = ()=>{
      closeSheet();
      scanPages = scanPages.filter(p=>!p.blank);
      updateScanCount();
      if (scanAppendTo){ appendScanToDoc(); return; }
      confirmDiscard("create the scanned PDF", createScanPdf);
    };
    $("sbKeep").onclick = ()=>{
      closeSheet();
      if (scanAppendTo){ appendScanToDoc(); return; }
      confirmDiscard("create the scanned PDF", createScanPdf);
    };
    $("sbCancel").onclick = closeSheet;
    openSheet();
    return;
  }
  if (scanAppendTo){ appendScanToDoc(); return; }   // v11.35: nothing to discard
  confirmDiscard("create the scanned PDF", createScanPdf);
};
// Draw one scanned page into `doc`, on a real paper size, honouring its turn.
// Shared by createScanPdf and the v11.35 append path so a page added to an
// existing document is built exactly like a page in a brand-new one.
async function addScanPageTo(doc, p){
  const img = await doc.embedJpg(p.bytes);
  const box = fitToPaper(p.w, p.h, scanPaper);
  const pg = doc.addPage([box.pageW, box.pageH]);
  // The white letterbox margin: pdf-lib pages have no background, and a page
  // with a transparent margin prints as whatever the printer decides. Paint it.
  if (box.letterboxed)
    pg.drawRectangle({ x:0, y:0, width:box.pageW, height:box.pageH, color:rgb(1,1,1) });
  pg.drawImage(img, { x:box.x, y:box.y, width:box.w, height:box.h });
  // v11.33: rotation is recorded as /Rotate rather than by re-encoding the
  // JPEG, so turning a page costs nothing and loses nothing.
  const r = normaliseRot(p.rot);
  if (r) pg.setRotation(degrees(r));
  return pg;
}
// v11.62: put a freshly built scan through the image pass before it is opened.
// A 308dpi HQ page came out at 2.73 MB because it was stored as a full-colour
// JPEG at the quality the camera gave. This keeps the resolution and re-encodes
// — and where the page is near black-and-white, stores it as CCITT G4 instead,
// which is the same route the paid scanners take to small files.
//
// Never allowed to make things worse: if the pass fails, or the result is not
// actually smaller, the original bytes are returned untouched.
// v11.74: shrinkScanPdf is gone. It ran on every freshly built scan and
// re-encoded the page at q68/300dpi, down from the captured q92/3200px — a
// quality loss applied automatically, which is precisely what v11.31 did not
// do. Both of its candidates are still available, deliberately, under Compress:
// the per-image levels, and MRC via runMrcCompress().
async function createScanPdf(){
  if (!scanPages.length) return;
  const pages=scanPages.slice();
  endScan();
  showSpin(true,"Creating PDF from "+pages.length+" page(s)…");
  try {
    const doc=await PDFDocument.create();
    for (const p of pages) await addScanPageTo(doc, p);
    // v11.74: a new scan is written EXACTLY as captured — q92, up to 3200px,
    // continuous tone — which is what v11.31 did and what made its scans good.
    //
    // Two compression stages had crept in front of this line and both cost
    // quality that could not be got back:
    //   v11.62 shrinkScanPdf   re-encoded the page at q68/300dpi, down from the
    //                          captured q92/3200px (~387dpi)
    //   v11.68 MRC             replaced continuous-tone text with a 1-bit
    //                          stencil, which merged 6pt print
    // Neither belongs in the capture path. Making a scan smaller is a decision
    // with a cost, so it is now something you ask for under Compress, where the
    // saving is shown and the original is still on screen to compare against.
    workingBytes = new Uint8Array(await doc.save());
    // dated default name ("Scan 5 Jul 2026 14.30.pdf") so saved scans are
    // findable in Files instead of a pile of identical "scan.pdf"s
    const d=new Date();
    fileName="Scan "+d.getDate()+" "+d.toLocaleString("en",{month:"short"})+" "+d.getFullYear()
      +" "+String(d.getHours()).padStart(2,"0")+"."+String(d.getMinutes()).padStart(2,"0")+".pdf";
    undoStack=[]; setMode(null);
    reopen(); setDirty(true); await render(); enableDocButtons(true);
    const sz = PAPER_SIZES[scanPaper];
    setStatus("Scanned "+pages.length+" page(s)"+(sz?" at "+sz.label:"")
      +" — tap Save to keep it as “"+fileName+"”.","ok");
  } catch(err){ setStatus("Could not create the PDF: "+friendly(err),"err"); }
  showSpin(false);
};

// ---- v11.35: add the scanned pages to the document already open -----------
// The everyday case this fixes: a contract is open, one page comes back signed
// on paper, and it has to go on the end. Before v11.35 that meant saving the
// scan as its own PDF, reopening the original, then Combine — three round trips
// through the Files app for one page.
//
// The pages are built into a temporary PDF with the SAME addScanPageTo used for
// a brand-new document (so an appended page is identical to a scanned one), and
// then grafted with mupdf's graftPage — the same primitive Combine uses, which
// carries the page's resources across properly rather than re-rasterising it.
async function appendScanToDoc(){
  if (!scanPages.length) return;
  if (!workingBytes || !MDOC){       // the document went away while scanning
    setStatus("That document is no longer open — creating a new PDF instead.","warn");
    scanAppendTo = null; await createScanPdf(); return;
  }
  const pages = scanPages.slice(), target = (scanAppendTo && scanAppendTo.name) || fileName;
  endScan();
  showSpin(true,"Adding "+pages.length+" page(s) to “"+target+"”…");
  let base = null, add = null;
  try {
    // Build and validate the scanned pages FIRST, before anything touches the
    // open document. If this throws, the document is left exactly as it was —
    // no undo step, no dirty flag, no half-appended file.
    const doc = await PDFDocument.create();
    for (const p of pages) await addScanPageTo(doc, p);
    const addBytes = new Uint8Array(await doc.save());
    add  = mupdf.Document.openDocument(addBytes, "application/pdf").asPDF();
    base = mupdf.Document.openDocument(workingBytes.slice(0), "application/pdf").asPDF();
    if (!add || !base) throw new Error("Could not read the pages back.");
    const before = base.countPages(), n = add.countPages();
    const undoKept = pushUndoGuarded();      // committed from here
    for (let i=0;i<n;i++) base.graftPage(-1, add, i);
    workingBytes = u8(base.saveToBuffer("garbage").asUint8Array());
    reopen(); setDirty(true); await render(); enableDocButtons(true);
    setStatus("Added "+n+" page(s) to “"+target+"” — now "+(before+n)+" pages. Tap Save to keep it."
      + (undoKept ? "" : " (Too large to keep an undo step.)"), "ok");
  } catch(err){
    setStatus("Could not add those pages: "+friendly(err),"err");
  } finally {
    try{ if(add)  add.destroy();  }catch(e){}
    try{ if(base) base.destroy(); }catch(e){}
    showSpin(false);
  }
}

// ---- document edge detection ----
// detectQuad and its helpers now live in scan-core.js (imported above), so the
// main thread (still-capture auto-detect + live-preview fallback) and the scan
// worker (off-thread live detection) share ONE copy. See scan-core.js.
// re-derive TL,TR,BR,BL after the user has dragged corners around
function orderQuad(q){
  const bySum=[...q].sort((a,b)=>(a.x+a.y)-(b.x+b.y));
  const tl=bySum[0], br=bySum[3];
  const [a,b]=bySum.slice(1,3);
  const tr = (a.x-a.y) > (b.x-b.y) ? a : b;
  return [tl, tr, br, tr===a ? b : a];
}
// Pull the 4 corners a hair toward their centroid before warping, so a thin
// sliver of background/shadow just outside the page edge isn't sampled into the
// scanned border. The page itself almost always has a small white margin, so
// this trims bleed without eating content. frac is a fraction of each corner's
// distance to the centre (≈0.8% ≈ a few px on a phone capture).
function insetQuad(q, frac){
  const cx=(q[0].x+q[1].x+q[2].x+q[3].x)/4, cy=(q[0].y+q[1].y+q[2].y+q[3].y)/4;
  return q.map(p=>({ x:p.x+(cx-p.x)*frac, y:p.y+(cy-p.y)*frac }));
}

// ---- perspective correction (main-thread fallback) ----
// Thin wrapper: read the canvas pixels and hand them to the shared warpCore in
// scan-core.js (the same code the worker runs), then wrap the result back into
// an ImageData. The warp/filter math lives in ONE place now (scan-core.js).
function warpPerspective(srcCanvas, q, maxDim){
  const sctx=srcCanvas.getContext("2d",{willReadFrequently:true});
  const src=sctx.getImageData(0,0,srcCanvas.width,srcCanvas.height);
  const r=warpCore(src.data, src.width, src.height, q, maxDim);
  return new ImageData(r.data, r.w, r.h);
}

// keep the scanner layouts in step with rotation / window changes
window.addEventListener("resize", ()=>{
  if ($("scanCrop").classList.contains("show")) layoutCrop();
  // v11.31: only when the camera screen is actually on screen. layoutCrop was
  // already guarded this way; sizeQuadCanvas was not, so a resize raised while
  // the Adjust screen was up measured a hidden element and collapsed the
  // overlay. sizeQuadCanvas now refuses a zero size on its own, so this guard
  // is belt-and-braces rather than the only defence.
  if (scanStream && $("scanCam").classList.contains("show")) sizeQuadCanvas();
});

// ---------------- current page -> PNG (mupdf) ----------------
async function exportVisiblePng(){
  // pick the page most CENTRED in the viewport (matches the "Page x of n" pill),
  // so a tall page that's only partly scrolled into view isn't mistaken for its
  // neighbour the way a nearest-to-top test could.
  const v=$("viewer"), vr=v.getBoundingClientRect(), mid=vr.top+vr.height/2;
  let target=0, best=1e9;
  document.querySelectorAll(".stage").forEach(s=>{
    const r=s.getBoundingClientRect();
    const d=Math.abs((r.top+r.bottom)/2 - mid);
    if (d<best){ best=d; target=+s.dataset.page; }
  });
  showSpin(true,"Rendering page "+(target+1)+"…");
  try {
    const page = MDOC.loadPage(target);
    // v10.21: render at ~400 dpi (was ~300) for crisper text, but cap the long
    // side at 4096px so huge / image-sized pages don't exhaust memory. The
    // embedded scan is the real ceiling — rendering past it only upsamples.
    const [bx0,by0,bx1,by1] = page.getBounds();
    const longPt = Math.max(bx1-bx0, by1-by0) || 1;
    let pscale = 400/72;
    if (longPt*pscale > 4096) pscale = 4096/longPt;
    const pix = page.toPixmap(mupdf.Matrix.scale(pscale,pscale), mupdf.ColorSpace.DeviceRGB, false);
    const png = u8(pix.asPNG()); pix.destroy(); page.destroy();
    const ok = await saveOrShare(png, baseName()+"_p"+(target+1)+".png", "image/png");
    setStatus(ok ? "Picture ready — pick where to keep it." : "Save cancelled.","ok");
  } catch(err){ setStatus("Could not save the picture: "+friendly(err),"err"); }
  showSpin(false);
}

// ---------------- save ----------------
// Opens the Save / Share sheet. `after` (optional) runs only once the document
// has actually been saved/shared — used by the unsaved-changes dialog so that
// "Save first" then continues the action the user originally asked for.
function openSaveSheet(after){
  if (!workingBytes) return;
  $("sheet").innerHTML = h`
    <h3>Save / Share</h3>
    <div class="row"><input type="text" id="svName" autocomplete="off" spellcheck="false"></div>
    <p class="hint">Tap Save, then pick where it goes — for example "Save to Files", or share it straight into another app.</p>
    <div class="row"><button class="full" id="svGo">Save</button></div>
    <div class="row"><button class="ghost full" id="svCancel">Cancel</button></div>`;
  $("svName").value = baseName();
  $("svGo").onclick = async ()=>{
    const nm = safeFileName(($("svName").value.trim()||baseName()).replace(/\.pdf$/i,"")+".pdf");
    fileName = nm;
    closeSheet();
    const ok = await saveOrShare(workingBytes, nm);
    if (!ok){ setStatus("Save cancelled.","ok"); return; }   // share sheet dismissed
    setDirty(false);               // saved — nothing unsaved any more
    if (MDOC) setMeta(nm, fmtKB(workingBytes.length));
    schedulePersistDoc();
    recentsRemember();             // saved under its final name
    setStatus("Saved — now pick where to keep it (e.g. Save to Files).","ok");
    if (after) after();
  };
  $("svCancel").onclick = closeSheet;
  openSheet();
  setTimeout(()=>{ try{ $("svName").select(); }catch(e){} }, 100);
}
// ---- v11.64: name the file from what is written on it ----------------------
// "Scan 28 Jul 2026 13.29.pdf" tells you when you scanned it and nothing about
// what it is, which is why a folder of scans is unsearchable. The document
// usually names itself in its first few lines — an invoice says so, a report
// carries its title — so offer that instead.
//
// The heading is chosen the way a reader would: among the lines near the top,
// prefer the ones set LARGEST, and among those the first that reads like a
// title rather than a reference number or a date.
function looksLikeTitleLine(t){
  const s = String(t||"").trim();
  if (s.length < 4 || s.length > 70) return false;
  if (!/[A-Za-z]/.test(s)) return false;                  // pure numerals
  if (/^\d[\d\s\/.\-:]*$/.test(s)) return false;          // a date or a number
  if (/^(page|copy|original)\b/i.test(s)) return false;   // furniture
  const letters = (s.match(/[A-Za-z]/g)||[]).length;
  return letters >= s.length*0.45;                        // mostly words
}
function suggestNameFromText(){
  try {
    if (!MDOC || !MDOC.countPages()) return null;
    const page = MDOC.loadPage(0);
    const [x0,y0,x1,y1] = page.getBounds();
    const st = page.toStructuredText("preserve-spans");
    const lines = [];
    let cur = null;
    st.walk({
      beginLine(){ cur = { text:"", size:0, y:0 }; lines.push(cur); },
      onChar(c, origin, font, size){ if (!cur) return;
        cur.text += c;
        if (!cur.size){ cur.size = size||0; cur.y = origin ? origin[1] : 0; } },
    });
    st.destroy(); page.destroy();
    // only the top third of the page: a title lives there, a footer does not
    const cutY = y0 + (y1-y0)*0.34;
    const cands = lines
      .map(l=>({ t:l.text.replace(/\s+/g," ").trim(), size:l.size, y:l.y }))
      .filter(l=> l.y > 0 && l.y <= cutY && looksLikeTitleLine(l.t));
    if (!cands.length) return null;
    const biggest = Math.max(...cands.map(l=>l.size));
    const pick = cands.find(l=> l.size >= biggest*0.92) || cands[0];
    const name = safeFileName(pick.t).replace(/\.pdf$/i,"").slice(0, 60).trim();
    return name ? name + ".pdf" : null;
  } catch(e){ return null; }
}
// Does the current name carry no information? Only those get replaced without
// asking twice — a name the user typed is never second-guessed.
function nameIsAutomatic(n){
  return /^scan \d/i.test(n||"") || /^document\.pdf$/i.test(n||"")
      || /^(photos|images)\b/i.test(n||"");
}
$("saveBtn").onclick = ()=>{
  // v11.64: offer a name taken from the document itself, once, before the save
  // sheet. Only when the current name says nothing and the document has text
  // to read — a scan that has not been recognised has none, and is left alone.
  if (workingBytes && MDOC && nameIsAutomatic(fileName) && !nameSuggestShown){
    const s = suggestNameFromText();
    if (s && s.toLowerCase() !== String(fileName||"").toLowerCase()){
      nameSuggestShown = true;
      $("sheet").innerHTML = h`
        <h3>Name this file?</h3>
        <p class="hint">It is called “${fileName}”, which says when it was made but not what it is. The first heading on the page reads:</p>
        <div class="row"><input type="text" id="anIn" value="${s.replace(/\.pdf$/i,"")}"></div>
        <div class="row"><button class="full" id="anUse">Use this name</button></div>
        <div class="row"><button class="ghost full" id="anSkip">Keep “${fileName}”</button></div>`;
      $("anUse").onclick = ()=>{
        const v = safeFileName(String($("anIn").value||"").trim());
        closeSheet();
        if (v) fileName = v.replace(/\.pdf$/i,"") + ".pdf";
        setMeta(fileName, fmtKB(workingBytes.length));
        openSaveSheet();
      };
      $("anSkip").onclick = ()=>{ closeSheet(); openSaveSheet(); };
      openSheet();
      setTimeout(()=>{ try{ $("anIn").focus(); }catch(e){} }, 100);
      return;
    }
  }
  openSaveSheet();
};
let nameSuggestShown = false;   // asked once per document, not once per save

// ---------------- compress ----------------
// v11.36 changed what "compress" means here.
//
// The old pipeline had exactly two moves: a lossless structural pass (which
// shaves a few percent off a typical file and nothing at all off an
// already-optimised one), and rasterising every page to a picture (which hits
// any target but destroys selectable text). A document whose bulk is a few
// oversized images — a report with screenshots, a scan, an invoice with a logo
// — therefore had no useful option: you got 5%, or you got your text destroyed.
//
// What actually makes those files big is that the images inside them are
// stored at far higher resolution than they are ever drawn at. A 12-megapixel
// phone photo placed in a 5cm box carries roughly 25x the pixels that box can
// show. So images are now recompressed INDIVIDUALLY and in place, and
// everything else in the file — text, fonts, vectors, links, annotations, form
// fields, the page tree — is left byte-for-byte alone. That is what Acrobat and
// the online tools do, and it is why they shrink a text document by 70% while
// leaving its text perfectly selectable.
//
// Rasterisation still exists, demoted to what it always should have been: a
// last resort, reached only if the file is still over target afterwards.

// Per-level image policy. `dpi` is the resolution an image is reduced to,
// measured against the size it is actually DRAWN at, not against its pixel
// count. 200dpi is past what most eyes resolve in print, 150 is the usual
// "ebook" setting, and 110 is visibly softer but still readable.
const IMG_LEVELS = {
  high:   { dpi:200, q:82 },
  medium: { dpi:150, q:72 },
  low:    { dpi:110, q:56 },
  // v11.62: the level a freshly built scan is put through. It deliberately
  // keeps the RESOLUTION (300dpi, so nothing is thrown away) and spends the
  // saving on encoding instead. This is the half of Adobe's trick that is
  // reachable here: their scans are small because text is stored as a bilevel
  // layer, and this pass takes that route automatically whenever the page is
  // near black-and-white — the CCITT G4 encoder written for Compress does the
  // work, and a whitened document page usually qualifies.
  scan:   { dpi:300, q:68 },
};
// Re-encoding a JPEG is lossy, so doing it for a 3% gain spends real image
// quality on nothing. An object has to give back a tenth of itself to be worth
// rewriting, and must never grow.
const IMG_MIN_GAIN  = 0.10;
const IMG_MIN_BYTES = 6 * 1024;
// An image we could not measure — only referenced from an unused resource, or
// drawn inside an annotation appearance we do not walk — still gets a ceiling,
// so a stray 40-megapixel object cannot sit in the file untouched. Generous on
// purpose: with no placement to compare against, guessing low would damage
// something that might legitimately be full-page. A4 at 200dpi is 1654 x 2339.
const IMG_UNMEASURED_MAX = 2400;

const COMPRESS = {
  high:   { targetKB:1024, steps:[ {dpi:170,q:88}, {dpi:140,q:80}, {dpi:120,q:72} ] },
  medium: { targetKB:700,  steps:[ {dpi:150,q:72}, {dpi:120,q:62}, {dpi:100,q:52} ] },
  low:    { targetKB:200,  steps:[ {dpi:140,q:62}, {dpi:110,q:52}, {dpi:96,q:42},
                                   {dpi:84,q:34}, {dpi:72,q:28}, {dpi:60,q:22} ] },
};
$("compBtn").onclick = ()=>{
  if (!workingBytes) return;
  $("sheet").innerHTML = h`
    <h3>Compress</h3>
    <p class="hint">Pictures inside the document are reduced to a sensible resolution for the size they are printed at. Text, fonts and drawings are never touched, so the document stays selectable and searchable.</p>
    <div class="row"><button class="full stack" id="cpHigh">High quality — pictures at 200 dpi<span class="est" id="estHigh">estimating…</span></button></div>
    <div class="row"><button class="full stack" id="cpMed">Balanced — pictures at 150 dpi<span class="est" id="estMed">estimating…</span></button></div>
    <div class="row"><button class="full stack" id="cpLow">Smallest — pictures at 110 dpi<span class="est" id="estLow">estimating…</span></button></div>
    <div class="row"><button class="full" id="cpTarget">Reach a size… — e.g. under 2 MB for an upload</button></div>
    <div class="row"><button class="full" id="cpMrc">Scanned pages — much smaller, text redrawn</button></div>
    <div class="row"><button class="ghost full" id="cpCancel">Cancel</button></div>`;
  $("cpHigh").onclick = ()=>{ closeSheet(); runCompress("high"); };
  $("cpMed").onclick  = ()=>{ closeSheet(); runCompress("medium"); };
  $("cpLow").onclick  = ()=>{ closeSheet(); runCompress("low"); };
  $("cpTarget").onclick = ()=>{ openTargetSize(); };
  $("cpMrc").onclick  = ()=>{ closeSheet(); runMrcCompress(); };
  $("cpCancel").onclick = closeSheet;
  openSheet();
  showCompressEstimate();
};

// v11.92: fill the three level buttons in with what they would produce.
// Deliberately NOT blocking: the sheet opens immediately and the numbers
// arrive a moment later, because a sheet that cannot be used until an estimate
// finishes is worse than one with no estimate at all. Closing the sheet (or
// pressing a level before the numbers land) abandons the work at the next
// image — `isLive` is checked inside the loop.
let estToken = 0;
async function showCompressEstimate(){
  const token = ++estToken;
  const live = ()=> token === estToken && $("estHigh");
  const put = (id, text)=>{ const el = $(id); if (el) el.textContent = text; };
  const before = workingBytes ? workingBytes.length : 0;
  try {
    const r = await estimateCompressLevels(MDOC, before,
      ()=> new Promise(res=>setTimeout(res,0)), live);
    if (!live()) return;
    if (r.high === null){
      // Too large to estimate cheaply. Say so rather than showing nothing:
      // a button that silently never fills in reads as a bug.
      for (const id of ["estHigh","estMed","estLow"]) put(id, "");
      return;
    }
    put("estHigh", fmtEstimate(before, r.high));
    put("estMed",  fmtEstimate(before, r.medium));
    put("estLow",  fmtEstimate(before, r.low));
  } catch(e){
    if (!live()) return;
    for (const id of ["estHigh","estMed","estLow"]) put(id, "");
  }
}

// ---- v11.36: image geometry (pure) ---------------------------------------
// What pixel size should this image be reduced to, given the size it is drawn
// at? Returns null when it is already at or below target and must be left
// alone.
//   pxW/pxH         the image's own pixel dimensions
//   drawWpt/drawHpt the size it is DRAWN at on the page, in points (1/72 inch)
//   targetDpi       the resolution we want
// The 10% slack band stops a 158dpi image being re-encoded to reach 150dpi:
// that trades a real generation of JPEG loss for a saving nobody can see.
function imageTargetSize(pxW, pxH, drawWpt, drawHpt, targetDpi){
  if (!(pxW > 0) || !(pxH > 0) || !(targetDpi > 0)) return null;
  if (!(drawWpt > 0) || !(drawHpt > 0)){
    if (Math.max(pxW, pxH) <= IMG_UNMEASURED_MAX) return null;
    const s = IMG_UNMEASURED_MAX / Math.max(pxW, pxH);
    return { w: Math.max(1, Math.round(pxW*s)), h: Math.max(1, Math.round(pxH*s)) };
  }
  // Effective resolution on each axis; take the HIGHER, so an image squashed
  // on one axis is not over-reduced on the other.
  const eff = Math.max(pxW/(drawWpt/72), pxH/(drawHpt/72));
  if (!(eff > targetDpi * 1.10)) return null;
  const s = targetDpi / eff;
  return { w: Math.max(1, Math.round(pxW*s)), h: Math.max(1, Math.round(pxH*s)) };
}

// ---- v11.92: predicting a level's result, without performing it ----------
// Compress offers three levels and, until now, no way to tell what any of them
// would produce. You committed, looked, and undid. The estimate below turns
// that guess-and-undo loop into a decision.
//
// It is a PREDICTION, not a dry run: actually compressing three times to show
// three numbers would cost more than the compression itself. Instead a handful
// of the largest images are genuinely encoded — the expensive step, decoding
// the pixmap, is done once and shared by all three levels — and the rest of
// the document is scaled from the bytes-per-pixel those samples measured.
// Because a few big images carry nearly all of a PDF's weight, the sampled
// part is usually most of the answer and the extrapolated part is the tail.
//
// Rules mirrored from recompressImages, so an image the real pass would skip
// is predicted as unchanged rather than as a saving:
//   • under IMG_MIN_BYTES        — left alone
//   • already at a sensible dpi and already a JPEG — left alone
//   • predicted saving under IMG_MIN_GAIN — left alone
// Anything not mirrored can only make the real result SMALLER than predicted
// (the lossless structural pass, font subsetting, CCITT on bilevel images),
// which is the safe direction to be wrong in.
const EST_MAX_SAMPLES = 8;          // images actually encoded
const EST_MAX_PIXELS  = 40e6;       // source pixels decoded, hard ceiling
const EST_MAX_PAGES   = 60;         // above this the walk itself is the cost
const EST_MAX_BYTES   = 60*1024*1024;

// Placement lookup by pixel size only. measureImagePlacements keys on
// pixels:components:depth because it is handed a decoded image; here we have
// only a dictionary. Where two images share a pixel size the LARGEST placement
// wins, which matches the map's own rule and is the conservative direction —
// a larger placement means a higher dpi target, so less reduction.
function placementByDims(placements, pxW, pxH){
  if (!placements || !(pxW > 0) || !(pxH > 0)) return null;
  const prefix = pxW+":"+pxH+":";
  let best = null;
  for (const [k, v] of placements){
    if (k.indexOf(prefix) !== 0) continue;
    if (!best || v.wpt*v.hpt > best.wpt*best.hpt) best = v;
  }
  return best;
}

function predictImageBytes(rawLen, pxW, pxH, drawWpt, drawHpt, dpi, bpp, isJpeg){
  if (!(rawLen >= IMG_MIN_BYTES)) return rawLen;
  const t = imageTargetSize(pxW, pxH, drawWpt, drawHpt, dpi);
  if (!t && isJpeg) return rawLen;
  const tw = t ? t.w : pxW, th = t ? t.h : pxH;
  if (!(bpp > 0)) return rawLen;
  const pred = Math.round(bpp * tw * th);
  if (pred > rawLen * (1 - IMG_MIN_GAIN)) return rawLen;
  return pred;
}

// before  — the document's current size
// items   — one entry per image: { rawLen, after }
// Everything that is not an image stream is carried across untouched, which is
// exactly what the real pass does to it.
function predictTotal(before, items){
  let delta = 0;
  for (const it of items) delta += Math.max(0, it.rawLen - it.after);
  return Math.max(0, before - delta);
}

// Two significant figures, because the estimate does not have three. 2.43 MB
// reads as a measurement; "about 2.4 MB" reads as what it is.
function fmtEstimate(before, after){
  if (!(after > 0) || after >= before * 0.97) return "about the same size";
  const pct = Math.round(100*(1 - after/before));
  return "about " + (after >= 1048576 ? (after/1048576).toFixed(1)+" MB"
                                      : Math.round(after/1024)+" KB")
       + "  ·  " + pct + "% smaller";
}

// Area-average (box filter) downsample of raw pixmap bytes. Deliberately NOT
// canvas drawImage: the browser's scaler is bilinear, which on a large
// reduction samples a sparse subset of source pixels and turns small type into
// a shimmer. Averaging every source pixel that falls inside a destination cell
// is both the correct answer and visibly cleaner on text at 3-4x reductions.
function boxDownsample(src, sw, sh, sstride, n, tw, th){
  const out = new Uint8Array(tw*th*n);
  const acc = new Float32Array(n);
  for (let y=0; y<th; y++){
    const y0 = Math.floor(y*sh/th), y1 = Math.min(sh, Math.max(y0+1, Math.floor((y+1)*sh/th)));
    for (let x=0; x<tw; x++){
      const x0 = Math.floor(x*sw/tw), x1 = Math.min(sw, Math.max(x0+1, Math.floor((x+1)*sw/tw)));
      acc.fill(0);
      let cnt = 0;
      for (let sy=y0; sy<y1; sy++){
        const row = sy*sstride;
        for (let sx=x0; sx<x1; sx++){
          const i = row + sx*n;
          for (let c=0;c<n;c++) acc[c] += src[i+c];
          cnt++;
        }
      }
      const o = (y*tw + x)*n;
      if (cnt) for (let c=0;c<n;c++) out[o+c] = ((acc[c]/cnt) + 0.5)|0;
    }
  }
  return out;
}

// ---- v11.36: bilevel detection -------------------------------------------
// Some images are ALREADY black and white — a fax, a stamp, a signature, a line
// drawing, a page someone thresholded long before it reached us — but are
// stored as 8-bit grey or 24-bit colour, which is 8 to 24 times the data they
// actually carry. For those, CCITT Group 4 (the fax standard) beats JPEG by a
// wide margin: typically 5-15x smaller, and unlike JPEG it is EXACT, with none
// of the ringing that makes a JPEG of black text on white look dirty.
//
// The test below is deliberately severe, because this is only safe as a change
// of CONTAINER, not of appearance. An anti-aliased grey scan — which is what
// this app's own scanner produces — has a broad spread of mid-tones, fails the
// test, and stays a JPEG. Thresholding one of those would visibly wreck it.
function bilevelProfile(px, w, h, stride, n){
  if (n !== 1 && n !== 3 && n !== 4) return null;
  if (!(w > 0) || !(h > 0)) return null;
  let extreme = 0, dark = 0, total = 0, chroma = 0;
  const step = Math.max(1, Math.floor(Math.sqrt((w*h)/200000)) || 1);
  for (let y=0; y<h; y+=step){
    const row = y*stride;
    for (let x=0; x<w; x+=step){
      const i = row + x*n;
      let L, c = 0;
      if (n === 1) L = px[i];
      else {
        const r=px[i], g=px[i+1], b=px[i+2];
        L = (r*77 + g*151 + b*28) >> 8;
        c = Math.max(r,g,b) - Math.min(r,g,b);
      }
      chroma += c;
      if (L <= 40 || L >= 215) extreme++;
      if (L <= 40) dark++;
      total++;
    }
  }
  if (!total) return null;
  const extremeFrac = extreme/total, darkFrac = dark/total, meanChroma = chroma/total;
  return { extremeFrac, darkFrac, meanChroma,
    // Two-valued already, essentially grey, and carrying a plausible amount of
    // ink. The ink bounds exclude a solid black rectangle and a blank frame:
    // neither is a document, and JPEG handles both perfectly well.
    isBilevel: extremeFrac >= 0.995 && meanChroma <= 12
               && darkFrac >= 0.002 && darkFrac <= 0.45 };
}
// Flatten to one byte per pixel, 1 = white. That matches CCITT with BlackIs1
// false, and also DeviceGray, where sample 1 is white.
function toBilevelBits(px, w, h, stride, n, threshold){
  const bits = new Uint8Array(w*h);
  for (let y=0; y<h; y++){
    const row = y*stride, o = y*w;
    for (let x=0; x<w; x++){
      const i = row + x*n;
      const L = n === 1 ? px[i] : ((px[i]*77 + px[i+1]*151 + px[i+2]*28) >> 8);
      bits[o+x] = L >= threshold ? 1 : 0;
    }
  }
  return bits;
}

// --- T.4 modified-Huffman run-length codes, as bit strings. -----------------
// Written out as "0"/"1" text rather than packed hex on purpose: these tables
// are transcribed from ITU-T T.4, and a single wrong bit produces a file that
// decodes to plausible-looking garbage rather than an error. In this form each
// entry can be checked against the spec by eye — and the encoder as a whole is
// round-tripped through MuPDF's own CCITT decoder by the tests, on random
// bitmaps, which is what actually proves it.
const CCITT_WHITE_TERM = [
"00110101","000111","0111","1000","1011","1100","1110","1111","10011","10100",
"00111","01000","001000","000011","110100","110101","101010","101011","0100111","0001100",
"0001000","0010111","0000011","0000100","0101000","0101011","0010011","0100100","0011000","00000010",
"00000011","00011010","00011011","00010010","00010011","00010100","00010101","00010110","00010111","00101000",
"00101001","00101010","00101011","00101100","00101101","00000100","00000101","00001010","00001011","01010010",
"01010011","01010100","01010101","00100100","00100101","01011000","01011001","01011010","01011011","01001010",
"01001011","00110010","00110011","00110100"];
const CCITT_WHITE_MAKEUP = [
"11011","10010","010111","0110111","00110110","00110111","01100100","01100101","01101000","01100111",
"011001100","011001101","011010010","011010011","011010100","011010101","011010110","011010111","011011000","011011001",
"011011010","011011011","010011000","010011001","010011010","011000","010011011"];
const CCITT_BLACK_TERM = [
"0000110111","010","11","10","011","0011","0010","00011","000101","000100",
"0000100","0000101","0000111","00000100","00000111","000011000","0000010111","0000011000","0000001000","00001100111",
"00001101000","00001101100","00000110111","00000101000","00000010111","00000011000","000011001010","000011001011","000011001100","000011001101",
"000001101000","000001101001","000001101010","000001101011","000011010010","000011010011","000011010100","000011010101","000011010110","000011010111",
"000001101100","000001101101","000011011010","000011011011","000001010100","000001010101","000001010110","000001010111","000001100100","000001100101",
"000001010010","000001010011","000000100100","000000110111","000000111000","000000100111","000000101000","000001011000","000001011001","000000101011",
"000000101100","000001011010","000001100110","000001100111"];
const CCITT_BLACK_MAKEUP = [
"0000001111","000011001000","000011001001","000001011011","000000110011","000000110100","000000110101","0000001101100","0000001101101","0000001001010",
"0000001001011","0000001001100","0000001001101","0000001110010","0000001110011","0000001110100","0000001110101","0000001110110","0000001110111","0000001010010",
"0000001010011","0000001010100","0000001010101","0000001011010","0000001011011","0000001100100","0000001100101"];
// 1792..2560 in steps of 64, shared by both colours
const CCITT_EXT_MAKEUP = [
"00000001000","00000001100","00000001101","000000010010","000000010011","000000010100","000000010101",
"000000010110","000000010111","000000011100","000000011101","000000011110","000000011111"];
// vertical modes indexed by (a1-b1)+3: VL3 VL2 VL1 V0 VR1 VR2 VR3
const CCITT_VCODE = ["0000010","000010","010","1","011","000011","0000011"];

// Minimal MSB-first bit writer.
function ccittBitWriter(){
  return { bytes:[], cur:0, n:0,
    put(s){
      for (let i=0;i<s.length;i++){
        this.cur = (this.cur << 1) | (s.charCodeAt(i) === 49 ? 1 : 0);
        if (++this.n === 8){ this.bytes.push(this.cur); this.cur = 0; this.n = 0; }
      }
    },
    finish(){
      if (this.n) this.bytes.push((this.cur << (8 - this.n)) & 255);
      return new Uint8Array(this.bytes);
    } };
}
// One run of `len` pixels of a single colour: zero or more makeup codes then
// exactly one terminating code. Runs of 2624+ repeat the largest makeup code,
// which is what the spec requires for very wide images.
function ccittPutRun(bw, len, white){
  const term   = white ? CCITT_WHITE_TERM   : CCITT_BLACK_TERM;
  const makeup = white ? CCITT_WHITE_MAKEUP : CCITT_BLACK_MAKEUP;
  while (len >= 2624){ bw.put(CCITT_EXT_MAKEUP[12]); len -= 2560; }
  if (len >= 1792){
    const idx = (len - 1792) >> 6;
    bw.put(CCITT_EXT_MAKEUP[idx]); len -= 1792 + idx*64;
  } else if (len >= 64){
    const idx = (len >> 6) - 1;
    bw.put(makeup[idx]); len -= (idx+1)*64;
  }
  bw.put(term[len]);
}
// Changing elements of one row: the positions where a pixel differs from the
// one to its left, with an imaginary WHITE pixel before the row. Because of
// that imaginary pixel the elements strictly alternate in the colour they
// change TO: even index changes to black, odd index changes to white. All the
// b1/b2 lookups below are built on that parity, which is what keeps this
// readable — the alternative is re-reading pixel values at every step.
function ccittChanges(bits, off, w){
  const t = [];
  let prev = 1;
  for (let x=0; x<w; x++){ const v = bits[off+x]; if (v !== prev){ t.push(x); prev = v; } }
  return t;
}
// CCITT Group 4 (ITU-T T.6) encoder. `bits` is ONE BYTE PER PIXEL, 1 = white,
// row-major, w*h long. Returns the encoded bytes, EOFB included.
function ccittG4Encode(bits, w, h){
  const bw = ccittBitWriter();
  let ref = [];                                  // imaginary all-white line above row 0
  for (let y=0; y<h; y++){
    const cur = ccittChanges(bits, y*w, w);
    let a0 = -1, colour = 1;                     // start white, just left of the row
    let guard = 0;
    for (;;){
      if (++guard > 4*w + 32) throw new Error("ccitt: row did not terminate");
      // We want the next change TO the opposite of the current run colour.
      // white run -> next change to black -> even index; black run -> odd.
      const wantParity = colour === 1 ? 0 : 1;
      let a1 = w;
      for (let i=0;i<cur.length;i++)
        if (cur[i] > a0 && (i & 1) === wantParity){ a1 = cur[i]; break; }
      let b1 = w, b2 = w;
      for (let i=0;i<ref.length;i++)
        if (ref[i] > a0 && (i & 1) === wantParity){
          b1 = ref[i]; b2 = (i+1 < ref.length) ? ref[i+1] : w; break;
        }
      if (b2 < a1){
        bw.put("0001");                          // pass mode
        a0 = b2;
      } else if (Math.abs(a1 - b1) <= 3){
        bw.put(CCITT_VCODE[(a1 - b1) + 3]);      // vertical mode
        a0 = a1; colour = colour === 1 ? 0 : 1;
      } else {
        let a2 = w;
        for (let i=0;i<cur.length;i++) if (cur[i] > a1){ a2 = cur[i]; break; }
        bw.put("001");                           // horizontal mode: two runs
        const s = a0 < 0 ? 0 : a0;
        ccittPutRun(bw, a1 - s, colour === 1);
        ccittPutRun(bw, a2 - a1, colour !== 1);
        a0 = a2;                                 // colour is unchanged after a pair
      }
      if (a0 >= w) break;
    }
    ref = cur;
  }
  bw.put("000000000001000000000001");            // EOFB
  return bw.finish();
}

// ---- v11.36: walking the document for images ------------------------------
// Every image XObject reachable from a page, following Form XObjects too (a
// stamp, a logo placed through a form, an imported page all live there). Keyed
// by object number, so an image shared across twenty pages is handled once and
// every reference to it picks up the smaller version automatically.
function collectImageXObjects(pdf){
  const out = new Map();
  const seenForms = new Set();
  const walkRes = (res, depth)=>{
    if (!res || depth > 8) return;
    let xo = null;
    try { xo = res.get("XObject"); } catch(e){ return; }
    if (!xo || !xo.isDictionary || !xo.isDictionary()) return;
    xo.forEach((val)=>{
      try {
        if (!val || !val.isIndirect || !val.isIndirect()) return;
        const num = val.asIndirect();
        const sub = val.get("Subtype");
        const st = (sub && sub.isName && sub.isName()) ? sub.asName() : "";
        if (st === "Image"){ if (!out.has(num)) out.set(num, val); }
        else if (st === "Form"){
          if (seenForms.has(num)) return;        // guards recursive forms
          seenForms.add(num);
          walkRes(val.get("Resources"), depth+1);
        }
      } catch(e){}
    });
  };
  const n = pdf.countPages();
  for (let i=0;i<n;i++){
    let page = null;
    try { page = pdf.loadPage(i); walkRes(page.getObject().getInheritable("Resources"), 0); }
    catch(e){}
    finally { try{ if(page) page.destroy(); }catch(e){} }
  }
  return out;
}

// How big is each image actually DRAWN? This is the number the whole feature
// turns on, and it cannot be read off the image object: it lives in the
// content stream's transformation matrix. Rather than parse content streams,
// run each page through a render device that draws nothing and only notes the
// matrix it is handed. For an image the CTM maps the unit square onto the
// placed rectangle, so its column lengths ARE the drawn width and height in
// points.
//
// Images are keyed by their intrinsic shape (pixels, components, bit depth)
// because the device is handed a decoded image, not the object number it came
// from. Two DIFFERENT images that share all four properties therefore share an
// entry, and the largest placement wins — deliberately, because a larger
// placement means a higher DPI target, which means LESS reduction. A collision
// can only ever be conservative.
function measureImagePlacements(pdf){
  const max = new Map();
  const note = (image, ctm)=>{
    try {
      const key = image.getWidth()+":"+image.getHeight()+":"
                + image.getNumberOfComponents()+":"+image.getBitsPerComponent();
      const wpt = Math.hypot(ctm[0], ctm[1]), hpt = Math.hypot(ctm[2], ctm[3]);
      if (!(wpt > 0) || !(hpt > 0)) return;
      const prev = max.get(key);
      if (!prev || wpt*hpt > prev.wpt*prev.hpt) max.set(key, { wpt, hpt });
    } catch(e){}
  };
  const n = pdf.countPages();
  for (let i=0;i<n;i++){
    let page = null, dev = null;
    try {
      page = pdf.loadPage(i);
      dev = new mupdf.Device({
        fillImage:     (im, ctm)=> note(im, ctm),
        fillImageMask: (im, ctm)=> note(im, ctm),
        clipImageMask: (im, ctm)=> note(im, ctm),
      });
      page.run(dev, mupdf.Matrix.identity);
    } catch(e){
      // A page we cannot render leaves its images unmeasured, which the
      // IMG_UNMEASURED_MAX ceiling then handles conservatively. One bad page
      // must not abort the whole pass.
    } finally {
      try{ if(dev) dev.close(); }catch(e){}
      try{ if(dev) dev.destroy(); }catch(e){}
      try{ if(page) page.destroy(); }catch(e){}
    }
  }
  return max;
}

// Colour space name for a pixmap component count. Anything else is refused
// rather than guessed at.
function csNameFor(n){
  return n === 1 ? "DeviceGray" : n === 3 ? "DeviceRGB" : n === 4 ? "DeviceCMYK" : null;
}

// ---- v11.36: the recompression pass --------------------------------------
// Rewrites oversized image streams IN PLACE. Returns a small report so the
// status line can say something true about what happened.
async function recompressImages(pdf, level, onProgress){
  const cfg = IMG_LEVELS[level] || IMG_LEVELS.medium;
  const placements = measureImagePlacements(pdf);
  const imgs = collectImageXObjects(pdf);
  const rep = { total: imgs.size, changed: 0, bilevel: 0, before: 0, after: 0 };
  let idx = 0;
  for (const ref of imgs.values()){
    idx++;
    if (onProgress) await onProgress(idx, imgs.size);
    let im = null, pm = null;
    try {
      // A stencil mask is 1-bit by definition, already tiny, and JPEG cannot
      // represent it at all.
      const imask = ref.get("ImageMask");
      if (imask && imask.isBoolean && imask.isBoolean() && imask.asBoolean()) continue;
      // /JPXDecode is JPEG 2000. Round-tripping one through a pixmap can shift
      // colour, and they are rare enough not to be worth that risk.
      const filt = ref.get("Filter");
      const filtName = (filt && filt.isName && filt.isName()) ? filt.asName() : "";
      if (filtName === "JPXDecode") continue;

      const rawLen = ref.readRawStream().asUint8Array().length;
      if (rawLen < IMG_MIN_BYTES) continue;

      im = pdf.loadImage(ref);
      const pxW = im.getWidth(), pxH = im.getHeight();
      const key = pxW+":"+pxH+":"+im.getNumberOfComponents()+":"+im.getBitsPerComponent();
      const place = placements.get(key);
      const t = imageTargetSize(pxW, pxH, place ? place.wpt : 0, place ? place.hpt : 0, cfg.dpi);

      // Already at a sensible resolution. If it is also already a JPEG there is
      // nothing to gain and a generation of quality to lose, so leave it. If it
      // is stored uncompressed or Flate, re-encoding at FULL size is still a
      // large, one-generation win.
      //
      // v11.62 exception, for a scan the app has just built: there the JPEG is
      // OURS and was written at q92 to a generous budget, so re-encoding at the
      // same SIZE is a real saving rather than a pointless generation — a 308dpi
      // page came out at 2.73 MB. The 10% floor below still applies, so an image
      // that would barely shrink is left alone anyway.
      const recode = (level === "scan");
      if (!t && filtName === "DCTDecode" && !recode) continue;
      const tw = t ? t.w : pxW, th = t ? t.h : pxH;

      pm = im.toPixmap();
      // An alpha channel cannot survive a JPEG. Images with soft masks keep
      // their transparency in a separate /SMask object, which this pass leaves
      // alone; a pixmap that carries alpha directly is skipped outright.
      if (pm.getAlpha()) continue;
      const sw = pm.getWidth(), sh = pm.getHeight(), stride = pm.getStride();
      const n = pm.getNumberOfComponents();
      const csName = csNameFor(n);
      if (!csName) continue;
      const src = pm.getPixels();

      const prof = bilevelProfile(src, sw, sh, stride, n);
      const down = (tw === sw && th === sh && stride === sw*n)
        ? src.slice(0)
        : boxDownsample(src, sw, sh, stride, n, tw, th);

      // --- candidate A: JPEG ------------------------------------------------
      let bestBytes = null, bestFilter = null, bestParms = null, bestN = n, bestCs = csName;
      let out = null;
      try {
        out = new mupdf.Pixmap(
          n === 1 ? mupdf.ColorSpace.DeviceGray : n === 4 ? mupdf.ColorSpace.DeviceCMYK : mupdf.ColorSpace.DeviceRGB,
          [0, 0, tw, th], false);
        const dp = out.getPixels(), ds = out.getStride();
        for (let y=0; y<th; y++) dp.set(down.subarray(y*tw*n, (y+1)*tw*n), y*ds);
        const jpg = new Uint8Array(out.asJPEG(cfg.q));
        bestBytes = jpg; bestFilter = "DCTDecode"; bestParms = null;
      } catch(e){ bestBytes = null; }
      finally { try{ if(out) out.destroy(); }catch(e){} }

      // --- candidate B: CCITT G4, only for images that are ALREADY bilevel ---
      if (prof && prof.isBilevel){
        try {
          const bits = toBilevelBits(down, tw, th, tw*n, n, 128);
          const g4 = ccittG4Encode(bits, tw, th);
          if (!bestBytes || g4.length < bestBytes.length){
            bestBytes = g4; bestFilter = "CCITTFaxDecode"; bestParms = { K:-1, Columns:tw, Rows:th };
            bestN = 1; bestCs = "DeviceGray";
          }
        } catch(e){ /* keep the JPEG candidate */ }
      }

      if (!bestBytes) continue;
      // Never grow, and never spend a generation of quality on a token saving.
      if (bestBytes.length > rawLen * (1 - IMG_MIN_GAIN)) continue;

      ref.put("Width",  pdf.newInteger(tw));
      ref.put("Height", pdf.newInteger(th));
      ref.put("ColorSpace", pdf.newName(bestCs));
      ref.put("BitsPerComponent", pdf.newInteger(bestFilter === "CCITTFaxDecode" ? 1 : 8));
      ref.put("Filter", pdf.newName(bestFilter));
      // /Decode and the old /DecodeParms describe the OLD encoding. Leaving
      // either behind is how an image comes back inverted or unreadable.
      ref.delete("Decode");
      ref.delete("DecodeParms");
      if (bestParms){
        const dp2 = pdf.newDictionary();
        dp2.put("K", pdf.newInteger(bestParms.K));
        dp2.put("Columns", pdf.newInteger(bestParms.Columns));
        dp2.put("Rows", pdf.newInteger(bestParms.Rows));
        dp2.put("BlackIs1", pdf.newBoolean(false));
        ref.put("DecodeParms", dp2);
      }
      ref.writeRawStream(bestBytes);
      rep.changed++;
      rep.before += rawLen;
      rep.after  += bestBytes.length;
      if (bestFilter === "CCITTFaxDecode") rep.bilevel++;
    } catch(e){
      // One unreadable image must not abandon the other forty.
    } finally {
      try{ if(pm) pm.destroy(); }catch(e){}
      try{ if(im) im.destroy(); }catch(e){}
    }
  }
  return rep;
}

// v11.92: one read-only pass that answers all three levels at once.
// Nothing here mutates the document: it reads image streams, decodes a few of
// them, and encodes those few into throwaway buffers. Safe to run on MDOC.
async function estimateCompressLevels(pdf, before, onTick, isLive){
  const levels = ["high","medium","low"];
  const out = { high:null, medium:null, low:null, sampled:0, images:0 };
  if (!pdf || !(before > 0)) return out;
  if (before > EST_MAX_BYTES) return out;
  let pages = 0;
  try { pages = pdf.countPages(); } catch(e){ return out; }
  if (!(pages > 0) || pages > EST_MAX_PAGES) return out;

  const placements = measureImagePlacements(pdf);
  const imgs = collectImageXObjects(pdf);
  const items = [];
  for (const ref of imgs.values()){
    try {
      const imask = ref.get("ImageMask");
      if (imask && imask.isBoolean && imask.isBoolean() && imask.asBoolean()) continue;
      const filt = ref.get("Filter");
      const filtName = (filt && filt.isName && filt.isName()) ? filt.asName() : "";
      if (filtName === "JPXDecode") continue;
      const rawLen = ref.readRawStream().asUint8Array().length;
      if (rawLen < IMG_MIN_BYTES) continue;
      items.push({ ref, rawLen, isJpeg: filtName === "DCTDecode" });
    } catch(e){}
  }
  out.images = items.length;
  if (!items.length){
    for (const lv of levels) out[lv] = before;
    return out;
  }
  items.sort((a,b)=> b.rawLen - a.rawLen);

  // Sample the largest images. The pixmap — by far the expensive part — is
  // decoded ONCE and encoded at each level's dpi and quality, so three answers
  // cost barely more than one.
  const bpp = { high:0, medium:0, low:0 };
  const bppN = { high:0, medium:0, low:0 };
  let pixels = 0;
  for (let i=0; i<items.length && i<EST_MAX_SAMPLES && pixels < EST_MAX_PIXELS; i++){
    if (isLive && !isLive()) return out;
    const it = items[i];
    let im = null, pm = null;
    try {
      im = pdf.loadImage(it.ref);
      const pxW = im.getWidth(), pxH = im.getHeight();
      it.pxW = pxW; it.pxH = pxH;
      const key = pxW+":"+pxH+":"+im.getNumberOfComponents()+":"+im.getBitsPerComponent();
      const place = placements.get(key);
      it.wpt = place ? place.wpt : 0; it.hpt = place ? place.hpt : 0;
      pm = im.toPixmap();
      if (pm.getAlpha()) continue;
      const sw = pm.getWidth(), sh = pm.getHeight(), stride = pm.getStride();
      const n = pm.getNumberOfComponents();
      if (!csNameFor(n)) continue;
      pixels += sw*sh;
      const src = pm.getPixels();
      it.sampled = {};
      for (const lv of levels){
        const cfg = IMG_LEVELS[lv];
        const t = imageTargetSize(pxW, pxH, it.wpt, it.hpt, cfg.dpi);
        if (!t && it.isJpeg){ it.sampled[lv] = it.rawLen; continue; }
        const tw = t ? t.w : sw, th = t ? t.h : sh;
        const down = (tw === sw && th === sh && stride === sw*n)
          ? src : boxDownsample(src, sw, sh, stride, n, tw, th);
        let outPm = null, bytes = it.rawLen;
        try {
          outPm = new mupdf.Pixmap(
            n === 1 ? mupdf.ColorSpace.DeviceGray : n === 4 ? mupdf.ColorSpace.DeviceCMYK : mupdf.ColorSpace.DeviceRGB,
            [0,0,tw,th], false);
          const dp = outPm.getPixels(), ds = outPm.getStride();
          for (let y=0; y<th; y++) dp.set(down.subarray(y*tw*n, (y+1)*tw*n), y*ds);
          const jpg = new Uint8Array(outPm.asJPEG(cfg.q));
          bpp[lv] += jpg.length/(tw*th); bppN[lv]++;
          bytes = (jpg.length > it.rawLen*(1-IMG_MIN_GAIN)) ? it.rawLen : jpg.length;
        } catch(e){}
        finally { try{ if(outPm) outPm.destroy(); }catch(e){} }
        it.sampled[lv] = bytes;
      }
      out.sampled++;
    } catch(e){}
    finally {
      try{ if(pm) pm.destroy(); }catch(e){}
      try{ if(im) im.destroy(); }catch(e){}
    }
    if (onTick) await onTick();
  }
  for (const lv of levels) bpp[lv] = bppN[lv] ? bpp[lv]/bppN[lv] : 0;

  // The tail: images that were never decoded. Their pixel size is read from the
  // object dictionary, which is free, and their placement is looked up by those
  // dimensions — the placement map is keyed by pixels:components:depth and the
  // dictionary does not reliably give the last two (an ICCBased colour space
  // hides the component count), so the lookup matches on pixel size alone.
  //
  // Without this the tail was assumed unplaced, which sends it down the
  // IMG_UNMEASURED_MAX path and predicts NO reduction at all — an estimate of
  // 7.2 MB against an actual 2.6 MB on a fourteen-image document. Conservative
  // is not the same as useful.
  for (const it of items){
    if (it.sampled) continue;
    try {
      const w = it.ref.get("Width"), h = it.ref.get("Height");
      it.pxW = (w && w.isNumber && w.isNumber()) ? w.asNumber() : 0;
      it.pxH = (h && h.isNumber && h.isNumber()) ? h.asNumber() : 0;
      const pl = placementByDims(placements, it.pxW, it.pxH);
      it.wpt = pl ? pl.wpt : 0; it.hpt = pl ? pl.hpt : 0;
    } catch(e){ it.pxW = 0; it.pxH = 0; it.wpt = 0; it.hpt = 0; }
  }

  for (const lv of levels){
    const cfg = IMG_LEVELS[lv];
    const rows = items.map(it => ({
      rawLen: it.rawLen,
      after: it.sampled ? it.sampled[lv]
           : predictImageBytes(it.rawLen, it.pxW, it.pxH, it.wpt, it.hpt, cfg.dpi, bpp[lv], it.isJpeg)
    }));
    out[lv] = predictTotal(before, rows);
  }
  return out;
}

// Roughly how much real, extractable text the document has, sampled across the
// first few pages. A scanned / image-only PDF returns ~0; a born-digital text
// page returns hundreds. Used to protect text PDFs from being silently
// rasterised by Compress. Cheap: stops as soon as the threshold is reached.
// cached "does this document have real text?" — sampled once per epoch and
// reused by the render path (PNG vs JPEG choice) and compress
// v11.50: was this document's text put there by our own OCR? Cached per epoch
// like docHasText, and read from the document's own metadata so it survives a
// save and reopen. See the note in doOcr for why the render path needs it.
let docOcrEpoch = -1, docOcrVal = false;
function docIsOcr(){
  if (docOcrEpoch !== epoch){
    docOcrVal = false;
    try { docOcrVal = /PyPDF-OCR/.test(MDOC.getMetaData("info:Keywords") || ""); } catch(e){}
    docOcrEpoch = epoch;
  }
  return docOcrVal;
}
let docTextEpoch = -1, docTextVal = true;
function docHasText(){
  if (docTextEpoch !== epoch){
    try { docTextVal = sampledTextLength() >= 80; } catch(e){ docTextVal = true; }
    docTextEpoch = epoch;
  }
  return docTextVal;
}
function sampledTextLength(maxPages=8, stopAt=80){
  let chars=0;
  try {
    const n=MDOC.countPages(), sample=Math.min(n,maxPages);
    for (let i=0;i<sample;i++){
      const page=MDOC.loadPage(i);
      const st=page.toStructuredText("preserve-spans");
      st.walk({ onChar(c){ if (c && c.trim()) chars++; } });
      st.destroy(); page.destroy();
      if (chars>=stopAt) break;
    }
  } catch(e){}
  return chars;
}
// Asked before rasterising a document that contains real text. Resolves:
//   false → keep the text-safe result;  true → rasterise to pictures;
//   null  → cancel the whole operation.
function confirmRasterise(before, losslessLen){
  return new Promise(resolve=>{
    $("sheet").innerHTML = h`
      <h3>This PDF contains real text</h3>
      <p class="hint">The pictures inside it have already been reduced as far as this setting allows — that version is ${fmtKB(losslessLen)} (from ${fmtKB(before)}) and its text is still selectable. Going smaller means turning every page into a picture, after which the text can no longer be selected, searched or read aloud.</p>
      <div class="row"><button class="full" id="crKeep">Keep text · ${fmtKB(losslessLen)}</button></div>
      <div class="row"><button class="full" id="crGo">Make smallest (as pictures)</button></div>
      <div class="row"><button class="ghost full" id="crCancel">Cancel</button></div>`;
    let settled=false;
    const done=v=>{ if(settled) return; settled=true; sheetOnDismiss=null; closeSheet(); resolve(v); };
    $("crKeep").onclick = ()=> done(false);
    $("crGo").onclick   = ()=> done(true);
    $("crCancel").onclick= ()=> done(null);
    openSheet();
    sheetOnDismiss = ()=> done(null);   // backdrop / Esc = cancel
  });
}
// ---- v11.68: MRC (mixed raster content) for scanned pages -----------------
// A scanned page is one big JPEG, so every pixel costs the same whether it is
// a letter or a photograph. MRC splits the page in two:
//
//   stencil     1-bit, full resolution, CCITT G4  — the TEXT, and only the text
//   background  colour at a third of that         — everything else
//
// Text keeps sharp 300dpi edges for a few KB; photographs and paper texture,
// where softening is invisible, are stored small. This is the route the paid
// scanners take to small files.
//
// Two rules were learned the hard way on corpus/USER-hq-scan.pdf, and both
// cost a rebuild when I guessed instead of measuring:
//
//  1. A picture is a REGION, not a pixel. Classifying pixel-by-pixel let
//     scattered dark pixels inside an endoscopy photograph into the stencil,
//     where they painted solid black speckle across the image.
//  2. Ink fraction cannot separate text from pictures. A block sitting inside
//     a bold stroke measures 1.0 — higher than any photographic block. Colour
//     and solid mid-tone content can: measured on that file, text blocks run
//     chroma 0–10, photographic blocks 98–164.
//
// The per-pixel test that survived is the opposite one: ink that is COLOURFUL
// stays in the background, because the stencil can only paint a single colour
// and a navy logo rendered black is a visible loss.
const MRC = {
  // v11.73: 300 -> 400. At 300dpi the 6pt print on a lab report is only a
  // couple of pixels per stroke, so binarising it merged letters — "Total"
  // came out as "Totaf". Compared against a 24MP phone photo of the same page
  // (414dpi of real detail), 400dpi is where the letters separate again; 500
  // cost another 100KB for no visible gain, since the capture is downsampled to
  // 3200px (~387dpi) anyway.
  DPI: 400,          // stencil resolution
  BG_DIV: 3,         // background is a third of that => 100dpi
  // v11.72: 58 -> 68. Grey fills now stay in the background instead of being
  // binarised into the stencil, so this layer carries more of what the page
  // actually looks like and is worth spending on. Measured: the endoscopy scan
  // goes 258KB -> 293KB, still 93% below the 3,965KB original. Going further
  // (a 2.5x background instead of 3x) cost +47% for no visible gain on a
  // text-dominant page, so it stopped here.
  BG_Q: 68,          // background JPEG quality
  BLK: 16,           // classification block, pixels at DPI
  // v11.73: 18 -> 26, and the reach 2 -> 1. Together these were fattening every
  // stroke by up to two pixels a side, which on 6pt print is more than the
  // stroke itself — the cause of the blobbed, merged letters.
  DARK: 26,          // soft threshold: darker than local paper by this
  CORE_FRAC: 0.60,   // hard threshold: below this SHARE of local paper => real ink
  CORE_NEAR: 1,      // a soft pixel joins the stencil only this close to core ink
  CHROMA_PICT: 40,   // block mean chroma above this => pictorial
  MID_PICT: 0.30,    // block solid mid-tone fraction above this => pictorial
  INK_CHROMA: 60,    // ink more colourful than this is left to the background
  MIN_GAIN: 0.15,    // must save at least this share to be worth using
  MAX_PX: 26e6,      // memory guard. A4@400 is 15.5MP; A3@400 would refuse.
  MAX_PICT: 0.70,    // mostly picture => MRC is the wrong tool, refuse
};
// Separable box blur. Uint8 in, Uint8 out, one Float32 scratch buffer — the
// full-page Float32 arrays this replaced cost ~150MB on an A4 page at 300dpi,
// which is not survivable on a phone.
// v11.73: the scratch buffer is Uint8, not Float32. At 400dpi an A4 page is
// 15.5M pixels, so a Float32 intermediate is 62MB on its own — on top of the
// eight byte-per-pixel masks this pass already holds. Rounding the horizontal
// means to whole levels costs about half a grey level, which is nothing against
// thresholds of 26 and 0.6x, and takes the scratch to 15MB.
function mrcBoxBlur(a, w, h, r){
  const t = new Uint8Array(w*h), o = new Uint8Array(w*h), d = 2*r+1;
  for (let y=0; y<h; y++){
    let s = 0;
    for (let x=-r; x<=r; x++) s += a[y*w + Math.min(w-1, Math.max(0, x))];
    for (let x=0; x<w; x++){
      t[y*w+x] = s/d;
      s -= a[y*w + Math.min(w-1, Math.max(0, x-r))];
      s += a[y*w + Math.min(w-1, Math.max(0, x+r+1))];
    }
  }
  for (let x=0; x<w; x++){
    let s = 0;
    for (let y=-r; y<=r; y++) s += t[Math.min(h-1, Math.max(0, y))*w + x];
    for (let y=0; y<h; y++){
      o[y*w+x] = s/d + 0.5;
      s -= t[Math.min(h-1, Math.max(0, y-r))*w + x];
      s += t[Math.min(h-1, Math.max(0, y+r+1))*w + x];
    }
  }
  return o;
}
// Split a rendered page into stencil and background.
// Returns { bits, paper, ink, pict, gx, gy } where bits is one BYTE per pixel
// (1 = paper, 0 = ink) — the layout ccittG4Encode expects. Feeding it a packed
// bitmap instead produces a stream that decodes for a few hundred rows and
// then tears into stripes, which is exactly what happened the first time.
function mrcSegment(px, w, h, stride, n, cfg){
  cfg = cfg || MRC;
  const N = w*h;
  const gray = new Uint8Array(N);
  for (let y=0; y<h; y++)
    for (let x=0; x<w; x++){
      const i = y*stride + x*n;
      gray[y*w+x] = n === 1 ? px[i] : ((px[i]*77 + px[i+1]*151 + px[i+2]*28) >> 8);
    }
  // local paper level, so a shadowed corner is not read as ink
  const paper = mrcBoxBlur(gray, w, h, Math.max(4, Math.round(Math.max(w,h)*0.015)));
  // v11.72: TWO ink thresholds, not one.
  //
  // A single "darker than local paper by 18" test cannot tell real ink from a
  // light grey fill. On a real lab report the 20%-grey band behind the header
  // sits about 45 below paper, so every pixel of it qualified — and because a
  // screened band is a halftone pattern plus sensor noise rather than a flat
  // tone, 37% of it crossed the line and got painted solid black by the
  // stencil. That is the "blackish hue" and the harshness: a grey band came
  // back as a mottled black smear, and its real tone was gone, because the
  // background had it lifted to paper.
  //
  //   core  gray is below 60% of local paper  -> unambiguously ink
  //   soft  gray is 18 below local paper      -> ink OR a grey fill OR noise
  //
  // Soft pixels join the stencil only within CORE_NEAR of a core pixel, so a
  // glyph keeps its anti-aliased edge while a grey fill — which contains no
  // core ink at all — stays in the background and keeps its actual tone.
  let core = new Uint8Array(N);
  const soft = new Uint8Array(N), midF = new Uint8Array(N);
  for (let i=0; i<N; i++){
    const p = Math.max(1, paper[i]);
    soft[i] = gray[i] < p - cfg.DARK ? 1 : 0;
    core[i] = gray[i] < p * cfg.CORE_FRAC ? 255 : 0;
    const v = gray[i]/p;
    midF[i] = (v > 0.35 && v < 0.80) ? 255 : 0;
  }
  // v11.73: `dark` is written back over `soft` and the temporaries are dropped
  // as soon as they are spent. At 400dpi each of these masks is 15.5MB, so
  // holding all of them to the end of the function is ~120MB on a phone.
  let coreNear = mrcBoxBlur(core, w, h, cfg.CORE_NEAR);
  const dark = soft;                       // same buffer, refined in place
  for (let i=0; i<N; i++) dark[i] = (dark[i] && coreNear[i] > 0) ? 1 : 0;
  coreNear = null; core = null;
  // A bold glyph is ringed by anti-aliased mid-tones, so counting mid-tone
  // pixels alone reads headings as pictures. Keep only mid-tones sitting
  // INSIDE a mid-tone neighbourhood: photo interiors survive, glyph rims do not.
  const midN = mrcBoxBlur(midF, w, h, 4);
  const BLK = cfg.BLK, gx = Math.ceil(w/BLK), gy = Math.ceil(h/BLK), G = gx*gy;
  const chr = new Float32Array(G), mid = new Float32Array(G), cnt = new Float32Array(G);
  for (let y=0; y<h; y++)
    for (let x=0; x<w; x++){
      const g = ((y/BLK)|0)*gx + ((x/BLK)|0), i = y*stride + x*n, k = y*w + x;
      const c = n === 1 ? 0
        : Math.max(px[i],px[i+1],px[i+2]) - Math.min(px[i],px[i+1],px[i+2]);
      chr[g] += c;
      mid[g] += (midF[k] && midN[k] > 128) ? 1 : 0;
      cnt[g]++;
    }
  const seed = new Uint8Array(G);
  for (let g=0; g<G; g++)
    if (cnt[g]) seed[g] = (chr[g]/cnt[g] > cfg.CHROMA_PICT || mid[g]/cnt[g] > cfg.MID_PICT) ? 1 : 0;
  const nb = (m, x, y)=>{
    let c = 0;
    for (let dy=-1; dy<=1; dy++)
      for (let dx=-1; dx<=1; dx++){
        if (!dx && !dy) continue;
        const ny = y+dy, nx = x+dx;
        if (ny>=0 && ny<gy && nx>=0 && nx<gx && m[ny*gx+nx]) c++;
      }
    return c;
  };
  // opening: a lone pictorial block among text is a false positive, drop it…
  const kept = new Uint8Array(G);
  for (let y=0; y<gy; y++)
    for (let x=0; x<gx; x++) kept[y*gx+x] = (seed[y*gx+x] && nb(seed,x,y) >= 3) ? 1 : 0;
  // …then grow by one block so photo edges and their halos are fully covered
  const pict = new Uint8Array(G);
  for (let y=0; y<gy; y++)
    for (let x=0; x<gx; x++) pict[y*gx+x] = (kept[y*gx+x] || nb(kept,x,y) > 0) ? 1 : 0;

  const bits = new Uint8Array(N).fill(1);
  let ink = 0, toneSum = 0, toneN = 0;
  for (let y=0; y<h; y++)
    for (let x=0; x<w; x++){
      const k = y*w+x;
      if (!dark[k]) continue;
      if (pict[((y/BLK)|0)*gx + ((x/BLK)|0)]) continue;
      if (n > 1){
        const i = y*stride + x*n;
        const c = Math.max(px[i],px[i+1],px[i+2]) - Math.min(px[i],px[i+1],px[i+2]);
        if (c >= cfg.INK_CHROMA) continue;     // coloured ink keeps its colour
      }
      bits[k] = 0; ink++;
      toneSum += gray[k]; toneN++;
    }
  // v11.72: what colour the stencil should paint. It used to be pure black,
  // but scanned ink is not pure black — on these reports the core of a stroke
  // measures around 40-60 — so every letter came back harder than the document
  // actually is. Painting the page's own measured ink tone keeps the text
  // crisp without that laser-print harshness. Clamped so a faint scan cannot
  // wash the text out.
  const tone = toneN ? Math.max(0, Math.min(70, Math.round(toneSum/toneN))) : 0;
  return { bits, paper, ink, pict, gx, gy, tone };
}
// Build one MRC page into `out`. Returns false if the page could not be done,
// in which case the caller must fall back rather than ship a broken page.
function mrcAddPage(out, srcPage, cfg){
  cfg = cfg || MRC;
  let pix = null, bpm = null;
  try {
    const [x0,y0,x1,y1] = srcPage.getBounds();
    const PW = x1-x0, PH = y1-y0;
    if (!(PW > 1 && PH > 1)) return false;
    const s = cfg.DPI/72;
    if (PW*s*PH*s > cfg.MAX_PX) return false;
    pix = srcPage.toPixmap(mupdf.Matrix.scale(s,s), mupdf.ColorSpace.DeviceRGB, false);
    const w = pix.getWidth(), h = pix.getHeight();
    const st = pix.getStride(), n = pix.getNumberOfComponents(), px = pix.getPixels();
    const seg = mrcSegment(px, w, h, st, n, cfg);
    // A page that is mostly photograph is the one case where MRC HURTS: there
    // is little text to sharpen and the whole picture would be stored at a
    // third of its resolution. Size alone would not catch that — the file gets
    // smaller while the page gets worse — so refuse and let the ordinary image
    // pass handle it, which keeps full resolution.
    let pictBlocks = 0;
    for (let g=0; g<seg.pict.length; g++) pictBlocks += seg.pict[g];
    if (pictBlocks / seg.pict.length > cfg.MAX_PICT) return false;
    const g4 = ccittG4Encode(seg.bits, w, h);

    // Lift stencil pixels to the local paper level IN THE PIXMAP, so the ink is
    // not stored a second time in the background (and does not bleed when the
    // background is downsampled). Done in place to avoid a second full-page
    // buffer.
    for (let y=0; y<h; y++)
      for (let x=0; x<w; x++){
        if (seg.bits[y*w+x]) continue;
        const i = y*st + x*n, v = seg.paper[y*w+x];
        for (let c=0; c<n; c++) px[i+c] = v;
      }
    const bw = Math.max(1, Math.round(w/cfg.BG_DIV)), bh = Math.max(1, Math.round(h/cfg.BG_DIV));
    const small = boxDownsample(px, w, h, st, n, bw, bh);
    bpm = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0,0,bw,bh], false);
    const dp = bpm.getPixels(), ds = bpm.getStride();
    for (let y=0; y<bh; y++) dp.set(small.subarray(y*bw*n, (y+1)*bw*n), y*ds);
    const bg = u8(bpm.asJPEG(cfg.BG_Q));

    const D = (pairs)=>{ const o = out.newDictionary(); for (const [k,v] of pairs) o.put(k,v); return o; };
    const NI = v=>out.newInteger(v), NN = v=>out.newName(v), NB = v=>out.newBoolean(v);
    const bgObj = out.addRawStream(bg, D([
      ["Type",NN("XObject")], ["Subtype",NN("Image")], ["Width",NI(bw)], ["Height",NI(bh)],
      ["ColorSpace",NN("DeviceRGB")], ["BitsPerComponent",NI(8)], ["Filter",NN("DCTDecode")]]));
    // ImageMask + Decode [0 1]: a 0 bit paints, a 1 bit leaves the page alone.
    const mkObj = out.addRawStream(g4, D([
      ["Type",NN("XObject")], ["Subtype",NN("Image")], ["Width",NI(w)], ["Height",NI(h)],
      ["ImageMask",NB(true)], ["BitsPerComponent",NI(1)], ["Filter",NN("CCITTFaxDecode")],
      ["DecodeParms", D([["K",NI(-1)],["Columns",NI(w)],["Rows",NI(h)],["BlackIs1",NB(false)]])]]));
    const xo = out.newDictionary(); xo.put("Bg", bgObj); xo.put("Mk", mkObj);
    const res = out.newDictionary(); res.put("XObject", xo);
    // the stencil is painted in the page's own ink tone, not pure black
    const gTone = ((seg.tone || 0)/255).toFixed(3);
    const content = "q "+PW+" 0 0 "+PH+" 0 0 cm /Bg Do Q\n"
                  + "q "+gTone+" g "+PW+" 0 0 "+PH+" 0 0 cm /Mk Do Q\n";
    out.insertPage(-1, out.addPage([0,0,PW,PH], 0, res, content));
    return true;
  } catch(e){ return false; }
  finally {
    try{ if(bpm) bpm.destroy(); }catch(e){}
    try{ if(pix) pix.destroy(); }catch(e){}
  }
}
// Rebuild a whole document as MRC. Returns null — never a partial or larger
// document — if anything is unsuitable, so the caller keeps what it had.
//
// MRC rasterises, so a page carrying real text is refused outright: turning
// selectable text into a picture would silently break search, copy and the
// text editor. That makes this safe for freshly built scans and for
// image-only pages, and a no-op everywhere else.
function mrcRebuild(bytes, onProgress){
  let src = null, out = null;
  try {
    src = mupdf.Document.openDocument(bytes.slice(0), "application/pdf").asPDF();
    if (!src) return null;
    const n = src.countPages();
    if (!n) return null;
    out = new mupdf.PDFDocument();
    for (let i=0; i<n; i++){
      if (onProgress) onProgress(i, n);
      let p = null;
      try {
        p = src.loadPage(i);
        let chars = 0;
        try {
          const stx = p.toStructuredText("preserve-spans");
          stx.walk({ onChar(ch){ if (ch && ch.trim()) chars++; } });
          stx.destroy();
        } catch(e){ chars = 0; }
        if (chars > 0) return null;                 // real text: do not rasterise
        if (!mrcAddPage(out, p, MRC)) return null;
      } finally { try{ if(p) p.destroy(); }catch(e){} }
    }
    const res = u8(out.saveToBuffer("compress,garbage").asUint8Array());
    if (!res.length || res.length >= bytes.length*(1-MRC.MIN_GAIN)) return null;
    return res;
  } catch(e){ return null; }
  finally {
    try{ if(out) out.destroy(); }catch(e){}
    try{ if(src) src.destroy(); }catch(e){}
  }
}
// ---- v11.46 (Phase 4): compress to a TARGET SIZE ---------------------------
// "Get it under 2 MB for the portal" is the iLovePDF feature people actually
// use. The search is over the machinery that already exists, most-careful
// first: lossless pass, then per-image recompression at high → medium → low,
// stopping at the first result that meets the target. Rasterising remains a
// last resort that asks first when the document has real text.
function openTargetSize(){
  const cur = workingBytes.length;
  $("sheet").innerHTML = h`
    <h3>Compress to a size</h3>
    <p class="hint">Currently ${fmtKB(cur)}. Pick a limit — the gentlest setting that fits is used, so quality is never given up without need.</p>
    <div class="row teseg" id="tsPre">
      <button class="segb" data-mb="10">10 MB</button>
      <button class="segb" data-mb="5">5 MB</button>
      <button class="segb" data-mb="2">2 MB</button>
      <button class="segb" data-mb="1">1 MB</button>
    </div>
    <div class="row"><input type="number" id="tsIn" min="0.1" step="0.1" inputmode="decimal" placeholder="or type a size in MB"></div>
    <div class="row"><button class="full" id="tsGo">Compress</button></div>
    <div class="row"><button class="ghost full" id="tsCancel">Cancel</button></div>`;
  const go = mb=>{
    if (!(mb > 0)) return;
    if (mb*1024*1024 >= cur){
      setStatus("It is already under "+mb+" MB ("+fmtKB(cur)+") — nothing to do.","ok");
      closeSheet(); return;
    }
    closeSheet(); runCompressToTarget(Math.round(mb*1024));
  };
  $("tsPre").querySelectorAll("[data-mb]").forEach(b=> b.onclick = ()=> go(+b.dataset.mb));
  $("tsGo").onclick = ()=> go(parseFloat($("tsIn").value));
  $("tsIn").onkeydown = e=>{ if (e.key==="Enter"){ e.preventDefault(); go(parseFloat($("tsIn").value)); } };
  $("tsCancel").onclick = closeSheet;
  openSheet();
  setTimeout(()=>{ try{ $("tsIn").focus(); }catch(e){} }, 100);
}
async function runCompressToTarget(targetKB){
  const before = workingBytes.length, target = targetKB*1024;
  showSpin(true,"Compressing…");
  try {
    // 1) lossless structural pass (with font subsetting)
    let best = u8(MDOC.saveToBuffer("compress,compress-images,compress-fonts,subset-fonts,garbage").asUint8Array());
    let bestLen = best.length, how = "lossless clean-up only", rasterised = false;
    // 2) per-image recompression, gentlest level first, stop when it fits
    if (bestLen > target){
      for (const level of ["high","medium","low"]){
        showSpin(true,"Compressing… trying "+(level==="high"?"200":level==="medium"?"150":"110")+" dpi pictures");
        let work = null;
        try {
          work = mupdf.Document.openDocument(workingBytes.slice(0), "application/pdf").asPDF();
          const rep = await recompressImages(work, level, async (i,n)=>{
            showSpin(true,"Compressing… picture "+i+" of "+n);
            await new Promise(r=>setTimeout(r,0));
          });
          if (rep && rep.changed){
            const cand = u8(work.saveToBuffer("compress,compress-fonts,subset-fonts,garbage").asUint8Array());
            if (cand.length < bestLen){
              best = cand; bestLen = cand.length;
              how = rep.changed+" picture"+(rep.changed>1?"s":"")+" reduced ("
                  + (level==="high"?"200":level==="medium"?"150":"110")+" dpi"
                  + (rep.bilevel ? ", "+rep.bilevel+" stored black-and-white" : "")+")";
            }
          }
        } catch(e){}
        finally { try{ if(work) work.destroy(); }catch(e){} }
        if (bestLen <= target) break;
      }
    }
    // 3) still over target: rasterising is the only move left. Ask when the
    //    document has real text; scans rasterise freely.
    if (bestLen > target){
      const rasterAll = async ()=>{
        for (const step of COMPRESS.low.steps){
          const bytes = await rasterize(step.dpi, step.q);
          if (bytes.length < bestLen){ best=bytes; bestLen=bytes.length; rasterised=true; }
          if (bytes.length <= target) break;
        }
        if (rasterised) how = "pages turned into pictures to reach the size";
      };
      if (sampledTextLength() >= 80){
        showSpin(false);
        const choice = await confirmRasterise(before, bestLen);
        if (choice === null){ setStatus("Compression cancelled.","warn"); return; }
        showSpin(true,"Compressing…");
        if (choice === true) await rasterAll();
      } else await rasterAll();
    }
    if (bestLen >= before){
      showSpin(false);
      setStatus("Already about as small as it usefully gets — "+fmtKB(before)+" left unchanged.","ok");
      return;
    }
    const undoKept = pushUndoGuarded();
    workingBytes = best instanceof Uint8Array ? best : new Uint8Array(best);
    reopen(); await render();
    showSpin(false);
    showCompressReport(before, bestLen, target, how, rasterised, undoKept);
  } catch(err){ setStatus("Could not compress: "+friendly(err),"err"); }
  showSpin(false);
}
// The before/after report — what changed, whether the target was met, and what
// was NOT touched. Shown for target-size compression, where "did it fit?" is
// the whole question.
function showCompressReport(before, after, target, how, rasterised, undoKept){
  const met = after <= target;
  const pct = Math.round(100*(1-after/before));
  $("sheet").innerHTML = h`
    <h3>${met ? "Done — it fits" : "As close as it gets"}</h3>
    <div class="about">
      <div class="abrow"><span>Before</span><b>${fmtKB(before)}</b></div>
      <div class="abrow"><span>After</span><b>${fmtKB(after)} (${pct}% smaller)</b></div>
      <div class="abrow"><span>Limit</span><b>${fmtKB(target)} — ${met ? "met" : "not reachable"}</b></div>
      <div class="abrow"><span>What changed</span><b>${how}</b></div>
      <div class="abrow"><span>Text</span><b>${rasterised ? "now pictures — no longer selectable" : "untouched — still selectable and searchable"}</b></div>
    </div>
    ${raw(met ? "" : '<p class="hint mt8">Below this the document stops being readable. If the limit is a hard one, try removing pages you don’t need first (All pages → Select → Delete).</p>')}
    ${raw(undoKept ? "" : '<p class="hint mt8">Too large to keep an undo step for this.</p>')}
    <div class="row mt8"><button class="full" id="crOk">OK</button></div>`;
  $("crOk").onclick = closeSheet;
  openSheet();
  setStatus("Compressed: "+fmtKB(before)+" → "+fmtKB(after)+"."+(undoKept?" Undo reverses it.":""), met?"ok":"warn");
}

// v11.74: MRC is now something you ASK for, not something done to every scan.
//
// It is the biggest saving the app can make on a photographed document — 90%
// and more — but it rebuilds the text as a 1-bit stencil, and on small print
// that is a visible change, not a free one. Automatic compression of a fresh
// scan is exactly what made the scanner worse than v11.31, so this sits under
// Compress, states its cost before running, and leaves the result on screen
// with Undo available.
async function runMrcCompress(){
  if (!workingBytes) return;
  const before = workingBytes.length;
  showSpin(true,"Rebuilding scanned pages…");
  let out = null;
  try {
    await new Promise(r=>setTimeout(r,0));       // let the spinner paint first
    out = mrcRebuild(workingBytes, (i,n)=> showSpin(true,"Rebuilding page "+(i+1)+" of "+n+"…"));
  } catch(e){ out = null; }
  showSpin(false);
  if (!out){
    setStatus("This document is not a photographed scan — its pages carry real text, "
            + "or they are mostly picture. Nothing was changed; try the picture options instead.","warn");
    return;
  }
  pushUndo();
  workingBytes = out;
  reopen(); setDirty(true); await render();
  setStatus("Scanned pages rebuilt — "+fmtKB(before)+" to "+fmtKB(out.length)
          + " ("+Math.round(100 - 100*out.length/before)+"% smaller). "
          + "Text is redrawn sharp at 400 dpi; check the small print, and Undo if you would rather keep the original.","ok");
}
async function runCompress(level){
  const cfg=COMPRESS[level], before=workingBytes.length;
  showSpin(true,"Compressing…");
  let imgRep = null;
  try {
    // 1) Lossless structural pass. Cheap, safe, and on some files enough on its
    //    own. It does not mutate MDOC or workingBytes, so we can still decide
    //    what to do before committing — and before taking the Undo snapshot,
    //    which keeps peak memory down.
    // v11.46: subset-fonts joined the pass — embedded fonts are trimmed to the
    // glyphs the document actually uses. A no-op on already-subset fonts
    // (verified byte-identical), a real win on full embedded fonts.
    let best = u8(MDOC.saveToBuffer("compress,compress-images,compress-fonts,subset-fonts,garbage").asUint8Array());
    let bestLen = best.length;
    let rasterised = false;

    // 2) v11.36: per-image recompression. This is the step that does the real
    //    work on the files people actually want to shrink, and it keeps every
    //    piece of text, every font and every vector exactly as it was.
    //    It runs on a SEPARATE copy of the document: if anything goes wrong the
    //    lossless result from step 1 is still there, untouched.
    if (bestLen > cfg.targetKB*1024){
      let work = null;
      try {
        work = mupdf.Document.openDocument(workingBytes.slice(0), "application/pdf").asPDF();
        if (work){
          imgRep = await recompressImages(work, level, async (i, n)=>{
            showSpin(true, "Compressing… picture "+i+" of "+n);
            await new Promise(r=>setTimeout(r,0));     // keep the UI alive
          });
          if (imgRep && imgRep.changed){
            const cand = u8(work.saveToBuffer("compress,compress-fonts,subset-fonts,garbage").asUint8Array());
            if (cand.length < bestLen){ best = cand; bestLen = cand.length; }
          }
        }
      } catch(e){ imgRep = null; }
      finally { try{ if(work) work.destroy(); }catch(e){} }
    }

    // 3) Rasterising is now the LAST resort, not the second move. It is only
    //    considered when the images have already been dealt with and the file
    //    is still over target.
    if (bestLen > cfg.targetKB*1024){
      showSpin(true,"Compressing…");
      const rasterAll = async ()=>{
        for (const step of cfg.steps){
          const bytes = await rasterize(step.dpi, step.q);
          if (bytes.length < bestLen){ best=bytes; bestLen=bytes.length; rasterised=true; }
          if (bytes.length <= cfg.targetKB*1024) break;
        }
      };
      if (sampledTextLength() >= 80){
        // Real text present: rasterising would destroy selectable/searchable
        // text. Let the user choose instead of doing it silently.
        showSpin(false);
        const choice = await confirmRasterise(before, bestLen);
        if (choice === null){ setStatus("Compression cancelled.","warn"); return; }
        showSpin(true,"Compressing…");
        if (choice === true) await rasterAll();
      } else {
        // no meaningful text (scanned / image PDF): rasterise freely as before
        await rasterAll();
      }
    }

    // 4) Never grow the file. An already-optimised PDF can come back the same
    //    size or a few bytes LARGER; committing that would grow the document,
    //    mark it dirty, add a pointless undo step and report a negative
    //    "% smaller". Leave it untouched instead.
    if (bestLen >= before){
      showSpin(false);
      setStatus(`Already about as small as it usefully gets — ${fmtKB(before)} left unchanged.`, "ok");
      return;
    }
    // 5) commit — snapshot for Undo now (skipped on very large files)
    const undoKept = pushUndoGuarded();
    workingBytes = best instanceof Uint8Array ? best : new Uint8Array(best);
    reopen(); await render();
    const met = bestLen <= cfg.targetKB*1024, pct=Math.round(100*(1-bestLen/before));
    let how = "";
    if (rasterised) how = " Pages were turned into pictures, so the text is no longer selectable.";
    else if (imgRep && imgRep.changed)
      how = " "+imgRep.changed+" picture"+(imgRep.changed>1?"s":"")+" reduced"
          + (imgRep.bilevel ? " ("+imgRep.bilevel+" stored as black-and-white)" : "")
          + "; all text stays selectable.";
    else how = " Text stays selectable.";
    setStatus(`Done: ${fmtKB(before)} → ${fmtKB(bestLen)} (${pct}% smaller).` + how
      + (met||rasterised ? "" : " That\'s the smallest it can go and stay readable.")
      + (undoKept ? "" : " (Too large to keep an undo step.)"), "ok");
  } catch(err){ setStatus("Could not compress: "+friendly(err),"err"); }
  showSpin(false);
};

async function rasterize(dpi, quality){
  const out = await PDFDocument.create();
  const scale = dpi/72, n = MDOC.countPages();
  for (let i=0;i<n;i++){
    // keep the UI alive on long documents: show progress and yield each page
    showSpin(true, "Compressing… page "+(i+1)+" of "+n);
    await new Promise(r=>setTimeout(r,0));
    const page = MDOC.loadPage(i);
    const [x0,y0,x1,y1]=page.getBounds(); const wPt=x1-x0, hPt=y1-y0;
    const pix = page.toPixmap(mupdf.Matrix.scale(scale,scale), mupdf.ColorSpace.DeviceRGB, false);
    const jpg = u8(pix.asJPEG(quality)); pix.destroy(); page.destroy();
    const img = await out.embedJpg(jpg);
    const p = out.addPage([wPt, hPt]);
    p.drawImage(img, { x:0, y:0, width:wPt, height:hPt });
  }
  return new Uint8Array(await out.save());
}

// ---------------- undo ----------------
const UNDO_LIMIT = 10;                       // max steps (small documents)
const UNDO_BYTES_CAP = 120*1024*1024;        // max total memory for undo copies
let undoStack = [];
// v10.90: the undo budget now SCALES DOWN with document size. A 20MB scanned
// file with 10 snapshots plus the working copy, engine and page rasters can
// breach WKWebView's hard memory limit on older iPhones — iOS then kills the
// app silently, losing the session. Fewer, cheaper steps on big files keeps
// the total footprint predictable; small documents keep the full history.
function undoBudget(){
  const sz = workingBytes ? workingBytes.length : 0;
  if (sz > 24*1024*1024) return { steps:3, bytes:48*1024*1024 };
  if (sz >  8*1024*1024) return { steps:5, bytes:80*1024*1024 };
  return { steps:UNDO_LIMIT, bytes:UNDO_BYTES_CAP };
}
function pushUndo(){
  // Each entry remembers BOTH the pre-mutation bytes and the dirty state at that
  // point, so undoing back to the originally-opened document also restores
  // dirty=false (rather than always leaving a spurious "unsaved changes" flag).
  undoStack.push({ bytes: workingBytes ? workingBytes.slice(0) : null, dirty });
  setDirty(true);                            // every mutation passes through here
  const budget = undoBudget();
  while (undoStack.length > budget.steps) undoStack.shift();
  // large documents: keep undo memory bounded by dropping the oldest steps
  let total=0; for (const e of undoStack) total += e.bytes ? e.bytes.length : 0;
  while (total > budget.bytes && undoStack.length > 1){
    const drop = undoStack.shift(); total -= drop.bytes ? drop.bytes.length : 0;
  }
  refreshUndo();
}
// Heavy operations (compress, merge) already hold several full-document copies
// in flight. On a very large file, adding one more full snapshot for Undo can
// push iOS past its hard per-tab memory limit. Above this size we skip the
// snapshot (the original file still exists in Files) and return false so the
// caller can mention that this one step can't be undone.
const UNDO_SNAPSHOT_MAX = 48*1024*1024;
function pushUndoGuarded(){
  if (workingBytes && workingBytes.length > UNDO_SNAPSHOT_MAX){
    setDirty(true); refreshUndo();    // still a change, just without a costly copy
    return false;
  }
  pushUndo();
  return true;
}
async function doUndo(){
  if (!undoStack.length){ setStatus("Nothing to undo.","err"); return; }
  const snap = undoStack.pop();
  workingBytes = snap.bytes;
  showSpin(true,"Undoing…");
  if (workingBytes){ setDirty(snap.dirty); reopen(); await render(); }
  else { closeDoc(); setDirty(snap.dirty); try{ idbDel("doc").catch(()=>{}); }catch(e){} await render(); }
  enableDocButtons(!!workingBytes);
  showSpin(false); setStatus("Undone.","ok");
}

// ---------------- sheet + utilities ----------------
function closeSheet(){
  $("sheetBg").classList.remove("show");
  const sh = $("sheet");                         // clear any drag-leftover state
  sh.classList.remove("fullpage");               // v11.10: pages grid height reset
  try { $("pagesBtn").classList.remove("on"); } catch(e){}   // v11.14
  sh.removeAttribute("data-drag"); sh.style.transform = "";
  sh.style.marginBottom = "";                    // clear any keyboard lift (v10.97)
  if (sheetThumbObs){ sheetThumbObs.disconnect(); sheetThumbObs=null; }
  // resolve any awaited sheet (e.g. password) as "cancelled" so it never hangs
  const cb = sheetOnDismiss; sheetOnDismiss = null;
  if (cb){ try{ cb(); }catch(e){} }
  // return focus to whatever had it before the sheet opened
  if (sheetLastFocus){ const el = sheetLastFocus; sheetLastFocus = null; try{ el.focus(); }catch(e){} }
}
$("sheetBg").addEventListener("click", e=>{ if(e.target===$("sheetBg")) closeSheet(); });
// Esc closes the open sheet (keyboard users / iPad with a keyboard)
document.addEventListener("keydown", e=>{ if(e.key==="Escape" && $("sheetBg").classList.contains("show")) closeSheet(); });

// ---------------- modal inert + focus trap (v10.96) ----------------
// While a sheet or a full-screen scanner view is open, everything behind it is
// marked inert so VoiceOver / keyboard focus cannot wander into hidden UI
// (previously only pointer input was blocked, by the backdrop). inert is
// supported on the app's iOS 16.4+ baseline; where it isn't, the attribute is
// a harmless no-op and the focus trap below still contains keyboard users.
const APP_CHROME_IDS = ["toolbar","findbar","viewer","pagePill","zoomctl","undoBtn","mkMenu"];
function updateModalInert(){
  const sheetOpen = $("sheetBg").classList.contains("show");
  const camOpen   = $("scanCam").classList.contains("show");
  const cropOpen  = $("scanCrop").classList.contains("show");
  const scanOpen  = camOpen || cropOpen;
  const set = (el,on)=>{ if (el){ try { el.toggleAttribute("inert", !!on); } catch(e){} } };
  set(document.querySelector("header"), sheetOpen || scanOpen);
  for (const id of APP_CHROME_IDS) set($(id), sheetOpen || scanOpen);
  // a sheet can open ON TOP of the scanner (page review, discard confirm):
  // the scanner screens themselves go inert underneath it
  set($("scanCam"),  sheetOpen || (scanOpen && !camOpen));
  set($("scanCrop"), sheetOpen || (scanOpen && !cropOpen));
}
// One wiring point: watch the class changes that show/hide these layers, so
// every open/close path (there are many) keeps the inert state correct.
(function wireModalInert(){
  if (typeof MutationObserver !== "function") return;   // headless harness: skip
  const mo = new MutationObserver(updateModalInert);
  for (const id of ["sheetBg","scanCam","scanCrop"]){
    const el = $(id); if (el) mo.observe(el, { attributes:true, attributeFilter:["class"] });
  }
})();
// v11.90: read the trace back. Deliberately a plain monospace dump with a Copy
// button rather than a pretty summary — a summary would be my interpretation,
// and interpreting these numbers wrongly is exactly what has cost four
// releases. The raw rows go to whoever is diagnosing.
function openDiagnostics(){
  const txt = diagText();
  $("sheet").innerHTML = h`
    <h3>Diagnostics</h3>
    <p class="hint">A frame-by-frame record of the layout during app launch and
    while the scanner opens. Reproduce the problem first, then come here — the
    last few seconds are kept. Copy this and send it on.</p>
    <pre class="diagdump" id="diagDump">${txt}</pre>
    <div class="row"><button class="full" id="diagCopy">Copy</button></div>
    <div class="row"><button class="full" id="diagAgain">Record again (6s)</button></div>
    <div class="row"><button class="ghost full" id="diagClose">Close</button></div>`;
  $("diagCopy").onclick = async ()=>{
    try {
      await navigator.clipboard.writeText(diagText());
      setStatus("Trace copied.","ok");
    } catch(e){
      // clipboard can be refused; selecting the text is the fallback
      try {
        const r = document.createRange(); r.selectNodeContents($("diagDump"));
        const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
        setStatus("Could not copy automatically — the trace is selected, use Copy.","warn");
      } catch(e2){ setStatus("Could not copy the trace.","err"); }
    }
  };
  $("diagAgain").onclick = ()=>{ diagRows = []; diagRecord("manual"); closeSheet();
    setStatus("Recording for 6 seconds — reproduce the problem now.","ok"); };
  $("diagClose").onclick = closeSheet;
  openSheet();
}
// ---------------- layout recorder (v11.90) ---------------------------------
// Two device-only bugs have survived four fixes each: a black band below the
// bottom toolbar, and the camera preview opening small and then jumping to
// size. Every one of those fixes was built on inference from a screenshot,
// because BOTH bugs are transient and self-correcting — any reading taken after
// the fact shows healthy numbers.
//
// So this records the numbers WHILE the bugs are visible, rather than measuring
// once and hoping the moment was right. It only reads; nothing here changes
// layout. Recording windows are short and bounded, and stop on their own.
const DIAG_MAX  = 700;          // rows kept, oldest dropped
const DIAG_MS   = 6000;         // how long a window records for
let diagRows = [];
let diagWindow = 0;             // timestamp the current window ends
let diagTimer  = 0;
let diagT0     = 0;

function diagSample(tag){
  try {
    const now = Date.now();
    const t = String(now - diagT0).padStart(5, " ");
    const bar = $("toolbar");
    const br = bar && bar.getBoundingClientRect ? bar.getBoundingClientRect() : null;
    const sc = window.screen || {};
    const vv = window.visualViewport;
    let row = "win=" + window.innerWidth + "x" + window.innerHeight
      + " scr=" + (sc.width|0) + "x" + (sc.height|0)
      + (vv ? " vv=" + Math.round(vv.width) + "x" + Math.round(vv.height)
              + "@" + Math.round(vv.offsetTop) : "")
      + (br ? " barBot=" + Math.round(br.bottom) + " barTop=" + Math.round(br.top) : "")
      + " drop=" + vvDrop;
    // scanner fields only while the scanner is up — the second bug lives here
    const panel = $("scanCam");
    if (panel && panel.classList.contains("show")){
      const view = $("scanView"), v = $("scanVideo");
      const vr = v && v.getBoundingClientRect ? v.getBoundingClientRect() : null;
      const pr = panel.getBoundingClientRect ? panel.getBoundingClientRect() : null;
      row += " | panel=" + (pr ? Math.round(pr.width)+"x"+Math.round(pr.height)+"@"+Math.round(pr.top) : "-")
          +  " view=" + (view ? view.clientWidth+"x"+view.clientHeight : "-")
          +  " vid=" + (v ? (v.videoWidth|0)+"x"+(v.videoHeight|0) : "-")
          // the RENDERED rect is the ground truth: it is what is on screen,
          // not what the fit intended
          +  " drawn=" + (vr ? Math.round(vr.width)+"x"+Math.round(vr.height)
                             + "@" + Math.round(vr.left) + "," + Math.round(vr.top) : "-")
          +  " ready=" + ((v && v.classList.contains("ready")) ? 1 : 0);
      // v11.94: label the frames that are actually WRONG. Reading 700 rows and
      // recomputing the contain fit by hand is how the first two traces were
      // read; the recorder can do that arithmetic itself and say so.
      if (v && v.videoWidth > 0 && view && vr){
        const f = containFit(v.videoWidth, v.videoHeight, view.clientWidth, view.clientHeight);
        if (Math.abs(Math.round(f.dispW) - Math.round(vr.width)) > 2
         || Math.abs(Math.round(f.dispH) - Math.round(vr.height)) > 2)
          row += "  OFF-FIT(want " + Math.round(f.dispW) + "x" + Math.round(f.dispH) + ")";
      }
      // v11.95: the element's rect is not what the eye sees. `object-fit:contain`
      // paints the stream INSIDE that box, so a video element of the right size
      // showing a stream of a different aspect paints smaller than itself — and
      // every frame of the last trace "matched the fit" while the preview was
      // still reported as opening small. Record what is painted, and what our
      // own code asked for, so the three can be compared.
      //
      // A correct contain fit is short on ONE axis (the letterbox). Short on
      // BOTH is the thing being described as a small window floating in black,
      // and is labelled as such.
      if (v && vr && view){
        const bw = view.clientWidth|0, bh = view.clientHeight|0;
        const sw = v.videoWidth|0, sh = v.videoHeight|0;
        let pw = Math.round(vr.width), ph = Math.round(vr.height);
        if (sw > 0 && sh > 0 && vr.width > 0 && vr.height > 0){
          const p = containFit(sw, sh, vr.width, vr.height);
          pw = Math.round(p.dispW); ph = Math.round(p.dispH);
        }
        row += " paint=" + pw + "x" + ph
            +  " sty=" + ((v.style && v.style.width) ? v.style.width + "x" + v.style.height : "-")
            +  " boot=" + (($("camBoot") && !$("camBoot").hidden) ? 1 : 0);
        if (bw > 0 && bh > 0 && pw < bw*0.92 && ph < bh*0.92)
          row += "  SMALL(paints " + pw + "x" + ph + " in " + bw + "x" + bh + ")";
      }
    }
    // v11.94: collapse identical consecutive frames. The first device trace was
    // 700 rows of which 690 were byte-identical — a still layout sampled every
    // frame — so the buffer covered eight seconds of a session in which the
    // interesting open had already been evicted. Only CHANGE is information
    // here; an unchanged frame is recorded as a repeat count on the row it
    // repeats, which is both shorter to read and keeps every distinct frame.
    const last = diagRows.length ? diagRows[diagRows.length-1] : null;
    if (!tag && last && last.body === row){
      last.n++; last.tEnd = t;
      return;
    }
    diagRows.push({ body: row, tag: tag || "", t, tEnd: t, n: 1 });
    if (diagRows.length > DIAG_MAX) diagRows.splice(0, diagRows.length - DIAG_MAX);
  } catch(e){ /* a diagnostic must never break the app it is diagnosing */ }
}

// Start (or extend) a recording window. Samples every animation frame, which is
// the resolution these bugs happen at — they resolve within a few frames.
function diagRecord(tag){
  const now = Date.now();
  if (!diagRows.length) diagT0 = now;
  diagSample(tag);
  diagWindow = now + DIAG_MS;
  if (diagTimer) return;                       // a window is already running
  const step = ()=>{
    diagSample("");
    if (Date.now() < diagWindow){ diagTimer = nextFrame(step); return; }
    diagTimer = 0;
  };
  diagTimer = nextFrame(step);
}
// Reading a computed style is the one thing in the trace that can throw where
// the recorder cannot — a diagnostic that crashes when asked for its report is
// worse than no diagnostic.
function diagSafeArea(){
  try {
    return (window.getComputedStyle(document.documentElement)
      .getPropertyValue("--botpad") || "?").trim();
  } catch(e){ return "?"; }
}
// The two questions a trace is opened to answer, answered at the top so nobody
// has to recompute a contain fit by hand to find out whether anything is wrong.
function diagVerdict(){
  try {
    const scr = window.screen ? Math.max(window.screen.width|0, window.screen.height|0) : 0;
    const short = scr - window.innerHeight;
    const web = (!scr || short <= 2)
      ? "web view full screen"
      : "web view SHORT by " + short + "px — the band below the bar is outside the page; re-add to Home Screen";
    let opens = 0, off = 0, offN = 0, small = 0, smallN = 0;
    for (const r of diagRows){
      if (r.tag === "scanner-open") opens++;
      if (/OFF-FIT/.test(r.body)){ off++; offN += r.n; }
      if (/SMALL\(/.test(r.body)){ small++; smallN += r.n; }
    }
    let cam;
    if (!opens) cam = "no scanner open recorded";
    else if (!off && !small) cam = opens + " scanner open(s), every frame filled the box";
    else {
      cam = opens + " scanner open(s)";
      if (off) cam += ", " + offN + " frame(s) OFF-FIT";
      if (small) cam += ", " + smallN + " frame(s) painted SMALL";
      cam += " — search " + (small ? "SMALL" : "OFF-FIT");
    }
    return web + " · " + cam;
  } catch(e){ return "?"; }
}
function diagText(){
  const head = [
    "PyPDF layout trace — build " + APP_BUILD,
    "mode: " + ((window.navigator && window.navigator.standalone === true)
      || (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches)
      ? "standalone" : "browser tab"),
    "dpr: " + (window.devicePixelRatio || "?")
      + "   safe-area-bottom: " + diagSafeArea(),
    "rows: " + diagRows.length + " distinct (newest last); ×N = frames held that shape",
    "verdict: " + diagVerdict(),
    ""
  ];
  const body = diagRows.map(r =>
    "t=" + r.t + (r.n > 1 ? ".." + r.tEnd + " x" + r.n : "")
    + " " + r.body + (r.tag ? "  <" + r.tag + ">" : ""));
  return head.concat(body).join("\n");
}
// ---------------- bottom chrome, pinned to the real bottom (v11.83) --------
// Reported with two screenshots taken minutes apart: sometimes a band of black
// sits BELOW the toolbar, sometimes it does not. The header is in the same
// place in both, so the page is not shifted — the LAYOUT viewport is ending
// short of the screen, and a `position:fixed; bottom:0` bar honestly obeys it.
// That is an iOS standalone-PWA behaviour I cannot reproduce off-device, so
// this measures the discrepancy rather than assuming a cause.
//
// --vvdrop is how far the visible bottom is below where `bottom:0` lands. When
// the two agree it is 0px and every rule that uses it is unchanged, so this is
// a no-op on every device that was already correct — which matters, because a
// blind fix for an intermittent bug should not be able to break the common case.
//
// The value is added as PADDING on the toolbar rather than as a negative
// `bottom`: growing the bar downwards keeps its background covering the gap,
// where moving it would just relocate the black band.
let vvDrop = 0;
let vvLast = "";        // for the About readout
// v11.86: TWO references, because either alone misses the real case.
//
// v11.85 measured only the bar's own edge against window.innerHeight. On this
// device that reads ZERO while the gap is plainly on screen — because the bar
// is exactly where `bottom:0` puts it, and it is the LAYOUT VIEWPORT that is
// short. Measuring the bar against the thing that is itself too small can
// never see it. That is why v11.83 and v11.85 both did nothing.
//
// The clue was in the screenshots: the gap is there while the "Ready…" toast is
// up and gone once it has faded. The toast is not a cause — it is `position:
// fixed` and cannot push anything — it is a CLOCK. It shows for a few seconds
// after launch, so the gap is a launch-time state that settles by itself.
//
// So the second reference is screen.height, which does not move. Gated to
// installed-standalone only: in a Safari tab innerHeight is legitimately much
// smaller than the screen (browser chrome), and pushing the toolbar down there
// would shove it under the browser UI.
function bottomShortfall(){
  const bar = $("toolbar");
  if (!bar || !bar.getBoundingClientRect) return null;
  const r = bar.getBoundingClientRect();
  // (1) is the bar where the viewport says the bottom is?
  let gap = Math.round(window.innerHeight - r.bottom);
  // (2) does the viewport itself reach the bottom of the screen?
  let short = 0;
  const standalone = (window.navigator && window.navigator.standalone === true)
    || (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
  if (standalone && window.screen && window.screen.height){
    const portrait = window.innerHeight >= window.innerWidth;
    // iOS does not swap screen.width/height on rotation, so pick by orientation
    const screenH = portrait ? Math.max(window.screen.width, window.screen.height)
                             : Math.min(window.screen.width, window.screen.height);
    const d = Math.round(screenH - window.innerHeight);
    // A small shortfall is the bug. A large one is a legitimately smaller
    // window (iPad multitasking, a resized window) and must be left alone.
    if (d > 0 && d <= 120) short = d;
  }
  vvLast = Math.round(r.bottom) + "/" + window.innerHeight
         + (window.screen ? "/" + Math.round(Math.max(window.screen.width, window.screen.height)) : "");
  return gap + short;
}
// v11.91: measures, but no longer CORRECTS. The on-device trace showed why a
// correction cannot work: innerHeight 894 against a 956 screen means the web
// view is 62px short and the black band is outside the document. A negative
// `bottom` put the bar's box at viewport-y 956, past the end of the web view,
// where it was clipped rather than painted. Anything below innerHeight is not
// rendered — so no value of --vvdrop could ever have filled that band.
//
// The reading is kept because it is what diagnosed this, and because it tells
// the user which state their install is in.
function pinBottomChrome(){
  const shortfall = bottomShortfall();
  if (shortfall === null) return;
  vvDrop = shortfall;          // reported in About and in the trace, not applied
  // v11.95: the one thing this measurement IS applied to. A web view that fills
  // the screen owns the home-indicator strip, so the bottom inset is real and
  // the toolbar honours it in full; a short one does not, and keeps the
  // subtract-30 correction. Toggled rather than set, so an install that changes
  // (re-adding to the Home Screen does exactly that) converges without a reload.
  try { document.documentElement.classList.toggle("fullvp", shortfall <= 2); } catch(e){}
}
(function watchBottomChrome(){
  const recheck = ()=> nextFrame(pinBottomChrome);
  window.addEventListener("resize", recheck);
  window.addEventListener("orientationchange", ()=> setTimeout(recheck, 300));
  const vv = window.visualViewport;
  if (vv && typeof vv.addEventListener === "function"){
    vv.addEventListener("resize", recheck);
    vv.addEventListener("scroll", recheck);
  }
  // iOS settles the standalone viewport some time after launch and again after
  // a resume, and there is no event that reliably marks the end of it. A short
  // ladder of checks costs nothing and covers every device I cannot test on.
  document.addEventListener("visibilitychange", ()=>{
    if (!document.hidden) [0,150,400,900].forEach(t=> setTimeout(pinBottomChrome, t));
  });
  [0,150,400,900,1800].forEach(t=> setTimeout(pinBottomChrome, t));
  // v11.90: record the launch window — this is when the bottom gap appears
  diagRecord("launch");
  document.addEventListener("visibilitychange", ()=>{
    if (!document.hidden) diagRecord("resume");
  });
  // v11.89: a fixed ladder can only catch a settle it happens to land on. If
  // the viewport reaches its final size later than the last rung, nothing
  // re-measures and the gap stays for the rest of the session. Poll gently for
  // the first ten seconds as well — pinBottomChrome is one getBoundingClientRect
  // and returns immediately when the bar is already flush, so twenty of them
  // cost nothing and remove the dependence on guessing the right moment.
  let polls = 0;
  const poll = setInterval(()=>{
    pinBottomChrome();
    if (++polls >= 20) clearInterval(poll);
  }, 500);
})();
// ---------------- keyboard avoidance (v10.97) ----------------
// On smaller iPhones the on-screen keyboard can cover a bottom sheet's input
// and action buttons (Save/rename, password, go-to-page). visualViewport
// reports the actually-visible area while the keyboard is up; lift the sheet
// by the overlap so the focused field and its buttons stay reachable. Cleared
// whenever the sheet closes (closeSheet) or the keyboard hides (overlap 0).
(function keyboardAvoid(){
  const vv = window.visualViewport;
  if (!vv || typeof vv.addEventListener !== "function") return;
  const apply = ()=>{
    const sheet = $("sheet");
    if (!$("sheetBg").classList.contains("show")){ sheet.style.marginBottom = ""; return; }
    const overlap = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    sheet.style.marginBottom = overlap > 0 ? overlap + "px" : "";
  };
  vv.addEventListener("resize", apply);
  vv.addEventListener("scroll", apply);
})();

// Trap Tab inside the open sheet (belt-and-braces on top of inert, and the
// only containment on engines without inert support).
$("sheet").addEventListener("keydown", (e)=>{
  if (e.key !== "Tab") return;
  const sheet = $("sheet");
  const f = [...sheet.querySelectorAll("button,input,textarea,select,a[href],[tabindex]")]
    .filter(el=>!el.disabled && el.tabIndex >= 0);
  if (!f.length) return;
  const first = f[0], last = f[f.length-1];
  if (e.shiftKey && (document.activeElement === first || document.activeElement === sheet)){
    e.preventDefault(); last.focus();
  } else if (!e.shiftKey && document.activeElement === last){
    e.preventDefault(); first.focus();
  }
});

// ---- native-style drag-to-dismiss on the sheet grabber ----------------------
// A downward drag that starts in the top grabber zone (and only when the sheet
// is scrolled to the top, so it never fights content scrolling) tracks the
// finger 1:1; releasing past a distance/velocity threshold closes the sheet,
// otherwise it springs back. Pointer events cover touch + mouse + pen.
(function sheetDrag(){
  const sheet = $("sheet");
  let dragging=false, startY=0, lastY=0, lastT=0, vy=0;
  const GRAB_ZONE = 44;          // px from the sheet top that initiates a drag
  sheet.addEventListener("pointerdown", e=>{
    if (e.pointerType==="mouse" && e.button!==0) return;
    if (sheet.scrollTop > 0) return;                       // let content scroll
    if (e.clientY - sheet.getBoundingClientRect().top > GRAB_ZONE) return;
    dragging=true; startY=lastY=e.clientY; lastT=performance.now(); vy=0;
    sheet.setAttribute("data-drag","");
    try{ sheet.setPointerCapture(e.pointerId); }catch(_){}
  });
  sheet.addEventListener("pointermove", e=>{
    if (!dragging) return;
    const dy = Math.max(0, e.clientY - startY);            // downward only
    const now = performance.now();
    if (now>lastT){ vy = (e.clientY-lastY)/(now-lastT); lastT=now; lastY=e.clientY; }
    sheet.style.transform = "translateY("+dy+"px)";
    if (dy>0) e.preventDefault();
  });
  function end(e){
    if (!dragging) return; dragging=false;
    try{ sheet.releasePointerCapture(e.pointerId); }catch(_){}
    sheet.removeAttribute("data-drag");
    const dy = Math.max(0, (e.clientY||lastY) - startY);
    sheet.style.transform = "";                            // CSS resumes control
    if (dy > 110 || vy > 0.55) closeSheet();               // dismiss vs spring back
  }
  sheet.addEventListener("pointerup", end);
  sheet.addEventListener("pointercancel", end);
})();

function fileToDataURL(file){ return new Promise((res,rej)=>{ const r=new FileReader();
  r.onload=()=>res(r.result); r.onerror=rej; r.readAsDataURL(file); }); }
function loadImage(url){ return new Promise((res,rej)=>{ const im=new Image();
  im.onload=()=>res(im); im.onerror=rej; im.src=url; }); }
async function toJpeg(dataUrl, q){
  const im=await loadImage(dataUrl);
  const c=document.createElement("canvas"); c.width=im.naturalWidth; c.height=im.naturalHeight;
  const ctx=c.getContext("2d"); ctx.fillStyle="#fff"; ctx.fillRect(0,0,c.width,c.height); ctx.drawImage(im,0,0);
  return c.toDataURL("image/jpeg", q);
}
async function toPng(dataUrl){
  const im=await loadImage(dataUrl);
  const c=document.createElement("canvas"); c.width=im.naturalWidth; c.height=im.naturalHeight;
  c.getContext("2d").drawImage(im,0,0);
  return c.toDataURL("image/png");
}
// Knock out a signature photo's paper background so only the ink shows, the way
// Adobe Sign does — the result blends onto any PDF page colour instead of sitting
// in a visible box. This is colour-aware, not a flat white threshold: real
// signatures are often photographed on off-white, grey, or shadowed paper (corner
// luminance well below pure white and uneven across the image). A flat threshold
// would leave a grey rectangle or shadow. Instead each pixel is kept by the
// stronger of two ink cues:
//   • darkness  — ink strokes are much darker than paper (covers black ink too)
//   • colour    — ink is saturated (blue/black pen) while paper/shadow is neutral
// Neutral, light pixels (paper + soft shadows) score low on both → transparent.
// Both cues ramp smoothly so stroke edges stay anti-aliased. Already-transparent
// PNGs are preserved (we only ever lower alpha, never raise it).
async function signatureToTransparentPng(dataUrl){
  const im = await loadImage(dataUrl);
  const w = im.naturalWidth, hh = im.naturalHeight;
  const c = document.createElement("canvas"); c.width=w; c.height=hh;
  const ctx = c.getContext("2d");
  ctx.drawImage(im,0,0);
  let id;
  try { id = ctx.getImageData(0,0,w,hh); }
  catch(e){ return c.toDataURL("image/png"); }   // tainted canvas → leave as-is
  const d = id.data;
  // Darkness cue: fully opaque at/below DARK_LO, transparent above DARK_HI.
  const DARK_LO = 110, DARK_HI = 175;
  // Colour cue: neutral below SAT_LO, fully "ink" at/above SAT_HI.
  const SAT_LO = 25,  SAT_HI = 60;
  const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
  for (let i=0;i<d.length;i+=4){
    const r=d[i], g=d[i+1], b=d[i+2];
    const lum = 0.299*r + 0.587*g + 0.114*b;
    const sat = Math.max(r,g,b) - Math.min(r,g,b);
    const darkScore  = clamp01((DARK_HI - lum) / (DARK_HI - DARK_LO));
    const colorScore = clamp01((sat - SAT_LO) / (SAT_HI - SAT_LO));
    const keep = Math.max(darkScore, colorScore);   // 1 = full ink, 0 = paper
    d[i+3] = Math.round(d[i+3] * keep);
  }
  ctx.putImageData(id,0,0);
  return c.toDataURL("image/png");
}
function downloadBlob(blob, name){
  const url=URL.createObjectURL(blob); const a=document.createElement("a");
  a.href=url; a.download=safeFileName(name); a.rel="noopener"; document.body.appendChild(a); a.click();
  setTimeout(()=>{ a.remove(); URL.revokeObjectURL(url); }, 4000);
}
// Save the PDF. Prefer the Web Share API (the real iOS share sheet — Save to
// Files, AirDrop, Mail…) when the browser can share files; otherwise fall back
// to a normal download. Must be called from a user gesture for share to work.
// Returns true if saved/shared, false if the user dismissed the share sheet.
async function saveOrShare(bytes, name, mime="application/pdf"){
  const nm = safeFileName(name);
  try {
    const file = new File([bytes], nm, { type:mime });
    if (navigator.canShare && navigator.canShare({ files:[file] })){
      try { await navigator.share({ files:[file] }); return true; }
      catch(e){ if (e && e.name === "AbortError") return false; /* unsupported at runtime → fall through */ }
    }
  } catch(e){ /* File ctor or canShare unavailable → fall through to download */ }
  downloadBlob(new Blob([bytes], {type:mime}), nm);
  return true;
}

// ---------------- "Page 3 of 12" pill while scrolling ----------------
// Appears during scroll on multi-page documents, fades out when you stop.
const raf = (typeof requestAnimationFrame !== "undefined") ? requestAnimationFrame : (f)=>setTimeout(f,16);
let pillT = 0, pillPending = false;
// v10.96: the pill is focusable only while visible, so keyboard/switch users
// can reach it but never land on an invisible control.
function pillShow(on){
  const p = $("pagePill");
  p.classList.toggle("show", !!on);
  p.tabIndex = on ? 0 : -1;
}
$("pagePill").tabIndex = -1;
$("pagePill").addEventListener("keydown", (e)=>{
  if (e.key === "Enter" || e.key === " "){
    e.preventDefault();
    if (workingBytes && MDOC && MDOC.countPages() > 1) openJumpToPage();
  }
});
// v11.24: the pill used to measure EVERY page with getBoundingClientRect on
// every scroll frame — 300 forced layout reads per frame on a 300-page book,
// on the hottest path in the app. Page geometry only changes on render/zoom/
// rotate, so measure ONCE per geometry (one pass, content-space coordinates)
// and answer each scroll frame with pure arithmetic + binary search.
let pillGeo = null;            // { key, tops:[], mids:[], pages:[] }
function pillGeoKey(v){ return epoch+":"+zoomPct+":"+lastViewerW+":"+$("pageWrap").childElementCount; }
function pillMeasure(v){
  const vr = v.getBoundingClientRect(), base = v.scrollTop - vr.top;
  const tops=[], mids=[], pages=[];
  v.querySelectorAll(".stage").forEach(s=>{
    const r = s.getBoundingClientRect();          // one pass, then cached
    tops.push(r.top + base); mids.push((r.top+r.bottom)/2 + base);
    pages.push(+s.dataset.page);
  });
  pillGeo = { key: pillGeoKey(v), tops, mids, pages };
}
$("viewer").addEventListener("scroll", ()=>{
  if (!workingBytes || !MDOC || pillPending) return;
  pillPending = true;
  raf(()=>{
    pillPending = false;
    try {
      const n = MDOC.countPages();
      if (n < 2) return;
      const v = $("viewer");
      if (!pillGeo || pillGeo.key !== pillGeoKey(v) || !pillGeo.pages.length) pillMeasure(v);
      const mid = v.scrollTop + v.clientHeight/2;
      // binary search the page whose centre is nearest the viewport centre
      const { mids, pages } = pillGeo;
      let lo = 0, hi = mids.length-1;
      while (lo < hi){ const m = (lo+hi)>>1; (mids[m] < mid) ? lo = m+1 : hi = m; }
      const best = (lo > 0 && Math.abs(mids[lo-1]-mid) < Math.abs(mids[lo]-mid))
                 ? pages[lo-1] : pages[lo];
      const p = $("pagePill");
      p.textContent = (best+1)+" of "+n;                  // compact, e-reader style
      p.setAttribute("aria-label", "Go to page — currently page "+(best+1)+" of "+n);
      pillShow(true);
      clearTimeout(pillT);
      // stay visible a little longer than before so it's comfortable to tap
      pillT = setTimeout(()=>pillShow(false), 2500);
    } catch(e){}
  });
}, { passive:true });
// the pill is a shortcut to Go to page; tapping it opens the same dialog as More
$("pagePill").onclick = ()=>{ if (workingBytes && MDOC && MDOC.countPages()>1) openJumpToPage(); };
// don't let it fade while a finger/cursor is on it, so the tap can't miss
["pointerenter","pointerdown"].forEach(ev=>$("pagePill").addEventListener(ev, ()=>{ clearTimeout(pillT); }));
$("pagePill").addEventListener("pointerleave", ()=>{ clearTimeout(pillT);
  pillT = setTimeout(()=>pillShow(false), 1200); });

// Re-render on rotate / real width change only. iOS fires "resize" constantly
// as the address bar shows/hides (height-only changes); re-rendering on those
// wastes battery, so skip when the viewer width is unchanged.
let resizeT;
window.addEventListener("resize", ()=>{
  if(!workingBytes) return;
  if($("viewer").clientWidth === lastViewerW) return;   // width unchanged → nothing to do
  clearTimeout(resizeT);
  // v11.06: keep the reading position through a rotation. Page heights change
  // with the new width, so a raw pixel scrollTop lands on different content;
  // anchor the page+fraction at the viewer centre (same trick as setZoom).
  resizeT = setTimeout(async ()=>{
    const v = $("viewer");
    let r = v.getBoundingClientRect();
    const anchor = anchorStage(r.left + r.width/2, r.top + r.height/2);
    await render();
    if (!anchor) return;
    const stg = $("pageWrap").querySelector('.stage[data-page="'+anchor.page+'"]');
    if (!stg) return;
    r = v.getBoundingClientRect();                       // fresh centre after rotate
    const px = r.left + r.width/2, py = r.top + r.height/2;
    const rc = stg.getBoundingClientRect();
    const maxL = Math.max(0, v.scrollWidth  - v.clientWidth);
    const maxT = Math.max(0, v.scrollHeight - v.clientHeight);
    v.scrollLeft = Math.max(0, Math.min(maxL, v.scrollLeft + (rc.left + anchor.fx*rc.width  - px)));
    v.scrollTop  = Math.max(0, Math.min(maxT, v.scrollTop  + (rc.top  + anchor.fy*rc.height - py)));
  }, 300);
});

// ---------------- battery: release everything when hidden / closed ----------------
// Stop all background work the moment the app is not visible, and fully release
// the WebAssembly document (tens of MB) plus image memory when it is closed or
// swiped away, so a backgrounded PWA costs essentially nothing.
function pauseWork(){ if (pageObserver) pageObserver.disconnect(); clearTimeout(resizeT); }
function resumeWork(){ if (workingBytes && MDOC) observeStages(); }   // re-attach lazy rendering
function releaseAll(){
  pauseWork();
  stopCamera();          // release the camera stream + live detect loop
  revokeURLs();
  closeDoc();            // destroy the mupdf doc -> frees the bulk of WASM memory
  spanCache.clear();
}

// v10.95: keep the camera stream across BRIEF hides (app switch, notification
// peek). Stopping the tracks here meant a fresh getUserMedia on return, and in
// a standalone iOS PWA every fresh call re-shows the permission prompt — so a
// user who glanced at Messages mid-scan got prompted again. iOS suspends
// camera capture while a page is hidden anyway, so keeping the (muted) stream
// costs nothing; it is released after a grace window if the user stays away,
// and by pagehide/releaseAll when the app really closes.
const CAM_HIDE_GRACE_MS = 60000;
let camReleaseT = 0;
document.addEventListener("visibilitychange", ()=>{
  if (document.hidden){
    pauseWork();
    flushPersistDoc();                 // don't lose a pending save if iOS kills us
    scanWasLive = !!scanStream;        // remember to relight the camera on return
    if (scanStream){
      pauseCamera();                   // stop the detect loop; KEEP the stream
      clearTimeout(camReleaseT);
      camReleaseT = setTimeout(()=>{ camReleaseT = 0;
        if (document.hidden) stopCamera();   // long absence → release (privacy/battery)
      }, CAM_HIDE_GRACE_MS);
    }
  } else {
    resumeWork();
    if (camReleaseT){ clearTimeout(camReleaseT); camReleaseT = 0; }
    // resumeCamera reuses the still-live stream (no permission prompt); if iOS
    // ended the track while hidden it falls back to a fresh startCamera().
    if (scanWasLive && $("scanCam").classList.contains("show")) resumeCamera();
    scanWasLive = false;
  }
});
// pagehide fires when the installed app is closed or navigated away from.
window.addEventListener("pagehide", releaseAll);
// If the OS restores the page from the back/forward cache, rebuild the engine.
window.addEventListener("pageshow", (e)=>{
  if (e.persisted && workingBytes && !MDOC){ reopen(); render(); }
});

// ---------------- session restore (runs once at startup) ----------------
// If a document or an unfinished scan was persisted before the app was killed,
// offer to bring it back. Never auto-restores — the user chooses.
(async function restoreSession(){
  let doc=null, scan=null, scanSaved=null;
  try {
    doc = await idbGet("doc"); scan = await idbGet("scan");
    if (scan && scan.pages && scan.pages.length) scanSaved = scan.pages;   // legacy format
    else if (scan && scan.count){
      scanSaved = [];
      for (let i=0;i<scan.count;i++){ const p = await idbGet("scan:p"+i); if (p) scanSaved.push(p); }
      if (!scanSaved.length) scanSaved = null;
    }
  } catch(e){ return; }
  const hasDoc  = !!(doc && doc.bytes && doc.bytes.length);
  const hasScan = !!scanSaved;
  if (!hasDoc && !hasScan) return;
  if (workingBytes) return;                  // user already opened something
  if (window.__pypdfHadPendingFile) return;  // an early-picked file is opening
  const rows = [];
  if (hasDoc)  rows.push(h`<div class="row"><button class="full" id="rsDoc">Restore “${doc.name}” (${fmtKB(doc.bytes.length)})</button></div>`);
  if (hasScan) rows.push(h`<div class="row"><button class="full" id="rsScan">Continue scan (${scanSaved.length} page${scanSaved.length>1?"s":""})</button></div>`);
  $("sheet").innerHTML = h`
    <h3>Restore previous session?</h3>
    <p class="hint">Unsaved work from last time was kept on this device. Bring it back, or discard it.</p>
    ${raw(rows.join(""))}
    <div class="row"><button class="ghost full" id="rsDrop">Discard saved session</button></div>
    <div class="row"><button class="ghost full" id="rsLater">Not now</button></div>`;
  if (hasDoc) $("rsDoc").onclick = async ()=>{
    closeSheet();
    // carry the scan along too — track its existing storage so a later clear
    // removes the right per-page keys
    if (hasScan){ scanPages = scanSaved; scanPersistPrev = scanSaved.slice(); }
    showSpin(true,"Restoring document…");
    try { await openBytes(doc.bytes, doc.name); setDirty(doc.dirty !== false); }
    catch(e){ setStatus("Could not restore it: "+friendly(e),"err"); }
    showSpin(false);
  };
  if (hasScan) $("rsScan").onclick = ()=>{
    closeSheet();
    scanPages = scanSaved;
    scanPersistPrev = scanSaved.slice();     // so persistScan/clear knows the existing keys
    startScan();                             // startScan keeps restored pages
  };
  $("rsDrop").onclick = ()=>{
    closeSheet();
    try { idbDel("doc").catch(()=>{}); dropScanStorage(scan && scan.count ? scan.count : (scanSaved?scanSaved.length:0)); } catch(e){}
    setStatus("Saved session discarded.","ok");
  };
  $("rsLater").onclick = closeSheet;
  openSheet();
})();

// service worker
if ("serviceWorker" in navigator)
  window.addEventListener("load", ()=> navigator.serviceWorker.register("./sw.js").catch(()=>{}));

// welcome screen: show recent files (no-op once a document is open)
renderRecents();

// v10.91: track the reading position (throttled inside saveViewState)
$("viewer").addEventListener("scroll", saveViewState, { passive:true });

// one-line "what's new" the first launch after an update, so updates are
// visible instead of silent. Shown a beat after boot so the engine-ready
// status has already settled; skipped entirely on a brand-new install.
try {
  const seen = localStorage.getItem("pypdf-seen-build");
  localStorage.setItem("pypdf-seen-build", APP_BUILD);
  if (seen && seen !== APP_BUILD)
    setTimeout(()=>{ setStatus("Updated to v"+APP_BUILD+" — "+WHATS_NEW,"ok"); }, 3500);
} catch(e){}
