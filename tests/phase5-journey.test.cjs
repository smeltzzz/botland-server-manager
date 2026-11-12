const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const { zipSync } = require('fflate');
const { profiles, order, bootstrapPath } = require('../electron/profiles.cjs');
const { BotWarfareInstaller } = require('../electron/botwarfare-install.cjs');

// Capture the manager's import, not the test runner's child_process module. Every
// spawn/execFile here is synthetic; an unexpected command fails rather than runs.
const managerModule = require.resolve('../electron/manager.cjs');
const originalLoad = Module._load;
let spawnMock = () => { throw new Error('Unexpected game spawn'); };
let execMock = () => { throw new Error('Unexpected external command'); };
let ServerManager;
try {
  Module._load = function (request, parent, isMain) {
    if (request === 'node:child_process' && parent?.filename === managerModule) {
      return { spawn: (...args) => spawnMock(...args), execFile: (...args) => execMock(...args) };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  ({ ServerManager } = require('../electron/manager.cjs'));
} finally {
  Module._load = originalLoad;
}

const multiplayer = {
  cod4: 'iw3mp.exe', waw: 'CoDWaWmp.exe', mw2: 'iw4mp.exe',
  bo1: 'BlackOpsMP.exe', mw3: 'iw5mp.exe', bo2: 't6mp.exe',
};
const maps = ['mp_alpha', 'mp_bravo'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const archive = files => Buffer.from(zipSync(Object.fromEntries(
  Object.entries(files).map(([name, contents]) => [name, Buffer.from(contents)]))));
const callback = 'CodeCallback_PlayerConnect()\n{\n\tself endon( "disconnect" );\n\t[[level.callbackPlayerConnect]]();\n}\n';
const zipFiles = {
  cod4: {
    'Add to root of CoD4x server/mods/mp_bots/z_svr_bots.iwd': 'synthetic IW3 archive',
    'Add to root of CoD4x server/mods/mp_bots/maps/mp/gametypes/_callbacksetup.gsx': callback,
    'Add to root of CoD4x server/mods/mp_bots/scriptdata/waypoints/mp_alpha_wp.csv': 'waypoint',
  },
  waw: { 'mp_bots/z_svr_bots.iwd': 'synthetic T4 archive' },
  mw2: {
    'Move files to root of MW2 folder/mods/mp_bots/z_svr_bots.iwd': 'synthetic IW4 archive',
    'Move files to root of MW2 folder/mods/mp_bots/scriptdata/waypoints/mp_alpha_wp.csv': 'waypoint',
  },
  bo1: {
    'Move to root of Black Ops folder/mods/mp_bots/description.txt': 'synthetic description',
    'Move to root of Black Ops folder/mods/mp_bots/mod.ff': 'synthetic fastfile',
    'Move to root of Black Ops folder/mods/mp_bots/mp_bots.iwd': 'synthetic T5 archive',
  },
  mw3: { 'z_svr_bots.iwd': 'synthetic IW5 archive' },
  bo2: {
    'snapshot/scripts/mp/bots.gsc': 'synthetic T6 script',
    'snapshot/scripts/mp/bots_adapter_pt6.gsc': 'synthetic T6 adapter',
  },
};
async function put(file, bytes = 'synthetic marker') {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes);
}
function fakePe(machine = 0x8664) {
  const bytes = Buffer.alloc(0x86);
  bytes.write('MZ');
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write('PE\0\0', 0x80);
  bytes.writeUInt16LE(machine, 0x84);
  return bytes;
}
function childFor(pid, onQuit) {
  const child = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdin = new EventEmitter();
  stdin.writable = true;
  stdin.write = text => { onQuit(text); queueMicrotask(() => child.finish()); return true; };
  Object.assign(child, { pid, stdout, stderr, stdin, exitCode: null, signalCode: null });
  child.finish = () => {
    if (child.exitCode !== null) return;
    child.exitCode = 0;
    stdout.emit('end');
    stderr.emit('end');
    child.emit('close', 0, null);
  };
  return child;
}
const game = (snapshot, id) => snapshot.games.find(item => item.id === id);
const missing = file => assert.rejects(fs.stat(file), { code: 'ENOENT' });

test('six synthetic installs: starter, ZIP mod, readiness, rotation, owned start/stop', async t => {
  const tempRoot = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp', 'opencode');
  await fs.mkdir(tempRoot, { recursive: true });
  const dir = await fs.mkdtemp(path.join(tempRoot, 'botland-phase5-journey-'));
  const oldLocal = process.env.LOCALAPPDATA;
  const local = path.join(dir, 'local-app-data');
  process.env.LOCALAPPDATA = local;
  const calls = { spawn: [], exec: [], download: [], quit: [] };
  const children = new Map();
  const readyKeys = new Set();
  // A placeholder tests the private-argument boundary, not a real server key.
  const placeholder = 'synthetic-placeholder';
  try {
    await fs.mkdir(local);
    const paths = Object.fromEntries(order.map(id => [id, path.join(dir, 'installs', id)]));
    for (const id of order) {
      const root = paths[id];
      await put(path.join(root, multiplayer[id]));
      if (id === 'cod4' || id === 'mw2') await put(path.join(root, profiles[id].executable));
      if (id === 'mw3') {
        await put(path.join(root, 'iw5mp.exe'), fakePe());
        await put(path.join(root, 'mss32.dll'));
        await put(path.join(root, 'admin', 'DOM_default.dsr'), 'gameOpt commonOption.timeLimit "0.0000"\n');
      }
      if (id === 'bo2') await put(path.join(root, 'main', 'gamesettings', 'dom.cfg'), 'set_gametype dom\n');
      const zone = ['zone', 'english'];
      for (const name of maps) {
        await put(path.join(root, ...zone, `${name}.ff`));
        if (['cod4', 'waw', 'mw2', 'mw3'].includes(id)) await put(path.join(root, ...zone, `${name}_load.ff`));
      }
    }
    await put(bootstrapPath());

    const archives = Object.fromEntries(order.map(id => [id, archive(zipFiles[id])]));
    const source = { async resolveSource(id, channel) {
      assert.ok(order.includes(id));
      assert.equal(channel, 'stable');
      return { supported: true, repo: `https://github.com/ineedbots/${id}_bot_warfare`,
        refType: 'tag', ref: 'v-fixture', assetUrl: `https://example.invalid/${id}.zip`, status: 'fixture' };
    } };
    const download = async url => {
      const id = new URL(url).pathname.slice(1, -4);
      assert.ok(order.includes(id));
      assert.equal(url, `https://example.invalid/${id}.zip`);
      calls.download.push(id);
      return { bytes: archives[id], sha256: sha256(archives[id]) };
    };
    let manager;
    const installer = new BotWarfareInstaller({ source, download, localAppData: local,
      isRunning: id => manager.instances.get(id)?.status });
    const events = [];
    manager = new ServerManager(path.join(dir, 'settings.json'), event => events.push(event), {
        modInstaller: installer, modSource: source,
        keyStore: {
          has: async id => readyKeys.has(id),
          get: async id => readyKeys.has(id) ? placeholder : null,
        },
        detectInstallations: async () => { throw new Error('Steam detection must not run'); },
        findPossibleOrphans: async () => { throw new Error('No external process scan'); },
        createLogTail: () => ({ async start() {}, async stop() {} }),
      });
    manager.data.updatesEnabled = false; // Do not perform background metadata checks.
    for (const id of order) manager.data.games[id] = { gamePath: paths[id], shuffle: false };

    for (const id of order) {
      const config = path.join(paths[id], profiles[id].config);
      const rotation = path.join(paths[id], profiles[id].rotation);
      assert.ok((await manager.check(id)).blockers.some(line => line.startsWith('Server config missing')));
      assert.equal(await manager.createStarterConfig(id), config);
      await missing(rotation);
      await assert.rejects(manager.createStarterConfig(id), { code: 'EEXIST' });
      if (id === 'mw3' || id === 'bo2') {
        assert.match(await fs.readFile(config, 'utf8'), new RegExp(`^exec ${path.basename(rotation).replace('.', '\\.')}\\r?$`, 'm'));
      }
      await manager.botAction(id, 'install');
      assert.equal((await manager.botStatus(id)).state, 'installed');
      await missing(rotation);
      if (profiles[id].executable === 'plutonium') readyKeys.add(id);
      await manager.saveOptions(id, { selectedMaps: maps, shuffle: false });
    }
    assert.deepEqual(calls.download, order);
    const patched = await fs.readFile(path.join(paths.cod4, 'mods', 'mp_bots', 'maps', 'mp', 'gametypes', '_callbacksetup.gsx'), 'utf8');
    assert.match(patched, /self\.clientid = level\.clientid/);
    assert.ok((await manager.botStatus('cod4')).manifest.patches.includes('Cod4R clientid initialization'));

    // Negative title-specific checks in the same fixture, then restore readiness.
    manager.data.games.bo2.selectedMaps = [maps[0]];
    assert.match((await manager.check('bo2')).blockers.join(' '), /at least two selected maps/);
    await missing(path.join(paths.bo2, profiles.bo2.rotation));
    await assert.rejects(manager.start('bo2'), /at least two selected maps/);
    manager.data.games.bo2.selectedMaps = maps;
    await fs.rm(path.join(paths.bo2, 'zone', 'english', `${maps[1]}.ff`));
    assert.match((await manager.check('bo2')).blockers.join(' '), /at least two installed multiplayer maps/);
    await put(path.join(paths.bo2, 'zone', 'english', `${maps[1]}.ff`));
    await fs.rm(path.join(paths.mw3, 'mss32.dll'));
    assert.match((await manager.check('mw3')).blockers.join(' '), /mss32\.dll/);
    await put(path.join(paths.mw3, 'mss32.dll'));
    await fs.rm(path.join(paths.mw3, 'admin', 'DOM_default.dsr'));
    assert.match((await manager.check('mw3')).blockers.join(' '), /DOM_default\.dsr/);
    await put(path.join(paths.mw3, 'admin', 'DOM_default.dsr'), 'gameOpt commonOption.timeLimit "0.0000"\n');
    await manager.saveOptions('bo1', { lan: true });
    assert.equal(manager.options('bo1').lan, false); // BO1 cannot be made private by launch options.
    assert.match((await manager.check('bo1')).warnings.join(' '), /no -lan launch flag/);
    for (const id of order) {
      const check = await manager.check(id);
      assert.equal(check.installed, true);
      assert.deepEqual(check.blockers, [], `${id} synthetic preflight`);
      assert.equal(check.keyStatus, profiles[id].executable === 'plutonium' ? 'stored' : 'not-required');
    }
    const before = await manager.snapshot();
    assert.equal(JSON.stringify(before).includes(placeholder), false);
    assert.equal(before.games.every(item => item.blockers.length === 0), true);
    // BO1 cannot rely on a -lan argument: even otherwise-ready fixtures need
    // an owned local-subnet rule before its public-bound process may spawn.
    for (const firewall of [{ state: 'missing' }, { state: 'unknown' }, { state: 'any', managed: true },
      { state: 'lan', legacy: true }, { state: 'lan' }]) {
      manager.firewallStatus = async () => firewall;
      await assert.rejects(manager.start('bo1'), /verified botLANd LAN-only firewall rule/);
    }
    manager.firewallStatus = async () => ({ state: 'lan', managed: true });

    spawnMock = (file, args, options) => {
      const id = order.find(name => file === (profiles[name].executable === 'plutonium'
        ? bootstrapPath() : path.join(paths[name], profiles[name].executable)) &&
        (profiles[name].executable !== 'plutonium' || args[1] === paths[name]));
      assert.ok(id, 'Only fixture engine paths may spawn');
      assert.equal(options.cwd, profiles[id].executable === 'plutonium' ? path.join(local, 'Plutonium') : paths[id]);
      assert.equal(options.shell, false);
      const child = childFor(6000 + order.indexOf(id), text => calls.quit.push({ id, text }));
      calls.spawn.push({ id, file, args, options });
      children.set(id, child);
      queueMicrotask(() => child.emit('spawn'));
      return child;
    };
    execMock = (file, args, _options, callback) => {
      assert.ok(['netstat.exe', 'taskkill.exe'].includes(file), 'No external commands beyond mocked port check and owned stop');
      calls.exec.push({ file, args });
      if (file === 'netstat.exe') return queueMicrotask(() => callback(null, '', ''));
      const child = [...children.values()].find(item => String(item.pid) === args[1]);
      assert.ok(child, 'taskkill must target an owned fixture PID');
      assert.deepEqual(args, ['/PID', String(child.pid), '/T', '/F']);
      queueMicrotask(() => { child.finish(); callback(null, '', ''); });
    };

    for (const id of order) {
      await manager.start(id);
      const child = children.get(id);
      assert.equal(game(await manager.snapshot(), id).status, 'running');
      const command = calls.spawn.at(-1);
      assert.equal(command.id, id);
      const args = command.args;
      if (profiles[id].executable === 'plutonium') {
        assert.equal(args[args.indexOf('key') + 1], placeholder);
        assert.equal(args.includes('-lan'), id !== 'bo1');
      }
      if (id === 'cod4') {
        assert.ok(args.includes('-nogui'));
        assert.ok(args.includes('botserver.cfg') && args.includes('botserver_rotation.cfg'));
        assert.ok(args.includes('mods/mp_bots'));
      }
      if (id === 'mw2') assert.ok(args.includes('serverlan.cfg') && args.includes('serverlan_rotation.cfg'));
      if (id === 'mw3') assert.ok(args.includes('+start_map_rotate') && args.includes('server.cfg'));
      if (id === 'bo2') assert.ok(args.includes('dedicated.cfg') && !args.includes('rotation_dom_shuffled.cfg'));
      if (id === 'bo1') assert.ok(args.includes('0.0.0.0') && !args.includes('-lan'));
      const text = await fs.readFile(path.join(paths[id], profiles[id].rotation), 'utf8');
      assert.ok(text.indexOf(`map ${maps[0]}`) >= 0 &&
        text.indexOf(`map ${maps[0]}`) < text.indexOf(`map ${maps[1]}`), `${id} rotation has both selected maps in order`);
      assert.match(text, id === 'mw3' ? /dsr DOM_default map mp_alpha map mp_bravo/
        : id === 'bo2' ? /execgts dom\.cfg map mp_alpha map mp_bravo/
          : id === 'mw2' ? /set sv_maprotation "map mp_alpha map mp_bravo"/
            : /gametype dom map mp_alpha gametype dom map mp_bravo/);
      if (id === 'waw' || id === 'bo1') assert.ok(args.includes(path.basename(profiles[id].rotation)));
      if (profiles[id].executable === 'plutonium') child.stdout.emit('data', Buffer.from(`+set key ${placeholder}\n`));
      await manager.stop(id);
      assert.equal(game(await manager.snapshot(), id).status, 'stopped');
      assert.equal(child.exitCode, 0);
      assert.equal(manager.instances.has(id), false);
    }
    assert.deepEqual(calls.quit, [{ id: 'cod4', text: 'quit\n' }]);
    assert.deepEqual(calls.exec.filter(call => call.file === 'taskkill.exe').map(call => call.args[1]),
      order.filter(id => id !== 'cod4').map(id => String(children.get(id).pid)));
    assert.equal(calls.exec.filter(call => call.file === 'netstat.exe').length, order.length * 2);
    assert.equal(JSON.stringify(events).includes(placeholder), false);
    assert.equal(JSON.stringify(await manager.snapshot()).includes(placeholder), false);
    assert.equal(manager.hasRunning(), false);
  } finally {
    spawnMock = () => { throw new Error('Unexpected game spawn'); };
    execMock = () => { throw new Error('Unexpected external command'); };
    if (oldLocal === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = oldLocal;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
