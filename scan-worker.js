"use strict";
/* scan-worker.js — heavy pixel work for the document scanner, off the main
   thread so the UI never freezes during "Use page".
   Receives: { id, buf (RGBA ArrayBuffer), w, h, quad (4 corners TL,TR,BR,BL
   in image px), filter ("colour"|"bw") } with the buffer transferred.
   Returns:  { id, ok:true, buf, w, h } (transferred) or { id, ok:false, err }.
   The math here must stay IDENTICAL to the fallback copies in app.js —
   the build is validated by comparing outputs byte-for-byte. */

self.onmessage = (e)=>{
  const { id, buf, w, h, quad, filter } = e.data;
  try {
    const src = new Uint8ClampedArray(buf);
    const out = warpCore(src, w, h, quad);
    if (filter === "bw") applyDocBW(out.data, out.w, out.h);
    else applyAutoContrast(out.data, out.w, out.h);
    self.postMessage({ id, ok:true, buf:out.data.buffer, w:out.w, h:out.h }, [out.data.buffer]);
  } catch (err){
    self.postMessage({ id, ok:false, err:String((err && err.message) || err) });
  }
};

// ---- perspective correction (homography + bilinear sampling) ----
function warpCore(sd, sw, sh, q){
  const dist=(a,b)=>Math.hypot(a.x-b.x, a.y-b.y);
  let ow=Math.max(dist(q[0],q[1]), dist(q[3],q[2]));
  let oh=Math.max(dist(q[0],q[3]), dist(q[1],q[2]));
  const cap=2000/Math.max(ow,oh);
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
function homographyTo(q,W,H){
  const dst=[{x:0,y:0},{x:W,y:0},{x:W,y:H},{x:0,y:H}];
  const M=[];
  for (let i=0;i<4;i++){
    const {x:u,y:v}=dst[i], {x,y}=q[i];
    M.push([u,v,1,0,0,0,-u*x,-v*x,x]);
    M.push([0,0,0,u,v,1,-u*y,-v*y,y]);
  }
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
function applyAutoContrast(d,w,h){
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
function applyDocBW(d,w,h){
  const n=w*h;
  const g=new Uint8Array(n);
  let gsum=0;
  for (let i=0;i<n;i++){ const j=i*4; const v=(d[j]*77+d[j+1]*151+d[j+2]*28)>>8; g[i]=v; gsum+=v; }
  const gmean=gsum/n;
  const f=8, mw=Math.max(1,Math.ceil(w/f)), mh=Math.max(1,Math.ceil(h/f));
  const sum=new Float64Array(mw*mh), cnt=new Float64Array(mw*mh);
  for (let y=0;y<h;y++){ const my=(y/f)|0;
    for (let x=0;x<w;x++){ const mi=my*mw+((x/f)|0); sum[mi]+=g[y*w+x]; cnt[mi]++; } }
  const mean=new Float32Array(mw*mh);
  for (let i=0;i<mw*mh;i++) mean[i]=cnt[i]?sum[i]/cnt[i]:255;
  boxBlurF(mean,mw,mh,6); boxBlurF(mean,mw,mh,6);
  const floor=Math.max(60, gmean*0.55);
  for (let i=0;i<mw*mh;i++) if (mean[i]<floor) mean[i]=floor;
  const sig=new Uint8Array(511);
  for (let i=0;i<511;i++){
    let v=Math.round(255/(1+Math.exp(-(i-255)/5)));
    if (v>=215) v=255; else if (v<=40) v=0;
    sig[i]=v;
  }
  for (let y=0;y<h;y++){
    const my=Math.min(mh-1,(y/f)|0);
    for (let x=0;x<w;x++){
      const m=mean[my*mw+Math.min(mw-1,(x/f)|0)];
      const t=m-(10+m*0.06);
      const o=sig[Math.max(0,Math.min(510,Math.round(g[y*w+x]-t)+255))];
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
