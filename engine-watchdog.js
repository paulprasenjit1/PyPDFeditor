"use strict";
/* engine-watchdog.js — visible failure when the engine never starts.
   app.js is an ES module that imports the MuPDF WASM engine via top-level
   await. If that import never resolves (a partial/corrupt cache, a failed
   first download, or an unsupported runtime), the module body never runs — so
   app.js's own error/rejection handlers never attach and the UI would sit on
   "Loading engine…" forever with no message and no way out.

   This tiny CLASSIC script runs independently of the module pipeline, so it
   executes even when the module fails. It does two things at parse time:

   1) DOWNLOAD PROGRESS. The MuPDF wrapper boots the engine with
      `libmupdf_wasm(globalThis["$libmupdf_wasm_Module"])`, which is Emscripten's
      Module config. By setting an `instantiateWasm` hook on that global BEFORE
      the module loads, we take over fetching the ~10 MB .wasm ourselves: we
      stream it, report real byte progress as a bar on the welcome screen, then
      hand the compiled instance back. It's a SINGLE download (the engine no
      longer fetches it itself) and degrades gracefully — any failure falls back
      to the engine's own streaming load, and an instant (cached) load shows no
      bar at all. No vendor files are modified.

   2) FAILURE WATCHDOG. A timer; if the engine hasn't signalled "ready" in time
      it shows a tap-to-reload message instead of a frozen "Loading engine…".

   No inline code or styles (CSP stays 'self'; widths/cursor go through the
   CSSOM, like the rest of the app). */
(function(){
  var READY_MS = 30000;                        // generous: first load fetches ~10MB WASM
  if (window.__pypdfEngineReady) return;        // already up (e.g. fast cache hit)

  // ---- (1) engine download progress via the Emscripten instantiateWasm hook ----
  var WASM_URL;
  try { WASM_URL = new URL("./vendor/mupdf/mupdf-wasm.wasm", document.baseURI).href; }
  catch(e){ WASM_URL = "./vendor/mupdf/mupdf-wasm.wasm"; }
  var barWrap = null, barFill = null, shownBar = false;

  function showProgress(received, total){
    if (window.__pypdfEngineReady) return;
    var pct = total ? Math.round(received / total * 100) : null;
    if (!shownBar){
      if (pct !== null && pct >= 100) return;   // arrived in one shot (cached): no bar/flash
      var welcome = document.querySelector(".welcome");
      if (welcome){
        barWrap = document.createElement("div"); barWrap.className = "engbar";
        barFill = document.createElement("div"); barFill.className = "engbar-fill";
        barWrap.appendChild(barFill);
        var hint = document.getElementById("welcomeHint");
        if (hint && hint.nextSibling) welcome.insertBefore(barWrap, hint.nextSibling);
        else welcome.appendChild(barWrap);
      }
      shownBar = true;
    }
    var h = document.getElementById("welcomeHint");
    if (pct !== null){
      if (barFill) barFill.style.width = pct + "%";
      if (h) h.textContent = "Downloading engine… " + pct + "% (first time only)";
    } else if (h){
      h.textContent = "Downloading engine… " + (received / 1048576).toFixed(1) + " MB (first time only)";
    }
  }

  // v12.23: a CACHE HIT MUST NEVER REPORT PROGRESS.
  //
  // Reported: "app is offline but shows Downloading when I open it after a day".
  // It was not downloading — it was reading the cached wasm and mislabelling it.
  // Two things combined:
  //   1. the entry this file stores was built as `new Response(arrayBuffer)`,
  //      which carries NO Content-Length (verified, not assumed);
  //   2. so on a cached read `total` was 0, `pct` was null, and the "arrived in
  //      one shot (cached): no bar" guard below — which only fires when pct is
  //      known — fell through to the unknown-size text.
  // Within a day iOS keeps the page suspended, so the boot never re-ran; after
  // about a day it reclaims it and the cold start showed the message.
  //
  // Asking the cache first makes it deterministic rather than inferred from
  // headers: cache hit means no bar, full stop. A large cached body can arrive
  // in several chunks, so a percentage guard alone would still flash the bar.
  function readCachedWasm(url){
    try {
      if (typeof caches === "undefined" || !caches.match) return Promise.resolve(null);
      return caches.match(url).then(function(hit){
        return hit ? hit.arrayBuffer() : null;
      }).catch(function(){ return null; });
    } catch(e){ return Promise.resolve(null); }
  }

  function streamWasm(url){
    return readCachedWasm(url).then(function(cached){
      return cached || fetchWasm(url);       // only a network read shows progress
    });
  }

  function fetchWasm(url){
    return fetch(url, { credentials: "same-origin" }).then(function(res){
      if (!res || !res.ok) throw new Error("wasm " + (res && res.status));
      var total = +(res.headers.get("Content-Length") || 0);
      if (!res.body || !res.body.getReader) return res.arrayBuffer();   // no streaming: no progress
      var reader = res.body.getReader(), chunks = [], received = 0;
      return (function pump(){
        return reader.read().then(function(r){
          if (r.done){
            var out = new Uint8Array(received), pos = 0;
            for (var i = 0; i < chunks.length; i++){ out.set(chunks[i], pos); pos += chunks[i].length; }
            return out.buffer;
          }
          chunks.push(r.value); received += r.value.length;
          try { showProgress(received, total); } catch(e){}
          return pump();
        });
      })();
    });
  }

  // Only install the hook where it can work; if anything is missing the engine
  // loads itself exactly as before.
  if (typeof WebAssembly !== "undefined" && typeof WebAssembly.instantiate === "function" && typeof fetch === "function"){
    globalThis.$libmupdf_wasm_Module = {
      instantiateWasm: function(imports, success){
        streamWasm(WASM_URL)
          .then(function(buf){
            // store the single download so offline + later loads work without a
            // second fetch (sw.js no longer precaches the wasm). VENDOR_CACHE name
            // must match sw.js; the fetch handler there matches by URL.
            // v12.23: carry Content-Length. sw.js's fetch handler already
            // cached the real network response under this same key, and this
            // put overwrites it — so without the length the stored entry was
            // strictly worse than the one it replaced.
            try { caches.open("pypdf-vendor-v1").then(function(c){
              c.put(WASM_URL, new Response(buf.slice(0), { headers:{
                "Content-Type": "application/wasm",
                "Content-Length": String(buf.byteLength)
              } }));
            }).catch(function(){}); } catch(e){}
            return WebAssembly.instantiate(buf, imports);
          })
          .then(function(res){ success(res.instance, res.module); })
          .catch(function(){
            // fall back to the engine's own load (no progress, but it still works)
            try {
              WebAssembly.instantiateStreaming(fetch(WASM_URL, { credentials: "same-origin" }), imports)
                .then(function(res){ success(res.instance, res.module); })
                .catch(function(){ /* watchdog timeout below will offer a reload */ });
            } catch(e){}
          });
        return {};   // signal async instantiation to Emscripten
      }
    };
  }

  // ---- (1b) instant open (v10.94) ----
  // The file picker needs no engine, so let the user tap Open (or the welcome
  // button) immediately instead of staring at disabled buttons for the 1–3s
  // WASM compile. A file picked early is stashed on window.__pypdfPendingFile;
  // app.js opens it the moment the engine is live. Once the engine is ready,
  // these early handlers become inert (app.js owns the flow). The first-paint
  // splash is also dropped as soon as the welcome screen exists — the app is
  // interactive during the engine load instead of hiding behind the logo.
  function wireEarlyOpen(){
    var open = document.getElementById("openBtn"), big = document.getElementById("bigOpen"),
        inp = document.getElementById("fileInput"), hint = document.getElementById("welcomeHint"),
        launch = document.getElementById("launch");
    if (!inp) return;
    var early = function(){ if (window.__pypdfEngineReady) return; inp.click(); };
    if (open){ open.disabled = false; open.addEventListener("click", early); }
    if (big){ big.disabled = false; big.addEventListener("click", early); }
    inp.addEventListener("change", function(e){
      if (window.__pypdfEngineReady) return;       // app.js owns the flow now
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      window.__pypdfPendingFile = f;
      if (hint) hint.textContent = "Got “" + f.name + "” — opening as soon as the engine is ready…";
    });
    if (launch) setTimeout(function(){ launch.classList.add("gone"); }, 350);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wireEarlyOpen);
  else wireEarlyOpen();

  // ---- (2) failure watchdog ----
  var fired = false;
  var timer = setTimeout(function(){
    if (window.__pypdfEngineReady) return;
    fired = true;
    var s = document.getElementById("status");
    if (!s) return;
    s.textContent = "The PDF engine is taking too long to start — it may not have "
      + "downloaded fully. Tap here to reload; if it keeps happening, reopen the app.";
    s.className = "status err";
    try { s.style.cursor = "pointer"; } catch(e){}
    s.addEventListener("click", function(){ location.reload(); }, { once:true });
  }, READY_MS);

  function ready(){
    window.__pypdfEngineReady = true;
    clearTimeout(timer);
    clearInterval(poll);
    if (barWrap && barWrap.parentNode) barWrap.parentNode.removeChild(barWrap);   // tidy up the bar
  }
  window.addEventListener("pypdf-engine-ready", ready);
  // Insurance in case the event fired before this listener attached: poll the
  // flag too. Stops as soon as the engine is up (or the watchdog has fired).
  var poll = setInterval(function(){
    if (window.__pypdfEngineReady){ ready(); }
    else if (fired){ clearInterval(poll); }
  }, 1000);
})();
