// Optional read-only desktop smoke test: npm run build, then
// node_modules/.bin/electron tests/visual.cjs (from this folder).
// Captures the real renderer with real setup checks; never launches a game.
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');
const { ServerManager } = require('../electron/manager.cjs');

// Use the platform's normal compositor for screenshots.
app.whenReady().then(async () => {
  const root = path.resolve(__dirname, '..', '..');
  const manager = new ServerManager(path.join(app.getPath('userData'), 'settings.json'), () => {}, root);
  await manager.initialize();
  ipcMain.handle('manager:action', async (_event, action, payload) => {
    if (action === 'snapshot') return manager.snapshot();
    if (action === 'maps') return manager.maps(payload.id);
    if (action === 'document') return manager.document(payload.id, payload.target, payload.mode);
    if (action === 'artwork') return manager.artwork(payload.id, payload.kind);
    if (action === 'firewallStatus') return manager.firewallStatus(payload.id);
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
  const output = path.join(process.env.LOCALAPPDATA || '.', 'Temp', 'opencode');
  await fs.mkdir(output, { recursive: true });
  await waitFor('.server-card');
  // Artwork loads after the cards render; give cached Steam art a moment before judging the fallback.
  await waitFor('.card-art.has-image', 4000).catch(() => {});
  const brand = await win.webContents.executeJavaScript("({name:document.querySelector('.brand strong')?.textContent,title:document.title})");
  if (brand.name !== 'botLANd' || brand.title !== 'botLANd Server Manager') throw new Error(`Unexpected branding: ${JSON.stringify(brand)}`);
  const art = await win.webContents.executeJavaScript("({cards:document.querySelectorAll('.card-art').length,withImage:document.querySelectorAll('.card-art.has-image').length,api:typeof window.manager?.artwork})");
  if (art.cards !== 6 || art.api !== 'function') throw new Error(`Artwork or fallback unavailable: ${JSON.stringify(art)}`);
  console.log(art.withImage ? 'Dashboard and cached game artwork rendered.' : 'Dashboard and fallback artwork rendered.');
  try { await fs.writeFile(path.join(output, 'botland-dashboard.png'), (await win.capturePage()).toPNG()); }
  catch { console.log('Desktop screenshot capture is not available in this host.'); }
  await win.webContents.executeJavaScript("document.querySelector('.server-card').click()");
  await waitFor('.detail-hero');
  const heading = await win.webContents.executeJavaScript("document.querySelector('.detail-hero h1').textContent");
  if (heading !== 'Call of Duty 4') throw new Error(`Unexpected game detail: ${heading}`);
  await win.webContents.executeJavaScript("[...document.querySelectorAll('.detail-tabs button')].find(x => x.textContent.includes('Configuration')).click()");
  await waitFor('.config-main');
  await waitFor('.config-group');
  const group = await win.webContents.executeJavaScript("document.querySelector('.config-group-title').textContent");
  if (!group.includes('SERVER')) throw new Error(`Unexpected config group: ${group}`);
  await win.webContents.executeJavaScript("[...document.querySelectorAll('.config-switch button')].find(x => x.textContent.includes('All existing settings')).click()");
  await waitFor('.advanced-row');
  const count = await win.webContents.executeJavaScript("document.querySelectorAll('.advanced-row').length");
  if (count < 20) throw new Error(`Advanced editor only showed ${count} settings.`);
  try { await fs.writeFile(path.join(output, 'botland-detail.png'), (await win.capturePage()).toPNG()); } catch { /* Unsupported compositor. */ }
  console.log('Desktop dashboard, game detail, guided settings and advanced editor rendered.');
  win.close(); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
