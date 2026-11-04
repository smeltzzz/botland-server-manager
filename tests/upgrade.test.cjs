const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { schemaFor, fieldFor } = require('../electron/schema.cjs');
const { inspectText, updateConfigText, previewConfig, saveConfig } = require('../electron/config.cjs');
const { mimeFor, appIds } = require('../electron/artwork.cjs');
const { ServerManager } = require('../electron/manager.cjs');
const { modeOptions } = require('../electron/maps.cjs');
const { profiles } = require('../electron/profiles.cjs');

const opts = (id, target = 'base', mode = 'dom') => ({ id, target, mode });
test('all six games map to local Steam artwork identifiers', () => {
  assert.deepEqual(Object.keys(appIds).sort(), ['bo1', 'bo2', 'cod4', 'mw2', 'mw3', 'waw']);
  assert.equal(mimeFor(Buffer.from([0xff, 0xd8, 0xff, 0x00])), 'image/jpeg');
  assert.equal(mimeFor(Buffer.from('untrusted image')), null);
});
test('Bot Warfare settings use the documented capabilities of each title', () => {
  assert.deepEqual(fieldFor('bo2', 'base', 'bots_skill').choices.map(c => c.value), ['0', '1', '2', '3']);
  assert.deepEqual(fieldFor('bo2', 'base', 'bots_manage_fill_mode').choices.map(c => c.value), ['0', '1']);
  assert.equal(fieldFor('bo1', 'base', 'bots_skill'), undefined);
  assert.ok(fieldFor('bo1', 'base', 'bot_difficulty'));
  assert.equal(fieldFor('cod4', 'base', 'bots_main_firstIsHost').default, '1');
  assert.equal(fieldFor('mw2', 'base', 'bots_manage_fill_mode').choices.length, 6);
  assert.ok(schemaFor('mw3', 'mode').fields.some(field => field.key === 'commonoption.timelimit'));
  assert.throws(() => updateConfigText('set bots_skill "2"\n', { bots_skill: '8' }, opts('bo2')));
  assert.throws(() => updateConfigText('set bots_manage_fill_mode "0"\n', { bots_manage_fill_mode: '4' }, opts('bo2')));
  assert.match(updateConfigText('set bots_manage_fill_mode "0"\n', { bots_manage_fill_mode: '4' }, opts('mw2')), /"4"/);
  assert.match(updateConfigText('set bots_loadout_rank "-1"\n', { bots_loadout_rank: '-1' }, opts('bo2')), /"-1"/);
});
test('MW3 gameOpt rules preserve dotted names and comments', () => {
  const original = 'gameOpt commonOption.scoreLimit "200" // points\r\ngameOpt commonOption.timeLimit "0.0000" // minutes\r\n';
  const changed = updateConfigText(original, { 'commonoption.scorelimit': '250' }, opts('mw3', 'mode', 'DOM_default'));
  assert.equal(changed, 'gameOpt commonOption.scoreLimit "250" // points\r\ngameOpt commonOption.timeLimit "0.0000" // minutes\r\n');
  assert.throws(() => updateConfigText(original, { 'commonoption.scorelimit': '350' }, opts('mw3', 'mode', 'DOM_default')));
});
test('BO2 gts rules do not touch include headers or commented-out examples', () => {
  const original = '// Do not touch\r\nexecgts gamesettings_default.cfg\r\nset_gametype dom\r\n//gts hardcoreMode "1"\r\ngts timelimit 5 // minutes\r\n';
  const changed = updateConfigText(original, { hardcoremode: '1', timelimit: '10' }, opts('bo2', 'mode'));
  assert.ok(changed.startsWith('// Do not touch\r\nexecgts gamesettings_default.cfg\r\nset_gametype dom\r\n//gts hardcoreMode "1"\r\n'));
  assert.match(changed, /gts timelimit "10" \/\/ minutes/);
  assert.match(changed, /gts hardcoreMode "1"/);
});
test('advanced entries mask passwords and GUIDs without exposing their values', () => {
  const source = 'set rcon_password "private123"\nset bots_main_GUIDs "abc-def"\nset sv_maxclients "18"\nset sv_maxclients "24"\n';
  const doc = inspectText(source, opts('mw2'));
  assert.equal(doc.entries.find(e => e.key === 'rcon_password').value, '');
  assert.equal(doc.entries.find(e => e.key === 'bots_main_guids').value, '');
  assert.equal(doc.entries.find(e => e.key === 'sv_maxclients').count, 2);
  assert.ok(!JSON.stringify(doc).includes('private123'));
  assert.ok(!JSON.stringify(doc).includes('abc-def'));
});
test('BO2 mode picker excludes Zombies configs and mismatched gametypes', async () => {
  const root = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp', 'opencode');
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'botland-modes-'));
  try {
    const folder = path.join(dir, 'main', 'gamesettings');
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, 'dom.cfg'), 'execgts gamesettings_dom.cfg\nset_gametype dom\n');
    await fs.writeFile(path.join(folder, 'zm_classic.cfg'), 'gts timelimit 5\n');
    await fs.writeFile(path.join(folder, 'tdm.cfg'), 'set_gametype dom\n');
    assert.deepEqual(await modeOptions(profiles.bo2, dir), [{ value: 'dom', label: 'DOM' }]);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('changing a port does not discard a custom artwork selection', async () => {
  const root = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp', 'opencode');
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'botland-options-'));
  try {
    const manager = new ServerManager(path.join(dir, 'settings.json'), () => {}, 'unused');
    manager.broadcastState = async () => {};
    manager.data.games.waw = { artwork: { hero: 'C:\\my-art\\hero.jpg' } };
    await manager.saveOptions('waw', { port: 29000 });
    assert.equal(manager.data.games.waw.artwork.hero, 'C:\\my-art\\hero.jpg');
    assert.equal(manager.data.games.waw.port, 29000);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('MW3 mode rules route to the selected DSR file', async () => {
  const root = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp', 'opencode');
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'botland-dsr-'));
  try {
    const admin = path.join(dir, 'admin');
    await fs.mkdir(admin, { recursive: true });
    await fs.writeFile(path.join(admin, 'DOM_default.dsr'), 'gameOpt commonOption.scoreLimit "200" // points\r\n');
    await fs.writeFile(path.join(admin, 'server.cfg'), 'set sv_maxclients "18"\r\n');
    const manager = new ServerManager('unused', () => {}, 'unused');
    manager.data.games.mw3 = { gamePath: dir, mode: 'DOM_default' };
    manager.broadcastState = async () => {};
    const doc = await manager.document('mw3', 'mode', 'DOM_default');
    assert.equal(doc.values['commonoption.scorelimit'], '200');
    const preview = await manager.previewSettings('mw3', 'mode', 'DOM_default', { 'commonoption.scorelimit': '250' });
    await manager.commitSettings('mw3', 'mode', 'DOM_default', { 'commonoption.scorelimit': '250' }, preview.token);
    assert.match(await fs.readFile(path.join(admin, 'DOM_default.dsr'), 'utf8'), /scoreLimit "250" \/\/ points/);
    assert.match(await fs.readFile(path.join(admin, 'server.cfg'), 'utf8'), /sv_maxclients "18"/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('BO2 mode rules route to the selected gamesettings file, not dedicated.cfg', async () => {
  const root = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp', 'opencode');
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'botland-mode-'));
  try {
    const modeDir = path.join(dir, 'main', 'gamesettings');
    await fs.mkdir(modeDir, { recursive: true });
    await fs.writeFile(path.join(modeDir, 'dom.cfg'), 'execgts gamesettings_default.cfg\r\nset_gametype dom\r\ngts timelimit 5\r\n');
    await fs.writeFile(path.join(dir, 'main', 'dedicated.cfg'), 'set sv_hostname "untouched"\r\n');
    const manager = new ServerManager('unused', () => {}, 'unused');
    manager.data.games.bo2 = { gamePath: dir, mode: 'dom' };
    manager.broadcastState = async () => {};
    const document = await manager.document('bo2', 'mode', 'dom');
    assert.equal(document.values.timelimit, '5');
    assert.equal(document.entries.some(entry => entry.key === 'execgts'), false);
    const preview = await manager.previewSettings('bo2', 'mode', 'dom', { timelimit: '10' });
    await manager.commitSettings('bo2', 'mode', 'dom', { timelimit: '10' }, preview.token);
    assert.match(await fs.readFile(path.join(modeDir, 'dom.cfg'), 'utf8'), /gts timelimit "10"/);
    assert.match(await fs.readFile(path.join(dir, 'main', 'dedicated.cfg'), 'utf8'), /untouched/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('preview redacts secrets and rejects stale writes while backing up', async () => {
  const root = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp', 'opencode');
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'botland-upgrade-'));
  const file = path.join(dir, 'server.cfg');
  try {
    await fs.writeFile(file, 'set rcon_password "oldSecret"\r\nset sv_maxclients "18"\r\n');
    const config = opts('mw2');
    const preview = await previewConfig(file, { rcon_password: 'newSecret' }, config);
    assert.ok(!JSON.stringify(preview).includes('oldSecret'));
    assert.ok(!JSON.stringify(preview).includes('newSecret'));
    await fs.appendFile(file, '// changed elsewhere\r\n');
    await assert.rejects(saveConfig(file, { rcon_password: 'newSecret' }, { ...config, token: preview.token }), /changed since preview/i);
    const fresh = await previewConfig(file, { sv_maxclients: '20' }, config);
    await saveConfig(file, { sv_maxclients: '20' }, { ...config, token: fresh.token });
    assert.match(await fs.readFile(file, 'utf8'), /sv_maxclients "20"/);
    assert.ok((await fs.readdir(dir)).some(name => name.startsWith('server.cfg.bak-')));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
