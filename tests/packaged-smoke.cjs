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
  values: { sv_hostname: 'Synthetic server' },
  entries: [{ key: 'sv_hostname', value: 'Synthetic server', masked: false, hasValue: true, count: 1 }],
  fields: [{ key: 'sv_hostname', sourceKey: 'sv_hostname', label: 'Server name', section: 'Server & access', type: 'text', default: 'Synthetic server' }],
};
let failSnapshotOnce = false;
let failMapsOnce = false;
let engineAttempts = 0;
let mapsVersion = 1;
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
  ipcMain.handle('manager:action', (_event, action, payload) => {
    switch (action) {
      case 'snapshot':
        if (failSnapshotOnce) { failSnapshotOnce = false; throw new Error('Synthetic status refresh failure.'); }
        return structuredClone(snapshot);
      case 'start': return undefined;
      case 'updateEngine': engineAttempts++; throw new Error('Synthetic engine update refused; no files were touched.');
      case 'setUnsavedChanges': return true;
      case 'artwork': return null;
      case 'maps':
        if (failMapsOnce) { failMapsOnce = false; throw new Error('Synthetic map scan failure.'); }
        return { maps: mapsVersion === 1 ? ['mp_crash'] : ['mp_crash', 'mp_second'], modes: [{ value: 'dom', label: 'Domination' }] };
      case 'firewallStatus': return payload?.id === 'bo1' ? structuredClone(bo1Rule) : { name: 'botLANd CoD4 UDP', port: 28962, state: 'missing' };
      case 'botStatus': return structuredClone(botFixture);
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
    // The card is a mouse shortcut, not an extra tab stop; MANAGE is its named control.
    const cardAccessibility = await win.webContents.executeJavaScript(`(() => {
      const card = document.querySelector('.server-card');
      return { role: card?.getAttribute('role'), tabIndex: card?.tabIndex, manage: card?.querySelector('.card-open')?.getAttribute('aria-label') };
    })()`);
    assert.equal(cardAccessibility.role, null);
    assert.equal(cardAccessibility.tabIndex, -1);
    assert.equal(cardAccessibility.manage, 'Manage Call of Duty 4');
    await win.webContents.executeJavaScript("document.querySelector('.server-card .card-art').click()");
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
    await win.webContents.executeJavaScript("(() => { const tab = [...document.querySelectorAll('.detail-tabs button')].find(button => button.textContent.includes('Configuration')); tab.focus(); tab.click(); })()");
    await waitFor(win, '.config-field-grid input');
    // Switching tabs keeps focus on the activated tab instead of jumping to <main>.
    const tabFocus = await win.webContents.executeJavaScript("({ active: document.activeElement?.textContent || '', label: document.querySelector('main')?.getAttribute('aria-label') })");
    assert.equal(tabFocus.active, 'Configuration');
    assert.equal(tabFocus.label, 'Call of Duty 4 — Configuration');
    const width = await win.webContents.executeJavaScript('({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth })');
    assert.ok(width.scrollWidth <= width.width, 'Configuration must not clip at a 640-DIP window');
    await win.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('.config-field-grid input');
      const props = Object.keys(input).find(key => key.startsWith('__reactProps$'));
      input[props].onChange({ target: { value: 'Synthetic edited name' } });
    })()`);
    await waitFor(win, '.config-savebar button:not(:disabled)');
    const unsavedStart = await win.webContents.executeJavaScript(`({
      disabled: document.querySelector('.detail-hero-action .primary-button')?.disabled,
      reason: document.querySelector('.detail-hero-action .primary-button')?.title,
      name: document.querySelector('.detail-hero-action .primary-button')?.getAttribute('aria-label'),
    })`);
    assert.equal(unsavedStart.disabled, true, 'Start must not silently ignore an unsaved config draft');
    assert.match(unsavedStart.reason, /Save or discard changes/);
    assert.equal(unsavedStart.name, 'Start Call of Duty 4 server');
    await win.webContents.executeJavaScript("(() => { const button = document.querySelector('.config-savebar button'); button.focus(); button.click(); })()");
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
        } else if (++attempts > 100) { clearInterval(timer); reject(new Error('Review focus did not return: ' + document.activeElement?.outerHTML?.slice(0, 300) + '; dialog=' + !!document.querySelector('dialog[open]'))); }
      }, 50);
    })`);
    // A rejected commit closes the review but retains the edited draft and
    // reports an actionable error; the synthetic IPC never writes a config.
    await win.webContents.executeJavaScript("(() => { const button = document.querySelector('.config-savebar button'); button.focus(); button.click(); })()");
    await waitFor(win, 'dialog[open]');
    await win.webContents.executeJavaScript("document.querySelector('dialog .review-actions .primary-button').click()");
    await waitForAbsent(win, 'dialog[open]');
    await waitFor(win, '.config-main .config-notice.error');
    assert.equal(await win.webContents.executeJavaScript("document.querySelector('.config-field-grid input')?.value"), 'Synthetic edited name');
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
    const retainedConfig = await win.webContents.executeJavaScript(`({
      tab: document.querySelector('main')?.getAttribute('aria-label'),
      draft: document.querySelector('.config-field-grid input')?.value,
      saveDisabled: document.querySelector('.config-savebar button')?.disabled,
      warning: document.querySelector('.config-notice.error')?.textContent,
    })`);
    assert.equal(retainedConfig.tab, 'Call of Duty 4 — Configuration');
    assert.equal(retainedConfig.draft, 'Synthetic edited name', 'Installation loss must not discard an unsaved config edit');
    assert.equal(retainedConfig.saveDisabled, true, 'Saving must wait for the folder to return');
    assert.match(retainedConfig.warning, /game folder is unavailable/i);
    await win.webContents.executeJavaScript("window.confirm = () => false; document.querySelector('.detail-back button').click()");
    assert.equal(await win.webContents.executeJavaScript("document.querySelector('main')?.getAttribute('aria-label')"), retainedConfig.tab,
      'Declining discard must leave the editor open');
    await win.webContents.executeJavaScript("window.confirm = () => true; document.querySelector('.detail-back button').click()");
    await waitFor(win, '.server-card .stop-button');
    const unavailableDashboard = await win.webContents.executeJavaScript(`({
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
    await win.webContents.executeJavaScript("document.querySelector('.server-card .card-open').click()");
    await waitFor(win, '.detail-hero-action .stop-button');
    win.webContents.send('manager:event', { type: 'state', snapshot: gameSnapshot({ installed: true, status: 'running', pid: 4321,
      activePort: 28962, startedAt: new Date().toISOString(), blockers: [] }) });
    await waitFor(win, '.detail-tabs button:nth-child(3):not(:disabled)');
    await win.webContents.executeJavaScript("[...document.querySelectorAll('.detail-tabs button')].find(button => button.textContent.includes('Maps & modes')).click()");
    await waitFor(win, '.map-option');
    await win.webContents.executeJavaScript("document.querySelector('.map-option').click()");
    await waitFor(win, '.rotation-panel .form-footer-actions button.outline-button');
    mapsVersion = 2;
    win.webContents.send('manager:event', { type: 'state', snapshot: gameSnapshot({ installed: false, status: 'running', pid: 4321,
      activePort: 28962, startedAt: new Date().toISOString(), blockers: ['Synthetic game folder became unavailable.'] }) });
    await waitForAbsent(win, '.map-option');
    assert.match(await win.webContents.executeJavaScript("document.querySelector('main')?.getAttribute('aria-label')"), /Maps & modes/,
      'An unavailable folder must not close an editor with unsaved rotation changes');
    win.webContents.send('manager:event', { type: 'state', snapshot: gameSnapshot({ installed: true, status: 'running', pid: 4321,
      activePort: 28962, startedAt: new Date().toISOString(), blockers: [] }) });
    await waitFor(win, '.map-grid .map-option:nth-child(2)');
    const rescannedMaps = await win.webContents.executeJavaScript("document.querySelectorAll('.map-option').length");
    assert.equal(rescannedMaps, 2);
    assert.equal(await win.webContents.executeJavaScript("document.querySelectorAll('.map-option.chosen').length"), 0,
      'A refreshed map scan must not replace unsaved rotation changes');
    // A failed rescan must clear stale results, block Save, and offer a retry.
    failMapsOnce = true;
    win.webContents.send('manager:event', { type: 'state', snapshot: gameSnapshot({ installed: false, status: 'running', pid: 4321,
      activePort: 28962, startedAt: new Date().toISOString(), blockers: ['Synthetic game folder became unavailable.'] }) });
    await waitForAbsent(win, '.map-option');
    win.webContents.send('manager:event', { type: 'state', snapshot: gameSnapshot({ installed: true, status: 'running', pid: 4321,
      activePort: 28962, startedAt: new Date().toISOString(), blockers: [] }) });
    await waitFor(win, '.map-scan-error button');
    assert.equal(await win.webContents.executeJavaScript("document.querySelector('.rotation-panel .primary-button')?.disabled"), true);
    assert.equal(await win.webContents.executeJavaScript("document.querySelectorAll('.map-option').length"), 0);
    await win.webContents.executeJavaScript("document.querySelector('.map-scan-error button').click()");
    await waitFor(win, '.map-grid .map-option:nth-child(2)');
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

    // The setup checklist must agree with the mod panel when upstream status
    // is offline or unsupported, rather than offering an action that will fail.
    win.webContents.send('manager:event', { type: 'state', snapshot: gameSnapshot({ status: 'stopped',
      setup: { ...snapshot.games[0].setup, bots: false }, blockers: ['Bot Warfare missing.'] }) });
    await win.webContents.executeJavaScript("[...document.querySelectorAll('.detail-tabs button')].find(button => button.textContent.includes('Overview')).click()");
    await waitFor(win, '.setup-step');
    const unsupportedMod = await win.webContents.executeJavaScript(`(() => {
      const step = [...document.querySelectorAll('.setup-step')].find(item => item.textContent.includes('Install Bot Warfare'));
      return { disabled: step?.querySelector('button.button')?.disabled, detail: step?.textContent };
    })()`);
    assert.equal(unsupportedMod.disabled, true);
    assert.match(unsupportedMod.detail, /No verified release is available/);
    botFixture = { ...botFixture, state: 'installed', source: { ...botFixture.source, supported: true, ref: 'v-fixture' } };
    await win.webContents.executeJavaScript("document.querySelector('.detail-back button').click()");
    await waitFor(win, '.server-card .card-open');
    await win.webContents.executeJavaScript("document.querySelector('.server-card .card-open').click()");
    await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const check = () => [...document.querySelectorAll('.setup-step button')].some(button => button.textContent.includes('Reinstall Bot Warfare'));
      if (check()) return resolve();
      const observer = new MutationObserver(() => { if (check()) { observer.disconnect(); resolve(); } });
      observer.observe(document.body, { subtree: true, childList: true, attributes: true });
      setTimeout(() => { observer.disconnect(); reject(new Error('Incomplete managed mod did not offer Reinstall')); }, 10000);
    })`);
    const managedMod = await win.webContents.executeJavaScript(`(() => {
      const step = [...document.querySelectorAll('.setup-step')].find(item => item.textContent.includes('Reinstall Bot Warfare'));
      return { disabled: step?.querySelector('button.button')?.disabled, detail: step?.textContent };
    })()`);
    assert.equal(managedMod.disabled, false);
    assert.match(managedMod.detail, /managed mod is incomplete/);

    // BO1 is bound publicly by its engine. A matching, owned LocalSubnet rule
    // must be verified before either dashboard or Overview offers Start.
    win.webContents.send('manager:event', { type: 'state', snapshot: bo1Snapshot() });
    await win.webContents.executeJavaScript("document.querySelector('.sidebar > .nav-item').click()");
    await waitFor(win, '.server-card.accent-bo');
    const bo1Card = await win.webContents.executeJavaScript(`({
      start: document.querySelector('.server-card.accent-bo .primary-button')?.textContent,
      setup: document.querySelector('.server-card.accent-bo .setup-button')?.textContent,
      state: document.querySelector('.server-card.accent-bo .state-chip')?.textContent,
    })`);
    assert.equal(bo1Card.start, undefined);
    assert.match(bo1Card.setup, /Finish setup/);
    assert.match(bo1Card.state, /Check LAN firewall/);
    await win.webContents.executeJavaScript("document.querySelector('.server-card.accent-bo .card-open').click()");
    await waitFor(win, '.setup-wizard');
    const bo1Blocked = await win.webContents.executeJavaScript(`({
      startDisabled: document.querySelector('.detail-hero-action .primary-button')?.disabled,
      heading: document.querySelector('.setup-wizard .section-kicker')?.textContent,
      warning: document.querySelector('.check-list')?.textContent,
    })`);
    assert.equal(bo1Blocked.startDisabled, true);
    assert.equal(bo1Blocked.heading, 'GETTING STARTED');
    assert.match(bo1Blocked.warning, /verified botLANd local-subnet firewall rule/i);
    bo1Rule = { name: 'botLANd BO1 UDP', port: 28961, state: 'lan', managed: true };
    await win.webContents.executeJavaScript("document.querySelector('.detail-back button').click()");
    await waitFor(win, '.server-card.accent-bo .primary-button');
    await win.webContents.executeJavaScript("document.querySelector('.server-card.accent-bo .card-open').click()");
    await waitFor(win, '.setup-wizard .readiness-pill.good');
    assert.equal(await win.webContents.executeJavaScript("document.querySelector('.detail-hero-action .primary-button')?.disabled"), false);
    win.setSize(400, 850);
    const narrow = await win.webContents.executeJavaScript('({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth })');
    assert.ok(narrow.scrollWidth <= narrow.width, 'BO1 Overview must not clip at a narrow window');

    // Both engine controls live beside Plutonium in the bottom-left sidebar,
    // never on a game Overview. A missing folder explains the disabled button.
    const needsEngine = gameSnapshot({ engineBusy: false,
      setup: { ...snapshot.games[0].setup, engine: false }, blockers: ['Cod4R DedRun missing.'] });
    win.webContents.send('manager:event', { type: 'state', snapshot: needsEngine });
    await win.webContents.executeJavaScript("document.querySelector('.sidebar .game-nav-item').click()");
    await waitFor(win, 'main[aria-label^="Call of Duty 4"] .setup-wizard');
    const engineControls = await win.webContents.executeJavaScript(`(() => {
      const step = [...document.querySelectorAll('.setup-step')].find(item => item.textContent.includes('Install CoD4R / IW3x'));
      return {
        guide: step?.querySelector('button.button')?.textContent,
        detail: step?.textContent,
        overviewUpdateButtons: [...document.querySelectorAll('main button')].filter(button => /^(Install|Update) (Cod4R|IW4x)/.test(button.textContent.trim())).length,
        engines: [...document.querySelectorAll('.engine-sidebar-item .root-button')].map(button => ({ text: button.textContent.trim(), disabled: button.disabled, name: button.getAttribute('aria-label') })),
        plutonium: document.querySelector('.sidebar-footer > .root-button')?.textContent,
        missingHint: document.querySelector('.engine-sidebar-item:nth-child(2) .engine-sidebar-hint')?.textContent,
      };
    })()`);
    assert.match(engineControls.guide, /Open setup guide/);
    assert.match(engineControls.detail, /bottom left/);
    assert.equal(engineControls.overviewUpdateButtons, 0);
    assert.equal(engineControls.engines.length, 2);
    assert.match(engineControls.engines[0].text, /Install Cod4R DedRun/);
    assert.equal(engineControls.engines[0].disabled, false);
    assert.match(engineControls.engines[0].name, /Call of Duty 4/);
    assert.equal(engineControls.engines[1].disabled, true);
    assert.match(engineControls.missingHint, /Choose MW2 folder first/);
    assert.match(engineControls.plutonium, /Plutonium/);
    // Declining an engine update confirmation must not call IPC.
    await win.webContents.executeJavaScript("window.confirm = () => false; document.querySelector('.engine-sidebar-item:first-child .root-button').click()");
    assert.equal(engineAttempts, 0);
    await win.webContents.executeJavaScript("window.confirm = () => true; document.querySelector('.engine-sidebar-item:first-child .root-button').click()");
    await waitFor(win, '.notice-error');
    assert.equal(engineAttempts, 1);
    assert.match(await win.webContents.executeJavaScript("document.querySelector('.notice-error')?.textContent"), /Synthetic engine update refused/);
    win.webContents.send('manager:event', { type: 'state', snapshot: gameSnapshot({ engineBusy: true,
      setup: { ...snapshot.games[0].setup, engine: true }, blockers: [] }) });
    await waitFor(win, '.state-chip.attention');
    assert.equal(await win.webContents.executeJavaScript("document.querySelector('.detail-hero-action .primary-button')?.disabled"), true);
    assert.equal(await win.webContents.executeJavaScript("document.querySelector('.engine-sidebar-item:first-child .root-button')?.disabled"), true);
    win.webContents.send('manager:event', { type: 'state', snapshot: gameSnapshot({ engineBusy: false,
      setup: { ...snapshot.games[0].setup, engine: true }, blockers: [] }) });
    await waitFor(win, '.engine-sidebar-item:first-child .root-button:not(:disabled)');
    assert.match(await win.webContents.executeJavaScript("document.querySelector('.engine-sidebar-item:first-child .root-button')?.textContent"), /Update Cod4R DedRun/);
    win.setSize(1000, 600);
    await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const check = () => innerWidth > 850 ? resolve() : requestAnimationFrame(check);
      check(); setTimeout(() => reject(new Error('Desktop resize did not complete')), 10000);
    })`);
    const footerLayout = await win.webContents.executeJavaScript(`(() => {
      const footer = document.querySelector('.sidebar-footer').getBoundingClientRect();
      return { top: footer.top, bottom: footer.bottom, height: innerHeight, width: innerWidth, scrollWidth: document.documentElement.scrollWidth };
    })()`);
    assert.ok(footerLayout.top >= 0 && footerLayout.bottom <= footerLayout.height,
      `Engine and Plutonium update buttons must remain accessible at the bottom left in a short desktop window: ${JSON.stringify(footerLayout)}`);
    assert.ok(footerLayout.scrollWidth <= footerLayout.width, 'Sidebar update buttons must not cause horizontal overflow');
    // IW4x also switches from disabled Install to Update once its game folder
    // and engine are present, without adding a button to MW2 Overview.
    const mw2Ready = gameSnapshot({ engineBusy: false });
    Object.assign(mw2Ready.games.find(entry => entry.id === 'mw2'), {
      installed: true, pathSource: 'manual', gamePath: 'C:\\Example\\MW2', configPath: 'C:\\Example\\MW2\\userraw\\serverlan.cfg',
      setup: { folder: true, engine: false, plutonium: null, key: null, bots: false, config: false, maps: false },
      blockers: ['IW4x executable missing.'],
    });
    win.webContents.send('manager:event', { type: 'state', snapshot: mw2Ready });
    await waitFor(win, '.engine-sidebar-item:nth-child(2) .root-button:not(:disabled)');
    assert.match(await win.webContents.executeJavaScript("document.querySelector('.engine-sidebar-item:nth-child(2) .root-button')?.textContent"), /Install IW4x/);
    await win.webContents.executeJavaScript("[...document.querySelectorAll('.sidebar .game-nav-item')].find(button => button.textContent.includes('MW2')).click()");
    await waitFor(win, 'main[aria-label^="Modern Warfare 2"] .setup-wizard');
    assert.equal(await win.webContents.executeJavaScript("[...document.querySelectorAll('main button')].filter(button => /^(Install|Update) IW4x/.test(button.textContent.trim())).length"), 0);
    mw2Ready.games.find(entry => entry.id === 'mw2').setup.engine = true;
    mw2Ready.games.find(entry => entry.id === 'mw2').blockers = [];
    win.webContents.send('manager:event', { type: 'state', snapshot: mw2Ready });
    await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const check = () => document.querySelector('.engine-sidebar-item:nth-child(2) .root-button')?.textContent.includes('Update IW4x');
      if (check()) return resolve();
      const observer = new MutationObserver(() => { if (check()) { observer.disconnect(); resolve(); } });
      observer.observe(document.body, { subtree: true, childList: true });
      setTimeout(() => { observer.disconnect(); reject(new Error('IW4x sidebar button did not switch to Update')); }, 10000);
    })`);

    console.log('Synthetic packaged renderer: startup fallback, dashboard, BO1 LAN guard, draft retention, lifecycle, map recovery, narrow layout and modal keyboard smoke passed.');
  } finally { win.destroy(); app.quit(); }
}).catch(error => { console.error(error); app.exit(1); });
