// Synthetic Electron smoke for the built renderer. Never loads a real game
// install or ServerManager; opt-in write actions mutate only in-memory fixtures.
// Run after build: node_modules/.bin/electron.cmd tests/packaged-smoke.cjs
const assert = require('node:assert/strict');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, protocol, session } = require('electron');
const { rendererEntryUrl, isolateSmokeProfile, registerSmokeSchemes, installOfflineProtocols, executeRenderer, hardenSmokeWindow, assertProductionPage, verifyAsarRenderer } = require('./smoke-harness.cjs');
const { logFixture } = require('./renderer-fixtures.cjs');

const profile = isolateSmokeProfile(app, 'botland-packaged-smoke');
registerSmokeSchemes(protocol);
// The renderer loads artwork over its own scheme; serve a tiny PNG so the
// smoke can prove the path works without reading a real Steam cache.
const artworkPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const definitions = [
  ['cod4', 'Call of Duty 4', 'CoD4', 'CoD4R / IW3x', 'mw'],
  ['waw', 'World at War', 'WaW', 'Plutonium T4', 'neutral'],
  ['mw2', 'Modern Warfare 2', 'MW2', 'IW4x', 'mw'],
  ['bo1', 'Black Ops', 'BO1', 'Plutonium T5', 'bo'],
  ['mw3', 'Modern Warfare 3', 'MW3', 'Plutonium IW5', 'mw'],
  ['bo2', 'Black Ops II', 'BO2', 'Plutonium T6', 'bo'],
];
const snapshot = {
  updatesEnabled: false, updates: {},
  plutonium: { available: true, installed: false, updating: false, lastUpdated: null, error: null },
  games: definitions.map(([id, title, short, engine, family]) => ({
    setup: { folder: id === 'cod4', engine: engine.startsWith('Plutonium') ? null : id === 'cod4', plutonium: engine.startsWith('Plutonium') ? false : null,
      key: engine.startsWith('Plutonium') ? false : null, bots: id === 'cod4', config: id === 'cod4', maps: id === 'cod4' },
    id, title, short, engine, family, subtitle: 'Synthetic test fixture',
    installed: id === 'cod4', pathSource: id === 'cod4' ? 'manual' : 'none',
    gamePath: id === 'cod4' ? 'C:\\Example\\Game' : '',
    configPath: id === 'cod4' ? 'C:\\Example\\Game\\main\\server.cfg' : '',
    keyStatus: id === 'cod4' || id === 'mw2' ? 'not-required' : 'missing',
    modBusy: false, connect: { primaryAddress: null, ambiguous: false, candidates: [] }, orphan: null,
    restart: { enabled: false, attempts: 0, nextAttemptAt: null, cutOff: false },
    config: { sv_hostname: 'Synthetic server' },
    options: { port: 28962, mode: 'dom', shuffle: true, selectedMaps: [], gamePath: '', lan: true },
    blockers: id === 'cod4' ? [] : ['Game folder not found.'], warnings: [],
    status: 'stopped', pid: null, startedAt: null, activePort: null, logs: [],
  })),
};
const documentFixture = {
  path: 'C:\\Example\\Game\\main\\server.cfg', target: 'base', mode: 'dom', sourceRepo: '',
  values: { sv_hostname: 'Synthetic server', bots_manage_fill_mode: '0', bots_manage_fill: '8' },
  entries: [
    { key: 'sv_hostname', value: 'Synthetic server', masked: false, hasValue: true, count: 1 },
    { key: 'bots_manage_fill_mode', value: '0', masked: false, hasValue: true, count: 1 },
    { key: 'bots_manage_fill', value: '8', masked: false, hasValue: true, count: 1 },
  ],
  fields: [
    { key: 'sv_hostname', sourceKey: 'sv_hostname', label: 'Server name', section: 'Server & access', type: 'text', default: 'Synthetic server' },
    { key: 'bots_manage_fill_mode', sourceKey: 'bots_manage_fill_mode', label: 'Fill mode', section: 'Bot population', type: 'select', default: '0', choices: [{ value: '0', label: 'Fill' }, { value: '1', label: 'Disabled' }] },
    { key: 'bots_manage_fill', sourceKey: 'bots_manage_fill', label: 'Fill target', section: 'Bot population', type: 'integer', min: 0, max: 64, default: '8', dependsOn: { key: 'bots_manage_fill_mode', value: '0' } },
  ],
};
let failSnapshotOnce = false;
let failMapsOnce = false;
let engineAttempts = 0;
let openDocumentAttempts = 0;
let allowMemoryConfigWrites = false;
let memoryConfig = structuredClone(documentFixture);
let memoryBackups = [];
let memoryConfigMissing = false;
let partialPrune = false;
let copyResult = true;
let copyCalls = 0;
let lastCopiedText = '';
let savedOptions = null;
let saveOptionsCalls = 0;
let deferredOptionsWrite = null;
let deferredDocumentRead = null;
let failCommitReloadOnce = false;
let deferredFirewallChange = null;
let deferredBo1StatusRead = null;
let mapsVersion = 1;
let mapInventory = ['mp_crash', 'mp_second', 'mp_third', 'mp_fourth'];
const stopCalls = [];
let bo1Rule = { name: 'botLANd BO1 UDP', port: 28961, state: 'missing' };
let botFixture = { state: 'not-installed', targetPath: 'C:\\Example\\Game\\mods', manifest: null,
  channel: 'stable', source: { supported: false, ref: null, notes: '', status: 'offline' } };

function gameSnapshot(overrides) {
  const next = structuredClone(snapshot);
  Object.assign(next.games.find(game => game.id === 'cod4'), overrides);
  return next;
}
function bo1Snapshot() {
  const next = structuredClone(snapshot);
  next.plutonium.installed = true;
  Object.assign(next.games.find(game => game.id === 'bo1'), {
    installed: true, pathSource: 'manual', gamePath: 'C:\\Example\\BO1',
    configPath: 'C:\\Example\\BO1\\main\\server.cfg', blockers: [],
    keyStatus: 'stored', setup: { folder: true, engine: null, plutonium: true, key: true,
      bots: true, config: true, maps: true },
  });
  return next;
}

async function waitFor(win, selector) {
  await executeRenderer(win, `new Promise((resolve, reject) => {
    const selector = ${JSON.stringify(selector)};
    if (document.querySelector(selector)) return resolve();
    const observer = new MutationObserver(() => {
      if (document.querySelector(selector)) { observer.disconnect(); resolve(); }
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true });
    setTimeout(() => { observer.disconnect(); reject(new Error('Renderer condition timed out: ' + selector)); }, 10000);
  })`);
}
async function waitForAbsent(win, selector) {
  await executeRenderer(win, `new Promise((resolve, reject) => {
    const selector = ${JSON.stringify(selector)};
    if (!document.querySelector(selector)) return resolve();
    const observer = new MutationObserver(() => {
      if (!document.querySelector(selector)) { observer.disconnect(); resolve(); }
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true });
    setTimeout(() => { observer.disconnect(); reject(new Error('Renderer condition timed out waiting for absence: ' + selector)); }, 10000);
  })`);
}

async function waitForCondition(win, expression) {
  await executeRenderer(win, `new Promise((resolve, reject) => {
    const check = () => { if (${expression}) { clearTimeout(timeout); resolve(); } else requestAnimationFrame(check); };
    const timeout = setTimeout(() => reject(new Error('Renderer condition timed out: ' + ${JSON.stringify(expression)})), 10000);
    check();
  })`);
}

app.whenReady().then(async () => {
  assert.equal(app.getPath('userData'), profile);
  assert.equal(app.getPath('sessionData'), profile);
  await verifyAsarRenderer(profile);
  const offline = installOfflineProtocols({ protocol, session: session.defaultSession, artwork: request => request.url.includes('/cod4/')
    ? new Response(request.method === 'HEAD' ? null : artworkPng, { headers: { 'content-type': 'image/png', 'x-content-type-options': 'nosniff' } })
    : new Response('Not found', { status: 404 }) });
  ipcMain.handle('manager:action', (_event, action, payload = {}) => {
    assert.equal(_event.sender, win.webContents);
    assert.equal(_event.senderFrame, win.webContents.mainFrame);
    switch (action) {
      case 'snapshot':
        if (failSnapshotOnce) { failSnapshotOnce = false; throw new Error('Synthetic status refresh failure.'); }
        return structuredClone(snapshot);
      case 'start': return undefined;
      case 'stop': stopCalls.push(payload.id); return undefined;
      case 'updateEngine': engineAttempts++; throw new Error('Synthetic engine update refused; no files were touched.');
      case 'setUnsavedChanges': return true;
      case 'copyText':
        copyCalls++;
        if (typeof payload.text !== 'string' || payload.text.length > 200_000) throw new Error('Invalid text to copy.');
        lastCopiedText = payload.text;
        if (copyResult === 'error') throw new Error('Synthetic clipboard failure.');
        return copyResult;
      case 'openLogs': return false;
      case 'maps':
        if (failMapsOnce) { failMapsOnce = false; throw new Error('Synthetic map scan failure.'); }
        return { maps: mapInventory.slice(0, mapsVersion), modes: [{ value: 'dom', label: 'Domination' }] };
      case 'firewallStatus': {
        const status = payload?.id === 'bo1' ? structuredClone(bo1Rule) : { name: 'botLANd CoD4 UDP', port: 28962, state: 'missing' };
        if (payload?.id === 'bo1' && deferredBo1StatusRead) return new Promise(resolve => {
          deferredBo1StatusRead.release = () => resolve(status);
          deferredBo1StatusRead.started();
        });
        return status;
      }
      case 'firewallApply':
      case 'firewallRemove': {
        if (!deferredFirewallChange || payload.id !== 'bo1') throw new Error('Synthetic smoke refuses firewall actions.');
        return new Promise(resolve => {
          deferredFirewallChange.release = () => {
            bo1Rule = { ...bo1Rule, state: action === 'firewallApply' ? 'any' : 'missing', managed: action === 'firewallApply' };
            resolve(structuredClone(bo1Rule));
          };
          deferredFirewallChange.started();
        });
      }
      case 'botStatus': return structuredClone(botFixture);
      case 'document':
        if (memoryConfigMissing) throw new Error('Synthetic config file is missing (ENOENT).');
        if (deferredDocumentRead) return new Promise(resolve => {
          deferredDocumentRead.release = () => resolve(structuredClone(memoryConfig));
          deferredDocumentRead.started();
        });
        return structuredClone(memoryConfig);
      case 'openDocument': openDocumentAttempts++; return false;
      case 'listConfigBackups': return memoryBackups.map(item => structuredClone(item.meta));
      case 'previewSettings': return { token: '0'.repeat(64), changed: true, changes: [
        { key: 'sv_hostname', label: 'Server name', before: memoryConfig.values.sv_hostname, after: payload.values.sv_hostname, duplicates: 1 },
      ] };
      // These optional write paths mutate only local JS fixtures. No filesystem,
      // game install, or real manager is available to this smoke window.
      case 'commitSettings': {
        if (!allowMemoryConfigWrites) throw new Error('Synthetic smoke refuses write actions.');
        assert.equal(payload.token, '0'.repeat(64));
        assert.equal(payload.expectedPath, memoryConfig.path);
        memoryBackups.unshift({ meta: { id: 'sample-backup', date: '2026-11-12T12:00:00.000Z', bytes: 32 }, values: structuredClone(memoryConfig.values) });
        Object.assign(memoryConfig.values, payload.values);
        memoryConfig.entries[0].value = memoryConfig.values.sv_hostname;
        if (failCommitReloadOnce) {
          failCommitReloadOnce = false;
          throw new Error('The configuration was saved, but it could not be reloaded: synthetic follow-up read failure.');
        }
        return structuredClone(memoryConfig);
      }
      case 'previewConfigRestore': {
        assert.ok(memoryBackups.some(item => item.meta.id === payload.backupId));
        return { token: '1'.repeat(64), summary: { changed: true, currentBytes: memoryConfigMissing ? 0 : 48, backupBytes: 32, ...(memoryConfigMissing ? { missing: true } : {}) } };
      }
      case 'restoreConfigBackup': {
        if (!allowMemoryConfigWrites) throw new Error('Synthetic smoke refuses write actions.');
        assert.equal(payload.token, '1'.repeat(64));
        const wasMissing = memoryConfigMissing;
        memoryConfigMissing = false;
        memoryConfig.values = structuredClone(memoryBackups.find(item => item.meta.id === payload.backupId).values);
        memoryConfig.entries[0].value = memoryConfig.values.sv_hostname;
        return { backupId: wasMissing ? null : payload.backupId };
      }
      case 'pruneConfigBackups': {
        if (!allowMemoryConfigWrites) throw new Error('Synthetic smoke refuses write actions.');
        const chosen = new Set(payload.ids);
        assert.ok(chosen.size && payload.ids.every(id => memoryBackups.some(item => item.meta.id === id)));
        const remove = partialPrune ? [payload.ids[0]] : payload.ids;
        memoryBackups = memoryBackups.filter(item => !remove.includes(item.meta.id));
        if (partialPrune) throw new Error(`Removed 1 of ${payload.ids.length} backups; the rest could not be removed (synthetic locked backup).`);
        return { removed: remove.length };
      }
      case 'saveOptions': {
        if (!allowMemoryConfigWrites) throw new Error('Synthetic smoke refuses write actions.');
        saveOptionsCalls++;
        const values = structuredClone(payload.values);
        const finish = () => {
          savedOptions = values;
          Object.assign(snapshot.games[0].options, values);
          win.webContents.send('manager:event', { type: 'state', snapshot: structuredClone(snapshot) });
        };
        if (deferredOptionsWrite) return new Promise(resolve => {
          deferredOptionsWrite.release = () => { finish(); resolve(); };
          deferredOptionsWrite.started();
        });
        finish();
        return undefined;
      }
      default: throw new Error('Synthetic smoke refuses write actions.');
    }
  });
  const win = new BrowserWindow({ width: 640, height: 900, show: false, backgroundColor: '#1B1A19',
    webPreferences: { preload: path.join(__dirname, '..', 'electron', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, offscreen: true } });
  hardenSmokeWindow(win);
  // A packaged window whose preload failed must explain the problem instead of
  // throwing while React mounts. Keep the main window alive while this window is
  // destroyed, or Electron quits before the rest of the smoke can run.
  const fallbackWin = new BrowserWindow({ width: 640, height: 900, show: false, backgroundColor: '#1B1A19',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  hardenSmokeWindow(fallbackWin);
  try {
    await fallbackWin.loadURL(rendererEntryUrl);
    await assertProductionPage(fallbackWin, { bridge: false });
    await waitFor(fallbackWin, '.startup-error');
    const fallbackText = await fallbackWin.webContents.executeJavaScript('document.body.textContent');
    assert.match(fallbackText, /could not connect to its desktop process/i);
  } finally { fallbackWin.destroy(); }
  try {
    await win.loadURL(rendererEntryUrl);
    await assertProductionPage(win);
    await waitFor(win, '.server-card .card-open');
    const dashboard = await executeRenderer(win, `({
      cards: document.querySelectorAll('.server-card').length,
      missing: document.querySelectorAll('.missing-row').length,
      width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
    })`);
    assert.equal(dashboard.cards, 1);
    assert.equal(dashboard.missing, 5);
    await waitForCondition(win, `document.querySelector('.server-card .card-art')?.classList.contains('has-image')`);
    const artwork = await executeRenderer(win, `({
      cover: document.querySelector('.server-card .card-art-image')?.getAttribute('src'),
      logo: document.querySelector('.server-card .card-logo')?.getAttribute('src'),
      dataImages: document.querySelectorAll('img[src^="data:image"]').length,
      inlineData: [...document.querySelectorAll('[style]')].filter(el => (el.getAttribute('style') || '').includes('data:image')).length,
    })`);
    assert.match(artwork.cover, /^botland-art:\/\/artwork\/cod4\/cover\?v=/, 'covers load over the artwork scheme');
    assert.match(artwork.logo, /^botland-art:\/\/artwork\/cod4\/logo\?v=/, 'logos load over the artwork scheme');
    assert.equal(artwork.dataImages, 0, 'no image bytes are embedded as data URLs');
    assert.equal(artwork.inlineData, 0, 'no artwork bytes are embedded in inline styles');
    assert.equal(await executeRenderer(win, "document.querySelector('.card-visibility')?.textContent"), 'NEXT: LAN', 'Saved visibility must not be presented as the running server state');
    assert.ok(dashboard.scrollWidth <= dashboard.width, 'Dashboard must not clip at a 640-DIP window');
    const pointerTargets = await executeRenderer(win, `(() => {
      const size = selector => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      };
      return { refresh: size('.topbar .icon-button'), manage: size('.server-card .card-open') };
    })()`);
    assert.ok(pointerTargets.refresh.width >= 38 && pointerTargets.refresh.height >= 38);
    assert.ok(pointerTargets.manage.height >= 36);
    // The card is a mouse shortcut, not an extra tab stop; MANAGE is its named control.
    const cardAccessibility = await executeRenderer(win, `(() => {
      const card = document.querySelector('.server-card');
      return { role: card?.getAttribute('role'), tabIndex: card?.tabIndex, manage: card?.querySelector('.card-open')?.getAttribute('aria-label') };
    })()`);
    assert.equal(cardAccessibility.role, null);
    assert.equal(cardAccessibility.tabIndex, -1);
    assert.equal(cardAccessibility.manage, 'Manage Call of Duty 4');
    await executeRenderer(win, "document.querySelector('.server-card .card-art').click()");
    await waitFor(win, '.detail-tabs');
    await executeRenderer(win, "document.querySelector('.sidebar > .nav-item').click()");
    await waitFor(win, '.server-card');
    failSnapshotOnce = true;
    await executeRenderer(win, "document.querySelector('.server-card .primary-button').click()");
    await waitFor(win, '.notice');
    const refreshNotice = await executeRenderer(win, "document.querySelector('.notice')?.textContent || ''");
    assert.match(refreshNotice, /Action completed/i);
    assert.match(refreshNotice, /could not be refreshed/i);
    await executeRenderer(win, "document.querySelector('.notice button').click()");
    await waitForAbsent(win, '.notice');
    await executeRenderer(win, "document.querySelector('.server-card .card-open').click()");
    await waitFor(win, '.detail-tabs');
    await waitForCondition(win, `document.querySelector('.detail-hero-image')?.complete`);
    assert.match(await executeRenderer(win, "document.querySelector('.detail-hero-image')?.getAttribute('src')"), /^botland-art:\/\/artwork\/cod4\/hero\?v=/, 'the game header loads over the artwork scheme');
    const manageFocus = await executeRenderer(win, "({ active: document.activeElement?.tagName, label: document.querySelector('main')?.getAttribute('aria-label') })");
    assert.equal(manageFocus.active, 'MAIN');
    assert.equal(manageFocus.label, 'Call of Duty 4 — Overview');
    const heading = await executeRenderer(win, "document.querySelector('.detail-hero h1').textContent");
    assert.equal(heading, 'Call of Duty 4');
    assert.match(await executeRenderer(win, "document.querySelector('.visibility-switch')?.getAttribute('aria-label')"), /next start/);
    // Reduced motion must stop infinite status spins, not accelerate them into
    // a .01ms infinite animation. Emulation touches this synthetic page only.
    win.webContents.debugger.attach('1.3');
    try {
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      const motion = await executeRenderer(win, `(() => {
        const icon = document.createElement('span'); icon.className = 'busy-spin'; document.body.append(icon);
        const style = getComputedStyle(icon);
        const result = { reduced: matchMedia('(prefers-reduced-motion: reduce)').matches, iterations: style.animationIterationCount, duration: style.animationDuration };
        icon.remove(); return result;
      })()`);
      assert.equal(motion.reduced, true);
      assert.equal(motion.iterations, '1');
      assert.ok(parseFloat(motion.duration) <= 0.00001);
    } finally { win.webContents.debugger.detach(); }
    // At the short minimum desktop size, every game section must fit without
    // horizontal page scrolling (vertical scrolling and tab-strip scrolling are fine).
    win.setSize(640, 600);
    await executeRenderer(win, `new Promise((resolve, reject) => {
      const check = () => innerHeight < 650 ? requestAnimationFrame(resolve) : requestAnimationFrame(check);
      check(); setTimeout(() => reject(new Error('Short-window resize did not complete')), 10000);
    })`);
    for (const [label, selector] of [
      ['Overview', '.setup-wizard'], ['Configuration', '.config-field-grid input'],
      ['Maps & modes', '.rotation-panel'], ['Console', '.console-panel'],
    ]) {
      if (label !== 'Overview') await executeRenderer(win, `([...document.querySelectorAll('.detail-tabs button')].find(button => button.textContent.includes(${JSON.stringify(label)}))).click()`);
      await waitFor(win, `main[aria-label="Call of Duty 4 — ${label}"] ${selector}`);
      const bounds = await executeRenderer(win, '({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth })');
      assert.ok(bounds.scrollWidth <= bounds.width, `${label} must not clip at a 640×600-DIP window: ${JSON.stringify(bounds)}`);
    }
    win.setSize(640, 900);
    await executeRenderer(win, "(() => { const tab = [...document.querySelectorAll('.detail-tabs button')].find(button => button.textContent.includes('Configuration')); tab.focus(); tab.click(); })()");
    await waitFor(win, '.config-field-grid input');
    // Switching tabs keeps focus on the activated tab instead of jumping to <main>.
    const tabFocus = await executeRenderer(win, "({ active: document.activeElement?.textContent || '', label: document.querySelector('main')?.getAttribute('aria-label') })");
    assert.equal(tabFocus.active, 'Configuration');
    assert.equal(tabFocus.label, 'Call of Duty 4 — Configuration');
    await executeRenderer(win, "(() => { const game = document.querySelector('.game-nav-item'); game.focus(); game.click(); })()");
    await waitFor(win, '.setup-wizard');
    const sameGameNavigationFocus = await executeRenderer(win, "({ active: document.activeElement?.tagName, label: document.querySelector('main')?.getAttribute('aria-label') })");
    assert.equal(sameGameNavigationFocus.active, 'MAIN');
    assert.equal(sameGameNavigationFocus.label, 'Call of Duty 4 — Overview');
    await executeRenderer(win, "([...document.querySelectorAll('.detail-tabs button')].find(button => button.textContent.includes('Configuration'))).click()");
    await waitFor(win, '.config-field-grid input');
    const width = await executeRenderer(win, '({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth })');
    assert.ok(width.scrollWidth <= width.width, 'Configuration must not clip at a 640-DIP window');
    await executeRenderer(win, `(() => {
      const input = document.querySelector('.config-field-grid input');
      const props = Object.keys(input).find(key => key.startsWith('__reactProps$'));
      input[props].onChange({ target: { value: 'Synthetic edited name' } });
    })()`);
    await waitFor(win, '.config-savebar button:not(:disabled)');
    const unsavedStart = await executeRenderer(win, `({
      disabled: document.querySelector('.detail-hero-action .primary-button')?.disabled,
      reason: document.querySelector('.detail-hero-action .primary-button')?.title,
      name: document.querySelector('.detail-hero-action .primary-button')?.getAttribute('aria-label'),
    })`);
    assert.equal(unsavedStart.disabled, true, 'Start must not silently ignore an unsaved config draft');
    assert.match(unsavedStart.reason, /Save or discard changes/);
    assert.equal(unsavedStart.name, 'Start server for Call of Duty 4');
    await executeRenderer(win, "(() => { const button = document.querySelector('.config-savebar button'); button.focus(); button.click(); })()");
    await waitFor(win, 'dialog[open]');
    const focused = await executeRenderer(win, "document.querySelector('dialog')?.contains(document.activeElement)");
    assert.equal(focused, true, 'Review dialog must take focus');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'TAB' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'TAB' });
    const trapped = await executeRenderer(win, "document.querySelector('dialog')?.contains(document.activeElement)");
    assert.equal(trapped, true, 'Tab must stay inside the review dialog');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ESC' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ESC' });
    await executeRenderer(win, `new Promise((resolve, reject) => {
      let attempts = 0;
      const timer = setInterval(() => {
        if (!document.querySelector('dialog[open]') && document.activeElement?.textContent?.includes('Review changes')) {
          clearInterval(timer); resolve(true);
        } else if (++attempts > 100) { clearInterval(timer); reject(new Error('Review focus did not return: ' + document.activeElement?.outerHTML?.slice(0, 300) + '; dialog=' + !!document.querySelector('dialog[open]'))); }
      }, 50);
    })`);
    // A rejected commit closes the review but retains the edited draft and
    // reports an actionable error; the synthetic IPC never writes a config.
    await executeRenderer(win, "(() => { const button = document.querySelector('.config-savebar button'); button.focus(); button.click(); })()");
    await waitFor(win, 'dialog[open]');
    await executeRenderer(win, "document.querySelector('dialog .review-actions .primary-button').click()");
    await waitForAbsent(win, 'dialog[open]');
    await waitFor(win, '.config-main .config-notice.error');
    assert.equal(await executeRenderer(win, "document.querySelector('.config-field-grid input')?.value"), 'Synthetic edited name');
    const guardedClose = await executeRenderer(win, `(() => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    })()`);
    assert.equal(guardedClose, true, 'Unsaved configuration edits must guard window close');
    win.webContents.send('manager:event', { type: 'state', snapshot: gameSnapshot({
      gamePath: 'C:\\Example\\MovedGame', configPath: 'C:\\Example\\MovedGame\\main\\server.cfg',
    }) });
    await waitFor(win, '.config-path-warning');
    const conflictedFile = await executeRenderer(win, `({
      label: document.querySelector('.config-file-label')?.textContent,
      shown: document.querySelector('.config-file-path')?.textContent,
      disabled: document.querySelector('.config-aside .full-width')?.disabled,
      draft: document.querySelector('.config-field-grid input')?.value,
    })`);
    assert.equal(conflictedFile.label, 'DRAFT FROM PREVIOUS FOLDER');
    assert.equal(conflictedFile.shown, documentFixture.path);
    assert.equal(conflictedFile.disabled, true, 'Cannot open a new location while showing an old file');
    assert.equal(conflictedFile.draft, 'Synthetic edited name');
    await executeRenderer(win, "document.querySelector('.config-aside .full-width').click()");
    assert.equal(openDocumentAttempts, 0);
    win.webContents.send('manager:event', { type: 'state', snapshot: gameSnapshot({}) });
    await waitForAbsent(win, '.config-path-warning');
    assert.equal(await executeRenderer(win, "document.querySelector('.config-aside .full-width')?.disabled"), false);

    // Complete a commit and restore against memory-only IPC fixtures; no disk
    // writes are permitted by this test harness.
    allowMemoryConfigWrites = true;
    await executeRenderer(win, "document.querySelector('.config-savebar button').click()");
    await waitFor(win, 'dialog[open]');
    await executeRenderer(win, "document.querySelector('dialog .review-actions .primary-button').click()");
    await waitForAbsent(win, 'dialog[open]');
    await waitFor(win, '.config-backup');
    await waitForCondition(win, "document.querySelector('.config-notice.success')?.textContent.includes('Saved 1 change') && document.activeElement === document.querySelector('.config-notice.success')");
    assert.equal(await executeRenderer(win, "document.querySelector('.config-field-grid input')?.value"), 'Synthetic edited name');
    await executeRenderer(win, "document.querySelector('.config-backup button').click()");
    await waitFor(win, 'dialog[open]');
    assert.match(await executeRenderer(win, "document.querySelector('#restore-description')?.textContent"), /replaced with the selected backup/);
    await executeRenderer(win, "document.querySelector('dialog .review-actions .primary-button').click()");
    await waitForAbsent(win, 'dialog[open]');
    await executeRenderer(win, `new Promise((resolve, reject) => {
      const check = () => document.querySelector('.config-field-grid input')?.value === 'Synthetic server';
      if (check()) return resolve();
      const observer = new MutationObserver(() => { if (check()) { observer.disconnect(); resolve(); } });
      observer.observe(document.body, { subtree: true, childList: true, attributes: true });
      setTimeout(() => { observer.disconnect(); reject(new Error('Restored config did not reload: ' + JSON.stringify({ input: document.querySelector('.config-field-grid input')?.value, notice: document.querySelector('.config-main .config-notice')?.textContent, dialog: !!document.querySelector('dialog[open]') }))); }, 10000);
    })`);
    assert.equal(memoryConfig.values.sv_hostname, 'Synthetic server');
    await verifyRecoveryAndPartialPrune(win);

    // A dependent edit must be reset identically whether its parent is changed
    // through Guided or All existing settings.
    for (const advanced of [false, true]) {
      await executeRenderer(win, `(() => {
        const input = document.querySelector('.config-groups input[type=number]');
        input[Object.keys(input).find(key => key.startsWith('__reactProps$'))].onChange({ target: { value: '12' } });
      })()`);
      await waitForCondition(win, "document.querySelector('.config-savebar')?.textContent.includes('1 unsaved change')");
      if (advanced) {
        await executeRenderer(win, "[...document.querySelectorAll('.config-switch button')].find(button => button.textContent.includes('All existing')).click()");
        await waitFor(win, 'input[aria-label="Value for bots_manage_fill_mode"]');
      }
      const parentSelector = advanced ? 'input[aria-label="Value for bots_manage_fill_mode"]' : '.config-groups select';
      await executeRenderer(win, `(() => {
        const input = document.querySelector(${JSON.stringify(parentSelector)});
        input[Object.keys(input).find(key => key.startsWith('__reactProps$'))].onChange({ target: { value: '1' } });
      })()`);
      await waitForCondition(win, "document.querySelector('.config-savebar')?.textContent.includes('1 unsaved change')");
      if (advanced) assert.equal(await executeRenderer(win, "document.querySelector('input[aria-label=\"Value for bots_manage_fill\"]')?.value"), '8');
      else assert.equal(await executeRenderer(win, "document.querySelector('.config-groups input[type=number]')"), null);
      await executeRenderer(win, `(() => {
        const input = document.querySelector(${JSON.stringify(parentSelector)});
        input[Object.keys(input).find(key => key.startsWith('__reactProps$'))].onChange({ target: { value: '0' } });
        if (${advanced}) document.querySelector('.config-switch button').click();
      })()`);
      await waitFor(win, '.config-groups input[type=number]');
      await waitForCondition(win, "document.querySelector('.config-savebar button')?.disabled === true");
      assert.equal(await executeRenderer(win, "document.querySelector('.config-groups input[type=number]')?.value"), '8');
    }

    // The mutation has succeeded even when its follow-up read fails. Defer the
    // recovery read, then verify the outcome survives loading and is in view.
    await executeRenderer(win, `(() => {
      const input = document.querySelector('.config-field-grid input');
      input[Object.keys(input).find(key => key.startsWith('__reactProps$'))].onChange({ target: { value: 'Synthetic recovery name' } });
    })()`);
    await waitFor(win, '.config-savebar button:not(:disabled)');
    await executeRenderer(win, "document.querySelector('.config-savebar button').click()");
    await waitFor(win, 'dialog[open]');
    failCommitReloadOnce = true;
    const recoveryStarted = new Promise(resolve => { deferredDocumentRead = { started: resolve, release: null }; });
    await executeRenderer(win, "document.querySelector('dialog .review-actions .primary-button').click()");
    await recoveryStarted;
    await waitForAbsent(win, '.config-savebar');
    const releaseRecovery = deferredDocumentRead.release;
    deferredDocumentRead = null;
    releaseRecovery();
    await waitFor(win, '.config-field-grid input');
    await waitForCondition(win, "document.querySelector('.config-notice.error')?.textContent.includes('Settings have now been reloaded') && document.activeElement === document.querySelector('.config-notice.error')");
    const recovered = await executeRenderer(win, `(() => {
      const notice = document.querySelector('.config-notice.error');
      const bounds = notice.getBoundingClientRect();
      return { text: notice.textContent, top: bounds.top, bottom: bounds.bottom, height: innerHeight,
        draft: document.querySelector('.config-field-grid input')?.value, disabled: document.querySelector('.config-savebar button')?.disabled };
    })()`);
    assert.match(recovered.text, /configuration was saved, but it could not be reloaded/i);
    assert.equal(recovered.draft, 'Synthetic recovery name');
    assert.equal(recovered.disabled, true, 'A completed save must not remain retryable as an unsaved draft');
    assert.ok(recovered.top >= 0 && recovered.bottom <= recovered.height, 'Commit errors must be scrolled into view');
    await executeRenderer(win, `(() => {
      const input = document.querySelector('.config-field-grid input');
      const props = Object.keys(input).find(key => key.startsWith('__reactProps$'));
      input[props].onChange({ target: { value: 'Synthetic edited name' } });
    })()`);
    await waitFor(win, '.config-savebar button:not(:disabled)');

    // A running server whose install disappears must keep a visible Stop control
    // and remain counted as live.
    const unavailable = gameSnapshot({ installed: false, status: 'running', pid: 4321, activePort: 28962,
      startedAt: new Date().toISOString(), blockers: ['Synthetic game folder became unavailable.'] });
    win.webContents.send('manager:event', { type: 'state', snapshot: unavailable });
    await waitFor(win, '.detail-hero-action .stop-button');
    assert.equal(await executeRenderer(win, "document.querySelectorAll('.detail-hero-action .stop-button').length"), 1);
    const retainedConfig = await executeRenderer(win, `({
      tab: document.querySelector('main')?.getAttribute('aria-label'),
      draft: document.querySelector('.config-field-grid input')?.value,
      saveDisabled: document.querySelector('.config-savebar button')?.disabled,
      warning: document.querySelector('.config-notice.error')?.textContent,
    })`);
    assert.equal(retainedConfig.tab, 'Call of Duty 4 — Configuration');
    assert.equal(retainedConfig.draft, 'Synthetic edited name', 'Installation loss must not discard an unsaved config edit');
    assert.equal(retainedConfig.saveDisabled, true, 'Saving must wait for the folder to return');
    assert.match(retainedConfig.warning, /game folder is unavailable/i);
    await executeRenderer(win, "window.confirm = () => false; document.querySelector('.detail-back button').click()");
    assert.equal(await executeRenderer(win, "document.querySelector('main')?.getAttribute('aria-label')"), retainedConfig.tab,
      'Declining discard must leave the editor open');
    await executeRenderer(win, "window.confirm = () => true; document.querySelector('.detail-back button').click()");
    await waitFor(win, '.server-card .stop-button');
    const unavailableDashboard = await executeRenderer(win, `({
      cards: document.querySelectorAll('.server-card').length,
      missing: document.querySelectorAll('.missing-row').length,
      running: document.querySelectorAll('.stat-card')[1]?.querySelector('strong')?.textContent || '',
      stopButtons: document.querySelectorAll('.server-card .stop-button').length,
    })`);
    assert.equal(unavailableDashboard.cards, 1, 'A running unavailable game must remain on the dashboard');
    assert.equal(unavailableDashboard.missing, 5, 'A running unavailable game must not move to Not detected');
    assert.match(unavailableDashboard.running, /01/, 'A running unavailable game must remain in the live count');
    assert.equal(unavailableDashboard.stopButtons, 1, 'The dashboard must retain its Stop control');

    // Returning the same game path to service must trigger a fresh map scan, not
    // silently reuse a stale cache.
    await executeRenderer(win, "document.querySelector('.server-card .card-open').click()");
    await waitFor(win, '.detail-hero-action .stop-button');
    win.webContents.send('manager:event', { type: 'state', snapshot: gameSnapshot({ installed: true, status: 'running', pid: 4321,
      activePort: 28962, startedAt: new Date().toISOString(), blockers: [] }) });
    await waitFor(win, '.detail-tabs button:nth-child(3):not(:disabled)');
    await executeRenderer(win, "[...document.querySelectorAll('.detail-tabs button')].find(button => button.textContent.includes('Maps & modes')).click()");
    await waitFor(win, '.map-option');
    await executeRenderer(win, "document.querySelector('.map-option').click()");
    await waitFor(win, '.rotation-panel .form-footer-actions button.outline-button');
    mapsVersion = 2;
    win.webContents.send('manager:event', { type: 'state', snapshot: gameSnapshot({ installed: false, status: 'running', pid: 4321,
      activePort: 28962, startedAt: new Date().toISOString(), blockers: ['Synthetic game folder became unavailable.'] }) });
    await waitForAbsent(win, '.map-option');
    assert.match(await executeRenderer(win, "document.querySelector('main')?.getAttribute('aria-label')"), /Maps & modes/,
      'An unavailable folder must not close an editor with unsaved rotation changes');
    win.webContents.send('manager:event', { type: 'state', snapshot: gameSnapshot({ installed: true, status: 'running', pid: 4321,
      activePort: 28962, startedAt: new Date().toISOString(), blockers: [] }) });
    await waitFor(win, '.map-grid .map-option:nth-child(2)');
    const rescannedMaps = await executeRenderer(win, "document.querySelectorAll('.map-option').length");
    assert.equal(rescannedMaps, 2);
    assert.equal(await executeRenderer(win, "document.querySelectorAll('.map-option.chosen').length"), 0,
      'A refreshed map scan must not replace unsaved rotation changes');
    // A failed rescan must clear stale results, block Save, and offer a retry.
    failMapsOnce = true;
    win.webContents.send('manager:event', { type: 'state', snapshot: gameSnapshot({ installed: false, status: 'running', pid: 4321,
      activePort: 28962, startedAt: new Date().toISOString(), blockers: ['Synthetic game folder became unavailable.'] }) });
    await waitForAbsent(win, '.map-option');
    win.webContents.send('manager:event', { type: 'state', snapshot: gameSnapshot({ installed: true, status: 'running', pid: 4321,
      activePort: 28962, startedAt: new Date().toISOString(), blockers: [] }) });
    await waitFor(win, '.map-scan-error button');
    assert.equal(await executeRenderer(win, "document.querySelector('.rotation-panel .primary-button')?.disabled"), true);
    assert.equal(await executeRenderer(win, "document.querySelectorAll('.map-option').length"), 0);
    await executeRenderer(win, "document.querySelector('.map-scan-error button').click()");
    await waitFor(win, '.map-grid .map-option:nth-child(2)');
    await executeRenderer(win, "document.querySelector('.map-tools button').click()");
    await waitFor(win, '.map-option.chosen:nth-child(2)');
    // A port-only edit with all maps selected must still include new maps after
    // a rescan; saving should keep the empty-list 'every installed map' intent.
    await executeRenderer(win, `(() => {
      const input = document.querySelector('.rotation-controls input[type=number]');
      const props = Object.keys(input).find(key => key.startsWith('__reactProps$'));
      input[props].onChange({ target: { value: '28965' } });
    })()`);
    mapsVersion = 3;
    win.webContents.send('manager:event', { type: 'state', snapshot: gameSnapshot({ installed: false, status: 'running', pid: 4321,
      activePort: 28962, startedAt: new Date().toISOString(), blockers: ['Folder unavailable.'] }) });
    await waitForAbsent(win, '.map-option');
    win.webContents.send('manager:event', { type: 'state', snapshot: gameSnapshot({ installed: true, status: 'running', pid: 4321,
      activePort: 28962, startedAt: new Date().toISOString(), blockers: [] }) });
    await waitFor(win, '.map-grid .map-option:nth-child(3)');
    assert.equal(await executeRenderer(win, "document.querySelectorAll('.map-option.chosen').length"), 3,
      'All-map draft must adopt newly installed maps without losing the port edit');
    await executeRenderer(win, "document.querySelector('.rotation-panel .primary-button').click()");
    await executeRenderer(win, `new Promise((resolve, reject) => {
      const check = () => document.querySelector('.rotation-panel .primary-button')?.disabled;
      if (check()) return resolve();
      const observer = new MutationObserver(() => { if (check()) { observer.disconnect(); resolve(); } });
      observer.observe(document.body, { subtree: true, childList: true, attributes: true });
      setTimeout(() => { observer.disconnect(); reject(new Error('Map draft save did not finish')); }, 10000);
    })`);
    assert.deepEqual(savedOptions.selectedMaps, [], 'All maps must save as an open-ended selection');
    // A deliberate subset, by contrast, must not gain maps discovered later.
    await executeRenderer(win, "document.querySelector('.map-option:nth-child(2)').click()");
    await waitFor(win, '.map-option:not(.chosen)');
    mapsVersion = 4;
    win.webContents.send('manager:event', { type: 'state', snapshot: gameSnapshot({ installed: false, status: 'running', pid: 4321,
      activePort: 28962, startedAt: new Date().toISOString(), blockers: ['Folder unavailable.'] }) });
    await waitForAbsent(win, '.map-option');
    win.webContents.send('manager:event', { type: 'state', snapshot: gameSnapshot({ installed: true, status: 'running', pid: 4321,
      activePort: 28962, startedAt: new Date().toISOString(), blockers: [] }) });
    await waitFor(win, '.map-grid .map-option:nth-child(4)');
    assert.equal(await executeRenderer(win, "document.querySelectorAll('.map-option.chosen').length"), 2,
      'An explicit subset must remain unchanged on rescan');
    await executeRenderer(win, "document.querySelector('.rotation-panel .primary-button').click()");
    await executeRenderer(win, `new Promise((resolve, reject) => {
      const check = () => document.querySelector('.rotation-panel .primary-button')?.disabled;
      if (check()) return resolve();
      const observer = new MutationObserver(() => { if (check()) { observer.disconnect(); resolve(); } });
      observer.observe(document.body, { subtree: true, childList: true, attributes: true });
      setTimeout(() => { observer.disconnect(); reject(new Error('Subset save did not finish')); }, 10000);
    })`);
    assert.deepEqual(savedOptions.selectedMaps, ['mp_crash', 'mp_third']);
    // A dirty explicit subset can lose a selected map during a rescan. Keep the
    // missing choice visible as an error, and never send a truncated selection.
    const optionsBeforeMissingMap = saveOptionsCalls;
    await executeRenderer(win, "document.querySelector('.map-option:nth-child(4)').click()");
    await waitFor(win, '.map-option.chosen:nth-child(4)');
    mapInventory = ['mp_crash', 'mp_second', 'mp_third'];
    mapsVersion = 3;
    win.webContents.send('manager:event', { type: 'state', snapshot: gameSnapshot({ installed: false, status: 'running', pid: 4321,
      activePort: 28962, startedAt: new Date().toISOString(), blockers: ['Folder unavailable.'] }) });
    await waitForAbsent(win, '.map-option');
    win.webContents.send('manager:event', { type: 'state', snapshot: gameSnapshot({ installed: true, status: 'running', pid: 4321,
      activePort: 28962, startedAt: new Date().toISOString(), blockers: [] }) });
    await waitFor(win, '.map-grid .map-option:nth-child(3)');
    await waitFor(win, '.rotation-panel .config-notice.error');
    const vanishedMap = await executeRenderer(win, `({
      warning: document.querySelector('.rotation-panel .config-notice.error')?.textContent,
      selected: document.querySelector('.map-heading h3')?.textContent,
      disabled: document.querySelector('.rotation-panel .primary-button')?.disabled,
    })`);
    assert.match(vanishedMap.warning, /1 selected map disappeared after the rescan.*Clear or reselect maps before saving/i);
    assert.match(vanishedMap.selected, /3 \/ 3 maps selected/);
    assert.equal(vanishedMap.disabled, true, 'A missing draft map must block Save');
    await executeRenderer(win, "document.querySelector('.rotation-panel .primary-button').click()");
    assert.equal(saveOptionsCalls, optionsBeforeMissingMap, 'Save must not call IPC with a vanished selected map');
    await executeRenderer(win, "document.querySelectorAll('.map-tools button')[1].click()");
    await waitForAbsent(win, '.rotation-panel .config-notice.error');
    await executeRenderer(win, "document.querySelector('.map-option:nth-child(2)').click()");
    await waitFor(win, '.map-option.chosen:nth-child(2)');
    assert.equal(await executeRenderer(win, "document.querySelector('.rotation-panel .primary-button')?.disabled"), false);

    // A folder move cannot silently retarget a draft to a different install,
    // even when a fresh scan finds exactly the same map names there.
    const portBeforeMove = await executeRenderer(win, "document.querySelector('.rotation-controls input[type=number]')?.value");
    win.webContents.send('manager:event', { type: 'state', snapshot: gameSnapshot({
      gamePath: 'C:\\Example\\MovedGame', configPath: 'C:\\Example\\MovedGame\\main\\server.cfg',
      options: { ...snapshot.games[0].options, port: 28970 }, status: 'running', pid: 4321, activePort: 28962,
    }) });
    await waitFor(win, '.rotation-path-warning');
    await waitFor(win, '.map-grid .map-option:nth-child(3)');
    const movedRotation = await executeRenderer(win, `({
      port: document.querySelector('.rotation-controls input[type=number]')?.value,
      disabled: document.querySelector('.rotation-panel .primary-button')?.disabled,
      selected: [...document.querySelectorAll('.map-option.chosen small')].map(item => item.textContent),
    })`);
    assert.equal(movedRotation.port, portBeforeMove, 'A snapshot option update cannot overwrite the old-folder draft');
    assert.equal(movedRotation.disabled, true);
    assert.deepEqual(movedRotation.selected, ['mp_second']);
    await executeRenderer(win, "document.querySelector('.rotation-panel .primary-button').click()");
    assert.equal(saveOptionsCalls, optionsBeforeMissingMap);
    win.webContents.send('manager:event', { type: 'state', snapshot: gameSnapshot({ status: 'running', pid: 4321, activePort: 28962 }) });
    await waitForAbsent(win, '.rotation-path-warning');
    await waitFor(win, '.rotation-panel .primary-button:not(:disabled)');

    // Hold the in-memory rotation write unresolved: a global write busy flag
    // must not disable the independent Stop or Cancel start safety controls.
    const optionsWriteStarted = new Promise(resolve => { deferredOptionsWrite = { started: resolve, release: null }; });
    await executeRenderer(win, "document.querySelector('.rotation-panel .primary-button').click()");
    await optionsWriteStarted;
    await waitFor(win, '.busy-indicator');
    assert.equal(saveOptionsCalls, optionsBeforeMissingMap + 1, 'Reselecting available maps must permit Save');
    assert.equal(await executeRenderer(win, "[...document.querySelectorAll('.rotation-controls input, .rotation-controls select, .toggle input, .map-tools button, .map-option')].every(input => input.disabled)"), true,
      'The rotation form must lock its own edits until the deferred save settles');
    await executeRenderer(win, "document.querySelector('.map-option').click(); [...document.querySelectorAll('.detail-tabs button')].find(button => button.textContent.includes('Overview')).click()");
    assert.match(await executeRenderer(win, "document.querySelector('main')?.getAttribute('aria-label')"), /Maps & modes/);
    assert.equal(await executeRenderer(win, "document.querySelectorAll('.map-option.chosen').length"), 1, 'A pending save cannot admit newer map edits that its completion would overwrite');
    assert.equal(await executeRenderer(win, "document.querySelector('.detail-hero-action .stop-button')?.disabled"), false);
    await executeRenderer(win, "window.confirm = () => true; document.querySelector('.detail-hero-action .stop-button').click()");
    await waitFor(win, '.detail-hero-action .primary-button');
    assert.deepEqual(stopCalls, ['cod4'], 'Stop must reach IPC while an unrelated write is pending');
    win.webContents.send('manager:event', { type: 'state', snapshot: gameSnapshot({ installed: true, status: 'starting',
      pid: null, activePort: 28962, startedAt: null, blockers: [] }) });
    await waitFor(win, '.detail-hero-action .stop-button');
    const cancelWhileBusy = await executeRenderer(win, `({
      text: document.querySelector('.detail-hero-action .stop-button')?.textContent?.trim(),
      disabled: document.querySelector('.detail-hero-action .stop-button')?.disabled,
      busy: !!document.querySelector('.busy-indicator'),
    })`);
    assert.equal(cancelWhileBusy.text, 'Cancel start');
    assert.equal(cancelWhileBusy.disabled, false);
    assert.equal(cancelWhileBusy.busy, true, 'The unrelated write must still be pending');
    await executeRenderer(win, "document.querySelector('.detail-hero-action .stop-button').click()");
    await waitFor(win, '.detail-hero-action .primary-button');
    assert.deepEqual(stopCalls, ['cod4', 'cod4'], 'Cancel start must reach IPC while an unrelated write is pending');
    const releaseOptionsWrite = deferredOptionsWrite.release;
    deferredOptionsWrite = null;
    releaseOptionsWrite();
    await waitForAbsent(win, '.busy-indicator');
    assert.deepEqual(savedOptions.selectedMaps, ['mp_second']);
    // Verify connect panel copy, stopping state, and starting state
    win.webContents.send('manager:event', { type: 'state', snapshot: gameSnapshot({ installed: true, status: 'running', pid: 4321,
      activePort: 28962, startedAt: new Date().toISOString(), blockers: [] }) });
    await executeRenderer(win, "[...document.querySelectorAll('.detail-tabs button')].find(button => button.textContent.includes('Overview')).click()");
    await waitFor(win, '.connect-panel');
    const connectSnap = gameSnapshot({
      installed: true, status: 'running', pid: 4321, activePort: 28962, startedAt: new Date().toISOString(), blockers: [],
      connect: {
        primaryAddress: null, ambiguous: true,
        candidates: [
          { adapter: 'Eth0', address: '192.168.1.10', scope: 'private', label: 'Local', connectAddress: '192.168.1.10:28962' },
          { adapter: 'Eth1', address: '10.0.0.5', scope: 'private', label: 'VPN', connectAddress: '10.0.0.5:28962' },
        ],
      },
    });
    win.webContents.send('manager:event', { type: 'state', snapshot: connectSnap });
    await waitFor(win, '.connect-row code');
    const connectPlaceholder = await executeRenderer(win, "document.querySelector('.connect-row code')?.textContent || ''");
    assert.equal(connectPlaceholder, 'Choose an interface above', 'Connect panel must direct the user to the dropdown above');

    // Stopping server must keep the stop-button class, be disabled, and read Stopping…
    const stoppingSnap = gameSnapshot({ installed: true, status: 'stopping', pid: 4321, activePort: 28962, startedAt: new Date().toISOString(), blockers: [] });
    win.webContents.send('manager:event', { type: 'state', snapshot: stoppingSnap });
    await waitFor(win, '.detail-hero-action .stop-button');
    const stoppingButton = await executeRenderer(win, `({
      text: document.querySelector('.detail-hero-action .stop-button')?.textContent?.trim(),
      disabled: document.querySelector('.detail-hero-action .stop-button')?.disabled,
      chipClass: document.querySelector('.state-chip')?.className,
      chipText: document.querySelector('.state-chip')?.textContent?.trim(),
    })`);
    assert.equal(stoppingButton.text, 'Stopping…');
    assert.equal(stoppingButton.disabled, true);
    assert.ok(stoppingButton.chipClass.includes('attention'));
    assert.equal(stoppingButton.chipText, 'Stopping');

    // Starting server must render attention chip and Cancel start control
    const startingSnap = gameSnapshot({ installed: true, status: 'starting', pid: null, activePort: 28962, startedAt: null, blockers: [] });
    win.webContents.send('manager:event', { type: 'state', snapshot: startingSnap });
    await waitFor(win, '.detail-hero-action .stop-button');
    const startingState = await executeRenderer(win, `({
      text: document.querySelector('.detail-hero-action .stop-button')?.textContent?.trim(),
      chipClass: document.querySelector('.state-chip')?.className,
      chipText: document.querySelector('.state-chip')?.textContent?.trim(),
    })`);
    assert.equal(startingState.text, 'Cancel start');
    assert.ok(startingState.chipClass.includes('attention'));
    assert.equal(startingState.chipText, 'Starting');

    // Console tab must reflect STARTING
    await executeRenderer(win, "[...document.querySelectorAll('.detail-tabs button')].find(button => button.textContent.includes('Console')).click()");
    await waitFor(win, '.console-panel');
    const consoleStarting = await executeRenderer(win, `({
      state: document.querySelector('.console-state')?.textContent?.trim(),
      live: document.querySelector('.terminal-live')?.textContent?.trim(),
    })`);
    assert.match(consoleStarting.state, /STARTING/);
    assert.match(consoleStarting.live, /STARTING/);

    // The setup checklist must agree with the mod panel when upstream status
    // is offline or unsupported, rather than offering an action that will fail.
    win.webContents.send('manager:event', { type: 'state', snapshot: gameSnapshot({ status: 'stopped',
      setup: { ...snapshot.games[0].setup, bots: false }, blockers: ['Bot Warfare missing.'] }) });
    await executeRenderer(win, "[...document.querySelectorAll('.detail-tabs button')].find(button => button.textContent.includes('Overview')).click()");
    await waitFor(win, '.setup-step');
    const unsupportedMod = await executeRenderer(win, `(() => {
      const step = [...document.querySelectorAll('.setup-step')].find(item => item.textContent.includes('Install Bot Warfare'));
      return { disabled: step?.querySelector('button.button')?.disabled, detail: step?.textContent };
    })()`);
    assert.equal(unsupportedMod.disabled, true);
    assert.match(unsupportedMod.detail, /No verified release is available/);
    botFixture = { ...botFixture, state: 'installed', source: { ...botFixture.source, supported: true, ref: 'v-fixture' } };
    await executeRenderer(win, "document.querySelector('.detail-back button').click()");
    await waitFor(win, '.server-card .card-open');
    await executeRenderer(win, "document.querySelector('.server-card .card-open').click()");
    await executeRenderer(win, `new Promise((resolve, reject) => {
      const check = () => [...document.querySelectorAll('.setup-step button')].some(button => button.textContent.includes('Reinstall Bot Warfare'));
      if (check()) return resolve();
      const observer = new MutationObserver(() => { if (check()) { observer.disconnect(); resolve(); } });
      observer.observe(document.body, { subtree: true, childList: true, attributes: true });
      setTimeout(() => { observer.disconnect(); reject(new Error('Incomplete managed mod did not offer Reinstall')); }, 10000);
    })`);
    const managedMod = await executeRenderer(win, `(() => {
      const step = [...document.querySelectorAll('.setup-step')].find(item => item.textContent.includes('Reinstall Bot Warfare'));
      return { disabled: step?.querySelector('button.button')?.disabled, detail: step?.textContent };
    })()`);
    assert.equal(managedMod.disabled, false);
    assert.match(managedMod.detail, /managed mod is incomplete/);

    // BO1 is bound publicly by its engine. A matching, owned rule allowing
    // inbound UDP from any address is required before Start is offered.
    win.webContents.send('manager:event', { type: 'state', snapshot: bo1Snapshot() });
    await executeRenderer(win, "document.querySelector('.sidebar > .nav-item').click()");
    await waitFor(win, '.server-card.accent-bo');
    await waitFor(win, '.dashboard-bo1-guidance');
    assert.match(await executeRenderer(win, "document.querySelector('.dashboard-bo1-guidance')?.textContent"), /BO1’s Overview.*any address/);
    const bo1Card = await executeRenderer(win, `({
      start: document.querySelector('.server-card.accent-bo .primary-button')?.textContent,
      setup: document.querySelector('.server-card.accent-bo .setup-button')?.textContent,
      state: document.querySelector('.server-card.accent-bo .state-chip')?.textContent,
    })`);
    assert.equal(bo1Card.start, undefined);
    assert.match(bo1Card.setup, /Finish setup/);
    assert.match(bo1Card.state, /Check public firewall/);
    await executeRenderer(win, "document.querySelector('.server-card.accent-bo .card-open').click()");
    await waitFor(win, '.setup-wizard');
    const bo1Blocked = await executeRenderer(win, `({
      startDisabled: document.querySelector('.detail-hero-action .primary-button')?.disabled,
      heading: document.querySelector('.setup-wizard .section-kicker')?.textContent,
      warning: document.querySelector('.check-list')?.textContent,
    })`);
    assert.equal(bo1Blocked.startDisabled, true);
    assert.equal(bo1Blocked.heading, 'GETTING STARTED');
    assert.match(bo1Blocked.warning, /verified botLANd public inbound UDP firewall rule/i);
    bo1Rule = { name: 'botLANd BO1 UDP', port: 28961, state: 'lan', managed: true };
    await executeRenderer(win, "document.querySelector('.detail-back button').click()");
    await waitFor(win, '.server-card.accent-bo .setup-button');
    await executeRenderer(win, "document.querySelector('.server-card.accent-bo .card-open').click()");
    await waitFor(win, '.firewall-apply');
    const bo1FirewallHint = await executeRenderer(win, "document.querySelector('.firewall-hint')?.textContent");
    assert.match(bo1FirewallHint, /Observed rule: LAN-only inbound \(local subnet\)/);
    assert.match(bo1FirewallHint, /Apply target: Public inbound UDP.*any address/);
    bo1Rule = { name: 'botLANd BO1 UDP', port: 28961, state: 'any', managed: true };
    // A different game's Overview still needs BO1's actual firewall status in
    // the sidebar, rather than defaulting to 'Check public firewall'.
    await executeRenderer(win, "[...document.querySelectorAll('.sidebar .game-nav-item')].find(button => button.textContent.includes('CoD4')).click()");
    await waitFor(win, 'main[aria-label^="Call of Duty 4"]');
    await executeRenderer(win, `new Promise((resolve, reject) => {
      const check = () => [...document.querySelectorAll('.sidebar .game-nav-item')].find(button => button.textContent.includes('BO1'))?.textContent.includes('Ready to launch');
      if (check()) return resolve();
      const observer = new MutationObserver(() => { if (check()) { observer.disconnect(); resolve(); } });
      observer.observe(document.body, { subtree: true, childList: true, attributes: true });
      setTimeout(() => { observer.disconnect(); reject(new Error('BO1 sidebar status not refreshed on another game')); }, 10000);
    })`);
    await executeRenderer(win, "document.querySelector('.sidebar > .nav-item').click()");
    await waitFor(win, '.server-card.accent-bo');
    assert.equal(await executeRenderer(win, "document.querySelector('.dashboard-bo1-guidance')"), null);
    await waitFor(win, '.server-card.accent-bo .primary-button');
    await executeRenderer(win, "document.querySelector('.server-card.accent-bo .card-open').click()");
    await waitFor(win, '.setup-wizard .readiness-pill.good');
    assert.equal(await executeRenderer(win, "document.querySelector('.detail-hero-action .primary-button')?.disabled"), false);

    // Elevation may finish after navigation, while a prior BO1 cache read is
    // still in flight. Both removing and applying must reverify that cache;
    // neither a stale read nor a mutation result belongs to the new game page.
    const originalBo1 = structuredClone(snapshot.games.find(entry => entry.id === 'bo1'));
    Object.assign(snapshot.games.find(entry => entry.id === 'bo1'), bo1Snapshot().games.find(entry => entry.id === 'bo1'));
    for (const apply of [false, true]) {
      const staleReadStarted = new Promise(resolve => { deferredBo1StatusRead = { started: resolve, release: null }; });
      await executeRenderer(win, "[...document.querySelectorAll('.sidebar .game-nav-item')].find(button => button.textContent.includes('CoD4')).click()");
      await staleReadStarted;
      const releaseStaleRead = deferredBo1StatusRead.release;
      deferredBo1StatusRead = null;
      await executeRenderer(win, "[...document.querySelectorAll('.sidebar .game-nav-item')].find(button => button.textContent.includes('BO1')).click()");
      await waitFor(win, apply ? '.firewall-apply:not(:disabled)' : '.firewall-row .inline-link:not(:disabled)');
      const firewallStarted = new Promise(resolve => { deferredFirewallChange = { started: resolve, release: null }; });
      await executeRenderer(win, `window.confirm = () => true; document.querySelector(${JSON.stringify(apply ? '.firewall-apply' : '.firewall-row .inline-link')}).click()`);
      await firewallStarted;
      await waitFor(win, '.busy-indicator');
      await executeRenderer(win, "[...document.querySelectorAll('.sidebar .game-nav-item')].find(button => button.textContent.includes('CoD4')).click()");
      await waitFor(win, 'main[aria-label^="Call of Duty 4"]');
      const releaseFirewall = deferredFirewallChange.release;
      deferredFirewallChange = null;
      releaseFirewall();
      await waitForAbsent(win, '.busy-indicator');
      const readyExpression = "[...document.querySelectorAll('.sidebar .game-nav-item')].find(button => button.textContent.includes('BO1'))?.textContent.includes('Ready to launch')";
      await waitForCondition(win, apply ? readyExpression : `!(${readyExpression})`);
      releaseStaleRead();
      await executeRenderer(win, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      assert.equal(await executeRenderer(win, readyExpression), apply, 'A pre-mutation BO1 read must never overwrite the verified post-mutation cache');
      await executeRenderer(win, "document.querySelector('.sidebar > .nav-item').click()");
      await waitFor(win, '.server-card.accent-bo');
      await waitForCondition(win, apply ? "!!document.querySelector('.server-card.accent-bo .primary-button')" : "!!document.querySelector('.server-card.accent-bo .setup-button')");
      await executeRenderer(win, "document.querySelector('.server-card.accent-bo .card-open').click()");
      await waitFor(win, apply ? '.firewall-row .inline-link' : '.firewall-apply');
    }
    Object.assign(snapshot.games.find(entry => entry.id === 'bo1'), originalBo1);
    win.setSize(400, 850);
    const narrow = await executeRenderer(win, '({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth })');
    assert.ok(narrow.scrollWidth <= narrow.width, 'BO1 Overview must not clip at a narrow window');

    // Both engine controls live beside Plutonium in the bottom-left sidebar,
    // never on a game Overview. A missing folder explains the disabled button.
    const needsEngine = gameSnapshot({ engineBusy: false,
      setup: { ...snapshot.games[0].setup, engine: false }, blockers: ['Cod4R DedRun missing.'] });
    win.webContents.send('manager:event', { type: 'state', snapshot: needsEngine });
    await executeRenderer(win, "document.querySelector('.sidebar .game-nav-item').click()");
    await waitFor(win, 'main[aria-label^="Call of Duty 4"] .setup-wizard');
    const engineControls = await executeRenderer(win, `(() => {
      const step = [...document.querySelectorAll('.setup-step')].find(item => item.textContent.includes('Install CoD4R / IW3x'));
      return {
        guide: step?.querySelector('button.button')?.textContent,
        detail: step?.textContent,
        overviewUpdateButtons: [...document.querySelectorAll('main button')].filter(button => /^(Install|Update) (IW3x|IW4x)/.test(button.textContent.trim())).length,
        engines: [...document.querySelectorAll('.engine-sidebar-item .root-button')].map(button => ({ text: button.textContent.trim(), disabled: button.disabled, name: button.getAttribute('aria-label') })),
        plutonium: document.querySelector('.sidebar-footer > .root-button')?.textContent,
        missingHint: document.querySelector('.engine-sidebar-item:has([data-engine=mw2]) .engine-sidebar-hint')?.textContent,
      };
    })()`);
    assert.match(engineControls.guide, /Open setup guide/);
    assert.match(engineControls.detail, /bottom left/);
    assert.equal(engineControls.overviewUpdateButtons, 0);
    assert.equal(engineControls.engines.length, 2);
    assert.match(engineControls.engines[0].text, /Install IW3x/);
    assert.equal(engineControls.engines[0].disabled, false);
    assert.match(engineControls.engines[0].name, /Call of Duty 4/);
    assert.equal(engineControls.engines[1].disabled, true);
    assert.match(engineControls.missingHint, /Choose MW2 folder first/);
    assert.match(engineControls.plutonium, /Plutonium/);
    // Declining an engine update confirmation must not call IPC.
    await executeRenderer(win, "window.confirm = () => false; document.querySelector('.root-button[data-engine=cod4]').click()");
    assert.equal(engineAttempts, 0);
    await executeRenderer(win, "window.confirm = () => true; document.querySelector('.root-button[data-engine=cod4]').click()");
    await waitFor(win, '.notice-error');
    assert.equal(engineAttempts, 1);
    assert.match(await executeRenderer(win, "document.querySelector('.notice-error')?.textContent"), /Synthetic engine update refused/);
    win.webContents.send('manager:event', { type: 'state', snapshot: gameSnapshot({ engineBusy: true,
      setup: { ...snapshot.games[0].setup, engine: true }, blockers: [] }) });
    await waitFor(win, '.state-chip.attention');
    assert.equal(await executeRenderer(win, "document.querySelector('.detail-hero-action .primary-button')?.disabled"), true);
    assert.equal(await executeRenderer(win, "document.querySelector('.root-button[data-engine=cod4]')?.disabled"), true);
    assert.match(await executeRenderer(win, "document.querySelector('.launch-blocked-reason')?.textContent"), /engine update to finish/i);
    assert.match(await executeRenderer(win, "[...document.querySelectorAll('.panel')].find(panel => panel.querySelector('h2')?.textContent === 'Server readiness')?.querySelector('.readiness-pill')?.textContent"), /ENGINE UPDATING/);
    assert.equal(await executeRenderer(win, "document.querySelector('.all-clear')"), null);
    win.webContents.send('manager:event', { type: 'state', snapshot: gameSnapshot({ engineBusy: false,
      setup: { ...snapshot.games[0].setup, engine: true }, blockers: [] }) });
    await waitFor(win, '.root-button[data-engine=cod4]:not(:disabled)');
    assert.match(await executeRenderer(win, "document.querySelector('.root-button[data-engine=cod4]')?.textContent"), /Update IW3x/);
    win.setSize(1000, 600);
    await executeRenderer(win, `new Promise((resolve, reject) => {
      const check = () => innerWidth > 850 ? resolve() : requestAnimationFrame(check);
      check(); setTimeout(() => reject(new Error('Desktop resize did not complete')), 10000);
    })`);
    const footerLayout = await executeRenderer(win, `(() => {
      const footer = document.querySelector('.sidebar-footer').getBoundingClientRect();
      return { top: footer.top, bottom: footer.bottom, height: innerHeight, width: innerWidth, scrollWidth: document.documentElement.scrollWidth };
    })()`);
    assert.ok(footerLayout.top >= 0 && footerLayout.bottom <= footerLayout.height,
      `Engine and Plutonium update buttons must remain accessible at the bottom left in a short desktop window: ${JSON.stringify(footerLayout)}`);
    const horizontalOverflow = await executeRenderer(win, `(() => [...document.querySelectorAll('body *')].map(element => {
      const rect = element.getBoundingClientRect();
      return { tag: element.tagName, className: typeof element.className === 'string' ? element.className : '', right: Math.round(rect.right), width: Math.round(rect.width), scrollWidth: element.scrollWidth, text: (element.textContent || '').trim().slice(0, 80) };
    }).filter(element => element.right > innerWidth + 1).sort((a, b) => b.right - a.right).slice(0, 12))()`);
    const compactLayout = await executeRenderer(win, `(() => {
      const rect = selector => { const box = document.querySelector(selector)?.getBoundingClientRect(); return box && { left: Math.round(box.left), right: Math.round(box.right), width: Math.round(box.width) }; };
      const sidebar = document.querySelector('.sidebar');
      const main = document.querySelector('.main-pane');
      return { innerWidth, clientWidth: document.documentElement.clientWidth, visualWidth: visualViewport?.width,
        devicePixelRatio, media1200: matchMedia('(max-width:1200px)').matches, media1050: matchMedia('(max-width:1050px)').matches,
        media850: matchMedia('(max-width:850px)').matches, shellDisplay: getComputedStyle(document.querySelector('.app-shell')).display,
        sidebar: rect('.sidebar'), sidebarWidth: getComputedStyle(sidebar).width, main: rect('.main-pane'), mainFlex: getComputedStyle(main).flex,
        detailLayout: rect('.detail-layout'), detailGrid: getComputedStyle(document.querySelector('.detail-layout')).gridTemplateColumns,
        primary: rect('.detail-primary'), secondary: rect('.detail-secondary'), tabs: rect('.detail-tabs') };
    })()`);
    assert.ok(footerLayout.scrollWidth <= footerLayout.width, `Game Overview and sidebar must not clip at a 1000×600-DIP window: ${JSON.stringify({ ...footerLayout, compactLayout, horizontalOverflow })}`);
    // IW4x also switches from disabled Install to Update once its game folder
    // and engine are present, without adding a button to MW2 Overview.
    const mw2Ready = gameSnapshot({ engineBusy: false });
    Object.assign(mw2Ready.games.find(entry => entry.id === 'mw2'), {
      installed: true, pathSource: 'manual', gamePath: 'C:\\Example\\MW2', configPath: 'C:\\Example\\MW2\\userraw\\serverlan.cfg',
      setup: { folder: true, engine: false, plutonium: null, key: null, bots: false, config: false, maps: false },
      blockers: ['IW4x executable missing.'],
    });
    win.webContents.send('manager:event', { type: 'state', snapshot: mw2Ready });
    await waitFor(win, '.root-button[data-engine=mw2]:not(:disabled)');
    assert.match(await executeRenderer(win, "document.querySelector('.root-button[data-engine=mw2]')?.textContent"), /Install IW4x/);
    await executeRenderer(win, "[...document.querySelectorAll('.sidebar .game-nav-item')].find(button => button.textContent.includes('MW2')).click()");
    await waitFor(win, 'main[aria-label^="Modern Warfare 2"] .setup-wizard');
    assert.equal(await executeRenderer(win, "[...document.querySelectorAll('main button')].filter(button => /^(Install|Update) IW4x/.test(button.textContent.trim())).length"), 0);
    mw2Ready.games.find(entry => entry.id === 'mw2').setup.engine = true;
    mw2Ready.games.find(entry => entry.id === 'mw2').blockers = [];
    win.webContents.send('manager:event', { type: 'state', snapshot: mw2Ready });
    await executeRenderer(win, `new Promise((resolve, reject) => {
      const check = () => document.querySelector('.root-button[data-engine=mw2]')?.textContent.includes('Update IW4x');
      if (check()) return resolve();
      const observer = new MutationObserver(() => { if (check()) { observer.disconnect(); resolve(); } });
      observer.observe(document.body, { subtree: true, childList: true });
      setTimeout(() => { observer.disconnect(); reject(new Error('IW4x sidebar button did not switch to Update')); }, 10000);
    })`);

    await verifyKeyboardAndConsole(win);
    assert.deepEqual(offline.blocked, [], 'No external/file/data network requests are permitted by the smoke');
    console.log('Synthetic packaged renderer: shared production app:// and ASAR handler, startup fallback, keyboard tabs/dirty-cancel, named map group, streamed console overlap/pause/jump/copy feedback, missing-file restore/partial prune, successful save focus, BO1 firewall cache, dependency cleanup, rotation guards, independent Stop/Cancel, engine sidebar and modal smoke passed.');
  } finally { win.destroy(); app.quit(); }
}).catch(error => { console.error(error); app.exit(1); });

async function verifyRecoveryAndPartialPrune(win) {
  memoryBackups.push({ meta: { id: 'sample-locked', date: '2026-11-11T12:00:00.000Z', bytes: 32 }, values: structuredClone(documentFixture.values) });
  memoryConfigMissing = true;
  await executeRenderer(win, "document.querySelector('[data-tab=console]').click()");
  await waitFor(win, '.console-panel');
  await executeRenderer(win, "document.querySelector('[data-tab=configuration]').click()");
  await waitFor(win, '.config-main .config-empty');
  await waitFor(win, '.config-backup:nth-child(2) button:not(:disabled)');
  assert.equal(await executeRenderer(win, "document.querySelector('.config-aside .full-width')?.disabled"), true);
  await executeRenderer(win, "document.querySelector('.config-backup button').click()");
  await waitFor(win, 'dialog[open]');
  const missing = await executeRenderer(win, "({ title: document.querySelector('#restore-title')?.textContent, description: document.querySelector('#restore-description')?.textContent, summary: document.querySelector('.config-restore-summary')?.textContent, action: document.querySelector('dialog .review-actions .primary-button')?.textContent })");
  assert.match(missing.title, /missing|recreate/i);
  assert.match(missing.description, /no current file to back up/i);
  assert.match(missing.summary, /current file: missing/i);
  assert.match(missing.action, /recreate/i);
  await executeRenderer(win, "document.querySelector('dialog .review-actions .primary-button').click()");
  await waitForAbsent(win, 'dialog[open]');
  await waitFor(win, '.config-field-grid input');
  await waitForCondition(win, "document.activeElement === document.querySelector('.config-notice.success')");
  assert.equal(memoryConfigMissing, false, 'Restore must recreate the memory-only missing file');
  assert.equal(await executeRenderer(win, "document.querySelector('.config-field-grid input')?.value"), 'Synthetic server');
  await waitFor(win, '.config-backup:nth-child(2) input:not(:disabled)');
  partialPrune = true;
  await executeRenderer(win, "window.confirm = () => true; document.querySelectorAll('.config-backup input[type=checkbox]').forEach(input => input.click())");
  await waitFor(win, '.config-prune:not(:disabled)');
  await executeRenderer(win, "document.querySelector('.config-prune').click()");
  await waitForCondition(win, "document.querySelector('.config-notice.error')?.textContent.includes('Removed 1 of 2 backups') && document.querySelectorAll('.config-backup').length === 1");
  const partial = await executeRenderer(win, "({ id: document.querySelector('.config-backup code')?.textContent, selected: document.querySelectorAll('.config-backup input:checked').length, enabled: !document.querySelector('.config-backup button')?.disabled, feedback: document.querySelector('.config-notice.error')?.textContent })");
  assert.equal(partial.id, 'sample-locked');
  assert.equal(partial.selected, 1, 'Partial deletion must reconcile selection to only surviving IDs');
  assert.equal(partial.enabled, true, 'The refreshed surviving backup remains usable');
  assert.match(partial.feedback, /remaining backups have been refreshed/i);
  partialPrune = false;
  await executeRenderer(win, "document.querySelector('.config-backup input[type=checkbox]').click()");
}
async function pressKey(win, keyCode) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
  await executeRenderer(win, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
}
async function verifyKeyboardAndConsole(win) {
  win.setContentSize(900, 750);
  win.webContents.send('manager:event', { type: 'state', snapshot: gameSnapshot({ status: 'stopped', blockers: [] }) });
  await executeRenderer(win, "window.confirm = () => true; document.querySelector('[data-game=cod4]').click()");
  await waitFor(win, '.setup-wizard');
  const tabs = await executeRenderer(win, "[...document.querySelectorAll('.detail-tabs [role=tab]')].map(tab => ({ id: tab.dataset.tab, selected: tab.getAttribute('aria-selected'), index: tab.tabIndex }))");
  assert.equal(tabs.filter(tab => tab.index === 0).length, 1, 'A tablist has one keyboard entry point');
  assert.ok(tabs.every(tab => tab.index === (tab.selected === 'true' ? 0 : -1)), 'Only the selected tab belongs to the page Tab order');
  await executeRenderer(win, "document.querySelector('[data-tab=overview]').focus()");
  for (const [key, expected] of [['Right', 'configuration'], ['End', 'console'], ['Home', 'overview'], ['Left', 'console'], ['Home', 'overview'], ['Right', 'configuration']]) {
    await pressKey(win, key);
    await waitForCondition(win, `document.querySelector('.detail-tabs [aria-selected="true"]')?.dataset.tab === ${JSON.stringify(expected)} && document.activeElement?.dataset.tab === ${JSON.stringify(expected)}`);
  }
  await waitFor(win, '.config-field-grid input');
  await executeRenderer(win, `(() => {
    const input = document.querySelector('.config-field-grid input');
    input[Object.keys(input).find(key => key.startsWith('__reactProps$'))].onChange({ target: { value: 'Keyboard dirty-cancel fixture' } });
    window.__smokeDiscardPrompts = 0;
    window.confirm = () => { window.__smokeDiscardPrompts++; return false; };
  })()`);
  await waitFor(win, '.config-savebar button:not(:disabled)');
  await executeRenderer(win, "document.querySelector('[data-tab=configuration]').focus()");
  for (const key of ['Right', 'Home', 'End', 'Left']) {
    await pressKey(win, key);
    const declined = await executeRenderer(win, "({ selected: document.querySelector('.detail-tabs [aria-selected=true]')?.dataset.tab, active: document.activeElement?.dataset.tab, draft: document.querySelector('.config-field-grid input')?.value })");
    assert.equal(declined.selected, 'configuration', `${key}: declining discard must not activate another tab`);
    assert.equal(declined.active, 'configuration', `${key}: declining discard must not strand focus on an inactive tab`);
    assert.equal(declined.draft, 'Keyboard dirty-cancel fixture');
  }
  assert.equal(await executeRenderer(win, 'window.__smokeDiscardPrompts'), 4);
  await executeRenderer(win, 'window.confirm = () => true; void 0');
  await pressKey(win, 'End');
  await waitFor(win, '.console-panel');
  await executeRenderer(win, "document.querySelector('[data-tab=rotation]').click()");
  await waitFor(win, '.map-option');
  const untouchedRotation = await executeRenderer(win, "({ port: document.querySelector('.rotation-controls input[type=number]')?.value, saveDisabled: document.querySelector('.rotation-panel .primary-button')?.disabled })");
  assert.equal(untouchedRotation.port, String(snapshot.games[0].options.port), 'Revisiting cached maps must initialize this game’s port, not preserve another title’s draft');
  assert.equal(untouchedRotation.saveDisabled, true, 'Opening an untouched rotation must not invent unsaved changes');
  const group = await executeRenderer(win, `(() => {
    const group = document.querySelector('.map-grid')?.closest('fieldset, [role=group]');
    const labelled = group?.getAttribute('aria-labelledby')?.split(/\\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ');
    return { exists: !!group, name: group?.getAttribute('aria-label') || labelled || group?.querySelector('legend')?.textContent || '', count: group?.querySelectorAll('.map-option').length || 0, total: document.querySelectorAll('.map-option').length };
  })()`);
  assert.equal(group.exists, true, 'Real map choices must be inside a semantic fieldset/group');
  assert.match(group.name, /map/i, 'The map group must have a real accessible name');
  assert.ok(group.count > 0);
  assert.equal(group.count, group.total, 'Every real map choice must belong to the named map group');
  await executeRenderer(win, "document.querySelector('[data-tab=console]').click()");
  await waitFor(win, '.console-panel');
  await verifyStreamedConsole(win);
}
async function verifyStreamedConsole(win) {
  const history = Array.from({ length: 120 }, (_, index) => logFixture(index));
  const next = index => logFixture(index);
  win.webContents.send('manager:event', { type: 'state', snapshot: gameSnapshot({ logs: history }) });
  await waitForCondition(win, "document.querySelectorAll('.console-line').length === 120");
  await executeRenderer(win, "document.querySelector('.console-lines').focus()");
  // Same entry in a streamed batch and an overlapping snapshot must render once;
  // a line already queued before a snapshot must not be silently lost either.
  win.webContents.send('manager:event', { type: 'log', id: 'cod4', entry: next(120) });
  win.webContents.send('manager:event', { type: 'state', snapshot: gameSnapshot({ logs: [...history.slice(1), next(120)] }) });
  win.webContents.send('manager:event', { type: 'log', id: 'cod4', entry: next(121) });
  await waitForCondition(win, "document.querySelector('.console-line:last-child')?.textContent.includes('Synthetic streamed output 121')");
  const overlap = await executeRenderer(win, `({
    messages: [...document.querySelectorAll('.console-line > span:last-child')].map(node => node.textContent),
    sources: [...new Set([...document.querySelectorAll('.console-source')].map(node => node.textContent))].sort(),
    focus: document.activeElement === document.querySelector('.console-lines'),
  })`);
  assert.equal(overlap.messages.length, 120);
  assert.equal(overlap.messages.filter(message => message === next(120).message).length, 1, 'Snapshot/event overlap must not duplicate log lines');
  assert.equal(overlap.messages.at(-1), next(121).message);
  assert.deepEqual(overlap.sources, ['g_log', 'manager', 'stderr', 'stdout']);
  assert.equal(overlap.focus, true, 'Streaming output must not steal console keyboard focus');
  await executeRenderer(win, "[...document.querySelectorAll('.console-actions button')].find(button => button.textContent.trim() === 'Pause').click()");
  await waitFor(win, '.console-paused');
  const paused = await executeRenderer(win, "document.querySelector('.console-lines').textContent");
  win.webContents.send('manager:event', { type: 'log', id: 'cod4', entry: next(122) });
  win.webContents.send('manager:event', { type: 'log', id: 'cod4', entry: next(123) });
  win.webContents.send('manager:event', { type: 'state', snapshot: gameSnapshot({ logs: [...history.slice(4), next(120), next(121), next(122), next(123)] }) });
  await waitForCondition(win, "/2 new lines buffered/.test(document.querySelector('.console-paused')?.textContent || '')");
  assert.equal(await executeRenderer(win, "document.querySelector('.console-lines').textContent"), paused, 'Pause freezes all 120 retained history lines while new output arrives');
  await executeRenderer(win, "[...document.querySelectorAll('.console-actions button')].find(button => /^Resume/.test(button.textContent.trim())).click()");
  await waitForCondition(win, "document.querySelector('.console-line:last-child')?.textContent.includes('Synthetic streamed output 123')");
  await executeRenderer(win, "(() => { const log = document.querySelector('.console-lines'); log.focus(); log.scrollTop = 0; log.dispatchEvent(new Event('scroll')); })()");
  const jump = "[...document.querySelectorAll('.console-actions button')].find(button => button.textContent.trim() === 'Jump to latest')";
  await waitForCondition(win, `!(${jump})?.disabled`);
  await executeRenderer(win, `(${jump}).click()`);
  await waitForCondition(win, "(() => { const log = document.querySelector('.console-lines'); return log.scrollHeight - log.scrollTop - log.clientHeight < 3; })()");
  const copy = "[...document.querySelectorAll('.console-actions button')].find(button => /^(Copy|Copied)$/.test(button.textContent.trim()))";
  const feedback = "[...document.querySelectorAll('.console-panel [role=status], .console-panel [role=alert]')].map(node => node.textContent).join(' ')";
  for (const result of [false, 'error']) {
    copyResult = result;
    const before = copyCalls;
    await executeRenderer(win, `(${copy}).click()`);
    await waitForCondition(win, `/clipboard|could not copy|copy.*(?:failed|unavailable)|not.*cop(?:y|ied)/i.test(${feedback})`);
    assert.equal(copyCalls, before + 1);
    assert.notEqual(await executeRenderer(win, `(${copy})?.textContent.trim()`), 'Copied', 'False/rejected clipboard results must never claim success');
  }
  copyResult = true;
  await executeRenderer(win, `(${copy}).click()`);
  await waitForCondition(win, `(${copy})?.textContent.trim() === 'Copied'`);
  assert.match(lastCopiedText, /Synthetic streamed output 123/);
  assert.match(lastCopiedText, /stdout|stderr|g_log/);
  const huge = Array.from({ length: 120 }, (_, index) => logFixture(500 + index, `Oversize output ${index} ${'x'.repeat(1900)}`));
  win.webContents.send('manager:event', { type: 'state', snapshot: gameSnapshot({ logs: huge }) });
  await waitForCondition(win, "document.querySelector('.console-line:last-child')?.textContent.includes('Oversize output 119')");
  await executeRenderer(win, `(${copy}).click()`);
  await waitForCondition(win, `/too (?:large|long)|200.?000|filter|reduce|fewer|limit|invalid text to copy/i.test(${feedback})`);
  assert.notEqual(await executeRenderer(win, `(${copy})?.textContent.trim()`), 'Copied', 'Oversize output must report a usable error, not a copy success');
}
