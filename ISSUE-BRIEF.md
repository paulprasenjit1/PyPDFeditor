# Two unresolved iOS PWA layout bugs

## Environment

- iPhone 16 Pro Max, current iOS. Installed to the home screen from Safari
  (standalone PWA), not run in a browser tab.
- Single-page app, vanilla JS + CSS. No framework.
- Strict CSP: `style-src 'self'` — **no inline `<style>`, no `style=` attributes**.
  All dynamic styling must go through the CSSOM (`el.style.x`), which is allowed.

```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
```
manifest: `"display": "standalone"`

Relevant CSS:

```css
html, body { margin:0; height:100%; overscroll-behavior:none; }
body { display:flex; flex-direction:column;
       height:100dvh; overflow:hidden; overscroll-behavior:none; }

/* app chrome */
header  { position:fixed; top:0; left:0; right:0; z-index:30;
          padding:max(3px, env(safe-area-inset-top)) 14px 3px; }
.toolbar{ position:fixed; bottom:0; left:0; right:0; z-index:30;
          display:flex; align-items:center;
          padding:3px 6px max(2px, calc(env(safe-area-inset-bottom) - 30px));
          background:rgba(16,16,18,.96); backdrop-filter:blur(16px) saturate(1.6); }

/* full-screen scanner panel */
.scanui   { position:fixed; inset:0; z-index:90; background:#000;
            display:none; flex-direction:column; }
.scanui.show { display:flex; }
/* children in order: .scantop, .scanview, .scantype, .scanthumbs, .scanctl */
.scanview { position:relative; flex:1; overflow:hidden; background:#000; }
.scanview video { position:absolute; left:0; top:0; width:100%; height:100%;
                  object-fit:contain; opacity:0; transition:opacity .18s ease; }
.scanview video.ready { opacity:1; }
```

---

## Issue 1 — black band below the fixed bottom toolbar

**Symptom.** Intermittently, a band of black roughly 50–60 CSS px tall appears
*below* the bottom toolbar. The toolbar's buttons sit that much higher than the
bottom of the screen. Sometimes it is correct instead. The header at the top is
in exactly the same position in both the good and bad cases, so the whole page
is not shifted — only the bottom is wrong.

**Timing correlation.** It is present in the first seconds after the app is
launched and gone later. (Established by noticing that it correlates perfectly
with a transient "Ready…" toast that shows for a few seconds after launch and
then fades — the toast is `position:fixed` and cannot itself affect layout, so
it is acting purely as a clock.)

**What has been tried and did not work:**

1. Measuring `visualViewport.height + visualViewport.offsetTop -
   window.innerHeight` and correcting by that. On this device those values
   **agree even when the gap is visible**, so it computed 0 and did nothing.
2. Applying the correction as `padding-bottom` on the toolbar. This cannot
   work: padding on an element with `bottom:0` grows it **upward**; the bottom
   edge never moves.
3. Measuring the toolbar's own `getBoundingClientRect().bottom` against
   `window.innerHeight`, and applying the correction as a negative `bottom`
   plus matching padding. Still not fixed on device.
4. Adding a second term comparing `window.innerHeight` against
   `window.screen.height` (gated to standalone only, and to shortfalls ≤120px).
   Still not fixed on device.

Current measurement code:

```js
function bottomShortfall(){
  const bar = document.getElementById("toolbar");
  const r = bar.getBoundingClientRect();
  // term 1: is the bar where the viewport says the bottom is?
  let gap = Math.round(window.innerHeight - r.bottom);
  // term 2: does the viewport itself reach the bottom of the screen?
  let short = 0;
  const standalone = window.navigator.standalone === true
    || window.matchMedia("(display-mode: standalone)").matches;
  if (standalone && window.screen && window.screen.height){
    const portrait = window.innerHeight >= window.innerWidth;
    const screenH = portrait ? Math.max(screen.width, screen.height)
                             : Math.min(screen.width, screen.height);
    const d = Math.round(screenH - window.innerHeight);
    if (d > 0 && d <= 120) short = d;
  }
  return gap + short;
}
// result fed into a CSS custom property --vvdrop, used as:
//   .toolbar { bottom: calc(0px - var(--vvdrop));
//              padding-bottom: calc(var(--botpad) + var(--vvdrop)); }
// re-run on resize, orientationchange, visualViewport resize/scroll,
// visibilitychange, a timeout ladder [0,150,400,900,1800]ms, and a 500ms poll
// for the first 10 seconds.
```

**Unknown:** which of the two terms is failing, or whether both read zero while
the gap is visible. No on-device numbers have been captured at the moment the
gap is showing.

---

## Issue 2 — camera preview opens small, then jumps to full size

**Symptom.** Opening the scanner shows the live camera preview rendered much
smaller than its container — a small window centred in a large black area —
then a fraction of a second later it snaps to the correct size. Persistent
across many attempts to fix.

**Key discriminating observation (important):**

- Force-quit the app and reopen → iOS shows the camera permission prompt →
  preview opens at the **correct** size, no glitch.
- Then cancel the scanner and reopen it → the small-preview glitch **appears**.

The difference is that on a first open `getUserMedia()` blocks for seconds
behind the permission prompt, so many frames pass before anything measures the
layout. On a reopen the grant is already held and `getUserMedia()` resolves in
milliseconds — measuring a panel that was made visible microseconds earlier:

```js
document.getElementById("scanCam").classList.add("show"); // .scanui display:none -> flex
await startCamera();                                      // getUserMedia
```

**The sizing code.** The preview is not sized by CSS percentages; explicit pixel
geometry is computed and written, because plain `width:100%; height:100%;
object-fit:contain` was previously observed not to fill the box on this device:

```js
function containFit(srcW, srcH, boxW, boxH){
  const scale = Math.min(boxW/srcW, boxH/srcH);
  return { scale, dispW:srcW*scale, dispH:srcH*scale,
           offX:(boxW - srcW*scale)/2, offY:(boxH - srcH*scale)/2 };
}

function fitPreviewBox(){
  const view = document.getElementById("scanView");   // .scanview, flex:1
  const v    = document.getElementById("scanVideo");
  const bw = view.clientWidth|0,  bh = view.clientHeight|0;
  const vw = v.videoWidth|0,      vh = v.videoHeight|0;
  if (bw <= 0 || bh <= 0 || vw <= 0 || vh <= 0) return null;
  const f = containFit(vw, vh, bw, bh);
  v.style.left   = Math.round(f.offX) + "px";
  v.style.top    = Math.round(f.offY) + "px";
  v.style.width  = Math.round(f.dispW) + "px";
  v.style.height = Math.round(f.dispH) + "px";
  v.style.right = "auto"; v.style.bottom = "auto";
  return { bw, bh, vw, vh };
}
```

The camera stream is a 4:3 sensor request (`width:{ideal:4032},
height:{ideal:3024}`), which iOS returns rotated to portrait in this
orientation.

**What has been tried and did not work:**

1. Re-fit on a `ResizeObserver` watching `.scanview`.
2. Re-fit on every tick of an existing `setInterval` live-detection loop
   (cheap, no-ops when neither the box nor the stream size changed).
3. Hold the video at `opacity:0` until the computed fit is unchanged for three
   consecutive animation frames, or a 1200ms timeout — i.e. do not reveal the
   unsettled state at all.
4. Wait two animation frames (`requestAnimationFrame` twice — a style recalc
   and a layout pass) after `.scanui` is shown and before the camera can start,
   in both the open path and the resume path.

Fixes 1 and 2 demonstrably *do* correct the size — which is precisely why the
preview "becomes normal" — but the correction lands after the preview is
already on screen.

**Unresolved contradiction.** Measuring the rendered preview off a screenshot
gives roughly 690×920 device-independent px inside what appears to be a
920×1420 container. That is not a `containFit` result for that container
(width-limited would give 920×1227), nor a CSS `object-fit:contain` result, nor
a transposition of either. So the working model of what box the fit ran against
is wrong. No `getBoundingClientRect()` values have been captured on device at
the moment the small preview is visible.

---

## Working hypothesis (unconfirmed)

Both symptoms may share one cause: `position:fixed` elements resolving against
an initial containing block that is shorter than the visible viewport for a
short period after launch / after the panel is shown.

- `.toolbar { position:fixed; bottom:0 }` would then sit above the true screen
  bottom → black band.
- `.scanui { position:fixed; inset:0 }` would be short → `.scanview { flex:1 }`
  short → preview fitted into a small box → small preview.
- Both would self-correct when the containing block updates.

**Evidence against it:** in a screenshot capturing the small preview, the
scanner's own bottom controls appear near the bottom of the screen, which
argues `.scanui` was *not* short at that moment.

## What would actually settle this

On-device `getBoundingClientRect()` / `innerHeight` / `screen.height` values
**captured at the moment each bug is visible** (recorded per frame during the
first seconds, not read afterwards — both bugs self-correct, so a later reading
shows healthy values).

## Questions worth answering

1. In an iOS standalone PWA with `viewport-fit=cover`, are there known
   conditions where `position:fixed; bottom:0` does not reach the bottom of the
   screen, and where `visualViewport` and `innerHeight` agree while it happens?
2. Is `100dvh` on `body` reliable in that context, and does it differ from the
   containing block used by `position:fixed`?
3. Is there a reason `width:100%; height:100%; object-fit:contain` on a
   `<video>` inside a `flex:1` container would fail to fill that container on
   iOS Safari, which is what motivated the JS pixel sizing in the first place?
4. Is a layout structure without any `position:fixed` for the full-screen panel
   and bottom bar (normal flex children of a `height:100dvh` body) the better
   answer than measuring and correcting?
