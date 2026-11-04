const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { downloadArchive } = require('../electron/botwarfare-download.cjs');

const release = 'https://github.com/ineedbots/iw3_bot_warfare/releases/download/v2.2.0/iw3bw220.zip';
const archive = 'https://codeload.github.com/ineedbots/t6_bot_warfare/zip/cafee7d585160b046dc928f90798a611683e6cd1';
const signed = 'https://release-assets.githubusercontent.com/github-production-release-asset/123/file?token=SYNTHETIC_SECRET';
const payload = Buffer.from([0, 1, 2, 127, 128, 255]);
const digest = createHash('sha256').update(payload).digest('hex');

function stream(chunks = [payload]) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}
function ok(chunks = [payload], headers = {}) {
  return new Response(stream(chunks), { status: 200, headers });
}
function redirect(location, status = 302) {
  return new Response(null, { status, headers: { location } });
}
function mock(responses) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.redirect, 'manual');
    assert.equal(options.method, 'GET');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.headers.Accept, 'application/octet-stream');
    const next = responses.shift();
    assert.ok(next, 'unexpected fetch');
    return typeof next === 'function' ? next(url, options) : next;
  };
  return { calls, fetch };
}

test('streams release asset through only its approved signed GitHub CDN redirect and hashes incrementally', async () => {
  const { fetch, calls } = mock([redirect(signed), ok([payload.subarray(0, 2), payload.subarray(2)],
    { 'content-length': String(payload.length) })]);
  const result = await downloadArchive(release, { fetch, expectedHash: digest.toUpperCase() });
  assert.deepEqual(result, { bytes: payload, sha256: digest });
  assert.deepEqual(calls.map(call => call.url), [release, signed]);
  assert.equal(JSON.stringify(result).includes('SYNTHETIC_SECRET'), false);
});

test('permits source ZIP and API asset paths only under the six ineedbots repositories', async () => {
  const first = mock([ok()]);
  assert.deepEqual(await downloadArchive(archive, { fetch: first.fetch }), { bytes: payload, sha256: digest });
  const second = mock([redirect(release), redirect(signed), ok()]);
  const api = 'https://api.github.com/repos/ineedbots/iw3_bot_warfare/releases/assets/12345';
  assert.equal((await downloadArchive(api, { fetch: second.fetch })).sha256, digest);
  assert.deepEqual(second.calls.map(call => call.url), [api, release, signed]);
});

test('rejects disallowed initial hosts, ports, credentials, fragments, paths, and direct CDN before fetch', async () => {
  const blocked = [
    signed, 'http://github.com/ineedbots/iw3_bot_warfare/releases/download/v2.2.0/iw3bw220.zip',
    release.replace('github.com/', 'github.com.evil.test/'),
    release.replace('github.com/', 'user:pass@github.com/'),
    release.replace('github.com/', 'github.com:443/'),
    release + '#fragment', release + '?token=do-not-send',
    release.replace('/ineedbots/', '/other/'),
    release.replace('iw3_bot_warfare', 'unrelated_repo'),
    release.replace('/releases/', '/../releases/'),
    release.replace('/ineedbots/', '/%69needbots/'),
    'https://api.github.com/repos/other/iw3_bot_warfare/releases/assets/123',
    'https://api.github.com/ineedbots/iw3_bot_warfare/x/zipball/abc',
    'https://codeload.github.com/ineedbots/unknown/zip/abc',
  ];
  let calls = 0;
  for (const url of blocked) {
    await assert.rejects(downloadArchive(url, { fetch: () => { calls++; throw Error('should not fetch'); } }), /Unapproved/u, url);
  }
  assert.equal(calls, 0);
});

test('never follows malicious redirects, including a CDN URL without a release-asset predecessor', async () => {
  for (const location of ['https://evil.example/steal',
    'https://github.com/other/iw3_bot_warfare/releases/download/v1/a.zip',
    'https://github.com:443/ineedbots/iw3_bot_warfare/releases/download/v2/a.zip', signed]) {
    const { fetch, calls } = mock([redirect(location)]);
    await assert.rejects(downloadArchive(archive, { fetch }), /Unapproved/u);
    assert.equal(calls.length, 1);
  }
  const directApi = mock([redirect(signed)]);
  await assert.rejects(downloadArchive('https://api.github.com/repos/ineedbots/iw3_bot_warfare/releases/assets/123',
    { fetch: directApi.fetch }), /Unapproved/u);
  assert.equal(directApi.calls.length, 1);
  const { fetch, calls } = mock([redirect(signed), redirect(signed)]);
  await assert.rejects(downloadArchive(release, { fetch }), /Unapproved/u);
  assert.equal(calls.length, 2);
});

test('redirect hop bound and absent redirect location fail without another request', async () => {
  const missing = mock([new Response(null, { status: 302 })]);
  await assert.rejects(downloadArchive(release, { fetch: missing.fetch }), /Invalid.*redirect/u);
  assert.equal(missing.calls.length, 1);
  const repeated = mock(Array.from({ length: 6 }, () => redirect(release, 307)));
  await assert.rejects(downloadArchive(release, { fetch: repeated.fetch }), /Too many/u);
  assert.equal(repeated.calls.length, 6);
});

test('rejects oversized declared and streamed bodies and a truncated Content-Length', async () => {
  const header = mock([ok([payload], { 'content-length': '100' })]);
  await assert.rejects(downloadArchive(release, { fetch: header.fetch, maxBytes: 10 }), /size limit/u);
  const body = mock([ok([payload.subarray(0, 4), payload.subarray(4)])]);
  await assert.rejects(downloadArchive(release, { fetch: body.fetch, maxBytes: 5 }), /size/u);
  const underreported = mock([ok([payload], { 'content-length': '5' })]);
  await assert.rejects(downloadArchive(release, { fetch: underreported.fetch }), /size/u);
  const truncated = mock([ok([payload], { 'content-length': '7' })]);
  await assert.rejects(downloadArchive(release, { fetch: truncated.fetch }), /Truncated/u);
  const malformed = mock([ok([payload], { 'content-length': 'NaN' })]);
  await assert.rejects(downloadArchive(release, { fetch: malformed.fetch }), /Content-Length/u);
});

test('hash mismatch never returns bytes and input caps cannot exceed 80 MB', async () => {
  const { fetch } = mock([ok()]);
  await assert.rejects(downloadArchive(release, { fetch, expectedHash: 'f'.repeat(64) }), /SHA-256 mismatch/u);
  for (const maxBytes of [0, 80 * 1024 * 1024 + 1, Infinity]) {
    await assert.rejects(downloadArchive(release, { maxBytes, fetch: () => { throw Error('should not fetch'); } }), /size limit/u);
  }
  await assert.rejects(downloadArchive(release, { expectedHash: 'xyz' }), /expected SHA-256/u);
});

test('timeouts cover fetch and stalled response streams; rate limits and offline errors are sanitized', async () => {
  let aborted;
  await assert.rejects(downloadArchive(release, { timeoutMs: 10, fetch: (_url, options) => {
    aborted = options.signal;
    return new Promise(() => {});
  } }), /timed out/u);
  assert.equal(aborted.aborted, true);
  const stalled = new ReadableStream({ start() {} });
  await assert.rejects(downloadArchive(release, { timeoutMs: 10,
    fetch: async () => new Response(stalled, { status: 200 }) }), /timed out/u);
  for (const response of [new Response(null, { status: 429 }),
    new Response(null, { status: 403, headers: { 'x-ratelimit-remaining': '0' } })]) {
    await assert.rejects(downloadArchive(release, { fetch: async () => response }), /rate-limited/u);
  }
  const secret = 'SYNTHETIC_SECRET';
  await assert.rejects(downloadArchive(release, { fetch: async () => { throw Error(`failed: ${secret}`); } }), error => {
    assert.match(error.message, /unavailable/u);
    assert.equal(error.message.includes(secret), false);
    return true;
  });
  await assert.rejects(downloadArchive(release, { fetch: async () => new Response(null, { status: 503 }) }), /unavailable/u);
});
