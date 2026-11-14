const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const Module = require('node:module');

// Preserve the manager's child_process seam: nothing here launches a game.
const originalLoad = Module._load;
let spawnImpl = () => { throw new Error('Unexpected spawn'); };
Module._load = function (request, parent, isMain) {
  if (request === 'node:child_process' && parent?.filename === require.resolve('../electron/manager.cjs')) {
    return { spawn: (...args) => spawnImpl(...args), execFile: () => { throw new Error('Unexpected taskkill'); } };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { ServerManager } = require('../electron/manager.cjs');
const { listBackups, previewRestore, restoreBackup } = require('../electron/config-backups.cjs');
Module._load = originalLoad;

async function temporary(t) {
  const root = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp', 'opencode');
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'botland-sweep17-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
function clock() {
  let now = Date.now();
  const timers = new Map();
  let next = 0;
  return {
    now: () => now,
    setTimeout: (callback, delay) => { const id = ++next; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout: id => timers.delete(id),
    advance: ms => {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); }
    },
    get pending() { return timers.size; },
  };
}
function child(pid) {
  const proc = new EventEmitter();
  Object.assign(proc, { pid, stdin: null, stdout: null, stderr: null, exitCode: null, signalCode: null });
  proc.finish = (code = 1) => { proc.exitCode = code; proc.emit('close', code, null); };
  return proc;
}
async function fixture(t) {
  const dir = await temporary(t);
  await fs.mkdir(path.join(dir, 'main'), { recursive: true });
  await fs.mkdir(path.join(dir, 'userraw'), { recursive: true });
  const timers = clock();
  const manager = new ServerManager(path.join(dir, 'settings.json'), () => {}, { restartTimers: timers,
    createLogTail: () => ({ start: async () => {}, stop: async () => {} }) });
  manager.broadcastState = async () => {};
  manager.check = async () => ({ blockers: [], gamePath: dir, options: { port: 28962, mode: 'dom', shuffle: false, selectedMaps: [], lan: true } });
  manager.maps = async () => ({ maps: ['mp_alpha', 'mp_bravo'], modes: [{ value: 'dom' }] });
  manager.portInUse = async () => false;
  let pid = 7000;
  const spawned = [];
  spawnImpl = (_file, _args) => {
    const proc = child(++pid);
    spawned.push(proc);
    queueMicrotask(() => proc.emit('spawn'));
    return proc;
  };
  t.after(() => { spawnImpl = () => { throw new Error('Unexpected spawn'); }; });
  return { manager, timers, spawned };
}
async function settle(predicate) {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(predicate(), 'asynchronous operation did not settle');
}

test('a pending automatic restart waits for a folder change instead of being dropped', async t => {
  const { manager, timers, spawned } = await fixture(t);
  await manager.setAutoRestart('cod4', true);
  await manager.start('cod4');
  spawned[0].finish(1);
  assert.equal(manager.instances.get('cod4').status, 'restarting');
  // The window where the retry used to vanish: a folder change is in flight
  // when the backoff expires. The retry must stay pending, not disappear.
  manager.folderUpdates.add('cod4');
  timers.advance(2000);
  assert.equal(manager.instances.get('cod4').status, 'restarting');
  assert.equal(timers.pending, 1);
  timers.advance(2000);
  assert.equal(timers.pending, 1);
  assert.equal(spawned.length, 1);
  manager.folderUpdates.delete('cod4');
  timers.advance(2000);
  await settle(() => spawned.length === 2 && manager.instances.get('cod4')?.status === 'running');
  spawned[1].finish(0);
  manager.cancelRestart('cod4');
});

test('the game folder cannot be re-pointed while a server is running or restarting', async t => {
  const { manager } = await fixture(t);
  const folder = path.join(path.dirname(manager.settingsPath), 'install');
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'iw3mp.exe'), 'synthetic');
  manager.gamePath = async () => folder;
  const dialog = { showOpenDialog: async () => ({ canceled: false, filePaths: [folder] }) };
  const running = { status: 'running' };
  manager.instances.set('cod4', running);
  await assert.rejects(manager.chooseFolder('cod4', null, dialog), /Stop this server before changing its game folder/);
  running.status = 'restarting';
  await assert.rejects(manager.chooseFolder('cod4', null, dialog), /Stop this server before changing its game folder/);
  running.status = 'stopped';
  assert.equal(await manager.chooseFolder('cod4', null, dialog), true);
});

test('config backups can be listed and restored when the live config is missing', async t => {
  const dir = await temporary(t);
  const file = path.join(dir, 'server.cfg');
  const backupName = `${path.basename(file)}.bak-2026-01-02T03-04-05-678Z-${crypto.randomUUID()}`;
  const backup = path.join(dir, backupName);
  const contents = 'set sv_hostname "recovered"\r\n';
  await fs.writeFile(backup, contents, 'utf8');
  // Exactly the state a user recovers from: the live file is gone.
  const listed = await listBackups(file);
  assert.equal(listed.length, 1);
  const preview = await previewRestore(file, listed[0].id);
  assert.equal(preview.summary.missing, true);
  assert.equal(preview.summary.currentBytes, 0);
  const restored = await restoreBackup(file, listed[0].id, preview.token);
  assert.equal(restored.backupId, null);
  assert.equal(await fs.readFile(file, 'utf8'), contents);
  // The missing file was created; no previous-copy backup was invented.
  assert.equal((await listBackups(file)).length, 1);
});

test('a manual folder can be replaced by the detected Steam folder, but not while running', async t => {
  const dir = await temporary(t);
  const manager = new ServerManager(path.join(dir, 'settings.json'), () => {});
  manager.broadcastState = async () => {};
  const install = path.join(dir, 'install');
  await fs.mkdir(install, { recursive: true });
  await fs.writeFile(path.join(install, 'iw3mp.exe'), 'synthetic');
  manager.detected = { games: { cod4: { gamePath: install } } };
  manager.data.games.cod4 = { gamePath: path.join(dir, 'old') };
  manager.instances.set('cod4', { status: 'running' });
  await assert.rejects(manager.useDetectedFolder('cod4'), /Stop this server before changing its game folder/);
  manager.instances.delete('cod4');
  assert.equal(await manager.useDetectedFolder('cod4'), true);
  assert.equal(manager.data.games.cod4.gamePath, install);
});