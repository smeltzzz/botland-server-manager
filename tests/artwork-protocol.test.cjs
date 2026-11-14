const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { parseArtworkUrl, createArtworkHandler } = require('../electron/artwork-protocol.cjs');
const { ArtworkCache } = require('../electron/artwork-cache.cjs');
const { imageMeta } = require('../electron/artwork.cjs');

const jpeg = (tag = 'x', size = 64) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(tag.padEnd(size, '.'))]);

async function temporary(testContext) {
  const root = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp', 'opencode');
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'botland-art-protocol-'));
  testContext.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('artwork URLs accept only known hosts, game ids and kinds', () => {
  assert.deepEqual(parseArtworkUrl('botland-art://artwork/cod4/cover'), { id: 'cod4', kind: 'cover' });
  assert.deepEqual(parseArtworkUrl('botland-art://artwork/bo2/logo?v=2'), { id: 'bo2', kind: 'logo' });
  assert.equal(parseArtworkUrl('botland-art://elsewhere/cod4/cover'), null);
  assert.equal(parseArtworkUrl('botland-art://artwork/cod4/wallpaper'), null);
  assert.equal(parseArtworkUrl('botland-art://artwork/../../../etc/passwd'), null);
  assert.equal(parseArtworkUrl('botland-art://artwork/cod4/cover/extra'), null);
  assert.equal(parseArtworkUrl('https://artwork/cod4/cover'), null);
  assert.equal(parseArtworkUrl('not a url'), null);
});

test('the handler serves bytes with an ETag and revalidates with 304', async t => {
  const dir = await temporary(t);
  const file = path.join(dir, 'cover.jpg');
  await fs.writeFile(file, jpeg('cover'));
  const meta = await imageMeta(file);
  const cache = new ArtworkCache();
  const handler = createArtworkHandler({ getManager: () => ({ artworkMeta: async () => meta }), cache });
  const first = await handler(new Request('botland-art://artwork/cod4/cover'));
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('content-type'), 'image/jpeg');
  assert.equal(first.headers.get('x-content-type-options'), 'nosniff');
  assert.match(first.headers.get('etag'), /^".+"$/);
  assert.deepEqual(Buffer.from(await first.arrayBuffer()), jpeg('cover'));
  const again = await handler(new Request('botland-art://artwork/cod4/cover', { headers: { 'if-none-match': first.headers.get('etag') } }));
  assert.equal(again.status, 304);
  assert.equal(again.body, null);
  const head = await handler(new Request('botland-art://artwork/cod4/cover', { method: 'HEAD' }));
  assert.equal(head.status, 200);
  assert.equal(head.body, null);
});

test('the handler fails closed for unknown art, bad URLs and writes', async () => {
  const cache = new ArtworkCache();
  let asked = null;
  const handler = createArtworkHandler({
    getManager: () => ({ artworkMeta: async (id, kind) => { asked = `${id}/${kind}`; return null; } }),
    cache,
  });
  assert.equal((await handler(new Request('botland-art://artwork/cod4/cover'))).status, 404);
  assert.equal(asked, 'cod4/cover');
  assert.equal((await handler(new Request('botland-art://artwork/cod4/wallpaper'))).status, 404);
  assert.equal((await handler(new Request('botland-art://artwork/../../secret'))).status, 404);
  assert.equal((await handler(new Request('botland-art://artwork/cod4/cover', { method: 'POST' }))).status, 405);
  const notReady = createArtworkHandler({ getManager: () => null, cache });
  assert.equal((await notReady(new Request('botland-art://artwork/cod4/cover'))).status, 503);
  const throwing = createArtworkHandler({ getManager: () => ({ artworkMeta: async () => { throw new Error('Unknown game'); } }), cache });
  assert.equal((await throwing(new Request('botland-art://artwork/nope/cover'))).status, 404);
});

test('the cache keeps encoded bytes, evicts the oldest and falls back to the original', async t => {
  const dir = await temporary(t);
  const first = path.join(dir, 'first.jpg');
  const second = path.join(dir, 'second.jpg');
  await fs.writeFile(first, jpeg('first', 2048));
  await fs.writeFile(second, jpeg('second', 2048));
  let calls = 0;
  const cache = new ArtworkCache({
    limit: 1,
    encode: (buffer, { width }) => { calls++; return { body: Buffer.from(`thumb-${width}`), mime: 'image/jpeg' }; },
  });
  const firstMeta = await imageMeta(first);
  const secondMeta = await imageMeta(second);
  const encoded = await cache.read(firstMeta, 'cover');
  assert.equal(encoded.body.toString(), 'thumb-900');
  assert.equal((await cache.read(firstMeta, 'cover')).body.toString(), 'thumb-900');
  assert.equal(calls, 1, 'a cache hit does not re-encode');
  await cache.read(secondMeta, 'hero');
  assert.equal(cache.entries.size, 1);
  assert.equal((await cache.read(firstMeta, 'cover')).body.toString(), 'thumb-900');
  assert.equal(calls, 3);

  const passthrough = new ArtworkCache({ encode: () => ({ body: Buffer.alloc(4096), mime: 'image/jpeg' }) });
  const original = await passthrough.read(firstMeta, 'logo');
  assert.equal(original.body.length, jpeg('first', 2048).length, 'a larger re-encode is rejected');
  assert.equal(original.mime, 'image/jpeg');
});

test('image validation rejects directories, tiny files and non-images', async t => {
  const dir = await temporary(t);
  const folder = path.join(dir, 'folder.jpg');
  await fs.mkdir(folder);
  assert.equal(await imageMeta(folder), null);
  const tiny = path.join(dir, 'tiny.jpg');
  await fs.writeFile(tiny, Buffer.from([0xff, 0xd8, 0xff]));
  assert.equal(await imageMeta(tiny), null);
  const text = path.join(dir, 'text.jpg');
  await fs.writeFile(text, Buffer.from('this is not an image at all'));
  assert.equal(await imageMeta(text), null);
  assert.equal((await imageMeta(path.join(dir, 'missing.jpg'))), null);
});
