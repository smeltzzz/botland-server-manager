const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { artworkFor } = require('../electron/artwork.cjs');
const { ServerManager } = require('../electron/manager.cjs');

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
  const manager = new ServerManager(path.join(dir, 'settings.json'), () => {}, dir);
  manager.detected = { steamPath: steam, games: {} };
  const image = await manager.artwork('cod4', 'cover');
  assert.equal(image, `data:image/jpeg;base64,${jpeg(0x6b).toString('base64')}`);
});
