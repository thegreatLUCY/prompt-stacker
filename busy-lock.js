/* Cross-tab busy lock — shared by the prompt queue (content.js) and the image
 * engine (library.js / thread.js / images-tab.js).
 *
 * WHY THIS EXISTS
 * The queue auto-sends prompts and the image grabber scrolls the page and hammers
 * the network. Running both at once scrambles the queue and corrupts the
 * "already downloaded" records, so they take turns. A window flag cannot do that
 * job: the two features usually run in *different tabs*, and window flags are
 * per-tab. This file is loaded by BOTH content-script blocks, which share one
 * isolated world, so there is exactly one implementation of the protocol.
 *
 * HONEST LIMITS (do not overstate this lock)
 * - chrome.storage has no atomic compare-and-swap, so `acquire` is read-then-write.
 *   Two tabs acquiring inside the same few milliseconds can both think they won.
 *   Both callers here are user-initiated, seconds apart, so the window is not a
 *   practical risk — but it is real, and it is why this is a *guard* and not a
 *   mutual-exclusion primitive.
 * - The TTL must stay comfortably longer than the heartbeat AND longer than the
 *   interval Chrome imposes on timers in a hidden tab (throttled to 1/minute after
 *   ~5 minutes hidden). A hidden tab is precisely the normal case: you start the
 *   queue, then switch to the other tab. TTL 120s survives two skipped beats.
 *   Do not lower it without reading this comment.
 * - A tab that crashes leaves the lock behind until it expires (≤120s).
 */
(() => {
  "use strict";

  // Loaded by both content-script blocks; only the first one does the work.
  if (window.cpsBusy) return;

  const KEY = "cps_busy_lock";
  const TTL = 120000; // 120s — see the header. Must exceed Chrome's hidden-tab timer throttle.
  const BEAT = 20000; // 20s

  let token = null; // our token while we hold the lock, else null
  let owner = null; // "queue" | "images"
  let timer = null;
  const lostCbs = new Set();

  function store() {
    try {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local)
        return chrome.storage.local;
    } catch (_) {}
    return null;
  }

  function fresh(lock) {
    return !!(lock && lock.ts && Date.now() - lock.ts < TTL);
  }

  function newToken() {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  /** Live lock, or null. Never rejects. */
  function read() {
    return new Promise((resolve) => {
      const s = store();
      if (!s) return resolve(null);
      try {
        s.get([KEY], (data) => {
          const lock = data && data[KEY];
          resolve(fresh(lock) ? lock : null);
        });
      } catch (_) {
        resolve(null);
      }
    });
  }

  function write(lock) {
    return new Promise((resolve) => {
      const s = store();
      if (!s) return resolve();
      try {
        s.set({ [KEY]: lock }, () => resolve());
      } catch (_) {
        resolve();
      }
    });
  }

  function removeKey() {
    return new Promise((resolve) => {
      const s = store();
      if (!s || !s.remove) return resolve();
      try {
        s.remove([KEY], () => resolve());
      } catch (_) {
        resolve();
      }
    });
  }

  function notifyLost() {
    lostCbs.forEach((cb) => {
      try {
        cb();
      } catch (_) {}
    });
  }

  function stopBeat() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function startBeat() {
    stopBeat();
    timer = setInterval(beat, BEAT);
  }

  /**
   * Refresh our timestamp. If the stored token is no longer ours, someone else
   * took the lock while our tab was frozen: stop claiming it and say so, rather
   * than fighting over the key.
   */
  async function beat() {
    if (!token) return stopBeat();
    const held = await read();
    if (held && held.token !== token) {
      token = null;
      owner = null;
      stopBeat();
      notifyLost();
      return;
    }
    await write({ owner, token, ts: Date.now() });
  }

  /** Any live lock that is not ours (so the caller can say who is in the way). */
  async function blocker() {
    const held = await read();
    return held && held.token !== token ? held : null;
  }

  /**
   * Take the lock. Resolves to null on success, or to the live foreign lock that
   * is blocking us. Any owner blocks, including another tab running the *same*
   * job — two tabs downloading at once overwrite each other's saved-id records.
   */
  async function acquire(who) {
    const held = await read();
    if (held && held.token !== token) return held;
    if (!token) token = newToken();
    owner = who;
    await write({ owner, token, ts: Date.now() });
    startBeat();
    return null;
  }

  /** Give it up. Removes the key only if it is still ours. */
  async function release() {
    stopBeat();
    const mine = token;
    token = null;
    owner = null;
    if (!mine) return;
    const held = await read();
    if (held && held.token !== mine) return; // not ours any more — leave it alone
    await removeKey();
  }

  if (typeof window !== "undefined") {
    // Refresh immediately when the tab becomes visible again: the browser may have
    // throttled our interval while we were hidden.
    try {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") beat();
      });
      window.addEventListener("focus", beat);
      window.addEventListener("pagehide", () => {
        // Best effort; a hard kill still relies on the TTL.
        release();
      });
    } catch (_) {}

    window.cpsBusy = {
      KEY,
      TTL,
      BEAT,
      acquire,
      release,
      read,
      blocker,
      isMine: () => !!token,
      owner: () => owner,
      onLost: (cb) => {
        lostCbs.add(cb);
        return () => lostCbs.delete(cb);
      },
    };
  }
})();
