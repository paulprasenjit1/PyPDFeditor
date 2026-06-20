"use strict";
/* engine-watchdog.js — visible failure when the engine never starts.
   app.js is an ES module that imports the MuPDF WASM engine via top-level
   await. If that import never resolves (a partial/corrupt cache, a failed
   first download, or an unsupported runtime), the module body never runs — so
   app.js's own error/rejection handlers never attach and the UI would sit on
   "Loading engine…" forever with no message and no way out.

   This tiny CLASSIC script runs independently of the module pipeline, so it
   executes even when the module fails. It starts a timer at parse time; if the
   engine has not signalled "ready" in time, it shows a plain message and makes
   the status line tap-to-reload. If the engine starts normally it cancels
   silently and costs nothing. No inline code or styles (CSP stays 'self';
   the cursor hint is set via the CSSOM, like the rest of the app). */
(function(){
  var READY_MS = 20000;                       // generous: first load fetches ~10MB WASM
  if (window.__pypdfEngineReady) return;       // already up (e.g. fast cache hit)

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
  }
  window.addEventListener("pypdf-engine-ready", ready);
  // Insurance in case the event fired before this listener attached: poll the
  // flag too. Stops as soon as the engine is up (or the watchdog has fired).
  var poll = setInterval(function(){
    if (window.__pypdfEngineReady){ clearTimeout(timer); clearInterval(poll); }
    else if (fired){ clearInterval(poll); }
  }, 1000);
})();
