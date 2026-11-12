const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

// Only the manager's own child_process import is intercepted. No test may run a
// real server, netstat, taskkill, or an engine updater subprocess.
const managerModule = require.resolve('../electron/manager.cjs');
const originalLoad = Module._load;
let spawnImpl = () => { throw new Error('Unexpected game spawn'); };
let ServerManager;
try {
  Module._load = function (request, parent, isMain) {
    if (request === 'node:child_process' && parent?.filename === managerModule) {
      return {
        spawn: (...args) => spawnImpl(...args),
        execFile: () => { throw new Error('Unexpected external command'); },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  ({ ServerManager } = require('../electron/manager.cjs'));
} finally {
  Module._load = originalLoad;
}

async function put(file) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, 'synthetic fixture');
}
async function fixture(t, updater = {}) {
  const root = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp', 'opencode');
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'botland-engine-manager-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const folders = { cod4: path.join(dir, 'cod4'), mw2: path.join(dir, 'mw2') };
  for (const [id, folder] of Object.entries(folders)) {
    await put(path.join(folder, id === 'cod4' ? 'iw3mp.exe' : 'iw4mp.exe'));
    await put(path.join(folder, id === 'cod4' ? 'Cod4R-DedRun.exe' : 'iw4x.exe'));
    await put(path.join(folder, id === 'cod4' ? 'main/botserver.cfg' : 'userraw/serverlan.cfg'));
    await put(path.join(folder, id === 'cod4' ? 'mods/mp_bots/z_svr_bots.iwd' : 'userraw/z_svr_bots.iwd'));
    for (const map of ['mp_alpha', 'mp_bravo']) {
      await put(path.join(folder, 'zone', 'english', `${map}.ff`));
      await put(path.join(folder, 'zone', 'english', `${map}_load.ff`));
    }
  }
  const events = [];
  const manager = new ServerManager(path.join(dir, 'settings.json'), event => events.push(event), { engineUpdater: updater,
    createLogTail: () => ({ start: async () => {}, stop: async () => {} }) });
  for (const [id, gamePath] of Object.entries(folders)) manager.data.games[id] = { gamePath, shuffle: false };
  t.after(() => { spawnImpl = () => { throw new Error('Unexpected game spawn'); }; });
  return { dir, folders, manager, events };
}
const game = (snapshot, id) => snapshot.games.find(item => item.id === id);
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function clock() {
  const pending = new Map();
  let next = 0;
  return {
    now: Date.now,
    setTimeout: (callback, delay) => { const id = ++next; pending.set(id, { callback, delay }); return id; },
    clearTimeout: id => pending.delete(id),
    fire: () => {
      assert.equal(pending.size, 1);
      const [id, timer] = pending.entries().next().value;
      pending.delete(id);
      timer.callback();
    },
    get pending() { return pending.size; },
  };
}
async function settle(predicate) {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(predicate(), 'automatic restart did not settle');
}

test('updateEngine rejects unsupported games, unavailable service, and missing or invalid folders', async t => {
  const calls = [];
  const { manager, folders } = await fixture(t, { update: async (...args) => { calls.push(args); } });
  await assert.rejects(manager.updateEngine('waw'), /Only CoD4 and MW2/);
  await assert.rejects(manager.updateEngine('bogus'), /Only CoD4 and MW2/);
  const noService = new ServerManager(path.join(path.dirname(folders.cod4), 'other-settings.json'), () => {});
  await assert.rejects(noService.updateEngine('cod4'), /unavailable/);
  manager.data.games.cod4.gamePath = '';
  await assert.rejects(manager.updateEngine('cod4'), /Select an installed game folder/);
  manager.data.games.mw2.gamePath = path.join(path.dirname(folders.mw2), 'not-installed');
  await fs.mkdir(manager.data.games.mw2.gamePath);
  await assert.rejects(manager.updateEngine('mw2'), /Select an installed game folder/);
  assert.deepEqual(calls, []);
  assert.equal(manager.engineBusy.size, 0);
  assert.equal(manager.hasModWork(), false);
});

test('updateEngine reserves synchronously, exposes engineBusy, and blocks concurrent same-game changes', async t => {
  const entered = deferred();
  const release = deferred();
  const calls = [];
  const { manager, folders, events } = await fixture(t, { update: async (...args) => {
    calls.push(args);
    entered.resolve();
    await release.promise;
  } });
  manager.modInstaller = { remove: async () => { throw new Error('Unexpected mod change'); } };
  manager.data.games.cod4.autoRestart = true;
  const work = manager.updateEngine('cod4');
  try {
    // This check must happen before updateEngine's first awaited snapshot finishes.
    assert.equal(manager.engineBusy.has('cod4'), true);
    assert.equal(manager.hasModWork(), true);
    await assert.rejects(manager.updateEngine('cod4'), /finish other changes/);
    await assert.rejects(manager.start('cod4'), /engine update to finish/);
    await assert.rejects(manager.botAction('cod4', 'remove'), /finish engine changes/);
    await assert.rejects(manager.chooseFolder('cod4', null, {
      showOpenDialog: async () => ({ canceled: false, filePaths: [folders.cod4] }),
    }), /engine or Bot Warfare change/);
    const timers = clock();
    manager.restartTimers = timers;
    assert.equal(manager.scheduleRestart('cod4', { startedAt: null }), false);
    assert.equal(timers.pending, 0);
    await entered.promise;
    assert.deepEqual(calls, [['cod4', folders.cod4]]);
    const snapshot = await manager.snapshot();
    assert.equal(game(snapshot, 'cod4').engineBusy, true);
    assert.equal(game(snapshot, 'mw2').engineBusy, false);
    assert.ok(events.some(event => event.type === 'state' && game(event.snapshot, 'cod4').engineBusy));
  } finally {
    release.resolve();
    await work;
  }
  assert.equal(manager.engineBusy.size, 0);
  assert.equal(manager.hasModWork(), false);
  assert.equal(game(await manager.snapshot(), 'cod4').engineBusy, false);
  assert.equal(manager.data.games.cod4.gamePath, folders.cod4);
});

test('updateEngine cancels a pending restart but rejects a running server or mod change', async t => {
  const calls = [];
  const { manager, folders } = await fixture(t, { update: async (...args) => { calls.push(args); } });
  const timers = clock();
  manager.restartTimers = timers;
  manager.data.games.mw2.autoRestart = true;
  const restarting = { status: 'restarting' };
  manager.instances.set('mw2', restarting);
  const state = manager.restartState('mw2');
  state.timer = timers.setTimeout(() => { throw new Error('Cancelled restart fired'); }, 2000);
  state.nextAttemptAt = new Date().toISOString();
  assert.equal(await manager.updateEngine('mw2'), true);
  assert.deepEqual(calls, [['mw2', folders.mw2]]);
  assert.equal(timers.pending, 0);
  assert.equal(state.nextAttemptAt, null);
  assert.equal(manager.instances.has('mw2'), false);
  manager.instances.set('cod4', { status: 'running' });
  await assert.rejects(manager.updateEngine('cod4'), /Stop this server/);
  manager.instances.delete('cod4');
  manager.modBusy.add('cod4');
  await assert.rejects(manager.updateEngine('cod4'), /finish other changes/);
  manager.modBusy.delete('cod4');
  assert.equal(manager.engineBusy.size, 0);
  assert.equal(calls.length, 1);
});

test('failed engine update releases the reservation and allows a later explicit retry', async t => {
  const failure = deferred();
  const entered = deferred();
  let calls = 0;
  const { manager, folders } = await fixture(t, { update: async (id, folder) => {
    assert.equal(id, 'mw2');
    assert.equal(folder, folders.mw2);
    if (++calls === 1) { entered.resolve(); await failure.promise; }
  } });
  const work = manager.updateEngine('mw2');
  assert.equal(manager.engineBusy.has('mw2'), true);
  await entered.promise;
  failure.reject(new Error('synthetic updater failure'));
  await assert.rejects(work, /synthetic updater failure/);
  assert.equal(manager.engineBusy.has('mw2'), false);
  assert.equal(manager.hasModWork(), false);
  assert.equal(game(await manager.snapshot(), 'mw2').engineBusy, false);
  assert.equal(await manager.updateEngine('mw2'), true);
  assert.equal(calls, 2);
});

test('interrupted engine prepareLaunch refuses manual Start and automatic retry without updating or spawning', async t => {
  const calls = { update: 0, prepare: [] };
  const { manager, folders } = await fixture(t, {
    update: async () => { calls.update++; },
    prepareLaunch: async (...args) => { calls.prepare.push(args); throw new Error('interrupted engine update'); },
  });
  spawnImpl = () => { throw new Error('Unexpected game spawn'); };
  for (const id of ['cod4', 'mw2']) {
    assert.match((await manager.check(id)).blockers.join(' '), /interrupted engine update/);
    await assert.rejects(manager.start(id), /interrupted engine update/);
    assert.equal(manager.instances.has(id), false);
    manager.data.games[id].autoRestart = true;
    await assert.rejects(manager.launch(id, true), /interrupted engine update/);
    assert.equal(manager.restartState(id).cutOff, true);
    assert.equal(manager.instances.has(id), false);
  }
  // Snapshot readiness now checks for interrupted engine work as well as Start,
  // so its read-only preflight can run more than twice per game.
  for (const id of ['cod4', 'mw2']) {
    assert.ok(calls.prepare.filter(([name, folder]) => name === id && folder === folders[id]).length >= 2);
  }
  assert.equal(calls.update, 0);
  for (const [id, file] of [['cod4', 'main/botserver_rotation.cfg'], ['mw2', 'userraw/serverlan_rotation.cfg']]) {
    await assert.rejects(fs.stat(path.join(folders[id], file)), { code: 'ENOENT' });
  }
});

test('manual Start and actual automatic restart prepare both engines but NEVER update them', async t => {
  const calls = { update: 0, prepare: [], spawn: [] };
  const { manager, folders } = await fixture(t, {
    update: async () => { calls.update++; throw new Error('Start must not update an engine'); },
    prepareLaunch: async (...args) => { calls.prepare.push(args); },
  });
  const timers = clock();
  manager.restartTimers = timers;
  manager.portInUse = async () => false;
  let pid = 9000;
  spawnImpl = (file, args, options) => {
    const child = new EventEmitter();
    Object.assign(child, { pid: ++pid, stdout: null, stderr: null, exitCode: null, signalCode: null });
    child.finish = code => { child.exitCode = code; child.emit('close', code, null); };
    calls.spawn.push({ file, args, options, child });
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  for (const id of ['cod4', 'mw2']) {
    manager.data.games[id].autoRestart = true;
    assert.deepEqual((await manager.check(id)).blockers, []);
    await manager.start(id);
    assert.equal(manager.instances.get(id).status, 'running');
    assert.equal(calls.spawn.at(-1).file, path.join(folders[id], id === 'cod4' ? 'Cod4R-DedRun.exe' : 'iw4x.exe'));
    calls.spawn.at(-1).child.finish(1);
    assert.equal(manager.instances.get(id).status, 'restarting');
    assert.equal(timers.pending, 1);
    timers.fire();
    await settle(() => manager.instances.get(id)?.status === 'running');
    // This is an intentional end to the fixture, not another unexpected exit.
    manager.instances.get(id).noRestart = true;
    calls.spawn.at(-1).child.finish(0);
    await settle(() => !manager.instances.has(id));
  }
  // Snapshot readiness now checks for interrupted engine work as well as Start,
  // so its read-only preflight can run more than twice per game.
  for (const id of ['cod4', 'mw2']) {
    assert.ok(calls.prepare.filter(([name, folder]) => name === id && folder === folders[id]).length >= 2);
  }
  assert.equal(calls.spawn.length, 4);
  assert.equal(calls.update, 0);
  assert.equal(timers.pending, 0);
});
