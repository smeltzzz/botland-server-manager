const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { ServerManager } = require('../electron/manager.cjs');

async function temporary(t) {
  const base = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp', 'opencode');
  await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, 'botland-readiness-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function put(file, contents = '') {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
}

test('CoD4 readiness reports absent maps and stale selections before Start', async t => {
  const dir = await temporary(t);
  const manager = new ServerManager(path.join(dir, 'settings.json'), () => {}, '');
  manager.data.games.cod4 = { gamePath: dir };
  await put(path.join(dir, 'main', 'botserver.cfg'), 'set sv_hostname "Fixture"\n');
  await put(path.join(dir, 'Cod4R-DedRun.exe'));
  await put(path.join(dir, 'mods', 'mp_bots', 'z_svr_bots.iwd'));
  let check = await manager.check('cod4');
  assert.match(check.blockers.join(' '), /No playable multiplayer maps/);
  await put(path.join(dir, 'zone', 'english', 'mp_crash.ff'));
  assert.match((await manager.check('cod4')).blockers.join(' '), /No playable multiplayer maps/);
  await put(path.join(dir, 'zone', 'english', 'mp_crash_load.ff'));
  check = await manager.check('cod4');
  assert.deepEqual(check.blockers, []);
  manager.data.games.cod4.selectedMaps = ['mp_missing'];
  assert.match((await manager.check('cod4')).blockers.join(' '), /Saved map selection/);
});

test('BO2 readiness requires a matching multiplayer ruleset and two maps', async t => {
  const dir = await temporary(t);
  const original = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = path.join(dir, 'local');
  t.after(() => { if (original === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = original; });
  const gamePath = path.join(dir, 'game');
  const manager = new ServerManager(path.join(dir, 'settings.json'), () => {}, '');
  manager.data.games.bo2 = { gamePath };
  await put(path.join(gamePath, 't6mp.exe'));
  await put(path.join(gamePath, 'main', 'dedicated.cfg'), 'exec rotation_dom_shuffled.cfg\n');
  await put(path.join(gamePath, 'zone', 'english', 'mp_one.ff'));
  let check = await manager.check('bo2');
  assert.match(check.blockers.join(' '), /T6 multiplayer ruleset missing/);
  assert.match(check.blockers.join(' '), /at least two installed multiplayer maps/);
  await put(path.join(gamePath, 'main', 'gamesettings', 'dom.cfg'), 'set_gametype zm\n');
  assert.match((await manager.check('bo2')).blockers.join(' '), /T6 multiplayer ruleset missing/);
  await put(path.join(gamePath, 'main', 'gamesettings', 'dom.cfg'), 'set_gametype dom\n');
  await put(path.join(gamePath, 'zone', 'english', 'mp_two.ff'));
  check = await manager.check('bo2');
  assert.ok(!check.blockers.some(message => /ruleset missing|at least two installed multiplayer maps/.test(message)), check.blockers.join('\n'));
  manager.data.games.bo2.selectedMaps = ['mp_one'];
  assert.match((await manager.check('bo2')).blockers.join(' '), /at least two selected maps/);
});
