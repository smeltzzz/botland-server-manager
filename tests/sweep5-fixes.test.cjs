const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { artworkFor } = require('../electron/artwork.cjs');
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

// The art reader only sniffs the file signature, so a minimal JPEG header is enough.
const jpeg = marker => Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.alloc(32, marker)]);

test('artwork searches a detected Steam install before hard-coded Program Files paths', async t => {
  const dir = await temporary(t);
  const cache = path.join(dir, 'Steam', 'appcache', 'librarycache', '7940');
  await fs.mkdir(cache, { recursive: true });
  await fs.writeFile(path.join(cache, 'library_hero.jpg'), jpeg(0x5a));
  const image = await artworkFor('cod4', 'hero', undefined, [path.join(dir, 'Steam', 'appcache', 'librarycache')]);
  assert.equal(image, `data:image/jpeg;base64,${jpeg(0x5a).toString('base64')}`);
});

test('manager artwork uses the Steam path found by detection', async t => {
  const dir = await temporary(t);
  const steam = path.join(dir, 'Custom Steam');
  const cache = path.join(steam, 'appcache', 'librarycache', '7940');
  await fs.mkdir(cache, { recursive: true });
  await fs.writeFile(path.join(cache, 'library_600x900.jpg'), jpeg(0x6b));
  const manager = new ServerManager(path.join(dir, 'settings.json'), () => {});
  manager.detected = { steamPath: steam, games: {} };
  const image = await manager.artwork('cod4', 'cover');
  assert.equal(image, `data:image/jpeg;base64,${jpeg(0x6b).toString('base64')}`);
});

test('an ambiguous orphan keeps its warning with an explicitly unknown PID', async t => {
  const dir = await temporary(t);
  const reason = 'UDP port occupied (ambiguous PID; process identity unverified)';
  const manager = new ServerManager(path.join(dir, 'settings.json'), () => {}, {
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
  const manager = new ServerManager(path.join(dir, 'settings.json'), () => {}, {
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
  const manager = new ServerManager(path.join(dir, 'settings.json'), () => {});
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
