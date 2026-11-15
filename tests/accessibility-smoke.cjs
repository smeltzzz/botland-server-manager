// Offline audit of the built production app:// renderer and real preload.
// Services and every title's real schema are backed ONLY by synthetic objects.
// Run after build: node_modules/.bin/electron.cmd tests/accessibility-smoke.cjs
// --screenshots is an explicit owner opt-in; normal audits never write images.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, protocol, session, nativeImage } = require('electron');
const { rendererEntryUrl, isolateSmokeProfile, registerSmokeSchemes, installOfflineProtocols, executeRenderer, hardenSmokeWindow, assertProductionPage } = require('./smoke-harness.cjs');
const { settleDom, settledAxe, verifyAuditSelfCheck } = require('./accessibility-audit.cjs');
const { waitForCondition, layout: strictLayout, responsive: strictResponsive, focusNotObscured: strictFocusNotObscured, artworkTextContrast } = require('./renderer-layout.cjs');
const { createRendererFixtures, schemaDocument } = require('./renderer-fixtures.cjs');

const root = path.join(__dirname, '..');
const captures = process.argv.includes('--screenshots');
const failures = [];
const profile = isolateSmokeProfile(app, 'botland-a11y');
registerSmokeSchemes(protocol);
const readActions = new Set(['snapshot', 'maps', 'document', 'botStatus', 'firewallStatus', 'listConfigBackups']);
const auditActions = new Set(['setUnsavedChanges', 'previewSettings', 'commitSettings', 'previewConfigRestore']);
let brightArtwork = false;

function layoutFailure(name, error) {
  if (error.code === 'RENDERER_UNRESPONSIVE' || /Unexpected native dialog:/.test(error.message)) throw error;
  failures.push({ page: name, layout: error.message });
  console.error(`Layout detail for ${name}: ${error.message}`);
}
async function layout(win, name, width) {
  try { await strictLayout(win, name, width); } catch (error) { layoutFailure(name, error); }
}
async function responsive(win, name, options = {}) {
  await strictResponsive(win, name, { ...options, onFailure: layoutFailure });
}
async function focusNotObscured(win, selector, name) {
  try { await strictFocusNotObscured(win, selector, name); } catch (error) { layoutFailure(name, error); }
}
async function checkArtworkContrast(win, selector, name) {
  try { await artworkTextContrast(win, selector, name); } catch (error) {
    failures.push({ page: name, contrast: error.message });
    console.error(`Artwork contrast detail for ${name}: ${error.message}`);
  }
}
async function checkRtlToggle(win, selector, name) {
  try { await checkedRtlToggle(win, selector, name); } catch (error) { layoutFailure(name, error); }
}
async function waitFor(win, selector) {
  await waitForCondition(win, `Boolean(document.querySelector(${JSON.stringify(selector)}))`);
}
async function expectedPage(win, { game = null, tab = 'overview' } = {}) {
  const state = await executeRenderer(win, `({
    dashboard: !!document.querySelector('main .dashboard-intro'),
    home: document.querySelector('.sidebar > .nav-item')?.getAttribute('aria-current'),
    heading: document.querySelector('.detail-hero h1')?.textContent,
    game: document.querySelector('.game-nav-item[aria-current="page"]')?.dataset.game,
    tab: document.querySelector('.detail-tabs [aria-selected="true"]')?.dataset.tab,
    label: document.querySelector('main')?.getAttribute('aria-label'),
    nativeDialogs: window.__smokeNativeDialogs || [],
  })`);
  assert.deepEqual(state.nativeDialogs, [], 'Audit navigation must not block on or silently accept an unplanned native dialog');
  if (!game) {
    assert.equal(state.dashboard, true, `Expected Dashboard, not a mislabeled prior page: ${JSON.stringify(state)}`);
    assert.equal(state.home, 'page');
    assert.equal(state.tab, undefined);
  } else {
    assert.equal(state.dashboard, false);
    assert.equal(state.game, game.id);
    assert.equal(state.heading, game.title);
    assert.equal(state.tab, tab);
  }
}
async function home(win) {
  await executeRenderer(win, "document.querySelector('.sidebar > .nav-item').click()");
  await waitFor(win, '.dashboard-intro');
  await expectedPage(win);
}
async function openGame(win, game) {
  await executeRenderer(win, `document.querySelector('[data-game=${JSON.stringify(game.id)}]').click()`);
  await waitFor(win, '.detail-hero');
  await waitForCondition(win, `document.querySelector('.detail-tabs [aria-selected="true"]')?.dataset.tab === 'overview'`);
  await expectedPage(win, { game });
}
async function tab(win, game, id, selector) {
  await executeRenderer(win, `document.querySelector('[data-tab=${JSON.stringify(id)}]').click()`);
  await waitFor(win, selector);
  await expectedPage(win, { game, tab: id });
}
async function changeControl(win, selector, value) {
  await executeRenderer(win, `(() => {
    const control = document.querySelector(${JSON.stringify(selector)});
    const prototype = control.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(control, ${JSON.stringify(value)});
    control.dispatchEvent(new Event(control.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  })()`);
}
async function audit(win, name, axeSource, page) {
  await expectedPage(win, page);
  const result = await settledAxe(win, axeSource);
  await expectedPage(win, page);
  if (result.violations.length) {
    failures.push({ page: name, violations: result.violations });
    console.error(`Accessibility detail for ${name}:`, JSON.stringify(result.violations, null, 2));
  }
  console.log(`Accessibility: ${name} ${result.violations.length ? 'FAILED' : 'passed'} (${result.incomplete} checks require manual review).`);
}
async function auditReflow(win, name, axeSource, page) {
  win.setContentSize(320, 850);
  await layout(win, `${name} 320 CSS px`, 320);
  await audit(win, `${name} at 320 CSS px`, axeSource, page);
  win.setContentSize(1380, 1000);
  await layout(win, `${name} reset`, 1380);
}
async function capture(win, filename) {
  if (!captures) return;
  await executeRenderer(win, "document.querySelector('.main-pane').scrollTo(0, 0)");
  await fs.writeFile(path.join(root, 'docs', 'images', filename), (await win.capturePage()).toPNG());
}
async function verifySchemaControls(win, game, target, mode, variant) {
  const doc = schemaDocument(game.id, target, mode, variant);
  const expected = doc.fields.filter(field => !field.presentOnly || Object.hasOwn(doc.values, field.key)).filter(field => {
    if (!field.dependsOn) return true;
    return (doc.values[field.dependsOn.key] ?? doc.fields.find(parent => parent.key === field.dependsOn.key)?.default) === field.dependsOn.value;
  }).map(field => field.key).sort();
  const rendered = await executeRenderer(win, "[...document.querySelectorAll('.config-field-grid [data-config-key]')].map(control => control.dataset.configKey).sort()");
  assert.deepEqual(rendered, expected, `${game.short} ${target}/${mode} ${variant} must audit its real title schema, not a generic demo subset`);
}
async function checkedRtlToggle(win, selector, name) {
  await waitForCondition(win, `document.querySelector(${JSON.stringify(selector)})?.checked === true`);
  await settleDom(win); // Also let the ordinary 200 ms knob transition finish.
  const result = await executeRenderer(win, `(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    const track = input.closest('.toggle').getBoundingClientRect();
    const knob = input.closest('.toggle').querySelector(':scope > span').getBoundingClientRect();
    return { checked: input.checked, dir: getComputedStyle(input).direction, trackCenter: track.left + track.width / 2, knobCenter: knob.left + knob.width / 2 };
  })()`);
  assert.equal(result.dir, 'rtl');
  assert.ok(result.knobCenter < result.trackCenter, `${name}: checked RTL knob must move toward inline-end, not outside the track: ${JSON.stringify(result)}`);
}

app.whenReady().then(async () => {
  const fixtures = createRendererFixtures();
  const manager = fixtures.services;
  const snapshot = await manager.snapshot();
  assert.equal(snapshot.games.length, 6);
  assert.ok(snapshot.games.every(game => game.installed && game.gamePath.startsWith('C:\\Example\\')));
  assert.equal(app.getPath('userData'), profile);
  assert.equal(app.getPath('sessionData'), profile);
  const white = nativeImage.createFromBitmap(Buffer.from([255, 255, 255, 255]), { width: 1, height: 1 }).toPNG();
  const offline = installOfflineProtocols({ protocol, session: session.defaultSession, artwork: request => brightArtwork && !request.url.includes('/logo')
    ? new Response(request.method === 'HEAD' ? null : white, { headers: { 'content-type': 'image/png', 'x-content-type-options': 'nosniff' } })
    : new Response('Not found', { status: 404 }) });
  // Hidden native windows throttle resize frames to ~1 Hz on Windows even
  // with backgroundThrottling disabled. Offscreen rendering keeps the full
  // viewport/zoom matrix deterministic without opening UI or relaxing checks.
  const win = new BrowserWindow({ width: 1380, height: 1000, show: false, backgroundColor: '#1B1A19',
    webPreferences: { preload: path.join(root, 'electron', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, offscreen: true } });
  hardenSmokeWindow(win);
  ipcMain.handle('manager:action', (event, action, payload = {}) => {
    assert.equal(event.sender, win.webContents);
    assert.equal(event.senderFrame, win.webContents.mainFrame);
    if (!readActions.has(action) && !auditActions.has(action)) throw new Error('Accessibility smoke refuses non-audit actions.');
    if (action === 'snapshot') return manager.snapshot();
    if (action === 'setUnsavedChanges') return manager.setUnsavedChanges(payload.dirty);
    if (action === 'document') return manager.document(payload.id, payload.target, payload.mode);
    if (action === 'previewSettings' || action === 'commitSettings') return manager[action](payload.id, payload.target, payload.mode, payload.values);
    if (action === 'previewConfigRestore') return manager.previewConfigRestore(payload.id, payload.target, payload.mode, payload.backupId);
    return manager[action](payload.id);
  });
  manager.subscribe(event => win.webContents.send('manager:event', event));
  const axeSource = await fs.readFile(require.resolve('axe-core/axe.min.js'), 'utf8');
  const rendererErrors = [];
  win.webContents.on('console-message', details => { if (details.level === 'error' && !/Electron Security Warning/.test(details.message)) rendererErrors.push(details.message); });
  try {
    await win.loadURL(rendererEntryUrl);
    await assertProductionPage(win);
    await executeRenderer(win, `(() => {
      window.__smokeNativeDialogs = [];
      for (const kind of ['confirm', 'alert', 'prompt']) window[kind] = message => {
        window.__smokeNativeDialogs.push({ kind, message: String(message) });
        return kind === 'confirm' ? false : kind === 'prompt' ? null : undefined;
      };
    })()`);
    await waitFor(win, '.server-card');
    await verifyAuditSelfCheck(win, axeSource);
    await audit(win, 'Dashboard (all six installed)', axeSource, {});
    await responsive(win, 'Dashboard');
    await capture(win, 'dashboard-demo.png');
    for (const game of snapshot.games) {
      await openGame(win, game);
      await audit(win, `${game.short} Overview`, axeSource, { game });
      await responsive(win, `${game.short} Overview`);
      await tab(win, game, 'configuration', '.config-field-grid [data-config-key]');
      await verifySchemaControls(win, game, 'base', game.options.mode, 'standard');
      await audit(win, `${game.short} full title schema`, axeSource, { game, tab: 'configuration' });
      await responsive(win, `${game.short} Configuration`);
      win.setContentSize(320, 850);
      await layout(win, `${game.short} focused reflow`, 320);
      await audit(win, `${game.short} Configuration at 320 CSS px`, axeSource, { game, tab: 'configuration' });
      await focusNotObscured(win, '.config-field-grid input, .config-field-grid select', `${game.short} sticky save bar`);
      win.setContentSize(1380, 1000);
      await layout(win, `${game.short} reset`, 1380);
      if (game.id === 'cod4') await capture(win, 'configuration-demo.png');
      await executeRenderer(win, "document.querySelectorAll('.config-switch button')[1].click()");
      await waitFor(win, '.advanced-list input');
      await audit(win, `${game.short} all existing settings (masked/duplicate/disabled directives)`, axeSource, { game, tab: 'configuration' });
      await responsive(win, `${game.short} advanced settings`, { full: false });
      if (game.id === 'mw3' || game.id === 'bo2') {
        await executeRenderer(win, "document.querySelector('.config-switch button').click(); document.querySelectorAll('.config-targets button')[1].click()");
        for (const mode of (await manager.maps(game.id)).modes) {
          await waitFor(win, '.config-targets select');
          await changeControl(win, '.config-targets select', mode.value);
          await waitForCondition(win, `document.querySelector('.config-file-path')?.textContent.includes(${JSON.stringify(mode.value)}) && document.querySelectorAll('.config-field-grid [data-config-key]').length > 0`);
          await verifySchemaControls(win, game, 'mode', mode.value, 'standard');
          await audit(win, `${game.short} mode editor ${mode.value}`, axeSource, { game, tab: 'configuration' });
          await responsive(win, `${game.short} mode ${mode.value}`, { full: false });
          await auditReflow(win, `${game.short} mode editor ${mode.value}`, axeSource, { game, tab: 'configuration' });
        }
      }
      await tab(win, game, 'rotation', '.map-option');
      await audit(win, `${game.short} Maps & modes`, axeSource, { game, tab: 'rotation' });
      await responsive(win, `${game.short} Maps & modes`);
      await tab(win, game, 'console', '.console-line');
      await audit(win, `${game.short} populated Console`, axeSource, { game, tab: 'console' });
      await responsive(win, `${game.short} populated Console`);
    }
    // Re-mount each editor with conditional and absent-default variants. Every
    // supported dependency field is audited, including IW3/IW4/IW5 skill mixes.
    for (const variant of ['conditional', 'defaults']) {
      fixtures.setVariant(variant);
      for (const game of snapshot.games) {
        await home(win);
        await openGame(win, game);
        await tab(win, game, 'configuration', '.config-field-grid [data-config-key]');
        await verifySchemaControls(win, game, 'base', game.options.mode, variant);
        await audit(win, `${game.short} ${variant} schema variant`, axeSource, { game, tab: 'configuration' });
        await responsive(win, `${game.short} ${variant} schema variant`, { full: false });
      }
    }
    fixtures.setVariant('standard');
    await home(win);
    await openGame(win, snapshot.games[0]);
    await tab(win, snapshot.games[0], 'configuration', '.config-field-grid [data-config-key]');
    await verifyConfigurationStates(win, fixtures, snapshot.games[0], axeSource);
    await verifyBrightArtwork(win, fixtures, snapshot.games, axeSource);
    // Explicitly go home: changing locale does NOT navigate away from the last
    // editor, so auditing that page as "Dashboard" used to give false coverage.
    await home(win);
    await manager.setLocale('pseudo-rtl');
    await waitForCondition(win, "document.documentElement.dir === 'rtl' && document.querySelector('.app-shell')?.dataset.locale === 'pseudo-rtl'");
    await expectedPage(win);
    await audit(win, 'Dashboard (pseudo RTL)', axeSource, {});
    await responsive(win, 'Dashboard (pseudo RTL)');
    const mirrored = await executeRenderer(win, "({ dir: document.documentElement.dir, right: document.querySelector('.sidebar').getBoundingClientRect().left > innerWidth / 2 })");
    assert.equal(mirrored.dir, 'rtl');
    assert.equal(mirrored.right, true);
    fixtures.state.games[0].restart.enabled = true;
    fixtures.emit();
    await openGame(win, snapshot.games[0]);
    await checkRtlToggle(win, '.restart-panel .toggle input', 'Restart toggle');
    await audit(win, 'CoD4 checked restart (pseudo RTL)', axeSource, { game: snapshot.games[0] });
    await tab(win, snapshot.games[0], 'rotation', '.map-option');
    await checkRtlToggle(win, '.rotation-panel .toggle input', 'Shuffle toggle');
    await audit(win, 'CoD4 checked shuffle (pseudo RTL)', axeSource, { game: snapshot.games[0], tab: 'rotation' });
    await responsive(win, 'CoD4 Maps & modes (pseudo RTL)');
    await tab(win, snapshot.games[0], 'configuration', '.config-field-grid [data-config-key]');
    await audit(win, 'CoD4 Configuration (pseudo RTL)', axeSource, { game: snapshot.games[0], tab: 'configuration' });
    await responsive(win, 'CoD4 Configuration (pseudo RTL)');
    await auditReflow(win, 'CoD4 Configuration (pseudo RTL)', axeSource, { game: snapshot.games[0], tab: 'configuration' });
    if (rendererErrors.length) failures.push({ page: 'Renderer console errors', errors: rendererErrors });
    if (offline.blocked.length) failures.push({ page: 'Forbidden external/file/data network requests', requests: offline.blocked });
    assert.equal(failures.length, 0, JSON.stringify(failures, null, 2));
    console.log('Synthetic production-origin accessibility/layout smoke passed: six title schemas, mode editors, variants, true 320 CSS px, dialogs/busy/notices, bright artwork, sticky focus and checked RTL.');
  } finally { win.destroy(); }
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });

async function verifyConfigurationStates(win, fixtures, game, axeSource) {
  const page = { game, tab: 'configuration' };
  await changeControl(win, '[data-config-key="sv_hostname"]', 'Synthetic reviewed server');
  await waitFor(win, '.config-savebar button:not(:disabled)');
  let release;
  let started;
  const pending = new Promise(resolve => { started = resolve; });
  fixtures.deferPreview(result => new Promise(resolve => { release = () => resolve(result); started(); }));
  await executeRenderer(win, "document.querySelector('.config-savebar button').click()");
  await pending;
  await waitFor(win, '.config-main[aria-busy="true"]');
  await audit(win, 'Configuration preview busy (inactive controls still get semantic checks)', axeSource, page);
  await responsive(win, 'Configuration preview busy', { full: false });
  await auditReflow(win, 'Configuration preview busy', axeSource, page);
  fixtures.deferPreview(null);
  release();
  await waitFor(win, 'dialog[open]');
  await audit(win, 'Configuration review dialog', axeSource, page);
  await responsive(win, 'Configuration review dialog', { full: false });
  await auditReflow(win, 'Configuration review dialog', axeSource, page);
  await executeRenderer(win, "document.querySelector('dialog .review-actions .primary-button').click()");
  await waitFor(win, '.config-notice.success');
  await waitForCondition(win, '!document.querySelector(\'dialog[open]\')');
  await audit(win, 'Configuration saved notice', axeSource, page);
  await responsive(win, 'Configuration saved notice', { full: false });
  await auditReflow(win, 'Configuration saved notice', axeSource, page);
  await executeRenderer(win, "document.querySelector('.config-backup button').click()");
  await waitFor(win, 'dialog[open]');
  await audit(win, 'Configuration restore preview dialog', axeSource, page);
  await responsive(win, 'Configuration restore preview dialog', { full: false });
  await auditReflow(win, 'Configuration restore preview dialog', axeSource, page);
  await executeRenderer(win, "document.querySelector('dialog .review-actions .outline-button').click()");
  await waitForCondition(win, '!document.querySelector(\'dialog[open]\')');
}
async function verifyBrightArtwork(win, fixtures, games, axeSource) {
  brightArtwork = true;
  // Changing only the synthetic snapshot path produces new art URLs without
  // loading a real file or relying on Chromium's prior 404 cache entry.
  for (const game of fixtures.state.games) game.gamePath += '\\BrightArtwork';
  fixtures.emit();
  await home(win);
  await waitFor(win, '.server-card .card-art.has-image');
  await audit(win, 'Dashboard with white synthetic artwork', axeSource, {});
  await checkArtworkContrast(win, '.server-card h3', 'Dashboard title over bright artwork');
  for (const game of games) {
    await openGame(win, game);
    await waitFor(win, '.detail-hero.has-image');
    await audit(win, `${game.short} bright artwork Overview`, axeSource, { game });
    await checkArtworkContrast(win, '.detail-hero h1', `${game.short} hero heading`);
    await checkArtworkContrast(win, '.detail-hero-content > p', `${game.short} hero secondary text`);
  }
}
