"use strict";
import * as mupdf from "./vendor/mupdf/mupdf.js";

const $ = id => document.getElementById(id);
const PDFLib = window.PDFLib;

// ---------------- app version (shown in the About dialog) ----------------
// Bump these together with the CACHE name in sw.js on every release.
const APP_VERSION = "8.0";
const BUILD_DATETIME = "11 Jun 2026";
const { PDFDocument, StandardFonts, rgb } = PDFLib;

// ---------------- state ----------------
let workingBytes = null;       // Uint8Array — single source of truth
let MDOC = null;               // live mupdf PDFDocument for the current bytes
let epoch = 0;                 // bumps on every change (invalidates caches)
let fileName = "document.pdf";
let zoomPct = 100;             // 50–300, 25% steps; 100% = fit to viewer width
let mergeSources = null;       // staged docs awaiting a chosen merge order
let signImgDataUrl = null;     // processed signature PNG dataURL
let signRemoveWhite = false;   // place signatures as-is (background kept)
let mode = null;               // null | "sign" | "text"
const spanCache = new Map();   // key `${epoch}:${page}` -> spans[]
let pageObserver = null;       // single lazy-render observer (disconnected on hide/close)
const liveURLs = new Set();    // outstanding object URLs, revoked on teardown
let lastViewerW = 0;           // last width we rendered at (skip no-op resize re-renders)

// HTML-escape any value before putting it in innerHTML. File names are
// attacker-influenced, so this prevents DOM-based XSS in the sheets.
function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g,
  c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }
// Strip path separators / control chars from a download file name.
function safeFileName(n){
  return String(n||"document.pdf").replace(/[\/\\\x00-\x1f]/g,"_").slice(0,128) || "document.pdf";
}

function setStatus(msg, cls=""){ const s=$("status"); s.textContent=msg; s.className="status "+cls; }
function showSpin(on, txt){ const s=$("spin"); if(txt) s.textContent=txt; s.classList.toggle("show", !!on); }
// Always drop the working spinner before opening a modal, otherwise its
// full-screen overlay would sit on top and swallow the modal's taps.
function openSheet(){ showSpin(false); $("sheetBg").classList.add("show"); }
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
  $("meta").textContent = "No document open";
  setStatus("Engine ready. Tap Open to load a PDF.", "ok");
})();

// ---------------- mupdf doc lifecycle ----------------
function closeDoc(){ if (MDOC){ try{ MDOC.destroy(); }catch(e){} MDOC=null; } }
function reopen(){
  closeDoc();
  // mupdf reads the buffer up front; hand it a fresh copy so workingBytes stays intact
  MDOC = mupdf.Document.openDocument(workingBytes.slice(0), "application/pdf").asPDF();
  epoch++;
  spanCache.clear();
}

function enableDocButtons(has){
  for (const id of ["textBtn","compBtn","compLevel","saveBtn"]) $(id).disabled = !has;
  refreshZoomButtons(); refreshUndo();
}
function refreshUndo(){ $("undoBtn").disabled = !undoStack.length; }
function refreshZoomButtons(){
  $("zoomOut").disabled = !workingBytes || zoomPct<=50;
  $("zoomIn").disabled  = !workingBytes || zoomPct>=300;
}
function applyZoom(delta){
  const next = Math.max(50, Math.min(300, zoomPct + delta));
  if (next === zoomPct){ refreshZoomButtons(); return; }
  zoomPct = next;
  $("zoomLbl").textContent = zoomPct + "%";
  refreshZoomButtons();
  if (workingBytes) render();
}
$("undoBtn").onclick = ()=> doUndo();
$("zoomOut").onclick = ()=> applyZoom(-25);
$("zoomIn").onclick  = ()=> applyZoom(25);

// ---------------- open (with password support) ----------------
$("openBtn").onclick = ()=> $("fileInput").click();
$("fileInput").onchange = async e=>{
  const f=e.target.files[0]; if(!f) return;
  showSpin(true,"Opening "+f.name+" …"); setStatus("Opening "+f.name+" …");
  try { await openBytes(new Uint8Array(await f.arrayBuffer()), f.name); }
  catch(err){ setStatus("Open failed: "+err.message,"err"); }
  showSpin(false); e.target.value="";
};

async function openBytes(bytes, name){
  // probe for encryption first
  let probe = mupdf.Document.openDocument(bytes.slice(0), "application/pdf");
  if (probe.needsPassword()){
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
  reopen();
  setMode(null);
  await render();
  enableDocButtons(true);
  setStatus("Opened "+fileName+".","ok");
}
function baseFrom(n){ return (n||"document.pdf").replace(/\.[^.]+$/,""); }

function askPassword(name){
  return new Promise(resolve=>{
    $("sheet").innerHTML = `
      <h3>Password required</h3>
      <p class="hint">“${esc(name||"This PDF")}” is protected. Enter its password to unlock and edit it.</p>
      <div class="row"><input type="password" id="pwIn" placeholder="Password" autocomplete="off"></div>
      <div class="row"><button class="full" id="pwOk">Unlock</button></div>
      <div class="row"><button class="ghost full" id="pwCancel">Cancel</button></div>`;
    const done=v=>{ closeSheet(); resolve(v); };
    $("pwOk").onclick = ()=> done($("pwIn").value || "");
    $("pwCancel").onclick = ()=> done(null);
    openSheet();    setTimeout(()=>$("pwIn").focus(), 100);
  });
}

// ---------------- render (mupdf -> JPEG -> <img>) ----------------
function viewerCssWidth(){
  const avail = $("viewer").clientWidth - 24;
  return Math.max(280, Math.min(1100, avail)) * (zoomPct/100);
}
const DPR = Math.min(window.devicePixelRatio || 1, 2);
// Cap a rendered page bitmap so high zoom on a large page can't allocate a
// huge canvas (heavy on CPU, GPU and battery). ~6 megapixels is plenty crisp.
const MAX_RENDER_PX = 2600;

// Build (or rebuild) the single lazy-render observer and watch every page that
// hasn't been rasterised yet. Reusing one observer avoids leaking observers on
// each re-render and lets us cleanly disconnect it when the app is hidden.
function observeStages(){
  const v = $("viewer");
  if (pageObserver) pageObserver.disconnect();
  pageObserver = new IntersectionObserver((entries)=>{
    for (const en of entries){
      if (!en.isIntersecting) continue;
      const stage = en.target; pageObserver.unobserve(stage);
      if (stage.dataset.rendered) continue;
      stage.dataset.rendered = "1";
      renderStage(stage, +stage.dataset.page);
    }
  }, { root: v, rootMargin: "700px 0px" });   // smaller margin = fewer offscreen renders
  v.querySelectorAll(".stage:not([data-rendered])").forEach(s=>pageObserver.observe(s));
}

async function render(){
  const v = $("viewer");
  v.querySelectorAll(".stage").forEach(s=>s.remove());
  revokeURLs();
  if (!workingBytes || !MDOC){ $("emptyMsg").style.display="block"; return; }
  $("emptyMsg").style.display="none";
  showSpin(true,"Rendering…");
  try {
    const n = MDOC.countPages();
    const cssW = viewerCssWidth();
    lastViewerW = v.clientWidth;

    for (let i=0;i<n;i++){
      const page = MDOC.loadPage(i);
      const [x0,y0,x1,y1] = page.getBounds();
      page.destroy();
      const wPt = x1-x0, hPt = y1-y0;
      const dispW = Math.round(cssW), dispH = Math.round(cssW * (hPt/wPt));
      const stage = document.createElement("div");
      stage.className = "stage" + (mode ? " placing" : "");
      stage.dataset.page = i;
      stage.dataset.wpt = wPt; stage.dataset.hpt = hPt;
      stage.style.width = dispW+"px";
      // tell the browser each page's size up-front so content-visibility:auto
      // can skip painting offscreen pages without the layout jumping
      stage.style.containIntrinsicSize = dispW+"px "+dispH+"px";
      stage.innerHTML = `<span class="plabel">Page ${i+1}</span>`+
        `<div style="width:${dispW}px;height:${dispH}px;background:#fff"></div>`+
        `<div class="ovl"></div>`;
      attachOverlay(stage, i);
      v.appendChild(stage);
    }
    observeStages();
    $("meta").textContent = `${fileName} • ${n} pages • ${fmtKB(workingBytes.length)}`;
  } catch(e){ setStatus("Could not render: "+e.message, "err"); }
  showSpin(false);
}

async function renderStage(stage, i){
  try {
    const cssW = parseFloat(stage.style.width);
    const page = MDOC.loadPage(i);
    const [x0,y0,x1,y1] = page.getBounds();
    const wPt = x1-x0, hPt = y1-y0;
    let scale = (cssW / wPt) * DPR;
    // clamp so neither dimension blows past the pixel cap (battery / memory)
    const cap = MAX_RENDER_PX / Math.max(wPt*scale, hPt*scale);
    if (cap < 1) scale *= cap;
    const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false);
    const jpg = u8(pix.asJPEG(80));
    pix.destroy(); page.destroy();
    const url = URL.createObjectURL(new Blob([jpg], {type:"image/jpeg"}));
    liveURLs.add(url);
    const holder = stage.querySelector("div");
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
function openTextEditor(pageIndex, spanIndex){
  const sp = getSpans(pageIndex)[spanIndex];
  if (!sp) return;
  $("sheet").innerHTML = `
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
    if (text.trim() !== ""){
      const font = await doc.embedFont(pickFont(sp.font));
      const safe = sanitizeForFont(text);
      pg.drawText(safe, { x:sp.origin[0], y:H-sp.origin[1], size:sp.size||11,
                          font, color:rgb(sp.color[0],sp.color[1],sp.color[2]), lineHeight:(sp.size||11)*1.15 });
    }
    workingBytes = new Uint8Array(await doc.save());
    reopen();
    setMode("text");
    await render();
    setStatus("Text updated on page "+(pageIndex+1)+".","ok");
  } catch(e){ setStatus("Text edit failed: "+e.message,"err"); }
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
    setStatus("Edit-text mode: tap any highlighted text to change it.","ok");
  } else if (m==="sign"){ setStatus("Sign mode: drag a box where the signature should go.","ok"); }
  else setStatus("Ready.");
}

$("textBtn").onclick = ()=> setMode(mode==="text" ? null : "text");

// ---------------- sign (entered from the More sheet) ----------------
function startSign(){
  if (mode==="sign"){ setMode(null); return; }   // toggling off cancels sign mode
  if (!signImgDataUrl) $("sigInput").click(); else setMode("sign");
}
$("sigInput").onchange = async e=>{
  const f=e.target.files[0]; if(!f) return;
  showSpin(true,"Loading signature…");
  try {
    const url = await fileToDataURL(f);
    signImgDataUrl = signRemoveWhite ? await knockoutWhite(url) : await toPng(url);
    setMode("sign");
  } catch(err){ setStatus("Signature load failed: "+err.message,"err"); }
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

async function placeSignature(pageIndex, xPt, yTopPt, wPt, hPt){
  if (!signImgDataUrl){ setStatus("Pick a signature image first (Sign button).","err"); return; }
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
  } catch(e){ setStatus("Sign failed: "+e.message,"err"); }
  showSpin(false);
}

// ---------------- More ▾ sheet ----------------
$("moreBtn").onclick = ()=>{
  const has = !!workingBytes, d = has?"":"disabled";
  $("sheet").innerHTML = `
    <h3>More actions</h3>
    <div class="row"><button class="full" id="mScan">Scan document (camera)</button></div>
    <div class="row"><button class="full" id="mSign" ${d}>Sign (add signature image)</button></div>
    <div class="row"><button class="full" id="mOrg" ${d}>Organise pages (reorder / delete)</button></div>
    <div class="row"><button class="full" id="mMerge" ${d}>Merge PDFs (choose order)</button></div>
    <div class="row"><button class="full" id="mImg">Images → PDF (new file)</button></div>
    <div class="row"><button class="full" id="mPng" ${d}>Current page → PNG</button></div>
    <div class="row"><button class="full" id="mCloseFile" ${d}>Close PDF</button></div>
    <div class="row"><button class="full" id="mAbout">About</button></div>
    <div class="row"><button class="ghost full" id="mClose">Cancel</button></div>`;
  $("mScan").onclick  = ()=>{ closeSheet(); startScan(); };
  $("mSign").onclick  = ()=>{ closeSheet(); startSign(); };
  $("mOrg").onclick   = ()=>{ closeSheet(); openOrganise(); };
  $("mMerge").onclick = ()=>{ closeSheet(); $("mergeInput").click(); };
  $("mImg").onclick   = ()=>{ closeSheet(); $("imgInput").click(); };
  $("mPng").onclick   = ()=>{ closeSheet(); exportVisiblePng(); };
  $("mCloseFile").onclick = ()=>{ closeSheet(); closeFile(); };
  $("mAbout").onclick = ()=>{ closeSheet(); openAbout(); };
  $("mClose").onclick = closeSheet;
  openSheet();
};

// ---------------- About dialog ----------------
function openAbout(){
  const cache = "pypdf-pwa-v8-mupdf";   // keep in step with sw.js CACHE
  $("sheet").innerHTML = `
    <h3>About PyPDF Editor</h3>
    <div class="about">
      <div class="abrow"><span>Version</span><b>${esc(APP_VERSION)}</b></div>
      <div class="abrow"><span>Build</span><b>${esc(BUILD_DATETIME)}</b></div>
      <div class="abrow"><span>Cache</span><b>${esc(cache)}</b></div>
      <div class="abrow"><span>Engine</span><b>MuPDF.js (WASM) + pdf-lib</b></div>
    </div>
    <p class="hint" style="margin-top:12px">
      A private, on-device PDF editor. Everything runs in your browser — nothing
      you open is ever uploaded. Edit text in place, sign, compress, merge,
      organise pages, and convert images to PDF.<br><br>
      If the version above doesn't match your latest upload, fully close and
      reopen the app so it fetches the new build.
    </p>
    <div class="row" style="margin-top:8px"><button class="ghost full" id="abClose">Close</button></div>`;
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
  fileName = "document.pdf";
  undoStack = [];
  spanCache.clear();
  setMode(null);
  zoomPct = 100; $("zoomLbl").textContent = "100%";
  $("emptyMsg").style.display = "block";
  $("meta").textContent = "No document open";
  enableDocButtons(false);
  setStatus("Closed. Tap Open to load another PDF.", "ok");
}

// ---------------- organise pages (reorder + delete) ----------------
async function openOrganise(){
  const n = MDOC.countPages();
  // order: array of original page indices; del: set of original indices to remove
  let order = Array.from({length:n}, (_,i)=>i);
  const del = new Set();
  const cssThumb = 46*DPR;

  function thumb(i){
    const page = MDOC.loadPage(i);
    const [x0,y0,x1,y1]=page.getBounds(); const s = cssThumb/(x1-x0);
    const pix = page.toPixmap(mupdf.Matrix.scale(s,s), mupdf.ColorSpace.DeviceRGB, false);
    const jpg = u8(pix.asJPEG(70)); pix.destroy(); page.destroy();
    return URL.createObjectURL(new Blob([jpg],{type:"image/jpeg"}));
  }
  function draw(){
    const rows = order.map((orig,pos)=>{
      const isdel = del.has(orig);
      return `<div class="porow ${isdel?'del':''}" data-pos="${pos}">
        <img src="${thumb(orig)}" alt="">
        <span class="pn">Page ${orig+1}</span>
        <button class="ghost" data-up="${pos}">↑</button>
        <button class="ghost" data-dn="${pos}">↓</button>
        <button class="ghost" data-del="${orig}">${isdel?'Keep':'Delete'}</button>
      </div>`;
    }).join("");
    $("sheet").innerHTML = `<h3>Organise pages</h3>
      <p class="hint">Reorder with ↑ ↓ and mark pages to delete. Changes apply when you tap Apply.</p>
      ${rows}
      <div class="row" style="margin-top:12px"><button class="full" id="orgApply">Apply</button></div>
      <div class="row"><button class="ghost full" id="orgCancel">Cancel</button></div>`;
    $("sheet").querySelectorAll("[data-up]").forEach(b=>b.onclick=()=>{const p=+b.dataset.up; if(p>0){[order[p-1],order[p]]=[order[p],order[p-1]]; draw();}});
    $("sheet").querySelectorAll("[data-dn]").forEach(b=>b.onclick=()=>{const p=+b.dataset.dn; if(p<order.length-1){[order[p+1],order[p]]=[order[p],order[p+1]]; draw();}});
    $("sheet").querySelectorAll("[data-del]").forEach(b=>b.onclick=()=>{const o=+b.dataset.del; del.has(o)?del.delete(o):del.add(o); draw();});
    $("orgApply").onclick = async ()=>{ closeSheet(); await applyOrganise(order.filter(o=>!del.has(o))); };
    $("orgCancel").onclick = closeSheet;
  }
  draw();
  openSheet();}

async function applyOrganise(finalOrder){
  if (!finalOrder.length){ setStatus("Cannot delete every page.","err"); return; }
  showSpin(true,"Updating pages…");
  try {
    pushUndo();
    MDOC.rearrangePages(finalOrder);          // reorder + drop in one step
    workingBytes = u8(MDOC.saveToBuffer("garbage").asUint8Array());
    reopen(); await render();
    setStatus("Pages updated. Now "+MDOC.countPages()+" pages.","ok");
  } catch(e){ setStatus("Organise failed: "+e.message,"err"); }
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
  } catch(err){ setStatus("Merge failed: "+err.message,"err"); showSpin(false); }
};

function openMergeOrder(){
  function draw(){
    const rows = mergeSources.map((s,pos)=>`
      <div class="porow" data-pos="${pos}">
        <span class="pn"><b>PDF ${pos+1}</b> · ${esc(s.name)}</span>
        <button class="ghost" data-up="${pos}">↑</button>
        <button class="ghost" data-dn="${pos}">↓</button>
      </div>`).join("");
    $("sheet").innerHTML = `<h3>Merge order</h3>
      <p class="hint">Pages are combined top to bottom — PDF 1 first, then PDF 2, and so on. Reorder with ↑ ↓.</p>
      ${rows}
      <div class="row" style="margin-top:12px"><button class="full" id="mgApply">Merge in this order</button></div>
      <div class="row"><button class="ghost full" id="mgCancel">Cancel</button></div>`;
    $("sheet").querySelectorAll("[data-up]").forEach(b=>b.onclick=()=>{const p=+b.dataset.up; if(p>0){[mergeSources[p-1],mergeSources[p]]=[mergeSources[p],mergeSources[p-1]]; draw();}});
    $("sheet").querySelectorAll("[data-dn]").forEach(b=>b.onclick=()=>{const p=+b.dataset.dn; if(p<mergeSources.length-1){[mergeSources[p+1],mergeSources[p]]=[mergeSources[p],mergeSources[p+1]]; draw();}});
    $("mgApply").onclick = ()=>{ const s=mergeSources.slice(); closeSheet(); doMerge(s); };
    $("mgCancel").onclick = ()=>{ mergeSources=null; closeSheet(); };
  }
  draw();
  openSheet();
}

async function doMerge(sources){
  showSpin(true,"Merging "+sources.length+" PDFs…");
  try {
    pushUndo();
    // first source is the base; graft the rest onto its end, in order
    const base = mupdf.Document.openDocument(sources[0].bytes.slice(0), "application/pdf").asPDF();
    for (let k=1;k<sources.length;k++){
      const src = mupdf.Document.openDocument(sources[k].bytes.slice(0), "application/pdf").asPDF();
      const c = src.countPages();
      for (let i=0;i<c;i++) base.graftPage(-1, src, i);
      src.destroy();
    }
    workingBytes = u8(base.saveToBuffer("garbage").asUint8Array());
    base.destroy();
    fileName = "merged.pdf";
    reopen(); await render(); enableDocButtons(true);
    setStatus("Merged "+sources.length+" PDFs. Now "+MDOC.countPages()+" pages.","ok");
  } catch(err){ setStatus("Merge failed: "+err.message,"err"); }
  mergeSources=null; showSpin(false);
}

// ---------------- images -> PDF (always a brand-new file) ----------------
$("imgInput").onchange = async e=>{
  const files=[...e.target.files]; e.target.value="";
  if(!files.length) return;
  showSpin(true,"Building a new PDF from "+files.length+" image(s)…");
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
      const page = doc.addPage([img.width, img.height]);
      page.drawImage(img, { x:0, y:0, width:img.width, height:img.height });
    }
    // replace whatever was open — behaves like opening a new document
    workingBytes = new Uint8Array(await doc.save());
    fileName = "images.pdf";
    undoStack = [];
    setMode(null);
    reopen(); await render(); enableDocButtons(true);
    setStatus("Opened a new PDF made from "+files.length+" image(s).","ok");
  } catch(err){ setStatus("Images→PDF failed: "+err.message,"err"); }
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
let scanPages = [];           // confirmed pages: [{bytes:Uint8Array(JPEG), w, h}]
let capFrame = null;          // canvas holding the full-res captured photo
let cropQuad = null;          // 4 corners in image px, order TL,TR,BR,BL
let cropFit = null;           // image→display fit for the crop screen
let cropFilter = "colour";    // "colour" | "bw"
let dragIdx = -1;             // corner handle being dragged

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
  scanPages = []; capFrame = null; scanFallback = false;
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
  startLiveDetect();
}
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

// live preview: detect the document every 300ms and outline it in green
function startLiveDetect(){
  if (scanLive) clearInterval(scanLive);
  scanLive = setInterval(()=>{
    const v = $("scanVideo");
    if (!v.videoWidth || document.hidden) return;
    drawLiveQuad(detectOnVideoFrame(v));
  }, 300);
}
function detectOnVideoFrame(v){
  const vw=v.videoWidth, vh=v.videoHeight;
  const s = 220/Math.max(vw,vh);
  const sw=Math.max(2,Math.round(vw*s)), sh=Math.max(2,Math.round(vh*s));
  const ctx = scratch(sw,sh).getContext("2d",{willReadFrequently:true});
  ctx.drawImage(v,0,0,sw,sh);
  const q = detectQuad(ctx.getImageData(0,0,sw,sh));
  return q ? q.map(p=>({x:p.x/s, y:p.y/s})) : null;   // → video px
}
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
  ctx.fillStyle="rgba(63,185,80,.16)"; ctx.fill();
  ctx.lineWidth=2.5; ctx.strokeStyle="#3fb950"; ctx.stroke();
}

// ---- capture ----
$("scanShot").onclick = ()=>{
  if (scanFallback){ $("camInput").click(); return; }
  const v=$("scanVideo");
  if (!v.videoWidth){ setStatus("Camera not ready yet.","warn"); return; }
  const c=document.createElement("canvas");
  c.width=v.videoWidth; c.height=v.videoHeight;
  c.getContext("2d").drawImage(v,0,0);
  stopCamera();
  enterCrop(c);
};
// fallback path: native camera app returns a photo file
$("camInput").onchange = async e=>{
  const f=e.target.files[0]; e.target.value="";
  if (!f) return;
  showSpin(true,"Loading photo…");
  try {
    const im = await loadImage(await fileToDataURL(f));
    const s = Math.min(1, 2600/Math.max(im.naturalWidth, im.naturalHeight));
    const c=document.createElement("canvas");
    c.width=Math.round(im.naturalWidth*s); c.height=Math.round(im.naturalHeight*s);
    c.getContext("2d").drawImage(im,0,0,c.width,c.height);
    $("scanCam").classList.add("show");
    enterCrop(c);
  } catch(err){ setStatus("Photo load failed: "+err.message,"err"); }
  showSpin(false);
};

// ---- adjust / crop screen ----
function enterCrop(frame){
  capFrame = frame;
  // auto-detect edges on a downscale; fall back to a 6% inset rectangle
  const s = 300/Math.max(frame.width, frame.height);
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
  ph.width=Math.round(fit.dispW*DPR); ph.height=Math.round(fit.dispH*DPR);
  ph.style.width=fit.dispW+"px"; ph.style.height=fit.dispH+"px";
  ph.style.left=left+"px"; ph.style.top=top+"px";
  ph.getContext("2d").drawImage(capFrame,0,0,ph.width,ph.height);
  const svg=$("cropSvg");
  svg.setAttribute("width",fit.dispW); svg.setAttribute("height",fit.dispH);
  svg.setAttribute("viewBox","0 0 "+fit.dispW+" "+fit.dispH);
  svg.style.left=left+"px"; svg.style.top=top+"px";
  updateCropOverlay();
}
function updateCropOverlay(){
  const s=cropFit.scale;
  $("cropPoly").setAttribute("points", cropQuad.map(p=>(p.x*s)+","+(p.y*s)).join(" "));
  cropQuad.forEach((p,i)=>{ const c=$("h"+i);
    c.setAttribute("cx",p.x*s); c.setAttribute("cy",p.y*s); });
}
// draggable corner handles
(function wireCropHandles(){
  for (let i=0;i<4;i++){
    const hEl=$("h"+i);
    hEl.addEventListener("pointerdown", e=>{ dragIdx=i; hEl.setPointerCapture(e.pointerId); e.preventDefault(); });
    hEl.addEventListener("pointermove", e=>{
      if (dragIdx!==i || !cropFit || !capFrame) return;
      const r=$("cropSvg").getBoundingClientRect();
      const x=(e.clientX-r.left)/cropFit.scale, y=(e.clientY-r.top)/cropFit.scale;
      cropQuad[i]={ x:Math.max(0,Math.min(capFrame.width ,x)),
                    y:Math.max(0,Math.min(capFrame.height,y)) };
      updateCropOverlay();
    });
    const end=()=>{ dragIdx=-1; };
    hEl.addEventListener("pointerup",end);
    hEl.addEventListener("pointercancel",end);
  }
})();

$("fltColour").onclick = ()=> setScanFilter("colour");
$("fltBw").onclick     = ()=> setScanFilter("bw");
function setScanFilter(f){
  cropFilter=f;
  $("fltColour").classList.toggle("on", f==="colour");
  $("fltBw").classList.toggle("on", f==="bw");
}

$("cropRetake").onclick = async ()=>{
  capFrame=null;
  $("scanCrop").classList.remove("show");
  $("scanCam").classList.add("show");
  if (scanFallback) $("camInput").click(); else await startCamera();
};
$("scanCancel").onclick = ()=>{
  if (scanPages.length && !confirm("Discard "+scanPages.length+" scanned page(s)?")) return;
  endScan();
  setStatus("Scan cancelled.","warn");
};

// confirm the page: perspective-correct, filter, JPEG-encode, back to camera
$("cropUse").onclick = async ()=>{
  if (!capFrame) return;
  showSpin(true,"Straightening page…");
  try {
    await new Promise(r=>setTimeout(r,30));    // let the spinner paint first
    const out = warpPerspective(capFrame, orderQuad(cropQuad));
    if (cropFilter==="bw") applyDocBW(out); else applyAutoContrast(out);
    const c=document.createElement("canvas"); c.width=out.width; c.height=out.height;
    c.getContext("2d").putImageData(out,0,0);
    const blob = await new Promise(res=>c.toBlob(res,"image/jpeg",0.85));
    scanPages.push({ bytes:new Uint8Array(await blob.arrayBuffer()), w:out.width, h:out.height });
    capFrame=null;
    updateScanCount();
    $("scanCrop").classList.remove("show");
    $("scanCam").classList.add("show");
    setStatus("Page "+scanPages.length+" added — scan the next page or tap Create PDF.","ok");
    if (!scanFallback) await startCamera();
  } catch(err){ setStatus("Scan failed: "+err.message,"err"); }
  showSpin(false);
};

// build the PDF (pages scaled to A4-ish point sizes) and open it in the editor
$("scanDone").onclick = async ()=>{
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
    reopen(); await render(); enableDocButtons(true);
    setStatus("Scanned "+pages.length+" page(s) into scan.pdf — tap Save to keep it.","ok");
  } catch(err){ setStatus("Create PDF failed: "+err.message,"err"); }
  showSpin(false);
};

// ---- document edge detection (pure JS, no OpenCV) ----
// Downscaled grayscale → 3×3 blur → Otsu threshold → largest connected
// component (tried both polarities) → quad corners via the x±y extreme trick.
function detectQuad(im){
  const w=im.width, h=im.height, n=w*h, d=im.data;
  const g=new Uint8Array(n);
  for (let i=0,j=0;i<n;i++,j+=4) g[i]=(d[j]*77+d[j+1]*151+d[j+2]*28)>>8;
  const bl=new Uint8Array(n);
  for (let y=0;y<h;y++) for (let x=0;x<w;x++){
    let s=0,c=0;
    for (let dy=-1;dy<=1;dy++){ const yy=y+dy; if(yy<0||yy>=h) continue;
      for (let dx=-1;dx<=1;dx++){ const xx=x+dx; if(xx<0||xx>=w) continue; s+=g[yy*w+xx]; c++; } }
    bl[y*w+x]=(s/c)|0;
  }
  // Otsu threshold
  const hist=new Float64Array(256);
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
  // paper is usually brighter than the background; try dark-on-light second
  for (const bright of [true,false]){
    const q=largestComponentQuad(bl,w,h,thr,bright);
    if (q) return q;
  }
  return null;
}
function largestComponentQuad(bl,w,h,thr,bright){
  const n=w*h;
  const seen=new Uint8Array(n);
  const inMask = bright ? (i=>bl[i]>thr) : (i=>bl[i]<=thr);
  const stack=new Int32Array(n);
  let best=null, bestArea=0;
  for (let i0=0;i0<n;i0++){
    if (seen[i0] || !inMask(i0)) continue;
    let top=0; stack[top++]=i0; seen[i0]=1;
    let area=0, minSum=1e9,maxSum=-1e9,minDif=1e9,maxDif=-1e9, tl=null,tr=null,br=null,blc=null;
    while (top){
      const i=stack[--top]; area++;
      const x=i%w, y=(i/w)|0, su=x+y, di=x-y;
      if (su<minSum){minSum=su; tl={x,y};}
      if (su>maxSum){maxSum=su; br={x,y};}
      if (di>maxDif){maxDif=di; tr={x,y};}
      if (di<minDif){minDif=di; blc={x,y};}
      if (x>0   && !seen[i-1] && inMask(i-1)){seen[i-1]=1; stack[top++]=i-1;}
      if (x<w-1 && !seen[i+1] && inMask(i+1)){seen[i+1]=1; stack[top++]=i+1;}
      if (y>0   && !seen[i-w] && inMask(i-w)){seen[i-w]=1; stack[top++]=i-w;}
      if (y<h-1 && !seen[i+w] && inMask(i+w)){seen[i+w]=1; stack[top++]=i+w;}
    }
    if (area>bestArea){ bestArea=area; best=[tl,tr,br,blc]; }
  }
  if (!best || bestArea < n*0.12) return null;          // too small to be the document
  if (quadArea(best) < n*0.10) return null;             // degenerate shape
  return [best[0],best[1],best[2],best[3]];             // TL,TR,BR,BL
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

// ---- perspective correction (homography + bilinear sampling) ----
function warpPerspective(srcCanvas, q){
  const sctx=srcCanvas.getContext("2d",{willReadFrequently:true});
  const src=sctx.getImageData(0,0,srcCanvas.width,srcCanvas.height);
  const sw=src.width, sh=src.height, sd=src.data;
  const dist=(a,b)=>Math.hypot(a.x-b.x, a.y-b.y);
  let ow=Math.max(dist(q[0],q[1]), dist(q[3],q[2]));
  let oh=Math.max(dist(q[0],q[3]), dist(q[1],q[2]));
  const cap=2000/Math.max(ow,oh);
  if (cap<1){ ow*=cap; oh*=cap; }
  const W=Math.max(8,Math.round(ow)), H=Math.max(8,Math.round(oh));
  const [ha,hb,hc,hd,he,hf,hg,hh]=homographyTo(q,W,H);
  const out=new ImageData(W,H), od=out.data;
  let k=0;
  for (let v=0;v<H;v++){
    for (let u=0;u<W;u++){
      const den=hg*u+hh*v+1;
      const sx=(ha*u+hb*v+hc)/den, sy=(hd*u+he*v+hf)/den;
      const x0=Math.floor(sx), y0=Math.floor(sy);
      if (x0<0||y0<0||x0>=sw-1||y0>=sh-1){ od[k++]=255; od[k++]=255; od[k++]=255; od[k++]=255; continue; }
      const fx=sx-x0, fy=sy-y0;
      const i00=(y0*sw+x0)*4, i10=i00+4, i01=i00+sw*4, i11=i01+4;
      for (let ch=0;ch<3;ch++){
        const t0=sd[i00+ch]*(1-fx)+sd[i10+ch]*fx;
        const t1=sd[i01+ch]*(1-fx)+sd[i11+ch]*fx;
        od[k++]=(t0*(1-fy)+t1*fy)|0;
      }
      od[k++]=255;
    }
  }
  return out;
}
// homography mapping dst rect (0,0)-(W,H) onto the source quad (8×8 solve)
function homographyTo(q,W,H){
  const dst=[{x:0,y:0},{x:W,y:0},{x:W,y:H},{x:0,y:H}];
  const M=[];
  for (let i=0;i<4;i++){
    const {x:u,y:v}=dst[i], {x,y}=q[i];
    M.push([u,v,1,0,0,0,-u*x,-v*x,x]);
    M.push([0,0,0,u,v,1,-u*y,-v*y,y]);
  }
  // Gauss-Jordan with partial pivoting on the augmented 8×9 matrix
  for (let c=0;c<8;c++){
    let piv=c;
    for (let r=c+1;r<8;r++) if (Math.abs(M[r][c])>Math.abs(M[piv][c])) piv=r;
    [M[c],M[piv]]=[M[piv],M[c]];
    const p=M[c][c]||1e-12;
    for (let j=c;j<=8;j++) M[c][j]/=p;
    for (let r=0;r<8;r++){
      if (r===c) continue;
      const f=M[r][c]; if(!f) continue;
      for (let j=c;j<=8;j++) M[r][j]-=f*M[c][j];
    }
  }
  return M.map(row=>row[8]);
}

// ---- output filters ----
// Colour: gentle auto-contrast (stretch the 2nd–98th luminance percentiles).
function applyAutoContrast(im){
  const d=im.data, n=im.width*im.height;
  const hist=new Uint32Array(256);
  for (let i=0;i<n;i++){ const j=i*4; hist[(d[j]*77+d[j+1]*151+d[j+2]*28)>>8]++; }
  let lo=0,hi=255,acc=0;
  for (let t=0;t<256;t++){ acc+=hist[t]; if(acc>=n*0.02){ lo=t; break; } }
  acc=0;
  for (let t=255;t>=0;t--){ acc+=hist[t]; if(acc>=n*0.02){ hi=t; break; } }
  if (hi-lo<30) return;                       // already well spread / blank page
  const lut=new Uint8Array(256);
  for (let t=0;t<256;t++) lut[t]=Math.max(0,Math.min(255,Math.round((t-lo)*255/(hi-lo))));
  for (let i=0;i<n;i++){ const j=i*4; d[j]=lut[d[j]]; d[j+1]=lut[d[j+1]]; d[j+2]=lut[d[j+2]]; }
}
// B&W: adaptive soft threshold against a blurred local mean (clean white paper,
// crisp dark text — the classic scanned-document look, evens out shadows).
function applyDocBW(im){
  const w=im.width, h=im.height, d=im.data, n=w*h;
  const g=new Uint8Array(n);
  for (let i=0;i<n;i++){ const j=i*4; g[i]=(d[j]*77+d[j+1]*151+d[j+2]*28)>>8; }
  const f=8, mw=Math.max(1,Math.ceil(w/f)), mh=Math.max(1,Math.ceil(h/f));
  const sum=new Float64Array(mw*mh), cnt=new Float64Array(mw*mh);
  for (let y=0;y<h;y++){ const my=(y/f)|0;
    for (let x=0;x<w;x++){ const mi=my*mw+((x/f)|0); sum[mi]+=g[y*w+x]; cnt[mi]++; } }
  const mean=new Float32Array(mw*mh);
  for (let i=0;i<mw*mh;i++) mean[i]=cnt[i]?sum[i]/cnt[i]:255;
  boxBlurF(mean,mw,mh,2); boxBlurF(mean,mw,mh,2);
  const sig=new Uint8Array(511);
  for (let i=0;i<511;i++) sig[i]=Math.round(255/(1+Math.exp(-(i-255)/7)));
  for (let y=0;y<h;y++){
    const my=Math.min(mh-1,(y/f)|0);
    for (let x=0;x<w;x++){
      const m=mean[my*mw+Math.min(mw-1,(x/f)|0)];
      const o=sig[Math.max(0,Math.min(510,Math.round(g[y*w+x]-(m-14))+255))];
      const j=(y*w+x)*4; d[j]=d[j+1]=d[j+2]=o;
    }
  }
}
function boxBlurF(a,w,h,r){
  const tmp=new Float32Array(a.length);
  for (let y=0;y<h;y++) for (let x=0;x<w;x++){
    let s=0,c=0;
    for (let k=-r;k<=r;k++){ const xx=x+k; if(xx<0||xx>=w) continue; s+=a[y*w+xx]; c++; }
    tmp[y*w+x]=s/c;
  }
  for (let y=0;y<h;y++) for (let x=0;x<w;x++){
    let s=0,c=0;
    for (let k=-r;k<=r;k++){ const yy=y+k; if(yy<0||yy>=h) continue; s+=tmp[yy*w+x]; c++; }
    a[y*w+x]=s/c;
  }
}

// keep the scanner layouts in step with rotation / window changes
window.addEventListener("resize", ()=>{
  if ($("scanCrop").classList.contains("show")) layoutCrop();
  if (scanStream) sizeQuadCanvas();
});

// ---------------- current page -> PNG (mupdf) ----------------
async function exportVisiblePng(){
  const v=$("viewer"); let target=0, best=1e9;
  document.querySelectorAll(".stage").forEach(s=>{
    const r=s.getBoundingClientRect(); const d=Math.abs(r.top - v.getBoundingClientRect().top);
    if (d<best){ best=d; target=+s.dataset.page; }
  });
  showSpin(true,"Rendering page "+(target+1)+"…");
  try {
    const page = MDOC.loadPage(target);
    const pix = page.toPixmap(mupdf.Matrix.scale(150/72*2,150/72*2), mupdf.ColorSpace.DeviceRGB, false); // ~300 dpi
    const png = u8(pix.asPNG()); pix.destroy(); page.destroy();
    downloadBlob(new Blob([png],{type:"image/png"}), baseName()+"_p"+(target+1)+".png");
    setStatus("Page PNG ready — use the share sheet to save.","ok");
  } catch(err){ setStatus("PNG export failed: "+err.message,"err"); }
  showSpin(false);
}

// ---------------- save ----------------
$("saveBtn").onclick = ()=>{
  if (!workingBytes) return;
  downloadBlob(new Blob([workingBytes], {type:"application/pdf"}), fileName||"document.pdf");
  setStatus("Use the share sheet → Save to Files.","ok");
};

// ---------------- compress ----------------
const COMPRESS = {
  high:   { targetKB:1024, steps:[ {dpi:170,q:88}, {dpi:140,q:80}, {dpi:120,q:72} ] },
  medium: { targetKB:700,  steps:[ {dpi:150,q:72}, {dpi:120,q:62}, {dpi:100,q:52} ] },
  low:    { targetKB:200,  steps:[ {dpi:140,q:62}, {dpi:110,q:52}, {dpi:96,q:42},
                                   {dpi:84,q:34}, {dpi:72,q:28}, {dpi:60,q:22} ] },
};
$("compBtn").onclick = async ()=>{
  const level=$("compLevel").value, cfg=COMPRESS[level], before=workingBytes.length;
  showSpin(true,"Compressing ("+level+")…");
  try {
    pushUndo();
    // 1) lossless structural pass — keep full quality if it already fits
    let best = u8(MDOC.saveToBuffer("compress,compress-images,compress-fonts,garbage").asUint8Array());
    let bestLen = best.length;
    // 2) otherwise rasterize pages with mupdf, gentlest step first
    if (bestLen > cfg.targetKB*1024){
      for (const step of cfg.steps){
        const bytes = await rasterize(step.dpi, step.q);
        if (bytes.length < bestLen){ best=bytes; bestLen=bytes.length; }
        if (bytes.length <= cfg.targetKB*1024) break;
      }
    }
    workingBytes = best instanceof Uint8Array ? best : new Uint8Array(best);
    reopen(); await render();
    const met = bestLen <= cfg.targetKB*1024, pct=Math.round(100*(1-bestLen/before));
    setStatus(`Compressed (${level}, target <${cfg.targetKB}KB): ${fmtKB(before)} → ${fmtKB(bestLen)} (${pct}% smaller).`
      + (met?"":"  — smallest readable at this level"), "ok");
  } catch(err){ setStatus("Compress failed: "+err.message,"err"); }
  showSpin(false);
};

async function rasterize(dpi, quality){
  const out = await PDFDocument.create();
  const scale = dpi/72, n = MDOC.countPages();
  for (let i=0;i<n;i++){
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
const UNDO_LIMIT = 10;
let undoStack = [];
function pushUndo(){ undoStack.push(workingBytes ? workingBytes.slice(0) : null);
  if (undoStack.length>UNDO_LIMIT) undoStack.shift(); refreshUndo(); }
async function doUndo(){
  if (!undoStack.length){ setStatus("Nothing to undo.","err"); return; }
  workingBytes = undoStack.pop();
  showSpin(true,"Undoing…");
  if (workingBytes){ reopen(); await render(); } else { closeDoc(); await render(); }
  enableDocButtons(!!workingBytes);
  showSpin(false); setStatus("Undone.","ok");
}

// ---------------- sheet + utilities ----------------
function closeSheet(){ $("sheetBg").classList.remove("show"); }
$("sheetBg").addEventListener("click", e=>{ if(e.target===$("sheetBg")) closeSheet(); });

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
async function knockoutWhite(dataUrl, thresh=238){
  const im=await loadImage(dataUrl);
  const c=document.createElement("canvas"); c.width=im.naturalWidth; c.height=im.naturalHeight;
  const ctx=c.getContext("2d"); ctx.drawImage(im,0,0);
  const d=ctx.getImageData(0,0,c.width,c.height); const a=d.data;
  for (let i=0;i<a.length;i+=4){ if (a[i]>=thresh&&a[i+1]>=thresh&&a[i+2]>=thresh) a[i+3]=0; }
  ctx.putImageData(d,0,0);
  return c.toDataURL("image/png");
}
function downloadBlob(blob, name){
  const url=URL.createObjectURL(blob); const a=document.createElement("a");
  a.href=url; a.download=safeFileName(name); a.rel="noopener"; document.body.appendChild(a); a.click();
  setTimeout(()=>{ a.remove(); URL.revokeObjectURL(url); }, 4000);
}

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

// service worker
if ("serviceWorker" in navigator)
  window.addEventListener("load", ()=> navigator.serviceWorker.register("./sw.js").catch(()=>{}));
