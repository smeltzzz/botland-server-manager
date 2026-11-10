const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { BotWarfareSource, SOURCES, approvedUrl, CACHE_AGE_MS, MAX_RESPONSE_BYTES } = require('../electron/botwarfare-source.cjs');

async function fixture(run) {
  const root = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp', 'opencode');
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'botland-sources-'));
  try { await run(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

function release(id, tag = SOURCES[id].tag, asset = SOURCES[id].asset, notes = 'Release notes') {
  const repo = SOURCES[id].repo;
  return { tag_name: tag, body: notes, assets: [{ name: asset,
    browser_download_url: `https://github.com/ineedbots/${repo}/releases/download/${tag}/${asset}` }] };
}
function json(data, headers = {}) {
  return new Response(JSON.stringify(data), { status: 200, headers });
}
function mockFetch(handler) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'manual');
    assert.equal(new URL(url).hostname, 'api.github.com');
    return handler(url, options);
  };
  return { fetch, calls };
}

test('six exact upstream sources, verified stable release assets and pinned T6 source', async () => fixture(async dir => {
  assert.deepEqual(Object.keys(SOURCES).sort(), ['bo1', 'bo2', 'cod4', 'mw2', 'mw3', 'waw']);
  const { fetch, calls } = mockFetch(url => {
    const id = Object.keys(SOURCES).find(key => url.includes(`/${SOURCES[key].repo}/`));
    return json(id === 'bo2' ? { sha: 'a'.repeat(40), commit: { message: 'master notes' } } : release(id));
  });
  const source = new BotWarfareSource({ userData: dir, fetch, now: () => 1000000 });
  for (const id of Object.keys(SOURCES)) {
    const resolved = await source.resolveSource(id);
    assert.equal(resolved.supported, true);
    assert.equal(resolved.repo, `https://github.com/ineedbots/${SOURCES[id].repo}`);
    assert.equal(resolved.refType, id === 'bo2' ? 'commit' : 'tag');
    assert.equal(resolved.expectedHash, SOURCES[id].sha256);
    if (id === 'bo2') {
      assert.equal(resolved.ref, 'cafee7d585160b046dc928f90798a611683e6cd1');
      assert.equal(resolved.assetUrl, `https://codeload.github.com/ineedbots/t6_bot_warfare/zip/${resolved.ref}`);
    } else {
      assert.equal(resolved.ref, SOURCES[id].tag);
      assert.equal(resolved.assetUrl,
        `https://github.com/ineedbots/${SOURCES[id].repo}/releases/download/${SOURCES[id].tag}/${SOURCES[id].asset}`);
    }
  }
  assert.equal(calls.length, 6);
  assert.ok(calls.every(call => !call.url.includes('?') && call.options.headers['User-Agent']));
  const cache = JSON.parse(await fs.readFile(path.join(dir, 'botwarfare-sources.json'), 'utf8'));
  assert.deepEqual(Object.keys(cache.sources).sort(), Object.keys(SOURCES).sort());
  assert.equal(cache.version, 1);
}));

test('ETags, 304 and 18-hour cache throttle; force bypasses freshness', async () => fixture(async dir => {
  let now = 2000000;
  let step = 0;
  const { fetch, calls } = mockFetch((url, options) => {
    step++;
    if (step === 1) return json(release('cod4'), { etag: '"release-1"' });
    assert.equal(options.headers['If-None-Match'], '"release-1"');
    return new Response(null, { status: 304, headers: { etag: '"release-1"' } });
  });
  const source = new BotWarfareSource({ userData: dir, fetch, now: () => now });
  assert.equal((await source.resolveSource('cod4')).status, 'current');
  assert.equal((await source.resolveSource('cod4')).status, 'cached');
  now += CACHE_AGE_MS - 1;
  assert.equal((await source.resolveSource('cod4')).status, 'cached');
  now++;
  assert.equal((await source.resolveSource('cod4')).status, 'not-modified');
  assert.equal((await source.resolveSource('cod4', 'stable', { force: true })).status, 'not-modified');
  assert.equal(calls.length, 3);
  assert.equal((await new BotWarfareSource({ userData: dir, fetch, now: () => now }).resolveSource('cod4')).status, 'cached');
}));

test('CoD4 development resolves only a verified master SHA to a commit-pinned archive', async () => fixture(async dir => {
  const sha = 'a'.repeat(40);
  const { fetch, calls } = mockFetch(() => json({ sha, commit: { message: 'Source build' } }));
  const source = new BotWarfareSource({ userData: dir, fetch, now: () => 1000000 });
  const development = await source.resolveSource('cod4', 'development');
  assert.equal(calls[0].url, 'https://api.github.com/repos/ineedbots/iw3_bot_warfare/commits/master');
  assert.equal(development.supported, true);
  assert.equal(development.status, 'current');
  assert.equal(development.refType, 'commit');
  assert.equal(development.ref, sha);
  assert.equal(development.commit, sha);
  assert.equal(development.assetUrl, `https://codeload.github.com/ineedbots/iw3_bot_warfare/zip/${sha}`);
  assert.equal(development.notes, 'Source build');

  const stable = await source.resolveSource('cod4');
  assert.equal(calls[1].url, 'https://api.github.com/repos/ineedbots/iw3_bot_warfare/releases/latest');
  assert.equal(stable.refType, 'tag');
  assert.equal(stable.ref, SOURCES.cod4.tag);
  assert.equal(stable.assetUrl, 'https://github.com/ineedbots/iw3_bot_warfare/releases/download/v2.2.0/iw3bw220.zip');
}));

test('CoD4 development has an independent persisted 18-hour cache and ETag', async () => fixture(async dir => {
  let now = 2000000;
  const sha = 'b'.repeat(40);
  const { fetch, calls } = mockFetch((url, options) => {
    if (url.endsWith('/commits/master')) {
      if (options.headers['If-None-Match']) {
        assert.equal(options.headers['If-None-Match'], '"commit-etag"');
        return new Response(null, { status: 304, headers: { etag: '"commit-etag"' } });
      }
      return json({ sha }, { etag: '"commit-etag"' });
    }
    if (options.headers['If-None-Match']) {
      assert.equal(options.headers['If-None-Match'], '"release-etag"');
      return new Response(null, { status: 304 });
    }
    return json(release('cod4'), { etag: '"release-etag"' });
  });
  const source = new BotWarfareSource({ userData: dir, fetch, now: () => now });
  assert.equal((await source.resolveSource('cod4')).status, 'current');
  now += CACHE_AGE_MS - 1;
  assert.equal((await source.resolveSource('cod4', 'development')).status, 'current');
  assert.equal((await source.resolveSource('cod4')).status, 'cached');
  now++;
  assert.equal((await source.resolveSource('cod4')).status, 'not-modified');
  assert.equal((await source.resolveSource('cod4', 'development')).status, 'cached');
  const reloaded = new BotWarfareSource({ userData: dir, fetch, now: () => now });
  assert.equal((await reloaded.resolveSource('cod4', 'development')).ref, sha);
  now += CACHE_AGE_MS;
  assert.equal((await reloaded.resolveSource('cod4', 'development')).status, 'not-modified');
  assert.equal((await reloaded.resolveSource('cod4', 'development', { force: true })).status, 'not-modified');
  assert.equal(calls.length, 5);
  const cache = JSON.parse(await fs.readFile(path.join(dir, 'botwarfare-sources.json'), 'utf8'));
  assert.equal(cache.sources.cod4.etag, '"release-etag"');
  assert.equal(cache.sources['cod4-development'].etag, '"commit-etag"');
  assert.equal(cache.sources['cod4-development'].record.commit, sha);
}));

test('update availability follows installed manifest channel and tag/commit, not missing installs', async () => fixture(async dir => {
  const { fetch } = mockFetch(url => {
    const id = Object.keys(SOURCES).find(key => url.includes(`/${SOURCES[key].repo}/`));
    if (id === 'bo2' || id === 'cod4' && url.endsWith('/commits/master')) {
      return json({ sha: 'b'.repeat(40) });
    }
    return json(release(id, id === 'mw2' ? 'v2.4.0' : SOURCES[id].tag,
      id === 'mw2' ? 'iw4bw240.zip' : SOURCES[id].asset));
  });
  const source = new BotWarfareSource({ userData: dir, fetch });
  const updates = await source.checkUpdates({ installed: {
    mw2: { channel: 'stable', tag: 'v2.3.0' },
    bo1: { channel: 'stable', tag: 'v9.0.0' },
    bo2: { channel: 'stable', commit: SOURCES.bo2.commit },
    cod4: { channel: 'development', commit: 'a'.repeat(40) },
  } });
  assert.equal(updates.mw2.updateAvailable, true);
  assert.equal(updates.bo1.updateAvailable, false);
  assert.equal(updates.bo2.updateAvailable, false);
  assert.equal(updates.cod4.updateAvailable, true);
  assert.deepEqual(updates.cod4.latest, { tag: 'v2.2.0', developmentCommit: 'b'.repeat(40) });
  assert.equal(updates.waw.updateAvailable, null);
  assert.equal((await source.resolveSource('mw2')).assetUrl,
    'https://github.com/ineedbots/iw4_bot_warfare/releases/download/v2.4.0/iw4bw240.zip');
  assert.equal((await source.resolveSource('mw2')).expectedHash, null);
  assert.equal((await source.checkUpdates({ installed: { mw2: { channel: 'stable', refType: 'tag', ref: 'v2.3.0' } } })).mw2.updateAvailable, true);
  assert.equal((await source.checkUpdates({ installed: { bo2: { channel: 'development', commit: 'a'.repeat(40) } } })).bo2.updateAvailable, true);
}));

test('CoD4 development fails closed offline or on invalid SHA; a cached commit survives outages', async () => fixture(async dir => {
  let mode = 'offline';
  const { fetch } = mockFetch(url => {
    if (url.endsWith('/releases/latest')) return json(release('cod4'));
    if (mode === 'offline') throw new Error('offline');
    if (mode === 'invalid') return json({ sha: 'not-a-commit', commit: { message: 'untrusted' } });
    return json({ sha: 'c'.repeat(40) });
  });
  const source = new BotWarfareSource({ userData: dir, fetch });
  const missing = await source.resolveSource('cod4', 'development');
  assert.equal(missing.status, 'offline');
  assert.equal(missing.supported, false);
  assert.equal(missing.assetUrl, null);
  mode = 'invalid';
  assert.equal((await source.resolveSource('cod4', 'development', { force: true })).status, 'unsupported');
  assert.equal((await source.resolveSource('cod4', 'development')).supported, false);
  mode = 'valid';
  assert.equal((await source.resolveSource('cod4', 'development', { force: true })).ref, 'c'.repeat(40));
  mode = 'offline';
  const retained = await source.resolveSource('cod4', 'development', { force: true });
  assert.equal(retained.status, 'offline');
  assert.equal(retained.ref, 'c'.repeat(40));
  assert.equal((await source.resolveSource('cod4')).ref, SOURCES.cod4.tag);
}));

test('CoD4 development badge compares only installed commits and never mutates stable metadata', async () => fixture(async dir => {
  const sha = 'd'.repeat(40);
  const { fetch, calls } = mockFetch(url => url.endsWith('/commits/master') ?
    json({ sha }) : json(release(Object.keys(SOURCES).find(id => url.includes(`/${SOURCES[id].repo}/`)))));
  const source = new BotWarfareSource({ userData: dir, fetch });
  const older = await source.checkUpdates({ installed: { cod4: { channel: 'development', commit: 'a'.repeat(40) } } });
  assert.equal(older.cod4.updateAvailable, true);
  assert.deepEqual(older.cod4.latest, { tag: SOURCES.cod4.tag, developmentCommit: sha });
  const current = await source.checkUpdates({ installed: { cod4: { channel: 'development', commit: sha } } });
  assert.equal(current.cod4.updateAvailable, false);
  assert.equal((await source.checkUpdates({ installed: { cod4: { channel: 'development', commit: 'bad' } } })).cod4.updateAvailable, null);
  assert.equal((await source.checkUpdates({ installed: { cod4: { channel: 'stable', tag: 'v2.2.0' } } })).cod4.updateAvailable, false);
  assert.equal((await source.checkUpdates()).cod4.updateAvailable, null);
  assert.equal(calls.length, 7);
}));

test('an unavailable CoD4 master cannot claim a development update from its stable release', async () => fixture(async dir => {
  const { fetch } = mockFetch(url => {
    if (url.includes('/iw3_bot_warfare/commits/master')) throw new Error('offline');
    if (url.endsWith('/commits/master')) return json({ sha: 'a'.repeat(40) });
    return json(release(Object.keys(SOURCES).find(id => url.includes(`/${SOURCES[id].repo}/`))));
  });
  const source = new BotWarfareSource({ userData: dir, fetch });
  const updates = await source.checkUpdates({ installed: {
    cod4: { channel: 'development', commit: 'b'.repeat(40) },
  } });
  assert.equal(updates.cod4.status, 'offline');
  assert.equal(updates.cod4.latest.tag, SOURCES.cod4.tag);
  assert.equal(updates.cod4.latest.developmentCommit, null);
  assert.equal(updates.cod4.updateAvailable, null);
  assert.equal((await source.resolveSource('cod4', 'stable')).supported, true);
  assert.equal((await source.resolveSource('cod4', 'development')).supported, false);
}));

test('development source is disabled for unverified titles; T6 requires a verified master commit', async () => fixture(async dir => {
  const { fetch } = mockFetch(() => { throw new Error('offline'); });
  const source = new BotWarfareSource({ userData: dir, fetch });
  for (const id of ['mw2', 'mw3', 'waw', 'bo1']) {
    const unsupported = await source.resolveSource(id, 'development');
    assert.equal(unsupported.supported, false, id);
    assert.equal(unsupported.assetUrl, null, id);
  }
  const unavailable = await source.resolveSource('bo2', 'development');
  assert.equal(unavailable.supported, false);
  assert.equal(unavailable.assetUrl, null);
  assert.equal(unavailable.status, 'offline');
  assert.equal((await source.resolveSource('bo2', 'stable')).ref, SOURCES.bo2.commit);
  const online = new BotWarfareSource({ userData: dir, fetch: async () => json({ sha: 'b'.repeat(40) }) });
  const development = await online.resolveSource('bo2', 'development', { force: true });
  assert.equal(development.supported, true);
  assert.equal(development.ref, 'b'.repeat(40));
  assert.equal(development.assetUrl, `https://codeload.github.com/ineedbots/t6_bot_warfare/zip/${'b'.repeat(40)}`);
  assert.notEqual(development.ref, (await online.resolveSource('bo2', 'stable')).ref);
}));

test('host restrictions and redirects never send requests to another origin', async () => fixture(async dir => {
  for (const url of ['http://api.github.com/a', 'https://api.github.com.evil.test/a',
    'https://user:pass@github.com/a', 'https://github.com:8443/a',
    'https://codeload.github.com/a#fragment']) assert.throws(() => approvedUrl(url), /Unapproved/);
  let calls = 0;
  const source = new BotWarfareSource({ userData: dir, fetch: async (url, options) => {
    calls++;
    assert.equal(options.redirect, 'manual');
    return new Response(null, { status: 302, headers: { location: 'https://evil.test/steal' } });
  } });
  assert.equal((await source.resolveSource('waw')).status, 'offline');
  assert.equal((await source.resolveSource('cod4', 'development')).supported, false);
  assert.equal(calls, 2);
  assert.equal((await source.resolveSource('waw')).status, 'cached');
}));

test('oversized, malformed and untrusted upstream data fail closed without storing URLs or secrets', async () => fixture(async dir => {
  const secret = 'fixture';
  const source = new BotWarfareSource({ userData: dir, fetch: async () =>
    new Response('x'.repeat(MAX_RESPONSE_BYTES + 1), { status: 200 }) });
  assert.equal((await source.resolveSource('cod4')).status, 'offline');
  const bad = new BotWarfareSource({ userData: dir, fetch: async () => json({
    ...release('cod4'), body: `note ${secret}`, assets: [{ name: 'iw3bw220.zip',
      browser_download_url: `https://evil.test/${secret}` }],
  }) });
  assert.equal((await bad.resolveSource('cod4', 'stable', { force: true })).status, 'unsupported');
  assert.equal((await bad.resolveSource('cod4')).assetUrl.includes(secret), false);
  const cache = await fs.readFile(path.join(dir, 'botwarfare-sources.json'), 'utf8');
  assert.equal(cache.includes(secret), false);
  assert.equal(cache.includes('evil.test'), false);
}));

test('failed checks retry after a short backoff instead of caching the failure for hours', async () => fixture(async dir => {
  let clock = 1_000_000_000;
  let online = false;
  let calls = 0;
  const source = new BotWarfareSource({ userData: dir, now: () => clock, fetch: async () => {
    calls++;
    if (!online) throw new Error('offline');
    return json(release('bo1'));
  } });
  assert.equal((await source.resolveSource('bo1')).status, 'offline');
  clock += 5 * 60 * 1000;
  assert.equal((await source.resolveSource('bo1')).status, 'cached');
  assert.equal(calls, 1);
  online = true;
  clock += 6 * 60 * 1000;
  assert.equal((await source.resolveSource('bo1')).status, 'current');
  assert.equal(calls, 2);
  online = false;
  clock += 60 * 60 * 1000;
  assert.equal((await source.resolveSource('bo1')).status, 'cached');
  assert.equal(calls, 2);
}));

test('rate limits and network failures are nonfatal and retain last known metadata', async () => fixture(async dir => {
  let step = 0;
  const source = new BotWarfareSource({ userData: dir, fetch: async () => {
    step++;
    if (step === 1) return json(release('bo1'), { etag: '"valid"' });
    if (step === 2) return new Response(null, { status: 403, headers: { 'x-ratelimit-remaining': '0' } });
    throw new Error('offline');
  } });
  assert.equal((await source.resolveSource('bo1')).status, 'current');
  const limited = await source.resolveSource('bo1', 'stable', { force: true });
  assert.equal(limited.status, 'rate-limited');
  assert.equal(limited.tag, 'v1.1.1');
  const offline = await source.resolveSource('bo1', 'stable', { force: true });
  assert.equal(offline.status, 'offline');
  assert.equal(offline.assetUrl, limited.assetUrl);
  assert.equal(step, 3);
}));

test('refuses non-userData relative paths and invalid inputs before making requests', async () => fixture(async dir => {
  assert.throws(() => new BotWarfareSource({ userData: 'relative' }), /Absolute/);
  const source = new BotWarfareSource({ userData: dir, fetch: () => { throw new Error('should not fetch'); } });
  await assert.rejects(source.resolveSource('../cod4'), /Unknown/);
  await assert.rejects(source.resolveSource('cod4', 'nightly'), /Unknown/);
  await assert.rejects(fs.stat(path.join(dir, 'botwarfare-sources.json')), { code: 'ENOENT' });
}));
