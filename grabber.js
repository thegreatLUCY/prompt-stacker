// Shared fetch + zip + save engine. Runs as a content script because ChatGPT's
// image URLs require the page's session cookies: fetched anonymously they answer
// 403 {"detail":"File stream access denied."}.
//
// Quality: bytes go from the response straight into the archive. Nothing is
// decoded, drawn to a canvas, or re-encoded, and the ZIP uses store mode, so
// extracted files are byte-identical to what the server sent.

(() => {
  const CONCURRENCY = 5;
  // Cap per ZIP so a 1000+ image selection never has to fit in memory at once.
  const PART_BYTES = 250 * 1024 * 1024;

  const EXTENSION_BY_TYPE = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/avif': 'avif',
  };

  function extensionFor(contentType, url) {
    const key = (contentType || '').split(';')[0].trim().toLowerCase();
    if (EXTENSION_BY_TYPE[key]) return EXTENSION_BY_TYPE[key];
    try {
      const match = new URL(url, location.href).pathname.match(/\.(png|jpe?g|webp|gif|avif)$/i);
      if (match) return match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase();
    } catch {}
    return 'png';
  }

  // A 200 that isn't an image means an error body (ChatGPT answers 403 + JSON
  // for unauthorized reads). Zipping that would silently produce junk files.
  async function fetchImage(url) {
    const res = await fetch(url, { credentials: 'include' });
    const contentType = res.headers.get('content-type') || '';
    if (!res.ok) {
      let detail = '';
      if (/json/.test(contentType)) {
        try {
          detail = ': ' + JSON.stringify(await res.json()).slice(0, 120);
        } catch {}
      }
      throw new Error(`HTTP ${res.status}${detail}`);
    }
    if (!/^image\//.test(contentType)) {
      throw new Error(`not an image (${contentType.split(';')[0] || 'unknown type'})`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!bytes.length) throw new Error('empty response');
    return { bytes, contentType };
  }

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  const tsvRow = (values) =>
    values.map((v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ')).join('\t');

  const INDEX_HEADER = 'file\tid\tcreated\tsize\tdimensions\tprompt';

  /**
   * @param {{images: Array, baseName: string, onProgress?: Function}} options
   */
  async function grab({ images, baseName, onProgress = () => {} }) {
    const failures = [];
    const parts = [];

    let entries = [];
    let index = [INDEX_HEADER];
    let pendingBytes = 0;
    let done = 0;
    let saved = 0;

    function flush(isFinal) {
      // A part may already have flushed before the last requests failed.
      // Preserve those errors in a final index-only part; it adds zero images.
      if (!entries.length && !(isFinal && saved > 0 && failures.length)) return;
      entries.push({
        name: 'index.tsv',
        bytes: new TextEncoder().encode(index.join('\n') + '\n'),
      });
      const blob = globalThis.ctigBuildZip(entries);
      const single = isFinal && parts.length === 0;
      const filename = single ? `${baseName}.zip` : `${baseName} part${parts.length + 1}.zip`;
      saveBlob(blob, filename);
      parts.push({ filename, bytes: blob.size, files: entries.length - 1 });
      saved += entries.length - 1;
      // Drop references so the next part starts from a clean heap.
      entries = [];
      index = [INDEX_HEADER];
      pendingBytes = 0;
    }

    // Fetch with a small pool, but write into the archive in the chosen order.
    const queue = images.map((image, position) => ({ ...image, position }));
    const results = new Map();
    let nextToWrite = 0;

    function drain() {
      while (nextToWrite < images.length && results.has(nextToWrite)) {
        const item = results.get(nextToWrite);
        results.delete(nextToWrite);
        nextToWrite++;
        if (!item) continue;
        entries.push({ name: item.name, bytes: item.bytes });
        index.push(
          tsvRow([item.name, item.id, item.created, item.bytes.length, item.dimensions, item.prompt])
        );
        pendingBytes += item.bytes.length;
        if (pendingBytes >= PART_BYTES) flush(false);
      }
    }

    async function worker() {
      while (queue.length) {
        const image = queue.shift();
        try {
          const { bytes, contentType } = await fetchImage(image.url);
          results.set(image.position, {
            name: `${image.name}.${extensionFor(contentType, image.url)}`,
            bytes,
            id: image.id,
            created: image.created,
            dimensions: image.dimensions,
            prompt: image.prompt,
          });
        } catch (error) {
          results.set(image.position, null);
          failures.push({ id: image.id, name: image.name, error: String(error.message || error) });
        }
        onProgress({ done: ++done, total: images.length, failed: failures.length });
        drain();
      }
    }

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, images.length) }, worker));
    drain();

    if (failures.length) {
      index.push('', 'Failed:');
      for (const failure of failures) index.push(tsvRow([failure.name, failure.id, failure.error]));
      if (!entries.length && !saved) {
        throw new Error(`All ${failures.length} downloads failed: ${failures[0].error}`);
      }
    }
    flush(true);

    if (!saved) throw new Error('Nothing was saved.');
    return {
      saved,
      failed: failures.length,
      // Callers use this to offer a retry without re-picking everything.
      failures,
      parts,
      bytes: parts.reduce((sum, part) => sum + part.bytes, 0),
    };
  }

  globalThis.ctigGrab = grab;
})();
