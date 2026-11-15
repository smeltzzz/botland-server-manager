const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createRendererHandler, parseRendererUrl, rendererEntryUrl, rendererSchemeRegistration, MAX_FILE_BYTES } = require('../electron/renderer-protocol.cjs');

async function fixture(t, suffix = '') {
  const temporaryRoot = path.join(process.env.LOCALAPPDATA || os.tmpdir(), ...(process.env.LOCALAPPDATA ? ['Temp', 'opencode'] : ['opencode']));
  await fs.mkdir(temporaryRoot, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(temporaryRoot, 'botland-renderer-protocol-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, `bundle${suffix}`, 'dist');
  await fs.mkdir(path.join(root, 'assets'), { recursive: true });
  await fs.writeFile(path.join(root, 'index.html'), '<!doctype html><title>Synthetic renderer</title>');
  await fs.writeFile(path.join(root, 'assets', 'index-test.js'), 'export const fixture = true;');
  await fs.writeFile(path.join(root, 'assets', 'index-test.css'), 'body { color: white; }');
  await fs.writeFile(path.join(root, 'assets', 'font-test.woff2'), Buffer.from([1, 2, 3, 4]));
  await fs.writeFile(path.join(root, 'assets', 'sample.json'), '{"synthetic":true}');
  return { root, temporary, handler: createRendererHandler({ root }) };
}
const request = (url, method = 'GET') => ({ url, method });

test('renderer protocol has a restricted secure standard origin, not file privileges', () => {
  assert.equal(rendererEntryUrl, 'app://botland/index.html');
  assert.equal(rendererSchemeRegistration.scheme, 'app');
  assert.deepEqual(rendererSchemeRegistration.privileges, { standard: true, secure: true, supportFetchAPI: true, codeCache: true });
});

test('renderer URLs accept only the exact origin and canonical built resource names', () => {
  for (const [url, expected] of [
    ['app://botland', 'index.html'], ['app://botland/', 'index.html'],
    [rendererEntryUrl, 'index.html'], ['app://botland/assets/index-test.js?v=1#cache', 'assets/index-test.js'],
    ['app://botland/assets/nested/name_1.woff2', 'assets/nested/name_1.woff2'],
  ]) assert.equal(parseRendererUrl(url), expected, url);
  for (const url of [
    'not a URL', 'file:///index.html', 'https://botland/index.html', 'APP://botland/index.html',
    'app://BOTLAND/index.html', 'app://botland./index.html', 'app://botland.evil/index.html',
    'app://elsewhere/index.html', 'app:///botland/index.html', 'app://%62otland/index.html',
    'app://user@botland/index.html', 'app://@botland/index.html', 'app://:pass@botland/index.html',
    'app://botland:123/index.html', 'app://botland:/index.html',
    'app://botland/../index.html', 'app://botland/assets/../index.html',
    'app://botland/assets/./index-test.js', 'app://botland//index.html',
    'app://botland/%2e%2e/index.html', 'app://botland/assets/%2e%2e/index.html',
    'app://botland/assets/%252e%252e/index.html', 'app://botland/assets%2findex-test.js',
    'app://botland/assets/%2findex-test.js', 'app://botland/assets/%5c..%5cindex.html',
    'app://botland/assets/..\\index.html', 'app://botland/assets/index-test.js:secret',
    'app://botland/assets/index-test.js::$DATA', 'app://botland/assets/index-test.js%3a$DATA',
    'app://botland/assets/index-test.js%00.css', 'app://botland/assets/index-test.js\0.css',
    'app://botland/assets/index-test.js\n', ' app://botland/index.html',
    'app://botland/assets/index-test.js.', 'app://botland/assets/NUL.js',
    'app://botland/assets/con.json', 'app://botland/assets/COM1.css',
    'app://botland/assets/.hidden.js', 'app://botland/assets/bad%zz.js',
    'app://botland/assets/index-test.js/', 'app://botland/assets/unknown.exe',
    'app://botland/package.json', 'app://botland/electron/main.cjs',
    `app://botland/assets/${'a'.repeat(4096)}.js`,
  ]) assert.equal(parseRendererUrl(url), null, url);
});

test('renderer handler serves built bytes with exact MIME, nosniff and HEAD metadata', async t => {
  const { handler } = await fixture(t);
  for (const [file, mime, body] of [
    ['index.html', 'text/html; charset=utf-8', '<!doctype html><title>Synthetic renderer</title>'],
    ['assets/index-test.js', 'text/javascript; charset=utf-8', 'export const fixture = true;'],
    ['assets/index-test.css', 'text/css; charset=utf-8', 'body { color: white; }'],
    ['assets/sample.json', 'application/json; charset=utf-8', '{"synthetic":true}'],
  ]) {
    const result = await handler(request(`app://botland/${file}`));
    assert.equal(result.status, 200, file);
    assert.equal(result.headers.get('content-type'), mime);
    assert.equal(result.headers.get('content-length'), String(Buffer.byteLength(body)));
    assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(result.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.equal(await result.text(), body);
    const head = await handler(request(`app://botland/${file}`, 'HEAD'));
    assert.equal(head.status, 200);
    assert.equal(head.body, null);
    assert.deepEqual([...head.headers], [...result.headers]);
  }
  const font = await handler(request('app://botland/assets/font-test.woff2'));
  assert.equal(font.headers.get('content-type'), 'font/woff2');
  assert.deepEqual(Buffer.from(await font.arrayBuffer()), Buffer.from([1, 2, 3, 4]));
  assert.equal(await (await handler(request('app://botland/'))).text(), '<!doctype html><title>Synthetic renderer</title>');
});

test('renderer handler returns bounded, non-leaking errors and never falls back for unknown resources', async t => {
  const { root, handler } = await fixture(t);
  await fs.writeFile(path.join(root, 'package.json'), 'not a built resource');
  await fs.writeFile(path.join(root, 'assets', 'secret.txt'), 'not a built asset');
  for (const url of [
    'app://botland/package.json', 'app://botland/assets/secret.txt',
    'app://botland/assets/missing.js', 'app://botland/settings',
    'app://botland/assets/', 'app://evil/index.html',
    'app://botland/../index.html', 'app://botland/assets/index-test.js:secret',
  ]) {
    const result = await handler(request(url));
    assert.equal(result.status, 404, url);
    assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(await result.text(), 'Not found');
    const head = await handler(request(url, 'HEAD'));
    assert.equal(head.status, 404);
    assert.equal(head.body, null, 'HEAD errors have no response body either');
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS', 'TRACE', 'get']) {
    const result = await handler(request(rendererEntryUrl, method));
    assert.equal(result.status, 405, method);
    assert.equal(result.headers.get('allow'), 'GET, HEAD');
    assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
  }
});

test('renderer allowlist is immutable and rejects directories and replaced or oversized built files', async t => {
  const { root, handler } = await fixture(t);
  assert.equal((await handler(request(rendererEntryUrl))).status, 200);
  await fs.writeFile(path.join(root, 'assets', 'added-later.js'), 'not in this build');
  assert.equal((await handler(request('app://botland/assets/added-later.js'))).status, 404);
  await fs.unlink(path.join(root, 'assets', 'index-test.js'));
  await fs.mkdir(path.join(root, 'assets', 'index-test.js'));
  assert.equal((await handler(request('app://botland/assets/index-test.js'))).status, 404);
  const css = await fs.open(path.join(root, 'assets', 'index-test.css'), 'w');
  await css.truncate(MAX_FILE_BYTES + 1);
  await css.close();
  assert.equal((await handler(request('app://botland/assets/index-test.css'))).status, 404);
  const excessive = createRendererHandler({ root });
  assert.equal((await excessive(request(rendererEntryUrl))).status, 404, 'An unbounded build fails closed before it can allocate a body');
});

test('renderer body reads remain bounded when an unpacked asset grows after stat', async t => {
  const { root, handler } = await fixture(t);
  const asset = path.join(root, 'assets', 'index-test.css');
  const originalSize = (await fs.stat(asset)).size;
  const lstat = fs.lstat.bind(fs);
  let stats = 0;
  t.mock.method(fs, 'lstat', async file => {
    const value = await lstat(file);
    // Manifest inspection, then the request's final stat. Grow only after the
    // latter has returned its original metadata, precisely the TOCTOU window.
    if (file === asset && ++stats === 2) await fs.truncate(asset, MAX_FILE_BYTES + 1);
    return value;
  });
  const prototype = require('node:fs').ReadStream.prototype;
  const emit = prototype.emit;
  let bytes = 0;
  t.mock.method(prototype, 'emit', function (event, ...args) {
    if (this.path === asset && event === 'data') bytes += args[0].length;
    return emit.call(this, event, ...args);
  });
  assert.equal((await handler(request('app://botland/assets/index-test.css'))).status, 404);
  assert.equal(bytes, originalSize + 1, 'Only the approved byte range plus one growth-detection byte may be read');
});

test('renderer inventory bounds directory traversal as well as individual file sizes', async t => {
  const { root } = await fixture(t);
  await Promise.all(Array.from({ length: 130 }, async (_, index) => {
    const directory = path.join(root, 'assets', `folder-${index}`);
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, 'fixture.js'), 'synthetic');
  }));
  const handler = createRendererHandler({ root });
  assert.equal((await handler(request(rendererEntryUrl))).status, 404, 'A large tree of small files must not bypass the inventory budget');
});

test('renderer handler does not follow file or directory links outside dist', async t => {
  const { root, temporary } = await fixture(t);
  const outside = path.join(temporary, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'escape.js'), 'outside root');
  // Directory junctions do not require Windows developer-mode symlink rights.
  await fs.symlink(outside, path.join(root, 'assets', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const handler = createRendererHandler({ root });
  assert.equal((await handler(request('app://botland/assets/linked/escape.js'))).status, 404);
  assert.equal((await handler(request(rendererEntryUrl))).status, 200);
  await fs.mkdir(path.join(root, 'assets', 'nested'));
  await fs.writeFile(path.join(root, 'assets', 'nested', 'escape.js'), 'inside root');
  const beforeSwap = createRendererHandler({ root });
  assert.equal((await beforeSwap(request('app://botland/assets/nested/escape.js'))).status, 200);
  await fs.rm(path.join(root, 'assets', 'nested'), { recursive: true });
  await fs.symlink(outside, path.join(root, 'assets', 'nested'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await beforeSwap(request('app://botland/assets/nested/escape.js'))).status, 404);
});

test('a failed build inventory is not cached, so a later request retries', async t => {
  const temporaryRoot = path.join(process.env.LOCALAPPDATA || os.tmpdir(), ...(process.env.LOCALAPPDATA ? ['Temp', 'opencode'] : ['opencode']));
  await fs.mkdir(temporaryRoot, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(temporaryRoot, 'botland-renderer-retry-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'dist');
  const handler = createRendererHandler({ root });
  assert.equal((await handler(request(rendererEntryUrl))).status, 404);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'index.html'), '<!doctype html><title>Retry</title>');
  assert.equal((await handler(request(rendererEntryUrl))).status, 200);
});
