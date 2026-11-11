const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const vm = require('node:vm');

// Intercept only this test file's manager import: no real game executable or taskkill is run.
const originalLoad = Module._load;
let spawnImpl = () => { throw new Error('Unexpected spawn'); };
let execImpl = (_file, _args, _options, callback) => callback(null, '', '');
Module._load = function (request, parent, isMain) {
  if (request === 'node:child_process' && parent?.filename === require.resolve('../electron/manager.cjs')) {
    return { spawn: (...args) => spawnImpl(...args), execFile: (...args) => execImpl(...args) };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { ServerManager } = require('../electron/manager.cjs');
Module._load = originalLoad;

async function temporary(testContext) {
  const root = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp', 'opencode');
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'botland-lifecycle-'));
  testContext.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
function managerAt(dir) { return new ServerManager(path.join(dir, 'settings.json'), () => {}); }
function readyToStart(manager, dir, port = 28960) {
  manager.broadcastState = async () => {};
  manager.check = async () => ({ blockers: [], gamePath: dir, options: { port, mode: 'dom', shuffle: false, selectedMaps: [] } });
  manager.portInUse = async () => false;
  manager.maps = async () => ({ maps: ['mp_alpha', 'mp_bravo'], modes: [{ value: 'dom' }] });
}
// main.cjs denies all web permissions on the default session at startup.
const fakeSession = { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } };
function fakeChild(pid) {
  const child = new EventEmitter();
  Object.assign(child, { pid, stdout: null, stderr: null, exitCode: null, signalCode: null });
  return child;
}

test('unreadable base config is a blocker and snapshot still resolves', async t => {
  const dir = await temporary(t);
  const manager = managerAt(dir);
  manager.data.games.mw3 = { gamePath: dir };
  manager.data.games.cod4 = { gamePath: dir };
  await fs.mkdir(path.join(dir, 'admin', 'server.cfg'), { recursive: true });
  await fs.mkdir(path.join(dir, 'main', 'botserver.cfg'), { recursive: true });
  const check = await manager.check('mw3');
  assert.ok(check.blockers.some(message => message.startsWith('Could not read server config')));
  const state = await manager.snapshot();
  for (const id of ['mw3', 'cod4']) {
    assert.ok(state.games.find(game => game.id === id).blockers.some(message => message.startsWith('Could not read server config')));
  }
  assert.ok(!state.games.find(game => game.id === 'waw').blockers.some(message => message.startsWith('Could not read server config')));
  assert.ok(state.games.find(game => game.id === 'waw').blockers.some(message => message.includes('was not found in your Steam libraries')));
});

test('MW3 preflight accepts x86 and proven-working x64 executables, but blocks invalid PE and missing runtime DLL', async t => {
  const dir = await temporary(t);
  const manager = managerAt(dir);
  manager.data.games.mw3 = { gamePath: dir };
  await fs.mkdir(path.join(dir, 'admin'), { recursive: true });
  await fs.writeFile(path.join(dir, 'admin', 'server.cfg'), 'exec server_live.cfg\n');
  const binary = Buffer.alloc(0x88);
  binary.write('MZ'); binary.writeUInt32LE(0x80, 0x3c);
  binary.write('PE\0\0', 0x80);
  binary.writeUInt16LE(0x8664, 0x84);
  await fs.writeFile(path.join(dir, 'iw5mp.exe'), binary);
  let blockers = (await manager.check('mw3')).blockers;
  assert.ok(!blockers.some(message => message.includes('PE architecture')));
  assert.ok(blockers.some(message => message.includes('mss32.dll')));
  binary.writeUInt16LE(0x14c, 0x84);
  await fs.writeFile(path.join(dir, 'iw5mp.exe'), binary);
  await fs.writeFile(path.join(dir, 'mss32.dll'), 'fixture');
  blockers = (await manager.check('mw3')).blockers;
  assert.ok(!blockers.some(message => message.includes('PE architecture') || message.includes('mss32.dll')));
  binary.writeUInt16LE(0x200, 0x84);
  await fs.writeFile(path.join(dir, 'iw5mp.exe'), binary);
  assert.ok((await manager.check('mw3')).blockers.some(message => message.includes('unsupported PE architecture')));
});

test('MW3 preflight requires the selected DSR mode and an installed Bot Warfare archive', async t => {
  const dir = await temporary(t);
  const previousLocalAppData = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = dir;
  try {
    const manager = managerAt(dir);
    manager.data.games.mw3 = { gamePath: dir };
    const admin = path.join(dir, 'admin');
    await fs.mkdir(admin, { recursive: true });
    await fs.writeFile(path.join(admin, 'server.cfg'), 'exec server_live.cfg\n');
    let blockers = (await manager.check('mw3')).blockers;
    assert.ok(blockers.some(message => message.includes('DOM_default.dsr')));
    assert.ok(blockers.some(message => message.includes('Bot Warfare archive missing')));
    await fs.writeFile(path.join(admin, 'DOM_default.dsr'), 'gameOpt commonOption.timeLimit "0.0000"\n');
    await fs.mkdir(path.join(dir, 'mods', 'bots'), { recursive: true });
    await fs.writeFile(path.join(dir, 'mods', 'bots', 'z_svr_bots.iwd'), 'fixture');
    blockers = (await manager.check('mw3')).blockers;
    assert.ok(!blockers.some(message => message.includes('DOM_default.dsr') || message.includes('Bot Warfare archive missing')));
    manager.data.games.mw3.mode = 'TDM_default';
    assert.ok((await manager.check('mw3')).blockers.some(message => message.includes('TDM_default.dsr')));
  } finally {
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocalAppData;
  }
});

test('MW3 preflight rejects a base config that clears the Bot Warfare mod', async t => {
  const dir = await temporary(t);
  const manager = managerAt(dir);
  manager.data.games.mw3 = { gamePath: dir };
  const config = path.join(dir, 'admin', 'server.cfg');
  await fs.mkdir(path.dirname(config), { recursive: true });
  await fs.writeFile(config, 'seta fs_game ""\nexec server_live.cfg\n');
  assert.ok((await manager.check('mw3')).blockers.some(message => message.includes('overrides the Bot Warfare mod')));
  await fs.writeFile(config, 'seta fs_game "mods/bots"\nexec server_live.cfg\n');
  assert.ok(!(await manager.check('mw3')).blockers.some(message => message.includes('overrides the Bot Warfare mod')));
});

test('MW3 and BO2 require an active exec directive, not a mention in a comment', async t => {
  const dir = await temporary(t);
  const manager = managerAt(dir);
  for (const [id, config, rotation] of [
    ['mw3', 'admin/server.cfg', 'server_live.cfg'],
    ['bo2', 'main/dedicated.cfg', 'rotation_dom_shuffled.cfg'],
  ]) {
    manager.data.games[id] = { gamePath: dir };
    const file = path.join(dir, config);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `// exec ${rotation}\n/*\nexec ${rotation}\n*/\nset sv_hostname "${rotation}"\n`);
    assert.ok((await manager.check(id)).blockers.some(message => message.startsWith('Base config must exec')));
    await fs.appendFile(file, `ExEc "${rotation.toUpperCase()}" // rotation\n`);
    assert.ok(!(await manager.check(id)).blockers.some(message => message.startsWith('Base config must exec')));
    await fs.writeFile(file, `exec "admin/${rotation}"\n`);
    assert.ok(!(await manager.check(id)).blockers.some(message => message.startsWith('Base config must exec')));
    // A multi-line comment ending on the exec line must not merge it into the previous line.
    await fs.writeFile(file, `set sv_hostname "x" /* note\nmore */ exec ${rotation}\n`);
    assert.ok(!(await manager.check(id)).blockers.some(message => message.startsWith('Base config must exec')));
    // An unterminated comment hides the rest of the file, including the exec.
    await fs.writeFile(file, `/* unfinished\nexec ${rotation}\n`);
    assert.ok((await manager.check(id)).blockers.some(message => message.startsWith('Base config must exec')));
  }
});

test('concurrent settings actions serialize writes without losing a newer change', async t => {
  const dir = await temporary(t);
  const manager = managerAt(dir);
  manager.broadcastState = async () => {};
  let release;
  let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const rename = fs.rename;
  let first = true;
  fs.rename = async (...args) => {
    if (first) { first = false; entered(); await gate; }
    return rename(...args);
  };
  try {
    const firstSave = manager.saveOptions('cod4', { port: 29999 });
    await waiting;
    const secondSave = manager.setUpdateChecks(false);
    release();
    await Promise.all([firstSave, secondSave]);
    const stored = JSON.parse(await fs.readFile(manager.settingsPath, 'utf8'));
    assert.equal(stored.games.cod4.port, 29999);
    assert.equal(stored.updatesEnabled, false);
    assert.ok(!(await fs.readdir(dir)).some(name => name.endsWith('.tmp')));
  } finally { release(); fs.rename = rename; }
});

test('failed settings persistence does not apply uncommitted options', async t => {
  const dir = await temporary(t);
  const manager = managerAt(dir);
  manager.broadcastState = async () => {};
  const rename = fs.rename;
  fs.rename = async () => { throw new Error('read-only settings'); };
  try {
    await assert.rejects(manager.saveOptions('cod4', { port: 30000 }), /read-only settings/);
    assert.equal(manager.options('cod4').port, 28962);
  } finally { fs.rename = rename; }
  await manager.saveOptions('cod4', { port: 30001 });
  assert.equal(manager.options('cod4').port, 30001);
});

test('an async options validation does not overwrite another action on the same game', async t => {
  const manager = managerAt(await temporary(t));
  manager.broadcastState = async () => {};
  let release;
  let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  manager.maps = async () => { entered(); await gate; return { maps: [], modes: [{ value: 'war' }] }; };
  const modeSave = manager.saveOptions('cod4', { mode: 'war' });
  await waiting;
  await manager.saveOptions('cod4', { port: 30000 });
  release();
  await modeSave;
  const stored = JSON.parse(await fs.readFile(manager.settingsPath, 'utf8'));
  assert.equal(stored.games.cod4.port, 30000);
  assert.equal(stored.games.cod4.mode, 'war');
});

test('a rejected initial broadcast cleans up start and releases a waiting stop', async t => {
  const manager = managerAt(await temporary(t));
  manager.broadcastState = async () => { throw new Error('state unavailable'); };
  manager.addLog = () => {};
  const starting = manager.start('cod4');
  const stopping = manager.stop('cod4');
  await assert.rejects(starting, /state unavailable/);
  await stopping;
  assert.equal(manager.hasRunning(), false);
});

test('failed spawn rejects launch and does not require stdout or stderr streams', async t => {
  const dir = await temporary(t);
  await fs.mkdir(path.join(dir, 'main'));
  const manager = managerAt(dir);
  readyToStart(manager, dir);
  spawnImpl = () => {
    const child = fakeChild(undefined);
    queueMicrotask(() => { child.emit('error', new Error('spawn failed')); child.emit('close', null, null); });
    return child;
  };
  await assert.rejects(manager.start('cod4'), /spawn failed/);
  assert.equal(manager.hasRunning(), false);
  assert.ok(manager.logs.get('cod4').some(entry => entry.message.includes('Could not start: spawn failed')));
});

test('active launch port remains reserved after saved options change', async t => {
  const dir = await temporary(t);
  await fs.mkdir(path.join(dir, 'main'));
  const manager = managerAt(dir);
  readyToStart(manager, dir);
  const child = fakeChild(12345);
  spawnImpl = () => { queueMicrotask(() => child.emit('spawn')); return child; };
  execImpl = (_file, _args, _options, callback) => {
    child.exitCode = 0;
    queueMicrotask(() => { child.emit('close', 0, null); callback(null, '', ''); });
  };
  await manager.start('cod4');
  await manager.saveOptions('cod4', { port: 30000 });
  assert.equal(manager.instances.get('cod4').activePort, 28960);
  assert.equal((await manager.snapshot()).games.find(game => game.id === 'cod4').activePort, 28960);
  await assert.rejects(manager.start('mw2'), /already assigned/);
  await manager.stop('cod4');
  assert.equal(manager.hasRunning(), false);
});

test('stop attempts taskkill despite broadcast failure and can retry after taskkill error', async t => {
  const manager = managerAt(await temporary(t));
  manager.broadcastState = async () => { throw new Error('snapshot failed'); };
  const child = fakeChild(12345);
  const instance = { status: 'running', child, cancelled: false, stopPromise: null };
  manager.instances.set('cod4', instance);
  let attempts = 0;
  execImpl = (file, _args, _options, callback) => {
    assert.equal(file, 'taskkill.exe');
    attempts++;
    callback(new Error('access denied'));
  };
  await assert.rejects(manager.stop('cod4'), /Could not stop server: access denied/);
  assert.equal(attempts, 1);
  assert.equal(instance.status, 'running');
  assert.equal(instance.stopPromise, null);
  execImpl = (_file, _args, _options, callback) => {
    attempts++;
    child.exitCode = 0;
    child.emit('close', 0, null);
    callback(null, '', '');
  };
  await manager.stop('cod4');
  assert.equal(attempts, 2);
});

test('window close and before-quit stay blocked while stopAll is pending', async () => {
  const source = await fs.readFile(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8');
  const handlers = {};
  let prompts = 0;
  let quits = 0;
  let resolveStop;
  let running = true;
  let window;
  let startupError = '';
  const stopDone = new Promise(resolve => { resolveStop = resolve; });
  const fakeManager = { initialize: async () => {}, rescanInstallations: async () => {}, hasRunning: () => running, stopAll: () => stopDone };
  class FakeWindow {
    constructor() {
      window = this;
      this.handlers = {};
      this.webContents = { send() {}, setWindowOpenHandler() {}, on() {} };
    }
    once(name, handler) { this.handlers[name] = handler; }
    on(name, handler) { this.handlers[name] = handler; }
    isDestroyed() { return false; }
    loadURL() { return Promise.resolve(); }
  }
  const app = {
    whenReady: () => Promise.resolve(), on: (name, handler) => { handlers[name] = handler; },
    getPath: name => name === 'appData' ? __dirname : path.join(__dirname, 'BotLANd Server Manager'),
    isPackaged: false, quit: () => { quits++; }, requestSingleInstanceLock: () => true,
  };
  const dialog = { showMessageBoxSync: () => { prompts++; return 1; }, showErrorBox: (_title, message) => { startupError = message; } };
  const sandbox = {
    module: { exports: {} }, process, __dirname: path.join(__dirname, '..', 'electron'),
    require: name => name === 'electron' ? { app, dialog, BrowserWindow: FakeWindow, ipcMain: { handle() {} }, shell: {}, session: fakeSession }
      : name === './manager.cjs' ? { ServerManager: class { constructor() { return fakeManager; } } }
        : name === './key-store.cjs' ? { KeyStore: class {} }
          : name === './botwarfare-source.cjs' ? { BotWarfareSource: class {} }
            : name === './botwarfare-install.cjs' ? { BotWarfareInstaller: class {} }
              : name.startsWith('./') ? require(path.join(__dirname, '..', 'electron', name)) : require(name),
  };
  vm.runInNewContext(source, sandbox);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(window, startupError);
  const firstClose = { prevented: false, preventDefault() { this.prevented = true; } };
  window.handlers.close(firstClose);
  assert.equal(firstClose.prevented, true);
  running = false;
  const secondClose = { prevented: false, preventDefault() { this.prevented = true; } };
  window.handlers.close(secondClose);
  const beforeQuit = { prevented: false, preventDefault() { this.prevented = true; } };
  handlers['before-quit'](beforeQuit);
  assert.equal(secondClose.prevented, true);
  assert.equal(beforeQuit.prevented, true);
  assert.equal(prompts, 1);
  assert.equal(quits, 0);
  resolveStop();
  await stopDone;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(quits, 1);
});

test('window close asks before discarding an unsaved draft', async t => {
  const dir = await temporary(t);
  const source = await fs.readFile(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8');
  const handlers = {};
  let window;
  let response = 0;
  const prompts = [];
  const fakeManager = {
    instances: new Map(),
    initialize: async () => {},
    rescanInstallations: async () => {},
    checkBotUpdates: async () => {},
    hasRunning: () => false,
    stopAll: async () => {},
  };
  class FakeWindow {
    constructor() {
      window = this;
      this.handlers = {};
      this.webContents = {
        mainFrame: {}, send() {}, setWindowOpenHandler() {},
        on: (name, handler) => { this.handlers[name] = handler; },
      };
    }
    once() {}
    on(name, handler) { this.handlers[name] = handler; }
    isDestroyed() { return false; }
    loadURL() { return Promise.resolve(); }
  }
  const app = {
    whenReady: () => Promise.resolve(), on: (name, handler) => { handlers[name] = handler; },
    getPath: name => name === 'appData' ? path.join(dir, 'appdata') : path.join(dir, 'userdata'),
    isPackaged: false, quit() {}, requestSingleInstanceLock: () => true,
  };
  let startupError = '';
  const dialog = {
    showMessageBoxSync: (_parent, options) => { prompts.push(options); return response; },
    showErrorBox: (_title, message) => { startupError = message; },
  };
  const sandbox = {
    module: { exports: {} }, process, __dirname: path.join(__dirname, '..', 'electron'),
    require: name => name === 'electron' ? { app, dialog, BrowserWindow: FakeWindow, ipcMain: { handle() {} }, shell: {}, session: fakeSession }
      : name === './manager.cjs' ? { ServerManager: class { constructor() { return fakeManager; } } }
        : name === './key-store.cjs' ? { KeyStore: class {} }
          : name === './botwarfare-source.cjs' ? { BotWarfareSource: class {} }
            : name === './botwarfare-install.cjs' ? { BotWarfareInstaller: class {} }
              : name.startsWith('./') ? require(path.join(__dirname, '..', 'electron', name)) : require(name),
  };
  vm.runInNewContext(source, sandbox);
  for (let attempt = 0; attempt < 100 && !window; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(window, startupError);
  const guard = window.handlers['will-prevent-unload'];
  assert.equal(typeof guard, 'function');

  const keep = { prevented: false, preventDefault() { this.prevented = true; } };
  guard(keep);
  assert.equal(keep.prevented, false, 'Keeping the draft must leave the unload blocked');
  response = 1;
  const discard = { prevented: false, preventDefault() { this.prevented = true; } };
  guard(discard);
  assert.equal(discard.prevented, true, 'Discarding the draft must allow the unload');
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0].buttons.join('|'), 'Keep editing|Discard changes');
  assert.match(prompts[0].message, /unsaved/i);
});

test('configuration review and commit reject a changed game folder even for identical files', async t => {
  const dir = await temporary(t);
  const first = path.join(dir, 'first');
  const second = path.join(dir, 'second');
  for (const folder of [first, second]) {
    await fs.mkdir(path.join(folder, 'main'), { recursive: true });
    await fs.writeFile(path.join(folder, 'main', 'botserver.cfg'), 'set sv_maxclients "18"\n');
  }
  const manager = managerAt(dir);
  manager.data.games.cod4 = { gamePath: first };
  const original = path.join(first, 'main', 'botserver.cfg');
  const preview = await manager.previewSettings('cod4', 'base', 'dom', { sv_maxclients: '20' }, original);
  manager.data.games.cod4.gamePath = second;
  await assert.rejects(manager.previewSettings('cod4', 'base', 'dom', { sv_maxclients: '20' }, original), /game folder changed/i);
  await assert.rejects(manager.commitSettings('cod4', 'base', 'dom', { sv_maxclients: '20' }, preview.token, original), /game folder changed/i);
  assert.match(await fs.readFile(path.join(second, 'main', 'botserver.cfg'), 'utf8'), /"18"/);
});

test('stop releases a process that exited while a leftover process holds its output open', async t => {
  const dir = await temporary(t);
  await fs.mkdir(path.join(dir, 'main'));
  const manager = managerAt(dir);
  readyToStart(manager, dir);
  manager.stopTimeout = 20;
  const child = fakeChild(4242);
  spawnImpl = () => { queueMicrotask(() => child.emit('spawn')); return child; };
  await manager.start('cod4');
  // The launcher exits, but 'close' never arrives because the pipes stay open.
  child.exitCode = 0;
  let taskkills = 0;
  execImpl = (_file, _args, _options, callback) => { taskkills++; callback(null, '', ''); };
  await manager.stop('cod4');
  assert.equal(taskkills, 0);
  assert.equal(manager.hasRunning(), false);
  assert.ok(manager.logs.get('cod4').some(entry => entry.message.includes('no longer manages it')));
});

test('stop reports a process that survives taskkill instead of hanging in stopping', async t => {
  const manager = managerAt(await temporary(t));
  manager.broadcastState = async () => {};
  manager.stopTimeout = 20;
  const child = fakeChild(4343);
  const instance = { status: 'running', child, cancelled: false, stopPromise: null };
  manager.instances.set('cod4', instance);
  execImpl = (_file, _args, _options, callback) => callback(null, '', '');
  await assert.rejects(manager.stop('cod4'), /did not exit/);
  assert.equal(instance.status, 'running');
  assert.equal(instance.stopPromise, null);
  assert.equal(child.listenerCount('close'), 0);
});

test('a cancelled launch is logged as information, not an error', async t => {
  const manager = managerAt(await temporary(t));
  readyToStart(manager, 'unused');
  const started = manager.start('cod4');
  const stopped = manager.stop('cod4');
  await assert.rejects(started, /Launch cancelled/);
  await stopped;
  const entries = manager.logs.get('cod4');
  assert.ok(entries.some(entry => entry.message === 'Launch cancelled.' && entry.level === 'info'));
  assert.ok(!entries.some(entry => entry.level === 'error'));
});

test('unreadable settings are preserved and replaced by defaults; bad stored values are ignored', async t => {
  const dir = await temporary(t);
  const settings = path.join(dir, 'settings.json');
  await fs.writeFile(settings, '{ "root": "D:\\\\x", "games": ');
  const manager = new ServerManager(settings, () => {});
  const backup = await manager.initialize();
  assert.ok(backup && path.basename(backup).startsWith('settings.json.corrupt-'));
  assert.equal(await fs.readFile(backup, 'utf8'), '{ "root": "D:\\\\x", "games": ');
  assert.equal(manager.data.root, undefined);
  assert.deepEqual(manager.data.games, {});
  await fs.writeFile(settings, JSON.stringify({ root: dir, games: {
    cod4: { port: 'abc', mode: 'dom;quit', shuffle: 'yes', selectedMaps: ['mp_ok', 'bad map', 'mp_ok', 3], gamePath: 7, lan: 'no', artwork: 'C:\\x.png' },
    mw2: [], unknown: { port: 30000 },
  } }));
  const second = new ServerManager(settings, () => {});
  assert.equal(await second.initialize(), null);
  assert.deepEqual(second.options('cod4'), { port: 28962, mode: 'dom', shuffle: true, selectedMaps: ['mp_ok'], gamePath: '', lan: true });
  assert.deepEqual(second.data.games.cod4.artwork, {});
  assert.equal(second.data.games.mw2, undefined);
  assert.equal(second.data.games.unknown, undefined);
  // The retired legacy scripts folder setting is ignored and never written back.
  assert.equal(second.data.root, undefined);
});

test('a second app instance hands off to the first and never opens a window', async () => {
  const source = await fs.readFile(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8');
  for (const primary of [false, true]) {
    const handlers = {};
    let quits = 0;
    let readyCalls = 0;
    const app = {
      requestSingleInstanceLock: () => primary, quit: () => { quits++; },
      whenReady: () => { readyCalls++; return new Promise(() => {}); }, on: (name, handler) => { handlers[name] = handler; },
    };
    vm.runInNewContext(source, {
      module: { exports: {} }, process, __dirname: path.join(__dirname, '..', 'electron'),
      require: name => name === 'electron' ? { app, dialog: {}, BrowserWindow: class {}, ipcMain: { handle() {} }, shell: {}, session: fakeSession }
        : name === './key-store.cjs' ? { KeyStore: class {} }
          : name === './botwarfare-source.cjs' ? { BotWarfareSource: class {} }
            : name === './botwarfare-install.cjs' ? { BotWarfareInstaller: class {} }
              : name.startsWith('./') ? require(path.join(__dirname, '..', 'electron', name)) : require(name),
    });
    assert.equal(quits, primary ? 0 : 1);
    assert.equal(readyCalls, primary ? 1 : 0);
    assert.equal(typeof handlers['second-instance'], primary ? 'function' : 'undefined');
    if (primary) handlers['second-instance']();
  }
});

test('elevated firewall changes run inline, report the real failure and clean up', async () => {
  const manager = new ServerManager('unused', () => {});
  const before = (await fs.readdir(os.tmpdir())).filter(name => name.startsWith('botland-elevate-'));
  let seen;
  execImpl = (_file, args, _options, callback) => {
    seen = args.at(-1);
    const encoded = seen.match(/'-EncodedCommand','([A-Za-z0-9+/=]+)'/)[1];
    const script = Buffer.from(encoded, 'base64').toString('utf16le');
    const resultFile = script.match(/-LiteralPath '([^']+)'/)[1];
    fs.writeFile(resultFile, '{ "ok": false, "message": "netsh exploded" }')
      .then(() => callback(null, '', ''))
      .catch(callback);
  };
  await assert.rejects(manager.runElevated(['netsh advfirewall show']), /The firewall change failed: netsh exploded/);
  assert.doesNotMatch(seen, /-File/);
  execImpl = (_file, _args, _options, callback) => {
    const error = new Error('failed');
    error.stderr = 'Start-Process : This command cannot be run due to the error: The operation was canceled by the user.';
    callback(error);
  };
  await assert.rejects(manager.runElevated(['netsh advfirewall show']), /elevation prompt was canceled/);
  const after = (await fs.readdir(os.tmpdir())).filter(name => name.startsWith('botland-elevate-'));
  assert.deepEqual(after.sort(), before.sort());
  execImpl = (_file, _args, _options, callback) => callback(null, '', '');
});

test('BO2 refuses to save a one-map rotation', async t => {
  const manager = managerAt(await temporary(t));
  manager.maps = async () => ({ maps: ['mp_one', 'mp_two'], modes: [{ value: 'dom' }] });
  await assert.rejects(manager.saveOptions('bo2', { selectedMaps: ['mp_one'] }), /at least two maps/i);
  assert.equal(manager.data.games.bo2, undefined);
});
