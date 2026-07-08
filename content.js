/* ===========================================================================
   ChatGPT Prompt Stacker — content script
   Queues prompts and sends the next one when ChatGPT finishes replying.
   Only clicks the same buttons a human would; no network calls, no scraping.
   =========================================================================== */
(() => {
  "use strict";

  // ==========================================================================
  // Pure helpers (no DOM) — also exported for unit tests at the bottom.
  // ==========================================================================

  // Split raw textarea input into individual prompts. Prompts are separated by
  // a blank line or a line containing only `---`, so a single prompt can span
  // multiple lines.
  function parsePrompts(text) {
    // Separator = a `---` line (with optional blank lines around it) or a
    // single blank line. The `---` variant is matched first so it consumes the
    // surrounding blanks instead of leaving "---" as its own prompt.
    return String(text)
      .split(/\n(?:[ \t]*\n)?[ \t]*---[ \t]*\n(?:[ \t]*\n)?|\n[ \t]*\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // Collect unique {{variable}} names across a list of prompts, in first-seen
  // order.
  function extractVars(prompts) {
    const seen = [];
    const re = /\{\{\s*([^}]+?)\s*\}\}/g;
    for (const p of prompts) {
      let m;
      while ((m = re.exec(p)) !== null) {
        const name = m[1].trim();
        if (name && !seen.includes(name)) seen.push(name);
      }
    }
    return seen;
  }

  // Replace {{variable}} tokens with provided values. Unknown tokens are left
  // intact so nothing is silently dropped.
  function applyVars(text, values) {
    return String(text).replace(/\{\{\s*([^}]+?)\s*\}\}/g, (whole, raw) => {
      const name = raw.trim();
      return Object.prototype.hasOwnProperty.call(values, name)
        ? values[name]
        : whole;
    });
  }

  // Serialize / parse a queue for export & import (blank-line separated).
  function serializeQueue(queue) {
    return queue.join("\n\n---\n\n");
  }

  // Node export for tests — guarded so it is a no-op inside the browser.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      parsePrompts,
      extractVars,
      applyVars,
      serializeQueue,
    };
  }

  // Everything below needs a DOM. Skip it entirely under Node (tests).
  if (typeof document === "undefined") return;

  // ==========================================================================
  // State
  // ==========================================================================
  let queue = []; // string[] — reusable prompt list
  let chains = []; // [{ id, name, prompts }]
  let runState = "idle"; // "idle" | "running" | "paused"
  let cancel = false;
  let sentCount = 0;
  let totalCount = 0;
  let currentQueueIndex = -1; // which visible queue row is sending
  let activeTab = "queue";

  const settings = {
    delay: 0, // seconds between prompts
    repeat: 1, // run the whole queue N times
    newChatPerPrompt: false,
    autoContinue: true,
    autoPauseOnLimit: false,
    themeMode: "auto", // "auto" | "dark" | "light"
  };

  const KEY_QUEUE = "cps_queue";
  const KEY_CHAINS = "cps_chains";
  const KEY_SETTINGS = "cps_settings";

  // ==========================================================================
  // ChatGPT DOM helpers — selectors kept loose so small UI changes survive.
  // ==========================================================================
  function getEditor() {
    return (
      document.querySelector("#prompt-textarea") ||
      document.querySelector('div[contenteditable="true"]') ||
      document.querySelector("textarea")
    );
  }

  function getSendButton() {
    return (
      document.querySelector('button[data-testid="send-button"]') ||
      document.querySelector('button[aria-label*="Send" i]')
    );
  }

  // Present only while ChatGPT is generating a reply.
  function getStopButton() {
    return (
      document.querySelector('button[data-testid="stop-button"]') ||
      document.querySelector('button[aria-label*="Stop" i]')
    );
  }

  function isGenerating() {
    return !!getStopButton();
  }

  function getContinueButton() {
    const btns = document.querySelectorAll("button");
    for (const b of btns) {
      const t = (b.textContent || "").trim().toLowerCase();
      if (t.includes("continue generating")) return b;
    }
    return null;
  }

  function getNewChatButton() {
    return (
      document.querySelector('[data-testid="create-new-chat-button"]') ||
      document.querySelector('a[aria-label*="New chat" i]') ||
      document.querySelector('button[aria-label*="New chat" i]')
    );
  }

  // Best-effort usage-limit detection (heuristic, off by default).
  function detectLimit() {
    const txt = (document.body.innerText || "").toLowerCase();
    return (
      txt.includes("you've reached") ||
      txt.includes("you’ve reached") ||
      txt.includes("reached the current usage") ||
      txt.includes("usage limit")
    );
  }

  // Insert text into ChatGPT's editor. execCommand("insertText") is the
  // reliable path for the ProseMirror contenteditable (plain assignment is
  // ignored by its internal state).
  function setPromptText(text) {
    const editor = getEditor();
    if (!editor) return false;
    editor.focus();

    if (editor.tagName === "TEXTAREA") {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value"
      ).set;
      setter.call(editor, text);
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }

    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand("insertText", false, text);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }

  function clickSend() {
    const btn = getSendButton();
    if (btn && !btn.disabled) {
      btn.click();
      return true;
    }
    const editor = getEditor();
    if (editor) {
      editor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
        })
      );
      return true;
    }
    return false;
  }

  // ==========================================================================
  // Timing
  // ==========================================================================
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(test, { timeout = 15000, interval = 300 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (cancel) return false;
      if (test()) return true;
      await sleep(interval);
    }
    return false;
  }

  // Cancel/pause-aware sleep in small slices.
  async function sleepCancelable(ms) {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (cancel) return false;
      await sleep(Math.min(200, ms));
    }
    return true;
  }

  async function waitWhilePaused() {
    while (runState === "paused" && !cancel) await sleep(200);
  }

  // Wait until a reply is finished. Handles auto-continue and limit pausing.
  async function waitForIdle() {
    let stableSince = null;
    const start = Date.now();
    const maxWait = 1000 * 60 * 15; // 15 min hard cap per reply

    while (Date.now() - start < maxWait) {
      if (cancel) return false;

      if (settings.autoContinue) {
        const cont = getContinueButton();
        if (cont) {
          cont.click();
          stableSince = null;
          await sleep(600);
          continue;
        }
      }

      if (settings.autoPauseOnLimit && detectLimit()) {
        runState = "paused";
        setStatus("Usage limit detected — paused.", false);
        renderControls();
        await waitWhilePaused();
        if (cancel) return false;
      }

      if (isGenerating()) {
        stableSince = null;
      } else if (stableSince === null) {
        stableSince = Date.now();
      } else if (Date.now() - stableSince > 1200) {
        return true; // idle for >1.2s → reply done
      }
      await sleep(300);
    }
    return true;
  }

  async function startNewChat() {
    const btn = getNewChatButton();
    if (!btn) return;
    btn.click();
    await sleep(700);
    await waitFor(() => !!getEditor(), { timeout: 5000 });
  }

  // ==========================================================================
  // Runner
  // ==========================================================================
  async function start() {
    if (runState !== "idle") return;
    const prompts = queue.slice();
    if (!prompts.length) return;

    // Resolve {{variables}} up front.
    let values = {};
    const vars = extractVars(prompts);
    if (vars.length) {
      const filled = await askForVars(vars);
      if (!filled) return; // cancelled
      values = filled;
    }

    // Build the flat run list (queue repeated N times, vars substituted).
    const repeat = Math.max(1, settings.repeat | 0);
    const runList = [];
    for (let r = 0; r < repeat; r++) {
      for (let i = 0; i < prompts.length; i++) {
        runList.push({ text: applyVars(prompts[i], values), qIndex: i });
      }
    }

    runState = "running";
    cancel = false;
    sentCount = 0;
    totalCount = runList.length;
    renderControls();
    updateProgress();

    if (isGenerating()) {
      setStatus("Waiting for the current reply…", true);
      await waitForIdle();
    }

    for (let i = 0; i < runList.length; i++) {
      if (cancel) break;
      await waitWhilePaused();
      if (cancel) break;

      currentQueueIndex = runList[i].qIndex;
      renderQueue();

      if (settings.newChatPerPrompt && i > 0) {
        setStatus("Starting a new chat…", true);
        await startNewChat();
        if (cancel) break;
      }

      setStatus(`Sending ${i + 1} of ${runList.length}…`, true);
      if (!setPromptText(runList[i].text)) {
        setStatus("Couldn't find ChatGPT's input box.", false);
        break;
      }
      await sleep(250);
      clickSend();

      await waitFor(() => isGenerating(), { timeout: 8000 });
      const done = await waitForIdle();
      if (cancel) break;

      sentCount++;
      updateProgress();

      if (i < runList.length - 1 && settings.delay > 0) {
        setStatus(`Waiting ${settings.delay}s before next…`, true);
        const ok = await sleepCancelable(settings.delay * 1000);
        if (!ok) break;
      }
    }

    const finished = sentCount >= totalCount && !cancel;
    runState = "idle";
    cancel = false;
    currentQueueIndex = -1;
    setStatus(
      finished ? `Done — sent ${sentCount} prompt(s).` : `Stopped after ${sentCount}.`,
      false
    );
    renderControls();
    renderQueue();
  }

  function pauseOrResume() {
    if (runState === "running") {
      runState = "paused";
      setStatus("Paused — finishes after the current reply.", false);
    } else if (runState === "paused") {
      runState = "running";
      setStatus("Resumed.", true);
    }
    renderControls();
  }

  function stop() {
    cancel = true;
    runState = "idle";
    setStatus("Stopping…", false);
    renderControls();
  }

  // ==========================================================================
  // Persistence
  // ==========================================================================
  function persistQueue() {
    try {
      chrome.storage.local.set({ [KEY_QUEUE]: queue });
    } catch (_) {}
  }
  function persistChains() {
    try {
      chrome.storage.local.set({ [KEY_CHAINS]: chains });
    } catch (_) {}
  }
  function persistSettings() {
    try {
      chrome.storage.local.set({ [KEY_SETTINGS]: settings });
    } catch (_) {}
  }

  function restore() {
    try {
      chrome.storage.local.get(
        [KEY_QUEUE, KEY_CHAINS, KEY_SETTINGS],
        (res) => {
          if (res && Array.isArray(res[KEY_QUEUE])) queue = res[KEY_QUEUE];
          if (res && Array.isArray(res[KEY_CHAINS])) chains = res[KEY_CHAINS];
          if (res && res[KEY_SETTINGS]) Object.assign(settings, res[KEY_SETTINGS]);
          syncSettingsInputs();
          applyTheme();
          renderAll();
        }
      );
    } catch (_) {
      renderAll();
    }
  }

  // ==========================================================================
  // Theme — follow ChatGPT's light/dark, with optional manual override.
  // ==========================================================================
  function detectPageTheme() {
    const html = document.documentElement;
    const cls = " " + (html.className || "") + " ";
    if (cls.includes(" dark ")) return "dark";
    if (cls.includes(" light ")) return "light";

    const scheme = getComputedStyle(html).colorScheme || "";
    if (scheme.includes("dark")) return "dark";
    if (scheme.includes("light")) return "light";

    try {
      const bg = getComputedStyle(document.body).backgroundColor;
      const nums = bg.match(/\d+/g);
      if (nums && nums.length >= 3) {
        const [r, g, b] = nums.map(Number);
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        return lum < 128 ? "dark" : "light";
      }
    } catch (_) {}

    return window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }

  function applyTheme() {
    if (!panel) return;
    const theme =
      settings.themeMode === "auto" ? detectPageTheme() : settings.themeMode;
    panel.classList.toggle("cps-theme-dark", theme === "dark");
    panel.classList.toggle("cps-theme-light", theme === "light");
    const btn = panel.querySelector("#cps-theme");
    if (btn) {
      const label = { auto: "◐", dark: "☾", light: "☀" }[settings.themeMode];
      btn.textContent = label;
      btn.title = `Theme: ${settings.themeMode} (click to change)`;
    }
  }

  function cycleTheme() {
    const order = ["auto", "dark", "light"];
    settings.themeMode = order[(order.indexOf(settings.themeMode) + 1) % 3];
    persistSettings();
    applyTheme();
  }

  function watchPageTheme() {
    const obs = new MutationObserver(() => {
      if (settings.themeMode === "auto") applyTheme();
    });
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    if (window.matchMedia) {
      window
        .matchMedia("(prefers-color-scheme: dark)")
        .addEventListener("change", () => {
          if (settings.themeMode === "auto") applyTheme();
        });
    }
  }

  // ==========================================================================
  // UI construction
  // ==========================================================================
  let panel, listEl, chainListEl, statusEl, progressBar;

  function buildPanel() {
    panel = document.createElement("div");
    panel.id = "cps-panel";
    panel.innerHTML = `
      <div class="cps-header">
        <span class="cps-logo"></span>
        <span class="cps-title">Prompt Stacker</span>
        <div class="cps-header-btns">
          <button class="cps-icon-btn" id="cps-theme" title="Theme">◐</button>
          <button class="cps-icon-btn" id="cps-collapse" title="Collapse">–</button>
        </div>
      </div>

      <div class="cps-tabs">
        <button class="cps-tab cps-tab-active" data-tab="queue">Queue</button>
        <button class="cps-tab" data-tab="library">Library</button>
      </div>

      <div class="cps-body">
        <!-- Queue pane -->
        <div class="cps-pane" data-pane="queue">
          <textarea class="cps-input" id="cps-input"
            placeholder="Type prompts here. Separate each with a blank line or --- on its own line."></textarea>
          <div class="cps-hint">
            Separate prompts with a blank line or <code>---</code>. Use
            <code>{{name}}</code> for fill-in variables.
          </div>
          <div class="cps-row">
            <button class="cps-btn" id="cps-add">Add to queue</button>
          </div>

          <details class="cps-options">
            <summary>Options</summary>
            <div class="cps-options-body">
              <div class="cps-field">
                <span>Delay between prompts (s)</span>
                <input type="number" id="cps-delay" min="0" max="600" step="1" value="0">
              </div>
              <div class="cps-field">
                <span>Repeat whole queue ×</span>
                <input type="number" id="cps-repeat" min="1" max="99" step="1" value="1">
              </div>
              <label class="cps-check">
                <input type="checkbox" id="cps-newchat"> New chat before each prompt
              </label>
              <label class="cps-check">
                <input type="checkbox" id="cps-autocont" checked> Auto-click “Continue generating”
              </label>
              <label class="cps-check">
                <input type="checkbox" id="cps-autolimit"> Auto-pause on usage-limit warning
              </label>
            </div>
          </details>

          <div class="cps-row">
            <button class="cps-btn cps-primary" id="cps-start">Start</button>
            <button class="cps-btn" id="cps-pause">Pause</button>
            <button class="cps-btn cps-danger" id="cps-stop">Stop</button>
          </div>

          <div class="cps-progress"><div class="cps-progress-bar" id="cps-progress"></div></div>
          <div class="cps-status" id="cps-status"></div>

          <ul class="cps-list" id="cps-queue"></ul>

          <div class="cps-footer">
            <button class="cps-btn" id="cps-save">Save as chain</button>
            <button class="cps-btn" id="cps-export">Export</button>
            <button class="cps-btn" id="cps-import">Import</button>
            <button class="cps-btn cps-danger" id="cps-clear">Clear</button>
          </div>
        </div>

        <!-- Library pane -->
        <div class="cps-pane" data-pane="library" hidden>
          <ul class="cps-list" id="cps-chains"></ul>
        </div>

        <a class="cps-star" href="https://github.com/thegreatLUCY/chatgpt-prompt-stacker"
           target="_blank" rel="noopener noreferrer">
          ★ Star on GitHub — a star would be much appreciated ♡
        </a>
      </div>
    `;
    document.body.appendChild(panel);

    listEl = panel.querySelector("#cps-queue");
    chainListEl = panel.querySelector("#cps-chains");
    statusEl = panel.querySelector("#cps-status");
    progressBar = panel.querySelector("#cps-progress");

    wireEvents();
    makeDraggable(panel, panel.querySelector(".cps-header"));
  }

  function wireEvents() {
    const $ = (id) => panel.querySelector(id);
    const input = $("#cps-input");

    $("#cps-add").onclick = () => {
      const parsed = parsePrompts(input.value);
      if (parsed.length) {
        queue.push(...parsed);
        input.value = "";
        persistQueue();
        renderQueue();
      }
    };

    $("#cps-start").onclick = start;
    $("#cps-pause").onclick = pauseOrResume;
    $("#cps-stop").onclick = stop;
    $("#cps-clear").onclick = () => {
      if (runState !== "idle") return;
      queue = [];
      persistQueue();
      renderQueue();
    };

    $("#cps-save").onclick = saveCurrentAsChain;
    $("#cps-export").onclick = exportQueue;
    $("#cps-import").onclick = importQueue;

    $("#cps-collapse").onclick = () => {
      panel.classList.toggle("cps-collapsed");
      $("#cps-collapse").textContent = panel.classList.contains("cps-collapsed")
        ? "+"
        : "–";
    };
    $("#cps-theme").onclick = cycleTheme;

    // Tabs
    panel.querySelectorAll(".cps-tab").forEach((tab) => {
      tab.onclick = () => switchTab(tab.dataset.tab);
    });

    // Settings inputs
    $("#cps-delay").oninput = (e) => {
      settings.delay = Math.max(0, Number(e.target.value) || 0);
      persistSettings();
    };
    $("#cps-repeat").oninput = (e) => {
      settings.repeat = Math.max(1, Number(e.target.value) || 1);
      persistSettings();
    };
    $("#cps-newchat").onchange = (e) => {
      settings.newChatPerPrompt = e.target.checked;
      persistSettings();
    };
    $("#cps-autocont").onchange = (e) => {
      settings.autoContinue = e.target.checked;
      persistSettings();
    };
    $("#cps-autolimit").onchange = (e) => {
      settings.autoPauseOnLimit = e.target.checked;
      persistSettings();
    };
  }

  function syncSettingsInputs() {
    if (!panel) return;
    const $ = (id) => panel.querySelector(id);
    $("#cps-delay").value = settings.delay;
    $("#cps-repeat").value = settings.repeat;
    $("#cps-newchat").checked = settings.newChatPerPrompt;
    $("#cps-autocont").checked = settings.autoContinue;
    $("#cps-autolimit").checked = settings.autoPauseOnLimit;
  }

  function switchTab(name) {
    activeTab = name;
    panel.querySelectorAll(".cps-tab").forEach((t) => {
      t.classList.toggle("cps-tab-active", t.dataset.tab === name);
    });
    panel.querySelectorAll(".cps-pane").forEach((p) => {
      p.hidden = p.dataset.pane !== name;
    });
    if (name === "library") renderChains();
  }

  // ==========================================================================
  // Rendering
  // ==========================================================================
  function setStatus(text, active) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.classList.toggle("cps-active", !!active);
  }

  function updateProgress() {
    if (!progressBar) return;
    const pct = totalCount > 0 ? (sentCount / totalCount) * 100 : 0;
    progressBar.style.width = pct + "%";
  }

  function renderControls() {
    if (!panel) return;
    const running = runState !== "idle";
    panel.querySelector("#cps-start").disabled = running || queue.length === 0;
    panel.querySelector("#cps-pause").disabled = !running;
    panel.querySelector("#cps-pause").textContent =
      runState === "paused" ? "Resume" : "Pause";
    panel.querySelector("#cps-stop").disabled = !running;
    panel.querySelector("#cps-clear").disabled = running;
  }

  let dragIndex = null;

  function renderQueue() {
    if (!listEl) return;
    listEl.innerHTML = "";

    if (queue.length === 0) {
      const li = document.createElement("li");
      li.className = "cps-empty";
      li.textContent = "No prompts queued yet.";
      listEl.appendChild(li);
      renderControls();
      return;
    }

    queue.forEach((text, i) => {
      const li = document.createElement("li");
      li.className = "cps-item" + (i === currentQueueIndex ? " cps-current" : "");
      li.draggable = true;

      const grip = document.createElement("span");
      grip.className = "cps-grip";
      grip.textContent = "⋮⋮";

      const num = document.createElement("span");
      num.className = "cps-item-num";
      num.textContent = i + 1 + ".";

      const span = document.createElement("span");
      span.className = "cps-item-text";
      span.textContent = text;
      span.title = "Double-click to edit";
      span.ondblclick = () => beginInlineEdit(li, span, i);

      const rm = document.createElement("button");
      rm.className = "cps-remove";
      rm.textContent = "×";
      rm.title = "Remove";
      rm.onclick = () => {
        queue.splice(i, 1);
        persistQueue();
        renderQueue();
      };

      // Drag to reorder
      li.addEventListener("dragstart", () => {
        dragIndex = i;
        li.classList.add("cps-dragging");
      });
      li.addEventListener("dragend", () => {
        dragIndex = null;
        li.classList.remove("cps-dragging");
        listEl
          .querySelectorAll(".cps-drop-target")
          .forEach((n) => n.classList.remove("cps-drop-target"));
      });
      li.addEventListener("dragover", (e) => {
        e.preventDefault();
        if (dragIndex !== null && dragIndex !== i)
          li.classList.add("cps-drop-target");
      });
      li.addEventListener("dragleave", () =>
        li.classList.remove("cps-drop-target")
      );
      li.addEventListener("drop", (e) => {
        e.preventDefault();
        if (dragIndex === null || dragIndex === i) return;
        const [moved] = queue.splice(dragIndex, 1);
        queue.splice(i, 0, moved);
        persistQueue();
        renderQueue();
      });

      li.append(grip, num, span, rm);
      listEl.appendChild(li);
    });

    renderControls();
  }

  function beginInlineEdit(li, span, i) {
    const ta = document.createElement("textarea");
    ta.className = "cps-edit";
    ta.value = queue[i];
    li.replaceChild(ta, span);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);

    const save = () => {
      const v = ta.value.trim();
      if (v) queue[i] = v;
      else queue.splice(i, 1);
      persistQueue();
      renderQueue();
    };
    ta.addEventListener("blur", save);
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        ta.blur();
      } else if (e.key === "Escape") {
        ta.removeEventListener("blur", save);
        renderQueue();
      }
    });
  }

  function renderChains() {
    if (!chainListEl) return;
    chainListEl.innerHTML = "";

    if (chains.length === 0) {
      const li = document.createElement("li");
      li.className = "cps-empty";
      li.textContent = "No saved chains. Build a queue, then “Save as chain”.";
      chainListEl.appendChild(li);
      return;
    }

    chains.forEach((chain, i) => {
      const li = document.createElement("li");
      li.className = "cps-chain";

      const info = document.createElement("div");
      info.className = "cps-chain-info";
      const name = document.createElement("div");
      name.className = "cps-chain-name";
      name.textContent = chain.name;
      const meta = document.createElement("div");
      meta.className = "cps-chain-meta";
      meta.textContent = `${chain.prompts.length} prompt(s)`;
      info.append(name, meta);

      const load = document.createElement("button");
      load.className = "cps-btn cps-btn-sm";
      load.textContent = "Load";
      load.title = "Replace the queue with this chain";
      load.onclick = () => {
        queue = chain.prompts.slice();
        persistQueue();
        switchTab("queue");
        renderQueue();
        setStatus(`Loaded “${chain.name}”.`, false);
      };

      const append = document.createElement("button");
      append.className = "cps-btn cps-btn-sm";
      append.textContent = "Append";
      append.title = "Add this chain to the end of the queue";
      append.onclick = () => {
        queue.push(...chain.prompts);
        persistQueue();
        switchTab("queue");
        renderQueue();
      };

      const del = document.createElement("button");
      del.className = "cps-remove";
      del.textContent = "×";
      del.title = "Delete chain";
      del.onclick = () => {
        chains.splice(i, 1);
        persistChains();
        renderChains();
      };

      li.append(info, load, append, del);
      chainListEl.appendChild(li);
    });
  }

  function renderAll() {
    renderQueue();
    renderChains();
    renderControls();
    updateProgress();
  }

  // ==========================================================================
  // Chains / import / export
  // ==========================================================================
  async function saveCurrentAsChain() {
    if (queue.length === 0) {
      setStatus("Queue is empty — nothing to save.", false);
      return;
    }
    const name = await askText("Save chain", "Chain name", "My chain");
    if (!name) return;
    chains.push({ id: Date.now(), name, prompts: queue.slice() });
    persistChains();
    setStatus(`Saved “${name}” to Library.`, false);
  }

  function exportQueue() {
    if (queue.length === 0) return;
    const blob = new Blob([serializeQueue(queue)], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "prompt-stack.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  function importQueue() {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = ".txt,text/plain";
    inp.onchange = () => {
      const file = inp.files && inp.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const parsed = parsePrompts(String(reader.result));
        if (parsed.length) {
          queue.push(...parsed);
          persistQueue();
          renderQueue();
          setStatus(`Imported ${parsed.length} prompt(s).`, false);
        }
      };
      reader.readAsText(file);
    };
    inp.click();
  }

  // ==========================================================================
  // Modal overlays (variables + text input)
  // ==========================================================================
  function showOverlay(buildInner) {
    const body = panel.querySelector(".cps-body");
    const overlay = document.createElement("div");
    overlay.className = "cps-overlay";
    const modal = document.createElement("div");
    modal.className = "cps-modal";
    overlay.appendChild(modal);
    body.appendChild(overlay);

    return new Promise((resolve) => {
      const close = (result) => {
        overlay.remove();
        resolve(result);
      };
      buildInner(modal, close);
      overlay.addEventListener("mousedown", (e) => {
        if (e.target === overlay) close(null);
      });
    });
  }

  function askForVars(vars) {
    return showOverlay((modal, close) => {
      const title = document.createElement("div");
      title.className = "cps-modal-title";
      title.textContent = "Fill in variables";
      modal.appendChild(title);

      const inputs = {};
      vars.forEach((name) => {
        const field = document.createElement("div");
        field.className = "cps-modal-field";
        const label = document.createElement("label");
        label.textContent = name;
        const inp = document.createElement("input");
        inp.type = "text";
        inp.placeholder = name;
        inputs[name] = inp;
        field.append(label, inp);
        modal.appendChild(field);
      });

      const row = document.createElement("div");
      row.className = "cps-row";
      const ok = document.createElement("button");
      ok.className = "cps-btn cps-primary";
      ok.textContent = "Run";
      ok.onclick = () => {
        const values = {};
        vars.forEach((n) => (values[n] = inputs[n].value));
        close(values);
      };
      const cancelBtn = document.createElement("button");
      cancelBtn.className = "cps-btn";
      cancelBtn.textContent = "Cancel";
      cancelBtn.onclick = () => close(null);
      row.append(ok, cancelBtn);
      modal.appendChild(row);

      vars[0] && inputs[vars[0]].focus();
    });
  }

  function askText(title, label, placeholder) {
    return showOverlay((modal, close) => {
      const t = document.createElement("div");
      t.className = "cps-modal-title";
      t.textContent = title;
      modal.appendChild(t);

      const field = document.createElement("div");
      field.className = "cps-modal-field";
      const lab = document.createElement("label");
      lab.textContent = label;
      const inp = document.createElement("input");
      inp.type = "text";
      inp.placeholder = placeholder || "";
      field.append(lab, inp);
      modal.appendChild(field);

      const row = document.createElement("div");
      row.className = "cps-row";
      const ok = document.createElement("button");
      ok.className = "cps-btn cps-primary";
      ok.textContent = "Save";
      ok.onclick = () => close(inp.value.trim() || null);
      const cancelBtn = document.createElement("button");
      cancelBtn.className = "cps-btn";
      cancelBtn.textContent = "Cancel";
      cancelBtn.onclick = () => close(null);
      row.append(ok, cancelBtn);
      modal.appendChild(row);

      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") close(inp.value.trim() || null);
      });
      inp.focus();
    });
  }

  // ==========================================================================
  // Dragging the whole panel
  // ==========================================================================
  function makeDraggable(el, handle) {
    let sx, sy, ox, oy, dragging = false;
    handle.addEventListener("mousedown", (e) => {
      if (e.target.classList.contains("cps-icon-btn")) return;
      dragging = true;
      sx = e.clientX;
      sy = e.clientY;
      const r = el.getBoundingClientRect();
      ox = r.left;
      oy = r.top;
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      el.style.left = ox + (e.clientX - sx) + "px";
      el.style.top = oy + (e.clientY - sy) + "px";
      el.style.right = "auto";
    });
    document.addEventListener("mouseup", () => (dragging = false));
  }

  // ==========================================================================
  // Init
  // ==========================================================================
  function init() {
    if (document.getElementById("cps-panel")) return;
    buildPanel();
    applyTheme();
    watchPageTheme();
    restore();
  }

  if (document.body) init();
  else window.addEventListener("DOMContentLoaded", init);
})();
