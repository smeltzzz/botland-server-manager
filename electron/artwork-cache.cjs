const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { MAX_ARTWORK_BYTES } = require('./artwork.cjs');

// Covers render at roughly 370 CSS px and the game hero at up to about 1100;
// at 2x device pixels these widths are plenty without shipping multi-megabyte
// Steam banners to the renderer.
const widths = { cover: 900, hero: 1600, logo: 0 };

function validMeta(meta, kind) {
  if (!meta || typeof meta.file !== 'string' || !meta.file || !Object.hasOwn(widths, kind) ||
      !Number.isSafeInteger(meta.size) || meta.size < 0 || meta.size > MAX_ARTWORK_BYTES ||
      !Number.isFinite(meta.mtimeMs) || (meta.ctimeMs !== undefined && !Number.isFinite(meta.ctimeMs))) {
    throw new Error('Artwork is not a bounded image.');
  }
}
function matches(stat, meta) {
  return stat.isFile() && stat.size === meta.size && stat.mtimeMs === meta.mtimeMs &&
    (meta.ctimeMs === undefined || stat.ctimeMs === meta.ctimeMs);
}
async function boundedRead(file, meta) {
  const handle = await fs.open(file, 'r');
  try {
    if (!matches(await handle.stat(), meta)) throw new Error('Artwork changed before reading.');
    const body = Buffer.alloc(meta.size);
    let position = 0;
    while (position < body.length) {
      const { bytesRead } = await handle.read(body, position, body.length - position, position);
      if (!bytesRead) throw new Error('Artwork changed while reading.');
      position += bytesRead;
    }
    // readFile() can grow its allocation indefinitely when a file grows after
    // stat(). At most the approved size plus this one-byte probe is read here.
    const extra = await handle.read(Buffer.alloc(1), 0, 1, position);
    if (extra.bytesRead || !matches(await handle.stat(), meta)) throw new Error('Artwork changed while reading.');
    return body;
  } finally { await handle.close(); }
}

// Reads artwork once, optionally downscales it, and keeps the result as bytes.
// The renderer receives it over `botland-art://`, so no base64 copy crosses IPC.
class ArtworkCache {
  constructor({ encode = null, limit = 16, maxBytes = 32_000_000 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new RangeError('Artwork cache limits must be non-negative integers.');
    }
    this.encode = typeof encode === 'function' ? encode : null;
    this.limit = limit;
    this.maxBytes = maxBytes;
    this.entries = new Map();
    this.pending = new Map();
    this.bytes = 0;
  }
  etagFor(meta, kind) {
    validMeta(meta, kind);
    // imageMeta/read supply a realpath. Hash it rather than exposing private
    // Steam/custom-image paths in HTTP headers. Size/time alone collide across
    // games and when the user switches between otherwise identical sources.
    const source = path.resolve(meta.file);
    const key = JSON.stringify([source, meta.mtimeMs, meta.ctimeMs ?? null, meta.size, meta.mime, kind]);
    return `"${createHash('sha256').update(key).digest('hex')}"`;
  }
  async read(meta, kind) {
    validMeta(meta, kind);
    const file = await fs.realpath(meta.file);
    const etag = this.etagFor({ ...meta, file }, kind);
    const hit = this.entries.get(etag);
    if (hit) {
      // Refresh LRU position without changing the byte count.
      this.entries.delete(etag);
      this.entries.set(etag, hit);
      return hit;
    }
    let pending = this.pending.get(etag);
    if (!pending) {
      pending = this.#load({ ...meta, file }, kind, etag);
      this.pending.set(etag, pending);
      pending.finally(() => { if (this.pending.get(etag) === pending) this.pending.delete(etag); }).catch(() => {});
    }
    return pending;
  }
  async #load(meta, kind, etag) {
    const original = await boundedRead(meta.file, meta);
    let body = original;
    let mime = meta.mime;
    const width = widths[kind];
    if (width && this.encode) {
      const encoded = this.encode(original, { mime: meta.mime, width });
      // Re-encoding must actually help; otherwise serve the original bytes.
      if (encoded && Buffer.isBuffer(encoded.body) && encoded.body.length > 0 && encoded.body.length < original.length) {
        body = encoded.body;
        mime = encoded.mime;
      }
    }
    const entry = { body, mime, etag };
    // An oversized entry may be served but must not defeat the cache budget.
    if (!this.limit || body.length > this.maxBytes) return entry;
    const previous = this.entries.get(etag);
    if (previous) {
      this.entries.delete(etag);
      this.bytes -= previous.body.length;
    }
    this.entries.set(etag, entry);
    this.bytes += body.length;
    while (this.entries.size > this.limit || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      const removed = this.entries.get(oldest);
      this.entries.delete(oldest);
      this.bytes -= removed.body.length;
    }
    return entry;
  }
}

module.exports = { ArtworkCache, widths };
