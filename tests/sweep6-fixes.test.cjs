const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { ServerManager } = require('../electron/manager.cjs');
const { profiles } = require('../electron/profiles.cjs');

async function temporary(testContext) {
  const root = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp', 'opencode');
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'botland-sweep6-'));
  testContext.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('an ambiguous orphan whose port belongs to a running managed server is not reported', async t => {
  const dir = await temporary(t);
  const manager = new ServerManager(path.join(dir, 'settings.json'), () => {}, {
    findPossibleOrphans: async candidates => candidates.map(candidate => ({
      id: candidate.id, pid: null, port: candidate.port, reason: 'UDP port occupied (ambiguous PID; process identity unverified)',
    })),
  });
  manager.broadcastState = async () => {};
  manager.detected = { steamPath: '', libraries: [], games: {
    cod4: { gamePath: dir, installed: true, enginePath: '', engineInstalled: false },
  } };

  // While running on port 28962, an ambiguous netstat result on port 28962 is its own listener
  manager.instances.set('cod4', { status: 'running', child: { pid: 9999 }, activePort: profiles.cod4.defaultPort });
  await manager.rescanOrphans();
  let card = (await manager.snapshot()).games.find(game => game.id === 'cod4');
  assert.equal(card.orphan, null, 'Running managed server must not flag itself as an unmanaged orphan');

  // Once stopped, that same ambiguous listener on UDP 28962 is correctly reported as an orphan
  manager.instances.delete('cod4');
  await manager.rescanOrphans();
  card = (await manager.snapshot()).games.find(game => game.id === 'cod4');
  assert.deepEqual(card.orphan, {
    pid: null, port: profiles.cod4.defaultPort,
    reason: 'UDP port occupied (ambiguous PID; process identity unverified)',
  }, 'Stopped server must report an occupied port as an orphan');
});

test('an ambiguous orphan on a different port is reported even when a server is running', async t => {
  const dir = await temporary(t);
  const manager = new ServerManager(path.join(dir, 'settings.json'), () => {}, {
    findPossibleOrphans: async candidates => candidates.map(candidate => ({
      id: candidate.id, pid: null, port: candidate.port, reason: 'UDP port occupied (ambiguous PID; process identity unverified)',
    })),
  });
  manager.broadcastState = async () => {};
  manager.detected = { steamPath: '', libraries: [], games: {
    cod4: { gamePath: dir, installed: true, enginePath: '', engineInstalled: false },
    waw: { gamePath: dir, installed: true, enginePath: '', engineInstalled: false },
  } };

  // CoD4 is running on 28962, but WaW (28963) is stopped and has an ambiguous listener
  manager.instances.set('cod4', { status: 'running', child: { pid: 9999 }, activePort: profiles.cod4.defaultPort });
  await manager.rescanOrphans();
  const card = (await manager.snapshot()).games.find(game => game.id === 'waw');
  assert.deepEqual(card.orphan, {
    pid: null, port: profiles.waw.defaultPort,
    reason: 'UDP port occupied (ambiguous PID; process identity unverified)',
  }, 'Stopped server must report its occupied port even when another server is running');
});
