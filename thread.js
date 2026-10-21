// Grabs every generated image in the currently open conversation.
// Triggered by the Images pane; the library picker is a separate flow.

(() => {
  const IMAGE_HOST = /(^|\.)oaiusercontent\.com$/;
  const FILE_ID = /(file[-_][A-Za-z0-9]{6,})/;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function findScroller() {
    const anchor =
      document.querySelector('[data-message-author-role]') ||
      document.querySelector('[data-testid^="conversation-turn"]') ||
      document.querySelector('[data-turn-key]');
    for (let el = anchor; el; el = el.parentElement) {
      const style = getComputedStyle(el);
      if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 50) return el;
    }
    return document.scrollingElement || document.documentElement;
  }

  function isGeneratedImage(img) {
    // Generated images live in assistant turns; uploads live in user turns.
    const turn = img.closest('[data-message-author-role]');
    if (turn && turn.getAttribute('data-message-author-role') !== 'assistant') return false;
    if (!turn && !img.closest('[data-testid^="conversation-turn"]') &&
        !img.closest('[data-testid="generated-image-preview"]')) return false;
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    if (w && h && (w < 128 || h < 128)) return false; // avatars, spinners, icons
    return true;
  }

  // Largest srcset entry, since the plain src is often a downscaled render.
  function bestDomUrl(img) {
    let best = img.currentSrc || img.src || '';
    let bestWidth = 0;
    for (const part of (img.getAttribute('srcset') || '').split(',')) {
      const [url, descriptor] = part.trim().split(/\s+/);
      if (!url) continue;
      const width = descriptor && descriptor.endsWith('w') ? parseInt(descriptor, 10) : 0;
      if (width >= bestWidth) {
        bestWidth = width;
        best = url;
      }
    }
    try {
      return new URL(best, location.href).href;
    } catch {
      return '';
    }
  }

  function isChatGptImage(url) {
    if (!url || url.startsWith('data:') || url.startsWith('blob:')) return false;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:') return false;
      if (IMAGE_HOST.test(parsed.hostname)) return true;
      return (
        parsed.origin === new URL(location.href).origin &&
        /\/backend-api\/(estuary\/)?(content|files)/.test(parsed.pathname)
      );
    } catch {
      return false;
    }
  }

  function fileIdFor(url) {
    try {
      const fromQuery = new URL(url).searchParams.get('id');
      if (fromQuery && FILE_ID.test(fromQuery)) return fromQuery.match(FILE_ID)[1];
    } catch {}
    const match = url.match(FILE_ID);
    return match ? match[1] : null;
  }

  // Signed URLs can't be edited, so identity comes from the file id when there
  // is one, otherwise from the path without its query.
  function identityFor(url) {
    const fileId = fileIdFor(url);
    if (fileId) return fileId;
    try {
      const parsed = new URL(url);
      return parsed.origin + parsed.pathname;
    } catch {
      return url;
    }
  }

  async function scanDom(report) {
    const scroller = findScroller();
    const found = new Map();

    const harvest = () => {
      for (const img of document.images) {
        if (!isGeneratedImage(img)) continue;
        const domUrl = bestDomUrl(img);
        if (!isChatGptImage(domUrl)) continue;
        const identity = identityFor(domUrl);
        if (!found.has(identity)) found.set(identity, { url: domUrl, fileId: fileIdFor(domUrl) });
      }
    };

    harvest();
    let lastHeight = -1;
    let settled = 0;
    for (let step = 0; step < 400; step++) {
      scroller.scrollTop = 0;
      await sleep(250);
      harvest();
      report(`Scrolling the thread… ${found.size} images so far`);
      // Height stops growing once there is nothing older left to load.
      if (scroller.scrollHeight === lastHeight) {
        if (++settled >= 3) break;
      } else {
        settled = 0;
        lastHeight = scroller.scrollHeight;
      }
    }
    scroller.scrollTop = scroller.scrollHeight;
    await sleep(200);
    harvest();
    return [...found.values()];
  }

  // Current ChatGPT renders generated previews as blob URLs and no longer
  // always exposes the old assistant-turn attributes. A preview is not proof
  // of original quality. Resolve image assets from the current conversation
  // branch instead, then use ChatGPT's original-file download URLs.
  function conversationAssets(data) {
    const mapping = data && data.mapping;
    let nodeId = data && data.current_node;
    if (!mapping || typeof mapping !== 'object' || !nodeId || !mapping[nodeId]) {
      throw new Error('ChatGPT returned an unrecognized conversation format.');
    }
    const branch = [];
    const seen = new Set();
    while (nodeId) {
      if (seen.has(nodeId) || !mapping[nodeId]) throw new Error('ChatGPT returned an incomplete conversation branch.');
      seen.add(nodeId);
      const node = mapping[nodeId];
      branch.push(node.message);
      nodeId = node.parent;
    }
    const assets = new Map();
    for (const message of branch.reverse()) {
      const role = message && message.author && message.author.role;
      // User references must never become generated outputs. Image tools can
      // return the actual output in a tool message before the assistant reply.
      if (role !== 'assistant' && role !== 'tool') continue;
      const visit = (part) => {
        if (!part || typeof part !== 'object') return;
        if (Array.isArray(part)) return part.forEach(visit);
        if (part.content_type === 'image_asset_pointer') {
          const pointer = String(part.asset_pointer || '').replace(/^(?:file-service|sediment):\/\//, '');
          const fileId = fileIdFor(pointer);
          if (!fileId) throw new Error('A generated image has no recognizable original-file reference.');
          if (!assets.has(fileId)) assets.set(fileId, { fileId, width: part.width, height: part.height });
          return;
        }
        if (Array.isArray(part.parts)) part.parts.forEach(visit);
      };
      visit(message.content);
    }
    return [...assets.values()];
  }

  async function originalImages(conversationId, report) {
    const session = await fetch('/api/auth/session', { credentials: 'include' });
    if (!session.ok) throw new Error(`Session request failed (HTTP ${session.status}).`);
    const auth = await session.json();
    if (!auth || !auth.accessToken) throw new Error('Not signed in.');
    const options = { credentials: 'include', headers: { Authorization: `Bearer ${auth.accessToken}` } };
    const response = await fetch(`/backend-api/conversation/${encodeURIComponent(conversationId)}`, options);
    if (!response.ok) throw new Error(`Conversation request failed (HTTP ${response.status}).`);
    const assets = conversationAssets(await response.json());
    const images = [];
    for (const asset of assets) {
      report(`Resolving original ${images.length + 1} of ${assets.length}…`);
      const result = await fetch(`/backend-api/files/download/${encodeURIComponent(asset.fileId)}?conversation_id=${encodeURIComponent(conversationId)}&inline=false`, options);
      if (!result.ok) throw new Error(`Original-image request failed (HTTP ${result.status}).`);
      const file = await result.json();
      const rawUrl = file && (file.download_url || file.url);
      const url = typeof rawUrl === 'string' ? new URL(rawUrl, location.href).href : '';
      if (!isChatGptImage(url)) throw new Error('ChatGPT did not return a supported original-image URL.');
      images.push({ ...asset, url });
    }
    return images;
  }

  async function run(report) {
    const conversationId = (location.pathname.match(/\/c\/([\w-]+)/) || [])[1];
    let found = [];
    let originalError = null;
    if (conversationId) {
      try {
        found = await originalImages(conversationId, report);
      } catch (error) {
        originalError = error;
      }
    }
    if (originalError && document.querySelector('[data-testid="generated-image-preview"]')) {
      throw new Error(`Could not load original thread images: ${originalError.message}`);
    }
    // Preserve the existing direct-original URL path for older ChatGPT pages.
    if (!found.length) found = await scanDom(report);
    if (!found.length && (originalError || document.querySelector('[data-testid="generated-image-preview"]'))) {
      throw new Error(originalError
        ? `Could not load original thread images: ${originalError.message}`
        : 'Generated previews are visible, but their original files could not be resolved. Try the image library.');
    }
    if (!found.length) return { ok: true, saved: 0, message: 'No generated images found here.' };

    const title = document.title.replace(/\s*[-|]\s*ChatGPT\s*$/i, '').trim();
    const baseName = `chatgpt-thread ${title || conversationId || 'thread'} ${new Date()
      .toISOString()
      .slice(0, 10)}`.replace(/[\\/:*?"<>|]+/g, '-');

    const result = await globalThis.ctigGrab({
      baseName,
      images: found.map((image, position) => ({
        name: String(position + 1).padStart(3, '0'),
        url: image.url,
        id: image.fileId || '',
        created: '',
        dimensions: '',
        prompt: '',
      })),
      onProgress: ({ done, total }) => report(`Downloading ${done} of ${total}…`),
    });
    return { ok: true, ...result };
  }

  // Entry point for the panel's Images tab. The old runtime-message listener is
  // gone: after the merge there is no background worker and no popup to relay
  // through, so it could never fire, and it made a doomed sendMessage call on
  // every progress tick.
  //
  // Pass a report(text) callback to surface progress in the panel.
  window.ctigGrabThread = run;
})();
