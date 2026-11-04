const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { isSecret, inspectText, parseConfig, updateConfigText, validateValues } = require('../electron/config.cjs');
const { ServerManager } = require('../electron/manager.cjs');

const opts = id => ({ id, target: 'base', mode: 'dom' });

test('plain and suffixed key dvars and singular GUID settings are treated as secrets', () => {
  for (const key of ['key', 'sv_licensekey', 'sv_license_key', 'sv_key', 'sv_adminguid', 'rcon_password']) assert.equal(isSecret(key), true, key);
  for (const key of ['sv_hostname', 'bots_manage_fill', 'sv_maxclients', 'scr_dom_timelimit']) assert.equal(isSecret(key), false, key);
  const text = 'set key "sample-key-value"\r\nset sv_hostname "Lobby"\r\n';
  const document = inspectText(text, opts('waw'));
  assert.ok(!JSON.stringify(document).includes('sample-key-value'));
  assert.equal(document.entries.find(entry => entry.key === 'key').masked, true);
  assert.ok(!JSON.stringify(parseConfig(text, opts('waw'))).includes('sample-key-value'));
});

test('a setting that an unterminated block comment would hide is refused instead of silently saved', () => {
  const text = 'set sv_hostname "Lobby"\n/* notes that never close\nset bots_main "0"\n';
  assert.throws(() => updateConfigText(text, { bots_main: '1' }, opts('cod4')), /block comment/);
  // Edits before the comment still work and keep the comment intact.
  assert.equal(updateConfigText(text, { sv_hostname: 'New' }, opts('cod4')), text.replace('"Lobby"', '"New"'));
});

test('MW3 bot fill target is capped at its 18 slots even when sv_maxclients is absent', () => {
  assert.throws(() => validateValues({ bots_manage_fill: '24' }, opts('mw3'), ''), /cannot exceed player slots/);
  assert.deepEqual(validateValues({ bots_manage_fill: '18' }, opts('mw3'), ''), { bots_manage_fill: '18' });
  assert.deepEqual(validateValues({ bots_manage_fill: '24' }, opts('cod4'), ''), { bots_manage_fill: '24' });
});

test('base config requests reject an invalid mode name', async t => {
  const root = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp', 'opencode');
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'botland-sweep-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const manager = new ServerManager(path.join(dir, 'settings.json'), () => {}, dir);
  manager.data.games.cod4 = { gamePath: dir };
  for (const mode of ['dom;quit', '../x', { toString: () => 'dom' }]) {
    await assert.rejects(manager.configTarget('cod4', 'base', mode), /Invalid mode name/);
  }
  assert.equal((await manager.configTarget('cod4', 'base', 'war')).mode, 'war');
});
