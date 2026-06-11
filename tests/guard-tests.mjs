import { readFileSync } from "fs";
import { JSDOM } from "jsdom";
const APP = "/sessions/dazzling-wonderful-darwin/mnt/iphone-pwa";
const appSrc = readFileSync(APP + "/app.js", "utf8").replace(/^import .*$/m, "");
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const oldHtml = readFileSync(APP + "/index.html","utf8")
  .replace(/<script[^>]*><\/script>/g,"")
  .replace(' data-build="9.2"','')
  .replace(/<button class="ghost mini" id="photoBtn">Photos<\/button>/,"");

async function run(sessionPrimed){
  const dom = new JSDOM(oldHtml, { url:"https://localhost/" });
  if (sessionPrimed) dom.window.sessionStorage.setItem("pypdf-healed","1");
  const state = { threw:null, unregistered:false, cachesDeleted:false, reloaded:false };
  const nav = { serviceWorker:{ getRegistrations: async ()=>{ state.unregistered=true; return []; } } };
  const cachesObj = { keys: async ()=>{ state.cachesDeleted=true; return []; }, delete: async ()=>true };
  try {
    new Function("mupdf","document","window","navigator","localStorage","indexedDB","sessionStorage","caches","location",
      appSrc)({}, dom.window.document, dom.window, nav, {getItem:()=>null,setItem(){}}, {},
              dom.window.sessionStorage, cachesObj, { reload(){ state.reloaded=true; } });
  } catch(e){ state.threw=e; }
  await sleep(40);                                   // let the async heal finish
  state.status = dom.window.document.getElementById("status").textContent;
  state.healedFlag = dom.window.sessionStorage.getItem("pypdf-healed");
  return state;
}

const r1 = await run(false);
console.log((r1.threw && /Finishing update/.test(r1.status) && r1.healedFlag==="1"
  && r1.unregistered && r1.cachesDeleted && r1.reloaded ? "PASS":"FAIL")
  + "  V1 first mismatch -> self-heal: purge caches + unregister SW + reload");

const r2 = await run(true);
console.log((r2.threw && /WEB SERVER is still serving an old index\.html/.test(r2.status) && !r2.reloaded ? "PASS":"FAIL")
  + "  V2 mismatch after heal -> blames the server, no reload loop");

// V3: matching build passes the guard and clears the heal flag
const goodHtml = readFileSync(APP + "/index.html","utf8").replace(/<script[^>]*><\/script>/g,"").replace(/<link rel="stylesheet"[^>]*>/g,"");
const dom3 = new JSDOM(goodHtml, { url:"https://localhost/" });
dom3.window.sessionStorage.setItem("pypdf-healed","1");
Object.defineProperty(dom3.window.Element.prototype,"clientWidth",{get(){return 390;},configurable:true});
Object.defineProperty(dom3.window.Element.prototype,"clientHeight",{get(){return 600;},configurable:true});
dom3.window.HTMLCanvasElement.prototype.getContext = function(){ return { clearRect(){}, drawImage(){}, getImageData:()=>({width:1,height:1,data:new Uint8ClampedArray(4)}), putImageData(){} }; };
dom3.window.PDFLib = { PDFDocument:{}, StandardFonts:{}, rgb:()=>({}), degrees:()=>({}) };
let threw3=null;
try {
  new Function("mupdf","document","window","navigator","localStorage","indexedDB","sessionStorage","caches","location","Worker","IntersectionObserver",
    appSrc)({}, dom3.window.document, dom3.window, {}, {getItem:()=>null,setItem(){}},
            {open:()=>({})}, dom3.window.sessionStorage, undefined, {}, class{}, class{observe(){}disconnect(){}});
} catch(e){ threw3=e; }
console.log((!threw3 && dom3.window.sessionStorage.getItem("pypdf-healed")===null ? "PASS":"FAIL")
  + "  V3 matching build passes guard + clears heal flag" + (threw3 ? "  ["+threw3.message+"]" : ""));

// V4: hung worker watchdog (regression)
let s=appSrc; const i=s.indexOf("function processPageOffThread");
let d=0,k=s.indexOf("{",i);
for(;k<s.length;k++){ if(s[k]==="{")d++; if(s[k]==="}"){d--; if(!d)break;} }
const fn=s.slice(i,k+1).replace("15000","50");
const ppot=new Function("ImageData",`let scanWorker={addEventListener(){},removeEventListener(){},postMessage(){}};let scanJobId=0;function getScanWorker(){return scanWorker;}${fn}return processPageOffThread;`)(class{});
const res=await ppot({data:{buffer:new ArrayBuffer(4)},width:1,height:1},[],"colour");
console.log((res===null?"PASS":"FAIL")+"  V4 hung worker watchdog still falls back");
