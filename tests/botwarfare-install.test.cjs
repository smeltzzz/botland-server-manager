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
  const source = { async resolveSource(gameId, channel) {
    assert.equal(gameId, id);
    return { supported: true, repo: `https://github.com/ineedbots/${id}_bot_warfare`,
      refType: 'tag', ref: `v-${version}`, assetUrl: `https://github.com/ineedbots/${id}_bot_warfare/releases/download/v-${version}/mod.zip`,
      channel, notes: '' };
  } };
  const download = async url => {
    downloaded.push(url);
    const bytes = archive(input(id, version));
    return { bytes, sha256: hash(bytes) };
  };
  const installer = new BotWarfareInstaller({ source, download, localAppData, ...overrides });
  return { game, localAppData, installer, downloaded, setVersion: v => { version = v; } };
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
      assert.equal(manifest.sha256, hash(archive(input(id, 'one'))));
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

test('updates preserve unrelated files and modified waypoints; removal only deletes unchanged owned files', async t => {
  const f = await fixture(t, 'cod4');
  await f.installer.install('cod4', f.game);
  const base = path.join(f.game, 'mods', 'mp_bots');
  const wp = path.join(base, 'scriptdata', 'waypoints', 'mp_crash_wp.csv');
  const userFile = path.join(base, 'server.cfg');
  const log = path.join(base, 'logs', 'console.log');
  await fs.mkdir(path.dirname(log));
  await fs.writeFile(log, 'keep log');
  await fs.writeFile(userFile, 'keep cfg');
  await fs.writeFile(wp, 'custom waypoint');
  f.setVersion('two');
  await f.installer.install('cod4', f.game);
  assert.equal(await read(path.join(base, 'z_svr_bots.iwd')), 'release-two');
  assert.equal(await read(wp), 'custom waypoint');
  const versions = (await f.installer.status('cod4', f.game)).versions;
  assert.equal(versions.length, 1);
  assert.equal((await f.installer.listVersions('cod4', f.game)).length, 1);
  await f.installer.remove('cod4', f.game);
  assert.equal(await exists(path.join(base, 'z_svr_bots.iwd')), false);
  assert.equal(await exists(path.join(base, 'botland-install.json')), false);
  assert.equal(await read(wp), 'custom waypoint');
  assert.equal(await read(userFile), 'keep cfg');
  assert.equal(await read(log), 'keep log');
  assert.equal((await f.installer.status('cod4', f.game)).state, 'not-installed');
  await f.installer.restore('cod4', f.game, versions[0].versionId);
  assert.equal(await read(wp), 'custom waypoint');
  assert.equal(await read(userFile), 'keep cfg');
  assert.equal(await read(log), 'keep log');
  assert.equal(await read(path.join(base, 'z_svr_bots.iwd')), 'release-one');
  await f.installer.remove('cod4', f.game);
  assert.equal(await read(wp), 'custom waypoint');
});

test('explicit install backs up pre-existing unmanifested mod; Restore recovers its bytes', async t => {
  const f = await fixture(t, 'mw3');
  const base = path.join(f.localAppData, 'Plutonium', 'storage', 'iw5', 'mods', 'bots');
  await fs.mkdir(base, { recursive: true });
  await fs.writeFile(path.join(base, 'z_svr_bots.iwd'), 'original user mod');
  await fs.writeFile(path.join(base, 'notes.txt'), 'user notes');
  assert.equal((await f.installer.status('mw3', f.game)).state, 'unknown');
  await assert.rejects(f.installer.remove('mw3', f.game), /Unknown/u);
  await f.installer.install('mw3', f.game);
  const unknown = (await f.installer.status('mw3', f.game)).versions.find(v => v.manifest === null);
  assert.ok(unknown);
  await f.installer.restore('mw3', f.game, unknown.versionId);
  assert.equal(await read(path.join(base, 'z_svr_bots.iwd')), 'original user mod');
  assert.equal(await read(path.join(base, 'notes.txt')), 'user notes');
  assert.equal(await exists(path.join(base, 'botland-install.json')), false);
});

test('pre-existing unowned waypoints are never overwritten, adopted or removed', async t => {
  const f = await fixture(t, 'mw2');
  const waypoint = path.join(f.game, 'userraw', 'scriptdata', 'waypoints', 'mp_rust_wp.csv');
  await fs.mkdir(path.dirname(waypoint), { recursive: true });
  await fs.writeFile(waypoint, 'my waypoint');
  await f.installer.install('mw2', f.game);
  assert.equal(await read(waypoint), 'my waypoint');
  assert.equal((await f.installer.status('mw2', f.game)).manifest.files.some(file => file.path.includes('waypoints')), false);
  f.setVersion('two');
  await f.installer.install('mw2', f.game);
  await f.installer.remove('mw2', f.game);
  assert.equal(await read(waypoint), 'my waypoint');
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
  assert.equal((await f.installer.status('bo1', f.game)).versions.length, 0);
});

test('restore prior version, retain three snapshots, refuse running/starting and serialize same-game operations', async t => {
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
  const previous = (await f.installer.status('bo2', f.game)).versions.find(v => v.manifest?.ref === 'v-one');
  assert.ok(previous);
  await f.installer.restore('bo2', f.game, previous.versionId);
  assert.equal(await read(path.join(base, 'bots.gsc')), 'release-one');
  running = 'starting';
  await assert.rejects(f.installer.remove('bo2', f.game), /Stop the starting or running/u);
  await assert.rejects(f.installer.install('bo2', f.game), /Stop the starting or running/u);
  running = true;
  await assert.rejects(f.installer.restore('bo2', f.game, previous.versionId), /Stop the starting or running/u);
  running = false;
  for (const v of ['three', 'four', 'five']) { f.setVersion(v); await f.installer.install('bo2', f.game); }
  assert.equal((await f.installer.status('bo2', f.game)).versions.length, 3);
});

test('invalid manifest cannot claim arbitrary user config, and tampered history cannot be restored', async t => {
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
  const version = (await f.installer.status('mw2', f.game)).versions.find(v => v.manifest?.ref === 'v-one');
  const snapshot = path.join(path.dirname(base), '.botland-versions-mw2-userraw', version.versionId, 'z_svr_bots.iwd');
  await fs.writeFile(snapshot, 'corrupt');
  await assert.rejects(f.installer.restore('mw2', f.game, version.versionId), /SHA-256 mismatch/u);
  assert.equal(await read(path.join(base, 'z_svr_bots.iwd')), 'release-two');
});
