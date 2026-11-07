const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { parseConfig, parseLauncher, updateConfigText, saveConfig } = require('../electron/config.cjs');
const { scanMaps, rotationText } = require('../electron/maps.cjs');
const { profiles } = require('../electron/profiles.cjs');
const { ServerManager } = require('../electron/manager.cjs');

test('reads the effective value without reading comments or private fields', () => {
  const source = '// set sv_hostname "fake"\r\nset sv_hostname "First" // comment\r\nset sv_hostname "Second"\r\nset rcon_password "do not expose"\r\n';
  assert.deepEqual(parseConfig(source), { sv_hostname: 'Second' });
});
test('edits the last matching setting and retains formatting and unknown directives', () => {
  const source = 'set sv_maxclients "12"\r\n// custom\r\nset sv_maxclients "18"   // slots\r\nexec custom.cfg\r\n';
  const changed = updateConfigText(source, { sv_maxclients: '20' });
  assert.equal(changed, 'set sv_maxclients "12"\r\n// custom\r\nset sv_maxclients "20"   // slots\r\nexec custom.cfg\r\n');
});
test('rejects invalid config values and unknown keys', () => {
  assert.throws(() => updateConfigText('', { sv_hostname: 'hello"\nset rcon_password stolen' }));
  assert.throws(() => updateConfigText('', { rcon_password: 'no' }));
  assert.throws(() => updateConfigText('', { bots_manage_fill: '65' }));
  assert.throws(() => updateConfigText('', { bots_team: 'spectator; quit' }));
  assert.match(updateConfigText('set bots_main "1"', { bots_main: '0' }), /bots_main "0"/);
});
test('parses both quoted and unquoted launcher assignments', () => {
  assert.deepEqual(parseLauncher('set "gamepath=D:\\Games\\COD4"\r\nset key=exampleSecret\r\nset GamePort=28960\r\n'),
    { gamepath: 'D:\\Games\\COD4', key: 'exampleSecret', gameport: '28960' });
  assert.deepEqual(parseLauncher([
    'set GAMEPATH = "D:\\Games\\COD4"',
    "set \"basecfg=main\\server.cfg\"",
    'set "mod=mods/mp_bots"',
    'set extra=a=b',
    'rem set ignored=value',
    'set novalue',
  ].join('\r\n')), {
    gamepath: 'D:\\Games\\COD4',
    basecfg: 'main\\server.cfg',
    mod: 'mods/mp_bots',
    extra: 'a=b',
  });
});
test('renders engine-specific rotations', () => {
  const maps = ['mp_alpha', 'mp_bravo'];
  assert.match(rotationText(profiles.cod4, maps, 'dom', false), /gametype dom map mp_alpha gametype dom map mp_bravo/);
  assert.match(rotationText(profiles.mw2, maps, 'war', false), /sv_maprotation "map mp_alpha map mp_bravo"/);
  assert.match(rotationText(profiles.mw3, maps, 'DOM_default', false), /dsr DOM_default map mp_alpha map mp_bravo/);
  assert.match(rotationText(profiles.bo2, maps, 'dom', false), /execgts dom.cfg map mp_alpha map mp_bravo/);
  assert.throws(() => rotationText(profiles.bo2, ['mp_alpha'], 'dom', false));
  assert.throws(() => rotationText(profiles.cod4, ['mp_alpha;quit'], 'dom', false));
});
test('redacts Plutonium keys from renderer log events', () => {
  const events = [];
  const manager = new ServerManager('unused', event => events.push(event), 'unused');
  manager.addLog('bo2', 'server key=sample-secret-value', 'info', 'sample-secret-value');
  assert.equal(events[0].entry.message, 'server key=[REDACTED]');
  assert.ok(!JSON.stringify(manager.logs.get('bo2')).includes('sample-secret-value'));
});
test('uses the correct direct executable and LAN arguments for each title', () => {
  // The Plutonium launcher path is derived from %LOCALAPPDATA%. Pin it so the
  // assertion does not depend on the host shell, and restore it either way.
  const previousLocalAppData = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = 'C:\\Users\\botland\\AppData\\Local';
  try {
    const manager = new ServerManager('unused', () => {}, 'unused');
    const root = 'D:\\Games\\Installed Game';
    for (const id of ['cod4', 'waw', 'mw2', 'bo1', 'mw3', 'bo2']) {
      const command = manager.buildCommand(profiles[id], root, profiles[id].defaultPort, profiles[id].defaultMode, 'example-key');
      assert.equal(command.args.includes('+set'), true);
      assert.equal(command.args.includes(String(profiles[id].defaultPort)), true);
      assert.equal(command.args.includes('example-key'), !['cod4', 'mw2'].includes(id));
      // The launcher path is Windows-formatted on every host; assert Windows semantics.
      assert.ok(path.win32.isAbsolute(command.file), command.file);
      if (id === 'mw2') assert.equal(command.argv0, 'iw4x.exe');
      for (const lan of [true, false]) {
        const built = manager.buildCommand(profiles[id], root, profiles[id].defaultPort, profiles[id].defaultMode, 'example-key', lan);
        const argAfter = name => { const index = built.args.indexOf(name); return index === -1 ? null : built.args[index + 1]; };
        assert.equal(built.args.includes('-lan'), lan && !['cod4', 'mw2', 'bo1'].includes(id));
        if (id === 'cod4') assert.equal(argAfter('dedicated'), lan ? '1' : '2');
        if (id === 'mw2') assert.equal(argAfter('sv_lanonly'), lan ? '1' : '0');
      }
    }
  } finally {
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocalAppData;
  }
});
test('persists the visibility option with per-title defaults', async () => {
  const root = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp', 'opencode');
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'botland-visibility-'));
  try {
    const manager = new ServerManager(path.join(dir, 'settings.json'), () => {}, 'unused');
    manager.broadcastState = async () => {};
    assert.equal(manager.options('cod4').lan, true);
    assert.equal(manager.options('bo1').lan, false);
    await manager.saveOptions('waw', { lan: false });
    assert.equal(manager.options('waw').lan, false);
    await assert.rejects(manager.saveOptions('waw', { lan: 'public' }), /Invalid visibility option/);
    await manager.saveOptions('bo1', { lan: true });
    assert.equal(manager.options('bo1').lan, false);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('backs up the original config byte-for-byte when saving', async () => {
  const root = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp', 'opencode');
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'botland-test-'));
  try {
    const file = path.join(dir, 'server.cfg');
    const original = Buffer.from('set sv_maxclients "18"\r\ncustom directive\r\n', 'utf8');
    await fs.writeFile(file, original);
    await saveConfig(file, { sv_maxclients: '24' });
    const files = await fs.readdir(dir);
    const backup = files.find(name => name.startsWith('server.cfg.bak-'));
    assert.ok(backup);
    assert.deepEqual(await fs.readFile(path.join(dir, backup)), original);
    assert.match(await fs.readFile(file, 'utf8'), /set sv_maxclients "24"/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('cancels a start in progress before spawning a server', async () => {
  const manager = new ServerManager('unused', () => {}, 'unused');
  manager.broadcastState = async () => {};
  manager.addLog = () => {};
  manager.check = async () => ({ blockers: [], gamePath: 'unused', options: { port: 28960, mode: 'dom', shuffle: false, selectedMaps: [] } });
  manager.portInUse = async () => false;
  manager.maps = async () => ({ maps: ['mp_crash'], modes: [{ value: 'dom', label: 'Domination' }] });
  const started = manager.start('cod4');
  const stopped = manager.stop('cod4');
  await assert.rejects(started, /Launch cancelled/);
  await stopped;
  assert.equal(manager.hasRunning(), false);
});
test('only offers actual installed maps for CoD4', async () => {
  const root = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp', 'opencode');
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'botland-maps-'));
  try {
    const zone = path.join(dir, 'zone', 'english');
    await fs.mkdir(zone, { recursive: true });
    for (const name of ['mp_crash.ff', 'mp_crash_load.ff', 'mp_missing.ff']) await fs.writeFile(path.join(zone, name), '');
    assert.deepEqual(await scanMaps(profiles.cod4, dir), ['mp_crash']);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
