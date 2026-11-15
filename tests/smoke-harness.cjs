// Shared offline Electron plumbing. Production exports only a pure protocol
// handler; all fake services, writable fixtures and audit hooks stay in tests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { finished } = require('node:stream/promises');
const { rendererScheme, rendererEntryUrl, rendererSchemeRegistration, createRendererHandler, parseRendererUrl } = require('../electron/renderer-protocol.cjs');
const { artScheme, parseArtworkUrl } = require('../electron/artwork-protocol.cjs');
const { order } = require('../electron/profiles.cjs');

function isolateSmokeProfile(app, name) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error('Invalid smoke profile name.');
  const temporaryRoot = path.join(process.env.LOCALAPPDATA || os.tmpdir(), ...(process.env.LOCALAPPDATA ? ['Temp', 'opencode'] : ['opencode']));
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const profile = fs.mkdtempSync(path.join(temporaryRoot, `${name}-`));
  app.setPath('userData', profile);
  app.setPath('sessionData', profile);
  const cleanup = () => {
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 2 }); }
    catch { /* Chromium can retain its isolated cache lock until process exit. */ }
  };
  app.on('will-quit', cleanup);
  app.on('quit', cleanup); // app.exit(1) skips will-quit after an assertion fails.
  return profile;
}
function registerSmokeSchemes(protocol) {
  protocol.registerSchemesAsPrivileged([
    rendererSchemeRegistration,
    { scheme: artScheme, privileges: { standard: true, secure: true } },
  ]);
}
function installOfflineProtocols({ protocol, session, artwork = () => new Response('Not found', { status: 404 }) }) {
  protocol.handle(rendererScheme, createRendererHandler());
  protocol.handle(artScheme, artwork);
  const blocked = [];
  session.webRequest.onBeforeRequest((details, callback) => {
    const art = parseArtworkUrl(details.url);
    const allowed = parseRendererUrl(details.url) !== null || Boolean(art && order.includes(art.id));
    if (!allowed) blocked.push(details.url.replace(/[?#].*$/, ''));
    callback({ cancel: !allowed });
  });
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  return { blocked };
}
const stalledWindows = new WeakMap();
function executeRenderer(win, script, timeoutMs = 20_000) {
  if (stalledWindows.has(win)) return Promise.reject(stalledWindows.get(win));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(`Synthetic renderer stopped responding after ${timeoutMs} ms: ${script.slice(0, 160)}`);
      error.code = 'RENDERER_UNRESPONSIVE';
      stalledWindows.set(win, error);
      reject(error);
    }, timeoutMs);
    try {
      Promise.resolve(win.webContents.executeJavaScript(script)).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    } catch (error) { clearTimeout(timer); reject(error); }
  });
}
function hardenSmokeWindow(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('will-attach-webview', event => event.preventDefault());
}
async function assertProductionPage(win, { bridge = true } = {}) {
  const state = await executeRenderer(win, `({
    url: location.href, origin: location.origin, bridge: typeof window.manager?.snapshot === 'function',
    require: typeof window.require, demo: document.documentElement.dataset.demo,
  })`);
  assert.equal(state.url, rendererEntryUrl);
  assert.equal(state.origin, 'app://botland');
  assert.equal(state.bridge, bridge, 'The real context-isolated preload bridge must be used');
  assert.equal(state.require, 'undefined');
  assert.notEqual(state.demo, 'true', 'Production renderer must not install a browser demo/test backdoor');
  const preferences = win.webContents.getLastWebPreferences();
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.sandbox, true);
  assert.notEqual(preferences.nodeIntegration, true);
}
async function verifyAsarRenderer(profile) {
  // Exercise Electron's patched fs against a real archive, not a directory
  // merely named .asar. No production service or private file enters it.
  const { createPackage } = require('@electron/asar');
  const source = path.join(profile, 'protocol-asar-source');
  const archive = path.join(profile, 'protocol-fixture.asar');
  await fsp.mkdir(path.join(source, 'dist', 'assets'), { recursive: true });
  await fsp.writeFile(path.join(source, 'dist', 'index.html'), '<!doctype html><title>ASAR fixture</title>');
  await fsp.writeFile(path.join(source, 'dist', 'assets', 'fixture.js'), 'export const asar = true;');
  const output = await createPackage(source, archive);
  // @electron/asar 3.x returns its ending WriteStream before 'finish'; waiting
  // only for createPackage races Electron's first, cached archive-header read.
  if (output?.once) await finished(output);
  const handler = createRendererHandler({ root: path.join(archive, 'dist') });
  const page = await handler(new Request(rendererEntryUrl));
  assert.equal(page.status, 200, 'The production renderer handler must read an actual ASAR archive');
  assert.equal(await page.text(), '<!doctype html><title>ASAR fixture</title>');
  const asset = await handler(new Request('app://botland/assets/fixture.js'));
  assert.equal(asset.status, 200);
  assert.equal(await asset.text(), 'export const asar = true;');
  const head = await handler(new Request('app://botland/assets/fixture.js', { method: 'HEAD' }));
  assert.equal(head.status, 200);
  assert.equal(head.body, null);
  assert.equal((await handler({ url: 'app://botland/assets/../../package.json', method: 'GET' })).status, 404);
  await fsp.rm(source, { recursive: true, force: true });
}
module.exports = { rendererEntryUrl, isolateSmokeProfile, registerSmokeSchemes, installOfflineProtocols, executeRenderer, hardenSmokeWindow, assertProductionPage, verifyAsarRenderer };
