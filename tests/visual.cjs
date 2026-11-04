// Optional read-only desktop smoke test: npm run build, then
// node_modules/.bin/electron tests/visual.cjs (from this folder).
// Checks the real renderer with real setup data; never launches a game.
// Screenshots containing local paths are opt-in with BOTLAND_VISUAL_SCREENSHOTS=1.
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, safeStorage } = require('electron');
const { ServerManager } = require('../electron/manager.cjs');
const { KeyStore } = require('../electron/key-store.cjs');
const { BotWarfareInstaller } = require('../electron/botwarfare-install.cjs');

// Use the platform's normal compositor for screenshots.
app.whenReady().then(async () => {
  const root = '';
  const source = { resolveSource: async () => ({ supported: false, ref: null, notes: '', status: 'offline' }) };
  const installer = new BotWarfareInstaller({ source, localAppData: process.env.LOCALAPPDATA });
  const manager = new ServerManager(path.join(app.getPath('userData'), 'settings.json'), () => {}, root,
    { keyStore: new KeyStore(path.join(app.getPath('userData'), 'keys.json'), safeStorage), modSource: source, modInstaller: installer });
  await manager.initialize();
  await manager.rescanInstallations();
  ipcMain.handle('manager:action', async (_event, action, payload) => {
    if (action === 'snapshot') return manager.snapshot();
    if (action === 'maps') return manager.maps(payload.id);
    if (action === 'document') return manager.document(payload.id, payload.target, payload.mode);
    if (action === 'artwork') return manager.artwork(payload.id, payload.kind);
    if (action === 'firewallStatus') return manager.firewallStatus(payload.id);
    if (action === 'botStatus') return manager.botStatus(payload.id);
    if (action === 'listConfigBackups') return manager.listConfigBackups(payload.id, payload.target, payload.mode);
    throw new Error('Visual smoke test is read-only.');
  });
  const win = new BrowserWindow({ width: 1380, height: 860, show: true, backgroundColor: '#1B1A19',
    webPreferences: { preload: path.resolve(__dirname, '..', 'electron', 'preload.cjs'), contextIsolation: true, sandbox: true } });
  win.webContents.on('console-message', details => { if (details.level === 'error') console.error('Renderer:', details.message); });
  console.log('Loading packaged renderer…');
  await win.loadFile(path.resolve(__dirname, '..', 'dist', 'index.html'));
  console.log('Renderer loaded.');
  const waitFor = (selector, timeout = 10000) => win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const selector = ${JSON.stringify(selector)};
    if (document.querySelector(selector)) return resolve();
    const observer = new MutationObserver(() => { if (document.querySelector(selector)) { observer.disconnect(); resolve(); } });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true });
    setTimeout(() => { observer.disconnect(); reject(new Error('Timed out waiting for ' + selector)); }, ${timeout});
  })`);
  const capture = async name => {
    if (process.env.BOTLAND_VISUAL_SCREENSHOTS !== '1') return;
    const output = path.join(process.env.LOCALAPPDATA || '.', 'Temp', 'opencode');
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(output, name), (await win.capturePage()).toPNG());
  };
  await waitFor('.server-card, .missing-row');
  const brand = await win.webContents.executeJavaScript("({name:document.querySelector('.brand strong')?.textContent,title:document.title})");
  if (brand.name !== 'botLANd' || brand.title !== 'botLANd Server Manager') throw new Error(`Unexpected branding: ${JSON.stringify(brand)}`);
  const summary = await win.webContents.executeJavaScript("({detected:document.querySelectorAll('.server-card').length,missing:document.querySelectorAll('.missing-row').length,api:typeof window.manager?.artwork})");
  if (summary.detected + summary.missing !== 6 || summary.api !== 'function') throw new Error(`Unexpected setup dashboard: ${JSON.stringify(summary)}`);
  console.log(`Dashboard rendered ${summary.detected} detected game(s) and ${summary.missing} not installed.`);
  await capture('botland-dashboard.png');
  if (summary.detected) {
    const expected = await win.webContents.executeJavaScript("document.querySelector('.server-card h3').textContent");
    await win.webContents.executeJavaScript("document.querySelector('.server-card').click()");
    await waitFor('.detail-hero');
    const heading = await win.webContents.executeJavaScript("document.querySelector('.detail-hero h1').textContent");
    if (heading !== expected) throw new Error(`Unexpected game detail: ${heading}`);
    await win.webContents.executeJavaScript("[...document.querySelectorAll('.detail-tabs button')].find(x => x.textContent.includes('Configuration')).click()");
    await waitFor('.config-main');
    console.log('Game detail and configuration workspace rendered.');
    await capture('botland-detail.png');
  }
  win.close(); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
