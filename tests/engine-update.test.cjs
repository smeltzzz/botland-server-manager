const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { zipSync } = require('fflate');
const { EngineUpdater, PINS } = require('../electron/engine-update.cjs');

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const exe = Buffer.from('MZ synthetic verified executable');
const zip = Buffer.from(zipSync({ 'iw4x-launcher.exe': exe }));
function pin(id, bytes) { return { ...PINS[id], size: bytes.length, sha256: sha(bytes), ...(id === 'mw2' ? { unpacked: exe.length } : {}) }; }
const pins = { cod4: pin('cod4', exe), mw2: pin('mw2', zip) };
function response(bytes, status = 200, headers = {}) {
  return new Response(bytes === null ? null : new ReadableStream({
    start(controller) { controller.enqueue(bytes); controller.close(); },
  }), { status, headers });
}
async function folder(t, id) {
  const root = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp', 'opencode');
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'botland-engine-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, PINS[id].base), 'MZ base game');
  return dir;
}
function fixture(id, { fetch, run, confirmOverwrite } = {}) {
  const requests = [];
  const updater = new EngineUpdater({ pins,
    fetch: fetch || (async (url, options) => {
      requests.push([url, options.redirect]);
      return response(id === 'mw2' ? zip : exe);
    }),
    run: run || (async () => {}), confirmOverwrite });
  return { updater, requests };
}

// Public pin values are intentionally asserted independently of synthetic fixtures.
test('official release pins remain fixed', () => {
  assert.equal(PINS.cod4.size, 5741742);
  assert.equal(PINS.cod4.sha256, '1aa421ee94f9ed742b52412e27235e800b5c242fad5768483f3b308d20832de6');
  assert.equal(PINS.mw2.size, 13012652);
  assert.equal(PINS.mw2.sha256, '4116ad1f75319174c96c1fe1f1a87bbf687e1f37dff42feebef74d81a89ad68f');
  assert.equal(PINS.mw2.unpacked, 44504061);
});

test('CoD4 publishes only the pinned executable without touching configs or mods', async t => {
  const dir = await folder(t, 'cod4');
  await fs.mkdir(path.join(dir, 'main'));
  await fs.writeFile(path.join(dir, 'main', 'botserver.cfg'), 'secret config');
  const { updater, requests } = fixture('cod4');
  assert.deepEqual(await updater.update('cod4', dir), { id: 'cod4', version: PINS.cod4.version });
  assert.deepEqual(await fs.readFile(path.join(dir, PINS.cod4.target)), exe);
  assert.equal(await fs.readFile(path.join(dir, 'main', 'botserver.cfg'), 'utf8'), 'secret config');
  assert.deepEqual(requests, [[PINS.cod4.url, 'manual']]);
  assert.equal(updater.busy.size, 0);
  assert.deepEqual((await fs.readdir(dir)).filter(name => name.startsWith('.botland-engine-stage-')), []);
});

test('MW2 extracts exactly one allowed member and runs a visible launcher in the game folder', async t => {
  const dir = await folder(t, 'mw2');
  const calls = [];
  const { updater } = fixture('mw2', { run: async (file, args, options) => {
    calls.push([file, args, options]);
    assert.deepEqual(await fs.readFile(file), exe);
    await fs.writeFile(path.join(dir, 'iw4x.exe'), 'MZ installed');
  } });
  assert.deepEqual(await updater.update('mw2', dir), { id: 'mw2', version: PINS.mw2.version });
  assert.deepEqual(calls, [[path.join(dir, 'iw4x-launcher.exe'),
    ['--skip-launch', '--no-self-update', '--no-shortcuts', '--no-connect-protocol'],
    { cwd: dir, timeout: 7200000 }]]);
  assert.equal(await fs.readFile(path.join(dir, 'iw4x.exe'), 'utf8'), 'MZ installed');
});

test('unexpected ZIP members, bad hashes, oversized and truncated responses cannot run or publish', async t => {
  const dir = await folder(t, 'mw2');
  let runs = 0;
  const badZip = Buffer.from(zipSync({ 'iw4x-launcher.exe': exe, 'main/botserver.cfg': Buffer.from('attack') }));
  for (const [asset, expected] of [
    [badZip, /ZIP|size mismatch/u],
    [Buffer.alloc(zip.length, 0), /SHA-256/u],
    [zip.subarray(0, zip.length - 1), /size mismatch/u],
  ]) {
    const testPins = { ...pins, mw2: { ...pins.mw2, ...(asset === badZip ? { size: asset.length, sha256: sha(asset) } : {}) } };
    const updater = new EngineUpdater({ pins: testPins, fetch: async () => response(asset), run: async () => { runs++; } });
    await assert.rejects(updater.update('mw2', dir), expected);
  }
  assert.equal(runs, 0);
  assert.equal(await fs.stat(path.join(dir, 'iw4x-launcher.exe')).catch(() => null), null);
  const { updater } = fixture('mw2', { run: async () => { runs++; } });
  await assert.rejects(updater.update('mw2', dir), /journal was retained for manual inspection/u);
  assert.equal(runs, 1);
  assert.deepEqual(await fs.readFile(path.join(dir, 'iw4x-launcher.exe')), exe);
  await assert.rejects(updater.prepareLaunch('mw2', dir), /IW4x update journal remains/u);
});

test('redirects only reach IW3x or the signed GitHub release CDN', async t => {
  const dir = await folder(t, 'mw2');
  for (const location of ['http://github.com/iw4x/launcher', 'https://evil.example/a',
    'https://release-assets.githubusercontent.com.evil.example/a', 'https://github.com/iw4x/launcher/archive/x.zip',
    'https://user@release-assets.githubusercontent.com/a']) {
    const { updater } = fixture('mw2', { fetch: async () => response(null, 302, { location }) });
    await assert.rejects(updater.update('mw2', dir), /Unapproved/u, location);
  }
  const requested = [];
  const signed = 'https://release-assets.githubusercontent.com/download/signed?token=abc';
  const { updater } = fixture('mw2', { fetch: async url => {
    requested.push(url);
    return url === PINS.mw2.url ? response(null, 302, { location: signed }) : response(zip);
  }, run: async () => fs.writeFile(path.join(dir, 'iw4x.exe'), 'MZ') });
  await updater.update('mw2', dir);
  assert.deepEqual(requested, [PINS.mw2.url, signed]);
  const cod4 = await folder(t, 'cod4');
  const denied = fixture('cod4', { fetch: async () => response(null, 302, { location: signed }) });
  await assert.rejects(denied.updater.update('cod4', cod4), /Unapproved/u);
});

test('folder validation and unknown target files fail closed until explicit per-file consent', async t => {
  const dir = await folder(t, 'cod4');
  const { updater } = fixture('cod4');
  await assert.rejects(updater.update('bo2', dir), /Only CoD4 and MW2/u);
  await assert.rejects(updater.update('cod4', 'relative'), /Absolute/u);
  const target = path.join(dir, PINS.cod4.target);
  await fs.writeFile(target, 'MZ user version');
  await assert.rejects(updater.update('cod4', dir), /explicit consent/u);
  assert.equal(await fs.readFile(target, 'utf8'), 'MZ user version');
  const approved = fixture('cod4', { confirmOverwrite: async (id, file, hash) => {
    assert.equal(id, 'cod4'); assert.equal(file, target); assert.equal(hash, sha(Buffer.from('MZ user version'))); return true;
  } });
  await approved.updater.update('cod4', dir);
  assert.deepEqual(await fs.readFile(target), exe);
  const link = path.join(dir, 'junction');
  try { await fs.symlink(dir, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') return; throw error; }
  await assert.rejects(updater.update('cod4', link), /symlink|junction/u);
});

test('failed external launcher retains exact backups and refuses an unsafe partial rollback', async t => {
  const dir = await folder(t, 'mw2');
  const launcher = path.join(dir, 'iw4x-launcher.exe');
  const output = path.join(dir, 'iw4x.exe');
  await fs.writeFile(launcher, 'MZ old launcher');
  await fs.writeFile(output, 'MZ old game');
  const { updater } = fixture('mw2', { confirmOverwrite: () => true, run: async () => {
    await fs.writeFile(output, 'MZ replacement');
    throw new Error('Synthetic launcher failure');
  } });
  await assert.rejects(updater.update('mw2', dir), /Synthetic launcher failure.*journal was retained/u);
  assert.deepEqual(await fs.readFile(launcher), exe);
  assert.equal(await fs.readFile(output, 'utf8'), 'MZ replacement');
  const retained = (await fs.readdir(dir)).filter(name => name.startsWith('.botland-engine-stage-'));
  assert.equal(retained.length, 1);
  assert.equal(await fs.readFile(path.join(dir, retained[0], 'before-0'), 'utf8'), 'MZ old launcher');
  assert.equal(await fs.readFile(path.join(dir, retained[0], 'before-1'), 'utf8'), 'MZ old game');
  await assert.rejects(updater.prepareLaunch('mw2', dir), /IW4x update journal remains/u);
  await assert.rejects(updater.update('mw2', dir), /journal retained for manual inspection/u);

  // Deliberately simulate an interruption during launcher execution by leaving
  // a valid journal and an unrecorded output. Recovery must preserve both.
  const interrupted = await folder(t, 'mw2');
  const interruptedLauncher = path.join(interrupted, 'iw4x-launcher.exe');
  const interruptedOutput = path.join(interrupted, 'iw4x.exe');
  await fs.writeFile(interruptedLauncher, 'MZ previous launcher');
  await fs.writeFile(interruptedOutput, 'MZ previous game');
  const staged = await fs.mkdtemp(path.join(interrupted, '.botland-engine-stage-mw2-'));
  const beforeLauncher = await fs.readFile(interruptedLauncher);
  const beforeOutput = await fs.readFile(interruptedOutput);
  await fs.writeFile(path.join(staged, 'before-0'), beforeLauncher);
  await fs.writeFile(path.join(staged, 'before-1'), beforeOutput);
  await fs.writeFile(path.join(staged, 'journal.json'), JSON.stringify({ version: 1, id: 'mw2', folder: interrupted, files: [
    { name: 'iw4x-launcher.exe', before: sha(beforeLauncher), after: sha(exe) },
    { name: 'iw4x.exe', before: sha(beforeOutput), after: null },
  ] }));
  await fs.writeFile(interruptedOutput, 'MZ unrecorded change');
  await assert.rejects(updater.update('mw2', interrupted), /recovery conflict/u);
  assert.equal(await fs.readFile(interruptedOutput, 'utf8'), 'MZ unrecorded change');
  assert.ok(await fs.stat(staged));
});

test('interrupted CoD4 replacement restores its exact backup before retrying', async t => {
  const dir = await folder(t, 'cod4');
  const target = path.join(dir, PINS.cod4.target);
  const old = Buffer.from('MZ previous engine');
  const stage = await fs.mkdtemp(path.join(dir, '.botland-engine-stage-cod4-'));
  await fs.writeFile(path.join(stage, 'before-0'), old);
  await fs.writeFile(path.join(stage, 'moved-Cod4R-DedRun.exe'), old);
  await fs.writeFile(path.join(stage, 'journal.json'), JSON.stringify({ version: 1, id: 'cod4', folder: dir,
    files: [{ name: PINS.cod4.target, before: sha(old), after: sha(exe) }] }));
  const { updater } = fixture('cod4', { fetch: async () => { throw new Error('offline'); } });
  await fs.writeFile(path.join(stage, 'unknown-note.txt'), 'keep this synthetic file');
  await assert.rejects(updater.update('cod4', dir), /Unexpected engine stage contents/u);
  assert.equal(await fs.readFile(path.join(stage, 'unknown-note.txt'), 'utf8'), 'keep this synthetic file');
  await fs.rm(path.join(stage, 'unknown-note.txt'));
  await assert.rejects(updater.prepareLaunch('cod4', `${dir}${path.sep}`), /interrupted Cod4R DedRun update/u);
  await assert.rejects(updater.update('cod4', `${dir}${path.sep}`), /unavailable/u);
  assert.deepEqual(await fs.readFile(target), old);
  assert.equal(await fs.stat(stage).catch(() => null), null);
});

test('an unconfirmed launcher exit leaves a blocking journal rather than rolling back', async t => {
  const dir = await folder(t, 'mw2');
  const { updater } = fixture('mw2', { run: async () => {
    throw Object.assign(new Error('exit was not observed'), { processUnknown: true });
  } });
  await assert.rejects(updater.update('mw2', dir), /exit was not observed/u);
  const stages = (await fs.readdir(dir)).filter(name => name.startsWith('.botland-engine-stage-mw2-'));
  assert.equal(stages.length, 1);
  assert.equal(await fs.readFile(path.join(dir, stages[0], 'process-unknown'), 'utf8'), 'IW4x launcher exit was not observed.');
  await assert.rejects(updater.prepareLaunch('mw2', dir), /IW4x update journal remains/u);
  await assert.rejects(updater.update('mw2', dir), /journal retained for manual inspection/u);
});

test('busy is synchronous and released even after failure', async t => {
  const dir = await folder(t, 'cod4');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { updater } = fixture('cod4', { fetch: async () => { await gate; throw new Error('offline'); } });
  const work = updater.update('cod4', dir);
  assert.equal(updater.busy.has('cod4'), true);
  await assert.rejects(updater.update('cod4', dir), /already in progress/u);
  release();
  await assert.rejects(work, /unavailable/u);
  assert.equal(updater.busy.size, 0);
});
