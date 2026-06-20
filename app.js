"use strict";
import * as mupdf from "./vendor/mupdf/mupdf.js";
// shared scanner pixel math (also imported by the scan worker — one source)
import { warpCore, colourBalanceCore } from "./scan-core.js";

const $ = id => document.getElementById(id);
const PDFLib = window.PDFLib;

// ---------------- build guard (with self-heal) ----------------
// If index.html and app.js come from different builds (stale HTTP/CDN copy,
// missed upload), wiring would crash silently and buttons would appear
// "frozen". Detect it, then: first occurrence per session → purge every cache,
// unregister the service worker and reload (heals a stale DEVICE copy).
// If it happens again right after healing, the SERVER itself is serving an old
// index.html — say so explicitly, since no amount of device clearing fixes that.
const APP_BUILD = "10.29";
(function buildGuard(){
  const pageBuild = document.documentElement.getAttribute("data-build") || "pre-9.2";
  const need = ["openBtn","moreBtn","status","sheet","sheetBg","spin","bigOpen","bigScan","welcomeHint","loupe","pageWrap","pagePill","closeBtn",
    "scanCam","scanShot","scanCancel","scanDone","scanThumbs","torchBtn",
    "scanCrop","cropPoly","g0","g1","g2","g3","h0","h1","h2","h3","qStd","qSmall","cropRetake","cropUse"];
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
function reportError(kind, msg, src){
  const text = kind+": "+(msg||"unknown")+(src ? " @ "+src : "");
  try {
    const log = JSON.parse(localStorage.getItem("pypdf-errlog")||"[]");
    log.unshift(new Date().toISOString().slice(0,16).replace("T"," ")+" "+text);
    localStorage.setItem("pypdf-errlog", JSON.stringify(log.slice(0,3)));
  } catch(e){}
  try { setStatus(text+" — the app keeps running; if something stops working, close and reopen it.", "err"); } catch(e){}
}
window.addEventListener("error", (e)=>{
  const src = e.filename ? e.filename.split("/").pop()+":"+e.lineno+":"+e.colno : "";
  reportError("Error", e.message, src);
});
window.addEventListener("unhandledrejection", (e)=>{
  reportError("Async error", (e.reason && e.reason.message) || String(e.reason||""), "");
});

// ---------------- app version (shown in the About dialog) ----------------
// Bump these together with the CACHE name in sw.js on every release.
const APP_VERSION = APP_BUILD;          // single source of truth: always tracks APP_BUILD
const BUILD_DATETIME = "20 Jun 2026";
const { PDFDocument, StandardFonts, rgb, degrees } = PDFLib;

// ---------------- state ----------------
let workingBytes = null;       // Uint8Array — single source of truth
let MDOC = null;               // live mupdf PDFDocument for the current bytes
let epoch = 0;                 // bumps on every change (invalidates caches)
let fileName = "document.pdf";
let zoomPct = 100;             // 50–300, 25% steps; 100% = fit to viewer width
let mergeSources = null;       // staged docs awaiting a chosen merge order
let signImgDataUrl = null;     // processed signature PNG dataURL
let mode = null;               // null | "sign" | "text"
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
    log.unshift(new Date().toISOString().slice(0,16).replace("T"," ")+" "+m.slice(0,120));
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
}

function enableDocButtons(has){
  for (const id of ["textBtn","compBtn","saveBtn","closeBtn"]) $(id).disabled = !has;
  refreshZoomButtons(); refreshUndo();
}
function refreshUndo(){ $("undoBtn").disabled = !undoStack.length; }
function refreshZoomButtons(){
  $("zoomOut").disabled = !workingBytes || zoomPct<=50;
  $("zoomIn").disabled  = !workingBytes || zoomPct>=300;
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
    if (e.touches.length===2 && workingBytes && !mode){
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
    if (!probe.asPDF()){
      probe.destroy();
      throw new Error("not a PDF file");
    }
    if (probe.countPages() === 0){
      probe.destroy();
      throw new Error("no pages found in this file");
    }
  }
  if (probe.needsPassword()){
    wasEncrypted = true;
    probe.destroy();
    const pw = await askPassword(name);
    if (pw === null){ showSpin(false); setStatus("Open cancelled — file is password protected.","warn"); return; }
    showSpin(true,"Unlocking…");
    probe = mupdf.Document.openDocument(bytes.slice(0), "application/pdf");
    if (!probe.authenticatePassword(pw)){ probe.destroy(); showSpin(false); setStatus("Wrong password — could not unlock.","err"); return; }
    // re-save WITHOUT encryption so the working copy is freely editable/saveable
    const clean = probe.asPDF().saveToBuffer("decrypt,garbage").asUint8Array();
    probe.destroy();
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
  setStatus("Opened "+fileName+". Pinch or use − / + to zoom.","ok");
}
function baseFrom(n){ return (n||"document.pdf").replace(/\.[^.]+$/,""); }

function askPassword(name){
  return new Promise(resolve=>{
    $("sheet").innerHTML = h`
      <h3>Password required</h3>
      <p class="hint">“${name||"This PDF"}” is protected. Enter its password to unlock and edit it.</p>
      <div class="row"><input type="password" id="pwIn" placeholder="Password" autocomplete="off"></div>
      <div class="row"><button class="full" id="pwOk">Unlock</button></div>
      <div class="row"><button class="ghost full" id="pwCancel">Cancel</button></div>`;
    let settled=false;
    const done=v=>{ if(settled) return; settled=true; sheetOnDismiss=null; closeSheet(); resolve(v); };
    $("pwOk").onclick = ()=> done($("pwIn").value || "");
    $("pwCancel").onclick = ()=> done(null);
    openSheet();
    sheetOnDismiss = ()=> done(null);   // backdrop / Esc dismiss = cancel, never hang the open flow
    setTimeout(()=>$("pwIn").focus(), 100);
  });
}

// ---------------- render (mupdf -> JPEG -> <img>) ----------------
function viewerCssWidth(){
  const avail = $("viewer").clientWidth - 24;
  return Math.max(280, Math.min(1100, avail)) * (zoomPct/100);
}
// Render at the TRUE device pixel ratio (modern iPhones are 3×). The old cap
// of 2 rendered pages at two-thirds of native resolution and upscaled them —
// the main reason text looked softer than Acrobat. Lazy rendering +
// content-visibility keep the extra pixels affordable: only visible pages are
// ever rasterised.
const DPR = Math.min(window.devicePixelRatio || 1, 3);
// Cap a rendered page bitmap so high zoom on a large page can't allocate a
// huge canvas. Raised with the DPR so zoomed-in text stays sharp.
const MAX_RENDER_PX = 3500;

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
      stage.innerHTML = h`<span class="plabel">Page ${i+1}</span><div class="holder"></div><div class="ovl"></div>`;
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
    const jpg = u8(pix.asJPEG(94));   // display only; sharper text edges than 92
    pix.destroy(); page.destroy();
    const url = URL.createObjectURL(new Blob([jpg], {type:"image/jpeg"}));
    liveURLs.add(url);
    const holder = stage.querySelector(".holder");
    const img = document.createElement("img");
    img.decoding = "async";
    img.onload = ()=> setTimeout(()=>{ URL.revokeObjectURL(url); liveURLs.delete(url); }, 1000);
    img.src = url;
    holder.replaceWith(img);
    if (mode === "text") await buildSpanBoxes(stage, i);
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
  stage.querySelectorAll(".span").forEach(s=>s.remove());
  const ovl = stage.querySelector(".ovl");
  const wPt = +stage.dataset.wpt;
  const dispW = parseFloat(stage.style.width);
  const s = dispW / wPt;                         // points -> css px
  const spans = getSpans(pageIndex);
  spans.forEach((sp, idx)=>{
    const b = document.createElement("div");
    b.className = "span";
    b.style.left   = (sp.x0*s)+"px";
    b.style.top    = (sp.y0*s)+"px";
    b.style.width  = ((sp.x1-sp.x0)*s)+"px";
    b.style.height = ((sp.y1-sp.y0)*s)+"px";
    b.onclick = (ev)=>{ ev.stopPropagation(); openTextEditor(pageIndex, idx); };
    ovl.appendChild(b);
  });
}

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

async function applyTextEdit(pageIndex, sp, newText){
  showSpin(true,"Editing text…");
  try {
    pushUndo();
    // 1) remove the original glyphs with a MuPDF redaction (no black box)
    const page = MDOC.loadPage(pageIndex);
    const an = page.createAnnotation("Redact");
    an.setRect([sp.x0-1, sp.y0-1, sp.x1+1, sp.y1+1]);
    an.update();
    page.applyRedactions(false);          // false => erase content, don't paint a box
    page.destroy();
    workingBytes = u8(MDOC.saveToBuffer("garbage").asUint8Array());

    // 2) reinsert real, selectable text with pdf-lib at the same place/size/colour
    const doc = await PDFDocument.load(workingBytes, { ignoreEncryption:true });
    const pg = doc.getPage(pageIndex);
    const H = pg.getHeight();
    const w = (sp.x1-sp.x0)+2, h = (sp.y1-sp.y0)+2;
    pg.drawRectangle({ x:sp.x0-1, y:H-(sp.y1+1), width:w, height:h, color:rgb(1,1,1) });
    const text = (newText||"");
    let substituted = false;
    if (text.trim() !== ""){
      const font = await doc.embedFont(pickFont(sp.font));
      const safe = sanitizeForFont(text);
      substituted = safe !== text;     // some glyphs fell outside the base font
      pg.drawText(safe, { x:sp.origin[0], y:H-sp.origin[1], size:sp.size||11,
                          font, color:rgb(sp.color[0],sp.color[1],sp.color[2]), lineHeight:(sp.size||11)*1.15 });
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
  $("viewer").classList.toggle("textmode", m==="text");
  document.querySelectorAll(".stage").forEach(s=>s.classList.toggle("placing", m==="sign"));
  if (m==="text"){
    document.querySelectorAll(".stage").forEach(s=>{ if(s.dataset.rendered) buildSpanBoxes(s, +s.dataset.page); });
    setStatus("Tap any highlighted text to change it.","ok");
  } else if (m==="sign"){ setStatus("Drag a box where the signature should go.","ok"); }
  else setStatus("Ready.");
}

$("textBtn").onclick = ()=> setMode(mode==="text" ? null : "text");

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

// ---------------- More ▾ sheet ----------------
$("moreBtn").onclick = ()=>{
  const has = !!workingBytes, d = has?"":"disabled";
  $("sheet").innerHTML = h`
    <h3>More actions</h3>
    <div class="row"><button class="full" id="mScan">📷 Scan a document</button></div>
    <div class="row"><button class="full" id="mSign" ${d}>✍️ Add my signature</button></div>
    <div class="row"><button class="full" id="mOrg" ${d}>📑 Pages — reorder · rotate · delete</button></div>
    <div class="row"><button class="full" id="mExtract" ${d}>📄 Copy pages → new PDF</button></div>
    <div class="row"><button class="full" id="mMerge" ${d}>➕ Combine PDFs</button></div>
    <div class="row"><button class="full" id="mImg">🖼 Photos → PDF</button></div>
    <div class="row"><button class="full" id="mPng" ${d}>⬇ Save this page as a picture</button></div>
    <div class="row"><button class="full" id="mAbout">About</button></div>
    <div class="row"><button class="ghost full" id="mClose">Cancel</button></div>`;
  $("mScan").onclick  = ()=>{ closeSheet(); startScan(); };
  $("mSign").onclick  = ()=>{ closeSheet(); startSign(); };
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
  const jpg = u8(pix.asJPEG(70)); pix.destroy(); page.destroy();
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
function processPageOffThread(srcIm, quad, filter, maxDim){
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
    w.postMessage({ id, buf:srcIm.data.buffer, w:srcIm.width, h:srcIm.height, quad, filter, maxDim },
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
      const raw = detectOnVideoFrame(v);
      const q = smoothQuad(raw);
      drawLiveQuad(q, 0);
    } catch(e){ /* one bad camera frame must not kill the preview loop */ }
  }, 300);
}
function detectOnVideoFrame(v){
  const vw=v.videoWidth, vh=v.videoHeight;
  const s = 300/Math.max(vw,vh);   // v10.20: higher working res = finer edges
  const sw=Math.max(2,Math.round(vw*s)), sh=Math.max(2,Math.round(vh*s));
  const ctx = scratch(sw,sh).getContext("2d",{willReadFrequently:true});
  ctx.drawImage(v,0,0,sw,sh);
  const q = detectQuad(ctx.getImageData(0,0,sw,sh));
  return q ? q.map(p=>({x:p.x/s, y:p.y/s})) : null;   // → video px
}
function drawLiveQuad(q, stable){
  const cnv=$("scanQuad"), ctx=cnv.getContext("2d");
  ctx.clearRect(0,0,cnv.width,cnv.height);
  if (!q) return;
  const v=$("scanVideo");
  const fit=containFit(v.videoWidth, v.videoHeight, cnv.width, cnv.height);
  ctx.beginPath();
  q.forEach((p,i)=>{ const x=p.x*fit.scale+fit.offX, y=p.y*fit.scale+fit.offY;
                     i ? ctx.lineTo(x,y) : ctx.moveTo(x,y); });
  ctx.closePath();
  ctx.fillStyle="rgba(63,185,80,.16)"; ctx.fill();
  ctx.lineWidth = stable>=2 ? 4 : 2.5;
  ctx.strokeStyle="#3fb950"; ctx.stroke();
  if (stable>=2){                       // auto-capture imminent: tell the user
    ctx.font="600 15px -apple-system,sans-serif";
    ctx.textAlign="center";
    ctx.fillStyle="rgba(0,0,0,.55)";
    const cx=cnv.width/2, cy=cnv.height-34;
    ctx.fillRect(cx-66, cy-20, 132, 28);
    ctx.fillStyle="#fff";
    ctx.fillText("Hold still…", cx, cy);
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
  stopCamera();
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
function enterCrop(frame){
  capFrame = frame;
  // auto-detect edges on a downscale; fall back to a 6% inset rectangle
  const s = 520/Math.max(frame.width, frame.height);  // v10.20: finer edges for low-contrast docs
  const sw=Math.max(2,Math.round(frame.width*s)), sh=Math.max(2,Math.round(frame.height*s));
  const ctx = scratch(sw,sh).getContext("2d",{willReadFrequently:true});
  ctx.drawImage(frame,0,0,sw,sh);
  let q = detectQuad(ctx.getImageData(0,0,sw,sh));
  if (q) q = q.map(p=>({x:p.x/s, y:p.y/s}));
  else {
    const mx=frame.width*0.06, my=frame.height*0.06;
    q=[{x:mx,y:my},{x:frame.width-mx,y:my},
       {x:frame.width-mx,y:frame.height-my},{x:mx,y:frame.height-my}];
  }
  cropQuad = q;
  $("scanCam").classList.remove("show");
  $("scanCrop").classList.add("show");
  layoutCrop();
  setStatus(q ? "Edges detected — drag the corners to fine-tune." : "Drag the corners onto the document edges.","ok");
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
  ctx.putImageData(im,0,0);
}

$("cropRetake").onclick = async ()=>{
  capFrame=null;
  $("scanCrop").classList.remove("show");
  $("scanCam").classList.add("show");
  if (scanFallback) $("camInput").click(); else await startCamera();
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
    const q = orderQuad(cropQuad);
    // preferred path: warp + filter in the worker (UI stays responsive)
    const sctx = capFrame.getContext("2d",{willReadFrequently:true});
    const Q = SCAN_Q[scanQuality] || SCAN_Q.std;
    let out = await processPageOffThread(
      sctx.getImageData(0,0,capFrame.width,capFrame.height), q, cropFilter, Q.maxDim);
    if (!out){                                 // fallback: same math, main thread
      out = warpPerspective(capFrame, q, Q.maxDim);
      colourBalanceCore(out.data, out.width, out.height);
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
    if (!scanFallback) await startCamera();
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

// ---- document edge detection (pure JS, no OpenCV) ----
// v10.2: smarter and stricter.
//  1. Region pass: Otsu threshold, then consider EVERY sizeable connected
//     component (both polarities), not just the largest — pick the biggest one
//     that actually looks like a document: convex, real side lengths, well
//     filled (≥85% of its quad — rejects L-shapes/door frames), and not the
//     whole frame.
//  2. Gradient fallback: when regions fail (white paper on a white desk), a
//     Sobel edge map finds the boundary/shadow line instead; a candidate is
//     only accepted if edges actually cover ≥80% of its outline.
// Pooled scratch buffers for the live-preview detector (runs every 300ms).
// Reused across frames to avoid re-allocating the big full-frame arrays each
// time (#7). Self-contained (pool hangs off the function) so the detection
// tests can eval it in isolation. `zero` is only requested for buffers that
// are read before being fully written (the histogram); g/bl are overwritten
// in full, so they skip the wasted clear.
function dqBuf(key, len, Ctor, zero){
  const pool = dqBuf._p || (dqBuf._p = new Map());
  let b = pool.get(key);
  if (!b || b.length !== len || b.constructor !== Ctor){ b = new Ctor(len); pool.set(key, b); }
  else if (zero) b.fill(0);
  return b;
}
function detectQuad(im){
  const w=im.width, h=im.height, n=w*h, d=im.data;
  const g=dqBuf("g",n,Uint8Array,false);
  for (let i=0,j=0;i<n;i++,j+=4) g[i]=(d[j]*77+d[j+1]*151+d[j+2]*28)>>8;
  const bl=dqBuf("bl",n,Uint8Array,false);
  for (let y=0;y<h;y++) for (let x=0;x<w;x++){
    let s=0,c=0;
    for (let dy=-1;dy<=1;dy++){ const yy=y+dy; if(yy<0||yy>=h) continue;
      for (let dx=-1;dx<=1;dx++){ const xx=x+dx; if(xx<0||xx>=w) continue; s+=g[yy*w+xx]; c++; } }
    bl[y*w+x]=(s/c)|0;
  }
  // Otsu threshold
  const hist=dqBuf("hist",256,Float64Array,true);
  for (let i=0;i<n;i++) hist[bl[i]]++;
  let sumAll=0; for (let t=0;t<256;t++) sumAll+=t*hist[t];
  let sumB=0,wB=0,maxVar=-1,thr=127;
  for (let t=0;t<256;t++){
    wB+=hist[t]; if(!wB) continue;
    const wF=n-wB; if(!wF) break;
    sumB+=t*hist[t];
    const mB=sumB/wB, mF=(sumAll-sumB)/wF, vr=wB*wF*(mB-mF)*(mB-mF);
    if (vr>maxVar){ maxVar=vr; thr=t; }
  }
  // pass 1: document-like regions (paper is usually brighter; try dark second)
  for (const bright of [true,false]){
    const mask=new Uint8Array(n);
    if (bright){ for (let i=0;i<n;i++) mask[i]=bl[i]>thr?1:0; }
    else       { for (let i=0;i<n;i++) mask[i]=bl[i]<=thr?1:0; }
    const q=bestRegionQuad(mask,w,h);
    if (q) return q;
  }
  // pass 2: gradient fallback (same-tone paper separated only by an edge/shadow)
  return gradientQuad(bl,g,w,h);
}

// scan all connected components of a binary mask; return the largest one that
// passes the document-shape tests
function bestRegionQuad(mask,w,h){
  const n=w*h;
  const seen=new Uint8Array(n);
  const stack=new Int32Array(n);
  let best=null, bestArea=0, boundary=null;
  for (let i0=0;i0<n;i0++){
    if (seen[i0] || !mask[i0]) continue;
    let top=0; stack[top++]=i0; seen[i0]=1;
    let area=0, minSum=1e9,maxSum=-1e9,minDif=1e9,maxDif=-1e9, tl=null,tr=null,br=null,blc=null;
    while (top){
      const i=stack[--top]; area++;
      const x=i%w, y=(i/w)|0, su=x+y, di=x-y;
      if (su<minSum){minSum=su; tl={x,y};}
      if (su>maxSum){maxSum=su; br={x,y};}
      if (di>maxDif){maxDif=di; tr={x,y};}
      if (di<minDif){minDif=di; blc={x,y};}
      if (x>0   && !seen[i-1] && mask[i-1]){seen[i-1]=1; stack[top++]=i-1;}
      if (x<w-1 && !seen[i+1] && mask[i+1]){seen[i+1]=1; stack[top++]=i+1;}
      if (y>0   && !seen[i-w] && mask[i-w]){seen[i-w]=1; stack[top++]=i-w;}
      if (y<h-1 && !seen[i+w] && mask[i+w]){seen[i+w]=1; stack[top++]=i+w;}
    }
    if (area < n*0.12 || area <= bestArea) continue;
    const q=[tl,tr,br,blc];
    const qa=quadArea(q);
    if (qa > n*0.92) continue;            // whole frame is not a document
    if (area < qa*0.85) continue;         // poorly filled: L-shape, frame, etc.
    if (!quadIsSane(q,w,h)) continue;
    // the quad's outline must follow the region's actual boundary — an
    // L-shape's extreme-corner quad cuts across empty space and fails this
    if (!boundary){
      boundary=new Uint8Array(n);
      for (let y=0;y<h;y++) for (let x=0;x<w;x++){
        const i=y*w+x;
        if (!mask[i]) continue;
        if (x===0||y===0||x===w-1||y===h-1 ||
            !mask[i-1]||!mask[i+1]||!mask[i-w]||!mask[i+w]) boundary[i]=1;
      }
    }
    if (outlineCoverage(q,boundary,w,h) < 0.80) continue;
    best=q; bestArea=area;
  }
  return best;
}

// document-shape sanity: big enough, convex, no degenerate sides
function quadIsSane(q,w,h){
  if (quadArea(q) < w*h*0.10) return false;
  const minSide = 0.15*Math.min(w,h);
  let sign=0;
  for (let i=0;i<4;i++){
    const a=q[i], b=q[(i+1)&3], c=q[(i+2)&3];
    if (Math.hypot(b.x-a.x, b.y-a.y) < minSide) return false;
    const cr=(b.x-a.x)*(c.y-b.y)-(b.y-a.y)*(c.x-b.x);
    if (cr){ const s=cr>0?1:-1; if(!sign) sign=s; else if(s!==sign) return false; }
  }
  return true;
}

// gradient fallback: Sobel edges -> dilate -> largest edge structure ->
// corner extremes -> accept only if edges cover most of the quad outline
function gradientQuad(bl,g,w,h){
  const n=w*h;
  const mag=new Float32Array(n);
  let sum=0, cnt=0;
  for (let y=1;y<h-1;y++) for (let x=1;x<w-1;x++){
    const i=y*w+x;
    const gx=(bl[i-w+1]+2*bl[i+1]+bl[i+w+1])-(bl[i-w-1]+2*bl[i-1]+bl[i+w-1]);
    const gy=(bl[i+w-1]+2*bl[i+w]+bl[i+w+1])-(bl[i-w-1]+2*bl[i-w]+bl[i-w+1]);
    const m=Math.abs(gx)+Math.abs(gy);
    mag[i]=m; sum+=m; cnt++;
  }
  const thr=Math.max(30, (sum/cnt)*2.5);
  const mask=new Uint8Array(n);
  for (let i=0;i<n;i++) mask[i]=mag[i]>thr?1:0;
  // dilate once so the boundary survives small gaps
  const dil=new Uint8Array(n);
  for (let y=1;y<h-1;y++) for (let x=1;x<w-1;x++){
    const i=y*w+x;
    dil[i]=mask[i]|mask[i-1]|mask[i+1]|mask[i-w]|mask[i+w];
  }
  // largest connected edge structure
  const seen=new Uint8Array(n), stack=new Int32Array(n);
  let best=null, bestSpan=0;
  for (let i0=0;i0<n;i0++){
    if (seen[i0] || !dil[i0]) continue;
    let top=0; stack[top++]=i0; seen[i0]=1;
    let area=0, minSum=1e9,maxSum=-1e9,minDif=1e9,maxDif=-1e9, tl=null,tr=null,br=null,blc=null;
    let minX=1e9,maxX=-1e9,minY=1e9,maxY=-1e9;
    while (top){
      const i=stack[--top]; area++;
      const x=i%w, y=(i/w)|0, su=x+y, di=x-y;
      if (su<minSum){minSum=su; tl={x,y};}
      if (su>maxSum){maxSum=su; br={x,y};}
      if (di>maxDif){maxDif=di; tr={x,y};}
      if (di<minDif){minDif=di; blc={x,y};}
      if (x<minX)minX=x; if (x>maxX)maxX=x; if (y<minY)minY=y; if (y>maxY)maxY=y;
      if (x>0   && !seen[i-1] && dil[i-1]){seen[i-1]=1; stack[top++]=i-1;}
      if (x<w-1 && !seen[i+1] && dil[i+1]){seen[i+1]=1; stack[top++]=i+1;}
      if (y>0   && !seen[i-w] && dil[i-w]){seen[i-w]=1; stack[top++]=i-w;}
      if (y<h-1 && !seen[i+w] && dil[i+w]){seen[i+w]=1; stack[top++]=i+w;}
    }
    const span=(maxX-minX)*(maxY-minY);
    if (span < n*0.15 || span <= bestSpan) continue;
    const q=[tl,tr,br,blc];
    if (quadArea(q) > n*0.92) continue;
    if (!quadIsSane(q,w,h)) continue;
    if (outlineCoverage(q,dil,w,h) < 0.80) continue;   // outline must really exist
    best=q; bestSpan=span;
  }
  return best;
}

// fraction of points sampled along the quad's outline that sit on (or within
// 2px of) an edge pixel
function outlineCoverage(q,mask,w,h){
  let hit=0, tot=0;
  for (let s=0;s<4;s++){
    const a=q[s], b=q[(s+1)&3];
    const steps=Math.max(8, Math.round(Math.hypot(b.x-a.x,b.y-a.y)/2));
    for (let k=0;k<=steps;k++){
      const x=Math.round(a.x+(b.x-a.x)*k/steps), y=Math.round(a.y+(b.y-a.y)*k/steps);
      tot++;
      let found=false;
      for (let dy=-2;dy<=2 && !found;dy++){
        const yy=y+dy; if (yy<0||yy>=h) continue;
        for (let dx=-2;dx<=2;dx++){
          const xx=x+dx; if (xx<0||xx>=w) continue;
          if (mask[yy*w+xx]){ found=true; break; }
        }
      }
      if (found) hit++;
    }
  }
  return hit/tot;
}
function quadArea(q){
  let a=0;
  for (let i=0;i<4;i++){ const p=q[i], r=q[(i+1)&3]; a+=p.x*r.y-r.x*p.y; }
  return Math.abs(a)/2;
}
// re-derive TL,TR,BR,BL after the user has dragged corners around
function orderQuad(q){
  const bySum=[...q].sort((a,b)=>(a.x+a.y)-(b.x+b.y));
  const tl=bySum[0], br=bySum[3];
  const [a,b]=bySum.slice(1,3);
  const tr = (a.x-a.y) > (b.x-b.y) ? a : b;
  return [tl, tr, br, tr===a ? b : a];
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
  const v=$("viewer"), vTop=v.getBoundingClientRect().top; let target=0, best=1e9;
  document.querySelectorAll(".stage").forEach(s=>{
    const d=Math.abs(s.getBoundingClientRect().top - vTop);   // viewer rect hoisted out of the loop (#6)
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
    <p class="hint">Smaller files are easier to send and store. Pick how small:</p>
    <div class="row"><button class="full" id="cpHigh">High quality — about 1 MB</button></div>
    <div class="row"><button class="full" id="cpMed">Balanced — about 700 KB</button></div>
    <div class="row"><button class="full" id="cpLow">Smallest — about 200 KB</button></div>
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
      p.textContent = "Page "+(best+1)+" of "+n;
      p.classList.add("show");
      clearTimeout(pillT);
      pillT = setTimeout(()=>p.classList.remove("show"), 1200);
    } catch(e){}
  });
}, { passive:true });

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
