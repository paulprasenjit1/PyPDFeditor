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
// PER-CHANNEL by design: applying the stretch LUT to each R/G/B channel deepens
// dark coloured ink (blue pen, red letterhead) and gives documents their punchy,
// vivid "scanned" look — the v10.76 behaviour the document scans are tuned for.
// (It was briefly made hue-preserving in v10.77 to protect ID cards, which
// dulled documents; ID cards now have their own idCardEnhance path, so this is
// per-channel again for documents only — colourBalanceCore is NOT used by Photo
// ID mode, so the card colour fix is unaffected.)
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

// ---- natural "document" enhance (v10.75) ----
// An Adobe Scan / Office Lens-style polish that is deliberately TONE-PRESERVING:
// it does NOT bleach the paper to pure white (the watermark / natural cream tone
// stays), it just makes the page read cleaner and the ink crisper. Three gentle
// passes on the warped RGBA, run after colourBalanceCore (+ flattenIllumination):
//   1) paperClean — edge-preserving smoothing applied ONLY to bright, low-
//      gradient paper pixels. Sensor grain on the blank page flattens, so the
//      JPEG spends far fewer bytes on noise (more quality per byte); text and
//      ink edges have a high gradient, so the mask is ~0 there and they are left
//      perfectly sharp.
//   2) inkDeepen — a soft pull on dark pixels only (<150 luma). Letters gain
//      contrast and "pop" like a Lens scan; paper and watermark tone unchanged.
//   3) a light 1px luminance unsharp for crisp glyph edges.
export function documentEnhance(d, w, h){
  const n = w*h;
  const L = new Float32Array(n);
  for (let i=0;i<n;i++){ const j=i*4; L[i]=(d[j]*77+d[j+1]*151+d[j+2]*28)>>8; }
  // 4-neighbour gradient magnitude (cheap edge proxy)
  const grad = new Float32Array(n);
  for (let y=0;y<h;y++) for (let x=0;x<w;x++){
    const i=y*w+x; let g=0;
    if (x>0) g+=Math.abs(L[i]-L[i-1]);
    if (y>0) g+=Math.abs(L[i]-L[i-w]);
    grad[i]=g;
  }
  // 1) paperClean — blend toward a 3×3 average where the pixel is bright AND flat
  const src = Uint8ClampedArray.from(d);
  for (let y=0;y<h;y++) for (let x=0;x<w;x++){
    const i=y*w+x;
    const bright = Math.max(0, Math.min(1, (L[i]-225)/30));   // 0 below 225 → 1 at 255
    const flat   = Math.max(0, Math.min(1, (8-grad[i])/8));   // 1 flat → 0 at gradient≥8
    const m = bright*flat*0.6;                                 // gentle, capped at 0.6
    if (m<=0.001) continue;
    let r=0,g=0,b=0,c=0;
    for (let dy=-1;dy<=1;dy++){ const yy=y+dy; if(yy<0||yy>=h) continue;
      for (let dx=-1;dx<=1;dx++){ const xx=x+dx; if(xx<0||xx>=w) continue;
        const k=(yy*w+xx)*4; r+=src[k]; g+=src[k+1]; b+=src[k+2]; c++; } }
    r/=c; g/=c; b/=c; const j=i*4;
    d[j]  = src[j]  *(1-m)+r*m;
    d[j+1]= src[j+1]*(1-m)+g*m;
    d[j+2]= src[j+2]*(1-m)+b*m;
  }
  // 2) inkDeepen — soft tone pull on darks only (≤18% at the very darkest).
  //    v10.78: deepens ALL dark ink, INCLUDING coloured pen (blue/red), because
  //    that is what makes handwriting "pop". The pull scales R/G/B by the SAME
  //    factor so it is hue-preserving, and it tapers with brightness, so a
  //    photographic mid-tone (an ID portrait, L≈80–130) only darkens a few
  //    percent and is never crushed — the heavy darkening that ruined the old ID
  //    scans came from the per-channel auto-contrast, now fixed above, NOT here.
  for (let i=0;i<n;i++){
    const j=i*4; const Li=(d[j]*77+d[j+1]*151+d[j+2]*28)>>8;
    const deep = Math.max(0, (150-Li)/150) * 0.18;
    if (deep>0){ d[j]*=(1-deep); d[j+1]*=(1-deep); d[j+2]*=(1-deep); }
  }
  // 3) light luminance unsharp for crisp glyph edges (mild — crispenAndLift
  //    already did the main sharpen, so keep this gentle to avoid ink halos)
  const L2 = new Float32Array(n);
  for (let i=0;i<n;i++){ const j=i*4; L2[i]=(d[j]*77+d[j+1]*151+d[j+2]*28)>>8; }
  const blur = new Float32Array(L2); boxBlurF(blur, w, h, 1);
  const SH = 0.35;
  for (let i=0;i<n;i++){ const j=i*4; const add=(L2[i]-blur[i])*SH;
    d[j]  =Math.max(0,Math.min(255, d[j]  +add));
    d[j+1]=Math.max(0,Math.min(255, d[j+1]+add));
    d[j+2]=Math.max(0,Math.min(255, d[j+2]+add)); }
}

// ---- Photo-ID enhance (v10.79) ----
// For "Photo ID" mode the goal is the OPPOSITE of the document pipeline: keep the
// portrait LIGHT and the colours TRUE to what the camera saw (no ink-deepen, no
// contrast crush, no paper-flatten). Three gentle, colour-faithful steps:
//   1) White balance from NEUTRAL pixels (v11.28). The old grey-world average over
//      ALL bright pixels was poisoned by big coloured subjects — a blue cheque or a
//      colourful card body cancelled a warm room cast in the mean (or tripped the
//      off-axis guard), so the yellow tint was never removed. Now the sample is
//      bright + unclipped + LOW-CHROMA pixels only (true paper/laminate white), so
//      the card's own colour cannot skew the estimate — which also makes a strong
//      90% blend safe. Falls back to the old partial grey-world when too few
//      neutral pixels exist (e.g. card fills the frame edge-to-edge).
//   1b) Paper-whiten (v11.28): gentle desaturation of bright near-neutral pixels
//      only, feathered by luminance and chroma, to clear residual cast off the
//      paper. Anything with real colour (skin, flags, security print) has chroma
//      above the gate and is untouched.
//   2) Midtone LIFT via a gentle gamma (0.85) applied as a hue-preserving
//      luminance gain — brightens the face and mid-tones while leaving bright
//      laminate/highlights alone, so the portrait no longer reads dark.
//   3) A light 1px unsharp for crisp card text. No darkening anywhere.
export function idCardEnhance(d, w, h){
  const n = w*h;
  // 1) white balance from bright NEUTRAL pixels (v11.28) — immune to the card's
  //    own colour. Neutral = bright, not clipped, and max-min channel spread
  //    under 10% of the max channel (real paper/laminate white).
  let nR=0,nG=0,nB=0,nc=0;
  // cool-tint protection mask for the paper-whiten pass, taken BEFORE any WB:
  // a warm light cast always reads R>B, so a pixel that is B>R with visible
  // chroma is a GENUINE cool card tint (PAN blue wash, cheque security print,
  // passport guilloché) — never cast — and must survive even if a later WB
  // step happens to pull it near-neutral.
  const coolTint=new Uint8Array(n);
  for (let i=0;i<n;i++){ const j=i*4; const r=d[j], g=d[j+1], b=d[j+2];
    const mx=r>g?(r>b?r:b):(g>b?g:b), mn=r<g?(r<b?r:b):(g<b?g:b);
    if (b>r && (mx-mn)*20 >= mx) coolTint[i]=1;
    const L=(r*77+g*151+b*28)>>8;
    if (L<110 || L>=250) continue;
    if ((mx-mn)*10 < mx){ nR+=r; nG+=g; nB+=b; nc++; }
  }
  let wbDone=false;
  if (nc >= n*0.02){
    const mR=nR/nc, mG=nG/nc, mB=nB/nc, mean=(mR+mG+mB)/3;
    const offAxis = Math.abs(mG-(mR+mB)/2)/Math.max(1,mean);
    if (offAxis < 0.20){                          // wide guard: sample is neutral by construction
      const TGT=248, GMAX=1.6, BLEND=0.90;
      const mk=(m)=>{ let g=Math.min(GMAX, Math.max(1, TGT/Math.max(1,m))); return 1+(g-1)*BLEND; };
      const gr=mk(mR), gg=mk(mG), gb=mk(mB);
      const lr=new Uint8Array(256), lg=new Uint8Array(256), lb=new Uint8Array(256);
      for (let t=0;t<256;t++){ lr[t]=Math.min(255,Math.round(t*gr)); lg[t]=Math.min(255,Math.round(t*gg)); lb[t]=Math.min(255,Math.round(t*gb)); }
      for (let i=0;i<n;i++){ const j=i*4; d[j]=lr[d[j]]; d[j+1]=lg[d[j+1]]; d[j+2]=lb[d[j+2]]; }
      wbDone=true;
    }
  }
  if (!wbDone){
    // fallback: old partial grey-world over all bright pixels (pre-v11.28)
    const hl=new Uint32Array(256);
    for (let i=0;i<n;i++){ const j=i*4; hl[(d[j]*77+d[j+1]*151+d[j+2]*28)>>8]++; }
    let acc=0, thr=0;
    for (let t=0;t<256;t++){ acc+=hl[t]; if (acc>=n*0.60){ thr=t; break; } }
    if (thr<110) thr=110;
    let sR=0,sG=0,sB=0,c=0;
    for (let i=0;i<n;i++){ const j=i*4; const L=(d[j]*77+d[j+1]*151+d[j+2]*28)>>8;
      if (L>=thr){ sR+=d[j]; sG+=d[j+1]; sB+=d[j+2]; c++; } }
    if (c>0){
      const mR=sR/c, mG=sG/c, mB=sB/c, mean=(mR+mG+mB)/3;
      const offAxis = Math.abs(mG-(mR+mB)/2)/Math.max(1,mean);
      if (offAxis < 0.12){
        const TGT=248, GMAX=1.6, BLEND=0.55;
        const mk=(m)=>{ let g=Math.min(GMAX, Math.max(1, TGT/Math.max(1,m))); return 1+(g-1)*BLEND; };
        const gr=mk(mR), gg=mk(mG), gb=mk(mB);
        const lr=new Uint8Array(256), lg=new Uint8Array(256), lb=new Uint8Array(256);
        for (let t=0;t<256;t++){ lr[t]=Math.min(255,Math.round(t*gr)); lg[t]=Math.min(255,Math.round(t*gg)); lb[t]=Math.min(255,Math.round(t*gb)); }
        for (let i=0;i<n;i++){ const j=i*4; d[j]=lr[d[j]]; d[j+1]=lg[d[j+1]]; d[j+2]=lb[d[j+2]]; }
      }
    }
  }
  // 1b) paper-whiten (v11.28): pull residual cast off bright near-neutral pixels.
  //     Strength feathers in with luminance (185→225) and out with chroma: FULL
  //     below 5% relative chroma (unambiguously cast-on-white), fading to ZERO at
  //     10%, so genuine pale card tints — PAN's blue wash, passport guilloché —
  //     sit above the gate and are untouched, as are skin tones and strong colours.
  //     Pixels flagged as cool tints BEFORE white balance are skipped outright.
  for (let i=0;i<n;i++){
    if (coolTint[i]) continue;
    const j=i*4; const r=d[j], g=d[j+1], b=d[j+2];
    const L=(r*77+g*151+b*28)>>8;
    if (L<=185) continue;
    const mx=r>g?(r>b?r:b):(g>b?g:b), mn=r<g?(r<b?r:b):(g<b?g:b);
    const rel=(mx-mn)/Math.max(1,mx);
    if (rel>=0.10) continue;
    const tL=Math.min(1,(L-185)/40);
    const tC=rel<=0.05 ? 1 : (0.10-rel)/0.05;
    const k=0.85*tL*tC;
    d[j]  =Math.round(r+(L-r)*k);
    d[j+1]=Math.round(g+(L-g)*k);
    d[j+2]=Math.round(b+(L-b)*k);
  }
  // 2) BRIGHTNESS-ADAPTIVE shadow lift (v10.82). The old flat gamma (0.72) lifted
  //    the WHOLE image, which on a card shot on a DARK surface — where the camera
  //    over-exposes the card so it is already bright — pushed it further toward
  //    white, washing out the colours. Now the lift only touches shadows/midtones
  //    (below a knee), and its strength scales DOWN as the card's overall
  //    brightness rises: a dark/normally-lit card still gets a strong face lift,
  //    an already-bright (over-exposed) card barely gets lifted, so it is no
  //    longer blown out.
  let sumL=0;
  for (let i=0;i<n;i++){ const j=i*4; sumL+=(d[j]*77+d[j+1]*151+d[j+2]*28)>>8; }
  const meanL=sumL/n;
  const brightT=Math.max(0, Math.min(1, (meanL-150)/70));   // 0 dark … 1 bright
  const liftMax=0.50 - 0.34*brightT;                        // dark:0.50 → bright:0.16
  const KNEE=165;
  for (let i=0;i<n;i++){
    const j=i*4; const L=(d[j]*77+d[j+1]*151+d[j+2]*28)>>8;
    const lift=liftMax*Math.max(0, (KNEE-L)/KNEE);          // only below the knee
    if (lift>0){ const g=1+lift;
      d[j]  =Math.min(255, d[j]  *g);
      d[j+1]=Math.min(255, d[j+1]*g);
      d[j+2]=Math.min(255, d[j+2]*g);
    }
  }
  // 2b) gentle saturation + contrast RESTORE (v10.82) — counters the wash-out on
  //     over-exposed/dark-surface captures: a mild hue-preserving contrast
  //     deepens grey text and a moderate saturation lift brings back the faded
  //     flag colours. Tuned gently so a well-exposed card stays natural.
  const SATK=1.15, CON=0.06;
  for (let i=0;i<n;i++){
    const j=i*4; const L=(d[j]*77+d[j+1]*151+d[j+2]*28)>>8;
    let Lt=128+(L-128)*(1+CON); if(Lt<0)Lt=0; else if(Lt>255)Lt=255;
    const cg=Lt/Math.max(1,L);
    const r=d[j]*cg, g=d[j+1]*cg, b=d[j+2]*cg;
    const L3=(r*77+g*151+b*28)/256;
    d[j]  =Math.max(0,Math.min(255, L3+(r-L3)*SATK));
    d[j+1]=Math.max(0,Math.min(255, L3+(g-L3)*SATK));
    d[j+2]=Math.max(0,Math.min(255, L3+(b-L3)*SATK));
  }
  // 3) light unsharp for crisp card text
  const L2=new Float32Array(n);
  for (let i=0;i<n;i++){ const j=i*4; L2[i]=(d[j]*77+d[j+1]*151+d[j+2]*28)>>8; }
  const blur=new Float32Array(L2); boxBlurF(blur, w, h, 1);
  const SH=0.30;
  for (let i=0;i<n;i++){ const j=i*4; const add=(L2[i]-blur[i])*SH;
    d[j]  =Math.max(0,Math.min(255, d[j]  +add));
    d[j+1]=Math.max(0,Math.min(255, d[j+1]+add));
    d[j+2]=Math.max(0,Math.min(255, d[j+2]+add)); }
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
  // pass 1: cell mean luminance (also count genuinely dark pixels)
  const sumL=new Float32Array(cells), cnt=new Float32Array(cells);
  let dark=0;
  for (let y=0;y<h;y++){ const gy=Math.min(GH-1,(y*GH/h)|0), row=gy*GW;
    for (let x=0;x<w;x++){ const j=(y*w+x)*4;
      const L=(d[j]*77+d[j+1]*151+d[j+2]*28)>>8;
      if (L<64) dark++;
      const gi=row+cx(x); sumL[gi]+=L; cnt[gi]++; } }
  // photo-heavy / mostly-dark page: flattening would lift the big dark region
  // into grey, so leave it untouched. A real text document is well under 10%
  // dark (just the ink), so this only triggers on photos / dark-filled pages.
  if (dark > n*0.40) return;
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
    const q=bestRegionQuad(mask,w,h,bl,d);
    if (q) return q;
  }
  // pass 2: gradient fallback (same-tone paper separated only by an edge/shadow)
  return gradientQuad(bl,g,w,h,d);
}

// ---- document priors (v10.86): prefer things shaped and toned like a page ----
// bilinear point inside/along a quad: u across the top/bottom edges, v down
function quadPoint(q,u,v){
  const tx=q[0].x+(q[1].x-q[0].x)*u, ty=q[0].y+(q[1].y-q[0].y)*u;
  const bx=q[3].x+(q[2].x-q[3].x)*u, by=q[3].y+(q[2].y-q[3].y)*u;
  return { x:tx+(bx-tx)*v, y:ty+(by-ty)*v };
}
// HARD gate: a page/card seen by a hand-held phone has corners near 90°.
// ±25° tolerance covers real perspective; arbitrary trapezoids from surface
// edges, shadows and furniture fail this.
function quadAnglesOk(q){
  for (let i=0;i<4;i++){
    const a=q[(i+3)&3], b=q[i], c=q[(i+1)&3];
    const v1x=a.x-b.x, v1y=a.y-b.y, v2x=c.x-b.x, v2y=c.y-b.y;
    const m=Math.hypot(v1x,v1y)*Math.hypot(v2x,v2y)||1;
    const ang=Math.acos(Math.max(-1,Math.min(1,(v1x*v2x+v1y*v2y)/m)))*180/Math.PI;
    if (ang<65 || ang>115) return false;
  }
  return true;
}
// SOFT prior 0.5..1.0: aspect ratio close to a known document — A5/A4 portrait
// & Letter (~1.29–1.46) or an ISO ID-1 card (1.586: PAN, Aadhaar, voter card,
// driving licence). Off-ratio shapes are down-weighted, never rejected, so
// receipts/odd sizes still win when nothing better is in frame.
function aspectPrior(q){
  const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
  const s1=(dist(q[0],q[1])+dist(q[3],q[2]))/2;
  const s2=(dist(q[0],q[3])+dist(q[1],q[2]))/2;
  const ar=Math.max(s1,s2)/Math.max(1,Math.min(s1,s2));
  let best=0;
  for (const t of [1.294, 1.414, 1.586])
    best=Math.max(best, Math.exp(-((ar-t)/0.35)*((ar-t)/0.35)));
  return 0.5+0.5*best;
}
// SOFT prior 0.55..1.0: documents separate from their background (interior vs
// just-outside brightness) and paper/card faces are bright with low-to-moderate
// colour saturation. A patch of bare desk scores low on both. Soft on purpose —
// D2-style same-tone paper (shadow-line only) must stay detectable.
function docTonePrior(q, bl, d, w, h){
  let inSum=0, inN=0, satSum=0;
  for (let iu=0; iu<4; iu++) for (let iv=0; iv<4; iv++){
    const p=quadPoint(q, 0.2+0.6*iu/3, 0.2+0.6*iv/3);
    const x=p.x|0, y=p.y|0; if (x<0||y<0||x>=w||y>=h) continue;
    const i=y*w+x; inSum+=bl[i]; inN++;
    const j=i*4, r=d[j], g=d[j+1], b=d[j+2], mx=Math.max(r,g,b)||1;
    satSum+=(mx-Math.min(r,g,b))/mx;
  }
  if (!inN) return 0.55;
  const cx=(q[0].x+q[1].x+q[2].x+q[3].x)/4, cy=(q[0].y+q[1].y+q[2].y+q[3].y)/4;
  let outSum=0, outN=0;
  for (const [u,v] of [[0.5,0],[1,0.5],[0.5,1],[0,0.5],[0,0],[1,0],[1,1],[0,1]]){
    const e=quadPoint(q,u,v);
    const x=(e.x+(e.x-cx)*0.12)|0, y=(e.y+(e.y-cy)*0.12)|0;
    if (x<0||y<0||x>=w||y>=h) continue;
    outSum+=bl[y*w+x]; outN++;
  }
  const contrast = outN ? Math.abs(inSum/inN - outSum/outN) : 48;
  const cScore = Math.min(1, contrast/48);                    // 0..1
  const sat = satSum/inN;
  // v10.87: penalty starts at 0.30 saturation (was 0.45) with more weight, so
  // bare wood (sat ~0.3–0.6) scores low even away from the frame borders
  const pScore = 1 - Math.min(1, Math.max(0, sat-0.30)/0.35);
  return (0.55+0.45*cScore) * (0.7+0.3*pScore);
}
// v10.87 — surfaces (work table, bed) run OFF the frame; a document the user
// is aiming at sits INSIDE it. borderFrac = fraction of the quad's outline
// lying within ~2% of the frame border.
function borderFrac(q,w,h){
  const m = Math.max(3, 0.02*Math.min(w,h));
  let hit=0, tot=0;
  for (let s=0;s<4;s++){
    const a=q[s], b=q[(s+1)&3];
    const steps=Math.max(8, Math.round(Math.hypot(b.x-a.x,b.y-a.y)/4));
    for (let k=0;k<=steps;k++){
      const x=a.x+(b.x-a.x)*k/steps, y=a.y+(b.y-a.y)*k/steps;
      tot++;
      if (x<m || y<m || x>w-1-m || y>h-1-m) hit++;
    }
  }
  return hit/tot;
}
// warm-saturated interior (brown/orange, R>G>B) — wood, not paper or a card
function warmInterior(q,d,w,h){
  let r=0,g=0,b=0,sat=0,nn=0;
  for (let iu=0; iu<4; iu++) for (let iv=0; iv<4; iv++){
    const p=quadPoint(q, 0.2+0.6*iu/3, 0.2+0.6*iv/3);
    const x=p.x|0, y=p.y|0; if (x<0||y<0||x>=w||y>=h) continue;
    const j=(y*w+x)*4, mx=Math.max(d[j],d[j+1],d[j+2])||1;
    r+=d[j]; g+=d[j+1]; b+=d[j+2]; sat+=(mx-Math.min(d[j],d[j+1],d[j+2]))/mx; nn++;
  }
  if (!nn) return false;
  r/=nn; g/=nn; b/=nn; sat/=nn;
  return sat>0.25 && r>g*1.15 && g>b*1.05;
}
// combined off-frame surface penalty: soft for everything, extra-strong once
// most of the outline hugs the border (a surface, not an aimed-at document) —
// never a hard rejection, so a lone edge-to-edge page still detects
function offFramePenalty(bf){
  let p = 1 - 0.5*bf;
  if (bf > 0.6) p *= 0.35;
  return p;
}

// scan all connected components of a binary mask; return the best one that
// passes the document-shape tests. "best" = largest, but with a centre bias so
// the aimed-at document is preferred over an off-centre distractor (a trackpad,
// a keyboard, a phone) of comparable size. `opts.fill` / `opts.outline` relax
// the shape gates for the fallback pass (defaults are the strict values).
function bestRegionQuad(mask,w,h,bl,d){
  const n=w*h;
  const cw=w/2, ch=h/2, diag=Math.hypot(w,h)||1;
  const seen=dqBuf("seen",n,Uint8Array,true);    // visited flags: must start zeroed
  const stack=dqBuf("stack",n,Int32Array,false); // written via top pointer before read
  let best=null, bestScore=0, boundary=null;      // boundary stays lazy (built once per call)
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
    // area is the maximum possible (centre-weighted) score, so this still skips
    // components that can't beat the current best
    if (area < n*0.12 || area <= bestScore) continue;
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
    if (!quadAnglesOk(q)) continue;                 // v10.86: corners must be page-like
    const bf=borderFrac(q,w,h);
    // v10.87 wood gate: a warm-saturated region running off the frame is a
    // table top, never a page or an ID card — reject outright
    if (bf>0.6 && warmInterior(q,d,w,h)) continue;
    const qx=(tl.x+tr.x+br.x+blc.x)/4, qy=(tl.y+tr.y+br.y+blc.y)/4;
    const score=area*(1 - 0.6*Math.hypot(qx-cw,qy-ch)/diag)    // centre bias
               *aspectPrior(q)*docTonePrior(q,bl,d,w,h)        // v10.86 document priors
               *offFramePenalty(bf);                           // v10.87 surface penalty
    if (score>bestScore){ best=q; bestScore=score; }
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
function gradientQuad(bl,g,w,h,d){
  const n=w*h;
  const cw=w/2, ch=h/2, diag=Math.hypot(w,h)||1;
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
  let best=null, bestScore=0;
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
    if (span < n*0.15 || span <= bestScore) continue;   // span is the max possible score
    const q=[tl,tr,br,blc];
    if (quadArea(q) > n*0.95) continue;
    if (!quadIsSane(q,w,h)) continue;
    if (outlineCoverage(q,dil,w,h) < 0.80) continue;   // outline must really exist
    if (!quadAnglesOk(q)) continue;                    // v10.86: corners must be page-like
    const bf=borderFrac(q,w,h);
    if (bf>0.6 && warmInterior(q,d,w,h)) continue;     // v10.87 wood gate
    const qx=(tl.x+tr.x+br.x+blc.x)/4, qy=(tl.y+tr.y+br.y+blc.y)/4;
    // aspect prior only here — the tone prior needs an interior/surround
    // brightness difference, which same-tone shadow-line documents (the very
    // case this fallback exists for) legitimately don't have
    const score=span*(1 - 0.6*Math.hypot(qx-cw,qy-ch)/diag)*aspectPrior(q)*offFramePenalty(bf);
    if (score>bestScore){ best=q; bestScore=score; }
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
