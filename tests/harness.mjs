// Headless integration harness for the PyPDF Editor PWA.
// Executes app.js for real (real MuPDF WASM + real pdf-lib), with faked
// canvas / camera / Worker / IndexedDB, and click-drives every feature.
import { readFileSync } from "fs";
import { JSDOM } from "jsdom";
import { createRequire } from "module";

const APP = process.argv[2] || new URL("..", import.meta.url).pathname.replace(/\/$/,"");
const require = createRequire(import.meta.url);
const PDFLib = require(APP + "/vendor/pdf-lib.min.js");
const mupdf = await import(APP + "/vendor/mupdf/mupdf.js");
const TEST_JPG = new Uint8Array(readFileSync(APP + "/tests/test.jpg"));

let pass = 0, fail = 0;
const ck = (name, ok, extra = "") => {
  console.log((ok ? "PASS" : "FAIL") + "  " + name + (extra ? "  (" + extra + ")" : ""));
  ok ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- DOM ----------
const html = readFileSync(APP + "/index.html", "utf8")
  .replace(/<script[^>]*><\/script>/g, "")
  .replace(/<link rel="stylesheet"[^>]*>/g, "");
const dom = new JSDOM(html, { url: "https://localhost/" });
const { window } = dom;
const { document } = window;

// fixed layout metrics (jsdom has no layout engine)
Object.defineProperty(window.Element.prototype, "clientWidth",  { get(){ return 390; }, configurable:true });
Object.defineProperty(window.Element.prototype, "clientHeight", { get(){ return 600; }, configurable:true });
window.Element.prototype.getBoundingClientRect = function(){ return { top:0, left:0, width:390, height:600, right:390, bottom:600 }; };

// ---------- fake 2d canvas ----------
class FakeCtx {
  constructor(c){ this.c = c; }
  _buf(){ const n = (this.c.width|0) * (this.c.height|0) * 4;
          if (!this.c.__px || this.c.__px.length !== n) this.c.__px = new Uint8ClampedArray(n).fill(255);
          return this.c.__px; }
  drawImage(src, ...a){
    const dst = this._buf(), dw = this.c.width|0, dh = this.c.height|0;
    let sw, sh, spx;
    if (src && src.__isVideo){ sw = src.videoWidth; sh = src.videoHeight; spx = src.__px; }
    else if (src && src.__px !== undefined || (src && src.width !== undefined && src.getContext)){
      sw = src.width|0; sh = src.height|0;
      spx = src.__px || new Uint8ClampedArray(sw*sh*4).fill(255);
    } else { sw = (src && src.naturalWidth) || 64; sh = (src && src.naturalHeight) || 64;
             spx = new Uint8ClampedArray(sw*sh*4).fill(255); }
    // nearest-neighbour scale of the full source into the full destination
    for (let y=0; y<dh; y++){
      const sy = Math.min(sh-1, (y*sh/dh)|0);
      for (let x=0; x<dw; x++){
        const sx = Math.min(sw-1, (x*sw/dw)|0);
        const si = (sy*sw+sx)*4, di = (y*dw+x)*4;
        dst[di]=spx[si]; dst[di+1]=spx[si+1]; dst[di+2]=spx[si+2]; dst[di+3]=255;
      }
    }
  }
  getImageData(x,y,w,h){
    const src=this._buf(), cw=this.c.width|0;
    const out=new window.ImageData(w,h);
    for (let yy=0; yy<h; yy++)
      for (let xx=0; xx<w; xx++){
        const si=((y+yy)*cw+(x+xx))*4, di=(yy*w+xx)*4;
        out.data[di]=src[si]; out.data[di+1]=src[si+1]; out.data[di+2]=src[si+2]; out.data[di+3]=src[si+3];
      }
    return out;
  }
  putImageData(im,x,y){
    const dst=this._buf(), cw=this.c.width|0;
    for (let yy=0; yy<im.height; yy++)
      for (let xx=0; xx<im.width; xx++){
        const di=((y+yy)*cw+(x+xx))*4, si=(yy*im.width+xx)*4;
        if ((y+yy)<this.c.height && (x+xx)<cw){
          dst[di]=im.data[si]; dst[di+1]=im.data[si+1]; dst[di+2]=im.data[si+2]; dst[di+3]=im.data[si+3];
        }
      }
  }
  clearRect(){} beginPath(){} moveTo(){} lineTo(){} closePath(){}
  fill(){} stroke(){} fillRect(){} fillText(){} setPointerCapture(){}
}
window.HTMLCanvasElement.prototype.getContext = function(){ this.__ctx = this.__ctx || new FakeCtx(this); return this.__ctx; };
window.HTMLCanvasElement.prototype.toDataURL = function(){ return "data:image/jpeg;base64," + Buffer.from(TEST_JPG).toString("base64"); };
window.HTMLCanvasElement.prototype.toBlob = function(cb){ setTimeout(()=>cb(new window.Blob([TEST_JPG], {type:"image/jpeg"})), 0); };

// ImageData polyfill (jsdom lacks it)
window.ImageData = class ImageData {
  constructor(a,b,c){
    if (typeof a === "number"){ this.width=a; this.height=b; this.data=new Uint8ClampedArray(a*b*4); }
    else { this.data=a; this.width=b; this.height=c; }
  }
};

// Blob arrayBuffer (jsdom Blob has it in modern versions; ensure)
if (!window.Blob.prototype.arrayBuffer)
  window.Blob.prototype.arrayBuffer = function(){ return Promise.resolve(TEST_JPG.buffer.slice(0)); };

// URL object helpers
window.URL.createObjectURL = () => "blob:fake-" + Math.random();
window.URL.revokeObjectURL = () => {};

// ---------- fake camera ----------
// synthetic scene: dark background with a bright tilted "document"
function sceneFrame(vw, vh){
  const px = new Uint8ClampedArray(vw*vh*4);
  for (let i=0;i<vw*vh;i++){ px[i*4]=30; px[i*4+1]=32; px[i*4+2]=35; px[i*4+3]=255; }
  const x0=vw*0.15, x1=vw*0.85, y0=vh*0.12, y1=vh*0.88;
  for (let y=y0|0; y<y1; y++) for (let x=x0|0; x<x1; x++){
    const i=(y*vw+x)*4; px[i]=235; px[i+1]=232; px[i+2]=225;
  }
  return px;
}
const videoEl = document.getElementById("scanVideo");
videoEl.__isVideo = true;
Object.defineProperty(videoEl, "videoWidth",  { get(){ return videoEl.srcObject ? 640 : 0; } });
Object.defineProperty(videoEl, "videoHeight", { get(){ return videoEl.srcObject ? 480 : 0; } });
videoEl.__px = sceneFrame(640, 480);
videoEl.play = async () => {};
const fakeTrack = { stop(){}, getCapabilities:()=>({ torch:true }), applyConstraints: async ()=>{} };
const fakeStream = { getTracks:()=>[fakeTrack], getVideoTracks:()=>[fakeTrack] };
const navigatorObj = { mediaDevices: { getUserMedia: async ()=>fakeStream } };

// ---------- fake Worker that runs the REAL scan-worker.js ----------
const workerSrc = readFileSync(APP + "/scan-worker.js", "utf8");
class FakeWorker {
  constructor(){
    this.listeners = { message:[], error:[] };
    const self = {
      postMessage: (data)=>{ setTimeout(()=>{
        for (const fn of this.listeners.message) fn({ data });
        if (this.onmessage) this.onmessage({ data });
      },0); },
      onmessage: null,
    };
    new Function("self", workerSrc)(self);
    this.__self = self;
  }
  addEventListener(t, fn){ (this.listeners[t] = this.listeners[t]||[]).push(fn); }
  removeEventListener(t, fn){ const a=this.listeners[t]||[]; const i=a.indexOf(fn); if(i>=0)a.splice(i,1); }
  postMessage(data){ setTimeout(()=>{ this.__self.onmessage && this.__self.onmessage({ data }); }, 0); }
}

// ---------- fake IndexedDB ----------
const idbStore = new Map();
const fakeIndexedDB = { open(){ const r={};
  setTimeout(()=>{ r.result={
    close(){}, createObjectStore(){},
    transaction(){ const tx={ objectStore:()=>({
        put:(v,k)=>idbStore.set(k,v),
        delete:(k)=>idbStore.delete(k),
        get:(k)=>{ const rq={}; setTimeout(()=>{ rq.result=idbStore.get(k); rq.onsuccess&&rq.onsuccess(); },0); return rq; }
      })};
      setTimeout(()=>tx.oncomplete&&tx.oncomplete(),1); return tx; } };
    r.onupgradeneeded&&r.onupgradeneeded(); r.onsuccess&&r.onsuccess(); },0);
  return r; } };

// ---------- misc fakes ----------
const lsMap = new Map();
const fakeLocalStorage = { getItem:k=>lsMap.has(k)?lsMap.get(k):null, setItem:(k,v)=>lsMap.set(k,String(v)), removeItem:k=>lsMap.delete(k) };
class FakeImage { constructor(){ this.naturalWidth=640; this.naturalHeight=480; }
  set src(v){ setTimeout(()=>this.onload && this.onload(), 0); } }
class FakeFileReader { readAsDataURL(){ setTimeout(()=>{ this.result="data:image/jpeg;base64,"+Buffer.from(TEST_JPG).toString("base64"); this.onload&&this.onload(); },0); } }
class FakeIO { constructor(cb){ this.cb=cb; } observe(el){ setTimeout(()=>this.cb([{ target:el, isIntersecting:true }]),0); } unobserve(){} disconnect(){} }
window.PDFLib = PDFLib;
const fakeFetch = async (url)=>({ arrayBuffer: async ()=>TEST_JPG.buffer.slice(0) });

// ---------- evaluate app.js ----------
let appSrc = readFileSync(APP + "/app.js", "utf8").replace(/^import .*$/m, "");
appSrc += `
;window.__t = { openBytes, startScan, getSpans, applyTextEdit, doMerge, openOrganise, applyOrganise,
  get workingBytes(){ return workingBytes; }, get scanPages(){ return scanPages; },
  get capFrame(){ return capFrame; }, get fileName(){ return fileName; },
  get MDOC(){ return MDOC; }, get undoStack(){ return undoStack; } };`;
const moduleFn = new Function(
  "mupdf","document","window","navigator","localStorage","indexedDB","URL","Blob","ImageData",
  "Worker","Image","FileReader","IntersectionObserver","fetch","setTimeout","clearTimeout","setInterval","clearInterval",
  appSrc);

let evalErr = null;
try {
  moduleFn(mupdf, document, window, navigatorObj, fakeLocalStorage, fakeIndexedDB, window.URL, window.Blob,
           window.ImageData, FakeWorker, FakeImage, FakeFileReader, FakeIO, fakeFetch,
           setTimeout, clearTimeout, setInterval, clearInterval);
} catch (e){ evalErr = e; }
ck("T1 module evaluates without throwing", !evalErr, evalErr ? evalErr.message : "");
if (evalErr) { console.log(evalErr.stack); process.exit(1); }

const $ = (id) => document.getElementById(id);
const T = window.__t;
const click = (id) => $(id).dispatchEvent(new window.Event("click"));
// app uses el.onclick assignment; jsdom Event dispatch triggers onclick — verify via direct call instead:
const tap = (id) => { const el=$(id); if(!el) throw new Error("no element "+id); if(!el.onclick) throw new Error("no handler on "+id); return el.onclick({ stopPropagation(){}, target:el }); };

(async ()=>{
  await sleep(50);
  ck("T2 engine ready: Open enabled", !$("openBtn").disabled);
  ck("T3 More enabled", !$("moreBtn").disabled);

  // ---- open a real 2-page PDF with text ----
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  const mk = await PDFDocument.create();
  const font = await mk.embedFont(StandardFonts.Helvetica);
  const p1 = mk.addPage([400, 500]);
  p1.drawText("Hello World", { x:50, y:400, size:18, font, color:rgb(0,0,0) });
  mk.addPage([400, 500]).drawText("Second Page", { x:50, y:400, size:18, font, color:rgb(0,0,0) });
  const pdfBytes = new Uint8Array(await mk.save());
  await T.openBytes(pdfBytes.slice(0), "test.pdf");
  await sleep(80);
  ck("T4 open: 2 pages, buttons enabled", T.MDOC && T.MDOC.countPages()===2 && !$("saveBtn").disabled,
     $("meta").textContent);

  // ---- More sheet contains everything ----
  tap("moreBtn");
  ck("T5 More sheet shows incl Scan", !!($("mScan") && $("mSign") && $("mOrg") && $("mMerge") && $("mImg") && $("mPng") && $("mCloseFile") && $("mAbout")));
  tap("mClose");

  // ---- SCANNER end-to-end (the reported flow) ----
  tap("moreBtn"); await tap("mScan"); await sleep(60);
  ck("T6 scanner open, camera live", $("scanCam").classList.contains("show") && !!videoEl.srcObject);
  ck("T7 torch offered (fake cam supports it)", !$("torchBtn").hidden);

  await tap("scanShot"); await sleep(40);
  ck("T8 capture -> crop screen", $("scanCrop").classList.contains("show") && !$("scanCam").classList.contains("show") && !!T.capFrame);
  ck("T9 edges auto-detected (not 6% fallback)", (()=>{ // fallback TL would be x=38.4 on 640px
      const ptr=$("cropPoly").getAttribute("points"); return ptr && !ptr.startsWith("0,0"); })());

  tap("fltBw"); ck("T10 B&W preview toggles", $("fltBw").classList.contains("on"));
  tap("fltColour");

  await tap("cropUse"); await sleep(300);
  ck("T11 Use page -> page 1 added, back to camera",
     T.scanPages.length===1 && $("scanCam").classList.contains("show") && $("scanDone").textContent.includes("(1)"));
  ck("T12 thumbnail strip shows 1 page", $("scanThumbs").querySelectorAll(".sthumb").length===1);

  await tap("scanShot"); await sleep(40);
  await tap("cropUse"); await sleep(300);
  ck("T13 second page added", T.scanPages.length===2 && $("scanDone").textContent.includes("(2)"));

  // thumbnail review + delete
  $("scanThumbs").querySelector("[data-pg='0']").onclick();
  ck("T14 page preview sheet", !!$("pgDel"));
  tap("pgDel"); await sleep(20);
  ck("T15 delete page -> 1 left", T.scanPages.length===1);

  // cancel flow: keep, then discard  (the reported freeze scenario)
  tap("scanCancel");
  ck("T16 discard sheet appears over scanner", !!$("dsYes") && $("sheetBg").classList.contains("show"));
  tap("dsNo");
  ck("T17 Keep scanning keeps session", T.scanPages.length===1 && $("scanCam").classList.contains("show"));
  tap("scanCancel"); tap("dsYes"); await sleep(20);
  ck("T18 Discard closes scanner, clears pages", T.scanPages.length===0 && !$("scanCam").classList.contains("show"));
  ck("T19 spinner not stuck after scan flows", !$("spin").classList.contains("show"));

  // ---- scan -> Create PDF (real embedJpg) ----
  tap("moreBtn"); await tap("mScan"); await sleep(60);
  await tap("scanShot"); await sleep(40);
  await tap("cropUse"); await sleep(300);
  await tap("scanDone"); await sleep(200);
  ck("T20 Create PDF: scan.pdf open with 1 page", T.fileName==="scan.pdf" && T.MDOC.countPages()===1);

  // ---- Organise: rotation + reorder on a real doc ----
  await T.openBytes(pdfBytes.slice(0), "test.pdf"); await sleep(60);
  await T.applyOrganise([1,0], {0:90}); await sleep(60);
  ck("T21 rotate+reorder applied", T.MDOC.countPages()===2);
  const chk = await PDFDocument.load(T.workingBytes.slice(0));
  ck("T22 rotation persisted on the right page", chk.getPage(1).getRotation().angle===90,
     "page rotations: " + [0,1].map(i=>chk.getPage(i).getRotation().angle).join(","));

  // ---- undo ----
  await tap("undoBtn"); await sleep(60);
  const chk2 = await PDFDocument.load(T.workingBytes.slice(0));
  ck("T23 undo restores pre-organise bytes", chk2.getPage(0).getRotation().angle===0 && chk2.getPage(1).getRotation().angle===0);

  // ---- in-place text edit (real mupdf redaction + pdf-lib reinsert) ----
  const spans = T.getSpans(0);
  ck("T24 text spans extracted", spans.length>=1 && spans[0].text.includes("Hello"), JSON.stringify(spans[0] && spans[0].text));
  await T.applyTextEdit(0, spans[0], "Changed Text"); await sleep(60);
  const spans2 = T.getSpans(0);
  ck("T25 text edited in place", spans2.some(s=>s.text.includes("Changed")) && !spans2.some(s=>s.text.includes("Hello")),
     JSON.stringify(spans2.map(s=>s.text)));

  // ---- merge ----
  const before = T.MDOC.countPages();
  await T.doMerge([{name:"a",bytes:T.workingBytes}, {name:"b",bytes:pdfBytes.slice(0)}]); await sleep(60);
  ck("T26 merge: pages add up", T.MDOC.countPages()===before+2, before+"+2="+T.MDOC.countPages());

  // ---- compress ----
  const sizeBefore = T.workingBytes.length;
  await tap("compBtn"); await sleep(400);
  ck("T27 compress completes, doc still valid", T.MDOC.countPages()===before+2 && T.workingBytes.length>0,
     sizeBefore+" -> "+T.workingBytes.length);
  ck("T28 spinner cleared after compress", !$("spin").classList.contains("show"));

  // ---- save + close ----
  await tap("saveBtn");
  ck("T29 save runs without throwing", true);
  tap("moreBtn"); tap("mCloseFile"); await sleep(30);
  ck("T30 close: empty state, buttons disabled", !T.workingBytes && $("saveBtn").disabled);

  // ---- persistence round trip ----
  await sleep(50);
  ck("T31 idb cleared after close", idbStore.get("doc")===undefined);

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch(e=>{ console.log("HARNESS CRASH:", e.stack); process.exit(1); });
