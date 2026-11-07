const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const Module = require('node:module');

// Preserve the manager's child_process import seam: nothing here launches a game or taskkill.
const originalLoad = Module._load;
let spawnImpl = () => { throw new Error('Unexpected spawn'); };
let execImpl = () => { throw new Error('Unexpected taskkill'); };
Module._load = function (request, parent, isMain) {
  if (request === 'node:child_process' && parent?.filename === require.resolve('../electron/manager.cjs')) {
    return { spawn: (...args) => spawnImpl(...args), execFile: (...args) => execImpl(...args) };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { ServerManager } = require('../electron/manager.cjs');
Module._load = originalLoad;

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
function child(pid, withStdin = true) {
  const proc = new EventEmitter();
  const writes = [];
  const stdin = new EventEmitter();
  stdin.writable = true;
  stdin.write = text => { writes.push(text); };
  Object.assign(proc, { pid, stdin: withStdin ? stdin : null, stdout: null, stderr: null, exitCode: null, signalCode: null, writes });
  proc.finish = (code = 1) => { proc.exitCode = code; proc.emit('close', code, null); };
  return proc;
}
async function fixture(t) {
  const root = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp', 'opencode');
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'botland-restart-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'main'));
  await fs.mkdir(path.join(dir, 'userraw'));
  const timers = clock();
  const manager = new ServerManager(path.join(dir, 'settings.json'), () => {}, dir, { restartTimers: timers });
  manager.broadcastState = async () => {};
  manager.check = async () => ({ blockers: [], gamePath: dir, options: { port: 28962, mode: 'dom', shuffle: false, selectedMaps: [], lan: true } });
  manager.maps = async () => ({ maps: ['mp_alpha', 'mp_bravo'], modes: [{ value: 'dom' }] });
  manager.portInUse = async () => false;
  let pid = 5000;
  const spawned = [];
  spawnImpl = (_file, _args, opts) => {
    const proc = child(++pid, opts.stdio[0] === 'pipe');
    spawned.push({ proc, opts });
    queueMicrotask(() => proc.emit('spawn'));
    return proc;
  };
  execImpl = () => { throw new Error('Unexpected taskkill'); };
  t.after(() => { spawnImpl = () => { throw new Error('Unexpected spawn'); }; execImpl = () => { throw new Error('Unexpected taskkill'); }; });
  return { manager, timers, spawned, dir };
}
async function settle(predicate) {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(predicate(), 'asynchronous launch did not settle');
}

test('restart is per-game, opt-in, persisted and validated; snapshots never persist runtime state', async t => {
  const { manager, dir } = await fixture(t);
  await assert.rejects(manager.setAutoRestart('bogus', true), /Unknown game/);
  await assert.rejects(manager.setAutoRestart('cod4', 'true'), /on or off/);
  assert.equal(manager.data.games.cod4, undefined);
  await manager.setAutoRestart('cod4', true);
  assert.equal(manager.data.games.mw2, undefined);
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'settings.json'), 'utf8'));
  assert.equal(saved.games.cod4.autoRestart, true);
  assert.equal(saved.games.cod4.restart, undefined);
  const next = new ServerManager(path.join(dir, 'settings.json'), () => {}, dir);
  await next.initialize();
  next.check = async () => ({ installed: false, gamePath: '', pathSource: 'none', keyStatus: 'not-required', blockers: [], warnings: [], options: {} });
  const snapshot = await next.snapshot();
  assert.deepEqual(snapshot.games.find(g => g.id === 'cod4').restart, { enabled: true, attempts: 0, nextAttemptAt: null, cutOff: false });
  assert.equal(snapshot.games.find(g => g.id === 'mw2').restart.enabled, false);
  await manager.setAutoRestart('cod4', false);
  assert.equal(manager.data.games.cod4.autoRestart, false);
});

test('unexpected owned exits retry with bounded exponential backoff and cut off after five retries', async t => {
  const { manager, timers, spawned } = await fixture(t);
  await manager.setAutoRestart('cod4', true);
  await manager.start('cod4');
  assert.equal(spawned[0].opts.stdio[0], 'pipe');
  const delays = [2000, 4000, 8000, 16000, 30000];
  for (let index = 0; index < delays.length; index++) {
    spawned[index].proc.finish(1);
    const state = manager.restartState('cod4');
    assert.equal(manager.instances.get('cod4').status, 'restarting');
    assert.equal(state.attempts, index + 1);
    assert.equal(Date.parse(state.nextAttemptAt) - timers.now(), delays[index]);
    timers.advance(delays[index] - 1);
    assert.equal(spawned.length, index + 1);
    timers.advance(1);
    await settle(() => spawned.length === index + 2 && manager.instances.get('cod4')?.status === 'running');
  }
  spawned.at(-1).proc.finish(1);
  assert.equal(manager.hasRunning(), false);
  assert.equal(manager.restartState('cod4').cutOff, true);
  assert.equal(manager.restartState('cod4').attempts, 6);
  assert.equal(timers.pending, 0);
  await manager.start('cod4');
  assert.equal(manager.restartState('cod4').cutOff, false);
  assert.equal(manager.restartState('cod4').attempts, 0);
  spawned.at(-1).proc.finish(0);
});

test('healthy runtime resets the crash budget; short-run crashes stay in the rolling window', async t => {
  const { manager, timers, spawned } = await fixture(t);
  await manager.setAutoRestart('cod4', true);
  await manager.start('cod4');
  spawned[0].proc.finish(1);
  timers.advance(2000);
  await settle(() => manager.instances.get('cod4')?.status === 'running');
  manager.instances.get('cod4').startedAt = new Date(timers.now() - 600001).toISOString();
  assert.equal((await manager.snapshot()).games.find(game => game.id === 'cod4').restart.attempts, 0);
  spawned[1].proc.finish(1);
  assert.equal(manager.restartState('cod4').attempts, 1);
  assert.equal(Date.parse(manager.restartState('cod4').nextAttemptAt) - timers.now(), 2000);
  await manager.stop('cod4');
});

test('Stop, stopAll, opt-out and mod operation cancel backoff without taskkill or future spawn', async t => {
  const { manager, timers, spawned } = await fixture(t);
  await manager.setAutoRestart('cod4', true);
  await manager.start('cod4');
  spawned[0].proc.finish();
  await manager.stop('cod4');
  assert.equal(timers.pending, 0);
  timers.advance(30000);
  assert.equal(spawned.length, 1);
  await manager.start('cod4');
  spawned[1].proc.finish();
  await manager.setAutoRestart('cod4', false);
  assert.equal(timers.pending, 0);
  await manager.setAutoRestart('cod4', true);
  await manager.start('cod4');
  spawned[2].proc.finish();
  await manager.stopAll();
  assert.equal(timers.pending, 0);
  timers.advance(30000);
  assert.equal(spawned.length, 3);
  // New manager for the mod action, since stopAll permanently disables retry launches.
  const second = await fixture(t);
  second.manager.modInstaller = {};
  await second.manager.setAutoRestart('cod4', true);
  await second.manager.start('cod4');
  second.spawned[0].proc.finish();
  await assert.rejects(second.manager.botAction('cod4', 'remove'), /Select an installed game folder/);
  assert.equal(second.timers.pending, 0);
  assert.equal(second.manager.hasRunning(), false);
});

test('a retry blocked by a port conflict stops retrying; only manual Start clears cutoff', async t => {
  const { manager, timers, spawned } = await fixture(t);
  await manager.setAutoRestart('cod4', true);
  await manager.start('cod4');
  spawned[0].proc.finish();
  manager.portInUse = async () => true;
  timers.advance(2000);
  await settle(() => manager.restartState('cod4').cutOff);
  assert.equal(manager.hasRunning(), false);
  assert.equal(spawned.length, 1);
  assert.equal(timers.pending, 0);
  await assert.rejects(manager.start('cod4'), /already in use/);
  assert.equal(manager.restartState('cod4').cutOff, false);
});

test('automatic retry refuses an unknown port state while manual Start retains engine fallback', async t => {
  const { manager, timers, spawned } = await fixture(t);
  await manager.setAutoRestart('cod4', true);
  await manager.start('cod4');
  spawned[0].proc.finish();
  manager.portInUse = async () => { throw new Error('netstat unavailable'); };
  timers.advance(2000);
  await settle(() => manager.restartState('cod4').cutOff);
  assert.equal(spawned.length, 1);
  assert.equal(manager.hasRunning(), false);
  await manager.start('cod4');
  assert.equal(spawned.length, 2);
  spawned[1].proc.finish(0);
});

test('Cod4R sends quit to the owned stdin and avoids taskkill if it closes', async t => {
  const { manager, spawned } = await fixture(t);
  await manager.start('cod4');
  const stopping = manager.stop('cod4');
  await settle(() => spawned[0].proc.writes.length === 1);
  assert.deepEqual(spawned[0].proc.writes, ['quit\n']);
  spawned[0].proc.finish(0);
  await stopping;
  assert.equal(manager.hasRunning(), false);
});

test('Cod4R falls back to taskkill by PID after grace expires, including retry after failed kill', async t => {
  const { manager, spawned } = await fixture(t);
  manager.gracefulStopTimeout = 10;
  await manager.start('cod4');
  let calls = 0;
  execImpl = (file, args, _options, callback) => {
    assert.equal(file, 'taskkill.exe');
    assert.deepEqual(args, ['/PID', String(spawned[0].proc.pid), '/T', '/F']);
    calls++;
    if (calls === 1) callback(new Error('access denied'));
    else { spawned[0].proc.finish(0); callback(null, '', ''); }
  };
  await assert.rejects(manager.stop('cod4'), /access denied/);
  assert.equal(manager.instances.get('cod4').status, 'running');
  await manager.stop('cod4');
  assert.deepEqual(spawned[0].proc.writes, ['quit\n', 'quit\n']);
  assert.equal(calls, 2);
  assert.equal(manager.hasRunning(), false);
});

test('failed taskkill still suppresses automatic restart when the owned child later exits', async t => {
  const { manager, spawned, timers } = await fixture(t);
  await manager.setAutoRestart('cod4', true);
  manager.gracefulStopTimeout = 1;
  await manager.start('cod4');
  execImpl = (_file, _args, _opts, callback) => callback(new Error('access denied'));
  await assert.rejects(manager.stop('cod4'), /access denied/);
  spawned[0].proc.finish(1);
  assert.equal(manager.hasRunning(), false);
  assert.equal(manager.restartState('cod4').attempts, 0);
  assert.equal(timers.pending, 0);
});

test('failed stopAll leaves the app usable but cannot retry a surviving child', async t => {
  const { manager, spawned, timers } = await fixture(t);
  await manager.setAutoRestart('cod4', true);
  manager.gracefulStopTimeout = 1;
  await manager.start('cod4');
  execImpl = (_file, _args, _opts, callback) => callback(new Error('access denied'));
  await manager.stopAll();
  assert.equal(manager.hasRunning(), true);
  assert.equal(manager.shuttingDown, false);
  // The failed quit must leave the periodic orphan diagnostic running.
  assert.ok(manager.orphanTimer);
  clearInterval(manager.orphanTimer);
  manager.orphanTimer = null;
  spawned[0].proc.finish(1);
  assert.equal(timers.pending, 0);
  assert.equal(manager.hasRunning(), false);
  await manager.start('cod4');
  assert.equal(spawned.length, 2);
  spawned[1].proc.finish(0);
});

test('broken Cod4R stdin falls back to taskkill for the same owned PID', async t => {
  const { manager, spawned } = await fixture(t);
  await manager.start('cod4');
  spawned[0].proc.stdin.write = () => { throw new Error('pipe closed'); };
  let kills = 0;
  execImpl = (file, args, _opts, callback) => {
    assert.equal(file, 'taskkill.exe');
    assert.deepEqual(args, ['/PID', String(spawned[0].proc.pid), '/T', '/F']);
    kills++;
    spawned[0].proc.finish(0);
    callback(null, '', '');
  };
  await manager.stop('cod4');
  assert.equal(kills, 1);
});

test('other engines have ignored stdin and forced stop; cancelled starts never spawn or retry', async t => {
  const { manager, spawned } = await fixture(t);
  await manager.start('mw2');
  assert.equal(spawned[0].opts.stdio[0], 'ignore');
  let kills = 0;
  execImpl = (_file, args, _options, callback) => {
    assert.deepEqual(args, ['/PID', String(spawned[0].proc.pid), '/T', '/F']);
    kills++;
    spawned[0].proc.finish(0);
    callback(null, '', '');
  };
  await manager.stop('mw2');
  assert.equal(kills, 1);
  await manager.setAutoRestart('cod4', true);
  let release;
  manager.check = async () => { await new Promise(resolve => { release = resolve; }); return { blockers: [], gamePath: 'unused', options: { port: 28962, mode: 'dom', shuffle: false, selectedMaps: [], lan: true } }; };
  const starting = manager.start('cod4');
  const stopping = manager.stop('cod4');
  await settle(() => typeof release === 'function');
  release();
  await assert.rejects(starting, /Launch cancelled/);
  await stopping;
  assert.equal(spawned.length, 1);
  assert.equal(manager.restartState('cod4').attempts, 0);
});
