const { createHash } = require('node:crypto');
const { SOURCES } = require('./botwarfare-source.cjs');

const MAX_ARCHIVE_BYTES = 80 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const OFFICIAL_HOSTS = new Set(['api.github.com', 'github.com', 'codeload.github.com']);
const CDN_HOST = 'release-assets.githubusercontent.com';
const REPOS = new Set(Object.values(SOURCES).map(source => source.repo));
const SEGMENT = /^[a-zA-Z0-9._-]+$/u;

function unapproved() { return new Error('Unapproved Bot Warfare download URL or redirect.'); }
function offline() { return new Error('Bot Warfare download unavailable; check your connection and retry.'); }
function timedOut() { return new Error('Bot Warfare download timed out; retry when online.'); }

// Check the *raw* authority and path as well as URL's parsed fields: URL() silently
// removes :443, resolves dot segments, and can reinterpret backslashes as slashes.
function validateUrl(raw, fromReleaseAsset = false) {
  if (typeof raw !== 'string' || raw !== raw.trim() || raw.includes('\\')) throw unapproved();
  const authority = /^https:\/\/([^/?#]+)(?:[/?#]|$)/iu.exec(raw)?.[1];
  if (!authority) throw unapproved();
  let url;
  try { url = new URL(raw); } catch { throw unapproved(); }
  if (authority.toLowerCase() !== url.hostname || url.protocol !== 'https:' || url.port ||
      url.username || url.password || url.hash) throw unapproved();
  if (url.hostname === CDN_HOST) {
    if (!fromReleaseAsset || url.pathname === '/') throw unapproved();
    return { href: url.href, releaseAsset: false };
  }
  if (!OFFICIAL_HOSTS.has(url.hostname) || url.search) throw unapproved();
  const rawPath = raw.slice(8 + authority.length) || '/';
  if (rawPath !== url.pathname || rawPath.includes('%') || rawPath.includes('//')) throw unapproved();
  const parts = rawPath.split('/').slice(1);
  const repo = url.hostname === 'api.github.com' ?
    (parts[0] === 'repos' && parts[1] === 'ineedbots' ? parts[2] : null) :
    (parts[0] === 'ineedbots' ? parts[1] : null);
  if (!REPOS.has(repo)) throw unapproved();
  const tail = parts.slice(url.hostname === 'api.github.com' ? 3 : 2);
  const safe = tail.every(part => SEGMENT.test(part) && part !== '.' && part !== '..');
  if (!safe) throw unapproved();
  const releaseAsset = url.hostname === 'github.com' && tail.length === 4 &&
    tail[0] === 'releases' && tail[1] === 'download' && tail[3].toLowerCase().endsWith('.zip');
  const apiAsset = url.hostname === 'api.github.com' && tail.length === 3 &&
    tail[0] === 'releases' && tail[1] === 'assets' && /^[1-9][0-9]*$/u.test(tail[2]);
  const apiArchive = url.hostname === 'api.github.com' && tail.length === 2 &&
    tail[0] === 'zipball';
  const codeArchive = url.hostname === 'codeload.github.com' && tail.length === 2 &&
    tail[0] === 'zip';
  const webArchive = url.hostname === 'github.com' && tail.length === 2 &&
    tail[0] === 'archive' && tail[1].toLowerCase().endsWith('.zip');
  if (!releaseAsset && !apiAsset && !apiArchive && !codeArchive && !webArchive) throw unapproved();
  return { href: url.href, releaseAsset };
}

function redirectUrl(location, current) {
  if (!location) throw new Error('Invalid Bot Warfare download redirect.');
  try {
    // Preserve the raw spelling of absolute URLs so explicit ports and dot
    // segments cannot be hidden by URL() canonicalization before validation.
    if (/^https?:\/\//iu.test(location)) return location;
    if (location.startsWith('//')) return `https:${location}`;
    return new URL(location, current).href;
  } catch { throw new Error('Invalid Bot Warfare download redirect.'); }
}

function contentLength(response, maxBytes) {
  const raw = response.headers.get('content-length');
  if (raw === null) return null;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error('Invalid Bot Warfare download Content-Length.');
  }
  const length = Number(raw);
  if (length > maxBytes) throw new Error('Bot Warfare download exceeds the size limit.');
  return length;
}

/**
 * Download an official ineedbots ZIP without following unapproved redirects.
 * No URL, signed CDN query, or archive data is written to disk or logged here.
 * @returns {Promise<{bytes: Buffer, sha256: string}>}
 */
async function downloadArchive(url, { fetch: fetcher = globalThis.fetch, expectedHash, maxBytes = MAX_ARCHIVE_BYTES,
  timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof fetcher !== 'function') throw new TypeError('Bot Warfare download fetch must be a function.');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_ARCHIVE_BYTES) {
    throw new RangeError('Bot Warfare download size limit must be between 1 byte and 80 MB.');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new RangeError('Invalid Bot Warfare download timeout.');
  }
  if (expectedHash !== undefined && (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/iu.test(expectedHash))) {
    throw new Error('Invalid Bot Warfare expected SHA-256 hash.');
  }
  let target = validateUrl(url); // Never send a request until the initial URL is approved.
  const controller = new AbortController();
  let reader;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      try { if (reader) Promise.resolve(reader.cancel()).catch(() => {}); }
      catch { /* The timeout still wins if cancellation itself fails. */ }
      reject(timedOut());
    }, timeoutMs);
  });
  const work = (async () => {
    for (let hops = 0; hops <= MAX_REDIRECTS; hops++) {
      let response;
      try {
        response = await fetcher(target.href, { method: 'GET', redirect: 'manual', signal: controller.signal,
          headers: { Accept: 'application/octet-stream', 'User-Agent': 'botLANd-mod-download' } });
      } catch { throw controller.signal.aborted ? timedOut() : offline(); }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (hops === MAX_REDIRECTS) throw new Error('Too many Bot Warfare download redirects.');
        const next = redirectUrl(response.headers.get('location'), target.href);
        target = validateUrl(next, target.releaseAsset);
        continue;
      }
      if (response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')) {
        throw new Error('Bot Warfare download rate-limited by GitHub; retry later.');
      }
      if (response.status !== 200) throw offline();
      const length = contentLength(response, maxBytes);
      if (!response.body || typeof response.body.getReader !== 'function') {
        throw new Error('Unreadable Bot Warfare download response.');
      }
      reader = response.body.getReader();
      const chunks = [];
      const hash = createHash('sha256');
      let size = 0;
      try {
        while (true) {
          let result;
          try { result = await reader.read(); }
          catch { throw controller.signal.aborted ? timedOut() : offline(); }
          if (result.done) break;
          if (!(result.value instanceof Uint8Array)) throw new Error('Unreadable Bot Warfare download response.');
          const chunk = Buffer.from(result.value);
          size += chunk.length;
          if (size > maxBytes || (length !== null && size > length)) {
            throw new Error('Bot Warfare download exceeds the declared or allowed size.');
          }
          hash.update(chunk);
          chunks.push(chunk);
        }
      } finally {
        if (reader) {
          const currentReader = reader;
          reader = undefined;
          if (size > maxBytes || (length !== null && size > length)) await currentReader.cancel().catch(() => {});
          currentReader.releaseLock();
        }
      }
      if (length !== null && size !== length) throw new Error('Truncated Bot Warfare download (Content-Length mismatch).');
      const sha256 = hash.digest('hex');
      if (expectedHash !== undefined && sha256 !== expectedHash.toLowerCase()) {
        throw new Error('Bot Warfare download SHA-256 mismatch: the archive did not match its verified checksum, so nothing was installed. Retry; if it keeps failing, the upstream file may have changed.');
      }
      return { bytes: Buffer.concat(chunks, size), sha256 };
    }
    throw new Error('Too many Bot Warfare download redirects.');
  })();
  try { return await Promise.race([work, timeout]); }
  finally {
    clearTimeout(timer);
    controller.abort();
  }
}

module.exports = { downloadArchive };
