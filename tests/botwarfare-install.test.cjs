const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { zipSync } = require('fflate');
const { BotWarfareInstaller } = require('../electron/botwarfare-install.cjs');

const tempRoot = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp', 'opencode');
const cod4Root = 'Add to root of CoD4x server/mods/mp_bots/';
const mw2Root = 'Move files to root of MW2 folder/mods/mp_bots/';
const bo1Root = 'Move to root of Black Ops folder/mods/mp_bots/';
const callback = 'CodeCallback_PlayerConnect()\n{\n\tself endon( "disconnect" );\n\t[[level.callbackPlayerConnect]]();\n}\n';
const input = (id, version) => {
  const data = `release-${version}`;
  switch (id) {
    case 'cod4': return { [cod4Root + 'z_svr_bots.iwd']: data,
      [cod4Root + 'maps/mp/gametypes/_callbacksetup.gsx']: callback,
      [cod4Root + 'scriptdata/waypoints/mp_crash_wp.csv']: `waypoint-${version}`,
      [cod4Root + 'run.bat']: 'do not install' };
    case 'mw2': return { [mw2Root + 'z_svr_bots.iwd']: data,
      [mw2Root + 'scriptdata/waypoints/mp_rust_wp.csv']: `waypoint-${version}`,
      [mw2Root + 'server.cfg']: 'do not install' };
    case 'mw3': return { 'z_svr_bots.iwd': data, 'run.bat': 'do not install' };
    case 'waw': return { 'mp_bots/z_svr_bots.iwd': data };
    case 'bo1': return { [bo1Root + 'description.txt']: 'Bot Warfare',
      [bo1Root + 'mod.ff']: data, [bo1Root + 'mp_bots.iwd']: data };
    case 'bo2': return { 'snapshot/scripts/mp/bots.gsc': data,
      'snapshot/scripts/mp/bots_adapter_pt6.gsc': `adapter-${version}` };
    default: throw Error('invalid fixture');
  }
};
const hash = data => createHash('sha256').update(data).digest('hex');
const archive = files => Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name, body]) => [name, Buffer.from(body)]))));

async function fixture(t, id, overrides = {}) {
  await fs.mkdir(tempRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(tempRoot, 'bw-install-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const game = path.join(root, 'game');
  const localAppData = path.join(root, 'app-data');
  await fs.mkdir(game);
  await fs.mkdir(localAppData);
  let version = 'one';
  const downloaded = [];
  const downloadHashes = [];
  const source = { async resolveSource(gameId, channel) {
    assert.equal(gameId, id);
    return { supported: true, repo: `https://github.com/ineedbots/${id}_bot_warfare`,
      refType: 'tag', ref: `v-${version}`, assetUrl: `https://github.com/ineedbots/${id}_bot_warfare/releases/download/v-${version}/mod.zip`,
      channel, notes: '' };
  } };
  const download = async url => {
    downloaded.push(url);
    const bytes = archive(input(id, version));
    downloadHashes.push(hash(bytes));
    return { bytes, sha256: hash(bytes) };
  };
  const installer = new BotWarfareInstaller({ source, download, localAppData, ...overrides });
  return { game, localAppData, installer, downloaded, downloadHashes, setVersion: v => { version = v; } };
}
const read = file => fs.readFile(file, 'utf8');
const exists = async file => Boolean(await fs.stat(file).catch(() => null));

test('all six fixture ZIP recipes install to fixed paths and record verified provenance', async t => {
  const destinations = {
    cod4: 'game/mods/mp_bots', mw2: 'game/userraw', mw3: 'app-data/Plutonium/storage/iw5/mods/bots',
    waw: 'app-data/Plutonium/storage/t4/mods/mp_bots', bo1: 'app-data/Plutonium/storage/t5/mods/mp_bots',
    bo2: 'app-data/Plutonium/storage/t6/scripts/mp',
  };
  const expected = {
    cod4: ['z_svr_bots.iwd', 'maps/mp/gametypes/_callbacksetup.gsx', 'scriptdata/waypoints/mp_crash_wp.csv'],
    mw2: ['z_svr_bots.iwd', 'scriptdata/waypoints/mp_rust_wp.csv'],
    mw3: ['z_svr_bots.iwd'], waw: ['z_svr_bots.iwd'],
    bo1: ['description.txt', 'mod.ff', 'mp_bots.iwd'], bo2: ['bots.gsc', 'bots_adapter_pt6.gsc'],
  };
  for (const id of Object.keys(destinations)) {
    await t.test(id, async t => {
      const f = await fixture(t, id);
      assert.equal((await f.installer.status(id, f.game)).state, 'not-installed');
      const result = await f.installer.install(id, f.game);
      const base = path.resolve(path.dirname(f.game), ...destinations[id].split('/'));
      assert.equal(result.targetPath, base);
      const manifest = JSON.parse(await read(path.join(base, 'botland-install.json')));
      assert.equal(manifest.repo, `https://github.com/ineedbots/${id}_bot_warfare`);
      assert.equal(manifest.channel, 'stable');
      assert.equal(manifest.ref, 'v-one');
      assert.equal(manifest.sha256, f.downloadHashes[0]);
      assert.equal(manifest.files.length, expected[id].length);
      for (const file of manifest.files) {
        assert.ok(expected[id].includes(file.path));
        assert.equal(file.sha256, hash(await fs.readFile(path.join(base, ...file.path.split('/')))));
      }
      assert.equal((await f.installer.status(id, f.game)).state, 'installed');
      assert.equal(await exists(path.join(base, 'run.bat')), false);
      assert.equal(await exists(path.join(base, 'server.cfg')), false);
    });
  }
});

test('rejects invalid folders, Plutonium root, mismatched ZIP hash, unsupported source and symlinked targets', async t => {
  const f = await fixture(t, 'mw3');
  await assert.rejects(f.installer.install('mw3', 'relative'), /Absolute game/u);
  await assert.rejects(f.installer.install('mw3', path.join(f.game, 'missing')), /Existing game/u);
  const withoutRoot = new BotWarfareInstaller({ source: f.installer.source, download: f.installer.download });
  await assert.rejects(withoutRoot.install('mw3', f.game), /localAppData/u);
  const broken = new BotWarfareInstaller({ source: f.installer.source,
    download: async () => ({ bytes: archive(input('mw3', 'one')), sha256: '0'.repeat(64) }), localAppData: f.localAppData });
  await assert.rejects(broken.install('mw3', f.game), /SHA-256 mismatch/u);
  assert.equal(f.downloaded.length, 0);
  f.installer.source.resolveSource = async () => ({ supported: false });
  await assert.rejects(f.installer.install('mw3', f.game), /not supported/u);

  const other = await fixture(t, 'cod4');
  const outside = path.join(path.dirname(other.game), 'outside');
  await fs.mkdir(outside);
  await fs.mkdir(path.join(other.game, 'mods'));
  try { await fs.symlink(outside, path.join(other.game, 'mods', 'mp_bots'), 'junction'); }
  catch (error) { if (error.code === 'EPERM') return; throw error; }
  await assert.rejects(other.installer.install('cod4', other.game), /symlink|junction/u);
  assert.deepEqual(await fs.readdir(outside), []);
});

// Version history is gone: the installer keeps no copy of what it replaces.
const historyFolders = async parent => (await fs.readdir(parent)).filter(name => name.startsWith('.botland-versions-'));

test('an update overwrites every managed file, edited ones included, and keeps unrelated files', async t => {
  const f = await fixture(t, 'cod4');
  await f.installer.install('cod4', f.game);
  const base = path.join(f.game, 'mods', 'mp_bots');
  const mod = path.join(base, 'z_svr_bots.iwd');
  const wp = path.join(base, 'scriptdata', 'waypoints', 'mp_crash_wp.csv');
  const userFile = path.join(base, 'server.cfg');
  const log = path.join(base, 'logs', 'console.log');
  await fs.mkdir(path.dirname(log));
  await fs.writeFile(log, 'keep log');
  await fs.writeFile(userFile, 'keep cfg');
  await fs.writeFile(wp, 'custom waypoint');
  await fs.writeFile(mod, 'hand-edited mod');
  f.setVersion('two');
  await f.installer.install('cod4', f.game);
  assert.equal(await read(mod), 'release-two');
  assert.equal(await read(wp), 'waypoint-two');
  assert.equal(await read(userFile), 'keep cfg');
  assert.equal(await read(log), 'keep log');
  const status = await f.installer.status('cod4', f.game);
  assert.equal(status.manifest.ref, 'v-two');
  assert.equal(Object.hasOwn(status, 'versions'), false);
  for (const file of status.manifest.files) assert.equal(file.sha256, hash(await fs.readFile(path.join(base, ...file.path.split('/')))));
  assert.deepEqual(await historyFolders(path.join(f.game, 'mods')), []);
  assert.equal(typeof f.installer.restore, 'undefined');
  assert.equal(typeof f.installer.listVersions, 'undefined');
});

test('Remove deletes unchanged managed files but still leaves a file you edited', async t => {
  const f = await fixture(t, 'cod4');
  await f.installer.install('cod4', f.game);
  const base = path.join(f.game, 'mods', 'mp_bots');
  const wp = path.join(base, 'scriptdata', 'waypoints', 'mp_crash_wp.csv');
  const userFile = path.join(base, 'server.cfg');
  await fs.writeFile(userFile, 'keep cfg');
  await fs.writeFile(wp, 'custom waypoint');
  await f.installer.remove('cod4', f.game);
  assert.equal(await exists(path.join(base, 'z_svr_bots.iwd')), false);
  assert.equal(await exists(path.join(base, 'botland-install.json')), false);
  assert.equal(await read(wp), 'custom waypoint');
  assert.equal(await read(userFile), 'keep cfg');
  assert.equal((await f.installer.status('cod4', f.game)).state, 'not-installed');
});

test('an update deletes a managed file the new release no longer ships, even if it was edited', async t => {
  const f = await fixture(t, 'cod4');
  await f.installer.install('cod4', f.game);
  const base = path.join(f.game, 'mods', 'mp_bots');
  // An earlier release shipped this waypoint; the user has since edited it.
  const stale = path.join(base, 'scriptdata', 'waypoints', 'mp_old_wp.csv');
  await fs.writeFile(stale, 'edited stale waypoint');
  const manifestFile = path.join(base, 'botland-install.json');
  const manifest = JSON.parse(await read(manifestFile));
  manifest.files.push({ path: 'scriptdata/waypoints/mp_old_wp.csv', sha256: hash('what the release shipped') });
  await fs.writeFile(manifestFile, JSON.stringify(manifest));
  f.setVersion('two');
  await f.installer.install('cod4', f.game);
  assert.equal(await exists(stale), false);
  assert.equal(await read(path.join(base, 'z_svr_bots.iwd')), 'release-two');
  const files = (await f.installer.status('cod4', f.game)).manifest.files.map(file => file.path);
  assert.equal(files.includes('scriptdata/waypoints/mp_old_wp.csv'), false);
});

test('explicit install overwrites a pre-existing unmanaged mod with the latest version and keeps other files', async t => {
  const f = await fixture(t, 'mw3');
  const base = path.join(f.localAppData, 'Plutonium', 'storage', 'iw5', 'mods', 'bots');
  await fs.mkdir(base, { recursive: true });
  await fs.writeFile(path.join(base, 'z_svr_bots.iwd'), 'original user mod');
  await fs.writeFile(path.join(base, 'notes.txt'), 'user notes');
  assert.equal((await f.installer.status('mw3', f.game)).state, 'unknown');
  await assert.rejects(f.installer.remove('mw3', f.game), /Unknown/u);
  await f.installer.install('mw3', f.game);
  assert.equal(await read(path.join(base, 'z_svr_bots.iwd')), 'release-one');
  assert.equal(await read(path.join(base, 'notes.txt')), 'user notes');
  assert.equal((await f.installer.status('mw3', f.game)).state, 'installed');
  assert.deepEqual(await historyFolders(path.dirname(base)), [], 'the replaced mod is not kept');
});

test('a pre-existing waypoint is overwritten by install and managed from then on', async t => {
  const f = await fixture(t, 'mw2');
  const waypoint = path.join(f.game, 'userraw', 'scriptdata', 'waypoints', 'mp_rust_wp.csv');
  await fs.mkdir(path.dirname(waypoint), { recursive: true });
  await fs.writeFile(waypoint, 'my waypoint');
  await f.installer.install('mw2', f.game);
  assert.equal(await read(waypoint), 'waypoint-one');
  assert.equal((await f.installer.status('mw2', f.game)).manifest.files.some(file => file.path.includes('waypoints')), true);
  f.setVersion('two');
  await f.installer.install('mw2', f.game);
  assert.equal(await read(waypoint), 'waypoint-two');
  await f.installer.remove('mw2', f.game);
  assert.equal(await exists(waypoint), false);
});

test('fault after a partial update rolls every written file and manifest back byte-for-byte', async t => {
  let fail = false;
  const f = await fixture(t, 'bo1', { fault(count) { if (fail && count === 2) throw Error('injected failure'); } });
  await f.installer.install('bo1', f.game);
  const base = path.join(f.localAppData, 'Plutonium', 'storage', 't5', 'mods', 'mp_bots');
  const names = ['description.txt', 'mod.ff', 'mp_bots.iwd', 'botland-install.json'];
  const before = await Promise.all(names.map(name => fs.readFile(path.join(base, name))));
  f.setVersion('two');
  fail = true;
  await assert.rejects(f.installer.install('bo1', f.game), /injected failure/u);
  for (let i = 0; i < names.length; i++) assert.deepEqual(await fs.readFile(path.join(base, names[i])), before[i]);
  assert.deepEqual(await historyFolders(path.dirname(base)), []);
});

const interrupted = count => { if (count === 2) throw Object.assign(new Error('simulated process death'), { simulateCrash: true }); };
const stages = async (parent, id) => (await fs.readdir(parent)).filter(name => name.startsWith(`.botland-stage-${id}-`));

test('a fresh process recovers interrupted creation before status and a subsequent install', async t => {
  const f = await fixture(t, 'cod4', { fault: interrupted });
  const base = path.join(f.game, 'mods', 'mp_bots');
  const keep = path.join(base, 'notes.txt');
  await fs.mkdir(base, { recursive: true });
  await fs.writeFile(keep, 'user data');
  await assert.rejects(f.installer.install('cod4', f.game), /simulated process death/u);
  assert.equal((await stages(path.dirname(base), 'cod4')).length, 1);
  const fresh = new BotWarfareInstaller({ source: f.installer.source, download: f.installer.download,
    localAppData: f.localAppData });
  assert.equal((await fresh.status('cod4', f.game)).state, 'not-installed');
  assert.equal(await read(keep), 'user data');
  assert.equal(await exists(path.join(base, 'z_svr_bots.iwd')), false);
  assert.equal(await exists(path.join(base, 'maps/mp/gametypes/_callbacksetup.gsx')), false);
  assert.deepEqual(await stages(path.dirname(base), 'cod4'), []);
  await fresh.install('cod4', f.game);
  assert.equal((await fresh.status('cod4', f.game)).state, 'installed');
});

test('an interrupted update or remove is rolled back to the original files before the next action', async t => {
  let crash = false;
  const f = await fixture(t, 'bo2', { fault(count) { if (crash) interrupted(count); } });
  await f.installer.install('bo2', f.game);
  const base = path.join(f.localAppData, 'Plutonium', 'storage', 't6', 'scripts', 'mp');
  const names = ['bots.gsc', 'bots_adapter_pt6.gsc', 'botland-install.json'];
  const original = await Promise.all(names.map(name => fs.readFile(path.join(base, name))));
  const intact = async () => { for (let i = 0; i < names.length; i++) assert.deepEqual(await fs.readFile(path.join(base, names[i])), original[i]); };
  f.setVersion('two'); crash = true;
  await assert.rejects(f.installer.install('bo2', f.game), /simulated process death/u);
  const fresh = new BotWarfareInstaller({ source: f.installer.source, download: f.installer.download,
    localAppData: f.localAppData });
  // A fresh process finishes the rollback before it reads anything.
  const recovered = await fresh.status('bo2', f.game);
  assert.equal(recovered.state, 'installed');
  assert.equal(recovered.manifest.ref, 'v-one');
  await intact();
  crash = false;
  const removeCrash = new BotWarfareInstaller({ source: f.installer.source, download: f.installer.download,
    localAppData: f.localAppData, fault: interrupted });
  await assert.rejects(removeCrash.remove('bo2', f.game), /simulated process death/u);
  assert.equal((await fresh.status('bo2', f.game)).state, 'installed');
  await intact();
  await fresh.remove('bo2', f.game);
  assert.equal((await fresh.status('bo2', f.game)).state, 'not-installed');
  assert.deepEqual(await historyFolders(path.dirname(base)), []);
});

test('a journal written by an earlier release (with a snapshot) still rolls back and is cleaned up', async t => {
  let crash = false;
  const f = await fixture(t, 'bo1', { fault(count) { if (crash) interrupted(count); } });
  await f.installer.install('bo1', f.game);
  const base = path.join(f.localAppData, 'Plutonium', 'storage', 't5', 'mods', 'mp_bots');
  const parent = path.dirname(base);
  const before = await fs.readFile(path.join(base, 'mod.ff'));
  f.setVersion('two'); crash = true;
  await assert.rejects(f.installer.install('bo1', f.game), /simulated process death/u);
  const stage = path.join(parent, (await stages(parent, 'bo1'))[0]);
  // Earlier releases journaled a snapshot of the replaced files next to the stage.
  const snapshotDir = path.join(stage, 'version');
  await fs.mkdir(snapshotDir);
  await fs.writeFile(path.join(snapshotDir, 'version.json'), '{"legacy":true}');
  const journalFile = path.join(stage, 'transaction.json');
  const journal = JSON.parse(await read(journalFile));
  journal.snapshot = { versionId: '11111111-1111-4111-8111-111111111111', sha256: hash('{"legacy":true}') };
  await fs.writeFile(journalFile, JSON.stringify(journal));
  const fresh = new BotWarfareInstaller({ source: f.installer.source, download: f.installer.download,
    localAppData: f.localAppData });
  assert.equal((await fresh.status('bo1', f.game)).manifest.ref, 'v-one');
  assert.deepEqual(await fs.readFile(path.join(base, 'mod.ff')), before);
  assert.deepEqual(await stages(parent, 'bo1'), []);
  assert.deepEqual(await historyFolders(parent), []);
});

test('recovery preserves conflicting user edits and retains journal until conflict is fixed', async t => {
  let crash = false;
  const f = await fixture(t, 'bo1', { fault(count) { if (crash) interrupted(count); } });
  await f.installer.install('bo1', f.game);
  f.setVersion('two'); crash = true;
  await assert.rejects(f.installer.install('bo1', f.game), /simulated process death/u);
  const base = path.join(f.localAppData, 'Plutonium', 'storage', 't5', 'mods', 'mp_bots');
  const parent = path.dirname(base);
  const target = path.join(base, 'mod.ff');
  await fs.writeFile(target, 'my edits');
  const fresh = new BotWarfareInstaller({ source: f.installer.source, download: f.installer.download,
    localAppData: f.localAppData });
  await assert.rejects(fresh.status('bo1', f.game), /recovery conflict/u);
  await assert.rejects(fresh.install('bo1', f.game), /recovery conflict/u);
  assert.equal(await read(target), 'my edits');
  assert.equal(await read(path.join(base, 'mp_bots.iwd')), 'release-two');
  assert.equal((await stages(parent, 'bo1')).length, 1);
  await fs.writeFile(target, 'release-two');
  assert.equal((await fresh.status('bo1', f.game)).manifest.ref, 'v-one');
  assert.equal(await read(path.join(base, 'mod.ff')), 'release-one');
  assert.deepEqual(await stages(parent, 'bo1'), []);
});

test('corrupt journal or backup fails closed and is never silently deleted', async t => {
  const f = await fixture(t, 'bo1', { fault: interrupted });
  await assert.rejects(f.installer.install('bo1', f.game), /simulated process death/u);
  const base = path.join(f.localAppData, 'Plutonium', 'storage', 't5', 'mods', 'mp_bots');
  const parent = path.dirname(base);
  const stage = path.join(parent, (await stages(parent, 'bo1'))[0]);
  const first = await fs.readFile(path.join(base, 'description.txt'));
  await fs.writeFile(path.join(stage, 'after-0'), 'corrupt');
  await assert.rejects(f.installer.status('bo1', f.game), /transaction journal/u);
  assert.deepEqual(await fs.readFile(path.join(base, 'description.txt')), first);
  assert.equal((await stages(parent, 'bo1')).length, 1);
  await fs.writeFile(path.join(stage, 'transaction.json'), '{broken');
  await assert.rejects(f.installer.remove('bo1', f.game), /transaction journal/u);
  assert.equal((await stages(parent, 'bo1')).length, 1);
});

test('recovery refuses a junction in a managed path and leaves unrelated targets alone', async t => {
  const f = await fixture(t, 'cod4', { fault: interrupted });
  await assert.rejects(f.installer.install('cod4', f.game), /simulated process death/u);
  const base = path.join(f.game, 'mods', 'mp_bots');
  const outside = path.join(path.dirname(f.game), 'outside');
  await fs.mkdir(outside);
  const mapDir = path.join(base, 'maps');
  await fs.rm(mapDir, { recursive: true });
  try { await fs.symlink(outside, mapDir, 'junction'); }
  catch (error) { if (error.code === 'EPERM') return; throw error; }
  await assert.rejects(f.installer.status('cod4', f.game), /symlink|junction/u);
  assert.deepEqual(await fs.readdir(outside), []);
  assert.equal((await stages(path.dirname(base), 'cod4')).length, 1);
  await fs.rm(mapDir);
  // The missing file was created by the interrupted install, so rolling back
  // leaves it absent without touching the outside directory.
  assert.equal((await f.installer.status('cod4', f.game)).state, 'not-installed');
  assert.deepEqual(await fs.readdir(outside), []);
});

test('cleanup interrupted after recovery is safe to resume', async t => {
  const f = await fixture(t, 'mw3');
  const base = path.join(f.localAppData, 'Plutonium', 'storage', 'iw5', 'mods', 'bots');
  await fs.mkdir(path.dirname(base), { recursive: true });
  const done = path.join(path.dirname(base), '.botland-done-mw3-ABC123');
  await fs.mkdir(done);
  await fs.writeFile(path.join(done, 'leftover'), 'already resolved');
  assert.equal((await f.installer.status('mw3', f.game)).state, 'not-installed');
  assert.equal(await exists(done), false);
});

test('a durable commit marker finalizes the update rather than undoing a complete publish', async t => {
  let crash = false;
  const f = await fixture(t, 'bo1', { fault(count, name) {
    if (crash && name === 'botland-install.json') throw Object.assign(new Error('simulated process death'), { simulateCrash: true });
  } });
  await f.installer.install('bo1', f.game);
  f.setVersion('two'); crash = true;
  await assert.rejects(f.installer.install('bo1', f.game), /simulated process death/u);
  const base = path.join(f.localAppData, 'Plutonium', 'storage', 't5', 'mods', 'mp_bots');
  const stage = path.join(path.dirname(base), (await stages(path.dirname(base), 'bo1'))[0]);
  await fs.writeFile(path.join(stage, 'committed'), hash(await fs.readFile(path.join(stage, 'transaction.json'))));
  const fresh = new BotWarfareInstaller({ source: f.installer.source, download: f.installer.download,
    localAppData: f.localAppData });
  const status = await fresh.status('bo1', f.game);
  assert.equal(status.manifest.ref, 'v-two');
  assert.equal(await read(path.join(base, 'mod.ff')), 'release-two');
  assert.deepEqual(await stages(path.dirname(base), 'bo1'), []);
  assert.deepEqual(await historyFolders(path.dirname(base)), []);
});

test('refuse running/starting and serialize same-game operations', async t => {
  let running = false;
  let pendingRelease;
  let entered;
  const gate = new Promise(resolve => { pendingRelease = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, 'bo2', { isRunning: () => running });
  const downloader = f.installer.download;
  let first = true;
  f.installer.download = async url => {
    const result = await downloader(url);
    if (first) { first = false; entered(); await gate; }
    return result;
  };
  const initial = f.installer.install('bo2', f.game);
  await started;
  f.setVersion('two');
  const second = f.installer.install('bo2', f.game);
  pendingRelease();
  await Promise.all([initial, second]);
  const base = path.join(f.localAppData, 'Plutonium', 'storage', 't6', 'scripts', 'mp');
  assert.equal(await read(path.join(base, 'bots.gsc')), 'release-two');
  running = 'starting';
  await assert.rejects(f.installer.remove('bo2', f.game), /Stop the starting or running/u);
  await assert.rejects(f.installer.install('bo2', f.game), /Stop the starting or running/u);
  running = true;
  await assert.rejects(f.installer.install('bo2', f.game), /Stop the starting or running/u);
  assert.equal(await read(path.join(base, 'bots.gsc')), 'release-two', 'a refused action changes nothing');
  running = false;
  f.setVersion('three');
  await f.installer.install('bo2', f.game);
  assert.equal(await read(path.join(base, 'bots.gsc')), 'release-three');
  assert.deepEqual(await historyFolders(path.dirname(base)), []);
});

test('an invalid manifest cannot claim arbitrary user config', async t => {
  const f = await fixture(t, 'mw2');
  await f.installer.install('mw2', f.game);
  const base = path.join(f.game, 'userraw');
  const manifestFile = path.join(base, 'botland-install.json');
  const manifest = JSON.parse(await read(manifestFile));
  manifest.files.push({ path: 'server.cfg', sha256: hash('private config') });
  await fs.writeFile(manifestFile, JSON.stringify(manifest));
  await assert.rejects(f.installer.remove('mw2', f.game), /Invalid Bot Warfare manifest/u);
  assert.equal(await read(path.join(base, 'z_svr_bots.iwd')), 'release-one');
  manifest.files.pop();
  await fs.writeFile(manifestFile, JSON.stringify(manifest));
  f.setVersion('two');
  await f.installer.install('mw2', f.game);
  assert.equal(await read(path.join(base, 'z_svr_bots.iwd')), 'release-two');
  assert.equal((await f.installer.status('mw2', f.game)).manifest.ref, 'v-two');
});

test('an abandoned stage without a journal is discarded instead of blocking every action', async t => {
  const f = await fixture(t, 'cod4');
  await f.installer.install('cod4', f.game);
  const parent = path.join(f.game, 'mods');
  const stage = path.join(parent, '.botland-stage-cod4-abc123');
  await fs.mkdir(path.join(stage, 'version'), { recursive: true });
  await fs.writeFile(path.join(stage, 'before-0'), 'partial');
  assert.equal((await f.installer.status('cod4', f.game)).state, 'installed');
  assert.equal(await exists(stage), false);
  // A stage holding anything unexpected still fails closed and names its folder.
  await fs.mkdir(stage);
  await fs.writeFile(path.join(stage, 'unexpected.txt'), 'keep');
  await assert.rejects(f.installer.status('cod4', f.game), error => /transaction journal/u.test(error.message) && error.message.includes(stage));
  assert.equal(await exists(path.join(stage, 'unexpected.txt')), true);
});

test('version history left by earlier releases is deleted, whatever it contains, and never blocks an action', async t => {
  const f = await fixture(t, 'cod4');
  await f.installer.install('cod4', f.game);
  const mods = path.join(f.game, 'mods');
  const base = path.join(mods, 'mp_bots');
  const history = path.join(mods, '.botland-versions-cod4-mp_bots');
  const snapshot = path.join(history, '11111111-1111-4111-8111-111111111111');
  await fs.mkdir(snapshot, { recursive: true });
  await fs.writeFile(path.join(snapshot, 'version.json'), '{"old":true}');
  await fs.writeFile(path.join(snapshot, 'z_svr_bots.iwd'), 'an older release');
  await fs.writeFile(path.join(history, 'desktop.ini'), '[.ShellClassInfo]');
  await fs.mkdir(path.join(history, '00000000-0000-4000-8000-000000000000'));
  // Other games' history lives under a different name and is not this installer's to touch.
  const foreign = path.join(mods, '.botland-versions-mw2-userraw');
  await fs.mkdir(foreign);
  await fs.writeFile(path.join(base, 'server.cfg'), 'keep cfg');

  const status = await f.installer.status('cod4', f.game);
  assert.equal(status.state, 'installed');
  assert.equal(await exists(history), false);
  assert.equal(await exists(foreign), true);
  assert.deepEqual((await fs.readdir(mods)).filter(name => name.startsWith('.botland-done-')), []);
  assert.equal(await read(path.join(base, 'server.cfg')), 'keep cfg');
  assert.equal(await read(path.join(base, 'z_svr_bots.iwd')), 'release-one');
});

test('pre-launch recovery fails closed on unsafe paths and invalid journals, but ignores absent unmanaged storage', async t => {
  const f = await fixture(t, 'mw3');
  const parent = path.join(f.localAppData, 'Plutonium', 'storage', 'iw5', 'mods');
  const stage = path.join(parent, '.botland-stage-mw3-abc123');
  await fs.mkdir(stage, { recursive: true });
  await fs.writeFile(path.join(stage, 'transaction.json'), '{invalid');
  await assert.rejects(f.installer.prepareLaunch('mw3', f.game), /transaction journal/);
  assert.equal(await exists(stage), true);
  await fs.rm(stage, { recursive: true });
  const target = path.join(parent, 'bots');
  await fs.symlink(f.game, target, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.installer.prepareLaunch('mw3', f.game), /symlink or junction/);
  await fs.rm(target);
  const absent = path.join(f.localAppData, 'absent');
  const unmanaged = new BotWarfareInstaller({ source: f.installer.source, localAppData: absent });
  await unmanaged.prepareLaunch('mw3', f.game);
  await assert.rejects(f.installer.prepareLaunch('mw3', path.join(f.game, 'missing')), /Existing game folder required/);
});

test('legacy history is also removed by install and by the pre-launch recovery', async t => {
  const f = await fixture(t, 'mw3');
  const parent = path.join(f.localAppData, 'Plutonium', 'storage', 'iw5', 'mods');
  const history = path.join(parent, '.botland-versions-mw3-bots');
  await fs.mkdir(path.join(history, '22222222-2222-4222-8222-222222222222'), { recursive: true });
  await f.installer.prepareLaunch('mw3', f.game);
  assert.equal(await exists(history), false);
  await fs.mkdir(path.join(history, '33333333-3333-4333-8333-333333333333'), { recursive: true });
  await f.installer.install('mw3', f.game);
  assert.equal(await exists(history), false);
  assert.equal((await f.installer.status('mw3', f.game)).state, 'installed');
});
