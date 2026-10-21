// Minimal ZIP writer, "store" method (no compression).
// PNG/JPEG/WebP payloads are already compressed, so deflate would only cost CPU
// and storing keeps every byte identical to what the server sent.
//
// Classic script on purpose: it shares the isolated-world global with the other
// content scripts, so no module plumbing is needed.

(() => {
  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // DOS date/time, 2-second resolution.
  function dosDateTime(date) {
    return {
      time:
        ((date.getHours() << 11) |
          (date.getMinutes() << 5) |
          (Math.floor(date.getSeconds() / 2) & 0x1f)) &
        0xffff,
      date:
        (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) &
        0xffff,
    };
  }

  /**
   * @param {Array<{name: string, bytes: Uint8Array}>} entries
   * @returns {Blob} a ZIP archive
   */
  function buildZip(entries) {
    const encoder = new TextEncoder();
    const stamp = dosDateTime(new Date());
    const chunks = [];
    let length = 0;

    const push = (bytes) => {
      chunks.push(bytes);
      length += bytes.length;
    };
    const u16 = (v) => push(new Uint8Array([v & 0xff, (v >>> 8) & 0xff]));
    const u32 = (v) =>
      push(new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]));

    const central = [];
    for (const entry of entries) {
      const nameBytes = encoder.encode(entry.name);
      const crc = crc32(entry.bytes);
      const offset = length;

      u32(0x04034b50); // local file header
      u16(20); // version needed
      u16(0x0800); // flags: UTF-8 names
      u16(0); // method: store
      u16(stamp.time);
      u16(stamp.date);
      u32(crc);
      u32(entry.bytes.length); // compressed size
      u32(entry.bytes.length); // uncompressed size
      u16(nameBytes.length);
      u16(0); // extra field length
      push(nameBytes);
      push(entry.bytes);

      central.push({ nameBytes, crc, size: entry.bytes.length, offset });
    }

    const centralStart = length;
    for (const item of central) {
      u32(0x02014b50); // central directory header
      u16(20); // version made by
      u16(20); // version needed
      u16(0x0800);
      u16(0);
      u16(stamp.time);
      u16(stamp.date);
      u32(item.crc);
      u32(item.size);
      u32(item.size);
      u16(item.nameBytes.length);
      u16(0); // extra
      u16(0); // comment
      u16(0); // disk number
      u16(0); // internal attrs
      u32(0); // external attrs
      u32(item.offset);
      push(item.nameBytes);
    }
    const centralSize = length - centralStart;

    u32(0x06054b50); // end of central directory
    u16(0);
    u16(0);
    u16(central.length);
    u16(central.length);
    u32(centralSize);
    u32(centralStart);
    u16(0); // comment length

    return new Blob(chunks, { type: 'application/zip' });
  }

  globalThis.ctigBuildZip = buildZip;
})();
