const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { ServerManager } = require('../electron/manager.cjs');

const root = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp', 'opencode');

async function fixture(t) {
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'botland-sweep4-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function managerWithConfig(t) {
  const dir = await fixture(t);
  await fs.mkdir(path.join(dir, 'main'), { recursive: true });
  const file = path.join(dir, 'main', 'botserver.cfg');
  await fs.writeFile(file, 'set sv_hostname "Before"\r\n');
  const manager = new ServerManager(path.join(dir, 'settings.json'), () => {});
  manager.data.games.cod4 = { gamePath: dir };
  return { dir, file, manager };
}

test('a successful save is not reported as failed when the state broadcast rejects', async t => {
  const { file, manager } = await managerWithConfig(t);
  let broadcasts = 0;
  manager.broadcastState = async () => { broadcasts++; throw new Error('renderer is gone'); };
  const preview = await manager.previewSettings('cod4', 'base', 'dom', { sv_hostname: 'After' });
  const document = await manager.commitSettings('cod4', 'base', 'dom', { sv_hostname: 'After' }, preview.token);
  assert.equal(broadcasts, 1, 'the state notification must still be attempted');
  assert.equal(document.values.sv_hostname, 'After');
  assert.equal(document.path, file);
  assert.match(await fs.readFile(file, 'utf8'), /set sv_hostname "After"/);
});

test('a save that cannot be reloaded reports that it was saved instead of asking for a retry', async t => {
  const { file, manager } = await managerWithConfig(t);
  manager.broadcastState = async () => {};
  const preview = await manager.previewSettings('cod4', 'base', 'dom', { sv_hostname: 'After' });
  manager.document = async () => { throw new Error('synthetic read failure'); };
  await assert.rejects(
    manager.commitSettings('cod4', 'base', 'dom', { sv_hostname: 'After' }, preview.token),
    /saved, but it could not be reloaded/i,
  );
  assert.match(await fs.readFile(file, 'utf8'), /set sv_hostname "After"/, 'the file must remain committed');
});
