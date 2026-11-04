const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const vm = require('node:vm');

// Intercept only this test file's manager import: no real game executable, netstat or taskkill is run.
// util.promisify resolves a plain mock with its first callback value, so mocks hand back { stdout, stderr } as the real execFile does.
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
const { saveConfig, previewConfig, parseEntries, inspectText, updateConfigText } = require('../electron/config.cjs');
const { artworkFor } = require('../electron/artwork.cjs');

// main.cjs denies all web permissions on the default session at startup.
const fakeSession = { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } };

async function temporary(testContext) {
  const root = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp', 'opencode');
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'botland-sweep3-'));
  testContext.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
const netstatLine = (address, pid = 4242) => `  UDP    ${address}    *:*                                    ${pid}`;
const netstatOutput = (...lines) => `\r\nActive Connections\r\n\r\n  Proto  Local Address          Foreign Address        State           PID\r\n${lines.join('\r\n')}\r\n`;

test('port check sees listeners bound to IPv6 as well as IPv4', async t => {
  const dir = await temporary(t);
  const manager = new ServerManager(path.join(dir, 'settings.json'), () => {}, dir);
  const asked = [];
  t.after(() => { execImpl = (_file, _args, _options, callback) => callback(null, '', ''); });
  execImpl = (_file, args, _options, callback) => {
    asked.push(args.join(' '));
    callback(null, { stdout: args.includes('udpv6') ? netstatOutput(netstatLine('[::]:27016')) : netstatOutput(netstatLine('0.0.0.0:53', 100)), stderr: '' });
  };
  assert.equal(await manager.portInUse(27016), true);
  assert.equal(await manager.portInUse(28962), false);
  assert.ok(asked.some(line => line.includes('udpv6')) && asked.some(line => line.endsWith('udp')), asked.join('\n'));
});

test('port check still works when only one address family can be queried, and fails when neither can', async t => {
  const dir = await temporary(t);
  const manager = new ServerManager(path.join(dir, 'settings.json'), () => {}, dir);
  t.after(() => { execImpl = (_file, _args, _options, callback) => callback(null, '', ''); });
  execImpl = (_file, args, _options, callback) => {
    if (args.includes('udpv6')) callback(new Error('IPv6 is disabled'), '', '');
    else callback(null, { stdout: netstatOutput(netstatLine('0.0.0.0:28962')), stderr: '' });
  };
  assert.equal(await manager.portInUse(28962), true);
  assert.equal(await manager.portInUse(28963), false);
  execImpl = (_file, _args, _options, callback) => callback(new Error('netstat missing'), '', '');
  await assert.rejects(manager.portInUse(28962), /netstat missing/);
});

test('a port check that cannot run does not block a launch', async t => {
  const dir = await temporary(t);
  const logs = [];
  const manager = new ServerManager(path.join(dir, 'settings.json'), event => { if (event.type === 'log') logs.push(event.entry.message); }, dir);
  manager.broadcastState = async () => {};
  manager.check = async () => ({ blockers: [], gamePath: dir, options: { port: 28960, mode: 'dom', shuffle: false, selectedMaps: [], lan: true } });
  manager.portInUse = async () => { throw new Error('Command failed: netstat.exe'); };
  manager.maps = async () => ({ maps: ['mp_alpha'], modes: [{ value: 'dom' }] });
  await fs.mkdir(path.join(dir, 'main'), { recursive: true });
  const child = new EventEmitter();
  Object.assign(child, { pid: 4343, stdout: null, stderr: null, exitCode: null, signalCode: null });
  spawnImpl = () => { process.nextTick(() => child.emit('spawn')); return child; };
  t.after(() => { spawnImpl = () => { throw new Error('Unexpected spawn'); }; });
  await manager.start('cod4');
  assert.equal(manager.instances.get('cod4')?.status, 'running');
  assert.ok(logs.some(line => line.includes('Could not check whether UDP 28960 is free')), logs.join('\n'));
});

test('without a game folder, preflight never reads a config relative to the working directory', async t => {
  const dir = await temporary(t);
  const cwd = process.cwd();
  await fs.mkdir(path.join(dir, 'admin'), { recursive: true });
  await fs.mkdir(path.join(dir, 'main'), { recursive: true });
  // Neither file execs the generated rotation, so reading them would add a blocker.
  await fs.writeFile(path.join(dir, 'admin', 'server.cfg'), 'set sv_hostname "stray"\n');
  await fs.writeFile(path.join(dir, 'main', 'dedicated.cfg'), 'set sv_hostname "stray"\n');
  const manager = new ServerManager(path.join(dir, 'settings.json'), () => {}, path.join(dir, 'scripts'));
  process.chdir(dir);
  try {
    for (const id of ['mw3', 'bo2']) {
      const blockers = (await manager.check(id)).blockers;
      assert.ok(blockers.some(message => message.includes('was not found in your Steam libraries')), blockers.join('\n'));
      assert.ok(!blockers.some(message => message.includes('must exec') || message.includes('Could not read')), blockers.join('\n'));
    }
  } finally { process.chdir(cwd); }
});

test('a state snapshot that finishes late is never delivered after a newer one', async t => {
  const dir = await temporary(t);
  const delivered = [];
  const manager = new ServerManager(path.join(dir, 'settings.json'), event => delivered.push(event.snapshot.label), dir);
  const pending = [];
  manager.snapshot = () => new Promise(resolve => pending.push(label => resolve({ label })));
  const first = manager.broadcastState();
  const second = manager.broadcastState();
  pending[1]('newer');
  await second;
  pending[0]('older');
  await first;
  assert.deepEqual(delivered, ['newer']);
  const third = manager.broadcastState();
  pending[2]('latest');
  await third;
  assert.deepEqual(delivered, ['newer', 'latest']);
});

test('a renderer that cannot receive events does not crash the main process', async () => {
  const source = await fs.readFile(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8');
  let notify;
  const fakeManager = { initialize: async () => {}, rescanInstallations: async () => {}, hasRunning: () => false, stopAll: async () => {} };
  class FakeWindow {
    constructor() {
      this.handlers = {};
      this.webContents = { send() { throw new Error('Render frame was disposed before WebFrameMain could be accessed'); }, setWindowOpenHandler() {}, on() {} };
    }
    once(name, handler) { this.handlers[name] = handler; }
    on(name, handler) { this.handlers[name] = handler; }
    isDestroyed() { return false; }
    loadURL() { return Promise.resolve(); }
  }
  const app = {
    whenReady: () => Promise.resolve(), on() {},
    getPath: name => name === 'appData' ? __dirname : path.join(__dirname, 'BotLANd Server Manager'),
    isPackaged: false, quit() {}, requestSingleInstanceLock: () => true,
  };
  const sandbox = {
    module: { exports: {} }, __dirname: path.join(__dirname, '..', 'electron'),
    require: name => name === 'electron' ? { app, dialog: { showErrorBox() {} }, BrowserWindow: FakeWindow, ipcMain: { handle() {} }, shell: {}, session: fakeSession }
      : name === './manager.cjs' ? { ServerManager: class { constructor(_settings, callback) { notify = callback; return fakeManager; } } }
        : name === './key-store.cjs' ? { KeyStore: class {} }
          : name.startsWith('./') ? require(path.join(__dirname, '..', 'electron', name)) : require(name),
  };
  vm.runInNewContext(source, sandbox);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof notify, 'function');
  assert.doesNotThrow(() => notify({ type: 'log', id: 'cod4', entry: { at: '', level: 'info', message: 'line' } }));
});

test('a config that cannot be replaced reports why and leaves no stray backup or temp file', async t => {
  const dir = await temporary(t);
  const file = path.join(dir, 'server.cfg');
  await fs.writeFile(file, 'set sv_maxclients "18"\n');
  const { token } = await previewConfig(file, { sv_maxclients: '20' }, { id: 'cod4' });
  const originalRename = fs.rename;
  fs.rename = async () => { throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' }); };
  try { await assert.rejects(saveConfig(file, { sv_maxclients: '20' }, { id: 'cod4', token }), /read-only or in use by another program/i); }
  finally { fs.rename = originalRename; }
  assert.equal(await fs.readFile(file, 'utf8'), 'set sv_maxclients "18"\n');
  assert.deepEqual(await fs.readdir(dir), ['server.cfg']);
  // The same preview still commits once the file can be replaced.
  await saveConfig(file, { sv_maxclients: '20' }, { id: 'cod4', token });
  assert.equal(await fs.readFile(file, 'utf8'), 'set sv_maxclients "20"\n');
  assert.equal((await fs.readdir(dir)).filter(name => name.startsWith('server.cfg.bak-')).length, 1);
});

test('artwork is found in the hashed subfolders newer Steam clients use', async t => {
  const dir = await temporary(t);
  const previous = process.env['PROGRAMFILES(X86)'];
  t.after(() => { if (previous === undefined) delete process.env['PROGRAMFILES(X86)']; else process.env['PROGRAMFILES(X86)'] = previous; });
  process.env['PROGRAMFILES(X86)'] = dir;
  const folder = path.join(dir, 'Steam', 'appcache', 'librarycache', '7940', 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678');
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'library_hero.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.alloc(32, 7)]));
  const image = await artworkFor('cod4', 'hero');
  assert.ok(image?.startsWith('data:image/jpeg;base64,'));
});

test('placeholder dvars with a leading underscore are listed and editable', () => {
  const text = 'set _Admin ""                       // Your username.\nset sv_hostname "Lobby"\nset _Website "old.example"\n';
  const entries = parseEntries(text);
  assert.deepEqual([...entries.keys()], ['_admin', 'sv_hostname', '_website']);
  const advanced = inspectText(text, { id: 'mw2', target: 'base', mode: 'dom' }).entries.map(entry => entry.key);
  assert.ok(advanced.includes('_admin') && advanced.includes('_website'));
  const updated = updateConfigText(text, { _website: 'new.example' }, { id: 'mw2', target: 'base', mode: 'dom' });
  assert.equal(updated, 'set _Admin ""                       // Your username.\nset sv_hostname "Lobby"\nset _Website "new.example"\n');
});

test('the message of the day can be cleared, but the server name cannot be blank', () => {
  const text = 'set sv_hostname "Lobby"\nset sv_motd "Welcome"\n';
  const options = { id: 'cod4', target: 'base', mode: 'dom' };
  assert.equal(updateConfigText(text, { sv_motd: '' }, options), 'set sv_hostname "Lobby"\nset sv_motd ""\n');
  assert.throws(() => updateConfigText(text, { sv_hostname: '' }, options), /Server name must be/);
});