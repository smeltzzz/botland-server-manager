const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { zipSync } = require('fflate');
const { BotWarfareInstaller } = require('../electron/botwarfare-install.cjs');
const { EngineUpdater, PINS } = require('../electron/engine-update.cjs');
const { readModArchive } = require('../electron/mod-archive.cjs');
const { planBotWarfareAsync, readModArchiveAsync } = require('../electron/archive-cpu.cjs');

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const zip = files => Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name, body]) => [name, Buffer.from(body)]))));
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function temporary(t) {
  const parent = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp', 'opencode');
  await fs.mkdir(parent, { recursive: true });
  const dir = await fs.mkdtemp(path.join(parent, 'sweep21-cpu-install-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return fs.realpath(dir);
}
function sourceFor(id, bytes, extra = {}) {
  return { resolveSource: async () => ({ supported: true, verified: true, repo: `https://github.com/ineedbots/${id}_bot_warfare`,
    refType: 'tag', ref: 'synthetic', assetUrl: 'synthetic:offline', expectedHash: hash(bytes), ...extra }) };
}
const mw2Files = () => ({ 'Move files to root of MW2 folder/mods/mp_bots/z_svr_bots.iwd': 'synthetic mod',
  'Move files to root of MW2 folder/mods/mp_bots/scriptdata/waypoints/mp_rust_wp.csv': 'synthetic waypoint' });

test('installer keeps same-game operations queued throughout CPU planning, before any stage/file writes', async t => {
  const game = await temporary(t);
  const bytes = zip(mw2Files());
  const entered = gate();
  const release = gate();
  let plans = 0;
  const installer = new BotWarfareInstaller({ source: sourceFor('mw2', bytes),
    download: async (url, options) => {
      assert.deepEqual(options, { expectedHash: hash(bytes) });
      return { bytes, sha256: hash(bytes) };
    },
    planArchive: async (id, channel, input) => {
      plans++;
      assert.deepEqual(input, bytes);
      if (plans === 1) { entered.resolve(); await release.promise; }
      return planBotWarfareAsync(id, channel, input);
    } });
  const first = installer.install('mw2', game);
  await entered.promise;
  assert.equal(installer.pending.has('mw2'), true);
  assert.deepEqual(await fs.readdir(game), []);
  const second = installer.install('mw2', game);
  let statusFinished = false;
  const status = installer.status('mw2', game).then(result => { statusFinished = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(plans, 1);
  assert.equal(statusFinished, false);
  release.resolve();
  const results = await Promise.all([first, second, status]);
  assert.ok(results.every(result => result.state === 'installed'));
  assert.equal(plans, 2);
  assert.equal(installer.pending.size, 0);
  assert.equal(await fs.readFile(path.join(game, 'userraw', 'z_svr_bots.iwd'), 'utf8'), 'synthetic mod');
  assert.deepEqual((await fs.readdir(game)).filter(name => name.startsWith('.botland-')), []);
});

test('a server becoming active during CPU planning prevents publication and releases the install queue', async t => {
  const game = await temporary(t);
  const bytes = zip(mw2Files());
  const entered = gate();
  const release = gate();
  let running = false;
  const installer = new BotWarfareInstaller({ source: sourceFor('mw2', bytes), isRunning: () => running,
    download: async () => ({ bytes, sha256: hash(bytes) }),
    planArchive: async (...args) => { entered.resolve(); await release.promise; return planBotWarfareAsync(...args); } });
  const work = installer.install('mw2', game);
  await entered.promise;
  running = 'starting';
  release.resolve();
  await assert.rejects(work, /Stop the starting or running game/u);
  assert.deepEqual(await fs.readdir(game), []);
  assert.equal(installer.pending.size, 0);
  running = false;
  assert.equal((await installer.status('mw2', game)).state, 'not-installed');
});

test('Stable trust and SHA-256 checks remain in main before any worker operation', async t => {
  const game = await temporary(t);
  const bytes = zip(mw2Files());
  let downloads = 0;
  let plans = 0;
  const installer = new BotWarfareInstaller({ source: sourceFor('mw2', bytes, { verified: false }),
    download: async () => { downloads++; return { bytes, sha256: '0'.repeat(64) }; },
    planArchive: async () => { plans++; throw new Error('CPU work must not start before verification.'); } });
  await assert.rejects(installer.install('mw2', game), /newer than the release verified/u);
  assert.equal(downloads, 0);
  assert.equal(plans, 0);
  installer.source = sourceFor('mw2', bytes);
  await assert.rejects(installer.install('mw2', game), /SHA-256 mismatch/u);
  assert.equal(downloads, 1);
  assert.equal(plans, 0);
  assert.equal(installer.pending.size, 0);
  assert.deepEqual(await fs.readdir(game), []);
});

test('a correctly checksummed but corrupt ZIP worker error creates no transaction and does not poison retry', async t => {
  const game = await temporary(t);
  const bytes = zip(mw2Files());
  const corrupt = Buffer.from(bytes);
  const central = corrupt.readUInt32LE(corrupt.length - 22 + 16);
  corrupt.writeUInt32LE(0, central + 16);
  corrupt.writeUInt32LE(0, 14);
  let input = corrupt;
  const installer = new BotWarfareInstaller({ source: { resolveSource: async () => (await sourceFor('mw2', input).resolveSource()) },
    download: async () => ({ bytes: input, sha256: hash(input) }) });
  await assert.rejects(installer.install('mw2', game), /CRC mismatch/u);
  assert.deepEqual(await fs.readdir(game), []);
  assert.equal(installer.pending.size, 0);
  input = bytes;
  assert.equal((await installer.install('mw2', game)).state, 'installed');
});

test('CoD4 development source is built in the worker and installed through the unchanged manifest/journal path', async t => {
  const game = await temporary(t);
  const callbackName = 'maps/mp/gametypes/_callbacksetup.gsx';
  const bytes = zip({ ['snapshot/' + callbackName]: 'CodeCallback_PlayerConnect()\n{\n\tself endon( "disconnect" );\n\t[[level.callbackPlayerConnect]]();\n}\n',
    'snapshot/maps/mp/bots/_bot.gsc': 'synthetic bot', 'snapshot/scripts/mp/bots.gsc': 'synthetic entrypoint',
    'snapshot/scripts/mp/bots_adapter_cod4x.gsc': 'synthetic adapter', 'snapshot/scripts/no.cfg': 'excluded' });
  const installer = new BotWarfareInstaller({ source: sourceFor('cod4', bytes, { refType: 'commit', verified: false }),
    download: async () => ({ bytes, sha256: hash(bytes) }) });
  const result = await installer.install('cod4', game, 'development');
  const iwd = await fs.readFile(path.join(result.targetPath, 'z_svr_bots.iwd'));
  assert.deepEqual([...readModArchive(iwd).keys()], ['maps/mp/bots/_bot.gsc', 'scripts/mp/bots.gsc', 'scripts/mp/bots_adapter_cod4x.gsc']);
  assert.match(await fs.readFile(path.join(result.targetPath, callbackName), 'utf8'), /self\.clientid = level\.clientid/u);
  for (const file of result.manifest.files) assert.equal(file.sha256, hash(await fs.readFile(path.join(result.targetPath, file.path))));
  assert.equal(result.manifest.channel, 'development');
  assert.equal(result.manifest.patches.length, 2);
  assert.deepEqual((await fs.readdir(path.dirname(result.targetPath))).filter(name => name.startsWith('.botland-stage-')), []);
});

async function engineFixture(t, overrides = {}) {
  const game = await temporary(t);
  const exe = Buffer.from('MZ synthetic launcher, never executed');
  const archive = zip({ 'iw4x-launcher.exe': exe });
  const pin = { ...PINS.mw2, size: archive.length, unpacked: exe.length, sha256: hash(archive) };
  await fs.writeFile(path.join(game, PINS.mw2.base), 'synthetic game marker');
  const updater = new EngineUpdater({ pins: { ...PINS, mw2: pin }, fetch: async () => new Response(archive),
    confirmOverwrite: () => true,
    run: async file => {
      assert.deepEqual(await fs.readFile(file), exe);
      await fs.writeFile(path.join(game, 'iw4x.exe'), 'synthetic launcher output');
    }, ...overrides });
  return { game, updater, pin, exe, archive };
}

test('engine CPU waits retain the busy reservation and pinned limits before confirmation, staging or launcher work', async t => {
  const entered = gate();
  const release = gate();
  let confirmations = 0;
  const f = await engineFixture(t, { confirmOverwrite: () => { confirmations++; return true; },
    readArchive: async (bytes, limits) => {
      assert.equal(hash(bytes), f.pin.sha256, 'download verification precedes worker work');
      assert.deepEqual(limits, { maxInputBytes: f.pin.size, maxEntries: 1,
        maxEntryBytes: f.pin.unpacked, maxExtractedBytes: f.pin.unpacked });
      entered.resolve();
      await release.promise;
      return readModArchiveAsync(bytes, limits);
    } });
  const target = path.join(f.game, PINS.mw2.target);
  await fs.writeFile(target, 'existing synthetic launcher');
  const work = f.updater.update('mw2', f.game);
  await entered.promise;
  assert.equal(f.updater.busy.has('mw2'), true);
  await assert.rejects(f.updater.update('mw2', f.game), /already in progress/u);
  assert.equal(confirmations, 0);
  assert.equal(await fs.readFile(target, 'utf8'), 'existing synthetic launcher');
  assert.deepEqual((await fs.readdir(f.game)).filter(name => name.startsWith('.botland-engine-')), []);
  release.resolve();
  await work;
  assert.equal(confirmations, 1);
  assert.equal(f.updater.busy.size, 0);
  assert.deepEqual(await fs.readFile(target), f.exe);
});

test('engine worker failure releases busy without touching originals or leaving a journal; retry still works', async t => {
  let calls = 0;
  const f = await engineFixture(t, { readArchive: async () => { calls++; throw new Error('synthetic CPU worker failure'); } });
  const target = path.join(f.game, PINS.mw2.target);
  await fs.writeFile(target, 'existing synthetic launcher');
  await assert.rejects(f.updater.update('mw2', f.game), /synthetic CPU worker failure/u);
  assert.equal(calls, 1);
  assert.equal(f.updater.busy.size, 0);
  assert.equal(await fs.readFile(target, 'utf8'), 'existing synthetic launcher');
  assert.deepEqual((await fs.readdir(f.game)).filter(name => name.startsWith('.botland-engine-')), []);
  f.updater.readArchive = readModArchiveAsync;
  await f.updater.update('mw2', f.game);
  assert.deepEqual(await fs.readFile(target), f.exe);
  assert.equal(f.updater.busy.size, 0);
});
