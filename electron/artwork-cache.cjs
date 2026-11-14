const fs = require('node:fs/promises');

// Covers render at roughly 370 CSS px and the game hero at up to about 1100;
// at 2x device pixels these widths are plenty without shipping multi-megabyte
// Steam banners to the renderer.
const widths = { cover: 900, hero: 1600, logo: 0 };

// Reads artwork once, optionally downscales it, and keeps the result as bytes.
// The renderer receives it over `botland-art://`, so no base64 copy crosses IPC.
class ArtworkCache {
  constructor({ encode = null, limit = 16, maxBytes = 32_000_000 } = {}) {
    this.encode = typeof encode === 'function' ? encode : null;
    this.limit = limit;
    this.maxBytes = maxBytes;
    this.entries = new Map();
    this.bytes = 0;
  }
  etagFor(meta, kind) {
    return `"${meta.mtimeMs.toString(36)}-${meta.size.toString(36)}-${kind}"`;
  }
  async read(meta, kind) {
    const etag = this.etagFor(meta, kind);
    const hit = this.entries.get(etag);
    if (hit) {
      // Refresh LRU position.
      this.entries.delete(etag);
      this.entries.set(etag, hit);
      return hit;
    }
    const original = await fs.readFile(meta.file);
    let body = original;
    let mime = meta.mime;
    const width = widths[kind] || 0;
    if (width && this.encode) {
      const encoded = this.encode(original, { mime: meta.mime, width });
      // Re-encoding must actually help; otherwise serve the original bytes.
      if (encoded && encoded.body.length > 0 && encoded.body.length < original.length) {
        body = encoded.body;
        mime = encoded.mime;
      }
    }
    const entry = { body, mime, etag };
    this.entries.set(etag, entry);
    this.bytes += body.length;
    while (this.entries.size > this.limit || (this.bytes > this.maxBytes && this.entries.size > 1)) {
      const oldest = this.entries.keys().next().value;
      const removed = this.entries.get(oldest);
      this.entries.delete(oldest);
      this.bytes -= removed.body.length;
    }
    return entry;
  }
}

module.exports = { ArtworkCache, widths };
