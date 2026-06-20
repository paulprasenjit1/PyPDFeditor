"use strict";
/* scan-worker.js — heavy pixel work for the document scanner, off the main
   thread so the UI never freezes during "Use page".
   Module worker: the warp + filter math lives in scan-core.js and is shared
   with the main-thread fallback in app.js (one source of truth — no more
   byte-for-byte duplicated copies).
   Receives: { id, buf (RGBA ArrayBuffer), w, h, quad (4 corners TL,TR,BR,BL
   in image px), maxDim } with the buffer transferred.
   Returns:  { id, ok:true, buf, w, h } (transferred) or { id, ok:false, err }. */
import { warpCore, colourBalanceCore, detectQuad } from "./scan-core.js";

self.onmessage = (e)=>{
  const m = e.data;
  // live-preview edge detection (off the main thread). Returns the quad as a
  // plain array of {x,y} (structured-cloned, nothing to transfer back).
  if (m && m.type === "detect"){
    try {
      const q = detectQuad({ width:m.w, height:m.h, data:new Uint8ClampedArray(m.buf) });
      self.postMessage({ id:m.id, kind:"detect", ok:true, quad:q });
    } catch (err){
      self.postMessage({ id:m.id, kind:"detect", ok:false, err:String((err && err.message) || err) });
    }
    return;
  }
  // default: full-res warp + colour filter for a confirmed page
  const { id, buf, w, h, quad } = m;
  try {
    const src = new Uint8ClampedArray(buf);
    const out = warpCore(src, w, h, quad, m.maxDim);
    colourBalanceCore(out.data, out.w, out.h);   // colour-only since v10.20
    self.postMessage({ id, ok:true, buf:out.data.buffer, w:out.w, h:out.h }, [out.data.buffer]);
  } catch (err){
    self.postMessage({ id, ok:false, err:String((err && err.message) || err) });
  }
};
