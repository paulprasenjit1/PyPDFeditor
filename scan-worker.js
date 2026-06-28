"use strict";
/* scan-worker.js — heavy pixel work for the document scanner, off the main
   thread so the UI never freezes during "Use page".
   Module worker: the warp + filter math lives in scan-core.js and is shared
   with the main-thread fallback in app.js (one source of truth — no more
   byte-for-byte duplicated copies).
   Receives: { id, buf (RGBA ArrayBuffer), w, h, quad (4 corners TL,TR,BR,BL
   in image px), maxDim } with the buffer transferred.
   Returns:  { id, ok:true, buf, w, h } (transferred) or { id, ok:false, err }. */
import { warpCore, colourBalanceCore, flattenIllumination, documentEnhance } from "./scan-core.js";

self.onmessage = (e)=>{
  const { id, buf, w, h, quad } = e.data;
  try {
    const src = new Uint8ClampedArray(buf);
    const out = warpCore(src, w, h, quad, e.data.maxDim);
    colourBalanceCore(out.data, out.w, out.h);   // colour-only since v10.20
    if (e.data.enhance){ flattenIllumination(out.data, out.w, out.h);   // "Whiten"
      documentEnhance(out.data, out.w, out.h); }                        // natural Lens polish (v10.75)
    self.postMessage({ id, ok:true, buf:out.data.buffer, w:out.w, h:out.h }, [out.data.buffer]);
  } catch (err){
    self.postMessage({ id, ok:false, err:String((err && err.message) || err) });
  }
};
