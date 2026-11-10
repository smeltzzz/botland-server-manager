const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { ServerManager } = require('../electron/manager.cjs');
const { profiles } = require('../electron/profiles.cjs');
const { previewConfig, saveConfig, readConfig } = require('../electron/config.cjs');
const { withConfigLock } = require('../electron/config-backups.cjs');

async function temporary(testContext) {
  const root = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp', 'opencode');
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'botland-sweep7-'));
  testContext.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('an ambiguous listener on a stopping server\'s own port is not reported as an orphan', async t => {
  const dir = await temporary(t);
  const manager = new ServerManager(path.join(dir, 'settings.json'), () => {}, dir, {
    findPossibleOrphans: async candidates => candidates.map(candidate => ({
      id: candidate.id, pid: null, port: candidate.port, reason: 'UDP port occupied (ambiguous PID; process identity unverified)',
    })),
  });
  manager.broadcastState = async () => {};
  manager.detected = { steamPath: '', libraries: [], games: {
    cod4: { gamePath: dir, installed: true, enginePath: '', engineInstalled: false },
  } };
  for (const status of ['starting', 'stopping']) {
    manager.instances.set('cod4', { status, child: { pid: 9999 }, activePort: profiles.cod4.defaultPort });
    await manager.rescanOrphans();
    const card = (await manager.snapshot()).games.find(game => game.id === 'cod4');
    assert.equal(card.orphan, null, status);
  }
  manager.instances.delete('cod4');
  await manager.rescanOrphans();
  assert.notEqual((await manager.snapshot()).games.find(game => game.id === 'cod4').orphan, null);
});

test('a save token is bound to the previewed file, even for byte-identical files', async t => {
  const dir = await temporary(t);
  const first = path.join(dir, 'first.cfg');
  const second = path.join(dir, 'second.cfg');
  const body = 'set sv_hostname "Before"\n';
  await fs.writeFile(first, body);
  await fs.writeFile(second, body);
  const { token } = await previewConfig(first, { sv_hostname: 'After' }, { id: 'cod4' });
  await assert.rejects(saveConfig(second, { sv_hostname: 'After' }, { id: 'cod4', token }), /changed since preview/i);
  assert.equal(await fs.readFile(second, 'utf8'), body);
  await saveConfig(first, { sv_hostname: 'After' }, { id: 'cod4', token });
  assert.equal((await readConfig(first, { id: 'cod4' })).sv_hostname, 'After');
});

test('a file with a UTF-16 marker but invalid contents reports a readable error', async t => {
  const dir = await temporary(t);
  const file = path.join(dir, 'server.cfg');
  // A lone high surrogate is not valid UTF-16.
  await fs.writeFile(file, Buffer.from([0xff, 0xfe, 0x00, 0xd8, 0x41, 0x00]));
  await assert.rejects(readConfig(file, { id: 'cod4' }), /not valid UTF-16/);
});

test('config saves and backup restores of one file share a single queue', async t => {
  const dir = await temporary(t);
  const file = path.join(dir, 'server.cfg');
  await fs.writeFile(file, 'set sv_hostname "Before"\n');
  const order = [];
  let release;
  let save;
  // Start the save only once the lock is held, so the queue order is known.
  const held = withConfigLock(file, () => new Promise(resolve => {
    release = resolve;
    order.push('held');
    save = saveConfig(file, { sv_hostname: 'After' }, { id: 'cod4' }).then(() => order.push('save'));
  }));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(order, ['held']);
  release();
  await held;
  await save;
  assert.deepEqual(order, ['held', 'save']);
});
