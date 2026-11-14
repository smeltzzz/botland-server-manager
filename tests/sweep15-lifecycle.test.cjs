const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');

// Intercept the manager only. No game, PowerShell, taskkill, or network is run.
const originalLoad = Module._load;
let execImpl = () => { throw new Error('Unexpected external command'); };
Module._load = function (request, parent, isMain) {
  if (request === 'node:child_process' && parent?.filename === require.resolve('../electron/manager.cjs')) {
    return { spawn: () => { throw new Error('Unexpected spawn'); }, execFile: (...args) => execImpl(...args) };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { ServerManager } = require('../electron/manager.cjs');
Module._load = originalLoad;

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture(t) {
  const root = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp', 'opencode');
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'botland-sweep15-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const manager = new ServerManager(path.join(dir, 'settings.json'), () => {});
  manager.broadcastState = async () => {};
  manager.data.games.cod4 = { gamePath: dir };
  manager.check = async () => ({ blockers: ['synthetic preflight stop'], gamePath: dir });
  // inspectGameFolder uses presence only, never executes these synthetic bytes.
  await fs.writeFile(path.join(dir, 'iw3mp.exe'), 'synthetic');
  return { manager, dir };
}
const dialogFor = dir => ({ showOpenDialog: async () => ({ canceled: false, filePaths: [dir] }) });

test('launch reserves synchronously before recovery; folder edits, mod work and duplicate Start cannot overtake it', async t => {
  const { manager, dir } = await fixture(t);
  const entered = deferred();
  const recover = deferred();
  const paths = [];
  manager.modInstaller = { prepareLaunch: async (_id, folder) => { paths.push(folder); entered.resolve(); await recover.promise; } };
  const launching = manager.start('cod4');
  const rejected = assert.rejects(launching, /synthetic preflight stop/);
  assert.equal(manager.instances.get('cod4').status, 'starting');
  await entered.promise;
  await assert.rejects(manager.start('cod4'), /already starting/);
  await assert.rejects(manager.chooseFolder('cod4', null, dialogFor(dir)), /finish starting/);
  await assert.rejects(manager.botAction('cod4', 'install'), /Stop this server/);
  recover.resolve();
  await rejected;
  assert.deepEqual(paths, [dir]);
  assert.equal(manager.instances.has('cod4'), false);
});

test('Stop during installer recovery cancels the reserved launch without preflight or spawn', async t => {
  const { manager } = await fixture(t);
  const entered = deferred();
  const recover = deferred();
  let checked = false;
  manager.check = async () => { checked = true; throw new Error('Unexpected preflight'); };
  manager.modInstaller = { prepareLaunch: async () => { entered.resolve(); await recover.promise; } };
  const launching = assert.rejects(manager.start('cod4'), /Launch cancelled/);
  await entered.promise;
  const stopped = manager.stop('cod4');
  assert.equal(manager.instances.get('cod4').cancelled, true);
  recover.resolve();
  await Promise.all([launching, stopped]);
  assert.equal(checked, false);
  assert.equal(manager.instances.has('cod4'), false);
});

test('launch retains recovered identity if detection changes during recovery', async t => {
  const { manager, dir } = await fixture(t);
  delete manager.data.games.cod4.gamePath;
  manager.detected = { games: { cod4: { gamePath: dir } } };
  const entered = deferred();
  const recover = deferred();
  manager.modInstaller = { prepareLaunch: async (_id, folder) => {
    assert.equal(folder, dir);
    entered.resolve();
    await recover.promise;
  } };
  const launching = assert.rejects(manager.start('cod4'), /game folder changed during launch/);
  await entered.promise;
  const different = path.join(dir, 'different');
  manager.detected.games.cod4.gamePath = different;
  manager.check = async () => ({ blockers: [], gamePath: different, options: {} });
  recover.resolve();
  await launching;
  assert.equal(manager.instances.has('cod4'), false);
});

test('folder persistence holds its reservation until settings publication, including preference writes queued behind it', async t => {
  const { manager, dir } = await fixture(t);
  const next = path.join(dir, 'next');
  await fs.mkdir(next);
  await fs.writeFile(path.join(next, 'iw3mp.exe'), 'synthetic');
  const entered = deferred();
  const persist = deferred();
  let writes = 0;
  manager.persist = async () => { if (++writes === 1) { entered.resolve(); await persist.promise; } };
  const changing = manager.chooseFolder('cod4', null, dialogFor(next));
  await entered.promise;
  assert.equal(manager.options('cod4').gamePath, dir);
  await assert.rejects(manager.start('cod4'), /folder change to finish/);
  const preference = manager.saveOptions('cod4', { port: 30123 });
  persist.resolve();
  await Promise.all([changing, preference]);
  assert.equal(manager.options('cod4').gamePath, next);
  assert.equal(manager.options('cod4').port, 30123);
  assert.equal(manager.folderUpdates.size, 0);
});

test('a folder change queued behind a preference write also blocks Start and releases on persistence failure', async t => {
  const { manager, dir } = await fixture(t);
  const entered = deferred();
  const persist = deferred();
  manager.persist = async () => { entered.resolve(); await persist.promise; };
  const preference = manager.saveOptions('cod4', { port: 30124 });
  await entered.promise;
  const folderQueued = deferred();
  const updateSettings = manager.updateSettings.bind(manager);
  manager.updateSettings = update => {
    const pending = updateSettings(update);
    folderQueued.resolve();
    return pending;
  };
  const changing = manager.chooseFolder('cod4', null, dialogFor(dir));
  await folderQueued.promise;
  assert.equal(manager.folderUpdates.has('cod4'), true);
  await assert.rejects(manager.start('cod4'), /folder change to finish/);
  manager.persist = async () => { throw new Error('synthetic disk failure'); };
  const rejected = assert.rejects(changing, /synthetic disk failure/);
  persist.resolve();
  await Promise.all([preference, rejected]);
  assert.equal(manager.folderUpdates.size, 0);
});

test('real installer recovers an interrupted stage and disposable done for its exact manager launch reservation', async t => {
  const { BotWarfareInstaller } = require('../electron/botwarfare-install.cjs');
  const { manager, dir } = await fixture(t);
  const installer = new BotWarfareInstaller({ source: { resolveSource: async () => { throw new Error('Unexpected source lookup'); } },
    download: async () => { throw new Error('Unexpected download'); }, isRunning: id => manager.instances.get(id) || false });
  const paths = await installer.paths('cod4', dir);
  await fs.mkdir(paths.folder, { recursive: true });
  const target = path.join(paths.folder, 'z_svr_bots.iwd');
  await fs.writeFile(target, 'original');
  installer.fault = count => { if (count === 1) throw Object.assign(new Error('synthetic crash'), { simulateCrash: true }); };
  await assert.rejects(installer.transition('cod4', paths, new Map([['z_svr_bots.iwd', Buffer.from('partial')]]), null, { overwrite: true }), /synthetic crash/);
  const done = path.join(paths.parent, '.botland-done-cod4-ABC123');
  await fs.mkdir(done);
  await fs.writeFile(path.join(done, 'disposable'), 'partial cleanup');
  assert.equal(await fs.readFile(target, 'utf8'), 'partial');
  installer.fault = () => {};
  manager.modInstaller = installer;
  let checked = false;
  manager.check = async () => {
    checked = true;
    assert.equal(await fs.readFile(target, 'utf8'), 'original');
    assert.deepEqual((await fs.readdir(paths.parent)).filter(name => /^\.botland-(stage|done)-/u.test(name)), []);
    return { blockers: ['synthetic preflight stop'] };
  };
  await assert.rejects(manager.start('cod4'), /synthetic preflight stop/);
  assert.equal(checked, true);
  assert.equal(manager.instances.has('cod4'), false);
});

test('installer reservation exemption is identity-only, pre-spawn, and exclusive to prepareLaunch recovery', async t => {
  const { BotWarfareInstaller } = require('../electron/botwarfare-install.cjs');
  const { dir } = await fixture(t);
  const reservation = { status: 'starting', child: null };
  let state = reservation;
  const installer = new BotWarfareInstaller({ source: { resolveSource: async () => { throw new Error('Unexpected source lookup'); } },
    download: async () => { throw new Error('Unexpected download'); }, isRunning: () => state });
  const paths = await installer.paths('cod4', dir);
  const done = path.join(paths.parent, '.botland-done-cod4-ABC123');
  await fs.mkdir(done, { recursive: true });
  for (const competing of [true, 'starting', 'running', { ...reservation }, { status: 'running' }]) {
    state = competing;
    await assert.rejects(installer.prepareLaunch('cod4', dir, reservation), /Stop the starting or running/);
  }
  state = reservation;
  reservation.child = {};
  await assert.rejects(installer.prepareLaunch('cod4', dir, reservation), /Stop the starting or running/);
  reservation.child = null;
  reservation.status = 'running';
  await assert.rejects(installer.prepareLaunch('cod4', dir, reservation), /Stop the starting or running/);
  reservation.status = 'starting';
  for (const action of [() => installer.status('cod4', dir), () => installer.install('cod4', dir), () => installer.remove('cod4', dir)]) {
    await assert.rejects(action(), /Stop the starting or running/);
    assert.equal((await fs.stat(done)).isDirectory(), true);
  }
  await installer.prepareLaunch('cod4', dir, reservation);
  await assert.rejects(fs.access(done), { code: 'ENOENT' });
});

test('folder publication blocks every Bot Warfare action and engine update before touching the old install', async t => {
  for (const queued of [false, true]) await t.test(queued ? 'queued behind preference persistence' : 'folder persistence in flight', async t => {
    const { manager, dir } = await fixture(t);
    const next = path.join(dir, 'next');
    await fs.mkdir(next);
    await fs.writeFile(path.join(next, 'iw3mp.exe'), 'synthetic');
    const entered = deferred();
    const persist = deferred();
    manager.persist = async () => { entered.resolve(); await persist.promise; };
    let calls = 0;
    manager.modInstaller = { status: async () => { calls++; return { state: 'installed' }; },
      install: async () => { calls++; }, remove: async () => { calls++; } };
    manager.engineUpdater = { update: async () => { calls++; } };
    const preference = queued ? manager.saveOptions('cod4', { port: 30125 }) : Promise.resolve();
    if (queued) await entered.promise;
    const reserved = deferred();
    const updateSettings = manager.updateSettings.bind(manager);
    manager.updateSettings = update => { const pending = updateSettings(update); reserved.resolve(); return pending; };
    const changing = manager.chooseFolder('cod4', null, dialogFor(next));
    await reserved.promise;
    if (!queued) await entered.promise;
    assert.equal(manager.options('cod4').gamePath, dir);
    for (const operation of ['install', 'update', 'reinstall', 'remove']) await assert.rejects(manager.botAction('cod4', operation), /folder change to finish/);
    await assert.rejects(manager.updateEngine('cod4'), /folder change to finish/);
    assert.equal(calls, 0);
    assert.equal(manager.modBusy.size, 0);
    assert.equal(manager.engineBusy.size, 0);
    persist.resolve();
    await Promise.all([preference, changing]);
    assert.equal(manager.options('cod4').gamePath, next);
    await manager.botAction('cod4', 'reinstall');
    await manager.updateEngine('cod4');
    assert.equal(calls, 3);
  });
});

function elevationPaths(args) {
  const command = args.at(-1);
  const encoded = command.match(/'-EncodedCommand','([^']+)'/)[1];
  const script = Buffer.from(encoded, 'base64').toString('utf16le');
  const [, permit, started] = script.match(/File\]::Move\('([^']+)', '([^']+)'\)/);
  const resultFile = script.match(/Set-Content -LiteralPath '([^']+)'/)[1];
  return { script, permit, started, resultFile, workspace: path.dirname(resultFile) };
}
const timeout = () => Object.assign(new Error('synthetic timeout'), { killed: true, signal: 'SIGTERM' });

test('timed-out pending UAC is atomically revoked: a late approval cannot claim permission', async t => {
  const { manager } = await fixture(t);
  let paths;
  execImpl = (_file, args, _opts, callback) => { paths = elevationPaths(args); callback(timeout(), '', ''); };
  await assert.rejects(manager.runElevated(['throw "must not execute"']), /permission was revoked/);
  assert.ok(paths.script.indexOf('File]::Move') < paths.script.indexOf('must not execute'));
  await assert.rejects(fs.rename(paths.permit, paths.started), { code: 'ENOENT' });
  await assert.rejects(fs.access(paths.workspace), { code: 'ENOENT' });
});

test('native UAC cancellation remains definitive and releases the BO1 reservation', async t => {
  const { manager } = await fixture(t);
  execImpl = (_file, _args, _opts, callback) => callback(Object.assign(new Error('localized'), { code: 1223 }), '', '');
  await assert.rejects(manager.firewallApply('bo1'), /prompt was canceled/);
  assert.equal(manager.firewallBusy.has('bo1'), false);
  assert.equal(manager.firewallUnresolved.size, 0);
  await assert.rejects(fs.access(manager.firewallJournal('bo1')), { code: 'ENOENT' });
});

test('claimed elevated work outlives timeout: status cannot unlock it, late terminal outcome can', async t => {
  const { manager } = await fixture(t);
  let paths;
  let calls = 0;
  execImpl = (_file, args, _opts, callback) => {
    calls++;
    paths = elevationPaths(args);
    fs.rename(paths.permit, paths.started).then(() => callback(timeout(), '', ''), callback);
  };
  manager.firewallQuery = async () => [];
  const first = manager.firewallRemove('bo1');
  const queued = manager.firewallApply('bo1');
  const queuedRejected = assert.rejects(queued, /still unresolved/);
  await assert.rejects(first, /outcome is unresolved/);
  await queuedRejected;
  t.after(() => fs.rm(paths.workspace, { recursive: true, force: true }));
  assert.equal(manager.firewallBusy.has('bo1'), true);
  const restarted = new ServerManager(manager.settingsPath, () => {});
  await restarted.initialize();
  assert.equal(restarted.firewallBusy.has('bo1'), true, 'unresolved elevation must survive app restart');
  await assert.rejects(restarted.start('bo1'), /firewall change is unresolved/);
  await assert.rejects(restarted.firewallApply('bo1'), /still unresolved/);
  assert.equal((await manager.firewallStatus('bo1')).state, 'missing');
  await assert.rejects(manager.start('bo1'), /firewall change/);
  await assert.rejects(manager.firewallRemove('bo1'), /still unresolved/);
  assert.equal(calls, 1);
  // The late operation may now have changed the firewall. Only its terminal
  // result, NOT the prior status read, allows another command.
  await fs.writeFile(paths.resultFile, JSON.stringify({ ok: true, message: '' }));
  manager.runElevated = async () => { calls++; };
  await manager.firewallApply('bo1');
  assert.equal(calls, 2);
  assert.equal(manager.firewallBusy.has('bo1'), false);
  assert.equal(manager.firewallUnresolved.size, 0);
  await assert.rejects(fs.access(manager.firewallJournal('bo1')), { code: 'ENOENT' });
});

test('corrupt durable firewall evidence fails closed instead of trusting current status', async t => {
  const { manager } = await fixture(t);
  await fs.writeFile(manager.firewallJournal('bo1'), '{malformed');
  await manager.initialize();
  await assert.rejects(manager.start('bo1'), /firewall change is unresolved/);
  await assert.rejects(manager.firewallRemove('bo1'), /still unresolved/);
});

test('query uses traced effective ActiveStore; GPO sources, missing provenance and duplicates fail closed', async t => {
  const { manager } = await fixture(t);
  let query;
  execImpl = (_file, args, _opts, callback) => {
    query = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    callback(null, { stdout: '[]', stderr: '' });
  };
  await manager.firewallQuery('botLANd BO1 UDP');
  assert.match(query, /Get-NetFirewallRule -PolicyStore ActiveStore -TracePolicyStore/);
  assert.match(query, /source = \[string\]\$rule.PolicyStoreSourceType/);
  assert.doesNotMatch(query, /PersistentStore/);
  const rule = { group: 'botLANd.ServerManager', description: 'Managed by botLANd Server Manager (UDP)', source: 'Local',
    enabled: 'True', direction: 'Inbound', action: 'Allow', profile: 'Any', protocol: 'UDP', localPort: ['28961'],
    remotePort: ['Any'], localAddress: ['Any'], remoteAddress: ['Any'], program: 'Any', service: 'Any' };
  for (const rules of [[{ ...rule, source: 'GroupPolicy' }], [{ ...rule, source: '' }], [rule, rule]]) {
    manager.firewallQuery = async () => rules;
    assert.equal((await manager.firewallStatus('bo1')).state, 'drift');
  }
  manager.firewallQuery = async () => [rule];
  assert.deepEqual(await manager.firewallStatus('bo1'), { name: 'botLANd BO1 UDP', port: 28961, state: 'any', managed: true });
});
