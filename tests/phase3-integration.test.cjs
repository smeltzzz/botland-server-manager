const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { zipSync } = require('fflate');
const { ServerManager } = require('../electron/manager.cjs');
const { BotWarfareSource, SOURCES } = require('../electron/botwarfare-source.cjs');
const { BotWarfareInstaller } = require('../electron/botwarfare-install.cjs');
const { profileFor } = require('../electron/profiles.cjs');
const { starterText } = require('../electron/starter-config.cjs');

const tempRoot = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp', 'opencode');
const multiplayer = { mw2: 'iw4mp.exe', bo2: 't6mp.exe' };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const archive = files => Buffer.from(zipSync(Object.fromEntries(
  Object.entries(files).map(([name, body]) => [name, Buffer.from(body)]))));
const modArchive = id => id === 'mw2' ? archive({
  'Move files to root of MW2 folder/mods/mp_bots/z_svr_bots.iwd': 'fixture mod',
  'Move files to root of MW2 folder/mods/mp_bots/scriptdata/waypoints/mp_rust_wp.csv': 'fixture waypoint',
}) : archive({
  'snapshot/scripts/mp/bots.gsc': 'fixture bots',
  'snapshot/scripts/mp/bots_adapter_pt6.gsc': 'fixture adapter',
});
const gameState = (snapshot, id) => snapshot.games.find(game => game.id === id);

async function fixture(t, id, { pausedDownload = false } = {}) {
  await fs.mkdir(tempRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(tempRoot, 'botland-phase3-'));
  const oldLocalAppData = process.env.LOCALAPPDATA;
  const localAppData = path.join(root, 'local-app-data');
  process.env.LOCALAPPDATA = localAppData;
  t.after(async () => {
    if (oldLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = oldLocalAppData;
    await fs.rm(root, { recursive: true, force: true });
  });
  const gamePath = path.join(root, 'game');
  await fs.mkdir(gamePath);
  await fs.mkdir(localAppData);
  await fs.writeFile(path.join(gamePath, multiplayer[id]), 'fixture multiplayer marker');
  const metadata = { tag: 'v2.4.0', commit: 'a'.repeat(40) };
  const fetches = [];
  const fetch = async (url, options) => {
    fetches.push(url);
    assert.equal(new URL(url).hostname, 'api.github.com');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'manual');
    const sourceId = Object.keys(SOURCES).find(key => url.includes(`/${SOURCES[key].repo}/`));
    assert.ok(sourceId, `Unexpected metadata URL: ${url}`);
    if (url.endsWith('/commits/master')) {
      return new Response(JSON.stringify({ sha: metadata.commit, commit: { message: 'Fixture snapshot' } }), { status: 200 });
    }
    const source = SOURCES[sourceId];
    const tag = sourceId === 'mw2' ? metadata.tag : source.tag;
    const asset = sourceId === 'mw2' ? `iw4bw${tag.slice(1).replaceAll('.', '')}.zip` : source.asset;
    return new Response(JSON.stringify({ tag_name: tag, body: 'Fixture release', assets: [{
      name: asset,
      browser_download_url: `https://github.com/ineedbots/${source.repo}/releases/download/${tag}/${asset}`,
    }] }), { status: 200 });
  };
  const source = new BotWarfareSource({ userData: path.join(root, 'user-data'), fetch, now: () => 1_000_000 });
  const downloads = [];
  let releaseDownload;
  let downloadEntered;
  const downloadGate = new Promise(resolve => { releaseDownload = resolve; });
  const enteredDownload = new Promise(resolve => { downloadEntered = resolve; });
  // A real installer processes these ZIP bytes; no HTTP download or game process is possible.
  const download = async (url, options) => {
    downloads.push({ url, options });
    if (pausedDownload) { downloadEntered(); await downloadGate; }
    const bytes = modArchive(id);
    return { bytes, sha256: sha256(bytes) };
  };
  let manager;
  const installer = new BotWarfareInstaller({ source, download, localAppData,
    isRunning: gameId => manager.instances.get(gameId)?.status });
  manager = new ServerManager(path.join(root, 'settings.json'), () => {}, path.join(root, 'absent-scripts'),
    { modSource: source, modInstaller: installer, detectInstallations: async () => ({ games: {} }) });
  manager.data.games[id] = { gamePath };
  return { root, gamePath, localAppData, manager, installer, metadata, fetches, downloads,
    enteredDownload, releaseDownload };
}

test('manager creates a starter only for a missing config; snapshot sees it without touching rotations', async t => {
  const f = await fixture(t, 'mw2');
  const file = path.join(f.gamePath, profileFor('mw2').config);
  const rotation = path.join(f.gamePath, profileFor('mw2').rotation);
  assert.match(gameState(await f.manager.snapshot(), 'mw2').blockers.join('\n'), /Server config missing/);
  assert.equal(await f.manager.createStarterConfig('mw2'), file);
  const bytes = await fs.readFile(file);
  assert.deepEqual(bytes, Buffer.from(starterText('mw2')));
  const game = gameState(await f.manager.snapshot(), 'mw2');
  assert.equal(game.config.sv_hostname, 'botLANd MW2 Server');
  assert.equal(game.blockers.some(message => message.startsWith('Server config missing')), false);
  await assert.rejects(fs.stat(rotation), { code: 'ENOENT' });
  const originalTime = new Date('2020-01-02T03:04:05.000Z');
  await fs.utimes(file, originalTime, originalTime);
  const before = await fs.stat(file);
  await assert.rejects(f.manager.createStarterConfig('mw2'), { code: 'EEXIST' });
  assert.deepEqual(await fs.readFile(file), bytes);
  assert.equal((await fs.stat(file)).mtimeMs, before.mtimeMs);
  assert.deepEqual(await fs.readdir(path.dirname(file)), ['serverlan.cfg']);
  await assert.rejects(fs.stat(rotation), { code: 'ENOENT' });
});

test('unknown mod, pending install/start guard, manifest provenance, update badge and disabled/manual checks', async t => {
  const f = await fixture(t, 'mw2', { pausedDownload: true });
  const base = path.join(f.gamePath, 'userraw');
  await fs.mkdir(base);
  await fs.writeFile(path.join(base, 'z_svr_bots.iwd'), 'unmanaged fixture mod');
  assert.equal((await f.manager.botStatus('mw2')).state, 'unknown');
  assert.equal(gameState(await f.manager.snapshot(), 'mw2').modBusy, false);
  await assert.rejects(f.manager.setBotChannel('mw2', 'development'), /verified development build/);
  let install;
  try {
    install = f.manager.botAction('mw2', 'install');
    await f.enteredDownload;
    assert.equal(gameState(await f.manager.snapshot(), 'mw2').modBusy, true);
    await assert.rejects(f.manager.start('mw2'), /Wait for the Bot Warfare change/);
    await assert.rejects(f.manager.botAction('mw2', 'remove'), /Stop this server/);
    await assert.rejects(fs.stat(path.join(f.gamePath, profileFor('mw2').rotation)), { code: 'ENOENT' });
  } finally {
    f.releaseDownload();
    if (install) await install;
  }
  assert.equal(gameState(await f.manager.snapshot(), 'mw2').modBusy, false);
  const status = await f.manager.botStatus('mw2');
  assert.equal(status.state, 'installed');
  assert.equal(status.channel, 'stable');
  assert.equal(status.manifest.refType, 'tag');
  assert.equal(status.manifest.ref, 'v2.4.0');
  assert.equal(Object.hasOwn(status.manifest, 'tag'), false);
  assert.equal(status.manifest.channel, 'stable');
  assert.equal(status.manifest.sha256, sha256(modArchive('mw2')));
  assert.deepEqual(status.manifest, JSON.parse(await fs.readFile(path.join(base, 'botland-install.json'), 'utf8')));
  assert.equal(status.versions.length, 1); // The unknown mod was snapshotted before replacement.
  assert.equal(status.versions[0].manifest, null);
  assert.equal(f.downloads.length, 1);
  assert.match(f.downloads[0].url, /\/v2\.4\.0\/iw4bw240\.zip$/);
  assert.equal(f.downloads[0].options.expectedHash, undefined);

  await f.manager.checkBotUpdates(true);
  assert.equal((await f.manager.snapshot()).updates.mw2.updateAvailable, false);
  f.metadata.tag = 'v2.5.0';
  await f.manager.checkBotUpdates(true);
  assert.equal((await f.manager.snapshot()).updates.mw2.updateAvailable, true);
  assert.equal((await f.manager.snapshot()).updates.bo1.updateAvailable, null);
  await f.manager.setUpdateChecks(false);
  assert.equal((await f.manager.snapshot()).updatesEnabled, false);
  assert.deepEqual((await f.manager.snapshot()).updates, {});
  const count = f.fetches.length;
  assert.equal((await f.manager.botStatus('mw2')).source.status, 'disabled');
  await f.manager.checkBotUpdates();
  assert.equal(f.fetches.length, count);
  assert.deepEqual((await f.manager.snapshot()).updates, {});
  await f.manager.checkBotUpdates(true); // Explicit Check now bypasses the preference.
  assert.ok(f.fetches.length > count);
  assert.equal((await f.manager.snapshot()).updates.mw2.updateAvailable, true);
});

test('development commit manifest drives badge; running and starting fake instances refuse mod changes', async t => {
  const f = await fixture(t, 'bo2');
  await f.manager.setBotChannel('bo2', 'development');
  assert.equal((await f.manager.botStatus('bo2')).channel, 'development');
  await f.manager.botAction('bo2', 'install');
  const status = await f.manager.botStatus('bo2');
  const base = path.join(f.localAppData, 'Plutonium', 'storage', 't6', 'scripts', 'mp');
  assert.equal(status.state, 'installed');
  assert.equal(status.manifest.channel, 'development');
  assert.equal(status.manifest.refType, 'commit');
  assert.equal(status.manifest.ref, 'a'.repeat(40));
  assert.equal(Object.hasOwn(status.manifest, 'commit'), false);
  assert.deepEqual(status.manifest, JSON.parse(await fs.readFile(path.join(base, 'botland-install.json'), 'utf8')));
  assert.equal(f.downloads.length, 1);
  assert.match(f.downloads[0].url, /codeload\.github\.com\/ineedbots\/t6_bot_warfare\/zip\/a{40}$/);
  const original = await fs.readFile(path.join(base, 'bots.gsc'));
  await f.manager.checkBotUpdates(true);
  assert.equal((await f.manager.snapshot()).updates.bo2.updateAvailable, false);
  f.metadata.commit = 'b'.repeat(40);
  await f.manager.checkBotUpdates(true);
  assert.equal((await f.manager.snapshot()).updates.bo2.updateAvailable, true);
  for (const state of ['starting', 'running']) {
    f.manager.instances.set('bo2', { status: state }); // No child is spawned.
    try {
      await assert.rejects(f.manager.botAction('bo2', 'update'), /Stop this server/);
      await assert.rejects(f.installer.remove('bo2', f.gamePath), /Stop the starting or running game/);
      assert.deepEqual(await fs.readFile(path.join(base, 'bots.gsc')), original);
      assert.equal((await f.manager.botStatus('bo2')).manifest.ref, 'a'.repeat(40));
    } finally { f.manager.instances.delete('bo2'); }
  }
  assert.equal(f.downloads.length, 1);
});
