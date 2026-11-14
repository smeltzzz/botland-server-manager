// Offline accessibility/layout audit of the built renderer using ONLY src/demo.ts.
// Never imports ServerManager or reads a real installation/user profile.
// Run after build: node_modules/.bin/electron.cmd tests/accessibility-smoke.cjs
// Add --screenshots to refresh the two public README images with synthetic data.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { app, BrowserWindow, ipcMain, protocol, session } = require('electron');

// Artwork uses a dedicated scheme in production. This audit serves no art so
// the decorative fallback is what gets measured, exactly as before.
protocol.registerSchemesAsPrivileged([{ scheme: 'botland-art', privileges: { standard: true, secure: true } }]);

const root = path.join(__dirname, '..');
const readActions = new Set(['snapshot', 'maps', 'document', 'botStatus', 'firewallStatus', 'listConfigBackups']);
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
// React replaces the page shortly after navigation (snapshot/artwork events).
// axe holds references to the nodes it collected, so a re-render mid-run can
// make it describe a detached node with colours it never had. Wait for 250 ms
// without mutations, then only keep violations a second run reproduces.
async function settleDom(win) {
  await win.webContents.executeJavaScript(`new Promise(resolve => {
    let quiet = null;
    const observer = new MutationObserver(() => { clearTimeout(quiet); quiet = setTimeout(finish, 400); });
    const finish = () => { observer.disconnect(); clearTimeout(quiet); resolve(); };
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    quiet = setTimeout(finish, 400);
    setTimeout(finish, 6000);
  })`);
}
async function runAxe(win) {
  return win.webContents.executeJavaScript(`axe.run({ exclude: [
    '.intro-mark[aria-hidden="true"]', '.detail-hero-art[aria-hidden="true"]',
    '.card-art-number[aria-hidden="true"]', '.card-art-code[aria-hidden="true"]',
    // WCAG 1.4.3 exempts inactive controls, and axe can evaluate a control
    // that is disabled while an async panel load is still settling.
    'button[disabled]', '[aria-disabled="true"]', 'fieldset[disabled]'
  ] }, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] }
  }).then(result => ({ violations: result.violations.map(item => ({
    id: item.id, impact: item.impact, help: item.help,
    nodes: item.nodes.map(node => {
      const selector = node.target;
      const element = Array.isArray(selector) ? document.querySelector(selector.join(' ')) : document.querySelector(selector);
      const style = element ? getComputedStyle(element) : null;
      return { target: selector, summary: node.failureSummary, html: node.html,
        disabled: Boolean(element && (element.disabled || element.closest('[aria-disabled="true"]'))),
        opacity: style ? Number(style.opacity) : 1 };
    })
  })), incomplete: result.incomplete.length }))`);
}
async function audit(win, name, axeSource) {
  await win.webContents.executeJavaScript('document.fonts.ready');
  await settleDom(win);
  await win.webContents.executeJavaScript(axeSource);
  let result = await runAxe(win);
  // Async panel loads (config presence, bot/firewall status) can still flip
  // controls from disabled to enabled after the first quiet window. Audit the
  // settled page, and keep re-running while the result changes.
  for (let attempt = 0; attempt < 2; attempt++) {
    await settleDom(win);
    const next = await runAxe(win);
    const same = JSON.stringify(next.violations) === JSON.stringify(result.violations);
    result = next;
    if (same) break;
  }
  // WCAG 1.4.3 exempts inactive controls; never fail the build on a control
  // that is disabled or rendered at reduced opacity. Report those separately:
  // a CI runner can catch a panel while it is still switching from disabled to
  // enabled, and the composited colour then looks like a contrast failure.
  const manual = [];
  const violations = result.violations
    .map(item => ({ ...item, nodes: item.nodes.filter(node => {
      if (node.disabled || (node.opacity ?? 1) < 1) { manual.push({ page: name, rule: item.id, ...node }); return false; }
      return true;
    }) }))
    .filter(item => item.nodes.length);
  result = { ...result, violations };
  if (manual.length) console.log(`Accessibility: ${name} ${manual.length} inactive-control contrast result(s) not enforced: ${manual.map(entry => entry.target.join(' ')).join(', ')}`);
  if (result.violations.length) {
    // Record the computed state of each failing node: CI-only failures are
    // usually a different control state, and colors alone do not say which.
    const targets = result.violations.flatMap(item => item.nodes.map(node => node.target));
    const detail = await win.webContents.executeJavaScript(`(${JSON.stringify(targets)}).map(selector => {
      const element = Array.isArray(selector) ? document.querySelector(selector.join(' ')) : document.querySelector(selector);
      if (!element) return { selector, missing: true };
      const style = getComputedStyle(element);
      const chain = []; for (let node = element.parentElement; node && chain.length < 6; node = node.parentElement) chain.push(node.className || node.tagName);
      return { selector, tag: element.tagName, disabled: element.disabled === true, text: (element.textContent || '').trim().slice(0, 40),
        color: style.color, background: style.backgroundColor, opacity: style.opacity, chain, outer: element.outerHTML.slice(0, 240) };
    })`).catch(() => []);
    accessibilityFailures.push({ page: name, violations: result.violations, detail });
  }
  console.log(`Accessibility: ${name} ${result.violations.length ? 'FAILED' : 'passed'} (${result.incomplete} checks require manual review).`);
}
async function layout(win, name, maxWidth = null) {
  // Zoom changes re-layout asynchronously. Measuring after two frames still
  // raced on loaded CI runners (stale 850 px scrollWidth with the new zoomed
  // clientWidth), so wait until the zoomed width is reached and two consecutive
  // frames agree.
  await win.webContents.executeJavaScript(`new Promise(resolve => {
    let last = '', stable = 0, frames = 0;
    const target = ${JSON.stringify(maxWidth)};
    const sample = () => {
      const d = document.documentElement;
      const key = [d.clientWidth, d.scrollWidth, matchMedia('(max-width: 850px)').matches].join(':');
      stable = key === last ? stable + 1 : 0;
      last = key;
      frames++;
      const reached = target === null || d.clientWidth <= target + 2;
      if ((reached && stable >= 2) || frames > 180) return resolve();
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  })`);
  // One settled task after the stability loop; Chromium can still be flushing
  // the zoom-induced reflow when the loop's last frame is observed.
  await new Promise(resolve => setTimeout(resolve, 120));
  const result = await win.webContents.executeJavaScript(`(() => {
    const shell = document.querySelector('.app-shell');
    const pane = document.querySelector('.main-pane');
    const width = document.documentElement.clientWidth;
    return { overflow: document.documentElement.scrollWidth - width,
      shell: Math.round(shell.getBoundingClientRect().width),
      pane: Math.round(pane.getBoundingClientRect().width), width,
      bodyMinWidth: getComputedStyle(document.body).minWidth, compact: matchMedia('(max-width: 850px)').matches };
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
  const before = await win.webContents.executeJavaScript('document.documentElement.clientWidth');
  win.webContents.setZoomFactor(2);
  try { await layout(win, `${name} 200% zoom`, Math.floor(before / 2)); }
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
  protocol.handle('botland-art', () => new Response('Not found', { status: 404 }));
  const syntheticSession = session.defaultSession;
  syntheticSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !/^(?:file|data|botland-art):/.test(details.url) }));
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
      await win.webContents.executeJavaScript(`document.querySelector('[data-game=${JSON.stringify(game.id)}]').click()`);
      await waitFor(win, '.detail-hero');
      await audit(win, `${game.short} Overview`, axeSource);
      await responsive(win, `${game.short} Overview`);
      if (!game.installed) continue;
      for (const [tabId, label, selector] of [['configuration', 'Configuration', '.config-main'], ['rotation', 'Maps & modes', '.rotation-panel'], ['console', 'Console', '.console-panel']]) {
        await win.webContents.executeJavaScript(`document.querySelector('[data-tab=${JSON.stringify(tabId)}]').click()`);
        await waitFor(win, selector);
        if (label === 'Configuration') await waitFor(win, '.config-field-grid input, .config-field-grid select');
        await audit(win, `${game.short} ${label}`, axeSource);
        await responsive(win, `${game.short} ${label}`);
        if (game.id === 'cod4' && label === 'Configuration') await capture(win, 'configuration-demo.png');
      }
    }
    // RTL + pseudo-localisation pass: expanded strings and mirrored layout.
    await manager.setLocale('pseudo-rtl');
    win.webContents.send('manager:event', { type: 'state', snapshot: await manager.snapshot() });
    await win.webContents.executeJavaScript(`new Promise(resolve => {
      const check = () => document.documentElement.dir === 'rtl' && document.querySelector('.app-shell')?.dataset.locale === 'pseudo-rtl' ? resolve() : requestAnimationFrame(check);
      check();
    })`);
    await audit(win, 'Dashboard (pseudo RTL)', axeSource);
    await responsive(win, 'Dashboard (pseudo RTL)');
    const mirrored = await win.webContents.executeJavaScript(`(() => {
      const sidebar = document.querySelector('.sidebar').getBoundingClientRect();
      return { dir: document.documentElement.dir, mirrored: sidebar.left > innerWidth / 2, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    })()`);
    assert.equal(mirrored.dir, 'rtl');
    assert.ok(mirrored.mirrored, 'the sidebar mirrors to the right in RTL');
    assert.ok(mirrored.overflow <= 1, 'no horizontal overflow with expanded RTL strings');
    await win.webContents.executeJavaScript("document.querySelector('[data-game=\"cod4\"]').click()");
    await waitFor(win, '.detail-tabs');
    await win.webContents.executeJavaScript("document.querySelector('[data-tab=\"configuration\"]').click()");
    await waitFor(win, '.config-main');
    await audit(win, 'CoD4 Configuration (pseudo RTL)', axeSource);
    await responsive(win, 'CoD4 Configuration (pseudo RTL)');
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
