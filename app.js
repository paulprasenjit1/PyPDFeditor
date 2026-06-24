"use strict";
import * as mupdf from "./vendor/mupdf/mupdf.js";
// shared scanner pixel math + edge detection (also imported by the scan worker
// — one source of truth for the warp, filters and document edge detection)
import { warpCore, colourBalanceCore, detectQuad, flattenIllumination } from "./scan-core.js";

const $ = id => document.getElementById(id);
const PDFLib = window.PDFLib;

// ---------------- build guard (with self-heal) ----------------
// If index.html and app.js come from different builds (stale HTTP/CDN copy,
// missed upload), wiring would crash silently and buttons would appear
// "frozen". Detect it, then: first occurrence per session → purge every cache,
// unregister the service worker and reload (heals a stale DEVICE copy).
// If it happens again right after healing, the SERVER itself is serving an old
// index.html — say so explicitly, since no amount of device clearing fixes that.
const APP_BUILD = "10.59";
(function buildGuard(){
  const pageBuild = document.documentElement.getAttribute("data-build") || "pre-9.2";
  const need = ["openBtn","moreBtn","signBtn","unlockBtn","undoBtn","status","sheet","sheetBg","spin","bigOpen","bigScan","welcomeHint","loupe","pageWrap","pagePill","closeBtn",
    "scanCam","scanShot","scanCancel","scanDone","scanThumbs","torchBtn",
    "scanCrop","cropPoly","g0","g1","g2","g3","h0","h1","h2","h3","qStd","qSmall","enhToggle","cropReset","cropRetake","cropUse"];
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
    localStorage.setItem("pypdf-errlog", JSON.stringify(log.slice(0,3)));
  } catch(e){}
  try { setStatus(text+" — the app keeps running; if something stops working, close and reopen it.", "err"); } catch(e){}
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
const BUILD_DATETIME = "24 Jun 2026";
const { PDFDocument, StandardFonts, rgb, degrees } = PDFLib;

// ---------------- state ----------------
let workingBytes = null;       // Uint8Array — single source of truth
let MDOC = null;               // live mupdf PDFDocument for the current bytes
let epoch = 0;                 // bumps on every change (invalidates caches)
let fileName = "document.pdf";
let zoomPct = 100;             // 50–300, 25% steps; 100% = fit to viewer width
let mergeSources = null;       // staged docs awaiting a chosen merge order
let signImgDataUrl = null;     // processed signature PNG dataURL
let mode = null;               // null | "sign" | "text" | "select"
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
  download:'<path d="M12 4v10M8 11l4 4l4 -4"/><path d="M5 19h14"/>',
  info:    '<path d="M12 21a9 9 0 1 0 0 -18a9 9 0 0 0 0 18z"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
  search:  '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4 -4"/>'
};
function ic(name){
  return raw('<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">' + (ICONS[name]||"") + '</svg>');
}
// Strip path separators / control chars from a download file name.
function safeFileName(n){
  return String(n||"document.pdf").replace(/[\/\\\x00-\x1f]/g,"_").slice(0,128) || "document.pdf";
}

function setStatus(msg, cls=""){ const s=$("status"); s.textContent=msg; s.className="status "+cls; }
// Translate raw engine errors into plain language. The raw message is kept in
// the on-device error log (More → About) for diagnosis.
function friendly(err){
  const m = String((err && err.message) || err || "");
  try {
    const log = JSON.parse(localStorage.getItem("pypdf-errlog")||"[]");
    log.unshift(new Date().toISOString().slice(0,16).replace("T"," ")+" "+scrubForLog(m).slice(0,120));
    localStorage.setItem("pypdf-errlog", JSON.stringify(log.slice(0,3)));
  } catch(e){}
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
  $("welcomeHint").textContent = "Everything stays on your phone — nothing is uploaded.";
  $("meta").textContent = "No document open";
  setStatus("Ready. Open a PDF or scan a document.", "ok");
  // tell the engine-load watchdog the engine is live, so it cancels its timer
  window.__pypdfEngineReady = true;
  try { window.dispatchEvent(new Event("pypdf-engine-ready")); } catch(e){}
})();
$("bigOpen").onclick = ()=> confirmDiscard("open another PDF", ()=>$("fileInput").click());
$("bigScan").onclick = ()=> startScan();

// ---------------- session persistence (IndexedDB, on-device only) ----------------
// The working document and any in-progress scan survive iOS evicting the PWA.
// Everything is wrapped in try/catch so private-browsing modes that block
// storage can never break the app. Password-unlocked PDFs are NEVER persisted
// (the decrypted copy must not outlive the session).
const DB_NAME="pypdf-state", DB_STORE="kv";
let docSensitive = false;     // true when the open doc came from a password unlock
let dirty = false;            // true when the document has changes not yet Saved

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
// very large documents are not auto-persisted: cloning ~100MB to storage on
// every change caused multi-second stalls and memory spikes. The original
// file already exists in Files, so nothing is lost — only session-restore.
const PERSIST_MAX_BYTES = 25*1024*1024;
function persistDocNow(){
  persistT=0;
  try {
    if (workingBytes && !docSensitive && workingBytes.length <= PERSIST_MAX_BYTES)
      idbSet("doc",{ name:fileName, bytes:workingBytes, ts:Date.now(), dirty }).catch(()=>{});
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
      idbSet("scan:p"+i, scanPages[i]).catch(()=>{});
    idbSet("scan", { count:scanPages.length, ts:Date.now() }).catch(()=>{});
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

// ---------------- mupdf doc lifecycle ----------------
function closeDoc(){ if (MDOC){ try{ MDOC.destroy(); }catch(e){} MDOC=null; } }
function reopen(){
  closeDoc();
  // mupdf reads the buffer up front; hand it a fresh copy so workingBytes stays intact
  MDOC = mupdf.Document.openDocument(workingBytes.slice(0), "application/pdf").asPDF();
  epoch++;
  spanCache.clear();
  schedulePersistDoc();        // every byte change flows through here
  // an edit changes the bytes → previously found matches are stale. Re-run the
  // search against the new document so highlights and the count stay correct.
  if (SEARCH.open && SEARCH.needle) runFind(SEARCH.needle);
}

function enableDocButtons(has){
  for (const id of ["textBtn","selectBtn","signBtn","compBtn","saveBtn","closeBtn"]) $(id).disabled = !has;
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
async function setZoom(newPct, anchorX, anchorY){
  newPct = Math.max(50, Math.min(300, Math.round(newPct/5)*5));
  if (newPct === zoomPct || !workingBytes || zooming){ refreshZoomButtons(); return; }
  zooming = true;
  const v = $("viewer"), r = v.getBoundingClientRect();
  const ax = (anchorX==null ? r.width/2  : anchorX - r.left);
  const ay = (anchorY==null ? r.height/2 : anchorY - r.top);
  const ratio = newPct / zoomPct;
  const sx = v.scrollLeft, sy = v.scrollTop;
  zoomPct = newPct;
  $("zoomLbl").textContent = zoomPct + "%";
  refreshZoomButtons();
  await render();
  v.scrollLeft = (sx + ax) * ratio - ax;
  v.scrollTop  = (sy + ay) * ratio - ay;
  zooming = false;
}
function applyZoom(delta){ setZoom(zoomPct + delta); }
// On phones (<600px) the − / + buttons are hidden, so the hint must point at the
// gestures that actually work there; tablets/desktop keep the buttons.
function zoomTip(){
  const phone = (typeof window.matchMedia === "function") && window.matchMedia("(max-width:599px)").matches;
  return phone ? "Pinch or double-tap to zoom." : "Pinch or use − / + to zoom.";
}
$("undoBtn").onclick = ()=> doUndo();
$("closeBtn").onclick = ()=> confirmDiscard("close this PDF", closeFile);
$("zoomOut").onclick = ()=> applyZoom(-25);
$("zoomIn").onclick  = ()=> applyZoom(25);

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
    $("zoomLbl").textContent = Math.round(zoomPct*k)+"%";
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

  // double-tap: toggle 100% <-> 200%, centred on the tap
  v.addEventListener("touchend", (e)=>{
    if (pinch || mode || !workingBytes) return;
    if (e.touches.length || e.changedTouches.length!==1) return;
    const t = e.changedTouches[0], now = Date.now();
    if (now-lastTap < 300 && Math.hypot(t.clientX-lastX, t.clientY-lastY) < 30){
      lastTap = 0;
      e.preventDefault();
      setZoom(zoomPct===100 ? 200 : 100, t.clientX, t.clientY);
    } else { lastTap = now; lastX = t.clientX; lastY = t.clientY; }
  });
})();

// ---------------- open (with password support) ----------------
$("openBtn").onclick = ()=> confirmDiscard("open another PDF", ()=>$("fileInput").click());
$("fileInput").onchange = async e=>{
  const f=e.target.files[0]; if(!f) return;
  showSpin(true,"Opening "+f.name+" …"); setStatus("Opening "+f.name+" …");
  try { await openBytes(new Uint8Array(await f.arrayBuffer()), f.name); }
  catch(err){ setStatus("Could not open: "+friendly(err),"err"); }
  showSpin(false); e.target.value="";
};

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
  dirty = false;                   // freshly opened = nothing to lose yet
  reopen();
  setMode(null);
  await render();
  enableDocButtons(true);
  setStatus("Opened "+fileName+". "+zoomTip(),"ok");
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
      dirty = true;
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
  const avail = $("viewer").clientWidth - 8;   // hairline gutter (4px each side) for an edge-to-edge fit
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
      const holder = document.createElement("div");
      holder.className = "holder";
      holder.style.width = dispW+"px"; holder.style.height = dispH+"px";
      const cur = stage.querySelector("img") || stage.querySelector(".holder");
      if (cur) cur.replaceWith(holder);
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
    $("meta").textContent = `${fileName} • ${n} pages • ${fmtKB(workingBytes.length)}`;
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
    const usePng = !bigDoc && rasterMax <= 2800;
    const bin = usePng ? u8(pix.asPNG()) : u8(pix.asJPEG(94));
    pix.destroy(); page.destroy();
    const url = URL.createObjectURL(new Blob([bin], {type: usePng ? "image/png" : "image/jpeg"}));
    liveURLs.add(url);
    const holder = stage.querySelector(".holder");
    const img = document.createElement("img");
    img.decoding = "async";
    img.onload = ()=> setTimeout(()=>{ URL.revokeObjectURL(url); liveURLs.delete(url); }, 1000);
    img.src = url;
    holder.replaceWith(img);
    if (mode === "text") await buildSpanBoxes(stage, i);
    else if (mode === "select") buildTextLayer(stage, i);
    if (SEARCH.open) paintPageHighlights(stage, i);
  } catch(e){ /* leave placeholder */ }
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

function openFind(){
  if (!workingBytes || !MDOC){ setStatus("Open a PDF first, then search it.","warn"); return; }
  SEARCH.open = true;
  const bar = $("findbar"); bar.hidden = false;
  const inp = $("findInput");
  inp.focus(); inp.select();
  if (inp.value.trim()) runFind(inp.value);
  else updateFindCount();
}

function closeFind(){
  SEARCH.open = false;
  SEARCH.token++;                     // cancel any in-flight background scan
  SEARCH.needle = "";
  SEARCH.pages.clear(); SEARCH.order = []; SEARCH.activeKey = null; SEARCH.scanned.clear();
  clearTimeout(SEARCH.debounce);
  $("findbar").hidden = true;
  // clear the box so reopening Find starts blank (same as iLovePDF / Acrobat)
  const inp = $("findInput"); if (inp) inp.value = "";
  $("findCount").textContent = "";
  document.querySelectorAll(".stage .hl").forEach(hl=>{ hl.textContent = ""; });
  setStatus("Ready.");
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
$("findInput").addEventListener("input", scheduleFind);
$("findInput").addEventListener("keydown", (e)=>{
  if (e.key==="Enter"){ e.preventDefault(); gotoFind(e.shiftKey ? -1 : 1); }
  else if (e.key==="Escape"){ e.preventDefault(); closeFind(); }
});
$("findPrev").onclick  = ()=> gotoFind(-1);
$("findNext").onclick  = ()=> gotoFind(1);
$("findClose").onclick = ()=> closeFind();

// ---------------- font matching (mirrors the macOS pick_font) ----------------
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
function openTextEditorSheet(pageIndex, sp){
  $("sheet").innerHTML = h`
    <h3>Edit text · page ${pageIndex+1}</h3>
    <p class="hint">The original text is removed and replaced with what you type, matching its position, size and colour. Leave empty to just delete it.</p>
    <div class="row"><textarea id="teIn"></textarea></div>
    <div class="row"><button class="full" id="teOk">Replace</button></div>
    <div class="row"><button class="ghost full" id="teCancel">Cancel</button></div>`;
  $("teIn").value = sp.text;
  $("teOk").onclick = async ()=>{ const t=$("teIn").value; closeSheet(); await applyTextEdit(pageIndex, sp, t); };
  $("teCancel").onclick = closeSheet;
  openSheet();  setTimeout(()=>$("teIn").focus(), 100);
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
// Shrink the draw size so a one-line replacement fits the original span width
// (pdf-lib doesn't wrap). Never shrink below half — better a slight overflow
// than illegible text. Only shrinks; never enlarges.
function fitFontSize(font, text, size, avail){
  if (!(avail>1) || !text) return size;
  try { const wAt = font.widthOfTextAtSize(text, size);
    if (wAt>avail) return Math.max(size*0.5, size*avail/wAt);
  } catch(e){}
  return size;
}

async function applyTextEdit(pageIndex, sp, newText){
  showSpin(true,"Editing text…");
  try {
    pushUndo();
    // sample the original background colour BEFORE redaction erases the area
    const bg = sampleSpanBg(pageIndex, sp);
    // 1) remove the original glyphs with a MuPDF redaction (no black box)
    const page = MDOC.loadPage(pageIndex);
    const an = page.createAnnotation("Redact");
    an.setRect([sp.x0-1, sp.y0-1, sp.x1+1, sp.y1+1]);
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
    const w = (sp.x1-sp.x0)+2, h = (sp.y1-sp.y0)+2;
    // fill the erased area with the original background colour so an edit on a
    // coloured cell/banner doesn't leave a white patch. Keep pure white when the
    // background is (near-)white or not a trustworthy flat colour — so ordinary
    // white-page edits are byte-for-byte unchanged.
    const nearWhite = bg && bg.r>=245 && bg.g>=245 && bg.b>=245;
    const fillCol = (bg && bg.uniform && !nearWhite)
                  ? rgb(bg.r/255, bg.g/255, bg.b/255) : rgb(1,1,1);
    pg.drawRectangle({ x:sp.x0-1, y:H-(sp.y1+1), width:w, height:h, color:fillCol });
    // a text span is a single line; collapse any newlines the user typed so the
    // replacement stays on that line and can't flow downward past where the
    // original sat (and over the content below it)
    const text = (newText||"").replace(/[\r\n]+/g, " ");
    let substituted = false;
    if (text.trim() !== ""){
      const font = await doc.embedFont(pickFont(sp.font));
      const safe = sanitizeForFont(text);
      substituted = safe !== text;     // some glyphs fell outside the base font
      const baseSize = sp.size || 11;
      const drawSize = fitFontSize(font, safe, baseSize, sp.x1 - sp.x0);   // shrink to fit width
      pg.drawText(safe, { x:sp.origin[0], y:H-sp.origin[1], size:drawSize,
                          font, color:rgb(sp.color[0],sp.color[1],sp.color[2]), lineHeight:drawSize*1.15 });
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
  $("textBtn").classList.toggle("on", m==="text");
  $("selectBtn").classList.toggle("on", m==="select");
  $("signBtn").classList.toggle("on", m==="sign");
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
  else setStatus("Ready.");
}

$("textBtn").onclick = ()=> setMode(mode==="text" ? null : "text");
$("selectBtn").onclick = ()=> setMode(mode==="select" ? null : "select");
// Sign and Unlock were promoted from the More menu to the toolbar (v10.52).
// Handlers are identical to the old menu items so behaviour is unchanged.
$("signBtn").onclick = ()=> startSign();
$("unlockBtn").onclick = ()=> confirmDiscard("unlock another PDF", ()=>$("unlockInput").click());

// ---------------- sign (entered from the More sheet) ----------------
function startSign(){
  if (mode==="sign"){ setMode(null); return; }   // toggling off cancels sign mode
  $("sigInput").click();   // always pick a signature image before placing
}
$("sigInput").onchange = async e=>{
  const f=e.target.files[0]; if(!f) return;
  showSpin(true,"Loading signature…");
  try {
    const url = await fileToDataURL(f);
    // signatures are placed as-is, with their own background kept
    signImgDataUrl = await toPng(url);
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
  const multi = has && MDOC && MDOC.countPages() > 1;
  $("sheet").innerHTML = h`
    <h3>More actions</h3>
    <div class="mgrp-l">Find</div>
    <div class="mgrid">
      <button class="mtile" id="mFind" ${d}>${ic("search")}<span>Find in document</span></button>
    </div>
    <div class="mgrp-l">Create</div>
    <div class="mgrid">
      <button class="mtile" id="mScan">${ic("camera")}<span>Scan</span></button>
      <button class="mtile" id="mImg">${ic("photo")}<span>Photos → PDF</span></button>
    </div>
    <div class="mgrp-l">Pages</div>
    <div class="mgrid">
      <button class="mtile" id="mMerge" ${d}>${ic("combine")}<span>Combine</span></button>
      <button class="mtile" id="mOrg" ${d}>${ic("grid")}<span>Organize</span></button>
      <button class="mtile" id="mExtract" ${d}>${ic("copy")}<span>Copy pages</span></button>
      <button class="mtile" id="mGoto" ${multi?"":"disabled"}>${ic("hash")}<span>Go to page</span></button>
    </div>
    <div class="mgrp-l">Export</div>
    <div class="mgrid">
      <button class="mtile" id="mPng" ${d}>${ic("download")}<span>Save image</span></button>
      <button class="mtile" id="mAbout">${ic("info")}<span>About</span></button>
    </div>
    <div class="row mt12"><button class="ghost full" id="mClose">Cancel</button></div>`;
  $("mFind").onclick  = ()=>{ closeSheet(); openFind(); };
  $("mGoto").onclick  = ()=>{ closeSheet(); openJumpToPage(); };
  $("mScan").onclick  = ()=>{ closeSheet(); startScan(); };
  $("mOrg").onclick   = ()=>{ closeSheet(); openOrganise(); };
  $("mExtract").onclick = ()=>{ closeSheet(); openExtract(); };
  $("mMerge").onclick = ()=>{ closeSheet(); $("mergeInput").click(); };
  $("mImg").onclick   = ()=>{ closeSheet(); confirmDiscard("turn photos into a new PDF", ()=>$("imgInput").click()); };
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
  if (SEARCH.open) closeFind();
  if (pageObserver) pageObserver.disconnect();
  $("viewer").querySelectorAll(".stage").forEach(s=>s.remove());
  revokeURLs();
  closeDoc();                       // destroy the mupdf doc -> frees WASM memory
  workingBytes = null;
  docSensitive = false;
  dirty = false;
  try{ idbDel("doc").catch(()=>{}); }catch(e){}   // closed on purpose: forget it
  fileName = "document.pdf";
  undoStack = [];
  spanCache.clear();
  thumbCache.clear();
  setMode(null);
  zoomPct = 100; $("zoomLbl").textContent = "100%";
  $("pagePill").classList.remove("show");
  $("emptyMsg").style.display = "block";
  $("meta").textContent = "No document open";
  enableDocButtons(false);
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
  if (thumbCache.size > 400){ thumbCache.delete(thumbCache.keys().next().value); }
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
      <p class="hint">Move pages with ↑ ↓. ⟳ turns a page a quarter. Nothing changes until you tap Apply.</p>
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
      const buf = new Uint8Array(await f.arrayBuffer());
      let img;
      if (/png$/i.test(f.type)||/\.png$/i.test(f.name)) img = await doc.embedPng(buf);
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
    fileName = "images.pdf";
    undoStack = [];
    setMode(null);
    reopen(); dirty = true; await render(); enableDocButtons(true);
    setStatus("Done — your photos are now a PDF.","ok");
  } catch(err){ setStatus("Could not turn the photos into a PDF: "+friendly(err),"err"); }
  showSpin(false);
};

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
let cropFit = null;           // image→display fit for the crop screen
const cropFilter = "colour";  // scanner is colour-only (B&W removed in v10.20)
let scanQuality = "std";      // "std" | "small" — JPEG quality + output size
try { if (localStorage.getItem("scanQuality")==="small") scanQuality="small"; } catch(e){}
let scanEnhance = true;       // "Whiten": flatten illumination so paper reads white
try { if (localStorage.getItem("scanEnhance")==="0") scanEnhance=false; } catch(e){}
const SCAN_Q = { std:{ jpeg:0.95, maxDim:2560 }, small:{ jpeg:0.62, maxDim:1400 } };
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
async function startScan(){
  // scanPages is kept as-is: it is always [] here except when a previous
  // session was restored from IndexedDB, in which case we continue it
  capFrame = null; scanFallback = false;
  updateScanCount();
  $("scanCrop").classList.remove("show");
  $("scanCam").classList.add("show");
  setStatus("Point the camera at a document and tap the shutter.","ok");
  await startCamera();
}
function endScan(){
  stopCamera();
  scanPages = []; capFrame = null;
  updateScanCount();
  $("scanCam").classList.remove("show");
  $("scanCrop").classList.remove("show");
}
function updateScanCount(){
  $("scanCount").textContent = scanPages.length ? scanPages.length+" page(s) scanned" : "";
  const d = $("scanDone");
  d.disabled = !scanPages.length;
  d.textContent = scanPages.length ? "Create PDF ("+scanPages.length+")" : "Create PDF";
  renderScanThumbs();
  persistScan();                 // scan session survives the app being killed
}
// thumbnail strip above the shutter: tap a page to review or delete it
function renderScanThumbs(){
  const strip=$("scanThumbs");
  strip.classList.toggle("has", scanPages.length>0);
  strip.innerHTML = scanPages.map((p,i)=>
    h`<button class="sthumb" data-pg="${i}" aria-label="Review scanned page ${i+1}"><img src="${p.thumb}" alt="Page ${i+1}"><span class="num">${i+1}</span></button>`).join("");
  strip.querySelectorAll("[data-pg]").forEach(b=> b.onclick=()=> openScanPageSheet(+b.dataset.pg));
  strip.scrollLeft = strip.scrollWidth;          // keep the newest page in view
}
function openScanPageSheet(i){
  const p=scanPages[i]; if(!p) return;
  const url=URL.createObjectURL(new Blob([p.bytes],{type:"image/jpeg"}));
  $("sheet").innerHTML = h`
    <h3>Scanned page ${i+1} of ${scanPages.length}</h3>
    <div class="row"><img class="pgprev" id="pgPrev" alt="Page ${i+1}"></div>
    <div class="row"><button class="full" id="pgDel">Delete this page</button></div>
    <div class="row"><button class="ghost full" id="pgClose">Close</button></div>`;
  $("pgPrev").src=url;
  const done=()=>{ URL.revokeObjectURL(url); closeSheet(); };
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
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({
      audio:false,
      video:{ facingMode:{ideal:"environment"}, width:{ideal:2560}, height:{ideal:1440} }
    });
  } catch(e){ enterFallback(); return; }
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
  setStatus("Live camera unavailable — using the native camera instead.","warn");
  $("camInput").click();
}
function sizeQuadCanvas(){
  const view = $("scanView"), q = $("scanQuad");
  q.width = view.clientWidth; q.height = view.clientHeight;
}

// live preview: detect the document every 300ms and outline it in green.
// The raw detection jitters frame to frame, so the shown quad is smoothed:
// it appears only after 2 consistent detections, eases toward each new
// detection (lerp), and survives up to 2 missed frames before vanishing.
let liveQuad=null, livePend=null, liveHits=0, liveMiss=0;
function resetLiveQuad(){ liveQuad=null; livePend=null; liveHits=0; liveMiss=0; }
function smoothQuad(q){
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
    return liveQuad;
  }
  const a=0.35;                             // ease toward the new detection
  liveQuad=liveQuad.map((p,i)=>({x:p.x+(q[i].x-p.x)*a, y:p.y+(q[i].y-p.y)*a}));
  return liveQuad;
}
function quadClose(a,b){
  let span=0;
  for (let i=0;i<4;i++) span=Math.max(span, Math.hypot(a[i].x-a[(i+1)&3].x, a[i].y-a[(i+1)&3].y));
  const tol=Math.max(20, span*0.18);
  for (let i=0;i<4;i++) if (Math.hypot(a[i].x-b[i].x, a[i].y-b[i].y)>tol) return false;
  return true;
}
function startLiveDetect(){
  if (scanLive) clearInterval(scanLive);
  resetLiveQuad();
  scanLive = setInterval(()=>{
    try {
      const v = $("scanVideo");
      if (!v.videoWidth || document.hidden) return;
      drawLiveQuad(smoothQuad(detectOnVideoFrame(v)));
    } catch(e){ /* one bad camera frame must not kill the preview loop */ }
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
// Draw the detected document outline on the live preview. Capture is always
// manual (the shutter) — there is no auto-capture, so there's no "hold still"
// state here.
function drawLiveQuad(q){
  const cnv=$("scanQuad"), ctx=cnv.getContext("2d");
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
  ctx.lineWidth = 3;
  ctx.strokeStyle="#46d65c"; ctx.stroke();
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
  captureFrame();
};
// shared: load a photo file (native camera fallback, or library import)
// into the same edge-detect → crop → filter pipeline
async function loadPhotoToCrop(f){
  showSpin(true,"Loading photo…");
  try {
    const im = await loadImage(await fileToDataURL(f));
    const s = Math.min(1, 2600/Math.max(im.naturalWidth, im.naturalHeight));
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
      updateCropOverlay();
      showLoupe(cropQuad[i]);
    });
    const end=()=>{ dragIdx=-1; hideLoupe(); };
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
  colourBalanceCore(im.data, im.width, im.height);
  if (scanEnhance) flattenIllumination(im.data, im.width, im.height);
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
$("cropUse").onclick = async ()=>{
  if (!capFrame || cropBusy) return;
  cropBusy = true;
  showSpin(true,"Straightening page…");
  try {
    await new Promise(r=>setTimeout(r,30));    // let the spinner paint first
    const q = insetQuad(orderQuad(cropQuad), 0.008);   // trim a sliver of edge bleed
    // preferred path: warp + filter in the worker (UI stays responsive)
    const sctx = capFrame.getContext("2d",{willReadFrequently:true});
    const Q = SCAN_Q[scanQuality] || SCAN_Q.std;
    let out = await processPageOffThread(
      sctx.getImageData(0,0,capFrame.width,capFrame.height), q, cropFilter, Q.maxDim, scanEnhance);
    if (!out){                                 // fallback: same math, main thread
      out = warpPerspective(capFrame, q, Q.maxDim);
      colourBalanceCore(out.data, out.width, out.height);
      if (scanEnhance) flattenIllumination(out.data, out.width, out.height);
    }
    const c=document.createElement("canvas"); c.width=out.width; c.height=out.height;
    c.getContext("2d").putImageData(out,0,0);
    const blob = await new Promise(res=>c.toBlob(res,"image/jpeg",(SCAN_Q[scanQuality]||SCAN_Q.std).jpeg));
    // small thumbnail (112px tall ≈ 56 css px at 2×) for the review strip
    const tc=document.createElement("canvas");
    tc.height=112; tc.width=Math.max(8,Math.round(out.width*112/out.height));
    tc.getContext("2d").drawImage(c,0,0,tc.width,tc.height);
    scanPages.push({ bytes:new Uint8Array(await blob.arrayBuffer()), w:out.width, h:out.height,
                     thumb:tc.toDataURL("image/jpeg",0.7) });
    capFrame=null;
    updateScanCount();
    $("scanCrop").classList.remove("show");
    $("scanCam").classList.add("show");
    setStatus("Page "+scanPages.length+" added — scan the next page or tap Create PDF.","ok");
    if (!scanFallback) await resumeCamera();
  } catch(err){ setStatus("Could not finish this page: "+friendly(err),"err"); }
  showSpin(false);
  cropBusy = false;
};

// build the PDF (pages scaled to A4-ish point sizes) and open it in the editor
$("scanDone").onclick = ()=>{
  if (!scanPages.length) return;
  confirmDiscard("create the scanned PDF", createScanPdf);
};
async function createScanPdf(){
  if (!scanPages.length) return;
  const pages=scanPages.slice();
  endScan();
  showSpin(true,"Creating PDF from "+pages.length+" page(s)…");
  try {
    const doc=await PDFDocument.create();
    for (const p of pages){
      const img=await doc.embedJpg(p.bytes);
      const sPt=842/Math.max(p.w,p.h);          // A4 long side = 842pt
      const pg=doc.addPage([p.w*sPt, p.h*sPt]);
      pg.drawImage(img,{x:0,y:0,width:p.w*sPt,height:p.h*sPt});
    }
    workingBytes=new Uint8Array(await doc.save());
    fileName="scan.pdf"; undoStack=[]; setMode(null);
    reopen(); dirty = true; await render(); enableDocButtons(true);
    setStatus("Scanned "+pages.length+" page(s) into scan.pdf — tap Save to keep it.","ok");
  } catch(err){ setStatus("Could not create the PDF: "+friendly(err),"err"); }
  showSpin(false);
};

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
  if (scanStream) sizeQuadCanvas();
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
    dirty = false;                 // saved — nothing unsaved any more
    if (MDOC) $("meta").textContent = nm+" • "+MDOC.countPages()+" pages • "+fmtKB(workingBytes.length);
    schedulePersistDoc();
    setStatus("Saved — now pick where to keep it (e.g. Save to Files).","ok");
    if (after) after();
  };
  $("svCancel").onclick = closeSheet;
  openSheet();
  setTimeout(()=>{ try{ $("svName").select(); }catch(e){} }, 100);
}
$("saveBtn").onclick = ()=> openSaveSheet();

// ---------------- compress ----------------
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
    <p class="hint">Pick a size to aim for. These are targets — a PDF with real text may stay larger so the text stays selectable, and a file that's already small is left unchanged.</p>
    <div class="row"><button class="full" id="cpHigh">High quality — aim for ~1 MB</button></div>
    <div class="row"><button class="full" id="cpMed">Balanced — aim for ~700 KB</button></div>
    <div class="row"><button class="full" id="cpLow">Smallest — aim for ~200 KB</button></div>
    <div class="row"><button class="ghost full" id="cpCancel">Cancel</button></div>`;
  $("cpHigh").onclick = ()=>{ closeSheet(); runCompress("high"); };
  $("cpMed").onclick  = ()=>{ closeSheet(); runCompress("medium"); };
  $("cpLow").onclick  = ()=>{ closeSheet(); runCompress("low"); };
  $("cpCancel").onclick = closeSheet;
  openSheet();
};
// Roughly how much real, extractable text the document has, sampled across the
// first few pages. A scanned / image-only PDF returns ~0; a born-digital text
// page returns hundreds. Used to protect text PDFs from being silently
// rasterised by Compress. Cheap: stops as soon as the threshold is reached.
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
//   false → keep the text-safe lossless result;  true → rasterise to pictures;
//   null  → cancel the whole operation.
function confirmRasterise(before, losslessLen){
  return new Promise(resolve=>{
    $("sheet").innerHTML = h`
      <h3>This PDF contains real text</h3>
      <p class="hint">Making it this small turns every page into a picture, so the text can no longer be selected, searched or read aloud. A text-safe version is ${fmtKB(losslessLen)} (from ${fmtKB(before)}).</p>
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
  try {
    // 1) lossless structural pass FIRST. This does not mutate MDOC or
    //    workingBytes, so we can decide what to do before committing — and
    //    before taking the Undo snapshot, which keeps peak memory down.
    let best = u8(MDOC.saveToBuffer("compress,compress-images,compress-fonts,garbage").asUint8Array());
    let bestLen = best.length;
    let rasterised = false;
    // 2) only if that still misses the target do we consider rasterising pages
    if (bestLen > cfg.targetKB*1024){
      const rasterAll = async ()=>{
        for (const step of cfg.steps){
          const bytes = await rasterize(step.dpi, step.q);
          if (bytes.length < bestLen){ best=bytes; bestLen=bytes.length; rasterised=true; }
          if (bytes.length <= cfg.targetKB*1024) break;
        }
      };
      if (sampledTextLength() >= 80){
        // real text present: rasterising would destroy selectable/searchable
        // text. Let the user choose instead of doing it silently.
        showSpin(false);
        const choice = await confirmRasterise(before, bestLen);
        if (choice === null){ setStatus("Compression cancelled.","warn"); return; }
        showSpin(true,"Compressing…");
        if (choice === true) await rasterAll();
        // choice === false: keep the text-safe lossless result (best/bestLen)
      } else {
        // no meaningful text (scanned / image PDF): rasterise freely as before
        await rasterAll();
      }
    }
    // 3) never grow the file. An already-optimised PDF can come back the same
    //    size or a few bytes LARGER from the lossless structural pass; committing
    //    that would grow the document, mark it dirty and add a pointless undo
    //    step, and report a negative "% smaller". Leave it untouched instead.
    if (bestLen >= before){
      showSpin(false);
      setStatus(`Already about as small as it usefully gets — ${fmtKB(before)} left unchanged.`, "ok");
      return;
    }
    // 4) commit — snapshot for Undo now (skipped on very large files, #5)
    const undoKept = pushUndoGuarded();
    workingBytes = best instanceof Uint8Array ? best : new Uint8Array(best);
    reopen(); await render();
    const met = bestLen <= cfg.targetKB*1024, pct=Math.round(100*(1-bestLen/before));
    setStatus(`Done: ${fmtKB(before)} → ${fmtKB(bestLen)} (${pct}% smaller).`
      + (rasterised ? "" : " Text stays selectable.")
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
const UNDO_LIMIT = 10;                       // max steps
const UNDO_BYTES_CAP = 120*1024*1024;        // max total memory for undo copies
let undoStack = [];
function pushUndo(){
  // Each entry remembers BOTH the pre-mutation bytes and the dirty state at that
  // point, so undoing back to the originally-opened document also restores
  // dirty=false (rather than always leaving a spurious "unsaved changes" flag).
  undoStack.push({ bytes: workingBytes ? workingBytes.slice(0) : null, dirty });
  dirty = true;                              // every mutation passes through here
  if (undoStack.length>UNDO_LIMIT) undoStack.shift();
  // large documents: keep undo memory bounded by dropping the oldest steps
  let total=0; for (const e of undoStack) total += e.bytes ? e.bytes.length : 0;
  while (total > UNDO_BYTES_CAP && undoStack.length > 1){
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
    dirty = true; refreshUndo();      // still a change, just without a costly copy
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
  if (workingBytes){ dirty = snap.dirty; reopen(); await render(); }
  else { closeDoc(); dirty = snap.dirty; try{ idbDel("doc").catch(()=>{}); }catch(e){} await render(); }
  enableDocButtons(!!workingBytes);
  showSpin(false); setStatus("Undone.","ok");
}

// ---------------- sheet + utilities ----------------
function closeSheet(){
  $("sheetBg").classList.remove("show");
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
$("viewer").addEventListener("scroll", ()=>{
  if (!workingBytes || !MDOC || pillPending) return;
  pillPending = true;
  raf(()=>{
    pillPending = false;
    try {
      const n = MDOC.countPages();
      if (n < 2) return;
      const v = $("viewer"), vr = v.getBoundingClientRect(), mid = vr.top + vr.height/2;
      let best = 0, bd = 1e9;
      v.querySelectorAll(".stage").forEach(s=>{
        const r = s.getBoundingClientRect();
        const d = Math.abs((r.top + r.bottom)/2 - mid);
        if (d < bd){ bd = d; best = +s.dataset.page; }
      });
      const p = $("pagePill");
      p.textContent = (best+1)+" of "+n;                  // compact, e-reader style
      p.setAttribute("aria-label", "Go to page — currently page "+(best+1)+" of "+n);
      p.classList.add("show");
      clearTimeout(pillT);
      // stay visible a little longer than before so it's comfortable to tap
      pillT = setTimeout(()=>p.classList.remove("show"), 2500);
    } catch(e){}
  });
}, { passive:true });
// the pill is a shortcut to Go to page; tapping it opens the same dialog as More
$("pagePill").onclick = ()=>{ if (workingBytes && MDOC && MDOC.countPages()>1) openJumpToPage(); };
// don't let it fade while a finger/cursor is on it, so the tap can't miss
["pointerenter","pointerdown"].forEach(ev=>$("pagePill").addEventListener(ev, ()=>{ clearTimeout(pillT); }));
$("pagePill").addEventListener("pointerleave", ()=>{ clearTimeout(pillT);
  pillT = setTimeout(()=>$("pagePill").classList.remove("show"), 1200); });

// Re-render on rotate / real width change only. iOS fires "resize" constantly
// as the address bar shows/hides (height-only changes); re-rendering on those
// wastes battery, so skip when the viewer width is unchanged.
let resizeT;
window.addEventListener("resize", ()=>{
  if(!workingBytes) return;
  if($("viewer").clientWidth === lastViewerW) return;   // width unchanged → nothing to do
  clearTimeout(resizeT); resizeT=setTimeout(render,300);
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

document.addEventListener("visibilitychange", ()=>{
  if (document.hidden){
    pauseWork();
    flushPersistDoc();                 // don't lose a pending save if iOS kills us
    scanWasLive = !!scanStream;        // remember to relight the camera on return
    if (scanStream) stopCamera();
  } else {
    resumeWork();
    if (scanWasLive && $("scanCam").classList.contains("show")) startCamera();
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
    try { await openBytes(doc.bytes, doc.name); dirty = doc.dirty !== false; }
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
