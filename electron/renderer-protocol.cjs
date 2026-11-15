const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');

const rendererScheme = 'app';
const rendererOrigin = 'app://botland';
const rendererEntryUrl = `${rendererOrigin}/index.html`;
const rendererSchemeRegistration = {
  scheme: rendererScheme,
  privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true },
};
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_BUILD_BYTES = 64 * 1024 * 1024;
const MAX_BUILD_FILES = 256;
const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
});

// Vite emits ASCII, URL-safe names. Reject escapes instead of decoding them:
// WHATWG URL parsing otherwise hides literal/encoded dot-segment traversal,
// and Windows additionally treats backslashes, ADS colons and device names as
// paths. Never turn an arbitrary URL pathname into a filesystem lookup.
function builtPath(value) {
  if (value === 'index.html') return value;
  if (!value.startsWith('assets/') || value.length > 1024) return null;
  const segments = value.split('/');
  if (segments.length > 6 || segments.some(segment => !/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(segment)
    || segment.endsWith('.') || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) return null;
  return MIME[path.posix.extname(value).toLowerCase()] ? value : null;
}
function parseRendererUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || [...value].some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)
    || value.includes('\\') || /%00|%5c/i.test(value)) return null;
  // Check the original authority/path before URL's normalization. Exact
  // authority also excludes credentials (even empty ones), ports and aliases.
  const match = /^app:\/\/botland(\/[^?#]*)?(?:\?[^#]*)?(?:#.*)?$/.exec(value);
  if (!match) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'app:' || url.hostname !== 'botland' || url.username || url.password || url.port) return null;
  const pathname = match[1] || '/';
  return builtPath(pathname === '/' ? 'index.html' : pathname.slice(1));
}
function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
async function builtFiles(root) {
  // Electron's fs implementation understands app.asar paths. Do not replace
  // this with file://, net.fetch(file://), or original-fs (which bypasses ASAR).
  const realRoot = await fs.realpath(root);
  const files = new Map();
  let bytes = 0;
  let count = 0;
  let visited = 0;
  async function add(relative) {
    const file = path.join(root, ...relative.split('/'));
    const real = await fs.realpath(file);
    const stat = await fs.lstat(file);
    if (!inside(realRoot, real) || stat.isSymbolicLink() || !stat.isFile()) return;
    if (++count > MAX_BUILD_FILES || stat.size > MAX_FILE_BYTES || (bytes += stat.size) > MAX_BUILD_BYTES) throw new Error('Renderer build exceeds resource limits.');
    files.set(relative, { file, real, size: stat.size });
  }
  await add('index.html');
  async function walk(relative, depth) {
    if (depth > 4) return;
    const directory = path.join(root, ...relative.split('/'));
    const real = await fs.realpath(directory);
    const stat = await fs.lstat(directory);
    if (!inside(realRoot, real) || !stat.isDirectory() || stat.isSymbolicLink()) return;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    if ((visited += entries.length) > MAX_BUILD_FILES) throw new Error('Renderer build exceeds resource limits.');
    for (const entry of entries) {
      const name = `${relative}/${entry.name}`;
      if (entry.isDirectory() && /^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(entry.name)) await walk(name, depth + 1);
      else if (entry.isFile() && builtPath(name)) await add(name);
    }
  }
  try { await walk('assets', 0); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { files, realRoot };
}
async function readBuiltFile(file, size) {
  if (size === 0) return Buffer.alloc(0);
  // Bound the read itself, not only the stat or the eventual response. An
  // unpacked file can grow after stat; never let readFile allocate that growth.
  // Electron's ASAR-aware streams also support these inclusive byte ranges.
  const stream = createReadStream(file, { start: 0, end: size, highWaterMark: 64 * 1024 });
  const chunks = [];
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      bytes += chunk.length;
      if (bytes > size || bytes > MAX_FILE_BYTES) throw new Error('Renderer asset changed during read.');
      chunks.push(chunk);
    }
  } finally { stream.destroy(); }
  if (bytes !== size) throw new Error('Renderer asset changed during read.');
  return Buffer.concat(chunks, bytes);
}
function response(request, status, body, extra = {}) {
  return new Response(request.method === 'HEAD' ? null : body, { status, headers: {
    'content-type': 'text/plain; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-cache',
    'cross-origin-resource-policy': 'same-origin',
    ...extra,
  } });
}
function createRendererHandler({ root = path.join(__dirname, '..', 'dist') } = {}) {
  const buildRoot = path.resolve(root);
  let inventory;
  return async request => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return response(request, 405, 'Method not allowed', { allow: 'GET, HEAD' });
    const relative = parseRendererUrl(request.url);
    if (!relative) return response(request, 404, 'Not found');
    try {
      if (!inventory) {
        const pending = builtFiles(buildRoot);
        inventory = pending;
        // A failed scan (e.g. dist/ not ready yet) must not be cached forever.
        pending.catch(() => { if (inventory === pending) inventory = null; });
      }
      const { files, realRoot } = await inventory;
      const entry = files.get(relative);
      if (!entry) return response(request, 404, 'Not found');
      // Recheck containment and size so an unpacked build cannot later swap an
      // allowlisted file/directory for a link, directory, or unbounded payload.
      const real = await fs.realpath(entry.file);
      const stat = await fs.lstat(entry.file);
      if (real !== entry.real || !inside(realRoot, real) || !stat.isFile() || stat.isSymbolicLink()
        || stat.size > MAX_FILE_BYTES || stat.size !== entry.size) return response(request, 404, 'Not found');
      const headers = { 'content-type': MIME[path.extname(relative).toLowerCase()], 'content-length': String(stat.size) };
      if (request.method === 'HEAD') return response(request, 200, null, headers);
      const body = await readBuiltFile(entry.file, stat.size);
      return response(request, 200, body, headers);
    } catch { return response(request, 404, 'Not found'); }
  };
}

module.exports = { rendererScheme, rendererOrigin, rendererEntryUrl, rendererSchemeRegistration, createRendererHandler, parseRendererUrl, MAX_FILE_BYTES };
