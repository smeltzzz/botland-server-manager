const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { ServerManager } = require('../electron/manager.cjs');
const { profiles } = require('../electron/profiles.cjs');
const { modeOptions } = require('../electron/maps.cjs');
const { downloadArchive } = require('../electron/botwarfare-download.cjs');
const { buildFirewallRemoveLines } = require('../electron/firewall-rule.cjs');
const { BotWarfareInstaller } = require('../electron/botwarfare-install.cjs');
const { ServerLogTail } = require('../electron/log-tail.cjs');

const release = 'https://github.com/ineedbots/iw3_bot_warfare/releases/download/v2.2.0/iw3bw220.zip';

async function temporary(testContext) {
  const root = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp', 'opencode');
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'botland-sweep8-'));
  testContext.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
function quietManager(dir, services = {}) {
  const manager = new ServerManager(path.join(dir, 'settings.json'), () => {}, services);
  manager.broadcastState = async () => {};
  return manager;
}
function stopTimers(testContext, manager) {
  testContext.after(() => { if (manager.orphanTimer) clearInterval(manager.orphanTimer); manager.orphanTimer = null; });
}
async function junction(target, link) {
  try { await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir'); return true; }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return false; throw error; }
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('an abandoned quit can be cancelled so Start works again', async t => {
  const dir = await temporary(t);
  const manager = quietManager(dir);
  stopTimers(t, manager);
  manager.rescanOrphans = async () => [];
  await manager.stopAll();
  assert.equal(manager.shuttingDown, true);
  await assert.rejects(manager.start('cod4'), /shutting down/);
  manager.cancelShutdown();
  assert.equal(manager.shuttingDown, false);
  assert.ok(manager.orphanTimer, 'the periodic orphan scan resumes');
  // Start now reaches preflight instead of refusing outright.
  await assert.rejects(manager.start('cod4'), error => !/shutting down/.test(error.message));
});

test('a Bot Warfare change in progress counts as work that must finish before quitting', async t => {
  const manager = quietManager(await temporary(t));
  assert.equal(manager.hasModWork(), false);
  manager.modBusy.add('cod4');
  assert.equal(manager.hasModWork(), true);
});

test('Start finishes installer recovery first and refuses to launch when it fails', async t => {
  const dir = await temporary(t);
  const calls = [];
  const modInstaller = {
    async prepareLaunch(id, gamePath) {
      calls.push([id, gamePath, manager.instances.has(id)]);
      throw new Error('Invalid Bot Warfare transaction journal; refusing to touch files.');
    },
  };
  const manager = quietManager(dir, { modInstaller });
  manager.data.games.cod4 = { gamePath: dir };
  await assert.rejects(manager.start('cod4'), /interrupted Bot Warfare change.*journal/);
  // Reserve before recovery so folder edits and duplicate Starts cannot race it.
  // prepareLaunch recovers journals without the explicit-mod-action running check.
  assert.deepEqual(calls, [['cod4', dir, true]]);
  assert.equal(manager.instances.has('cod4'), false);
  assert.ok(manager.logs.get('cod4').some(entry => /interrupted Bot Warfare change/.test(entry.message)));
});

test('installer launch preparation rejects a damaged stage folder and ignores clean targets', async t => {
  const dir = await temporary(t);
  const installer = new BotWarfareInstaller({ source: { resolveSource() {} }, localAppData: dir });
  await installer.prepareLaunch('cod4', dir);
  await fs.mkdir(path.join(dir, 'mods', '.botland-stage-cod4-bad'), { recursive: true });
  await assert.rejects(installer.prepareLaunch('cod4', dir), /Invalid Bot Warfare transaction journal/);
});

test('a game folder reached through a junction can still be managed by the installer', async t => {
  const dir = await temporary(t);
  const real = path.join(dir, 'real-game');
  await fs.mkdir(real);
  const link = path.join(dir, 'linked-game');
  if (!await junction(real, link)) return t.skip('Junctions are not available on this host.');
  const installer = new BotWarfareInstaller({ source: { resolveSource() {} }, localAppData: dir });
  const status = await installer.status('cod4', link);
  assert.equal(status.state, 'not-installed');
  // Links beneath the selected root are still refused.
  await fs.mkdir(path.join(real, 'mods'));
  const outside = path.join(dir, 'outside');
  await fs.mkdir(outside);
  await junction(outside, path.join(real, 'mods', 'mp_bots'));
  await assert.rejects(installer.status('cod4', link), /symlink or junction/);
});

test('the download timeout is an idle limit, with a separate overall cap', async () => {
  const slow = () => new ReadableStream({
    async start(controller) {
      for (let i = 0; i < 6; i++) { await new Promise(resolve => setTimeout(resolve, 20)); controller.enqueue(new Uint8Array([i])); }
      controller.close();
    },
  });
  // Six chunks 20 ms apart take longer than the 60 ms idle limit in total.
  const result = await downloadArchive(release, { timeoutMs: 60, fetch: async () => new Response(slow(), { status: 200 }) });
  assert.deepEqual([...result.bytes], [0, 1, 2, 3, 4, 5]);
  const trickle = () => new ReadableStream({
    async pull(controller) { await new Promise(resolve => setTimeout(resolve, 10)); controller.enqueue(new Uint8Array([1])); },
  });
  await assert.rejects(downloadArchive(release, { timeoutMs: 50, totalTimeoutMs: 80,
    fetch: async () => new Response(trickle(), { status: 200 }) }), /timed out/);
});

test('firewall removal uses checked NetSecurity cmdlets for an allowlisted rule name only', () => {
  const script = buildFirewallRemoveLines({ name: 'botLANd WaW UDP' }).join('\n');
  assert.match(script, /Remove-NetFirewallRule -PolicyStore PersistentStore -Name/);
  assert.match(script, /still active/);
  assert.doesNotMatch(script, /netsh|2>&1/);
  assert.throws(() => buildFirewallRemoveLines({ name: "x'; Remove-Item C:\\" }), /Unknown botLANd firewall rule/);
});

test('a refused automatic restart still refreshes the UI', async t => {
  const dir = await temporary(t);
  let fire;
  const manager = new ServerManager(path.join(dir, 'settings.json'), () => {}, {
    restartTimers: { now: Date.now, setTimeout: callback => { fire = callback; return 1; }, clearTimeout() {} },
  });
  let broadcasts = 0;
  manager.broadcastState = async () => { broadcasts++; };
  manager.data.games.cod4 = { autoRestart: true };
  manager.launch = async () => { throw new Error('The manager is shutting down.'); };
  const instance = { status: 'running', child: { pid: 1 }, startedAt: new Date().toISOString(), logTail: null, sessionStarted: false };
  manager.instances.set('cod4', instance);
  assert.equal(manager.scheduleRestart('cod4', instance), true);
  fire();
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(manager.instances.has('cod4'), false);
  assert.ok(broadcasts >= 1, 'state is broadcast after the refused retry');
});

test('a saved setting is not reported as failed when the follow-up refresh fails', async t => {
  const dir = await temporary(t);
  const manager = new ServerManager(path.join(dir, 'settings.json'), () => {});
  manager.broadcastState = async () => { throw new Error('renderer gone'); };
  await manager.setUpdateChecks(false);
  assert.equal(manager.data.updatesEnabled, false);
  await manager.setAutoRestart('cod4', true);
  assert.equal(manager.data.games.cod4.autoRestart, true);
});

test('the game folder cannot change while a Bot Warfare change is running', async t => {
  const dir = await temporary(t);
  const manager = quietManager(dir);
  manager.modBusy.add('mw2');
  await fs.writeFile(path.join(dir, 'iw4mp.exe'), 'MZ');
  const dialog = { showOpenDialog: async () => ({ canceled: false, filePaths: [dir] }) };
  await assert.rejects(manager.chooseFolder('mw2', null, dialog), /Bot Warfare change to finish/);
  assert.equal(manager.data.games.mw2, undefined);
});

test('UTF-16 BO2 mode files are listed like UTF-8 ones', async t => {
  const dir = await temporary(t);
  const folder = path.join(dir, 'main', 'gamesettings');
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'tdm.cfg'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('set_gametype tdm\r\n', 'utf16le')]));
  await fs.writeFile(path.join(folder, 'dom.cfg'), 'set_gametype dom\n');
  const modes = (await modeOptions(profiles.bo2, dir)).map(mode => mode.value).sort();
  assert.deepEqual(modes, ['dom', 'tdm']);
});

test('Plutonium games are blocked with a clear reason when LOCALAPPDATA is missing', async t => {
  const dir = await temporary(t);
  const previous = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = '';
  t.after(() => { if (previous === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previous; });
  const manager = quietManager(dir);
  manager.data.games.waw = { gamePath: dir };
  const result = await manager.check('waw');
  assert.ok(result.blockers.some(blocker => /LOCALAPPDATA/.test(blocker)));
  assert.ok(!result.blockers.some(blocker => /bootstrapper missing at Plutonium/.test(blocker)), 'no working-directory-relative path is reported');
});

test('a missing server config is reported as a structured flag', async t => {
  const dir = await temporary(t);
  const manager = quietManager(dir);
  manager.data.games.cod4 = { gamePath: dir };
  const card = (await manager.snapshot()).games.find(game => game.id === 'cod4');
  assert.equal(card.configMissing, true);
  assert.ok(card.blockers.some(blocker => blocker.startsWith('Server config missing')));
});

test('a log whose write time changes without new bytes is not replayed', async t => {
  const dir = await temporary(t);
  const file = path.join(dir, 'main', 'console_mp.log');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, 'previous session\n');
  const lines = [];
  const tail = new ServerLogTail({ id: 'cod4', gamePath: dir, localAppData: dir, onLine: line => lines.push(line), intervalMs: 60_000 });
  try {
    await tail.start();
    await fs.appendFile(file, 'one\n');
    await tail.poll();
    const later = new Date(Date.now() + 30_000);
    await fs.utimes(file, later, later);
    await tail.poll();
    assert.deepEqual(lines, ['one']);
    // A rewrite of the same size with different content still starts over.
    await fs.writeFile(file, 'X'.repeat('previous session\none\n'.length - 1) + '\n');
    const latest = new Date(Date.now() + 60_000);
    await fs.utimes(file, latest, latest);
    await tail.poll();
    assert.equal(lines.length, 2);
  } finally { await tail.stop(); }
});

test('logs are tailed through a junctioned game folder', async t => {
  const dir = await temporary(t);
  const real = path.join(dir, 'real');
  await fs.mkdir(path.join(real, 'main'), { recursive: true });
  const link = path.join(dir, 'linked');
  if (!await junction(real, link)) return t.skip('Junctions are not available on this host.');
  const file = path.join(real, 'main', 'console_mp.log');
  await fs.writeFile(file, '');
  const lines = [];
  const tail = new ServerLogTail({ id: 'cod4', gamePath: link, localAppData: dir, onLine: line => lines.push(line), intervalMs: 60_000 });
  try {
    await tail.start();
    await fs.appendFile(file, 'through the junction\n');
    await tail.poll();
    assert.deepEqual(lines, ['through the junction']);
  } finally { await tail.stop(); }
});
