const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const Module = require('node:module');

// Intercept only the manager's child_process import; no game or firewall is run.
const originalLoad = Module._load;
let spawnImpl = () => { throw new Error('Unexpected spawn'); };
Module._load = function (request, parent, isMain) {
  if (request === 'node:child_process' && parent?.filename === require.resolve('../electron/manager.cjs')) {
    return { spawn: (...args) => spawnImpl(...args), execFile: () => { throw new Error('Unexpected execFile'); } };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { ServerManager } = require('../electron/manager.cjs');
Module._load = originalLoad;

const root = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp', 'opencode');
async function fixture(t) {
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'botland-phase4-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
const game = (snapshot, id) => snapshot.games.find(item => item.id === id);
function processMock(pid) {
  const child = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  Object.assign(child, { pid, stdout, stderr, stdin: null, exitCode: null, signalCode: null });
  child.finish = (code = 0) => { child.exitCode = code; stdout.emit('end'); stderr.emit('end'); child.emit('close', code, null); };
  return child;
}
async function settle(predicate) {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(predicate(), 'asynchronous cleanup did not settle');
}

test('running connect candidates and cached possible orphans never claim an owned PID or scan on snapshot', async t => {
  const dir = await fixture(t);
  let calls = 0;
  const manager = new ServerManager(path.join(dir, 'settings.json'), () => {}, dir, {
    networkInterfaces: () => ({ LAN: [{ family: 'IPv4', address: '192.168.1.20', internal: false }] }),
    findPossibleOrphans: async candidates => {
      calls++;
      assert.ok(candidates.some(item => item.id === 'cod4' && item.port === 28962));
      return [{ id: 'cod4', port: 28962, pid: 777, reason: 'UDP port occupied (process identity unverified)' },
        { id: 'mw2', port: 28962, pid: 999, reason: 'UDP port occupied (process identity unverified)' }];
    },
  });
  manager.data.games.cod4 = { gamePath: dir };
  manager.data.games.mw2 = { gamePath: dir, port: 28962 };
  manager.instances.set('mw2', { status: 'running', activePort: 28962, child: { pid: 999 } });
  await manager.rescanOrphans();
  assert.equal(calls, 1);
  const first = await manager.snapshot();
  assert.deepEqual(game(first, 'cod4').orphan, { pid: 777, port: 28962, reason: 'UDP port occupied (process identity unverified)' });
  assert.equal(game(first, 'mw2').orphan, null);
  assert.equal(game(first, 'mw2').connect.primaryAddress, '192.168.1.20:28962');
  assert.deepEqual(game(first, 'cod4').connect.candidates, []);
  manager.instances.set('cod4', { status: 'running', activePort: 28962, child: { pid: 777 } });
  assert.equal(game(await manager.snapshot(), 'cod4').orphan, null);
  assert.equal(calls, 1);
  manager.instances.clear();
  manager.findPossibleOrphans = async () => { throw new Error('netstat unavailable'); };
  await manager.rescanOrphans();
  assert.equal(game(await manager.snapshot(), 'cod4').orphan, null);
  assert.equal(manager.hasRunning(), false);
});

test('whole-line redaction and optional session service cover stdout, stderr, file and manager logs without blocking lifecycle', async t => {
  const dir = await fixture(t);
  await fs.mkdir(path.join(dir, 'main'));
  const events = [];
  const calls = [];
  let fileLine;
  const key = 'fixture';
  const service = {
    async start(id, options) { calls.push(['start', id, options.key]); },
    append(id, entry) { calls.push(['append', id, entry]); return Promise.reject(new Error('disk full')); },
    async close(id) { calls.push(['close', id]); throw new Error('unavailable'); },
  };
  const manager = new ServerManager(path.join(dir, 'settings.json'), event => events.push(event), dir, {
    keyStore: { get: async () => key }, sessionLogs: service,
    createLogTail: options => ({ async start() { calls.push(['tail-start']); fileLine = options.onLine; },
      async stop() { calls.push(['tail-stop']); } }),
  });
  manager.broadcastState = async () => {};
  manager.check = async () => ({ blockers: [], gamePath: dir, options: { port: 28960, mode: 'dom', shuffle: false, selectedMaps: [], lan: true } });
  manager.maps = async () => ({ maps: ['mp_alpha', 'mp_bravo'], modes: [{ value: 'dom' }] });
  manager.portInUse = async () => false;
  const child = processMock(9777);
  spawnImpl = () => { calls.push(['spawn']); queueMicrotask(() => child.emit('spawn')); return child; };
  t.after(() => { spawnImpl = () => { throw new Error('Unexpected spawn'); }; });
  await manager.start('waw');
  assert.deepEqual(calls.filter(item => ['start', 'tail-start', 'spawn'].includes(item[0])).map(item => item[0]), ['start', 'tail-start', 'spawn']);
  child.stdout.emit('data', Buffer.from('api_token=split'));
  child.stdout.emit('data', Buffer.from(' secret\n+set key fixture\n'));
  child.stderr.emit('data', Buffer.from('guid="another secret"\n'));
  fileLine('rcon_password=other-secret');
  fileLine(`unlabeled ${key}`);
  manager.addLog('waw', 'manager secret: should-hide');
  child.finish();
  await settle(() => calls.some(item => item[0] === 'close'));
  const logEntries = events.filter(item => item.type === 'log').map(item => item.entry);
  assert.ok(logEntries.some(item => item.source === 'stdout' && item.message === 'api_token=[REDACTED] secret'));
  assert.ok(logEntries.some(item => item.source === 'stdout' && item.message === '+set key [REDACTED]'));
  assert.ok(logEntries.some(item => item.source === 'stderr' && item.message === 'guid=[REDACTED]'));
  assert.ok(logEntries.some(item => item.source === 'file' && item.message === 'rcon_password=[REDACTED]'));
  assert.ok(logEntries.some(item => item.source === 'file' && item.message === 'unlabeled [REDACTED]'));
  assert.ok(logEntries.some(item => item.source === 'manager' && item.message === 'manager secret: [REDACTED]'));
  assert.equal(calls.findIndex(item => item[0] === 'tail-stop') < calls.findIndex(item => item[0] === 'close'), true);
  const persisted = calls.filter(item => item[0] === 'append').map(item => item[2]);
  // A rejected append ends disk logging for the session (the real service has
  // already closed the file); console logging continues unaffected.
  assert.equal(persisted.length, 1);
  assert.equal(JSON.stringify({ events, persisted, logs: manager.logs.get('waw') }).includes(key), false);
  assert.equal(manager.hasRunning(), false);
});

test('a fresh launch waits for the previous tail and session to close', async t => {
  const dir = await fixture(t);
  await fs.mkdir(path.join(dir, 'main'));
  const order = [];
  let finishTail;
  const waiting = new Promise(resolve => { finishTail = resolve; });
  const manager = new ServerManager(path.join(dir, 'settings.json'), () => {}, dir, {
    sessionLogs: { async start() { order.push('session-start'); }, async close() { order.push('session-close'); },
      async append() {} },
    createLogTail: () => ({ async start() { order.push('tail-start'); },
      async stop() { order.push('tail-stop'); if (order.filter(item => item === 'tail-stop').length === 1) await waiting; } }),
  });
  manager.broadcastState = async () => {};
  manager.check = async () => ({ blockers: [], gamePath: dir, options: { port: 28960, mode: 'dom', shuffle: false, selectedMaps: [], lan: true } });
  manager.maps = async () => ({ maps: ['mp_alpha'], modes: [{ value: 'dom' }] });
  manager.portInUse = async () => false;
  const spawned = [];
  spawnImpl = () => { const child = processMock(8000 + spawned.length); spawned.push(child); order.push('spawn'); queueMicrotask(() => child.emit('spawn')); return child; };
  t.after(() => { finishTail(); spawnImpl = () => { throw new Error('Unexpected spawn'); }; });
  await manager.start('cod4');
  spawned[0].finish();
  const next = manager.start('cod4');
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(spawned.length, 1);
  finishTail();
  await next;
  assert.equal(spawned.length, 2);
  assert.deepEqual(order.filter(item => ['session-start', 'session-close', 'spawn'].includes(item)),
    ['session-start', 'spawn', 'session-close', 'session-start', 'spawn']);
  spawned[1].finish();
  await settle(() => order.filter(item => item === 'session-close').length === 2);
});

test('real session JSONL never stores the key, command line or unredacted server output', async t => {
  const dir = await fixture(t);
  await fs.mkdir(path.join(dir, 'main'));
  const { SessionLogs } = require('../electron/session-logs.cjs');
  const sessionLogs = new SessionLogs({ userData: dir });
  const manager = new ServerManager(path.join(dir, 'settings.json'), () => {}, dir, {
    keyStore: { get: async () => 'session-unique-key' }, sessionLogs,
    createLogTail: () => ({ async start() {}, async stop() {} }),
  });
  manager.broadcastState = async () => {};
  manager.check = async () => ({ blockers: [], gamePath: dir, options: { port: 28960, mode: 'dom', shuffle: false, selectedMaps: [], lan: true } });
  manager.maps = async () => ({ maps: ['mp_alpha', 'mp_bravo'], modes: [{ value: 'dom' }] });
  manager.portInUse = async () => false;
  const child = processMock(1337);
  spawnImpl = () => { queueMicrotask(() => child.emit('spawn')); return child; };
  t.after(() => { spawnImpl = () => { throw new Error('Unexpected spawn'); }; });
  await manager.start('waw');
  child.stdout.emit('data', Buffer.from('key=session-unique-key\npassword="unshared secret"\n'));
  child.finish();
  await settle(() => !sessionLogs.sessions.has('waw'));
  const files = await fs.readdir(path.join(dir, 'session-logs', 'waw'));
  assert.equal(files.length, 1);
  const content = await fs.readFile(path.join(dir, 'session-logs', 'waw', files[0]), 'utf8');
  assert.match(content, /key=\[REDACTED\]/);
  assert.match(content, /password=\[REDACTED\]/);
  assert.doesNotMatch(content, /session-unique-key|unshared secret|\+set key/);
});

test('manager backup API stays path-bound, previewed and broadcasts restored bytes', async t => {
  const dir = await fixture(t);
  const file = path.join(dir, 'main', 'botserver.cfg');
  await fs.mkdir(path.dirname(file));
  const original = Buffer.from('\ufeffset sv_hostname "Before"\r\nset rcon_password "confidential"\r\n');
  await fs.writeFile(file, original);
  let broadcasts = 0;
  const manager = new ServerManager(path.join(dir, 'settings.json'), () => {}, dir);
  manager.data.games.cod4 = { gamePath: dir };
  manager.broadcastState = async () => { broadcasts++; };
  const review = await manager.previewSettings('cod4', 'base', 'dom', { sv_hostname: 'After' });
  await manager.commitSettings('cod4', 'base', 'dom', { sv_hostname: 'After' }, review.token);
  const edited = await fs.readFile(file);
  const [backup] = await manager.listConfigBackups('cod4', 'base', 'dom');
  assert.match(backup.id, /^[a-f0-9]{64}$/);
  const restore = await manager.previewConfigRestore('cod4', 'base', 'dom', backup.id);
  assert.equal(JSON.stringify(restore).includes('confidential'), false);
  await assert.rejects(manager.restoreConfigBackup('cod4', 'base', 'dom', backup.id, '0'.repeat(64)), /changed since preview/);
  const result = await manager.restoreConfigBackup('cod4', 'base', 'dom', backup.id, restore.token);
  assert.deepEqual(await fs.readFile(file), original);
  assert.equal(broadcasts, 2);
  assert.ok((await manager.listConfigBackups('cod4', 'base', 'dom')).some(item => item.id === result.backupId && item.bytes === edited.length));
  await assert.rejects(manager.previewConfigRestore('cod4', 'base', '../other', backup.id), /Invalid mode|not installed/);
  await assert.rejects(manager.pruneConfigBackups('cod4', 'base', 'dom', ['bad']), /Invalid|Explicit/);
  assert.deepEqual(await manager.pruneConfigBackups('cod4', 'base', 'dom', [backup.id]), { removed: 1 });
  assert.equal((await manager.listConfigBackups('cod4', 'base', 'dom')).length, 1);
});

test('firewall apply uses validated staged managed-rule lines; remove retains legacy behavior', async () => {
  const manager = new ServerManager('unused', () => {}, 'unused');
  manager.data.games.cod4 = { port: 30001, lan: false };
  manager.instances.set('cod4', { status: 'running', activePort: 28962 });
  const runs = [];
  manager.runElevated = async lines => { runs.push(lines); };
  manager.firewallStatus = async () => ({ state: 'any' });
  await manager.firewallApply('cod4');
  const script = runs[0].join('\n');
  assert.match(script, /\$targetPort = '28962'/);
  assert.match(script, /\$targetScope = 'Any'/);
  assert.match(script, /botLANd.ServerManager/);
  assert.match(script, /New-NetFirewallRule/);
  assert.match(script, /Candidate rule was not promoted/);
  assert.doesNotMatch(script, /netsh|delete rule name/);
  await manager.firewallRemove('cod4');
  assert.match(runs[1][0], /netsh advfirewall firewall delete rule/);
});
