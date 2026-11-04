const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pruneRelease } = require('../scripts/prune-release.cjs');

async function withRelease(run) {
  const root = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp', 'opencode');
  await fs.mkdir(root, { recursive: true });
  const release = await fs.mkdtemp(path.join(root, 'botland-release-test-'));
  try { await run(release); } finally { await fs.rm(release, { recursive: true, force: true }); }
}
const keep = ['botLANd Server Manager Setup 0.2.1.exe', 'botLANd Server Manager 0.2.1.exe'];

test('prunes only old versioned botLANd files after a complete build', async () => withRelease(async dir => {
  const old = ['BotLANd Server Manager Setup 0.2.0.exe', 'BotLANd Server Manager Setup 0.2.0.exe.blockmap', 'BotLANd Server Manager 0.1.0.exe'];
  const other = ['botLANd Server Manager Setup 0.2.1.exe.blockmap', 'unrelated.exe', 'builder-debug.yml'];
  for (const name of [...keep, ...old, ...other]) await fs.writeFile(path.join(dir, name), name);
  await fs.mkdir(path.join(dir, 'win-unpacked'));
  await fs.writeFile(path.join(dir, 'win-unpacked', 'custom.txt'), 'leave intact');
  assert.deepEqual((await pruneRelease(dir, '0.2.1', 'botLANd Server Manager')).sort(), old.sort());
  assert.deepEqual((await fs.readdir(dir)).sort(), [...keep, ...other, 'win-unpacked'].sort());
  assert.equal(await fs.readFile(path.join(dir, 'win-unpacked', 'custom.txt'), 'utf8'), 'leave intact');
}));

test('does not delete old releases if the current installer or portable app is missing', async () => withRelease(async dir => {
  const old = 'BotLANd Server Manager 0.2.0.exe';
  await fs.writeFile(path.join(dir, old), 'previous working version');
  await fs.writeFile(path.join(dir, keep[0]), 'only installer built');
  await assert.rejects(pruneRelease(dir, '0.2.1', 'botLANd Server Manager'), /ENOENT|Missing completed release/);
  assert.equal(await fs.readFile(path.join(dir, old), 'utf8'), 'previous working version');
}));

test('rejects unexpected release identities without deleting files', async () => withRelease(async dir => {
  for (const name of keep) await fs.writeFile(path.join(dir, name), 'build');
  await assert.rejects(pruneRelease(dir, '../outside', 'botLANd Server Manager'));
  await assert.rejects(pruneRelease(dir, '0.2.1', 'Other App'));
  assert.deepEqual((await fs.readdir(dir)).sort(), [...keep].sort());
}));
