/* Images tab — fills and wires the empty `[data-pane="images"]` pane that
 * content.js renders inside the Prompt Stacker panel.
 *
 * WHY THIS FILE LOADS ON ALL FIVE SITES (content-script block 1)
 * The engine only exists on ChatGPT, but the tab has to be able to say so. In
 * the original Grabber, gating lived in a file that was only injected on
 * chatgpt.com, so the "ChatGPT only" notice could never actually appear — off
 * ChatGPT the tab simply was not there, which just looks broken. Now every site
 * gets the tab and a disabled one explains itself.
 *
 * HOW IT TALKS TO THE ENGINE
 * Both content-script blocks share one isolated world, so window.ctigOpenPicker
 * / ctigGrabThread / ctigImageJobGate / ctigHistory (set by the block-2 files)
 * are reachable here and invisible to the page. No background worker, no relay,
 * no `tabs` permission — which is exactly why the merged extension still asks
 * for nothing but `storage`.
 */
(() => {
  "use strict";
  if (window.ctigImagesTabLoaded) return;
  window.ctigImagesTabLoaded = true;

  const isChatGpt = /(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/.test(location.hostname);
  const GATED = "Images works on ChatGPT only — open chatgpt.com to use it.";

  /** content.js builds the panel synchronously at document_idle; this is only a
   *  bounded safety net in case that ever stops being true. */
  function whenPaneReady(cb) {
    const find = () => document.querySelector('#cps-panel [data-pane="images"]');
    if (find()) return cb(find());
    let tries = 0;
    const timer = setInterval(() => {
      const pane = find();
      if (pane || ++tries > 20) {
        clearInterval(timer);
        if (pane) cb(pane);
      }
    }, 100);
  }

  function mount(pane) {
    if (pane.dataset.ctigWired === "1") return;
    pane.dataset.ctigWired = "1";

    pane.innerHTML = `
      <div class="cps-hint">
        Saves the original full-quality images as a ZIP — nothing cropped or recompressed.
      </div>
      <div class="cps-row">
        <button class="cps-btn cps-primary" id="cps-img-library" type="button">Pick from image library…</button>
      </div>
      <div class="cps-hint" id="cps-img-last"></div>
      <div class="cps-row">
        <button class="cps-btn" id="cps-img-thread" type="button">Grab all images in this thread</button>
      </div>
      <div class="cps-status" id="cps-img-status" role="status" aria-live="polite"></div>
    `;

    const panel = document.getElementById("cps-panel");
    const libBtn = pane.querySelector("#cps-img-library");
    const threadBtn = pane.querySelector("#cps-img-thread");
    const statusEl = pane.querySelector("#cps-img-status");
    const lastEl = pane.querySelector("#cps-img-last");

    const setStatus = (text) => {
      if (statusEl) statusEl.textContent = text || "";
    };

    // --- last download line -------------------------------------------------
    function refreshLast() {
      if (!lastEl) return;
      const read = window.ctigHistory;
      const info = typeof read === "function" ? read() : null;
      if (!info || !info.runAt) {
        lastEl.textContent = "";
        return;
      }
      let when = info.runAt;
      try {
        when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
          new Date(info.runAt)
        );
      } catch (_) {}
      lastEl.textContent = `Last download ${when}${info.count ? ` · ${info.count} images` : ""}.`;
    }

    // --- one job at a time, both buttons -----------------------------------
    // Either image job disables both buttons. The engine re-checks the same
    // conditions itself (window.ctigImageJobGate) because a disabled button is
    // not a guarantee — but this is what the user actually sees.
    function setBusy(busy) {
      libBtn.disabled = busy || !isChatGpt;
      threadBtn.disabled = busy || !isChatGpt;
    }
    window.ctigImageBusyChanged = setBusy;

    if (!isChatGpt) {
      setBusy(false);
      setStatus(GATED);
      // Keep the tab clickable so the notice is readable, and refresh the line
      // in case the user comes back on a ChatGPT tab later.
      return;
    }

    setBusy(false);
    setStatus("");

    // --- the picker ---------------------------------------------------------
    let hidForPicker = false;

    // The engine calls this from close(), on every close path.
    window.ctigPickerClosed = () => {
      refreshLast();
      if (!hidForPicker) return;
      hidForPicker = false;
      if (panel) panel.style.display = "";
    };

    libBtn.addEventListener("click", () => {
      if (typeof window.ctigOpenPicker !== "function") {
        setStatus("The image engine has not loaded yet — reload the page.");
        return;
      }
      // Tell the engine's navigation watchdog to leave this picker alone: it is
      // legitimately open off /images, because the feed API works from any
      // chatgpt.com page.
      window.ctigPanelHold = true;
      // The panel's z-index (2147483647) is above the picker's whole stack, so
      // collapsing is not enough — it has to go away entirely.
      if (panel && panel.style.display !== "none") {
        hidForPicker = true;
        panel.style.display = "none";
      }
      window.ctigOpenPicker();
      let queueRunning = false;
      try {
        queueRunning = typeof window.cpsIsRunning === "function" && window.cpsIsRunning();
      } catch (_) {}
      setStatus(
        queueRunning
          ? "Picker open — browsing is fine, and Download will wait until you pause the prompt queue."
          : "Picker open — click images to select, then Download."
      );
    });

    // --- a whole thread -----------------------------------------------------
    threadBtn.addEventListener("click", async () => {
      if (typeof window.ctigGrabThread !== "function" || typeof window.ctigImageJobGate !== "function") {
        setStatus("The image engine has not loaded yet — reload the page.");
        return;
      }
      setBusy(true);
      let started = false;
      try {
        const blocked = await window.ctigImageJobGate();
        if (blocked) {
          setStatus(blocked);
          return;
        }
        started = true;
        window.ctigBusy = true;
        setStatus("Scanning the thread…");
        const result = await window.ctigGrabThread((text) => setStatus(text));
        if (!result || !result.ok) {
          setStatus((result && result.error) || "Failed.");
        } else if (!result.saved) {
          setStatus(result.message || "No images found in this thread.");
        } else {
          const mb = (result.bytes / 1048576).toFixed(1);
          const parts = result.parts && result.parts.length > 1 ? ` in ${result.parts.length} parts` : "";
          setStatus(
            `Saved ${result.saved} images (${mb} MB)${parts}.` +
              (result.failed ? ` ${result.failed} failed — see index.tsv.` : "")
          );
        }
      } catch (error) {
        setStatus(String((error && error.message) || error));
      } finally {
        // A refused job owns nothing. In particular, it must not release a
        // queue's lock or clear another image job's busy flag in this tab.
        if (started) {
          window.ctigBusy = false;
          if (window.cpsBusy) await window.cpsBusy.release();
        }
        setBusy(!!window.ctigBusy);
      }
    });

    // --- housekeeping -------------------------------------------------------
    // Refresh the "last download" line whenever the user comes back to this tab,
    // and say something if another tab took the lock off us mid-job.
    const tabButton = panel && panel.querySelector('.cps-tab[data-tab="images"]');
    if (tabButton) tabButton.addEventListener("click", refreshLast);
    if (window.cpsBusy && window.cpsBusy.onLost) {
      window.cpsBusy.onLost(() => {
        setStatus("Another tab took over the image lock — if a download is still running here, let it stop first.");
      });
    }
    refreshLast();
  }

  whenPaneReady(mount);
})();
