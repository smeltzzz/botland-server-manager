const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { PlutoniumUpdater, downloadUpdater, UPDATER_URL } = require('../electron/plutonium-update.cjs');
const { ServerManager } = require('../electron/manager.cjs');

async function temporary(testContext) {
  const root = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp', 'opencode');
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'botland-plutonium-'));
  testContext.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
const payload = Buffer.from('MZ synthetic updater');
const digest = createHash('sha256').update(payload).digest('hex');
function respond(bytes = payload, status = 200, headers = {}) {
  return new Response(bytes === null ? null : new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }), { status, headers });
}
// An updater whose download and run are both synthetic; "running" creates the bootstrapper.
function fixture(dir, { run, fetch, now } = {}) {
  const bootstrapper = path.join(dir, 'local', 'Plutonium', 'bin', 'plutonium-bootstrapper-win32.exe');
  const calls = { fetch: 0, run: [] };
  const updater = new PlutoniumUpdater({
    userData: path.join(dir, 'user'), bootstrapper: () => bootstrapper, launchers: async () => [], now,
    fetch: fetch || (async url => { calls.fetch++; assert.equal(url, UPDATER_URL); return respond(); }),
    run: run || (async (file, args, options) => {
      calls.run.push([file, args, options.cwd]);
      await fs.mkdir(path.dirname(bootstrapper), { recursive: true });
      await fs.writeFile(bootstrapper, 'MZ');
    }),
  });
  return { updater, bootstrapper, calls };
}
// The real pinned digest cannot match synthetic bytes, so tests pin their own.
function pinned(updater, hash = digest) {
  const original = updater.ensureUpdater.bind(updater);
  updater.ensureUpdater = async () => {
    if (await fs.access(updater.exe).then(() => true, () => false)) return;
    await fs.mkdir(updater.dir, { recursive: true });
    await fs.writeFile(updater.exe, await downloadUpdater({ fetch: updater.fetch, sha256: hash }));
  };
  return original;
}

test('the updater download is pinned, size-limited and only follows plutonium.pw redirects', async () => {
  assert.deepEqual(await downloadUpdater({ fetch: async () => respond(), sha256: digest }), payload);
  await assert.rejects(downloadUpdater({ fetch: async () => respond() }), /did not match the verified version/);
  await assert.rejects(downloadUpdater({ fetch: async () => respond(null, 500), sha256: digest }), /Could not download Plutonium/);
  await assert.rejects(downloadUpdater({ fetch: async () => { throw new Error('offline'); }, sha256: digest }), /Could not download Plutonium/);
  const requested = [];
  await assert.rejects(downloadUpdater({ sha256: digest, fetch: async url => {
    requested.push(url);
    return respond(null, 302, { location: 'https://evil.example/plutonium.exe' });
  } }), /unexpected address/);
  assert.deepEqual(requested, [UPDATER_URL]);
  const hops = [];
  const bytes = await downloadUpdater({ sha256: digest, fetch: async url => {
    hops.push(url);
    return hops.length === 1 ? respond(null, 302, { location: 'https://cdn.plutonium.pw/updater/v2/plutonium.exe' }) : respond();
  } });
  assert.deepEqual(bytes, payload);
  await assert.rejects(downloadUpdater({ url: 'http://cdn.plutonium.pw/updater/plutonium.exe', sha256: digest, fetch: async () => respond() }), /unexpected address/);
  await assert.rejects(downloadUpdater({ sha256: digest, fetch: async () => respond(payload, 200, { 'content-length': String(64 * 1024 * 1024) }) }), /larger than expected/);
  const stalled = () => new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }), { status: 200 });
  await assert.rejects(downloadUpdater({ sha256: digest, idleTimeoutMs: 30, fetch: async () => stalled() }), /timed out/);
});

test('install downloads the updater once, runs -update-only and records the time', async t => {
  const dir = await temporary(t);
  const { updater, bootstrapper, calls } = fixture(dir, { now: () => Date.parse('2026-11-10T12:00:00Z') });
  pinned(updater);
  assert.deepEqual(await updater.status(), { installed: false, updating: false, lastUpdated: null, error: null });
  await updater.update();
  assert.equal(calls.fetch, 1);
  assert.deepEqual(calls.run, [[updater.exe, ['-update-only'], updater.dir]]);
  assert.equal(await fs.readFile(bootstrapper, 'utf8'), 'MZ');
  assert.deepEqual(await updater.status(), { installed: true, updating: false, lastUpdated: '2026-11-10T12:00:00.000Z', error: null });
  await updater.update();
  assert.equal(calls.fetch, 1, 'an existing updater is reused');
  assert.equal(calls.run.length, 2);
});

test('concurrent update requests share one run', async t => {
  const dir = await temporary(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { updater, bootstrapper, calls } = fixture(dir, { run: async () => {
    calls.run.push('run');
    await gate;
    await fs.mkdir(path.dirname(bootstrapper), { recursive: true });
    await fs.writeFile(bootstrapper, 'MZ');
  } });
  pinned(updater);
  const first = updater.update();
  const second = updater.update();
  assert.equal(first, second);
  assert.equal(updater.updating, true);
  release();
  await Promise.all([first, second]);
  assert.equal(calls.run.length, 1);
  assert.equal(updater.updating, false);
});

test('a failed update reports a readable error and never claims success', async t => {
  const dir = await temporary(t);
  const { updater } = fixture(dir, { run: async () => { throw new Error('The Plutonium updater exited with code 5.'); } });
  pinned(updater);
  await assert.rejects(updater.update(), /exited with code 5/);
  const status = await updater.status();
  assert.equal(status.installed, false);
  assert.equal(status.lastUpdated, null);
  assert.match(status.error, /exited with code 5/);
  // An updater that "succeeds" without producing Plutonium is still a failure.
  const quiet = fixture(path.join(dir, 'quiet'), { run: async () => {} });
  pinned(quiet.updater);
  await assert.rejects(quiet.updater.update(), /was not found afterwards/);
});

test('launch preparation updates at most every six hours and only blocks when Plutonium is missing', async t => {
  const dir = await temporary(t);
  let clock = Date.parse('2026-11-10T12:00:00Z');
  let fail = false;
  const runs = [];
  const bootstrapper = path.join(dir, 'local', 'Plutonium', 'bin', 'plutonium-bootstrapper-win32.exe');
  const updater = new PlutoniumUpdater({ userData: path.join(dir, 'user'), bootstrapper: () => bootstrapper, launchers: async () => [], now: () => clock,
    fetch: async () => respond(),
    run: async () => {
      runs.push(clock);
      if (fail) throw new Error('The Plutonium updater exited with code 1.');
      await fs.mkdir(path.dirname(bootstrapper), { recursive: true });
      await fs.writeFile(bootstrapper, 'MZ');
    } });
  pinned(updater);
  const logs = [];
  const log = (text, level = 'info') => logs.push([level, text]);
  // Missing Plutonium: a failed install blocks the launch.
  fail = true;
  await assert.rejects(updater.prepareLaunch({ log }), /Plutonium could not be installed: .*code 1/);
  fail = false;
  assert.deepEqual(await updater.prepareLaunch({ log }), { updated: true });
  assert.ok(logs.some(([, text]) => text === 'Plutonium installed.'));
  // Fresh: no second run.
  clock += 60 * 60 * 1000;
  assert.deepEqual(await updater.prepareLaunch({ log }), { updated: false });
  assert.equal(runs.length, 2);
  // Stale and failing: the installed version is used with a logged warning.
  clock += 6 * 60 * 60 * 1000;
  fail = true;
  assert.deepEqual(await updater.prepareLaunch({ log }), { updated: false });
  assert.equal(runs.length, 3);
  assert.ok(logs.some(([level, text]) => level === 'error' && /Starting with the installed version/.test(text)));
  // Skipped (another Plutonium server is running): never runs the updater.
  assert.deepEqual(await updater.prepareLaunch({ log, skip: true }), { updated: false });
  assert.equal(runs.length, 3);
});

test('a Plutonium Start runs the update before preflight and logs it to that server', async t => {
  const dir = await temporary(t);
  const order = [];
  const plutonium = {
    updating: false,
    async status() { return { installed: true, updating: false, lastUpdated: null, error: null }; },
    async prepareLaunch({ log, skip }) { order.push(['prepare', skip]); log('Checking for Plutonium updates…'); return { updated: true }; },
    update() { throw new Error('unexpected'); },
  };
  const manager = new ServerManager(path.join(dir, 'settings.json'), () => {}, { plutonium });
  manager.broadcastState = async () => {};
  manager.check = async () => { order.push(['check']); return { blockers: ['stop here'] }; };
  await assert.rejects(manager.start('waw'), /stop here/);
  assert.deepEqual(order, [['prepare', false], ['check']]);
  assert.ok(manager.logs.get('waw').some(entry => entry.message === 'Checking for Plutonium updates…'));
  // Non-Plutonium engines never touch the updater.
  order.length = 0;
  await assert.rejects(manager.start('cod4'), /stop here/);
  assert.deepEqual(order, [['check']]);
  // Another live Plutonium server makes the launch skip the update.
  order.length = 0;
  manager.instances.set('bo2', { status: 'running', child: { pid: 1 } });
  await assert.rejects(manager.start('waw'), /stop here/);
  assert.deepEqual(order, [['prepare', true], ['check']]);
});

test('manual Plutonium updates refuse while a Plutonium server is active and count as unfinished work', async t => {
  const dir = await temporary(t);
  let release;
  const plutonium = {
    updating: false,
    async status() { return { installed: true, updating: this.updating, lastUpdated: null, error: null }; },
    update() {
      this.updating = true;
      return new Promise(resolve => { release = () => { this.updating = false; resolve(); }; });
    },
  };
  const manager = new ServerManager(path.join(dir, 'settings.json'), () => {}, { plutonium });
  manager.broadcastState = async () => {};
  manager.instances.set('mw3', { status: 'starting' });
  await assert.rejects(manager.updatePlutonium(), /Stop every Plutonium server/);
  manager.instances.clear();
  // A CoD4 server does not use Plutonium and does not block the update.
  manager.instances.set('cod4', { status: 'running' });
  const pending = manager.updatePlutonium();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(manager.hasModWork(), true, 'quitting waits for the update');
  release();
  assert.equal(await pending, true);
  assert.equal(manager.hasModWork(), false);
  const snapshot = await manager.snapshot();
  assert.deepEqual(snapshot.plutonium, { available: true, installed: true, updating: false, lastUpdated: null, error: null });
  assert.equal(snapshot.root, undefined);
});

test('an open Plutonium launcher blocks the update, and only the launcher the update opened is closed', async t => {
  const dir = await temporary(t);
  const bootstrapper = path.join(dir, 'local', 'Plutonium', 'bin', 'plutonium-bootstrapper-win32.exe');
  let running = [{ pid: 500, ppid: 1 }];
  const killed = [];
  let runs = 0;
  const updater = new PlutoniumUpdater({
    userData: path.join(dir, 'user'), bootstrapper: () => bootstrapper, launchers: async () => [], fetch: async () => respond(),
    launchers: async () => running, kill: pid => { killed.push(pid); running = running.filter(item => item.pid !== pid); },
    run: async (file, args, { onSpawn }) => {
      runs++;
      onSpawn(4242);
      await fs.mkdir(path.dirname(bootstrapper), { recursive: true });
      await fs.writeFile(bootstrapper, 'MZ');
      // The real updater opens the launcher as it finishes.
      running.push({ pid: 900, ppid: 4242 });
    },
  });
  pinned(updater);
  await assert.rejects(updater.update(), /Close the Plutonium launcher window first/);
  assert.equal(runs, 0, 'the updater never starts while the launcher is open');
  running = [];
  await updater.update();
  assert.deepEqual(killed, [900]);
  // A launcher the user opens during the update (another parent) is left alone.
  running = [];
  updater.run = async (file, args, { onSpawn }) => { onSpawn(5555); running.push({ pid: 901, ppid: 1 }, { pid: 902, ppid: 5555 }); };
  await updater.update();
  assert.deepEqual(killed, [900, 902]);
  assert.deepEqual(running, [{ pid: 901, ppid: 1 }]);
  // An installed Plutonium still starts when the launcher blocks the update.
  const logs = [];
  await fs.rm(updater.stateFile, { force: true }); // Make the last update stale.
  assert.deepEqual(await updater.prepareLaunch({ log: text => logs.push(text) }), { updated: false });
  assert.ok(logs.some(text => /Close the Plutonium launcher window first/.test(text)));
});

test('the updater requires an absolute app data folder', () => {
  assert.throws(() => new PlutoniumUpdater({ userData: 'relative' }), /absolute app data folder/);
});
