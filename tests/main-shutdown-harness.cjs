const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function event() { return { prevented: false, preventDefault() { this.prevented = true; } }; }
async function fakeMain(t, manager) {
  const temporaryRoot = path.join(process.env.LOCALAPPDATA || os.tmpdir(), ...(process.env.LOCALAPPDATA ? ['Temp', 'opencode'] : ['opencode']));
  await fs.mkdir(temporaryRoot, { recursive: true });
  const profile = await fs.mkdtemp(path.join(temporaryRoot, 'botland-main-harness-'));
  t.after(() => fs.rm(profile, { recursive: true, force: true }));
  const handlers = {};
  const prompts = [];
  const errors = [];
  let win;
  let quitCalls = 0;
  let allowedQuits = 0;
  let onQuit = () => {};
  class FakeWindow {
    constructor() {
      win = this;
      this.handlers = {};
      this.webContents = { mainFrame: {}, send() {}, setWindowOpenHandler() {}, on: (name, handler) => { this.handlers[name] = handler; } };
    }
    once() {}
    on(name, handler) { this.handlers[name] = handler; }
    isDestroyed() { return false; }
    loadURL() { return Promise.resolve(); }
  }
  const app = {
    isPackaged: false, requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(), on: (name, handler) => { handlers[name] = handler; },
    getPath: name => path.join(profile, name),
    quit: () => {
      quitCalls++;
      onQuit();
      const quitting = event();
      handlers['before-quit'](quitting);
      if (!quitting.prevented) allowedQuits++;
    },
  };
  const dialog = {
    showMessageBoxSync: (...args) => { const options = args.at(-1); prompts.push(options); return options.type === 'warning' ? 1 : 0; },
    showMessageBox: async (...args) => { const options = args.at(-1); prompts.push(options); return { response: options.type === 'warning' ? 1 : 0 }; },
    showErrorBox: (title, message) => { errors.push({ title, message }); },
  };
  Object.assign(manager, { initialize: async () => {}, rescanInstallations: async () => {}, checkBotUpdates: async () => {} });
  const source = await fs.readFile(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8');
  vm.runInNewContext(source, {
    module: { exports: {} }, process, __dirname: path.join(__dirname, '..', 'electron'),
    require: name => name === 'electron' ? {
      app, dialog, BrowserWindow: FakeWindow, ipcMain: { handle() {} }, shell: {},
      session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } },
    } : name === './manager.cjs' ? { ServerManager: class { constructor() { return manager; } } }
      : ['./key-store.cjs', './botwarfare-source.cjs', './botwarfare-install.cjs'].includes(name)
        ? { KeyStore: class {}, BotWarfareSource: class {}, BotWarfareInstaller: class {} }
        : name.startsWith('./') ? require(path.join(__dirname, '..', 'electron', name)) : require(name),
  });
  for (let attempt = 0; attempt < 100 && !win; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(win, JSON.stringify(errors));
  assert.deepEqual(errors, []);
  return { handlers, win, prompts, errors, get quitCalls() { return quitCalls; }, get allowedQuits() { return allowedQuits; }, onQuit: callback => { onQuit = callback; } };
}
async function tick() { await new Promise(resolve => setImmediate(resolve)); }
module.exports = { fakeMain, deferred, event, tick };
