// Selection UI for the ChatGPT image library (chatgpt.com/images).
//
// Reads the library through /backend-api/my/recent/image_gen, whose `url` field
// is the full-quality original (verified byte-identical to the files API
// download). Thumbnails come from encodings.thumbnail.path so the picker stays
// light — the originals are only fetched for you hover or actually select.
//
// The feed is newest-first and every item carries created_at, so "everything
// since my last download" is a watermark comparison, and paging can stop as
// soon as it walks past the watermark.

(() => {
  if (window.__ctigLoaded) return;
  window.__ctigLoaded = true;

  const PAGE_SIZE = 50;
  const INITIAL_PAGES = 3;
  const HISTORY_KEY = 'ctig.history';
  // Enough to cover a few very large sessions without bloating storage.
  const MAX_REMEMBERED_IDS = 20000;
  const HOVER_DELAY = 220;

  // Masonry maths: rows are 1px and the vertical gap is a cell margin, so a
  // span equals the image's exact pixel height — no rounding, so no crop.
  const GAP = 10;
  const DENSITIES = { s: 110, m: 170, l: 260 };

  const state = {
    items: [],
    selected: new Set(),
    cursor: null,
    exhausted: false,
    loading: false,
    lastClicked: -1,
    focus: -1,
    busy: false,
    token: null,
    density: 'm',
    hideDownloaded: false,
    colWidth: 0,
  };

  // Persisted between sessions. `at` is the created_at of the newest image in
  // the last download, i.e. the watermark everything newer is measured against.
  const history = {
    at: 0,
    runAt: '',
    count: 0,
    avgBytes: 0,
    ids: new Set(),
    failed: [],
  };

  let lastFailures = [];
  let host = null;
  let root = null;

  // --- persistence -----------------------------------------------------------

  const storage = () => (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) || null;

  async function loadHistory(merge = false) {
    const store = storage();
    if (!store) return;
    try {
      const data = await store.get(HISTORY_KEY);
      const saved = data && data[HISTORY_KEY];
      if (!saved) return;
      history.at = merge ? Math.max(history.at, saved.at || 0) : saved.at || 0;
      const storedIds = new Set(saved.ids || []);
      // Another tab may have saved after this picker opened. Keep its latest
      // ids at the tail so the cap cannot evict them in favour of our stale copy.
      history.ids = merge
        ? new Set([...history.ids].filter((id) => !storedIds.has(id)).concat([...storedIds]))
        : storedIds;
      if (merge && history.runAt > (saved.runAt || '')) return;
      history.runAt = saved.runAt || '';
      history.count = saved.count || 0;
      history.avgBytes = saved.avgBytes || 0;
      history.failed = saved.failed || [];
      // A retry offer is only useful if it outlives the tab that failed.
      lastFailures = history.failed;
    } catch {}
  }

  async function saveHistory() {
    const store = storage();
    if (!store) return;
    // Keep the TAIL: recordDownload inserts oldest-first, so the tail holds the
    // newest ids — the ones the watermark rule reads (see isNewItem).
    const ids = [...history.ids].slice(-MAX_REMEMBERED_IDS);
    history.ids = new Set(ids);
    try {
      await store.set({
        [HISTORY_KEY]: {
          at: history.at,
          runAt: history.runAt,
          count: history.count,
          avgBytes: history.avgBytes,
          ids,
          failed: history.failed,
        },
      });
    } catch {}
  }

  async function recordDownload(items, result) {
    // The image lock serializes jobs, but each open picker has its own snapshot.
    // Merge the persisted result of the previous job before writing this one.
    await loadHistory(true);
    history.failed = (result.failures || []).map((failure) => ({ id: failure.id, error: failure.error }));
    lastFailures = history.failed;
    const failed = new Set(history.failed.map((failure) => failure.id));
    const saved = items.filter((item) => !failed.has(item.id));
    if (!saved.length) return saveHistory();
    // `items` arrives newest-first (the feed order); insert OLDEST-first so the
    // tail of the Set is the most recent download. saveHistory() keeps the tail
    // when it trims to MAX_REMEMBERED_IDS, and the recent ids are the ones the
    // watermark depends on.
    for (const item of saved.slice().reverse()) history.ids.add(item.id);
    const newest = saved.reduce((max, item) => Math.max(max, item.created || 0), 0);
    // Only ever move the watermark forward — re-downloading old images should
    // not make everything since then look new again.
    if (newest > history.at) history.at = newest;
    history.runAt = new Date().toISOString();
    history.count = saved.length;
    if (result.bytes && result.saved) history.avgBytes = Math.round(result.bytes / result.saved);
    await saveHistory();
  }

  // --- data ------------------------------------------------------------------

  async function getToken() {
    if (state.token) return state.token;
    const res = await fetch('/api/auth/session', { credentials: 'include' });
    const data = await res.json();
    state.token = data && data.accessToken;
    if (!state.token) throw new Error('Not signed in.');
    return state.token;
  }

  async function fetchPage(cursor) {
    const token = await getToken();
    const query = `limit=${PAGE_SIZE}${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`;
    const res = await fetch(`/backend-api/my/recent/image_gen?${query}`, {
      credentials: 'include',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Library request failed (HTTP ${res.status})`);
    const data = await res.json();
    const items = (data.items || []).filter((item) => item.url).map((item) => ({
      id: item.id,
      url: item.url,
      thumb: (item.encodings && item.encodings.thumbnail && item.encodings.thumbnail.path) || item.url,
      width: item.width,
      height: item.height,
      created: item.created_at,
      prompt: item.prompt || item.title || '',
    }));
    return { items, cursor: items.length ? data.cursor : null };
  }

  let pendingPage = null;
  function withPageLoad(work) {
    if (pendingPage) return pendingPage;
    state.loading = true;
    pendingPage = work().finally(() => { state.loading = false; pendingPage = null; });
    return pendingPage;
  }

  async function loadPage() {
    if (pendingPage) return pendingPage;
    if (state.exhausted) return 0;
    return withPageLoad(async () => {
      const page = await fetchPage(state.cursor);
      const known = new Set(state.items.map((item) => item.id));
      state.items.push(...page.items.filter((item) => !known.has(item.id)));
      state.cursor = page.cursor;
      state.exhausted = !page.cursor;
      return page.items.length;
    });
  }

  // A tab can stay open while new images arrive. Refresh from the head until
  // we overlap the cached feed, retaining older loaded pages and selections.
  async function refreshHead() {
    if (pendingPage) await pendingPage;
    return withPageLoad(async () => {
      const known = new Set(state.items.map((item) => item.id));
      const fresh = new Map();
      let cursor = null;
      do {
        const page = await fetchPage(cursor);
        for (const item of page.items) fresh.set(item.id, item);
        cursor = page.cursor;
        if (!cursor || page.items.some((item) => known.has(item.id))) break;
      } while (cursor);
      state.items = [...fresh.values(), ...state.items.filter((item) => !fresh.has(item.id))];
      if (!known.size || !cursor) {
        state.cursor = cursor;
        state.exhausted = !cursor;
      }
    });
  }

  async function loadAll() {
    while (!state.exhausted) {
      await loadPage();
      render();
      setStatus(`Loaded ${state.items.length} images…`);
    }
  }

  // Pages only until the feed walks past the watermark, so "select new" on a
  // 5000-image library still costs one or two requests.
  async function loadUntilWatermark() {
    while (!state.exhausted) {
      const oldest = state.items[state.items.length - 1];
      // Stop only on a STRICTLY older item: siblings inside the watermark's own
      // second may still be undownloaded, so that whole second has to load
      // before we can trust the "new" count (see isNewItem).
      if (oldest && oldest.created && oldest.created < history.at) return;
      await loadPage();
      render();
      setStatus(`Looking for new images… ${state.items.length} checked`);
    }
  }

  // --- formatting ------------------------------------------------------------

  const DAY = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  const STAMP = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  function dayKey(created) {
    if (!created) return 'undated';
    const date = new Date(created * 1000);
    return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  }

  function dayLabel(created) {
    if (!created) return 'Undated';
    const date = new Date(created * 1000);
    const today = new Date();
    const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const days = Math.floor((midnight - new Date(date.getFullYear(), date.getMonth(), date.getDate())) / 86400000);
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    return DAY.format(date);
  }

  function formatBytes(bytes) {
    if (!bytes) return '';
    if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
    return `${Math.round(bytes / 1_048_576)} MB`;
  }

  // --- ui --------------------------------------------------------------------

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, sans-serif; }
    .backdrop {
      position: fixed; inset: 0; z-index: 2147483100;
      background: rgba(0,0,0,.72); display: flex; align-items: center; justify-content: center;
    }
    .panel {
      width: min(1500px, 96vw); height: 94vh;
      background: #1f2023; color: #ececf1; border-radius: 14px;
      display: flex; flex-direction: column; overflow: hidden;
      box-shadow: 0 20px 60px rgba(0,0,0,.5);
    }
    .bar {
      display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
      padding: 12px 16px; border-bottom: 1px solid #34363c;
    }
    .bar h2 { margin: 0; font-size: 14px; font-weight: 600; }
    .last {
      margin-right: auto; font-size: 11px; color: #9aa0aa;
      padding: 3px 9px; border-radius: 999px; background: #2b2d31; white-space: nowrap;
    }
    .last b { color: #d7dae0; font-weight: 600; }
    button.act {
      padding: 6px 11px; border: 1px solid #45474e; border-radius: 7px;
      background: #2b2d31; color: #ececf1; font-size: 12px; cursor: pointer;
    }
    button.act:hover { background: #35373c; }
    button.act:disabled { opacity: .45; cursor: default; }
    button.act.on { background: #10a37f22; border-color: #10a37f; color: #4ad3ad; }
    button.primary { background: #10a37f; border-color: #10a37f; color: #fff; font-weight: 600; }
    button.primary:disabled { opacity: .5; cursor: default; }
    button.close { background: transparent; border: 0; color: #9aa0aa; font-size: 20px; cursor: pointer; line-height: 1; }
    .seg { display: flex; border: 1px solid #45474e; border-radius: 7px; overflow: hidden; }
    .seg button {
      padding: 6px 9px; border: 0; background: #2b2d31; color: #9aa0aa;
      font-size: 11px; cursor: pointer; border-right: 1px solid #45474e;
    }
    .seg button:last-child { border-right: 0; }
    .seg button.on { background: #10a37f; color: #fff; font-weight: 600; }
    .grid {
      flex: 1; overflow-y: auto; padding: 14px;
      display: grid; grid-template-columns: repeat(auto-fill, minmax(var(--cell, 170px), 1fr));
      grid-auto-rows: 1px; row-gap: 0; column-gap: ${GAP}px; align-content: start;
    }
    .head {
      grid-column: 1 / -1; grid-row: span 40; margin-bottom: ${GAP}px;
      display: flex; align-items: center; gap: 10px;
      font-size: 12px; font-weight: 600; color: #9aa0aa;
      letter-spacing: .04em; text-transform: uppercase;
    }
    .head::after { content: ''; flex: 1; height: 1px; background: #34363c; }
    .mark {
      grid-column: 1 / -1; grid-row: span 34; margin-bottom: ${GAP}px;
      display: flex; align-items: center; gap: 10px;
      font-size: 11px; font-weight: 600; color: #f0b132; white-space: nowrap;
    }
    .mark::before, .mark::after { content: ''; flex: 1; height: 2px; background: #f0b13255; }
    .cell {
      position: relative; border-radius: 9px; overflow: hidden; margin-bottom: ${GAP}px;
      background: #2b2d31; cursor: pointer; border: 2px solid transparent;
    }
    .cell img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .cell.on { border-color: #10a37f; }
    .cell.on::after {
      content: '✓'; position: absolute; top: 5px; right: 5px;
      width: 20px; height: 20px; border-radius: 50%;
      background: #10a37f; color: #fff; font-size: 13px;
      display: flex; align-items: center; justify-content: center;
    }
    .cell.cursor { outline: 2px solid #6ea8fe; outline-offset: 1px; }
    .cell.had { opacity: .42; }
    .cell.had:hover { opacity: .85; }
    .cell.gone { display: none; }
    .badge {
      position: absolute; top: 5px; left: 5px; padding: 1px 6px; border-radius: 999px;
      background: rgba(0,0,0,.7); font-size: 10px; color: #9aa0aa;
    }
    .dims {
      position: absolute; left: 5px; bottom: 5px; padding: 1px 5px; border-radius: 4px;
      background: rgba(0,0,0,.65); font-size: 10px; color: #d7dae0;
    }
    .zoom {
      position: absolute; right: 5px; bottom: 5px; width: 22px; height: 22px;
      border: 0; border-radius: 6px; background: rgba(0,0,0,.65); color: #ececf1;
      font-size: 12px; line-height: 1; cursor: zoom-in; display: none;
    }
    .cell:hover .zoom { display: block; }
    .foot {
      padding: 10px 16px; border-top: 1px solid #34363c;
      font-size: 12px; color: #9aa0aa; display: flex; align-items: center; gap: 10px;
    }
    .foot .track { flex: 1; height: 4px; background: #34363c; border-radius: 2px; overflow: hidden; }
    .foot .track > div { height: 100%; width: 0; background: #10a37f; transition: width .2s; }
    .hint { font-size: 11px; color: #767b85; }
    .count { color: #ececf1; font-weight: 600; white-space: nowrap; }
    .peek {
      position: fixed; top: 50%; transform: translateY(-50%); width: 360px; max-height: 80vh;
      z-index: 2147483200; background: #17181a; border: 1px solid #3a3c42; border-radius: 12px;
      box-shadow: 0 18px 50px rgba(0,0,0,.6); overflow: hidden;
      display: flex; flex-direction: column; pointer-events: none;
    }
    .peek img { width: 100%; max-height: 62vh; object-fit: contain; background: #0d0e10; display: block; }
    .peek .meta { padding: 9px 11px; font-size: 11px; color: #9aa0aa; display: grid; gap: 4px; }
    .peek .meta .p { color: #d7dae0; font-size: 12px; max-height: 66px; overflow: hidden; }
    .lightbox {
      position: fixed; inset: 0; z-index: 2147483300; background: rgba(0,0,0,.92);
      display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 12px;
      cursor: zoom-out; padding: 24px;
    }
    .lightbox img { max-width: 96vw; max-height: 84vh; object-fit: contain; }
    .lightbox .meta { font-size: 12px; color: #9aa0aa; max-width: 900px; text-align: center; }
  `;

  // The picker is opened from the Prompt Stacker panel's Images tab. The old
  // floating "⬇ Download images" launcher is deliberately gone: one entry point,
  // and it removes the only reason this file needed the `tabs` permission.
  function ensureHost() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'chatgpt-thread-image-grabber';
    root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    root.append(style);
    document.body.append(host);
  }

  let backdrop = null;
  let gridEl = null;
  let statusEl = null;
  let fillEl = null;
  let countEl = null;
  let lastEl = null;
  let selEl = null;
  let newBtn = null;
  let retryBtn = null;
  let hideBtn = null;
  let peek = null;
  let lightbox = null;
  let hoverTimer = 0;
  let hovered = -1;

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function setProgress(done, total) {
    if (!fillEl) return;
    fillEl.style.width = total ? `${Math.round((100 * done) / total)}%` : '0';
  }

  // "New" = at or newer than the second of your last download, AND not already
  // saved. created_at has ONE-SECOND resolution and ChatGPT emits whole batches
  // inside a single second, so comparing timestamps alone cannot separate a
  // half-downloaded batch: a strict `>` mislabels every sibling of an image you
  // just saved. The saved-id set — not the clock — decides that same second.
  function isNewItem(item) {
    return (item.created || 0) >= history.at && !history.ids.has(item.id);
  }

  function newSinceWatermark() {
    if (!history.at) return [];
    return state.items.filter(isNewItem);
  }

  function updateChrome() {
    if (!countEl) return;
    const size = history.avgBytes ? formatBytes(history.avgBytes * state.selected.size) : '';
    countEl.textContent = `Download ${state.selected.size || ''}`.trim();
    countEl.disabled = state.selected.size === 0 || state.busy;
    if (selEl) {
      selEl.textContent = state.selected.size
        ? `${state.selected.size} selected${size ? ` · ~${size}` : ''}`
        : '';
    }
    if (lastEl) {
      lastEl.innerHTML = history.runAt
        ? `Last download <b>${STAMP.format(new Date(history.runAt))}</b> · ${history.count} images`
        : 'No downloads recorded yet';
    }
    if (newBtn) {
      const fresh = newSinceWatermark().length;
      newBtn.disabled = !history.at || state.busy;
      newBtn.textContent = history.at && fresh ? `Select new (${fresh})` : 'Select new';
      // Before the first download there is no watermark to compare against, so
      // this is permanently disabled. Say why instead of looking broken.
      newBtn.title = history.at ? '' : 'Nothing to compare against yet — download something first.';
    }
    if (retryBtn) retryBtn.style.display = lastFailures.length ? '' : 'none';
    if (retryBtn) retryBtn.textContent = `Select ${lastFailures.length} failed`;
    if (hideBtn) hideBtn.classList.toggle('on', state.hideDownloaded);
  }

  function open() {
    ensureHost();
    if (backdrop) return;
    backdrop = document.createElement('div');
    backdrop.className = 'backdrop';
    backdrop.innerHTML = `
      <div class="panel">
        <div class="bar">
          <h2>Image library</h2>
          <span class="last"></span>
          <button class="act" data-act="new">Select new</button>
          <button class="act" data-act="retry" style="display:none">Select failed</button>
          <button class="act" data-act="all">Select all loaded</button>
          <button class="act" data-act="none">Clear</button>
          <button class="act" data-act="hide">Hide downloaded</button>
          <button class="act" data-act="more">Load all</button>
          <span class="seg">
            <button data-density="s">S</button>
            <button data-density="m">M</button>
            <button data-density="l">L</button>
          </span>
          <button class="act primary" data-act="go">Download</button>
          <button class="close" data-act="close">×</button>
        </div>
        <div class="grid"></div>
        <div class="foot">
          <span class="status">Loading…</span>
          <span class="count"></span>
          <span class="track"><div></div></span>
          <span class="hint">click select · shift-click range · ⇥ arrows move · space toggles · f preview · ⌘A all · esc close</span>
        </div>
      </div>`;
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) close();
    });
    root.append(backdrop);

    gridEl = root.querySelector('.grid');
    statusEl = root.querySelector('.status');
    fillEl = root.querySelector('.track > div');
    countEl = root.querySelector('[data-act="go"]');
    lastEl = root.querySelector('.last');
    selEl = root.querySelector('.count');
    newBtn = root.querySelector('[data-act="new"]');
    retryBtn = root.querySelector('[data-act="retry"]');
    hideBtn = root.querySelector('[data-act="hide"]');

    root.querySelector('.bar').addEventListener('click', onToolbar);
    gridEl.addEventListener('scroll', onScroll);
    gridEl.addEventListener('click', onCellClick);
    gridEl.addEventListener('mouseover', onHover);
    gridEl.addEventListener('mouseleave', hidePeek);
    document.addEventListener('keydown', onKey, true);
    resizeObserver.observe(gridEl);
    setDensity(state.density);

    (async () => {
      try {
        await loadHistory();
        updateChrome();
        // Keep cached older pages, but do not hide images generated since the
        // previous open. Never refresh state under an active download.
        if (!state.items.length) {
          for (let i = 0; i < INITIAL_PAGES && !state.exhausted; i++) await loadPage();
        } else if (!state.busy) await refreshHead();
        rebuild();
        setStatus(`${state.items.length} loaded${state.exhausted ? '' : ' — scroll or “Load all” for more'}`);
        updateChrome();
      } catch (error) {
        setStatus(String(error.message || error));
      }
    })();
    updateChrome();
  }

  function close() {
    if (!backdrop) return;
    hidePeek();
    closeLightbox();
    document.removeEventListener('keydown', onKey, true);
    resizeObserver.disconnect();
    backdrop.remove();
    backdrop = gridEl = statusEl = fillEl = countEl = lastEl = selEl = null;
    newBtn = retryBtn = hideBtn = null;
    // Tell the panel it may come back. `ctigPanelHold` is what stops the
    // navigation watchdog from closing a picker the panel deliberately opened
    // off /images, so it must be cleared on every close path.
    window.ctigPanelHold = false;
    if (typeof window.ctigPickerClosed === 'function') {
      try {
        window.ctigPickerClosed();
      } catch (_) {}
    }
  }

  function selectAllOf(items) {
    for (const item of items) state.selected.add(item.id);
    syncCells();
    updateChrome();
  }

  async function onToolbar(event) {
    const density = event.target.dataset && event.target.dataset.density;
    if (density) return setDensity(density);
    const action = event.target.dataset && event.target.dataset.act;
    if (!action) return;
    if (action === 'close') return close();
    if (action === 'all') selectAllOf(state.items);
    if (action === 'none') {
      state.selected.clear();
      syncCells();
    }
    if (action === 'hide') {
      state.hideDownloaded = !state.hideDownloaded;
      syncCells();
    }
    if (action === 'retry') {
      const ids = new Set(lastFailures.map((failure) => failure.id));
      selectAllOf(state.items.filter((item) => ids.has(item.id)));
    }
    if (action === 'new') {
      if (!history.at) return;
      setStatus('Looking for new images…');
      // Both of these hit the network and can fail (expired session, HTTP error).
      // Without the catch the rejection was unhandled and the status stayed on
      // "Looking for new images…" forever, so the button looked dead.
      try {
        await refreshHead();
        await loadUntilWatermark();
        const fresh = newSinceWatermark();
        state.selected.clear();
        selectAllOf(fresh);
        rebuild();
        setStatus(
          fresh.length
            ? `${fresh.length} new since your last download — selected.`
            : 'Nothing new since your last download.'
        );
      } catch (error) {
        setStatus(String(error.message || error));
      }
    }
    if (action === 'more') {
      setStatus('Loading the whole library…');
      try {
        await loadAll();
        setStatus(`${state.items.length} images loaded — all of them.`);
      } catch (error) {
        setStatus(String(error.message || error));
      }
    }
    if (action === 'go') download();
    updateChrome();
  }

  function setDensity(density) {
    state.density = DENSITIES[density] ? density : 'm';
    if (!gridEl) return;
    gridEl.style.setProperty('--cell', `${DENSITIES[state.density]}px`);
    for (const button of root.querySelectorAll('[data-density]')) {
      button.classList.toggle('on', button.dataset.density === state.density);
    }
    state.colWidth = 0;
    // Reading geometry straight away forces the new column width to resolve;
    // rAF would never fire in a background tab and leave spans stale.
    layout(true);
  }

  async function onScroll() {
    hidePeek();
    if (!gridEl || state.exhausted || state.loading) return;
    if (gridEl.scrollTop + gridEl.clientHeight > gridEl.scrollHeight - 400) {
      await loadPage();
      render();
      setStatus(`${state.items.length} loaded${state.exhausted ? ' — all of them' : ''}`);
      updateChrome();
    }
  }

  function toggleRange(from, to, turningOn) {
    const [start, end] = [from, to].sort((a, b) => a - b);
    for (let i = start; i <= end; i++) {
      const id = state.items[i].id;
      if (turningOn) state.selected.add(id);
      else state.selected.delete(id);
    }
  }

  function onCellClick(event) {
    const cell = event.target.closest('.cell');
    if (!cell) return;
    const position = Number(cell.dataset.pos);
    const item = state.items[position];
    if (!item) return;

    if (event.target.classList.contains('zoom')) {
      event.stopPropagation();
      return openLightbox(position);
    }

    if (event.shiftKey && state.lastClicked >= 0) {
      toggleRange(state.lastClicked, position, !state.selected.has(item.id));
    } else {
      if (state.selected.has(item.id)) state.selected.delete(item.id);
      else state.selected.add(item.id);
      state.lastClicked = position;
    }
    state.focus = position;
    syncCells();
    updateChrome();
  }

  // --- hover preview ---------------------------------------------------------

  function onHover(event) {
    const cell = event.target.closest('.cell');
    if (!cell) return;
    const position = Number(cell.dataset.pos);
    if (position === hovered) return;
    hovered = position;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => showPeek(position, cell), HOVER_DELAY);
  }

  function showPeek(position, cell) {
    const item = state.items[position];
    if (!item || !backdrop || lightbox) return;
    if (!peek) {
      peek = document.createElement('div');
      peek.className = 'peek';
      root.append(peek);
    }
    const stamp = item.created ? STAMP.format(new Date(item.created * 1000)) : 'undated';
    const dims = item.width && item.height ? ` · ${item.width}×${item.height}` : '';
    const had = history.ids.has(item.id) ? ' · already downloaded' : '';
    peek.innerHTML = `
      <img alt="">
      <div class="meta">
        <div class="p"></div>
        <div>${stamp}${dims}${had}</div>
      </div>`;
    peek.querySelector('.p').textContent = item.prompt || '(no prompt recorded)';

    const img = peek.querySelector('img');
    img.src = item.thumb;
    // Upgrade to the original once it lands, but only if the pointer stayed put.
    const full = new Image();
    full.onload = () => {
      if (hovered === position && peek) img.src = item.url;
    };
    full.src = item.url;

    // Sit on the side the pointer is not on, so the preview never covers the
    // cell being inspected.
    const box = cell.getBoundingClientRect();
    const onLeft = box.left + box.width / 2 > window.innerWidth / 2;
    peek.style.left = onLeft ? '24px' : '';
    peek.style.right = onLeft ? '' : '24px';
  }

  function hidePeek() {
    clearTimeout(hoverTimer);
    hovered = -1;
    if (peek) {
      peek.remove();
      peek = null;
    }
  }

  // --- lightbox --------------------------------------------------------------

  function openLightbox(position) {
    const item = state.items[position];
    if (!item) return;
    hidePeek();
    closeLightbox();
    lightbox = document.createElement('div');
    lightbox.className = 'lightbox';
    const stamp = item.created ? STAMP.format(new Date(item.created * 1000)) : 'undated';
    const dims = item.width && item.height ? ` · ${item.width}×${item.height}` : '';
    lightbox.innerHTML = `<img alt=""><div class="meta"></div>`;
    lightbox.querySelector('img').src = item.url;
    lightbox.querySelector('.meta').textContent = `${item.prompt || '(no prompt)'} — ${stamp}${dims}`;
    lightbox.addEventListener('click', closeLightbox);
    root.append(lightbox);
  }

  function closeLightbox() {
    if (!lightbox) return;
    lightbox.remove();
    lightbox = null;
  }

  // --- keyboard --------------------------------------------------------------

  function visibleCells() {
    return gridEl ? [...gridEl.querySelectorAll('.cell:not(.gone)')] : [];
  }

  function focusCell(cell, extend) {
    const position = Number(cell.dataset.pos);
    if (extend && state.focus >= 0) toggleRange(state.focus, position, true);
    state.focus = position;
    cell.scrollIntoView({ block: 'nearest' });
    syncCells();
    updateChrome();
  }

  function moveFocus(step, extend) {
    const cells = visibleCells();
    if (!cells.length) return;
    const current = cells.findIndex((cell) => Number(cell.dataset.pos) === state.focus);
    const next = Math.max(0, Math.min(cells.length - 1, current < 0 ? 0 : current + step));
    focusCell(cells[next], extend);
  }

  // Cells in a masonry column are all different heights, so "down" means the
  // next cell in the same column, not a fixed jump through the item list.
  function moveVertical(direction, extend) {
    const cells = visibleCells();
    if (!cells.length) return;
    const current = cells.find((cell) => Number(cell.dataset.pos) === state.focus);
    if (!current) return moveFocus(direction, extend);
    const from = current.getBoundingClientRect();
    const centre = from.left + from.width / 2;
    let best = null;
    let bestGap = Infinity;
    for (const cell of cells) {
      if (cell === current) continue;
      const box = cell.getBoundingClientRect();
      if (Math.abs(box.left + box.width / 2 - centre) > from.width / 2) continue;
      const gap = direction > 0 ? box.top - from.top : from.top - box.top;
      if (gap > 1 && gap < bestGap) {
        bestGap = gap;
        best = cell;
      }
    }
    if (best) focusCell(best, extend);
  }

  function onKey(event) {
    if (!backdrop) return;
    const key = event.key;
    if (key === 'Escape') {
      event.preventDefault();
      return lightbox ? closeLightbox() : close();
    }
    if (lightbox) return;
    if ((event.metaKey || event.ctrlKey) && key.toLowerCase() === 'a') {
      event.preventDefault();
      return selectAllOf(state.items);
    }
    if (key === 'ArrowRight' || key === 'ArrowLeft') {
      event.preventDefault();
      return moveFocus(key === 'ArrowRight' ? 1 : -1, event.shiftKey);
    }
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault();
      return moveVertical(key === 'ArrowDown' ? 1 : -1, event.shiftKey);
    }
    if (key === ' ' || key === 'Enter') {
      event.preventDefault();
      const item = state.items[state.focus];
      if (!item) return;
      if (state.selected.has(item.id)) state.selected.delete(item.id);
      else state.selected.add(item.id);
      state.lastClicked = state.focus;
      syncCells();
      return updateChrome();
    }
    if (key.toLowerCase() === 'f' && state.focus >= 0) {
      event.preventDefault();
      openLightbox(state.focus);
    }
  }

  // --- rendering -------------------------------------------------------------

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const img = entry.target;
        if (img.dataset.src) {
          img.src = img.dataset.src;
          delete img.dataset.src;
        }
        observer.unobserve(img);
      }
    },
    { root: null, rootMargin: '300px' }
  );

  const resizeObserver = new ResizeObserver(() => layout(false));

  let rendered = 0;
  let headerKey = null;
  let markPlaced = false;

  function buildCell(item, position) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.dataset.pos = String(position);
    const img = document.createElement('img');
    img.dataset.src = item.thumb;
    img.loading = 'lazy';
    img.alt = '';
    cell.append(img);
    if (item.width && item.height) {
      const dims = document.createElement('span');
      dims.className = 'dims';
      dims.textContent = `${item.width}×${item.height}`;
      cell.append(dims);
    }
    const zoom = document.createElement('button');
    zoom.className = 'zoom';
    zoom.textContent = '⤢';
    zoom.title = 'Open full size';
    cell.append(zoom);
    observer.observe(img);
    return cell;
  }

  function render() {
    if (!gridEl) return;
    for (; rendered < state.items.length; rendered++) {
      const item = state.items[rendered];
      const key = dayKey(item.created);
      if (key !== headerKey) {
        headerKey = key;
        const head = document.createElement('div');
        head.className = 'head';
        head.textContent = dayLabel(item.created);
        gridEl.append(head);
      }
      // Positional anchor, NOT a claim about what you already have: everything
      // above the line is at or newer than the second your last download ended
      // on, and siblings inside that same second can still be undownloaded. The
      // per-cell `saved` badge is what states the per-photo truth. Placed before
      // the first STRICTLY older item so a same-second batch is not split.
      if (!markPlaced && history.at && (item.created || 0) < history.at) {
        markPlaced = true;
        const savedAbove = state.items
          .slice(0, rendered)
          .filter((entry) => history.ids.has(entry.id)).length;
        const mark = document.createElement('div');
        mark.className = 'mark';
        mark.textContent = savedAbove
          ? `≈ your last download was around here · ${savedAbove} above already saved`
          : '≈ your last download was around here';
        gridEl.append(mark);
      }
      gridEl.append(buildCell(item, rendered));
    }
    syncCells();
    layout(false);
  }

  function rebuild() {
    if (!gridEl) return;
    gridEl.textContent = '';
    rendered = 0;
    headerKey = null;
    markPlaced = false;
    state.colWidth = 0;
    render();
  }

  function syncCells() {
    if (!gridEl) return;
    for (const cell of gridEl.children) {
      if (!cell.classList.contains('cell')) continue;
      const position = Number(cell.dataset.pos);
      const item = state.items[position];
      if (!item) continue;
      const had = history.ids.has(item.id);
      cell.classList.toggle('on', state.selected.has(item.id));
      cell.classList.toggle('had', had && !state.selected.has(item.id));
      cell.classList.toggle('gone', had && state.hideDownloaded);
      cell.classList.toggle('cursor', position === state.focus);
      const badge = cell.querySelector('.badge');
      if (had && !badge) {
        const mark = document.createElement('span');
        mark.className = 'badge';
        mark.textContent = 'saved';
        cell.append(mark);
      } else if (!had && badge) {
        badge.remove();
      }
    }
  }

  // Masonry: each cell spans the number of grid rows its true aspect ratio needs,
  // so nothing is cropped and row order stays left-to-right chronological.
  function layout(force) {
    if (!gridEl) return;
    const first = gridEl.querySelector('.cell');
    if (!first) return;
    const width = first.getBoundingClientRect().width;
    if (!width) return;
    if (!force && Math.abs(width - state.colWidth) < 0.5) {
      // Only new cells need spans.
      for (const cell of gridEl.querySelectorAll('.cell:not([data-span])')) applySpan(cell, width);
      return;
    }
    state.colWidth = width;
    for (const cell of gridEl.querySelectorAll('.cell')) applySpan(cell, width);
  }

  function applySpan(cell, width) {
    const item = state.items[Number(cell.dataset.pos)];
    if (!item) return;
    const ratio = item.width && item.height ? item.height / item.width : 1;
    // width is the border box; the 2px border on each side is not image area.
    const height = Math.max(40, (width - 4) * ratio + 4);
    const span = Math.max(1, Math.round(height + GAP));
    cell.style.gridRowEnd = `span ${span}`;
    cell.dataset.span = String(span);
  }

  // --- download --------------------------------------------------------------

  /**
   * May an image job start right now, in this tab or another?
   * Resolves to null when it may, or to a sentence explaining what is in the way.
   * Shared by both image jobs (library download and thread grab) so the policy
   * lives in exactly one place — see window.ctigImageJobGate below.
   *
   * Order matters: the same-tab checks come first (instant, no storage read),
   * then the cross-tab lock, which is the only one that can see other tabs.
   */
  function setImageBusy(busy) {
    window.ctigBusy = busy;
    if (typeof window.ctigImageBusyChanged === 'function') window.ctigImageBusyChanged(busy);
  }

  async function imageJobGate() {
    // The other image job in THIS tab. Both buttons are disabled while either
    // runs, but a queued click or a keyboard path must not slip through.
    if (window.ctigBusy) return 'Another image job is already running here — let it finish first.';

    // The prompt queue in this tab.
    if (typeof window.cpsIsRunning === 'function') {
      try {
        if (window.cpsIsRunning())
          return 'Pause the prompt queue first — sending and downloading at once scrambles both.';
      } catch (_) {}
    }

    // Cross-tab: any live lock that is not ours. Images block images too — two
    // tabs saving at once overwrite each other's "already downloaded" records.
    // Reserve this tab synchronously: the library and thread actions can both
    // arrive before storage resolves, even though each has its own UI guard.
    setImageBusy(true);
    try {
      if (window.cpsBusy) {
        const held = await window.cpsBusy.acquire('images');
        if (held) {
          setImageBusy(false);
          return held.owner === 'queue'
            ? 'The prompt queue is running in another tab — pause it first, then download.'
            : 'Another tab is already saving images — wait for it to finish.';
        }
      }
    } catch (error) {
      setImageBusy(false);
      throw error;
    }
    return null;
  }
  window.ctigImageJobGate = imageJobGate;

  // Named by capture time so repeated runs merge into one folder without
  // colliding or reshuffling — a per-selection counter restarts every run.
  function fileBaseName(item, position) {
    const shortId = String(item.id).replace(/^s_/, '').slice(0, 8);
    if (!item.created) return `undated_${String(position + 1).padStart(4, '0')}_${shortId}`;
    const date = new Date(item.created * 1000);
    const pad = (value) => String(value).padStart(2, '0');
    const stamp =
      `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
      `_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
    return `${stamp}_${shortId}`;
  }

  async function download() {
    if (state.busy || !state.selected.size) return;
    // Synchronous re-entrancy guard, set BEFORE anything awaits: the gate below
    // is async, and a double-click used to start two ZIP jobs through the gap.
    state.busy = true;
    updateChrome();

    const blocked = await imageJobGate().catch((error) => String(error.message || error));
    if (blocked) {
      state.busy = false;
      setStatus(blocked);
      updateChrome();
      return;
    }

    // Set only after the gate, so the gate can still see the other job's flag.
    window.ctigBusy = true;

    const chosen = state.items.filter((item) => state.selected.has(item.id));
    const images = chosen.map((item, position) => ({
      position,
      name: fileBaseName(item, position),
      url: item.url,
      id: item.id,
      created: item.created ? new Date(item.created * 1000).toISOString() : '',
      dimensions: item.width && item.height ? `${item.width}x${item.height}` : '',
      prompt: item.prompt,
    }));

    setStatus(`Downloading ${images.length} originals…`);
    setProgress(0, images.length);
    try {
      const result = await globalThis.ctigGrab({
        images,
        baseName: `chatgpt-library ${new Date().toISOString().slice(0, 10)}`,
        onProgress: ({ done, total }) => {
          setProgress(done, total);
          setStatus(`Downloaded ${done} of ${total}…`);
        },
      });
      lastFailures = result.failures || [];
      await recordDownload(chosen, result);
      const megabytes = (result.bytes / 1_048_576).toFixed(1);
      const partText = result.parts.length > 1 ? ` in ${result.parts.length} parts` : '';
      setStatus(
        `Saved ${result.saved} images (${megabytes} MB)${partText}.` +
          (result.failed ? ` ${result.failed} failed — see index.tsv.` : '')
      );
      state.selected.clear();
      syncCells();
    } catch (error) {
      const message = String(error.message || error);
      // The unchanged engine throws when every fetch fails, so there is no
      // result.failures to read. Preserve that whole selection for retry too.
      lastFailures = chosen.map((item) => ({ id: item.id, error: message }));
      await recordDownload(chosen, { saved: 0, failures: lastFailures });
      setStatus(message);
    } finally {
      state.busy = false;
      setImageBusy(false);
      // Release only our own token — releaseBusyLock used to delete whichever
      // lock was in the key, including another tab's.
      if (window.cpsBusy) await window.cpsBusy.release();
      updateChrome();
    }
  }

  // The library is client-routed. Nothing needs watching while the picker is
  // closed, so this only runs on a route change and while the picker is open —
  // it used to poll every second on every ChatGPT tab, forever, for a floating
  // launcher button that no longer exists.
  function syncLauncher() {
    const onImages = /^\/images/.test(location.pathname);
    if (onImages) ensureHost();
    // A picker opened from the panel's Images tab must survive navigation away
    // from /images: the feed API works from any chatgpt.com page. `ctigPanelHold`
    // is set by the panel and cleared in close().
    if (!onImages && !window.ctigPanelHold) close();
  }

  syncLauncher();
  window.addEventListener('popstate', syncLauncher);
  setInterval(() => {
    if (backdrop) syncLauncher();
  }, 1000);

  // Test hook: only wired up when a harness asks for it.
  if (document.documentElement.dataset.ctigTest === '1') {
    window.__ctig = { state, history, open, close, render, rebuild, fileBaseName, dayLabel, newSinceWatermark, isNewItem, recordDownload, formatBytes, syncLauncher };
  }

  // Bridge for the panel's Images tab. Both content-script blocks share one
  // isolated world, so these are visible to images-tab.js but not to the page.
  window.ctigOpenPicker = open;
  window.ctigIsOpen = () => !!backdrop;
  // Read-only summary for the tab's "Last download …" line. A function, not the
  // live object: the panel must not be able to mutate history by accident.
  window.ctigHistory = () => ({ runAt: history.runAt, count: history.count });
})();
