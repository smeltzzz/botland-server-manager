const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { ServerManager } = require('../electron/manager.cjs');
const { modeOptions } = require('../electron/maps.cjs');
const { profiles } = require('../electron/profiles.cjs');

async function temporary(testContext) {
  const root = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp', 'opencode');
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'botland-sweep5-'));
  testContext.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('an ambiguous orphan keeps its warning with an explicitly unknown PID', async t => {
  const dir = await temporary(t);
  const reason = 'UDP port occupied (ambiguous PID; process identity unverified)';
  const manager = new ServerManager(path.join(dir, 'settings.json'), () => {}, dir, {
    // The real scan reports pid: null when the two address families disagree.
    findPossibleOrphans: async candidates => candidates.map(candidate => ({ id: candidate.id, pid: null, port: candidate.port, reason })),
  });
  manager.broadcastState = async () => {};
  manager.detected = { steamPath: '', libraries: [], games: {
    cod4: { gamePath: dir, installed: true, enginePath: '', engineInstalled: false },
  } };
  await manager.rescanOrphans();
  const card = (await manager.snapshot()).games.find(game => game.id === 'cod4');
  // The warning must survive, and must never be backfilled with a made-up PID.
  assert.deepEqual(card.orphan, { pid: null, port: profiles.cod4.defaultPort, reason });
  // The renderer only ever receives a serialized snapshot; null must survive it.
  assert.equal(JSON.parse(JSON.stringify(card.orphan)).pid, null);
});

test('an orphan whose PID belongs to a managed server is not reported', async t => {
  const dir = await temporary(t);
  const manager = new ServerManager(path.join(dir, 'settings.json'), () => {}, dir, {
    findPossibleOrphans: async candidates => candidates.map(candidate => ({
      id: candidate.id, pid: 4321, port: candidate.port, reason: 'UDP port occupied (process identity unverified)',
    })),
  });
  manager.broadcastState = async () => {};
  manager.detected = { steamPath: '', libraries: [], games: {
    cod4: { gamePath: dir, installed: true, enginePath: '', engineInstalled: false },
  } };
  manager.instances.set('cod4', { status: 'running', child: { pid: 4321 }, activePort: profiles.cod4.defaultPort });
  await manager.rescanOrphans();
  const card = (await manager.snapshot()).games.find(game => game.id === 'cod4');
  assert.equal(card.orphan, null);
});

test('resetting one artwork kind leaves the other custom image in place', async t => {
  const dir = await temporary(t);
  const manager = new ServerManager(path.join(dir, 'settings.json'), () => {}, dir);
  const cover = path.join(dir, 'custom-cover.png');
  const hero = path.join(dir, 'custom-hero.png');
  manager.data.games.cod4 = { artwork: { cover, hero } };
  await manager.resetArtwork('cod4', 'hero');
  // "Use Steam header" must not discard a cover the user picked separately.
  assert.deepEqual(manager.data.games.cod4.artwork, { cover });
  await manager.resetArtwork('cod4', 'cover');
  assert.deepEqual(manager.data.games.cod4.artwork, {});
});

test('per-title gametype names stay distinct so the browser preview can mirror them', async t => {
  const dir = await temporary(t);
  const cod4 = await modeOptions(profiles.cod4, dir);
  const mw2 = await modeOptions(profiles.mw2, dir);
  const waw = await modeOptions(profiles.waw, dir);
  const bo1 = await modeOptions(profiles.bo1, dir);
  // IW3 and IW4 call team deathmatch "war"; T4 and T5 call it "tdm".
  for (const modes of [cod4, mw2]) assert.ok(modes.some(mode => mode.value === 'war'));
  for (const modes of [waw, bo1]) {
    assert.ok(modes.some(mode => mode.value === 'tdm'));
    assert.ok(!modes.some(mode => mode.value === 'war'));
  }
});
