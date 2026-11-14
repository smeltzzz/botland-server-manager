const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { zipSync } = require('fflate');
const { BotWarfareInstaller } = require('../electron/botwarfare-install.cjs');
const { EngineUpdater, PINS } = require('../electron/engine-update.cjs');

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const crash = () => Object.assign(new Error('synthetic process death'), { simulateCrash: true });
const exists = async file => (await fs.stat(file).catch(() => null)) !== null;
const read = file => fs.readFile(file, 'utf8');
async function temporary(t) {
  const parent = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp', 'opencode');
  await fs.mkdir(parent, { recursive: true });
  const dir = await fs.mkdtemp(path.join(parent, 'sweep15-install-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return fs.realpath(dir);
}
async function botFixture(t) {
  const game = await temporary(t);
  let version = 'one';
  const source = { resolveSource: async () => ({ supported: true, repo: 'https://github.com/ineedbots/mw2_bot_warfare',
    refType: 'tag', ref: version, assetUrl: 'synthetic:offline' }) };
  const download = async () => {
    const root = 'Move files to root of MW2 folder/mods/mp_bots/';
    const bytes = Buffer.from(zipSync({ [root + 'z_svr_bots.iwd']: Buffer.from(version),
      [root + 'scriptdata/waypoints/mp_rust_wp.csv']: Buffer.from('waypoint-' + version) }));
    return { bytes, sha256: hash(bytes) };
  };
  const installer = new BotWarfareInstaller({ source, download });
  await installer.install('mw2', game);
  const folder = path.join(game, 'userraw');
  return { game, folder, installer, setVersion: next => { version = next; },
    target: path.join(folder, 'z_svr_bots.iwd'), manifest: path.join(folder, 'botland-install.json') };
}

test('Remove carries ownership hash from selection into staging instead of adopting concurrent bytes', async t => {
  for (const change of ['edit', 'replace', 'delete']) await t.test(change, async t => {
    const f = await botFixture(t);
    const originalManifest = await read(f.manifest);
    f.installer.fault = async (count, phase) => {
      if (phase !== 'before-staging') return;
      if (change !== 'edit') await fs.unlink(f.target);
      if (change !== 'delete') await fs.writeFile(f.target, 'user change during Remove');
    };
    await assert.rejects(f.installer.remove('mw2', f.game), /owned target changed before staging/u);
    assert.equal(await read(f.manifest), originalManifest);
    assert.equal(await read(path.join(f.folder, 'scriptdata', 'waypoints', 'mp_rust_wp.csv')), 'waypoint-one');
    if (change === 'delete') assert.equal(await exists(f.target), false);
    else assert.equal(await read(f.target), 'user change during Remove');
    assert.deepEqual((await fs.readdir(f.game)).filter(name => name.startsWith('.botland-stage-')), []);
    f.installer.fault = () => {};
    await f.installer.remove('mw2', f.game);
    if (change !== 'delete') assert.equal(await read(f.target), 'user change during Remove');
    assert.equal(await exists(f.manifest), false);
  });
});

test('Remove also preserves edits made after staging and retains a conflicting recovery journal', async t => {
  const f = await botFixture(t);
  const originalManifest = await read(f.manifest);
  f.installer.fault = async (count, phase) => {
    if (phase === 'after-staging') await fs.writeFile(f.target, 'post-staging edit');
  };
  await assert.rejects(f.installer.remove('mw2', f.game), /rollback failed/u);
  assert.equal(await read(f.target), 'post-staging edit');
  assert.equal(await read(f.manifest), originalManifest);
  const fresh = new BotWarfareInstaller({ source: f.installer.source, download: f.installer.download });
  await assert.rejects(fresh.prepareLaunch('mw2', f.game), /recovery conflict/u);
  assert.equal(await read(f.target), 'post-staging edit');
});

test('Install/Update still deliberately overwrite edits, including edits before the staging read', async t => {
  const f = await botFixture(t);
  await fs.writeFile(f.target, 'pre-existing user edit');
  f.setVersion('two');
  f.installer.fault = async (count, phase) => {
    if (phase === 'before-staging') await fs.writeFile(f.target, 'edit before staging');
  };
  await f.installer.install('mw2', f.game);
  assert.equal(await read(f.target), 'two');
  assert.equal(JSON.parse(await read(f.manifest)).ref, 'two');
});

const executable = Buffer.from('MZ synthetic engine only');
const launcherZip = Buffer.from(zipSync({ 'iw4x-launcher.exe': executable }));
const pins = Object.fromEntries(['cod4', 'mw2'].map(id => {
  const bytes = id === 'cod4' ? executable : launcherZip;
  return [id, { ...PINS[id], size: bytes.length, sha256: hash(bytes), ...(id === 'mw2' ? { unpacked: executable.length } : {}) }];
}));
function engine(id, folder, overrides = {}) {
  return new EngineUpdater({ pins, confirmOverwrite: () => true,
    fetch: async () => new Response(id === 'cod4' ? executable : launcherZip),
    run: async () => { await fs.writeFile(path.join(folder, 'iw4x.exe'), 'new game output'); }, ...overrides });
}
async function engineFixture(t, id) {
  const folder = await temporary(t);
  await fs.writeFile(path.join(folder, PINS[id].base), 'synthetic base game');
  await fs.writeFile(path.join(folder, PINS[id].target), 'previous executable');
  if (id === 'mw2') await fs.writeFile(path.join(folder, 'iw4x.exe'), 'previous game output');
  return folder;
}
const stages = async (folder, kind) => (await fs.readdir(folder)).filter(name => name.startsWith(`.botland-engine-${kind}-`));
async function stageSnapshot(folder) {
  const [name] = await stages(folder, 'stage');
  assert.ok(name);
  const stage = path.join(folder, name);
  return Object.fromEntries(await Promise.all((await fs.readdir(stage)).sort().map(async item =>
    [item, (await fs.readFile(path.join(stage, item))).toString('hex')])));
}
async function interruptCleanup(phase, done) {
  if (phase !== 'cleanup') return;
  // Model recursive rm stopping after destroying the journal and a backup. A
  // fresh process must not attempt to validate or roll back this resolved data.
  await fs.rm(path.join(done, 'journal.json'));
  await fs.rm(path.join(done, 'before-0'));
  throw crash();
}

for (const id of ['cod4', 'mw2']) {
  test(`${id}: committed cleanup can stop after rename or midway through recursive deletion`, async t => {
    for (const boundary of ['resolved', 'cleanup']) await t.test(boundary, async t => {
      const folder = await engineFixture(t, id);
      const updater = engine(id, folder, { fault: async (phase, done) => {
        if (phase !== boundary) return;
        if (boundary === 'cleanup') await interruptCleanup(phase, done);
        else throw crash();
      } });
      await assert.rejects(updater.update(id, folder), /synthetic process death/u);
      assert.deepEqual(await stages(folder, 'stage'), []);
      assert.equal((await stages(folder, 'done')).length, 1);
      assert.deepEqual(await fs.readFile(path.join(folder, PINS[id].target)), executable);
      if (id === 'mw2') assert.equal(await read(path.join(folder, 'iw4x.exe')), 'new game output');
      const fresh = engine(id, folder);
      await fresh.prepareLaunch(id, folder);
      await fresh.recover(id, folder, pins[id]);
      await fresh.recover(id, folder, pins[id]);
      assert.deepEqual(await stages(folder, 'done'), []);
      assert.deepEqual(await fs.readFile(path.join(folder, PINS[id].target)), executable);
    });
  });

  test(`${id}: rollback cleanup interruption leaves only disposable data and exact original files`, async t => {
    const folder = await engineFixture(t, id);
    const updater = engine(id, folder, { fault: phase => { if (phase === 'published') throw crash(); } });
    await assert.rejects(updater.update(id, folder), /synthetic process death/u);
    const recovering = engine(id, folder, { fault: interruptCleanup });
    await assert.rejects(recovering.recover(id, folder, pins[id]), /synthetic process death/u);
    assert.equal(await read(path.join(folder, PINS[id].target)), 'previous executable');
    if (id === 'mw2') assert.equal(await read(path.join(folder, 'iw4x.exe')), 'previous game output');
    assert.deepEqual(await stages(folder, 'stage'), []);
    assert.equal((await stages(folder, 'done')).length, 1);
    const fresh = engine(id, folder);
    await fresh.prepareLaunch(id, folder);
    await fresh.recover(id, folder, pins[id]);
    assert.deepEqual(await stages(folder, 'done'), []);
    assert.equal(await read(path.join(folder, PINS[id].target)), 'previous executable');
  });
}

test('failed/interrupted/unknown external IW4x runs NEVER enter the disposable namespace', async t => {
  for (const failure of ['failed', 'interrupted', 'unknown']) await t.test(failure, async t => {
    const folder = await engineFixture(t, 'mw2');
    const updater = engine('mw2', folder, {
      run: async () => {
        await fs.writeFile(path.join(folder, 'iw4x.exe'), 'external partial output');
        const error = failure === 'interrupted' ? crash() : new Error('synthetic external failure');
        if (failure === 'unknown') error.processUnknown = true;
        throw error;
      },
    });
    await assert.rejects(updater.update('mw2', folder), /synthetic/u);
    const before = await stageSnapshot(folder);
    assert.equal(before['before-0'], Buffer.from('previous executable').toString('hex'));
    assert.equal(before['before-1'], Buffer.from('previous game output').toString('hex'));
    assert.ok(before['external-started']);
    assert.equal(Object.hasOwn(before, 'committed'), false);
    assert.equal(Object.hasOwn(before, 'output.sha256'), failure === 'failed');
    assert.equal(Object.hasOwn(before, 'process-unknown'), failure === 'unknown');
    const fresh = engine('mw2', folder);
    await assert.rejects(fresh.prepareLaunch('mw2', folder), /journal remains/u);
    await assert.rejects(fresh.recover('mw2', folder, pins.mw2), /journal retained for manual inspection/u);
    assert.deepEqual(await stageSnapshot(folder), before);
    assert.deepEqual(await stages(folder, 'done'), []);
    assert.equal(await read(path.join(folder, 'iw4x.exe')), 'external partial output');
  });
});
