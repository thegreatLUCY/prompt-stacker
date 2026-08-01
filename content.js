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

  // Split raw textarea input into individual prompts. A line containing only
  // `---` always separates prompts. When `splitOnBlank` is true (the default),
  // a blank line also separates them; turn it off so a single prompt can span
  // several paragraphs.
  function parsePrompts(text, splitOnBlank = true) {
    // The `---` variant is matched first so it consumes any surrounding blank
    // lines instead of leaving "---" as its own prompt.
    const re = splitOnBlank
      ? /\n(?:[ \t]*\n)?[ \t]*---[ \t]*\n(?:[ \t]*\n)?|\n[ \t]*\n/
      : /\n(?:[ \t]*\n)*[ \t]*---[ \t]*\n(?:[ \t]*\n)*/;
    return String(text)
      .split(re)
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
  let completedCount = 0;
  let skippedCount = 0;
  let totalCount = 0;
  let currentQueueIndex = -1; // which visible queue row is sending
  let activeTab = "queue";
  let lastReply = ""; // most recent answer, for {{last_reply}}
  let replySnapshot = ""; // for text-stability "busy" detection (no-stop sites)
  let replyChangedAt = 0;
  let awaitingRecovery = false;
  let resolveRecovery = null;
  let onboardingDismissed = false;
  let undoAction = null;
  let undoTimer = null;

  // Dynamic variables filled from ChatGPT at run time rather than by the user.
  const RESERVED_VARS = ["last_reply", "last_response", "previous"];

  const settings = {
    delay: 0, // seconds between prompts
    repeat: 1, // run the whole queue N times
    newChatPerPrompt: false,
    autoContinue: true,
    autoPauseOnLimit: false,
    splitOnBlank: true, // treat a blank line as a prompt separator
    themeMode: "auto", // "auto" | "dark" | "light"
  };

  const KEY_QUEUE = "cps_queue";
  const KEY_CHAINS = "cps_chains";
  const KEY_SETTINGS = "cps_settings";
  const KEY_ONBOARDING = "cps_onboarding_dismissed";
  const EXAMPLE_PROMPTS = [
    "Research {{topic}} and explain the five most important points.",
    "Turn the previous answer into a clear step-by-step outline.",
    "Write a concise final response using that outline.",
  ];

  // ==========================================================================
  // Site adapters — per-platform selectors. The queue/runner logic is
  // platform-agnostic; only these DOM touchpoints differ. Selectors are
  // ordered best-first and fall back to shared generics, so a small UI change
  // on any site (or an unknown send button) degrades gracefully. To support a
  // new site or fix a drifted selector, edit only this block.
  // ==========================================================================
  const GENERIC = {
    editor: ['div[contenteditable="true"]', "textarea"],
    send: ['button[aria-label*="Send" i]', 'button[data-testid*="send" i]'],
    stop: ['button[aria-label*="Stop" i]', 'button[data-testid*="stop" i]'],
    newChat: ['a[aria-label*="New chat" i]', 'button[aria-label*="New chat" i]'],
  };

  const ADAPTERS = {
    chatgpt: {
      name: "ChatGPT",
      host: /(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/,
      editor: ["#prompt-textarea", 'div[contenteditable="true"]'],
      send: ['button[data-testid="send-button"]'],
      stop: ['button[data-testid="stop-button"]'],
      newChat: ['[data-testid="create-new-chat-button"]'],
      assistant: ['[data-message-author-role="assistant"] .markdown',
        '[data-message-author-role="assistant"]'],
      // Whole assistant turn — scanned for a still-rendering image, since
      // image generation drops the stop button before the picture finishes.
      turn: ['[data-message-author-role="assistant"]'],
      continueText: ["continue generating"],
    },
    claude: {
      name: "Claude",
      // Verified live on claude.ai (2026-07): editor [data-testid="chat-input"]
      // (tiptap ProseMirror), send "Send message", stop "Stop response",
      // assistant content .standard-markdown.
      host: /(^|\.)claude\.ai$/,
      editor: ['[data-testid="chat-input"]', 'div.ProseMirror[contenteditable="true"]',
        '[contenteditable="true"]'],
      send: ['button[aria-label="Send message" i]', 'button[aria-label*="Send" i]'],
      stop: ['button[aria-label="Stop response" i]', 'button[aria-label*="Stop" i]'],
      newChat: ['a[href="/new"]'],
      assistant: [".standard-markdown", "div.font-claude-message",
        '[data-testid="message-content"]'],
      continueText: [],
    },
    gemini: {
      name: "Gemini",
      // Verified live on gemini.google.com (2026-07): Quill editor div.ql-editor
      // (aria "Enter a prompt for Gemini"), send "Send message", stop
      // "Stop response", responses in <message-content>.
      host: /(^|\.)gemini\.google\.com$/,
      editor: ['div.ql-editor[contenteditable="true"]',
        '.ql-editor[aria-label*="Gemini" i]', "rich-textarea .ql-editor"],
      send: ['button[aria-label="Send message" i]', 'button[aria-label*="Send" i]'],
      stop: ['button[aria-label="Stop response" i]', 'button[aria-label*="Stop" i]'],
      newChat: ['[data-test-id="new-chat-button"]', 'button[aria-label*="New chat" i]'],
      assistant: ["message-content .markdown", "message-content", ".model-response-text"],
      continueText: [],
    },
    deepseek: {
      name: "DeepSeek",
      // NOTE: best-effort — not yet verified against a live chat.deepseek.com
      // session. Editor is a textarea, so the Enter-key send fallback should
      // work; noStopButton enables text-stability completion detection in case
      // the stop-button selector is wrong. Refine from a probe when possible.
      host: /(^|\.)deepseek\.com$/,
      noStopButton: true,
      editor: ["textarea#chat-input", "textarea", '[contenteditable="true"]'],
      send: ['div[role="button"][aria-disabled]', 'button[aria-label*="Send" i]'],
      stop: ['button[aria-label*="Stop" i]', 'div[role="button"][aria-label*="Stop" i]'],
      newChat: [],
      assistant: [".ds-markdown", '[class*="markdown"]', "[class*=message]"],
      continueText: [],
    },
  };

  function detectSite() {
    const h = location.hostname;
    for (const key in ADAPTERS) if (ADAPTERS[key].host.test(h)) return ADAPTERS[key];
    return ADAPTERS.chatgpt; // sensible default
  }

  const SITE = detectSite();

  // Per-platform brand accent — the panel tints its primary action, progress,
  // focus rings and active tab to the detected model, and shows a matching
  // "detected" dot. `dot` overrides the solid accent for a gradient bullet.
  const BRANDS = {
    ChatGPT: { accent: "#19c37d" },
    Claude: { accent: "#d97757" },
    Gemini: { accent: "#4b8bf5", dot: "linear-gradient(135deg,#4b8bf5,#9168f0)" },
    DeepSeek: { accent: "#4d6bfe" },
  };
  const BRAND = BRANDS[SITE.name] || { accent: "#19c37d" };

  // Return the first match for any selector in the list, skipping anything
  // inside our own panel (so the generic `textarea`/`button` fallbacks never
  // grab the Stacker's own controls).
  function firstMatch(list) {
    for (const sel of list) {
      for (const el of document.querySelectorAll(sel)) {
        if (!el.closest("#cps-panel")) return el;
      }
    }
    return null;
  }

  function getEditor() {
    return firstMatch([...(SITE.editor || []), ...GENERIC.editor]);
  }

  function getSendButton() {
    return firstMatch([...(SITE.send || []), ...GENERIC.send]);
  }

  // Present only while the model is generating a reply.
  function getStopButton() {
    return firstMatch([...(SITE.stop || []), ...GENERIC.stop]);
  }

  function isGenerating() {
    return !!getStopButton();
  }

  // Update the streaming-text snapshot; returns the current reply text.
  function noteReply() {
    const t = getLastReplyText();
    if (t !== replySnapshot) {
      replySnapshot = t;
      replyChangedAt = Date.now();
    }
    return t;
  }

  // "Is the model still working?" — a stop button (most sites) OR, for sites
  // without a reliable stop control, the reply text still growing.
  // Still rendering an image/media in the latest reply? Image generation on
  // ChatGPT removes the stop button while the picture is still being drawn, so
  // without this the next prompt would fire early and cancel the image. We look
  // at the most recent assistant turn for an unfinished <img> or an element
  // flagged aria-busy — both selector-independent, so this survives UI churn.
  function mediaBusy() {
    const scopes = SITE.turn || SITE.assistant || [];
    let turn = null;
    for (const sel of scopes) {
      const nodes = [...document.querySelectorAll(sel)].filter(
        (n) => !n.closest("#cps-panel")
      );
      if (nodes.length) {
        turn = nodes[nodes.length - 1];
        break;
      }
    }
    if (!turn) return false;
    if (turn.querySelector('[aria-busy="true"]')) return true;
    for (const img of turn.querySelectorAll("img")) {
      // Skip tiny inline icons/avatars; only real generated pictures matter.
      const big =
        img.width > 64 || img.height > 64 || img.naturalWidth > 64 || !img.width;
      if (big && (!img.complete || img.naturalWidth === 0)) return true;
    }
    return false;
  }

  function isBusy() {
    if (isGenerating()) return true;
    if (mediaBusy()) return true;
    if (SITE.noStopButton) {
      noteReply();
      return replySnapshot.length > 0 && Date.now() - replyChangedAt < 1400;
    }
    return false;
  }

  // Read the text of the most recent assistant reply (for {{last_reply}}).
  function getLastReplyText() {
    for (const sel of SITE.assistant || []) {
      const nodes = [...document.querySelectorAll(sel)].filter(
        (n) => !n.closest("#cps-panel")
      );
      if (nodes.length) return (nodes[nodes.length - 1].innerText || "").trim();
    }
    return "";
  }

  function getContinueButton() {
    const texts = SITE.continueText || [];
    if (!texts.length) return null;
    for (const b of document.querySelectorAll("button")) {
      const t = (b.textContent || "").trim().toLowerCase();
      if (texts.some((x) => t.includes(x))) return b;
    }
    return null;
  }

  function getNewChatButton() {
    return firstMatch([...(SITE.newChat || []), ...GENERIC.newChat]);
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

  // Insert text into the editor. execCommand("insertText") is the reliable path
  // for rich contenteditable editors (ProseMirror on ChatGPT/Claude, Quill on
  // Gemini); plain assignment is ignored by their internal state.
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

  function getEditorText() {
    const editor = getEditor();
    if (!editor) return "";
    return String(
      editor.tagName === "TEXTAREA"
        ? editor.value
        : editor.innerText || editor.textContent || ""
    ).trim();
  }

  function clickSend() {
    const btn = getSendButton();
    if (btn && !btn.disabled && btn.getAttribute("aria-disabled") !== "true") {
      btn.click();
      return true;
    }
    // Fallback: press Enter in the editor (covers sites with unknown send
    // buttons, e.g. plain textarea composers).
    const editor = getEditor();
    if (editor) {
      for (const type of ["keydown", "keypress", "keyup"]) {
        editor.dispatchEvent(
          new KeyboardEvent(type, {
            key: "Enter",
            code: "Enter",
            keyCode: 13,
            which: 13,
            bubbles: true,
          })
        );
      }
      return true;
    }
    return false;
  }

  // Sending is only considered accepted when the composer clears, generation
  // begins, or a new assistant response appears. A failed click is retried once
  // while the prompt is still visibly present, avoiding duplicate submissions.
  async function sendAndWaitForReply(text) {
    const previousReply = getLastReplyText();
    if (!setPromptText(text)) {
      return { ok: false, reason: "Couldn't find the input box on this page." };
    }

    const inserted = await waitFor(() => getEditorText().length > 0, {
      timeout: 2000,
      interval: 100,
    });
    if (!inserted) {
      return { ok: false, reason: "The site rejected the prompt text." };
    }

    replySnapshot = previousReply;
    replyChangedAt = 0;

    let responseSeen = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (cancel) return { ok: false, cancelled: true };
      if (attempt === 2) setStatus("Send wasn't confirmed — retrying once…", true);

      await sleep(250);
      const clicked = clickSend();
      if (!clicked) continue;

      const accepted = await waitFor(() => {
        const replyChanged = getLastReplyText() !== previousReply;
        const busy = isBusy();
        responseSeen = responseSeen || replyChanged || busy;
        return responseSeen || getEditorText().length === 0;
      }, { timeout: 8000, interval: 200 });

      if (accepted) break;
      // If the prompt disappeared, it may already have been accepted; never
      // click again in that case because doing so could submit it twice.
      if (getEditorText().length === 0) break;
    }

    if (cancel) return { ok: false, cancelled: true };

    if (!responseSeen) {
      responseSeen = await waitFor(() => {
        return isBusy() || getLastReplyText() !== previousReply;
      }, { timeout: 30000, interval: 250 });
    }
    if (!responseSeen) {
      return {
        ok: false,
        reason: "The prompt was not confirmed and no AI response started.",
      };
    }

    const finished = await waitForIdle();
    if (!finished) {
      return cancel
        ? { ok: false, cancelled: true }
        : { ok: false, reason: "The AI response did not finish within 15 minutes." };
    }
    return { ok: true, reply: getLastReplyText() };
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

      if (isBusy()) {
        stableSince = null;
      } else if (stableSince === null) {
        stableSince = Date.now();
      } else if (Date.now() - stableSince > 1200) {
        return true; // idle for >1.2s → reply done
      }
      await sleep(300);
    }
    return false;
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

    // Resolve user {{variables}} up front. Reserved dynamic vars (like
    // {{last_reply}}) are excluded — they're filled from ChatGPT at send time.
    let values = {};
    const vars = extractVars(prompts).filter(
      (v) => !RESERVED_VARS.includes(v.toLowerCase())
    );
    if (vars.length) {
      const filled = await askForVars(vars);
      if (!filled) return; // cancelled
      values = filled;
    }

    lastReply = "";

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
    completedCount = 0;
    skippedCount = 0;
    totalCount = runList.length;
    hideRecovery();
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

      // Substitute dynamic vars ({{last_reply}} etc.) with the latest answer.
      const dyn = {};
      RESERVED_VARS.forEach((n) => (dyn[n] = lastReply));
      const outgoing = applyVars(runList[i].text, dyn);

      let stepComplete = false;
      while (!stepComplete && !cancel) {
        runState = "running";
        setStatus(`Sending ${i + 1} of ${runList.length}…`, true);
        renderControls();

        const result = await sendAndWaitForReply(outgoing);
        if (result.cancelled || cancel) break;

        if (result.ok) {
          lastReply = result.reply;
          sentCount++;
          completedCount++;
          stepComplete = true;
          updateProgress();
          continue;
        }

        const action = await requestRecovery(
          `${result.reason} Prompt ${i + 1} was not marked as sent.`
        );
        if (action === "retry") continue;
        if (action === "skip") {
          runState = "running";
          skippedCount++;
          completedCount++;
          stepComplete = true;
          updateProgress();
          setStatus(`Skipped prompt ${i + 1}.`, false);
        } else {
          cancel = true;
        }
      }
      if (cancel) break;

      if (i < runList.length - 1 && settings.delay > 0) {
        setStatus(`Waiting ${settings.delay}s before next…`, true);
        const ok = await sleepCancelable(settings.delay * 1000);
        if (!ok) break;
      }
    }

    const finished = completedCount >= totalCount && !cancel;
    runState = "idle";
    cancel = false;
    hideRecovery();
    currentQueueIndex = -1;
    const doneText = skippedCount
      ? `Done — sent ${sentCount}, skipped ${skippedCount}.`
      : `Done — sent ${sentCount} prompt(s).`;
    setStatus(finished ? doneText : `Stopped after ${sentCount} sent.`, false);
    renderControls();
    renderQueue();
  }

  function pauseOrResume() {
    if (awaitingRecovery) return;
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
    if (resolveRecovery) resolveRecovery("stop");
    setStatus("Stopping…", false);
    renderControls();
  }

  // ==========================================================================
  // Persistence
  // The working queue lives in local storage; chains and settings go to sync
  // storage so they roam across signed-in Chrome browsers (falling back to
  // local if sync is unavailable or over quota).
  // ==========================================================================
  function syncArea() {
    return (chrome.storage && chrome.storage.sync) || chrome.storage.local;
  }

  function persistQueue() {
    try {
      chrome.storage.local.set({ [KEY_QUEUE]: queue });
    } catch (_) {}
  }
  function persistChains() {
    try {
      syncArea().set({ [KEY_CHAINS]: chains }, () => {
        if (chrome.runtime && chrome.runtime.lastError) {
          chrome.storage.local.set({ [KEY_CHAINS]: chains }); // quota fallback
        }
      });
    } catch (_) {}
  }
  function persistSettings() {
    try {
      syncArea().set({ [KEY_SETTINGS]: settings }, () => {
        if (chrome.runtime && chrome.runtime.lastError) {
          chrome.storage.local.set({ [KEY_SETTINGS]: settings });
        }
      });
    } catch (_) {}
  }

  function restore() {
    const done = () => {
      if ((queue.length || chains.length) && !onboardingDismissed) {
        onboardingDismissed = true;
        try {
          chrome.storage.local.set({ [KEY_ONBOARDING]: true });
        } catch (_) {}
      }
      syncSettingsInputs();
      applyTheme();
      renderAll();
      requestAnimationFrame(() => constrainPanel());
    };
    try {
      chrome.storage.local.get(
        [KEY_QUEUE, KEY_CHAINS, KEY_SETTINGS, KEY_ONBOARDING],
        (loc) => {
          if (loc && Array.isArray(loc[KEY_QUEUE])) queue = loc[KEY_QUEUE];
          if (loc && Array.isArray(loc[KEY_CHAINS])) chains = loc[KEY_CHAINS];
          if (loc && loc[KEY_SETTINGS]) Object.assign(settings, loc[KEY_SETTINGS]);
          onboardingDismissed = !!(loc && loc[KEY_ONBOARDING]);
          // Sync copy wins for chains/settings when present.
          syncArea().get([KEY_CHAINS, KEY_SETTINGS], (syn) => {
            if (syn && Array.isArray(syn[KEY_CHAINS])) chains = syn[KEY_CHAINS];
            if (syn && syn[KEY_SETTINGS]) Object.assign(settings, syn[KEY_SETTINGS]);
            done();
          });
        }
      );
    } catch (_) {
      done();
    }
  }

  // Full backup / restore as a single JSON file.
  function backupAll() {
    const data = { app: "chatgpt-prompt-stacker", version: 1, queue, chains, settings };
    downloadFile(
      "prompt-stacker-backup.json",
      JSON.stringify(data, null, 2),
      "application/json"
    );
    setStatus("Backed up queue, chains, and settings.", false);
  }

  function restoreAll() {
    pickFile(".json,application/json", (text) => {
      let data;
      try {
        data = JSON.parse(text);
      } catch (_) {
        setStatus("That file isn't valid backup JSON.", false);
        return;
      }
      if (Array.isArray(data.queue)) queue = data.queue;
      if (Array.isArray(data.chains)) chains = data.chains;
      if (data.settings) Object.assign(settings, data.settings);
      if (queue.length || chains.length) dismissOnboarding();
      persistQueue();
      persistChains();
      persistSettings();
      syncSettingsInputs();
      applyTheme();
      renderAll();
      setStatus("Restored from backup.", false);
    });
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

  // Tint the panel to the detected platform and fill in the "detected" chip.
  function applyBrand() {
    if (!panel) return;
    panel.style.setProperty("--cps-accent", BRAND.accent);
    const dot = panel.querySelector("#cps-dot");
    const name = panel.querySelector("#cps-detect-name");
    if (dot) dot.style.background = BRAND.dot || BRAND.accent;
    if (name) name.textContent = SITE.name;
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

  function extUrl(path) {
    try {
      if (chrome.runtime && chrome.runtime.getURL) return chrome.runtime.getURL(path);
    } catch (_) {}
    return path;
  }

  function buildPanel() {
    const logoUrl = extUrl("icon48.png");
    panel = document.createElement("div");
    panel.id = "cps-panel";
    panel.classList.add("cps-collapsed");
    panel.innerHTML = `
      <div class="cps-header" title="Click to expand">
        <img class="cps-logo" src="${logoUrl}" alt="" draggable="false" />
        <div class="cps-titles">
          <span class="cps-title">Prompt Stacker</span>
          <span class="cps-detect" id="cps-detect">
            <span class="cps-dot" id="cps-dot"></span>
            <span id="cps-detect-name">Detecting…</span>
          </span>
        </div>
        <span class="cps-count" id="cps-count" hidden></span>
        <span class="cps-expand-hint">Click to expand</span>
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
          <div class="cps-onboarding" id="cps-onboarding" hidden>
            <div class="cps-onboarding-title">Build your first stack</div>
            <div class="cps-onboarding-copy">
              Separate prompts with a blank line. Each one sends after the AI
              finishes the previous reply.
            </div>
            <div class="cps-row">
              <button class="cps-btn cps-primary" id="cps-example">Try an example</button>
              <button class="cps-btn" id="cps-onboarding-close">Got it</button>
            </div>
          </div>
          <textarea class="cps-input" id="cps-input"
            placeholder="Type your prompts here…"></textarea>
          <div class="cps-inserts">
            <button type="button" class="cps-chip" id="cps-ins-var"
              title="Insert a fill-in placeholder you'll be asked for once when you press Start">
              + Fill-in blank</button>
            <button type="button" class="cps-chip" id="cps-ins-last"
              title="Insert the AI's previous answer into this prompt">
              + Previous answer</button>
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
                <input type="checkbox" id="cps-splitblank" checked> Treat a blank line as a new prompt
              </label>
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
          <div class="cps-status" id="cps-status" role="status" aria-live="polite"></div>
          <div class="cps-recovery" id="cps-recovery" hidden>
            <button class="cps-btn cps-primary" id="cps-retry">Retry step</button>
            <button class="cps-btn" id="cps-skip">Skip step</button>
          </div>

          <div class="cps-toast" id="cps-toast" role="status" aria-live="polite" hidden>
            <span id="cps-toast-message"></span>
            <button type="button" id="cps-undo">Undo</button>
          </div>

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
          <div class="cps-footer">
            <button class="cps-btn" id="cps-backup">Back up all</button>
            <button class="cps-btn" id="cps-restore">Restore</button>
          </div>
          <div class="cps-hint">
            Backs up your queue, chains, and settings to one JSON file. Chains
            and settings also sync across your signed-in Chrome browsers.
          </div>
        </div>

        <div class="cps-privacy">
          <svg class="cps-lock" viewBox="0 0 24 24" width="11" height="11" fill="none"
               stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="5" y="11" width="14" height="10" rx="2"></rect>
            <path d="M8 11V7a4 4 0 0 1 8 0v4"></path>
          </svg>
          Everything stays on your device. Your prompts are never sent to us or anyone else.
        </div>

        <a class="cps-star" href="https://github.com/thegreatLUCY/prompt-stacker"
           target="_blank" rel="noopener noreferrer">
          <span class="cps-star-icon">★</span> Open source · Star on GitHub
          <span class="cps-star-arrow">↗</span>
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

  // Insert `token` at the textarea caret. `select` = [start,end] offsets within
  // the token to highlight afterwards (e.g. the word "topic" so it can be typed
  // over); otherwise the caret lands right after the token.
  function insertToken(textarea, token, select) {
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? textarea.value.length;
    const v = textarea.value;
    textarea.value = v.slice(0, start) + token + v.slice(end);
    if (select) {
      textarea.setSelectionRange(start + select[0], start + select[1]);
    } else {
      const pos = start + token.length;
      textarea.setSelectionRange(pos, pos);
    }
    textarea.focus();
  }

  function addToQueue() {
    const input = panel.querySelector("#cps-input");
    const parsed = parsePrompts(input.value, settings.splitOnBlank);
    if (parsed.length) {
      queue.push(...parsed);
      input.value = "";
      dismissOnboarding();
      persistQueue();
      renderQueue();
    }
  }

  function wireEvents() {
    const $ = (id) => panel.querySelector(id);
    const input = $("#cps-input");

    panel.querySelector(".cps-title").title = "Active on " + SITE.name;

    $("#cps-add").onclick = addToQueue;
    $("#cps-example").onclick = () => {
      input.value = EXAMPLE_PROMPTS.join("\n\n");
      dismissOnboarding();
      input.focus();
      setStatus("Example loaded — edit it or add it to your queue.", false);
    };
    $("#cps-onboarding-close").onclick = dismissOnboarding;
    // ⌘/Ctrl+Enter in the box adds to the queue.
    input.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        addToQueue();
      }
    });

    // Insert helpers — write the token at the cursor so non-technical users
    // don't have to remember the {{…}} syntax.
    $("#cps-ins-var").onclick = () => insertToken(input, "{{topic}}", [2, 7]);
    $("#cps-ins-last").onclick = () => insertToken(input, "{{last_reply}}");

    $("#cps-start").onclick = start;
    $("#cps-pause").onclick = pauseOrResume;
    $("#cps-stop").onclick = stop;
    $("#cps-retry").onclick = () => {
      if (resolveRecovery) resolveRecovery("retry");
    };
    $("#cps-skip").onclick = () => {
      if (resolveRecovery) resolveRecovery("skip");
    };
    $("#cps-clear").onclick = () => {
      if (runState !== "idle") return;
      const cleared = queue.slice();
      if (!cleared.length) return;
      queue = [];
      persistQueue();
      renderQueue();
      offerUndo(
        `Cleared ${cleared.length} prompt${cleared.length === 1 ? "" : "s"}.`,
        () => {
          queue = [...cleared, ...queue];
          persistQueue();
          renderQueue();
          setStatus("Queue restored.", false);
        }
      );
    };
    $("#cps-undo").onclick = runUndo;

    $("#cps-save").onclick = saveCurrentAsChain;
    $("#cps-export").onclick = exportQueue;
    $("#cps-import").onclick = importQueue;
    $("#cps-backup").onclick = backupAll;
    $("#cps-restore").onclick = restoreAll;

    $("#cps-collapse").onclick = toggleCollapse;
    $("#cps-theme").onclick = cycleTheme;
    panel.querySelector(".cps-options").addEventListener("toggle", () => {
      requestAnimationFrame(() => constrainPanel());
    });

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
    $("#cps-splitblank").onchange = (e) => {
      settings.splitOnBlank = e.target.checked;
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
    $("#cps-splitblank").checked = settings.splitOnBlank;
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
    requestAnimationFrame(() => constrainPanel());
  }

  function toggleCollapse() {
    panel.classList.toggle("cps-collapsed");
    const collapsed = panel.classList.contains("cps-collapsed");
    panel.querySelector("#cps-collapse").textContent = collapsed ? "+" : "–";
    panel.querySelector(".cps-header").title = collapsed
      ? "Click to expand"
      : "Drag to move · click to collapse";
    updateCount();
    requestAnimationFrame(() => constrainPanel());
  }

  // Small badge on the header/pill showing how many prompts are queued.
  function updateCount() {
    const el = panel && panel.querySelector("#cps-count");
    if (!el) return;
    const n = queue.length;
    el.textContent = n;
    el.hidden = n === 0;
  }

  // ==========================================================================
  // Rendering
  // ==========================================================================
  function setStatus(text, active) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.classList.toggle("cps-active", !!active);
  }

  function hideUndo() {
    if (undoTimer) clearTimeout(undoTimer);
    undoTimer = null;
    undoAction = null;
    const toast = panel && panel.querySelector("#cps-toast");
    if (toast) toast.hidden = true;
    requestAnimationFrame(() => constrainPanel());
  }

  function offerUndo(message, action) {
    if (undoTimer) clearTimeout(undoTimer);
    undoAction = action;
    const toast = panel.querySelector("#cps-toast");
    panel.querySelector("#cps-toast-message").textContent = message;
    toast.hidden = false;
    undoTimer = setTimeout(hideUndo, 7000);
    requestAnimationFrame(() => constrainPanel());
  }

  function runUndo() {
    const action = undoAction;
    hideUndo();
    if (action) action();
  }

  function updateProgress() {
    if (!progressBar) return;
    const pct = totalCount > 0 ? (completedCount / totalCount) * 100 : 0;
    progressBar.style.width = pct + "%";
  }

  function hideRecovery() {
    awaitingRecovery = false;
    resolveRecovery = null;
    const recovery = panel && panel.querySelector("#cps-recovery");
    if (recovery) recovery.hidden = true;
  }

  function requestRecovery(message) {
    awaitingRecovery = true;
    runState = "paused";
    if (panel.classList.contains("cps-collapsed")) toggleCollapse();
    setStatus(message, false);
    panel.querySelector("#cps-recovery").hidden = false;
    renderControls();
    requestAnimationFrame(() => constrainPanel());

    return new Promise((resolve) => {
      resolveRecovery = (action) => {
        hideRecovery();
        resolve(action);
      };
    });
  }

  function renderControls() {
    if (!panel) return;
    const running = runState !== "idle";
    panel.querySelector("#cps-start").disabled = running || queue.length === 0;
    panel.querySelector("#cps-pause").disabled = !running || awaitingRecovery || cancel;
    panel.querySelector("#cps-pause").textContent =
      runState === "paused" ? "Resume" : "Pause";
    panel.querySelector("#cps-stop").disabled = !running || cancel;
    panel.querySelector("#cps-clear").disabled = running || queue.length === 0;
  }

  let dragIndex = null;

  function renderQueue() {
    if (!listEl) return;
    listEl.innerHTML = "";
    updateCount();

    if (queue.length === 0) {
      const li = document.createElement("li");
      li.className = "cps-empty";
      li.textContent = "No prompts queued yet.";
      listEl.appendChild(li);
      renderControls();
      requestAnimationFrame(() => constrainPanel());
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
        const [removed] = queue.splice(i, 1);
        persistQueue();
        renderQueue();
        offerUndo("Prompt removed.", () => {
          queue.splice(Math.min(i, queue.length), 0, removed);
          persistQueue();
          renderQueue();
          setStatus("Prompt restored.", false);
        });
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
    requestAnimationFrame(() => constrainPanel());
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
    renderOnboarding();
    renderControls();
    updateProgress();
  }

  function renderOnboarding() {
    const el = panel && panel.querySelector("#cps-onboarding");
    if (el) el.hidden = onboardingDismissed;
  }

  function dismissOnboarding() {
    onboardingDismissed = true;
    try {
      chrome.storage.local.set({ [KEY_ONBOARDING]: true });
    } catch (_) {}
    renderOnboarding();
    requestAnimationFrame(() => constrainPanel());
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

  function downloadFile(name, text, mime) {
    const blob = new Blob([text], { type: mime || "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  function pickFile(accept, onText) {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = accept;
    inp.onchange = () => {
      const file = inp.files && inp.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => onText(String(reader.result));
      reader.readAsText(file);
    };
    inp.click();
  }

  function exportQueue() {
    if (queue.length === 0) return;
    downloadFile("prompt-stack.txt", serializeQueue(queue), "text/plain");
  }

  function importQueue() {
    pickFile(".txt,text/plain", (text) => {
      const parsed = parsePrompts(text);
      if (parsed.length) {
        queue.push(...parsed);
        dismissOnboarding();
        persistQueue();
        renderQueue();
        setStatus(`Imported ${parsed.length} prompt(s).`, false);
      }
    });
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
      const onEsc = (e) => {
        if (e.key === "Escape") close(null);
      };
      const close = (result) => {
        document.removeEventListener("keydown", onEsc, true);
        overlay.remove();
        resolve(result);
      };
      buildInner(modal, close);
      overlay.addEventListener("mousedown", (e) => {
        if (e.target === overlay) close(null);
      });
      document.addEventListener("keydown", onEsc, true);
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
  function constrainPanel(el = panel) {
    if (!el || !el.isConnected) return;
    const edge = 8;
    const r = el.getBoundingClientRect();
    const maxLeft = Math.max(edge, window.innerWidth - r.width - edge);
    const maxTop = Math.max(edge, window.innerHeight - r.height - edge);
    el.style.left = Math.min(maxLeft, Math.max(edge, r.left)) + "px";
    el.style.top = Math.min(maxTop, Math.max(edge, r.top)) + "px";
    el.style.right = "auto";
  }

  function makeDraggable(el, handle) {
    let sx, sy, ox, oy, dragging = false, moved = false;
    handle.addEventListener("mousedown", (e) => {
      if (e.target.closest(".cps-icon-btn")) return;
      dragging = true;
      moved = false;
      sx = e.clientX;
      sy = e.clientY;
      const r = el.getBoundingClientRect();
      ox = r.left;
      oy = r.top;
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      if (!moved && Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) > 4) {
        moved = true;
      }
      if (!moved) return;
      const r = el.getBoundingClientRect();
      const edge = 8;
      const maxLeft = Math.max(edge, window.innerWidth - r.width - edge);
      const maxTop = Math.max(edge, window.innerHeight - r.height - edge);
      const nextLeft = ox + (e.clientX - sx);
      const nextTop = oy + (e.clientY - sy);
      el.style.left = Math.min(maxLeft, Math.max(edge, nextLeft)) + "px";
      el.style.top = Math.min(maxTop, Math.max(edge, nextTop)) + "px";
      el.style.right = "auto";
    });
    document.addEventListener("mouseup", (e) => {
      // A click on the header (no real drag, not on a button) toggles collapse.
      if (dragging && !moved && !e.target.closest(".cps-icon-btn")) {
        toggleCollapse();
      }
      dragging = false;
    });
  }

  // ==========================================================================
  // Init
  // ==========================================================================
  // Global shortcuts. Ctrl/⌘+Shift+… is used to avoid clashing with ChatGPT.
  function onKey(e) {
    if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return;
    const k = e.key.toLowerCase();
    if (k === "s") {
      e.preventDefault();
      runState === "idle" ? start() : stop();
    } else if (k === "p") {
      e.preventDefault();
      pauseOrResume();
    } else if (k === "h") {
      e.preventDefault();
      toggleCollapse();
    }
  }

  function mount() {
    if (document.getElementById("cps-panel")) return;
    buildPanel();
    applyTheme();
    applyBrand();
    watchPageTheme();
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", () => constrainPanel());
    restore();
  }

  function init() {
    if (document.getElementById("cps-panel")) return;
    mount();
  }

  if (document.body) init();
  else window.addEventListener("DOMContentLoaded", init);
})();
