// Offline accessibility/layout audit of the built renderer using ONLY src/demo.ts.
// Never imports ServerManager or reads a real installation/user profile.
// Run after build: node_modules/.bin/electron.cmd tests/accessibility-smoke.cjs
// Add --screenshots to refresh the two public README images with synthetic data.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { app, BrowserWindow, ipcMain, session } = require('electron');

const root = path.join(__dirname, '..');
const readActions = new Set(['snapshot', 'maps', 'document', 'artwork', 'botStatus', 'firewallStatus', 'listConfigBackups']);
const captures = process.argv.includes('--screenshots');
const accessibilityFailures = [];
const temporaryRoot = path.join(process.env.LOCALAPPDATA || require('node:os').tmpdir(), ...(process.env.LOCALAPPDATA ? ['Temp', 'opencode'] : ['opencode']));
require('node:fs').mkdirSync(temporaryRoot, { recursive: true });
const profile = require('node:fs').mkdtempSync(path.join(temporaryRoot, 'botland-a11y-'));
app.setPath('userData', profile);

async function waitFor(win, selector) {
  await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const selector = ${JSON.stringify(selector)};
    if (document.querySelector(selector)) return resolve();
    const observer = new MutationObserver(() => {
      if (document.querySelector(selector)) { observer.disconnect(); clearTimeout(timer); resolve(); }
    });
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Timed out: ' + selector)); }, 10000);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  })`);
}
async function audit(win, name, axeSource) {
  await win.webContents.executeJavaScript('document.fonts.ready');
  await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await win.webContents.executeJavaScript(axeSource);
  // These aria-hidden glyphs are decorative artwork, not readable UI text.
  // Keep meaningful labels, muted text, and status chips in the contrast audit.
  const result = await win.webContents.executeJavaScript(`axe.run({ exclude: [
    '.intro-mark[aria-hidden="true"]', '.detail-hero-art[aria-hidden="true"]',
    '.card-art-number[aria-hidden="true"]', '.card-art-code[aria-hidden="true"]'
  ] }, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] }
  }).then(result => ({ violations: result.violations.map(item => ({
    id: item.id, impact: item.impact, help: item.help,
    nodes: item.nodes.map(node => ({ target: node.target, summary: node.failureSummary }))
  })), incomplete: result.incomplete.length }))`);
  if (result.violations.length) accessibilityFailures.push({ page: name, violations: result.violations });
  console.log(`Accessibility: ${name} ${result.violations.length ? 'FAILED' : 'passed'} (${result.incomplete} checks require manual review).`);
}
async function layout(win, name) {
  await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const result = await win.webContents.executeJavaScript(`(() => {
    const shell = document.querySelector('.app-shell');
    const pane = document.querySelector('.main-pane');
    const width = document.documentElement.clientWidth;
    return { overflow: document.documentElement.scrollWidth - width,
      shell: Math.round(shell.getBoundingClientRect().width),
      pane: Math.round(pane.getBoundingClientRect().width), width };
  })()`);
  assert.ok(result.overflow <= 1, `${name}: horizontal overflow ${JSON.stringify(result)}`);
  assert.ok(result.pane > 0 && result.shell <= result.width + 1, `${name}: collapsed layout ${JSON.stringify(result)}`);
}
async function responsive(win, name) {
  for (const width of [640, 900, 1100, 1380]) {
    win.setSize(width, 700);
    await layout(win, `${name} ${width}px`);
  }
  win.setSize(1380, 1000);
  win.webContents.setZoomFactor(2);
  try { await layout(win, `${name} 200% zoom`); }
  finally { win.webContents.setZoomFactor(1); }
}
async function capture(win, filename) {
  if (!captures) return;
  await win.webContents.executeJavaScript("document.querySelector('.main-pane').scrollTo(0, 0)");
  await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await fs.writeFile(path.join(root, 'docs', 'images', filename), (await win.capturePage()).toPNG());
}

// Isolate even Chromium's cache from the normal Electron or botLANd profile.
app.whenReady().then(async () => {
  const syntheticSession = session.defaultSession;
  syntheticSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !/^(?:file|data):/.test(details.url) }));
  syntheticSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  const source = await fs.readFile(path.join(root, 'src', 'demo.ts'), 'utf8');
  const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(javascript, { module, exports: module.exports, structuredClone, document: { documentElement: { dataset: {} } } }, { filename: 'src/demo.ts' });
  const manager = module.exports.createDemoManager();
  const snapshot = await manager.snapshot();
  assert.equal(snapshot.games.length, 6);
  assert.ok(snapshot.games.every(game => !game.gamePath || game.gamePath.startsWith('C:\\Example\\')));
  const win = new BrowserWindow({ width: 1380, height: 1000, show: false,
    webPreferences: { preload: path.join(root, 'electron', 'preload.cjs'), session: syntheticSession, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  ipcMain.handle('manager:action', (event, action, payload = {}) => {
    assert.equal(event.sender, win.webContents);
    assert.equal(event.senderFrame, win.webContents.mainFrame);
    if (action === 'setUnsavedChanges') return true;
    if (!readActions.has(action)) throw new Error('Accessibility smoke refuses mutations.');
    if (action === 'snapshot') return manager.snapshot();
    if (action === 'document') return manager.document(payload.id, payload.target, payload.mode);
    if (action === 'artwork') return null;
    return manager[action](payload.id);
  });
  const axeSource = await fs.readFile(require.resolve('axe-core/axe.min.js'), 'utf8');
  const rendererErrors = [];
  win.webContents.on('console-message', details => { if (details.level === 'error' && !/Electron Security Warning/.test(details.message)) rendererErrors.push(details.message); });
  try {
    await win.loadFile(path.join(root, 'dist', 'index.html'));
    await waitFor(win, '.server-card');
    await audit(win, 'Dashboard', axeSource);
    await responsive(win, 'Dashboard');
    await capture(win, 'dashboard-demo.png');
    for (const game of snapshot.games) {
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('.game-nav-item')].find(button => button.querySelector('.nav-game-label')?.firstChild.textContent === ${JSON.stringify(game.short)}).click()`);
      await waitFor(win, '.detail-hero');
      await audit(win, `${game.short} Overview`, axeSource);
      await responsive(win, `${game.short} Overview`);
      if (!game.installed) continue;
      for (const [label, selector] of [['Configuration', '.config-main'], ['Maps & modes', '.rotation-panel'], ['Console', '.console-panel']]) {
        await win.webContents.executeJavaScript(`[...document.querySelectorAll('.detail-tabs button')].find(button => button.textContent === ${JSON.stringify(label)}).click()`);
        await waitFor(win, selector);
        if (label === 'Configuration') await waitFor(win, '.config-field-grid input, .config-field-grid select');
        await audit(win, `${game.short} ${label}`, axeSource);
        await responsive(win, `${game.short} ${label}`);
        if (game.id === 'cod4' && label === 'Configuration') await capture(win, 'configuration-demo.png');
      }
    }
    assert.equal(accessibilityFailures.length, 0, JSON.stringify(accessibilityFailures, null, 2));
    assert.deepEqual(rendererErrors, [], 'Renderer console errors');
    console.log('Synthetic accessibility and layout smoke passed. No real setup data or write actions were used.');
  } finally { win.destroy(); }
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
app.on('will-quit', () => {
  // Cache locks can remain until Chromium exits; leave only isolated synthetic
  // cache data if Windows refuses cleanup rather than touching another profile.
  if (profile) {
    try { require('node:fs').rmSync(profile, { recursive: true, force: true, maxRetries: 2 }); }
    catch { /* Windows releases Chromium cache locks on process exit. */ }
  }
});
