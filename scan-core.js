"use strict";
/* scan-core.js — the document-scanner pixel math, in ONE place.
   Imported by both the main thread (app.js, for the synchronous fallback and
   the crop preview) and the scan worker (scan-worker.js, a module worker).
   Previously these functions were copied verbatim into both files and kept in
   sync by source-identity tests; sharing one module removes that duplication.

   All functions operate on raw RGBA pixel data (Uint8ClampedArray / Uint8Array)
   so they work the same in a Worker (no canvas) and on the main thread. */

// ---- perspective correction (homography + bilinear sampling) ----
// sd = source RGBA data, sw/sh = source size, q = 4 corners TL,TR,BR,BL in
// image px, maxDim caps the long side of the output. Returns { data, w, h }.
export function warpCore(sd, sw, sh, q, maxDim){
  const dist=(a,b)=>Math.hypot(a.x-b.x, a.y-b.y);
  let ow=Math.max(dist(q[0],q[1]), dist(q[3],q[2]));
  let oh=Math.max(dist(q[0],q[3]), dist(q[1],q[2]));
  const cap=(maxDim||2000)/Math.max(ow,oh);
  if (cap<1){ ow*=cap; oh*=cap; }
  const W=Math.max(8,Math.round(ow)), H=Math.max(8,Math.round(oh));
  const [ha,hb,hc,hd,he,hf,hg,hh]=homographyTo(q,W,H);
  const od=new Uint8ClampedArray(W*H*4);
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
  return { data:od, w:W, h:H };
}
// homography mapping dst rect (0,0)-(W,H) onto the source quad (8×8 solve)
export function homographyTo(q,W,H){
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

// ---- output filters (raw RGBA array versions) ----
// Colour: gentle auto-contrast (stretch the 2nd–98th luminance percentiles).
export function applyAutoContrast(d,w,h){
  const n=w*h;
  const hist=new Uint32Array(256);
  for (let i=0;i<n;i++){ const j=i*4; hist[(d[j]*77+d[j+1]*151+d[j+2]*28)>>8]++; }
  let lo=0,hi=255,acc=0;
  for (let t=0;t<256;t++){ acc+=hist[t]; if(acc>=n*0.02){ lo=t; break; } }
  acc=0;
  for (let t=255;t>=0;t--){ acc+=hist[t]; if(acc>=n*0.02){ hi=t; break; } }
  if (hi-lo<30) return;
  const lut=new Uint8Array(256);
  for (let t=0;t<256;t++) lut[t]=Math.max(0,Math.min(255,Math.round((t-lo)*255/(hi-lo))));
  for (let i=0;i<n;i++){ const j=i*4; d[j]=lut[d[j]]; d[j+1]=lut[d[j+1]]; d[j+2]=lut[d[j+2]]; }
}
// Colour "clean scan" pipeline (v10.17). Two safe, GLOBAL steps — deliberately
// NOT the v10.14 "magic scan" (that used a per-tile illumination map + unsharp
// mask, which produced local dark blotches and harsh halos):
//   1) Global white balance by "grey-world over the paper". The paper is the
//      bright majority of a document, so we average the colour of all pixels
//      above the 60th-percentile luminance (estimated paper/light colour) and
//      scale each channel so that average lands on a neutral 245. Because it is
//      AREA-AVERAGED, a small neutral element (a plastic address window, a white
//      label) can't skew it — the warm/green room cast on the paper is removed.
//      One gain per channel for the whole image, so no local dark patches.
//   2) The long-standing gentle 2nd–98th percentile luminance stretch, to
//      deepen text. No sharpening.
export function colourBalanceCore(d,w,h){
  const n=w*h;
  const lum=new Uint8Array(n), hl=new Uint32Array(256);
  for (let i=0;i<n;i++){ const j=i*4; const L=(d[j]*77+d[j+1]*151+d[j+2]*28)>>8; lum[i]=L; hl[L]++; }
  let acc=0, thr=0;
  for (let t=0;t<256;t++){ acc+=hl[t]; if (acc>=n*0.60){ thr=t; break; } }
  if (thr<120) thr=120;                        // never mistake a dark scene for paper
  let sR=0,sG=0,sB=0,c=0;
  for (let i=0;i<n;i++){ if (lum[i]>=thr){ const j=i*4; sR+=d[j]; sG+=d[j+1]; sB+=d[j+2]; c++; } }
  if (c>0){
    const TGT=245, GMAX=2.2;
    const gr=Math.min(GMAX, Math.max(1, TGT/Math.max(1,sR/c)));
    const gg=Math.min(GMAX, Math.max(1, TGT/Math.max(1,sG/c)));
    const gb=Math.min(GMAX, Math.max(1, TGT/Math.max(1,sB/c)));
    if (gr>1.001 || gg>1.001 || gb>1.001){
      const lr=new Uint8Array(256), lg=new Uint8Array(256), lb=new Uint8Array(256);
      for (let t=0;t<256;t++){
        lr[t]=Math.min(255,Math.round(t*gr));
        lg[t]=Math.min(255,Math.round(t*gg));
        lb[t]=Math.min(255,Math.round(t*gb));
      }
      for (let i=0;i<n;i++){ const j=i*4; d[j]=lr[d[j]]; d[j+1]=lg[d[j+1]]; d[j+2]=lb[d[j+2]]; }
    }
  }
  applyAutoContrast(d,w,h);
  crispenAndLift(d,w,h);
}
// v10.20: gentle crispness + brightness so the captured still (often darker and
// softer than the live camera) reads sharp and bright like a flatbed scan.
// Deliberately mild — a 1px luminance unsharp mask and a small midtone gain —
// NOT the v10.14 magic-scan (wide map + strong unsharp) that caused halos.
export function crispenAndLift(d,w,h){
  const n=w*h;
  const lum=new Float32Array(n);
  for (let i=0;i<n;i++){ const j=i*4; lum[i]=(d[j]*77+d[j+1]*151+d[j+2]*28)>>8; }
  const blur=new Float32Array(lum);
  boxBlurF(blur,w,h,1);
  const SH=0.55, LIFT=1.06;            // unsharp amount; midtone brightness gain
  for (let i=0;i<n;i++){
    const add=(lum[i]-blur[i])*SH;     // high-pass detail (edges/letters)
    const j=i*4;
    d[j]  =Math.max(0,Math.min(255, d[j]  *LIFT+add));
    d[j+1]=Math.max(0,Math.min(255, d[j+1]*LIFT+add));
    d[j+2]=Math.max(0,Math.min(255, d[j+2]*LIFT+add));
  }
}
export function boxBlurF(a,w,h,r){
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
