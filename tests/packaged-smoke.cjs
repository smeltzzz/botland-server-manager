// Synthetic, read-only Electron smoke for the built renderer. Never loads a
// real game install or ServerManager; the IPC mock refuses every write action.
// Run after build: node_modules/.bin/electron.cmd tests/packaged-smoke.cjs
const assert = require('node:assert/strict');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

const definitions = [
  ['cod4', 'Call of Duty 4', 'CoD4', 'CoD4R / IW3x', 'mw'],
  ['waw', 'World at War', 'WaW', 'Plutonium T4', 'neutral'],
  ['mw2', 'Modern Warfare 2', 'MW2', 'IW4x', 'mw'],
  ['bo1', 'Black Ops', 'BO1', 'Plutonium T5', 'bo'],
  ['mw3', 'Modern Warfare 3', 'MW3', 'Plutonium IW5', 'mw'],
  ['bo2', 'Black Ops II', 'BO2', 'Plutonium T6', 'bo'],
];
const snapshot = {
  root: '', updatesEnabled: false, updates: {},
  games: definitions.map(([id, title, short, engine, family]) => ({
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
  values: { sv_hostname: 'Synthetic server' },
  entries: [{ key: 'sv_hostname', value: 'Synthetic server', masked: false, hasValue: true, count: 1 }],
  fields: [{ key: 'sv_hostname', sourceKey: 'sv_hostname', label: 'Server name', section: 'Server & access', type: 'text', default: 'Synthetic server' }],
};
let failSnapshotOnce = false;
let mapsVersion = 1;

function gameSnapshot(overrides) {
  const next = structuredClone(snapshot);
  Object.assign(next.games.find(game => game.id === 'cod4'), overrides);
  return next;
}

async function waitFor(win, selector) {
  await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
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
  await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const selector = ${JSON.stringify(selector)};
    if (!document.querySelector(selector)) return resolve();
    const observer = new MutationObserver(() => {
      if (!document.querySelector(selector)) { observer.disconnect(); resolve(); }
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true });
    setTimeout(() => { observer.disconnect(); reject(new Error('Renderer condition timed out waiting for absence: ' + selector)); }, 10000);
  })`);
}

app.whenReady().then(async () => {
  ipcMain.handle('manager:action', (_event, action) => {
    switch (action) {
      case 'snapshot':
        if (failSnapshotOnce) { failSnapshotOnce = false; throw new Error('Synthetic status refresh failure.'); }
        return structuredClone(snapshot);
      case 'start': return undefined;
      case 'artwork': return null;
      case 'maps': return { maps: mapsVersion === 1 ? ['mp_crash'] : ['mp_crash', 'mp_second'], modes: [{ value: 'dom', label: 'Domination' }] };
      case 'firewallStatus': return { name: 'botLANd CoD4 UDP', port: 28962, state: 'missing' };
      case 'botStatus': return { state: 'not-installed', targetPath: 'C:\\Example\\Game\\mods', manifest: null,
        versions: [], channel: 'stable', source: { supported: false, ref: null, notes: '', status: 'offline' } };
      case 'document': return structuredClone(documentFixture);
      case 'listConfigBackups': return [];
      case 'previewSettings': return { token: '0'.repeat(64), changed: true, changes: [
        { key: 'sv_hostname', label: 'Server name', before: 'Synthetic server', after: 'Synthetic edited name', duplicates: 1 },
      ] };
      default: throw new Error('Synthetic smoke refuses write actions.');
    }
  });
  const win = new BrowserWindow({ width: 640, height: 900, show: false, backgroundColor: '#1B1A19',
    webPreferences: { preload: path.join(__dirname, '..', 'electron', 'preload.cjs'), contextIsolation: true, sandbox: true } });
  // A packaged window whose preload failed must explain the problem instead of
  // throwing while React mounts. Keep the main window alive while this window is
  // destroyed, or Electron quits before the rest of the smoke can run.
  const fallbackWin = new BrowserWindow({ width: 640, height: 900, show: false, backgroundColor: '#1B1A19',
    webPreferences: { contextIsolation: true, sandbox: true } });
  try {
    await fallbackWin.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
    await waitFor(fallbackWin, '.startup-error');
    const fallbackText = await fallbackWin.webContents.executeJavaScript('document.body.textContent');
    assert.match(fallbackText, /could not connect to its desktop process/i);
  } finally { fallbackWin.destroy(); }
  try {
    await win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
    await waitFor(win, '.server-card .card-open');
    const dashboard = await win.webContents.executeJavaScript(`({
      cards: document.querySelectorAll('.server-card').length,
      missing: document.querySelectorAll('.missing-row').length,
      width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
    })`);
    assert.equal(dashboard.cards, 1);
    assert.equal(dashboard.missing, 5);
    assert.ok(dashboard.scrollWidth <= dashboard.width, 'Dashboard must not clip at a 640-DIP window');
    const cardAccessibility = await win.webContents.executeJavaScript(`(() => {
      const card = document.querySelector('.server-card');
      return { role: card?.getAttribute('role'), tabIndex: card?.tabIndex, label: card?.getAttribute('aria-label') };
    })()`);
    assert.equal(cardAccessibility.role, 'group');
    assert.equal(cardAccessibility.tabIndex, 0);
    assert.match(cardAccessibility.label, /Press Enter or Space to manage/);
    await win.webContents.executeJavaScript(`(() => {
      const card = document.querySelector('.server-card');
      card.focus();
      card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
    await waitFor(win, '.detail-tabs');
    await win.webContents.executeJavaScript("document.querySelector('.sidebar > .nav-item').click()");
    await waitFor(win, '.server-card');
    await win.webContents.executeJavaScript(`(() => {
      const card = document.querySelector('.server-card');
      card.focus();
      card.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    })()`);
    await waitFor(win, '.detail-tabs');
    await win.webContents.executeJavaScript("document.querySelector('.sidebar > .nav-item').click()");
    await waitFor(win, '.server-card');
    failSnapshotOnce = true;
    await win.webContents.executeJavaScript("document.querySelector('.server-card .primary-button').click()");
    await waitFor(win, '.notice');
    const refreshNotice = await win.webContents.executeJavaScript("document.querySelector('.notice')?.textContent || ''");
    assert.match(refreshNotice, /Action completed/i);
    assert.match(refreshNotice, /could not be refreshed/i);
    await win.webContents.executeJavaScript("document.querySelector('.notice button').click()");
    await waitForAbsent(win, '.notice');
    await win.webContents.executeJavaScript("document.querySelector('.server-card .card-open').click()");
    await waitFor(win, '.detail-tabs');
    const manageFocus = await win.webContents.executeJavaScript("({ active: document.activeElement?.tagName, label: document.querySelector('main')?.getAttribute('aria-label') })");
    assert.equal(manageFocus.active, 'MAIN');
    assert.equal(manageFocus.label, 'Call of Duty 4 — Overview');
    const heading = await win.webContents.executeJavaScript("document.querySelector('.detail-hero h1').textContent");
    assert.equal(heading, 'Call of Duty 4');
    await win.webContents.executeJavaScript("[...document.querySelectorAll('.detail-tabs button')].find(button => button.textContent.includes('Configuration')).click()");
    await waitFor(win, '.config-field-grid input');
    const tabFocus = await win.webContents.executeJavaScript("({ active: document.activeElement?.tagName, label: document.querySelector('main')?.getAttribute('aria-label') })");
    assert.equal(tabFocus.active, 'MAIN');
    assert.equal(tabFocus.label, 'Call of Duty 4 — Configuration');
    const width = await win.webContents.executeJavaScript('({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth })');
    assert.ok(width.scrollWidth <= width.width, 'Configuration must not clip at a 640-DIP window');
    await win.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('.config-field-grid input');
      const props = Object.keys(input).find(key => key.startsWith('__reactProps$'));
      input[props].onChange({ target: { value: 'Synthetic edited name' } });
    })()`);
    await waitFor(win, '.config-savebar button:not(:disabled)');
    await win.webContents.executeJavaScript("document.querySelector('.config-savebar button').click()");
    await waitFor(win, 'dialog[open]');
    const focused = await win.webContents.executeJavaScript("document.querySelector('dialog')?.contains(document.activeElement)");
    assert.equal(focused, true, 'Review dialog must take focus');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'TAB' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'TAB' });
    const trapped = await win.webContents.executeJavaScript("document.querySelector('dialog')?.contains(document.activeElement)");
    assert.equal(trapped, true, 'Tab must stay inside the review dialog');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ESC' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ESC' });
    await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      let attempts = 0;
      const timer = setInterval(() => {
        if (!document.querySelector('dialog[open]') && document.activeElement?.textContent?.includes('Review changes')) {
          clearInterval(timer); resolve(true);
        } else if (++attempts > 100) { clearInterval(timer); reject(new Error('Review focus did not return')); }
      }, 50);
    })`);
    const guardedClose = await win.webContents.executeJavaScript(`(() => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    })()`);
    assert.equal(guardedClose, true, 'Unsaved configuration edits must guard window close');

    // A running server whose install disappears must keep a visible Stop control
    // and remain counted as live.
    const unavailable = gameSnapshot({ installed: false, status: 'running', pid: 4321, activePort: 28962,
      startedAt: new Date().toISOString(), blockers: ['Synthetic game folder became unavailable.'] });
    win.webContents.send('manager:event', { type: 'state', snapshot: unavailable });
    await waitFor(win, '.detail-hero-action .stop-button');
    assert.equal(await win.webContents.executeJavaScript("document.querySelectorAll('.detail-hero-action .stop-button').length"), 1);
    await win.webContents.executeJavaScript("window.confirm = () => true; document.querySelector('.detail-back button').click()");
    await waitFor(win, '.server-card .stop-button');
    const unavailableDashboard = await win.webContents.executeJavaScript(`({
      cards: document.querySelectorAll('.server-card').length,
      missing: document.querySelectorAll('.missing-row').length,
      running: document.querySelectorAll('.stat-card')[1]?.querySelector('strong')?.textContent || '',
      stopButtons: document.querySelectorAll('.server-card .stop-button').length,
    })`);
    assert.equal(unavailableDashboard.cards, 1, 'A running unavailable game must remain on the dashboard');
    assert.equal(unavailableDashboard.missing, 5, 'A running unavailable game must not move to Not installed');
    assert.match(unavailableDashboard.running, /01/, 'A running unavailable game must remain in the live count');
    assert.equal(unavailableDashboard.stopButtons, 1, 'The dashboard must retain its Stop control');

    // Returning the same game path to service must trigger a fresh map scan, not
    // silently reuse a stale cache.
    await win.webContents.executeJavaScript("document.querySelector('.server-card .card-open').click()");
    await waitFor(win, '.detail-hero-action .stop-button');
    win.webContents.send('manager:event', { type: 'state', snapshot: gameSnapshot({ installed: true, status: 'running', pid: 4321,
      activePort: 28962, startedAt: new Date().toISOString(), blockers: [] }) });
    await waitFor(win, '.detail-tabs button:nth-child(3):not(:disabled)');
    await win.webContents.executeJavaScript("[...document.querySelectorAll('.detail-tabs button')].find(button => button.textContent.includes('Maps & modes')).click()");
    await waitFor(win, '.map-option');
    mapsVersion = 2;
    win.webContents.send('manager:event', { type: 'state', snapshot: gameSnapshot({ installed: false, status: 'running', pid: 4321,
      activePort: 28962, startedAt: new Date().toISOString(), blockers: ['Synthetic game folder became unavailable.'] }) });
    await waitForAbsent(win, '.map-option');
    win.webContents.send('manager:event', { type: 'state', snapshot: gameSnapshot({ installed: true, status: 'running', pid: 4321,
      activePort: 28962, startedAt: new Date().toISOString(), blockers: [] }) });
    await waitFor(win, '.map-grid .map-option:nth-child(2)');
    const rescannedMaps = await win.webContents.executeJavaScript("document.querySelectorAll('.map-option').length");
    // Verify connect panel copy, stopping state, and starting state
    await win.webContents.executeJavaScript("[...document.querySelectorAll('.detail-tabs button')].find(button => button.textContent.includes('Overview')).click()");
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
    const connectPlaceholder = await win.webContents.executeJavaScript("document.querySelector('.connect-row code')?.textContent || ''");
    assert.equal(connectPlaceholder, 'Choose an interface above', 'Connect panel must direct the user to the dropdown above');

    // Stopping server must keep the stop-button class, be disabled, and read Stopping…
    const stoppingSnap = gameSnapshot({ installed: true, status: 'stopping', pid: 4321, activePort: 28962, startedAt: new Date().toISOString(), blockers: [] });
    win.webContents.send('manager:event', { type: 'state', snapshot: stoppingSnap });
    await waitFor(win, '.detail-hero-action .stop-button');
    const stoppingButton = await win.webContents.executeJavaScript(`({
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
    const startingState = await win.webContents.executeJavaScript(`({
      text: document.querySelector('.detail-hero-action .stop-button')?.textContent?.trim(),
      chipClass: document.querySelector('.state-chip')?.className,
      chipText: document.querySelector('.state-chip')?.textContent?.trim(),
    })`);
    assert.equal(startingState.text, 'Cancel start');
    assert.ok(startingState.chipClass.includes('attention'));
    assert.equal(startingState.chipText, 'Starting');

    // Console tab must reflect STARTING
    await win.webContents.executeJavaScript("[...document.querySelectorAll('.detail-tabs button')].find(button => button.textContent.includes('Console')).click()");
    await waitFor(win, '.console-panel');
    const consoleStarting = await win.webContents.executeJavaScript(`({
      state: document.querySelector('.console-state')?.textContent?.trim(),
      live: document.querySelector('.terminal-live')?.textContent?.trim(),
    })`);
    assert.match(consoleStarting.state, /STARTING/);
    assert.match(consoleStarting.live, /STARTING/);

    console.log('Synthetic packaged renderer: startup fallback, dashboard, navigation, lifecycle state, map rescan, narrow layout and modal keyboard smoke passed.');
  } finally { win.destroy(); app.quit(); }
}).catch(error => { console.error(error); app.exit(1); });
