const artScheme = 'botland-art';
const kinds = new Set(['cover', 'hero', 'logo']);

// URL shape: botland-art://artwork/<game>/<kind>
// Nothing from the URL is used as a path. The manager resolves the game and
// kind against its own profile/settings state, so the scheme cannot be pointed
// at an arbitrary file.
function parseArtworkUrl(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== `${artScheme}:` || url.hostname !== 'artwork') return null;
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length !== 2) return null;
  const [id, kind] = segments;
  if (!/^[a-z0-9]{2,8}$/.test(id) || !kinds.has(kind)) return null;
  return { id, kind };
}

function text(body, status, extra = {}) {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...extra } });
}

function createArtworkHandler({ getManager, cache }) {
  return async request => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return text('Method not allowed', 405, { allow: 'GET, HEAD' });
    const manager = getManager();
    if (!manager) return text('Not ready', 503);
    const parsed = parseArtworkUrl(request.url);
    if (!parsed) return text('Not found', 404);
    let meta;
    try { meta = await manager.artworkMeta(parsed.id, parsed.kind); } catch { return text('Not found', 404); }
    if (!meta) return text('Not found', 404);
    let entry;
    try { entry = await cache.read(meta, parsed.kind); } catch { return text('Not found', 404); }
    const headers = {
      'content-type': entry.mime,
      'cache-control': 'no-cache',
      etag: entry.etag,
      'x-content-type-options': 'nosniff',
    };
    if (request.headers.get('if-none-match') === entry.etag) return new Response(null, { status: 304, headers });
    return new Response(request.method === 'HEAD' ? null : entry.body, { status: 200, headers });
  };
}

module.exports = { artScheme, kinds, parseArtworkUrl, createArtworkHandler };
