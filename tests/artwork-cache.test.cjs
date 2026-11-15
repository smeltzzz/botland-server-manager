const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { ArtworkCache } = require('../electron/artwork-cache.cjs');
const { imageMeta, MAX_ARTWORK_BYTES } = require('../electron/artwork.cjs');
const { createArtworkHandler } = require('../electron/artwork-protocol.cjs');

const jpeg = tag => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(tag.padEnd(64, '.'))]);
async function temporary(t) {
  const root = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp', 'opencode');
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'sweep21-art-cache-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function image(dir, name) {
  const file = path.join(dir, name + '.jpg');
  await fs.writeFile(file, jpeg(name));
  return imageMeta(file);
}
function accounting(cache) {
  assert.equal(cache.bytes, [...cache.entries.values()].reduce((sum, entry) => sum + entry.body.length, 0));
  assert.ok(cache.bytes >= 0 && cache.bytes <= cache.maxBytes);
  assert.ok(cache.entries.size <= cache.limit);
}

test('same-size, same-time sources never share cached artwork or conditional ETags', async t => {
  const dir = await temporary(t);
  const first = await image(dir, 'first-private-source');
  const second = await image(dir, 'other-private-source');
  const timestamp = new Date('2024-01-02T03:04:05Z');
  await fs.utimes(first.file, timestamp, timestamp);
  await fs.utimes(second.file, timestamp, timestamp);
  const a = await imageMeta(first.file);
  const b = await imageMeta(second.file);
  assert.equal(a.size, b.size);
  assert.equal(a.mtimeMs, b.mtimeMs);
  const cache = new ArtworkCache();
  // Even every other field being identical cannot replace source identity.
  assert.notEqual(cache.etagFor(a, 'cover'), cache.etagFor({ ...a, file: b.file }, 'cover'));
  const handler = createArtworkHandler({ cache,
    getManager: () => ({ artworkMeta: async id => id === 'cod4' ? a : b }) });
  const one = await handler(new Request('botland-art://artwork/cod4/cover'));
  const two = await handler(new Request('botland-art://artwork/mw2/cover', { headers: { 'if-none-match': one.headers.get('etag') } }));
  assert.equal(two.status, 200, 'a different source must not receive 304 for the first source');
  assert.deepEqual(Buffer.from(await one.arrayBuffer()), jpeg('first-private-source'));
  assert.deepEqual(Buffer.from(await two.arrayBuffer()), jpeg('other-private-source'));
  assert.notEqual(one.headers.get('etag'), two.headers.get('etag'));
  assert.match(one.headers.get('etag'), /^"[a-f0-9]{64}"$/u, 'no path or filename is exposed');
  assert.equal(cache.entries.size, 2);
  accounting(cache);
});

test('canonical aliases deduplicate to one source identity', async t => {
  const dir = await temporary(t);
  const meta = await image(dir, 'canonical');
  const alias = path.join(dir, 'alias');
  try { await fs.symlink(dir, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('Symlinks unavailable.'); return; } throw error; }
  const throughAlias = await imageMeta(path.join(alias, 'canonical.jpg'));
  assert.equal(throughAlias.file, await fs.realpath(meta.file));
  let calls = 0;
  const cache = new ArtworkCache({ encode: () => { calls++; return { body: Buffer.from('small'), mime: 'image/jpeg' }; } });
  const [one, two] = await Promise.all([cache.read(meta, 'cover'), cache.read(throughAlias, 'cover')]);
  assert.equal(one, two);
  assert.equal(calls, 1);
  accounting(cache);
});

test('concurrent same-key misses perform one read/encode and count retained bytes exactly once', async t => {
  const dir = await temporary(t);
  const meta = await image(dir, 'concurrent');
  const open = fs.open;
  let opens = 0;
  let calls = 0;
  t.mock.method(fs, 'realpath', async file => file);
  t.mock.method(fs, 'open', async (...args) => { opens++; return open(...args); });
  const cache = new ArtworkCache({ encode: () => { calls++; return { body: Buffer.from('small'), mime: 'image/jpeg' }; } });
  const entries = await Promise.all(Array.from({ length: 40 }, () => cache.read(meta, 'cover')));
  assert.equal(new Set(entries).size, 1);
  assert.equal(opens, 1);
  assert.equal(calls, 1);
  assert.equal(cache.bytes, 5, 'the old race retained 5 bytes but reported 10 or more');
  assert.equal(cache.pending.size, 0);
  assert.equal(await cache.read(meta, 'cover'), entries[0]);
  assert.equal(opens, 1, 'a hit does not read the image again');
  accounting(cache);
});

test('LRU hits, concurrent loads, byte evictions and oversized bypasses keep exact accounting', async t => {
  const dir = await temporary(t);
  const metas = await Promise.all(['one', 'two', 'three', 'four'].map(name => image(dir, name)));
  const cache = new ArtworkCache({ limit: 3, maxBytes: 10,
    encode: () => ({ body: Buffer.from('small'), mime: 'image/jpeg' }) });
  const one = await cache.read(metas[0], 'cover');
  const two = await cache.read(metas[1], 'cover');
  assert.equal(cache.bytes, 10);
  await cache.read(metas[0], 'cover');
  const three = await cache.read(metas[2], 'cover');
  assert.deepEqual([...cache.entries.values()], [one, three], 'refreshing one evicts two instead');
  assert.equal(cache.entries.has(two.etag), false);
  accounting(cache);
  await Promise.all(Array.from({ length: 10 }, () => cache.read(metas[3], 'cover')));
  assert.equal(cache.bytes, 10);
  assert.equal(cache.entries.size, 2);
  accounting(cache);
  const oneEntry = new ArtworkCache({ limit: 1, maxBytes: 10,
    encode: () => ({ body: Buffer.from('small'), mime: 'image/jpeg' }) });
  await Promise.all(metas.map(meta => oneEntry.read(meta, 'cover')));
  assert.equal(oneEntry.bytes, 5);
  accounting(oneEntry);
  for (const settings of [{ limit: 0 }, { maxBytes: 0 }, { maxBytes: 4 }]) {
    const bypass = new ArtworkCache({ ...settings,
      encode: () => ({ body: Buffer.from('small'), mime: 'image/jpeg' }) });
    assert.equal((await bypass.read(metas[0], 'cover')).body.toString(), 'small');
    assert.equal(bypass.entries.size, 0);
    accounting(bypass);
  }
});

test('a failed shared load leaves no entry, byte debt or poisoned pending promise', async t => {
  const dir = await temporary(t);
  const meta = await image(dir, 'retry');
  t.mock.method(fs, 'realpath', async file => file);
  let calls = 0;
  const cache = new ArtworkCache({ encode: () => { calls++; throw new Error('synthetic encode failure'); } });
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => cache.read(meta, 'cover')));
  assert.ok(results.every(result => result.status === 'rejected' && /synthetic encode failure/u.test(result.reason.message)));
  assert.equal(calls, 1);
  assert.equal(cache.pending.size, 0);
  assert.equal(cache.entries.size, 0);
  accounting(cache);
  cache.encode = () => ({ body: Buffer.from('small'), mime: 'image/jpeg' });
  assert.equal((await cache.read(meta, 'cover')).body.toString(), 'small');
  accounting(cache);
});

test('reads reject stale, oversized and growing sources and always close the bounded file handle', async t => {
  const dir = await temporary(t);
  const meta = await image(dir, 'growing');
  const cache = new ArtworkCache();
  await assert.rejects(cache.read({ ...meta, size: MAX_ARTWORK_BYTES + 1 }, 'cover'), /bounded image/u);
  const open = fs.open;
  let grew = false;
  let requested = 0;
  let closed = 0;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args);
    const read = handle.read.bind(handle);
    const close = handle.close.bind(handle);
    handle.read = async (...readArgs) => {
      requested += readArgs[2];
      const result = await read(...readArgs);
      if (!grew) {
        grew = true;
        await fs.appendFile(meta.file, Buffer.alloc(MAX_ARTWORK_BYTES));
      }
      return result;
    };
    handle.close = async () => { closed++; return close(); };
    return handle;
  });
  await assert.rejects(cache.read(meta, 'cover'), /changed while reading/u);
  assert.equal(requested, meta.size + 1, 'growth does not trigger unbounded readFile allocation');
  assert.equal(closed, 1);
  assert.equal(cache.pending.size, 0);
  accounting(cache);
  t.mock.restoreAll();
  assert.equal(await imageMeta(meta.file), null, 'the grown source is too large for metadata discovery too');
  await fs.writeFile(meta.file, jpeg('shorter now'));
  await assert.rejects(cache.read({ ...meta, size: meta.size - 1 }, 'cover'), /changed before reading/u);
  await cache.read(await imageMeta(meta.file), 'cover');
  accounting(cache);
});
