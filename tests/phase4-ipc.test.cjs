const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

const electronDir = path.join(__dirname, '..', 'electron');
const gameIds = new Set(['cod4', 'waw', 'mw2', 'bo1', 'mw3', 'bo2']);
const backupMethods = ['listConfigBackups', 'previewConfigRestore', 'restoreConfigBackup', 'pruneConfigBackups'];

// Run both entry points with only in-memory dependencies. In particular, never
// load the real manager, profiles, networking, Electron, or private launchers.
async function ipcFixture() {
  const [mainSource, preloadSource] = await Promise.all([
    fs.readFile(path.join(electronDir, 'main.cjs'), 'utf8'),
    fs.readFile(path.join(electronDir, 'preload.cjs'), 'utf8'),
  ]);
  let handler;
  let window;
  let api;
  let windowLoaded;
  const loaded = new Promise(resolve => { windowLoaded = resolve; });
  const startupErrors = [];
  const writes = [];
  const discoveries = [];
  const calls = [];
  const invocations = [];
  let addresses = ['192.168.10.5'];

  const profileFor = id => {
    if (!gameIds.has(id)) throw new Error('Invalid game id.');
    return { id };
  };
  const manager = {
    instances: new Map(),
    async initialize() { return null; },
    async rescanInstallations() {},
    async checkBotUpdates() {},
    setAutoRestart(id, enabled) {
      calls.push(['setAutoRestart', id, enabled]);
      profileFor(id);
      if (typeof enabled !== 'boolean') throw new Error('Invalid restart setting.');
      return Promise.resolve('restart-saved');
    },
    rescanOrphans() {
      calls.push(['rescanOrphans']);
      return Promise.resolve('orphans-scanned');
    },
  };
  for (const method of backupMethods) {
    manager[method] = (...args) => {
      calls.push([method, ...args]);
      const [id, target, mode, extra, token] = args;
      profileFor(id);
      if (target !== 'base' || mode !== 'dom') throw new Error('Invalid config target or mode.');
      if (method === 'previewConfigRestore' || method === 'restoreConfigBackup') {
        if (!/^[a-f0-9]{64}$/.test(extra)) throw new Error('Invalid backup id.');
      }
      if (method === 'restoreConfigBackup' && !/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid preview token.');
      if (method === 'pruneConfigBackups' && (!Array.isArray(extra) || !extra.every(id => /^[a-f0-9]{64}$/.test(id)))) {
        throw new Error('Invalid backup ids.');
      }
      return Promise.resolve({ method, args });
    };
  }

  class FakeWindow {
    constructor() {
      window = this;
      this.webContents = {
        mainFrame: {}, send() {}, setWindowOpenHandler() {}, on() {},
      };
    }
    once() {}
    on() {}
    loadURL() { windowLoaded(); return Promise.resolve(); }
    isDestroyed() { return false; }
  }
  const appData = path.join(__dirname, 'unused-app-data');
  const electron = {
    app: {
      isPackaged: false,
      requestSingleInstanceLock: () => true,
      whenReady: () => Promise.resolve(),
      on() {},
      getPath: name => name === 'appData' ? appData : path.join(appData, 'BotLANd Server Manager'),
      quit() { throw new Error('Unexpected quit.'); },
    },
    BrowserWindow: FakeWindow,
    clipboard: { writeText(text) { writes.push(text); } },
    dialog: { showErrorBox(_title, message) { startupErrors.push(message); } },
    ipcMain: { handle(channel, callback) { assert.equal(channel, 'manager:action'); handler = callback; } },
    safeStorage: {},
    session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } },
    shell: {},
    contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'manager'); api = value; } },
    ipcRenderer: {
      invoke(channel, action, payload) {
        invocations.push([channel, action, payload === undefined ? undefined : JSON.parse(JSON.stringify(payload))]);
        return handler(validEvent(), action, payload);
      },
    },
  };
  const mocks = {
    electron,
    'node:path': path,
    'node:fs/promises': { mkdir() { throw new Error('Unexpected disk write.'); }, copyFile() { throw new Error('Unexpected disk copy.'); } },
    'node:fs': { constants: { COPYFILE_EXCL: 1 } },
    './manager.cjs': { ServerManager: class { constructor() { return manager; } } },
    './key-store.cjs': { KeyStore: class {} },
    './botwarfare-source.cjs': { BotWarfareSource: class {} },
    './botwarfare-install.cjs': { BotWarfareInstaller: class {} },
    './session-logs.cjs': { SessionLogs: class {} },
    './connect-address.cjs': {
      discoverConnectAddresses(port) {
        discoveries.push(port);
        return { candidates: addresses.map(address => ({ connectAddress: `${address}:${port}` })) };
      },
    },
    './profiles.cjs': { profileFor },
    './schema.cjs': { sourceRepos: {} },
  };
  const sandbox = { module: { exports: {} }, __dirname: electronDir, process: { env: { LOCALAPPDATA: 'unused' } }, require(request) {
    if (!Object.hasOwn(mocks, request)) throw new Error(`Unexpected module import: ${request}`);
    return mocks[request];
  } };
  vm.runInNewContext(mainSource, sandbox, { filename: 'electron/main.cjs' });
  await loaded;
  assert.deepEqual(startupErrors, []);
  assert.equal(typeof handler, 'function');
  vm.runInNewContext(preloadSource, sandbox, { filename: 'electron/preload.cjs' });
  assert.ok(api);
  function validEvent() { return { sender: window.webContents, senderFrame: window.webContents.mainFrame }; }
  return { api, handler, validEvent, window, manager, writes, discoveries, calls, invocations,
    setAddresses(next) { addresses = next; } };
}

test('Phase 4 bridge methods have matching ManagerApi declarations', async () => {
  const types = await fs.readFile(path.join(__dirname, '..', 'src', 'types.ts'), 'utf8');
  for (const signature of [
    'copyConnectAddress\\(id: GameId, address: string\\): Promise<boolean>',
    'setAutoRestart\\(id: GameId, enabled: boolean\\): Promise<void>',
    'rescanOrphans\\(\\): Promise<void>',
    'listConfigBackups\\(id: GameId, target: ConfigTarget, mode: string\\): Promise<ConfigBackup\\[\\]>',
    'previewConfigRestore\\(id: GameId, target: ConfigTarget, mode: string, backupId: string\\): Promise<ConfigRestorePreview>',
    'restoreConfigBackup\\(id: GameId, target: ConfigTarget, mode: string, backupId: string, token: string\\): Promise<void>',
    'pruneConfigBackups\\(id: GameId, target: ConfigTarget, mode: string, ids: string\\[\\]\\): Promise<\\{ removed: number \\}>',
  ]) assert.match(types, new RegExp(`^  ${signature};$`, 'm'));
});

test('copyConnectAddress uses the running instance active port and an exact current candidate', async () => {
  const { api, manager, writes, discoveries, setAddresses, invocations } = await ipcFixture();
  const address = '192.168.10.5:28962';
  manager.instances.set('cod4', { status: 'running', activePort: 28962 });
  assert.equal(await api.copyConnectAddress('cod4', address), true);
  assert.deepEqual(writes, [address]);
  assert.deepEqual(discoveries, [28962]);
  assert.deepEqual(invocations.at(-1), ['manager:action', 'copyConnectAddress', { id: 'cod4', address }]);

  // A previously listed address, a different port, or a differently spelled
  // candidate must not be copied, even while that server remains running.
  setAddresses(['192.168.10.6']);
  for (const stale of [address, '192.168.10.6:28963', '192.168.10.6:28962 ', '192.168.10.6:28962\n']) {
    await assert.rejects(api.copyConnectAddress('cod4', stale), /no longer available/);
  }
  manager.instances.get('cod4').activePort = 30000;
  await assert.rejects(api.copyConnectAddress('cod4', '192.168.10.6:28962'), /no longer available/);
  assert.deepEqual(writes, [address]);
  assert.equal(await api.copyConnectAddress('cod4', '192.168.10.6:30000'), true);
  assert.deepEqual(writes, [address, '192.168.10.6:30000']);
  assert.equal(discoveries.at(-1), 30000);
});

test('copyConnectAddress rejects non-running, invalid ids and invalid address types without writing', async () => {
  const { api, manager, writes, discoveries } = await ipcFixture();
  const address = '192.168.10.5:28962';
  for (const status of ['starting', 'stopping', 'restarting', 'stopped']) {
    manager.instances.set('cod4', { status, activePort: 28962 });
    await assert.rejects(api.copyConnectAddress('cod4', address), /Start this server/);
  }
  manager.instances.delete('cod4');
  await assert.rejects(api.copyConnectAddress('cod4', address), /Start this server/);
  manager.instances.set('cod4', { status: 'running', activePort: 28962 });
  for (const id of ['missing', '../cod4', '', null]) {
    await assert.rejects(api.copyConnectAddress(id, address), /Invalid game id/);
  }
  for (const invalid of [undefined, null, 28962, { connectAddress: address }, ['192.168.10.5']]) {
    await assert.rejects(api.copyConnectAddress('cod4', invalid), /Start this server/);
  }
  assert.deepEqual(writes, []);
  assert.deepEqual(discoveries, []);
});

test('backup bridge forwards exact arguments and the validated manager owns backup errors', async () => {
  const { api, calls, invocations } = await ipcFixture();
  const backupId = 'a'.repeat(64);
  const token = 'b'.repeat(64);
  const cases = [
    ['listConfigBackups', ['cod4', 'base', 'dom']],
    ['previewConfigRestore', ['cod4', 'base', 'dom', backupId]],
    ['restoreConfigBackup', ['cod4', 'base', 'dom', backupId, token]],
    ['pruneConfigBackups', ['cod4', 'base', 'dom', [backupId]]],
  ];
  for (const [method, args] of cases) {
    const result = await api[method](...args);
    assert.deepEqual(calls.at(-1), [method, ...args]);
    assert.deepEqual(result, { method, args });
    assert.deepEqual(invocations.at(-1), ['manager:action', method,
      { id: args[0], target: args[1], mode: args[2], ...(
        method === 'pruneConfigBackups' ? { ids: args[3] } :
          method === 'listConfigBackups' ? {} : { backupId: args[3], ...(method === 'restoreConfigBackup' ? { token: args[4] } : {}) }) }]);
  }
  for (const [method, args, message] of [
    ['listConfigBackups', ['unknown', 'base', 'dom'], /Invalid game id/],
    ['listConfigBackups', ['cod4', '../outside', 'dom'], /Invalid config target/],
    ['previewConfigRestore', ['cod4', 'base', 'dom', '../outside'], /Invalid backup id/],
    ['restoreConfigBackup', ['cod4', 'base', 'dom', backupId, 'stale'], /Invalid preview token/],
    ['pruneConfigBackups', ['cod4', 'base', 'dom', ['../outside']], /Invalid backup ids/],
  ]) {
    await assert.rejects(api[method](...args), message);
    assert.deepEqual(calls.at(-1), [method, ...args], `${method} must delegate validation to the manager`);
  }
});

test('setAutoRestart and rescanOrphans route through preload to manager', async () => {
  const { api, calls, invocations } = await ipcFixture();
  assert.equal(await api.setAutoRestart('bo2', true), 'restart-saved');
  assert.deepEqual(calls.at(-1), ['setAutoRestart', 'bo2', true]);
  assert.deepEqual(invocations.at(-1), ['manager:action', 'setAutoRestart', { id: 'bo2', enabled: true }]);
  assert.equal(await api.setAutoRestart('bo2', false), 'restart-saved');
  assert.deepEqual(calls.at(-1), ['setAutoRestart', 'bo2', false]);
  assert.equal(await api.rescanOrphans(), 'orphans-scanned');
  assert.deepEqual(calls.at(-1), ['rescanOrphans']);
  assert.deepEqual(invocations.at(-1), ['manager:action', 'rescanOrphans', undefined]);
  await assert.rejects(api.setAutoRestart('unknown', true), /Invalid game id/);
  await assert.rejects(api.setAutoRestart('bo2', 'yes'), /Invalid restart setting/);
});

test('Phase 4 actions refuse forged sender/frame and malformed requests before any side effect', async () => {
  const { handler, validEvent, manager, calls, writes, discoveries, window } = await ipcFixture();
  manager.instances.set('cod4', { status: 'running', activePort: 28962 });
  const requests = [
    ['copyConnectAddress', { id: 'cod4', address: '192.168.10.5:28962' }],
    ['setAutoRestart', { id: 'cod4', enabled: true }],
    ['rescanOrphans', {}],
    ['listConfigBackups', { id: 'cod4', target: 'base', mode: 'dom' }],
    ['previewConfigRestore', { id: 'cod4', target: 'base', mode: 'dom', backupId: 'a'.repeat(64) }],
    ['restoreConfigBackup', { id: 'cod4', target: 'base', mode: 'dom', backupId: 'a'.repeat(64), token: 'b'.repeat(64) }],
    ['pruneConfigBackups', { id: 'cod4', target: 'base', mode: 'dom', ids: [] }],
  ];
  for (const [action, payload] of requests) {
    await assert.rejects(handler({ sender: {}, senderFrame: window.webContents.mainFrame }, action, payload), /Invalid window/);
    await assert.rejects(handler({ sender: window.webContents, senderFrame: {} }, action, payload), /Invalid window/);
  }
  for (const payload of [null, [], 'invalid']) {
    await assert.rejects(handler(validEvent(), 'copyConnectAddress', payload), /Invalid request/);
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(writes, []);
  assert.deepEqual(discoveries, []);
});
