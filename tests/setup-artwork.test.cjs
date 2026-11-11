const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { artworkFor, appIds } = require('../electron/artwork.cjs');
const { ServerManager } = require('../electron/manager.cjs');

async function temporary(testContext) {
  const root = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp', 'opencode');
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'botland-setup-art-'));
  testContext.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
const jpeg = tag => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(tag.padEnd(16, '.'))]);
const png = tag => Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from(tag.padEnd(16, '.'))]);
const decoded = image => Buffer.from(image.split(',')[1], 'base64').subarray(4).toString().replace(/\.+$/, '');

test('cards use wide Steam art, falling back from the hero to the store header and only then the tall cover', async t => {
  const cache = await temporary(t);
  const folder = path.join(cache, appIds.bo2);
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, 'library_600x900.jpg'), jpeg('tall'));
  assert.equal(decoded(await artworkFor('bo2', 'cover', undefined, [cache])), 'tall');
  await fs.writeFile(path.join(folder, 'header.jpg'), jpeg('header'));
  assert.equal(decoded(await artworkFor('bo2', 'cover', undefined, [cache])), 'header');
  await fs.writeFile(path.join(folder, 'library_hero.jpg'), jpeg('hero'));
  assert.equal(decoded(await artworkFor('bo2', 'cover', undefined, [cache])), 'hero');
  assert.equal(decoded(await artworkFor('bo2', 'hero', undefined, [cache])), 'hero');
});

test('the transparent game logo is read from the Steam cache, including hashed subfolders', async t => {
  const cache = await temporary(t);
  const nested = path.join(cache, appIds.mw2, '0123abcd');
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(path.join(nested, 'logo.png'), png('logo'));
  const logo = await artworkFor('mw2', 'logo', undefined, [cache]);
  assert.match(logo, /^data:image\/png;base64,/);
  await assert.rejects(artworkFor('mw2', 'wallpaper', undefined, [cache]), /Unknown artwork type/);
});

test('custom images replace the card and header, never the logo', async t => {
  const dir = await temporary(t);
  const custom = path.join(dir, 'custom.png');
  await fs.writeFile(custom, png('custom'));
  const manager = new ServerManager(path.join(dir, 'settings.json'), () => {});
  manager.detected = { steamPath: path.join(dir, 'no-steam'), games: {} };
  manager.data.games.cod4 = { artwork: { cover: custom, hero: custom, logo: custom } };
  assert.match(await manager.artwork('cod4', 'cover'), /^data:image\/png/);
  assert.match(await manager.artwork('cod4', 'hero'), /^data:image\/png/);
  const logo = await manager.artwork('cod4', 'logo');
  assert.ok(logo === null || !decoded(logo).startsWith('custom'), 'the logo comes from Steam only');
});

test('the setup checklist flags follow each preflight area for a Plutonium game', async t => {
  const dir = await temporary(t);
  const previous = process.env.LOCALAPPDATA;
  const local = path.join(dir, 'local');
  process.env.LOCALAPPDATA = local;
  t.after(() => { if (previous === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previous; });
  const game = path.join(dir, 'waw');
  await fs.mkdir(path.join(game, 'main'), { recursive: true });
  await fs.writeFile(path.join(game, 'CoDWaWmp.exe'), 'MZ');
  await fs.mkdir(path.join(game, 'zone', 'english'), { recursive: true });
  await fs.writeFile(path.join(game, 'zone', 'english', 'mp_castle.ff'), '');
  await fs.writeFile(path.join(game, 'zone', 'english', 'mp_castle_load.ff'), '');
  let stored = false;
  const keyStore = { async has() { return stored; }, async get() { return 'k'; }, async save() { stored = true; }, async remove() {} };
  const manager = new ServerManager(path.join(dir, 'settings.json'), () => {}, { keyStore });
  manager.data.games.waw = { gamePath: game };
  const flags = async () => (await manager.check('waw')).setup;
  assert.deepEqual(await flags(), { folder: true, engine: null, plutonium: false, key: false, bots: false, config: false, maps: true });
  const result = await manager.check('waw');
  assert.ok(result.blockers.some(text => /Click Install Plutonium/.test(text)));
  assert.ok(result.blockers.some(text => /Click Create server config/.test(text)));
  await fs.mkdir(path.join(local, 'Plutonium', 'bin'), { recursive: true });
  await fs.writeFile(path.join(local, 'Plutonium', 'bin', 'plutonium-bootstrapper-win32.exe'), 'MZ');
  stored = true;
  const mod = path.join(local, 'Plutonium', 'storage', 't4', 'mods', 'mp_bots');
  await fs.mkdir(mod, { recursive: true });
  await fs.writeFile(path.join(mod, 'z_svr_bots.iwd'), 'PK');
  await fs.writeFile(path.join(game, 'main', 'server.cfg'), 'set sv_hostname "x"\n');
  assert.deepEqual(await flags(), { folder: true, engine: null, plutonium: true, key: true, bots: true, config: true, maps: true });
});
