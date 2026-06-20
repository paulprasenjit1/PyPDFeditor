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
    const mR=sR/c, mG=sG/c, mB=sB/c, mean=(mR+mG+mB)/3;
    // Grey-world white balance assumes the bright region is neutral paper seen
    // under a warm or cool light — a cast in which green sits BETWEEN red and
    // blue (R>=G>=B warm, or B>=G>=R cool). If instead the bright region is a
    // strongly COLOURED surface — a pink/magenta wall (green well below the
    // red-blue midpoint) or a green surface (well above it) — then forcing it
    // neutral injects the complementary cast into the rest of the frame. That is
    // the reported yellow/green tint on captures of non-document scenes. Detect
    // that off-axis (green<->magenta) tint and skip the white balance; the
    // contrast + crispen steps below still run, so real documents are unaffected.
    const offAxis = Math.abs(mG - (mR+mB)/2) / Math.max(1, mean);
    if (offAxis < 0.12){
      const TGT=245, GMAX=2.2;
      const gr=Math.min(GMAX, Math.max(1, TGT/Math.max(1,mR)));
      const gg=Math.min(GMAX, Math.max(1, TGT/Math.max(1,mG)));
      const gb=Math.min(GMAX, Math.max(1, TGT/Math.max(1,mB)));
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

// ---- illumination flattening ("whiten paper", optional) ----
// Evens out uneven lighting / shadows so crumpled or shadowed paper reads as
// uniform white, WITHOUT the dark halos around text that a small-radius unsharp
// or illumination map causes (the old v10.14 "magic scan" problem). The trick is
// to estimate the background at a COARSE scale, far larger than any glyph, so
// text cannot pull the estimate down:
//   1) Split the image into a coarse grid (~32 cells on the long side). For each
//      cell, estimate the PAPER colour as the mean of its brighter-than-average
//      pixels — text is darker, so it drops out of the estimate.
//   2) Lightly blur that small grid and pick a robust paper-white target.
//   3) Upscale the grid smoothly (bilinear) and multiply each pixel by
//      target/localPaper as a single LUMINANCE gain (equal on R/G/B, so hue is
//      unchanged), clamped to only ever brighten and never by more than GMAX.
// Shadowed paper lifts to white; text keeps its colour because the gain under
// text equals the gain of the paper immediately around it. Gentle and clamped.
function smoothGrid(g, gw, gh){
  if (gw<3 && gh<3) return;
  const t=Float32Array.from(g);
  for (let y=0;y<gh;y++) for (let x=0;x<gw;x++){
    let s=0,c=0;
    for (let dy=-1;dy<=1;dy++){ const yy=y+dy; if(yy<0||yy>=gh) continue;
      for (let dx=-1;dx<=1;dx++){ const xx=x+dx; if(xx<0||xx>=gw) continue; s+=t[yy*gw+xx]; c++; } }
    g[y*gw+x]=s/c;
  }
}
export function flattenIllumination(d, w, h){
  const n=w*h;
  if (n < 64) return;
  const GW = Math.max(1, Math.min(32, w));
  const GH = Math.max(1, Math.min(64, Math.round(GW*h/w) || 1));
  const cells = GW*GH;
  const cx = i => Math.min(GW-1, (i*GW/w)|0);
  // pass 1: cell mean luminance
  const sumL=new Float32Array(cells), cnt=new Float32Array(cells);
  for (let y=0;y<h;y++){ const gy=Math.min(GH-1,(y*GH/h)|0), row=gy*GW;
    for (let x=0;x<w;x++){ const j=(y*w+x)*4;
      const L=(d[j]*77+d[j+1]*151+d[j+2]*28)>>8;
      const gi=row+cx(x); sumL[gi]+=L; cnt[gi]++; } }
  const meanL=new Float32Array(cells);
  for (let i=0;i<cells;i++) meanL[i]=sumL[i]/(cnt[i]||1);
  // pass 2: paper luminance = mean of pixels brighter than the cell mean
  const pSum=new Float32Array(cells), pCnt=new Float32Array(cells);
  for (let y=0;y<h;y++){ const gy=Math.min(GH-1,(y*GH/h)|0), row=gy*GW;
    for (let x=0;x<w;x++){ const j=(y*w+x)*4;
      const L=(d[j]*77+d[j+1]*151+d[j+2]*28)>>8;
      const gi=row+cx(x); if (L>=meanL[gi]){ pSum[gi]+=L; pCnt[gi]++; } } }
  const paper=new Float32Array(cells);
  for (let i=0;i<cells;i++) paper[i]= pCnt[i]?pSum[i]/pCnt[i]:meanL[i];
  smoothGrid(paper, GW, GH);
  // robust paper-white target: 85th percentile of the grid, sensibly capped
  const sorted=Float32Array.from(paper).sort();
  let target=sorted[Math.min(cells-1, Math.floor(cells*0.85))];
  target=Math.max(170, Math.min(244, target));
  // apply: bilinear-upscaled gain, luminance-only, gentle + clamped (brighten only)
  const GMAX=2.0, S=0.85;
  for (let y=0;y<h;y++){
    const fy=Math.max(0, Math.min(GH-1.0001, y*GH/h - 0.5)), y0=Math.floor(fy), y1=Math.min(GH-1,y0+1), wy=fy-y0;
    for (let x=0;x<w;x++){
      const fx=Math.max(0, Math.min(GW-1.0001, x*GW/w - 0.5)), x0=Math.floor(fx), x1=Math.min(GW-1,x0+1), wx=fx-x0;
      const p0=paper[y0*GW+x0]*(1-wx)+paper[y0*GW+x1]*wx;
      const p1=paper[y1*GW+x0]*(1-wx)+paper[y1*GW+x1]*wx;
      const bg=p0*(1-wy)+p1*wy;
      let gain=target/Math.max(1,bg);
      gain=1+(Math.max(1,Math.min(GMAX,gain))-1)*S;   // only brighten, capped, gentle
      const j=(y*w+x)*4;
      d[j]  =Math.min(255, d[j]  *gain);
      d[j+1]=Math.min(255, d[j+1]*gain);
      d[j+2]=Math.min(255, d[j+2]*gain);
    }
  }
}

// ---- document edge detection (pure JS, no OpenCV) ----
// Lives here (since v10.30) so BOTH the main thread (app.js: the still-capture
// auto-detect and the synchronous live-preview fallback) and the scan worker
// (scan-worker.js: the off-thread live-preview detector) run ONE copy. Only
// detectQuad is exported; the helpers are module-private. Operates on raw RGBA
// ImageData-like objects { width, height, data } so it is canvas-free.
// v10.2 detector: (1) Otsu-thresholded connected-component "document-like"
// regions, then (2) a Sobel gradient fallback for same-tone paper.
// Pooled scratch buffers keep the live-preview detector allocation-free.
function dqBuf(key, len, Ctor, zero){
  const pool = dqBuf._p || (dqBuf._p = new Map());
  let b = pool.get(key);
  if (!b || b.length !== len || b.constructor !== Ctor){ b = new Ctor(len); pool.set(key, b); }
  else if (zero) b.fill(0);
  return b;
}
export function detectQuad(im){
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
    const mask=dqBuf("mask",n,Uint8Array,false);   // pooled; fully overwritten below
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
  const seen=dqBuf("seen",n,Uint8Array,true);    // visited flags: must start zeroed
  const stack=dqBuf("stack",n,Int32Array,false); // written via top pointer before read
  let best=null, bestArea=0, boundary=null;       // boundary stays lazy (built once per call)
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
    if (qa > n*0.95) continue;            // whole frame is not a document (allow docs framed large)
    if (area < qa*0.85) continue;         // poorly filled: L-shape, frame, etc.
    if (!quadIsSane(q,w,h)) continue;
    // the quad's outline must follow the region's actual boundary — an
    // L-shape's extreme-corner quad cuts across empty space and fails this
    if (!boundary){
      boundary=dqBuf("boundary",n,Uint8Array,true);   // pooled; zeroed, then we set edge pixels
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
  const mag=dqBuf("mag",n,Float32Array,true);   // interior only written; borders must be 0
  let sum=0, cnt=0;
  for (let y=1;y<h-1;y++) for (let x=1;x<w-1;x++){
    const i=y*w+x;
    const gx=(bl[i-w+1]+2*bl[i+1]+bl[i+w+1])-(bl[i-w-1]+2*bl[i-1]+bl[i+w-1]);
    const gy=(bl[i+w-1]+2*bl[i+w]+bl[i+w+1])-(bl[i-w-1]+2*bl[i-w]+bl[i-w+1]);
    const m=Math.abs(gx)+Math.abs(gy);
    mag[i]=m; sum+=m; cnt++;
  }
  const thr=Math.max(30, (sum/cnt)*2.5);
  const mask=dqBuf("mask",n,Uint8Array,false);   // fully overwritten for every pixel
  for (let i=0;i<n;i++) mask[i]=mag[i]>thr?1:0;
  // dilate once so the boundary survives small gaps
  const dil=dqBuf("dil",n,Uint8Array,true);      // interior only written; borders must be 0
  for (let y=1;y<h-1;y++) for (let x=1;x<w-1;x++){
    const i=y*w+x;
    dil[i]=mask[i]|mask[i-1]|mask[i+1]|mask[i-w]|mask[i+w];
  }
  // largest connected edge structure
  const seen=dqBuf("seen",n,Uint8Array,true), stack=dqBuf("stack",n,Int32Array,false);
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
    if (quadArea(q) > n*0.95) continue;
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
