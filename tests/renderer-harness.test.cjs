const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { registerSmokeSchemes, installOfflineProtocols, isolateSmokeProfile, executeRenderer } = require('./smoke-harness.cjs');
const { rendererSchemeRegistration } = require('../electron/renderer-protocol.cjs');
const { createRendererFixtures, schemaDocument, logFixture } = require('./renderer-fixtures.cjs');
const { order } = require('../electron/profiles.cjs');
const { schemaFor } = require('../electron/schema.cjs');

test('both offline smokes use the production handler/origin and real preload, never file:// or main services', async () => {
  for (const name of ['packaged-smoke.cjs', 'accessibility-smoke.cjs']) {
    const source = await fs.readFile(path.join(__dirname, name), 'utf8');
    assert.match(source, /installOfflineProtocols/);
    assert.match(source, /isolateSmokeProfile/);
    assert.match(source, /loadURL\(rendererEntryUrl\)/);
    assert.match(source, /assertProductionPage/);
    assert.match(source, /preload\.cjs/);
    assert.doesNotMatch(source, /\.loadFile\(|\.loadURL\(['"]file:|require\(['"][^'"]*electron\/(?:main|manager|key-store|firewall-rule|botwarfare-install)\.cjs/);
  }
  const auditor = await fs.readFile(path.join(__dirname, 'accessibility-audit.cjs'), 'utf8');
  assert.doesNotMatch(auditor, /nodes\.filter\(|opacity\s*[<>]|exclude[^\n]*disabled|exclude[^\n]*opacity/, 'Audit must not discard enabled low-opacity controls or globally exclude disabled semantics');
  assert.match(auditor, /aria-hidden/);
  assert.match(auditor, /!element\.querySelector\(interactive\)/, 'Narrow decorative exclusions must never hide interactive descendants');
  assert.match(auditor, /button-name/);
  assert.match(auditor, /aria-required-attr/);
  assert.match(auditor, /color-contrast/);
});

test('offline session registers production privileges and denies network/file/data without invoking any service', () => {
  let registrations;
  let intercept;
  let permission;
  let permissionCheck;
  const handles = new Map();
  const protocol = { registerSchemesAsPrivileged: entries => { registrations = entries; }, handle: (scheme, handler) => handles.set(scheme, handler) };
  registerSmokeSchemes(protocol);
  assert.equal(registrations[0], rendererSchemeRegistration);
  assert.deepEqual(registrations[1], { scheme: 'botland-art', privileges: { standard: true, secure: true } });
  const session = {
    webRequest: { onBeforeRequest: callback => { intercept = callback; } },
    setPermissionRequestHandler: callback => { permission = callback; },
    setPermissionCheckHandler: callback => { permissionCheck = callback; },
  };
  const { blocked } = installOfflineProtocols({ protocol, session });
  assert.equal(typeof handles.get('app'), 'function');
  assert.equal(typeof handles.get('botland-art'), 'function');
  for (const [url, allowed] of [
    ['app://botland/index.html', true], ['app://botland/assets/built.js', true],
    ['botland-art://artwork/cod4/cover?v=1', true],
    ['https://example.invalid/config', false], ['http://127.0.0.1:5173/', false],
    ['file:///C:/Example/Game/server.cfg', false], ['data:text/html,external', false],
    ['app://elsewhere/index.html', false], ['app://botland/assets/../../keys.json', false],
    ['botland-art://artwork/unknown/cover', false],
  ]) intercept({ url }, result => assert.equal(result.cancel, !allowed, url));
  assert.equal(blocked.length, 7);
  permission(null, 'camera', allowed => assert.equal(allowed, false));
  assert.equal(permissionCheck(), false);
});

test('smoke profiles are unique isolated temporary folders and cleanup touches only that profile', async () => {
  const paths = [];
  const handlers = [];
  const app = { setPath: (key, value) => { assert.ok(key === 'userData' || key === 'sessionData'); if (key === 'userData') paths.push(value); },
    on: (key, callback) => { assert.ok(key === 'will-quit' || key === 'quit'); handlers.push(callback); } };
  const first = isolateSmokeProfile(app, 'botland-harness-test');
  const second = isolateSmokeProfile(app, 'botland-harness-test');
  try {
    assert.notEqual(first, second);
    assert.deepEqual(paths, [first, second]);
    assert.equal((await fs.stat(first)).isDirectory(), true);
    handlers[0]();
    await assert.rejects(fs.stat(first), /ENOENT/);
    assert.equal((await fs.stat(second)).isDirectory(), true);
  } finally { for (const handler of handlers) handler(); }
});

test('renderer watchdog preserves real execution results and script rejections', async () => {
  const failure = new Error('Synthetic script failure.');
  const win = { webContents: { executeJavaScript: script => script === 'success' ? Promise.resolve(42) : Promise.reject(failure) } };
  assert.equal(await executeRenderer(win, 'success'), 42);
  await assert.rejects(executeRenderer(win, 'failure'), error => error === failure);
  assert.equal(await executeRenderer(win, 'success'), 42, 'An ordinary script rejection must not mark a healthy renderer as hung');
});

test('renderer watchdog fails a blocked main thread without relying on its stalled JavaScript timers', async () => {
  let calls = 0;
  const win = { webContents: { executeJavaScript: () => { calls++; return new Promise(() => {}); } } };
  await assert.rejects(executeRenderer(win, 'blocked fixture', 5), error => error.code === 'RENDERER_UNRESPONSIVE' && /blocked fixture/.test(error.message));
  await assert.rejects(executeRenderer(win, 'must not keep waiting', 5), error => error.code === 'RENDERER_UNRESPONSIVE');
  assert.equal(calls, 1, 'After a liveness failure, do not spend another timeout on each following viewport');
});

test('schema fixtures install all six titles and expose every real title/mode schema without reading configs', async () => {
  const fixture = createRendererFixtures();
  const snapshot = await fixture.services.snapshot();
  assert.deepEqual(snapshot.games.map(game => game.id), order);
  assert.ok(snapshot.games.every(game => game.installed && game.gamePath.startsWith('C:\\Example\\SyntheticGames\\')));
  for (const game of snapshot.games) {
    const base = schemaDocument(game.id);
    assert.deepEqual(base.fields, schemaFor(game.id).fields);
    assert.ok(base.entries.some(entry => entry.masked && entry.value === ''));
    assert.equal(game.logs.length, 120);
    assert.equal(game.logs[119].message, logFixture(119).message);
    const conditional = schemaDocument(game.id, 'base', game.options.mode, 'conditional');
    assert.equal(conditional.values.bots_team, 'custom');
    const defaults = schemaDocument(game.id, 'base', game.options.mode, 'defaults');
    assert.ok(defaults.fields.some(field => field.default !== undefined && !Object.hasOwn(defaults.values, field.key)));
    if (game.id === 'mw3' || game.id === 'bo2') {
      for (const mode of (await fixture.services.maps(game.id)).modes) {
        const doc = schemaDocument(game.id, 'mode', mode.value);
        assert.deepEqual(doc.fields, schemaFor(game.id, 'mode', mode.value).fields);
        assert.match(doc.path, game.id === 'mw3' ? /\.dsr$/ : /\.cfg$/);
      }
    }
  }
  // Fixtures clone at the bridge boundary and never mutate a prior snapshot.
  fixture.state.games[0].logs.push(logFixture(120));
  assert.equal(snapshot.games[0].logs.length, 120);
  assert.equal((await fixture.services.snapshot()).games[0].logs.length, 121);
});
