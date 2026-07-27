"use strict";
import * as mupdf from "./vendor/mupdf/mupdf.js";
// shared scanner pixel math + edge detection (also imported by the scan worker
// — one source of truth for the warp, filters and document edge detection)
// NOTE: keep this on ONE line. tests/harness.mjs and tests/scenario-tests.mjs
// evaluate app.js by stripping `^import .*$` line by line, so a wrapped import
// statement leaves a dangling `... } from "./scan-core.js";` behind.
import { warpCore, colourBalanceCore, detectQuad, flattenIllumination, documentEnhance, idCardEnhance, autoCaptureReady, quadMaxCornerShift, AUTO } from "./scan-core.js";

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
const APP_BUILD = "11.38";
(function buildGuard(){
  const pageBuild = document.documentElement.getAttribute("data-build") || "pre-9.2";
  const need = ["openBtn","moreBtn","signBtn","unlockBtn","undoBtn","status","sheet","sheetBg","spin","bigOpen","bigScan","welcomeHint","loupe","pageWrap","pagePill","closeBtn",
    "scanCam","scanShot","scanCancel","scanDone","scanThumbs","torchBtn",
    "scanCrop","cropPoly","g0","g1","g2","g3","h0","h1","h2","h3","qStd","qSmall","enhToggle","idToggle","cropReset","cropRetake","cropUse",
    "autoBtn","paperBtn","idBothToggle",
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
const BUILD_DATETIME = "27 Jul 2026";   // v11.38
// One-line release note shown once after an update (keep in sync with APP_BUILD,
// so the banner never describes an older release).
const WHATS_NEW = "you can now sign with your finger instead of hunting for a photo of your signature, and the app remembers it for next time.";
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
let mode = null;               // null | "sign" | "text" | "select"
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
  $("rcClear").onclick = async ()=>{
    try { for (const r of await recentsGet()) idbDel(r.id).catch(()=>{}); await idbDel("recents"); } catch(e){}
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
  for (const id of ["textBtn","selectBtn","signBtn","compBtn","saveBtn","closeBtn","pagesBtn","markupBtn","findBtn"]) $(id).disabled = !has;
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
  let wasEncrypted = false;
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
    probe.destroy();
    if (!isPdf){ showSpin(false); setStatus("That file isn’t a PDF, so it can’t be unlocked.","err"); return; }
    if (!isProtected){ showSpin(false); setStatus("“"+f.name+"” isn’t password-protected — there’s nothing to remove.","warn"); return; }
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
    const usePng = !bigDoc && rasterMax <= 2800 && docHasText();
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
    else if (mode === "select") buildTextLayer(stage, i);
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
    if (!sp.text) continue;
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
  // Paragraph mode is the default WHEN there is a paragraph, because that is
  // almost always what someone means by "edit this text"; the single-line
  // behaviour is one tap away and is still what a form field gets.
  let asBlock = canBlock;
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
          <button class="segb${asBlock?" on":""}" data-v="1">Whole paragraph</button>
          <button class="segb${asBlock?"":" on"}" data-v="0">This line only</button>
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
async function applyBlockEdit(pageIndex, block, newText, opts){
  opts = opts || {};
  showSpin(true, "Editing paragraph…");
  try {
    pushUndo();
    const first = block.lines[0];
    const bg    = sampleSpanBg(pageIndex, first);
    const fres  = (opts.font && opts.font !== "keep") ? null : capturePdfFont(pageIndex, first.font);
    const align = blockAlignFor(pageIndex, first);
    const bands = block.lines.map(l=> redactBandFor(pageIndex, l));

    // 1) erase every line of the paragraph in ONE redaction pass
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
    const nearWhite = bg && bg.r>=245 && bg.g>=245 && bg.b>=245;
    const fillCol = (bg && bg.uniform && !nearWhite)
                  ? rgb(bg.r/255, bg.g/255, bg.b/255) : rgb(1,1,1);
    for (const b of bands)
      pg.drawRectangle({ x:b[0], y:H-b[3], width:b[2]-b[0], height:b[3]-b[1], color:fillCol });

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
    const fres = (opts.font && opts.font !== "keep") ? null : capturePdfFont(pageIndex, sp.font);
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
    const nearWhite = bg && bg.r>=245 && bg.g>=245 && bg.b>=245;
    const fillCol = (bg && bg.uniform && !nearWhite)
                  ? rgb(bg.r/255, bg.g/255, bg.b/255) : rgb(1,1,1);
    pg.drawRectangle({ x:band[0], y:H-band[3], width:band[2]-band[0], height:band[3]-band[1], color:fillCol });
    // a text span is a single line; collapse any newlines the user typed so the
    // replacement stays on that line and can't flow downward past where the
    // original sat (and over the content below it)
    const text = (newText||"").replace(/[\r\n]+/g, " ");
    let substituted = false;
    if (text.trim() !== ""){
      // v11.37: the sheet can override size and colour. Both default to the
      // original, so an edit that touches neither is byte-identical to v11.36.
      const baseSize = opts.size != null ? opts.size : (sp.size || 11);
      const colour = opts.colour || sp.color || [0,0,0];
      const y = H - sp.origin[1];                       // baseline never moves
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

// ---------------- modes ----------------
function setMode(m){
  mode = m;
  if (m) lastMarkupMode = m;           // v11.22: remember preferred tool for the session
  if (m && SEARCH.open) closeFind();   // v11.19: entering a mode closes search
  setImmersive(false);           // v11.10: entering any mode brings the chrome back
  $("textBtn").classList.toggle("on", m==="text");
  $("selectBtn").classList.toggle("on", m==="select");
  $("signBtn").classList.toggle("on", m==="sign");
  ["textBtn","selectBtn","signBtn"].forEach(id=>$(id).classList.remove("pref"));  // v11.22
  $("markupBtn").classList.toggle("on", !!m);    // v11.11: bar shows a mode is active
  $("mkMenu").hidden = true;
  $("viewer").classList.toggle("textmode", m==="text");
  $("viewer").classList.toggle("selmode", m==="select");
  document.querySelectorAll(".stage").forEach(s=>s.classList.toggle("placing", m==="sign"));
  if (m==="text"){
    // buildSpanBoxes is async; contain any rejection (e.g. a page that mupdf
    // can't read in a malformed PDF) so it never escapes as an uncaught
    // "Async error" — text editing simply skips that page.
    document.querySelectorAll(".stage").forEach(s=>{
      if (s.dataset.rendered) buildSpanBoxes(s, +s.dataset.page).catch(()=>{});
    });
    setStatus("Tap any highlighted text to change it.","ok");
  } else if (m==="select"){
    // build the invisible selectable text layer over every already-rendered
    // page; pages scrolled into view later get theirs in renderStage
    document.querySelectorAll(".stage").forEach(s=>{
      if (s.dataset.rendered) try { buildTextLayer(s, +s.dataset.page); } catch(e){}
    });
    setStatus("Select any text, then copy it.","ok");
  } else if (m==="sign"){ setStatus("Drag a box where the signature should go.","ok"); }
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

$("textBtn").onclick = ()=> setMode(mode==="text" ? null : "text");
$("selectBtn").onclick = ()=> setMode(mode==="select" ? null : "select");
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
    if (mode!=="sign") return;
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
    await placeSignature(pageIndex, px/s, py/s, pw/s, ph/s);
  });
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
    reopen(); setMode(null); await render();
    setStatus("Signature placed on page "+(pageIndex+1)+".","ok");
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
    </div>
    <div class="mgrp-l">Document</div>
    <div class="mgrid">
      <button class="mtile" id="mComp" ${d}>${ic("compress")}<span>Compress</span></button>
      <button class="mtile" id="mUnlock">${ic("unlock")}<span>Unlock a PDF</span></button>
      <button class="mtile" id="mPng" ${d}>${ic("download")}<span>Save image</span></button>
    </div>
    <div class="mgrid mgrid2 mt12">
      <button class="mtile" id="mAbout">${ic("info")}<span>About</span></button>
      <button class="mtile" id="mClose">${ic("close")}<span>Cancel</span></button>
    </div>`;
  $("mScan").onclick  = ()=>{ closeSheet(); startScan(false); };
  $("mScanAdd").onclick = ()=>{ closeSheet(); if (workingBytes) startScan(true); };
  $("mOrg").onclick   = ()=>{ closeSheet(); openOrganise(); };
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
    <div class="row mt8"><button class="ghost full" id="abClose">Close</button></div>`;
  $("abClose").onclick = closeSheet;
  openSheet();
}

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

// ---------------- all pages: Preview-style thumbnail grid (v11.10) ----------------
// A near-full-height sheet with every page as a thumbnail. Tap a page to jump
// to it; Select mode allows rotate / copy-to-new-PDF / delete on a selection.
// Reordering keeps its dedicated Organize sheet (drag needs the row layout).
function openPagesGrid(keepSel){
  if (!workingBytes || !MDOC) return;
  const n = MDOC.countPages();
  let selecting = !!(keepSel && keepSel.size);
  const sel = new Set(keepSel || []);
  function draw(){
    const cells = Array.from({length:n},(_,i)=> h`<button class="pgcell ${sel.has(i)?'sel':''}" data-pg="${i}"
        aria-label="Page ${i+1}${sel.has(i)?', selected':''}">
        <img data-pthumb="${i}" alt="">
        <span class="pgnum">${i+1}</span>
      </button>`).join("");
    const acts = selecting ? h`<div class="pgacts">
        <button class="ghost" id="pgRot" ${sel.size?"":"disabled"}>⟳ Rotate</button>
        <button class="ghost" id="pgExt" ${sel.size?"":"disabled"}>Copy</button>
        <button class="ghost danger" id="pgDel" ${sel.size?"":"disabled"}>Delete</button>
      </div>` : "";
    $("sheet").innerHTML = h`
      <div class="pghead">
        <button class="ghost mini" id="pgDone">Done</button>
        <h3 class="pgttl">All pages</h3>
        <button class="ghost mini" id="pgSel">${selecting ? "Cancel" : "Select"}</button>
      </div>
      <div class="pggrid">${raw(cells)}</div>${raw(acts)}`;
    $("sheet").classList.add("fullpage");
    $("pagesBtn").classList.add("on");     // v11.14: bar shows Pages is open
    $("pgDone").onclick = closeSheet;
    $("pgSel").onclick = ()=>{ selecting = !selecting; sel.clear(); draw(); };
    $("sheet").querySelectorAll("[data-pg]").forEach(b=>b.onclick = ()=>{
      const i = +b.dataset.pg;
      if (!selecting){ closeSheet(); scrollToPage(i); return; }
      sel.has(i) ? sel.delete(i) : sel.add(i);
      draw();
    });
    if (selecting){
      const ident = ()=>Array.from({length:MDOC.countPages()},(_,i)=>i);
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
let scanQuality = "std";      // "std" | "small" — JPEG quality + output size
try { if (localStorage.getItem("scanQuality")==="small") scanQuality="small"; } catch(e){}
let scanEnhance = true;       // "Whiten": flatten illumination so paper reads white
try { if (localStorage.getItem("scanEnhance")==="0") scanEnhance=false; } catch(e){}
let scanIdMode = false;       // v10.79 "Photo ID": light, colour-true card placed on a white A4 page
try { if (localStorage.getItem("scanIdMode")==="1") scanIdMode=true; } catch(e){}
// v11.32 auto capture. ON by default — it is the faster path for the common
// case (a stack of pages on a desk) and the shutter is still there for anyone
// who wants to frame a shot deliberately. Persisted, so the choice sticks.
let scanAuto = true;
try { if (localStorage.getItem("scanAuto")==="0") scanAuto=false; } catch(e){}
// v11.33 output paper size for scanned pages. "auto" keeps the captured shape
// (the pre-v11.33 behaviour) and is deliberately NOT the default: a scan of an
// A4 sheet should come out A4 so it prints with even margins and merges
// cleanly with born-digital pages.
let scanPaper = "a4";
try { const p=localStorage.getItem("scanPaper"); if (p && PAPER_SIZES[p]) scanPaper=p; } catch(e){}
// v11.34 "Both sides": front and back of one card composited onto a single A4
// page. Declared here with the rest of the scanner state because the toggle is
// wired up (and refreshed) further down the file, well before the compositing
// code that uses it — a `let` beside that code would be in its dead zone.
let idTwoSide = false;
try { if (localStorage.getItem("scanIdTwoSide")==="1") idTwoSide=true; } catch(e){}
let idPendingCard = null;     // canvas of side 1, held until side 2 arrives
// v10.74: std now warps to a larger long side (was 2560) so the higher-res 4K
// capture keeps its detail instead of being shrunk away. File size is held in
// check by encodeUnderBudget() (size-budgeted adaptive JPEG) rather than a
// fixed quality, so sparse document pages stay well under ~1.45 MB while dense
// pages settle to a slightly lower quality automatically. "small" is unchanged.
const SCAN_Q = { std:{ jpeg:0.92, maxDim:3200, budget:1400000, qFloor:0.78 },
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
  capFrame = null; scanFallback = false;
  scanAppendTo = (append && workingBytes) ? { name: fileName } : null;
  idPendingCard = null;
  disarmAuto(); autoBusy = false; autoNeedsRelease = false;
  refreshAutoBtn(); refreshPaperBtn(); refreshIdTwoSideBtn();
  updateScanCount();
  $("scanCrop").classList.remove("show");
  $("scanCam").classList.add("show");
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
  await startCamera();
}
function endScan(){
  stopCamera();
  scanPages = []; capFrame = null;
  scanAppendTo = null;           // v11.35: forget any append target
  idPendingCard = null;          // v11.34: drop a half-finished card pair
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
  strip.classList.toggle("has", scanPages.length>0);
  strip.innerHTML = scanPages.map((p,i)=>
    h`<button class="sthumb" data-pg="${i}" aria-label="Review scanned page ${i+1}"><img src="${p.thumb}" alt="Page ${i+1}"><span class="num">${i+1}</span></button>`).join("");
  strip.querySelectorAll("[data-pg]").forEach(b=>{
    const i = +b.dataset.pg;
    b.onclick = ()=> openScanPageSheet(i);
    // v11.33: show the page's rotation on its thumbnail. Set through the CSSOM,
    // not a style attribute — the CSP is style-src 'self' with no unsafe-inline.
    const r = normaliseRot(scanPages[i] && scanPages[i].rot);
    const im = b.querySelector("img");
    if (im && r) im.style.transform = "rotate("+r+"deg)";
  });
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
  $("pgClose").onclick=done;
  openSheet();
  sheetOnDismiss = ()=>{ try{ URL.revokeObjectURL(url); }catch(e){} };  // backdrop/Esc: don't leak the blob URL
}

// ---- camera ----
async function startCamera(){
  stopCamera();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){ enterFallback(); return; }
  // v10.74: request the full sensor resolution the device can give. iPhone Pro
  // models stream up to 4K (3840×2160) — ~2.25× the pixels of the old 1440p
  // request — which is the single biggest driver of scan sharpness (the warp +
  // filters were never the bottleneck; capture resolution was). We try 4K first
  // and walk down a fallback chain so older/locked-down devices still get a
  // stream. `continuous` focus keeps handheld captures crisp.
  const camTries = [
    { facingMode:{ideal:"environment"}, width:{ideal:3840}, height:{ideal:2160}, focusMode:"continuous" },
    { facingMode:{ideal:"environment"}, width:{ideal:2560}, height:{ideal:1440} },
    { facingMode:{ideal:"environment"} }
  ];
  scanStream = null;
  for (const v of camTries){
    try { scanStream = await navigator.mediaDevices.getUserMedia({ audio:false, video:v }); break; }
    catch(e){ /* try the next, less-demanding constraint set */ }
  }
  if (!scanStream){ enterFallback(); return; }
  const v = $("scanVideo");
  v.srcObject = scanStream;
  try { await v.play(); } catch(e){ /* autoplay is allowed: muted+playsinline */ }
  sizeQuadCanvas();
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
  const v = $("scanVideo"); v.srcObject = null;
  const q = $("scanQuad");
  if (q.width) q.getContext("2d").clearRect(0,0,q.width,q.height);
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
  const track = (scanStream && scanStream.getVideoTracks) ? scanStream.getVideoTracks()[0] : null;
  if (track && track.readyState === "live"){
    const v = $("scanVideo");
    if (v.srcObject !== scanStream) v.srcObject = scanStream;
    try { await v.play(); } catch(e){}
    sizeQuadCanvas();
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
const AUTO_HOLD_MS = 900;      // steady-hold before firing (on top of the ~0.9s lock)
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
  autoWhy = ""; autoWhyRun = 0;
  if (!autoArmedAt){ autoArmedAt = Date.now(); startAutoRing(); }
  autoProgress = Math.min(1, (Date.now()-autoArmedAt)/AUTO_HOLD_MS);
  if (autoProgress >= 1){
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
    const q = insetQuad(orderQuad(liveQuad.map(p=>({x:p.x,y:p.y}))), 0.008);
    const c = document.createElement("canvas");
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext("2d").drawImage(v,0,0);
    flashCapture();
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
  const q = detectQuad(ctx.getImageData(0,0,sw,sh));
  return q ? q.map(p=>({x:p.x/s, y:p.y/s})) : null;   // → video px
}
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
    const s = Math.min(1, 3200/Math.max(im.naturalWidth, im.naturalHeight));
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
function autoDetectCropQuad(){
  const frame = capFrame;
  const s = 520/Math.max(frame.width, frame.height);  // v10.20: finer edges for low-contrast docs
  const sw=Math.max(2,Math.round(frame.width*s)), sh=Math.max(2,Math.round(frame.height*s));
  const ctx = scratch(sw,sh).getContext("2d",{willReadFrequently:true});
  ctx.drawImage(frame,0,0,sw,sh);
  let q = detectQuad(ctx.getImageData(0,0,sw,sh));
  const found = !!q;
  if (q) q = q.map(p=>({x:p.x/s, y:p.y/s}));
  else {
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

// output size: Standard (sharp) or Small file (lighter PDFs)
try { if (scanQuality==="small"){ $("qStd").classList.remove("on"); $("qSmall").classList.add("on"); } } catch(e){}
$("qStd").onclick   = ()=> setScanQuality("std");
$("qSmall").onclick = ()=> setScanQuality("small");
function setScanQuality(q){
  if (scanQuality===q) return;
  scanQuality=q;
  try { localStorage.setItem("scanQuality", q); } catch(e){}
  $("qStd").classList.toggle("on", q==="std");
  $("qSmall").classList.toggle("on", q==="small");
}
// "Whiten": flatten illumination so shadowed/crumpled paper reads as white. An
// independent on/off toggle (not part of the size choice). Re-renders the crop
// preview so you can compare before tapping Use page.
try { $("enhToggle").classList.toggle("on", scanEnhance); $("enhToggle").setAttribute("aria-pressed", String(scanEnhance)); } catch(e){}
$("enhToggle").onclick = ()=> setScanEnhance(!scanEnhance);
function setScanEnhance(on){
  scanEnhance = !!on;
  try { localStorage.setItem("scanEnhance", scanEnhance ? "1" : "0"); } catch(e){}
  $("enhToggle").classList.toggle("on", scanEnhance);
  $("enhToggle").setAttribute("aria-pressed", String(scanEnhance));
  renderCropPreview();
}
// "Photo ID": treat the selected region as an ID/photo card — process it light and
// colour-true (no ink-deepen/whiten) and drop it onto a clean white A4 page, like
// a flatbed ID scan. Mutually exclusive with Whiten (the document polish).
try { $("idToggle").classList.toggle("on", scanIdMode); $("idToggle").setAttribute("aria-pressed", String(scanIdMode)); } catch(e){}
$("idToggle").onclick = ()=> setScanIdMode(!scanIdMode);
function setScanIdMode(on){
  scanIdMode = !!on;
  try { localStorage.setItem("scanIdMode", scanIdMode ? "1" : "0"); } catch(e){}
  $("idToggle").classList.toggle("on", scanIdMode);
  $("idToggle").setAttribute("aria-pressed", String(scanIdMode));
  if (scanIdMode){            // Whiten/document polish would fight the ID look
    scanEnhance = false;
    try { localStorage.setItem("scanEnhance","0"); } catch(e){}
    $("enhToggle").classList.toggle("on", false);
    $("enhToggle").setAttribute("aria-pressed","false");
    setStatus(idTwoSide
      ? "Photo ID, both sides: scan the front, then the back — they go on one A4 page."
      : "Photo ID mode: the card will be placed on a white A4 page. Frame just the card.","ok");
  } else {
    clearIdPending(true);     // leaving ID mode abandons any held front side
  }
  refreshIdTwoSideBtn();
  renderCropPreview();
}
// v11.34: "Both sides" — only relevant inside Photo ID mode, so it is hidden
// rather than merely disabled when ID mode is off. Hiding it also keeps the
// filter row from wrapping to a third line on a small phone.
function refreshIdTwoSideBtn(){
  const b = $("idBothToggle"); if (!b) return;
  b.hidden = !scanIdMode;
  b.classList.toggle("on", idTwoSide);
  b.setAttribute("aria-pressed", String(idTwoSide));
}
$("idBothToggle").onclick = ()=> setIdTwoSide(!idTwoSide);
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
$("paperBtn").onclick = ()=>{
  const order = ["a4","letter","legal","auto"];
  setScanPaper(order[(order.indexOf(scanPaper)+1) % order.length]);
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
  b.textContent = paperLabel(scanPaper);
  b.classList.toggle("on", scanPaper !== "auto");
}
refreshPaperBtn();

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
    capFrame = null;
    if (returnToCamera){
      $("scanCrop").classList.remove("show");
      $("scanCam").classList.add("show");
      if (!scanFallback) resumeCamera();
    }
    updateScanCount();          // refreshes the "side 1 held" hint
    setStatus("Front captured. Turn the card over and scan the back.","ok");
    return null;
  }
  const page = compositeCardsOnA4([idPendingCard, card]);
  idPendingCard = null;
  return page;
}
// Drop a half-finished card pair. Called when ID mode or the two-side toggle is
// switched off and when the scan session ends, so a stale side can never be
// silently welded onto an unrelated card later.
function clearIdPending(quiet){
  if (!idPendingCard) return;
  idPendingCard = null;
  updateScanCount();
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
  const Q = SCAN_Q[scanQuality] || SCAN_Q.std;
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
    c=document.createElement("canvas"); c.width=out.width; c.height=out.height;
    c.getContext("2d").putImageData(out,0,0);
  }
  await pushScanPage(c, out.width, out.height);
  capFrame=null;
  updateScanCount();
  if (returnToCamera){
    $("scanCrop").classList.remove("show");
    $("scanCam").classList.add("show");
    if (!scanFallback) await resumeCamera();
  }
  setStatus("Page "+scanPages.length+" added — "
    + (scanAuto && !returnToCamera ? "hold the camera over the next one."
                                   : "scan the next page or tap Create PDF."), "ok");
}
// encode + record one finished page canvas
async function pushScanPage(c, w, h){
  const QQ = SCAN_Q[scanQuality] || SCAN_Q.std;
  const blob = await encodeScanJpeg(c, QQ.jpeg, QQ.budget, QQ.qFloor);
  // small thumbnail (112px tall ≈ 56 css px at 2×) for the review strip
  const tc=document.createElement("canvas");
  tc.height=112; tc.width=Math.max(8,Math.round(w*112/h));
  tc.getContext("2d").drawImage(c,0,0,tc.width,tc.height);
  scanPages.push({ bytes:new Uint8Array(await blob.arrayBuffer()), w, h,
                   thumb:tc.toDataURL("image/jpeg",0.7), rot:0 });
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
async function createScanPdf(){
  if (!scanPages.length) return;
  const pages=scanPages.slice();
  endScan();
  showSpin(true,"Creating PDF from "+pages.length+" page(s)…");
  try {
    const doc=await PDFDocument.create();
    for (const p of pages) await addScanPageTo(doc, p);
    workingBytes=new Uint8Array(await doc.save());
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
$("saveBtn").onclick = ()=> openSaveSheet();

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
    <div class="row"><button class="full" id="cpHigh">High quality — pictures at 200 dpi</button></div>
    <div class="row"><button class="full" id="cpMed">Balanced — pictures at 150 dpi</button></div>
    <div class="row"><button class="full" id="cpLow">Smallest — pictures at 110 dpi</button></div>
    <div class="row"><button class="ghost full" id="cpCancel">Cancel</button></div>`;
  $("cpHigh").onclick = ()=>{ closeSheet(); runCompress("high"); };
  $("cpMed").onclick  = ()=>{ closeSheet(); runCompress("medium"); };
  $("cpLow").onclick  = ()=>{ closeSheet(); runCompress("low"); };
  $("cpCancel").onclick = closeSheet;
  openSheet();
};

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
      if (!t && filtName === "DCTDecode") continue;
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

// Roughly how much real, extractable text the document has, sampled across the
// first few pages. A scanned / image-only PDF returns ~0; a born-digital text
// page returns hundreds. Used to protect text PDFs from being silently
// rasterised by Compress. Cheap: stops as soon as the threshold is reached.
// cached "does this document have real text?" — sampled once per epoch and
// reused by the render path (PNG vs JPEG choice) and compress
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
async function runCompress(level){
  const cfg=COMPRESS[level], before=workingBytes.length;
  showSpin(true,"Compressing…");
  let imgRep = null;
  try {
    // 1) Lossless structural pass. Cheap, safe, and on some files enough on its
    //    own. It does not mutate MDOC or workingBytes, so we can still decide
    //    what to do before committing — and before taking the Undo snapshot,
    //    which keeps peak memory down.
    let best = u8(MDOC.saveToBuffer("compress,compress-images,compress-fonts,garbage").asUint8Array());
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
            const cand = u8(work.saveToBuffer("compress,compress-fonts,garbage").asUint8Array());
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
