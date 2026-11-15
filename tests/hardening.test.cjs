const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');

// Intercept only the manager's child_process import: nothing is elevated or spawned.
const originalLoad = Module._load;
let execImpl = (_file, _args, _options, callback) => callback(null, '', '');
Module._load = function (request, parent, isMain) {
  if (request === 'node:child_process' && parent?.filename === require.resolve('../electron/manager.cjs')) {
    return { spawn: () => { throw new Error('Unexpected spawn'); }, execFile: (...args) => execImpl(...args) };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { ServerManager } = require('../electron/manager.cjs');
Module._load = originalLoad;
const { validatePayload } = require('../electron/ipc-validate.cjs');

async function temporary(t) {
  const root = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp', 'opencode');
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'botland-hardening-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('IPC payload validation rejects malformed shapes and accepts real ManagerApi calls', () => {
  for (const [action, payload] of [
    ['start', { id: 'cod4' }],
    ['setAutoRestart', { id: 'bo2', enabled: false }],
    ['saveOptions', { id: 'mw2', values: { port: 28961, mode: 'dom', shuffle: true, selectedMaps: ['mp_rust'], lan: false } }],
    ['previewSettings', { id: 'cod4', target: 'base', mode: 'dom', values: { sv_hostname: 'x' }, expectedPath: 'C:\\g\\a.cfg' }],
    ['commitSettings', { id: 'cod4', target: 'mode', mode: 'dom', values: {}, token: 'a'.repeat(64) }],
    ['pruneConfigBackups', { id: 'waw', target: 'base', mode: 'tdm', ids: ['a'.repeat(64)] }],
    ['setUpdateChecks', { enabled: true }],
    ['snapshot', {}],
  ]) assert.doesNotThrow(() => validatePayload(action, payload), action);
  for (const [action, payload, message] of [
    ['start', { id: 'unknown' }, /Invalid game id/],
    ['start', { id: '__proto__' }, /Invalid game id/],
    ['stop', {}, /Invalid game id/],
    ['setAutoRestart', { id: 'bo2', enabled: 'yes' }, /Invalid restart setting/],
    ['setUpdateChecks', { enabled: 1 }, /Invalid update-check setting/],
    ['saveKey', { id: 'bo2', key: 'x'.repeat(5000) }, /Invalid server key/],
    ['saveKey', { id: 'bo2', key: 42 }, /Invalid server key/],
    ['saveOptions', { id: 'mw2', values: { selectedMaps: 'mp_rust' } }, /Invalid map selection/],
    ['saveOptions', { id: 'mw2', values: { lan: 'false' } }, /Invalid lan/],
    ['saveOptions', { id: 'mw2', values: { injected: true } }, /Invalid options/],
    ['previewSettings', { id: 'cod4', target: 'base', mode: 'dom', values: [] }, /Invalid config values/],
    ['previewSettings', { id: 'cod4', target: 'base', mode: 'dom', values: { a: 1 } }, /Invalid config values/],
    ['document', { id: 'cod4', target: '../x' }, /Invalid config target/],
    ['pruneConfigBackups', { id: 'cod4', target: 'base', ids: new Array(1001).fill('a') }, /Invalid backup ids/],
    ['copyConnectAddress', { id: 'cod4', address: {} }, /Invalid connect address/],
    ['start', [], /Invalid request/],
  ]) assert.throws(() => validatePayload(action, payload), message, action);
});

test('firewall journal is written atomically and stays a blocker while unresolved', async t => {
  const dir = await temporary(t);
  const manager = new ServerManager(path.join(dir, 'settings.json'), () => {});
  let workspace;
  execImpl = (_file, args, _options, callback) => {
    const encoded = args.at(-1).match(/'-EncodedCommand','([A-Za-z0-9+/=]+)'/)[1];
    const script = Buffer.from(encoded, 'base64').toString('utf16le');
    const permit = script.match(/Move\('([^']+)'/)[1];
    workspace = path.dirname(permit);
    // Simulate the elevated child claiming the permit but never reporting.
    fs.rename(permit, path.join(workspace, 'started')).then(() => callback(null, '', ''), callback);
  };
  t.after(() => { execImpl = (_f, _a, _o, callback) => callback(null, '', ''); });
  await assert.rejects(manager.runElevated(['Get-Date'], 'bo1'), /unresolved/);
  const journal = JSON.parse(await fs.readFile(manager.firewallJournal('bo1'), 'utf8'));
  assert.equal(journal.workspace, workspace);
  assert.deepEqual((await fs.readdir(dir)).filter(name => name.endsWith('.tmp')), []);
  await fs.rm(workspace, { recursive: true, force: true });
});

test('a corrupt firewall journal fails closed instead of crashing or unlocking', async t => {
  const dir = await temporary(t);
  const manager = new ServerManager(path.join(dir, 'settings.json'), () => {});
  await fs.writeFile(manager.firewallJournal('bo1'), '{"workspace":');
  await manager.initialize();
  assert.ok(manager.firewallUnresolved.has('bo1'));
  assert.ok(manager.firewallBusy.has('bo1'));
  let ran = false;
  await assert.rejects(manager.queueFirewall('bo1', async () => { ran = true; }), /still unresolved/);
  assert.equal(ran, false);
  assert.ok(await fs.stat(manager.firewallJournal('bo1')), 'the journal is kept for manual inspection');
});

test('base config text is cached by path, mtime and size and invalidated on change or app writes', async t => {
  const dir = await temporary(t);
  const manager = new ServerManager(path.join(dir, 'settings.json'), () => {});
  const file = path.join(dir, 'server.cfg');
  await fs.writeFile(file, 'set sv_hostname "one"\n');
  const first = await fs.stat(file);
  assert.match(await manager.cachedConfigText(file, first), /one/);
  // Same stat identity: served from cache without re-reading the file.
  await fs.writeFile(file, 'set sv_hostname "two"\n');
  assert.match(await manager.cachedConfigText(file, first), /one/);
  // A changed size/mtime invalidates.
  await fs.writeFile(file, 'set sv_hostname "three!"\n');
  assert.match(await manager.cachedConfigText(file, await fs.stat(file)), /three!/);
  // App writes clear the cache even if the stat identity looks unchanged.
  manager.invalidateConfigCache();
  await fs.writeFile(file, 'set sv_hostname "four!!"\n');
  const stale = { ...first, mtimeMs: first.mtimeMs, size: first.size };
  assert.match(await manager.cachedConfigText(file, stale), /four!!/);
});
