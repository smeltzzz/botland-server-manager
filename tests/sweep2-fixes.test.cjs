const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const Module = require('node:module');

// Intercept only this test file's manager import: no real game executable, taskkill or PowerShell is run.
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
const { updateConfigText, validateValues } = require('../electron/config.cjs');
const { pruneRelease } = require('../scripts/prune-release.cjs');

const opts = id => ({ id, target: 'base', mode: 'dom' });
async function temporary(testContext) {
  const root = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp', 'opencode');
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'botland-sweep2-'));
  testContext.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('server output keeps multi-byte characters that are split across chunks', async t => {
  const dir = await temporary(t);
  const logs = [];
  const manager = new ServerManager(path.join(dir, 'settings.json'), event => { if (event.type === 'log') logs.push(event.entry.message); }, dir);
  manager.broadcastState = async () => {};
  manager.check = async () => ({ blockers: [], gamePath: dir, options: { port: 28960, mode: 'dom', shuffle: false, selectedMaps: [], lan: true } });
  manager.portInUse = async () => false;
  manager.maps = async () => ({ maps: ['mp_alpha'], modes: [{ value: 'dom' }] });
  await fs.mkdir(path.join(dir, 'main'), { recursive: true });
  const child = new EventEmitter();
  Object.assign(child, { pid: 4242, stdout: new PassThrough(), stderr: null, exitCode: null, signalCode: null });
  spawnImpl = () => { process.nextTick(() => child.emit('spawn')); return child; };
  t.after(() => { spawnImpl = () => { throw new Error('Unexpected spawn'); }; });
  await manager.start('cod4');
  const bytes = Buffer.from('Map café loaded\n', 'utf8');
  const split = bytes.indexOf(0xc3) + 1;
  child.stdout.write(bytes.subarray(0, split));
  child.stdout.write(bytes.subarray(split));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(logs.includes('Map café loaded'), logs.join('\n'));
  assert.ok(!logs.some(line => line.includes('\uFFFD')));
});

test('a failed stop of a cancelled launch restores a consistent running state', async t => {
  const dir = await temporary(t);
  const manager = new ServerManager(path.join(dir, 'settings.json'), () => {}, dir);
  manager.broadcastState = async () => {};
  const child = new EventEmitter();
  Object.assign(child, { pid: 4343, stdout: null, stderr: null, exitCode: null, signalCode: null });
  const instance = { status: 'stopping', child, startedAt: null, activePort: 28960, cancelled: true, stopPromise: Promise.resolve() };
  manager.instances.set('cod4', instance);
  execImpl = (_file, _args, _options, callback) => callback(new Error('Access is denied.'), '', '');
  t.after(() => { execImpl = (_file, _args, _options, callback) => callback(null, '', ''); });
  await assert.rejects(manager.stopChild('cod4', instance), /Could not stop server/);
  assert.equal(instance.status, 'running');
  assert.equal(instance.cancelled, false);
  assert.ok(instance.startedAt);
  assert.equal(instance.stopPromise, null);
});

test('a declined UAC prompt is recognized by its native exit code, not localized text', async t => {
  const dir = await temporary(t);
  const manager = new ServerManager(path.join(dir, 'settings.json'), () => {}, dir);
  let command = '';
  execImpl = (_file, args, _options, callback) => {
    command = args.at(-1);
    const error = Object.assign(new Error('Command failed'), { code: 1223, stderr: 'Der Vorgang wurde vom Benutzer abgebrochen.', stdout: '' });
    callback(error, '', error.stderr);
  };
  t.after(() => { execImpl = (_file, _args, _options, callback) => callback(null, '', ''); });
  await assert.rejects(manager.runElevated(['$null = 1']), /elevation prompt was canceled/);
  assert.match(command, /NativeErrorCode -eq 1223\) \{ exit 1223 \}/);
});

test('saving mode and maps together scans the installation once', async t => {
  const dir = await temporary(t);
  const manager = new ServerManager(path.join(dir, 'settings.json'), () => {}, dir);
  manager.broadcastState = async () => {};
  let scans = 0;
  manager.maps = async () => { scans++; return { maps: ['mp_alpha', 'mp_bravo'], modes: [{ value: 'dom' }, { value: 'war' }] }; };
  await manager.saveOptions('cod4', { mode: 'war', selectedMaps: ['mp_bravo'] });
  assert.equal(scans, 1);
  assert.deepEqual([manager.options('cod4').mode, manager.options('cod4').selectedMaps], ['war', ['mp_bravo']]);
});

test('adding a setting to an empty config does not start with a blank line', () => {
  assert.equal(updateConfigText('', { bots_main: '1' }, opts('cod4')), 'set bots_main "1"\n');
});

test('bot target is checked even when the slot count is non-numeric, and MW3 stays capped at 18', () => {
  assert.throws(() => validateValues({ bots_manage_fill: '70' }, opts('cod4'), 'set sv_maxclients "abc"\n'), /cannot exceed player slots|between/);
  assert.throws(() => validateValues({ bots_manage_fill: '20' }, opts('mw3'), 'set sv_maxclients "abc"\n'), /cannot exceed player slots/);
  assert.deepEqual(validateValues({ bots_manage_fill: '40' }, opts('waw'), 'set sv_maxclients "abc"\n'), { bots_manage_fill: '40' });
  assert.throws(() => validateValues({ bots_manage_fill: '20' }, opts('mw3'), 'set sv_maxclients "24"\n'), /cannot exceed player slots/);
  assert.deepEqual(validateValues({ bots_manage_fill: '12' }, opts('cod4'), 'set sv_maxclients "18"\n'), { bots_manage_fill: '12' });
});

test('release cleanup keeps a rebuilt current version whose file kept older capitalization', { skip: process.platform !== 'win32' }, async t => {
  const dir = await temporary(t);
  const current = ['BotLANd Server Manager Setup 0.2.1.exe', 'BotLANd Server Manager 0.2.1.exe', 'BotLANd Server Manager Setup 0.2.1.exe.blockmap'];
  for (const name of [...current, 'botLANd Server Manager 0.2.0.exe']) await fs.writeFile(path.join(dir, name), name);
  assert.deepEqual(await pruneRelease(dir, '0.2.1', 'botLANd Server Manager'), ['botLANd Server Manager 0.2.0.exe']);
  assert.deepEqual((await fs.readdir(dir)).sort(), [...current].sort());
});
