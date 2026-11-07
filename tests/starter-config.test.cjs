const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createStarterConfig, starterText } = require('../electron/starter-config.cjs');
const { order, profileFor } = require('../electron/profiles.cjs');
const { readConfig, readDocument, parseConfig, validateValues, previewConfig, saveConfig } = require('../electron/config.cjs');
const { rotationText } = require('../electron/maps.cjs');
const { ServerManager } = require('../electron/manager.cjs');

async function temporary(t) {
  const base = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp', 'opencode');
  await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, 'botland-starter-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('all six starters are readable, editable, CRLF-terminated and contain no credentials', async t => {
  const dir = await temporary(t);
  for (const id of order) {
    const profile = profileFor(id);
    const gamePath = path.join(dir, id);
    await fs.mkdir(gamePath);
    const file = await createStarterConfig(id, gamePath);
    assert.equal(file, path.join(gamePath, profile.config));
    const text = await fs.readFile(file, 'utf8');
    assert.equal(text, starterText(id));
    assert.match(text, /\r\n$/);
    assert.doesNotMatch(text.replaceAll('\r\n', ''), /[\r\n]/);
    assert.doesNotMatch(text, /(?:^|\r\n)\s*(?:set\s+)?(?:key|rcon_password|sv_adminguid|bots_main_guids|server_key|sv_password)\s+/i);
    assert.doesNotMatch(text, /test-starter-secret-do-not-copy/i);

    const opts = { id, target: 'base', mode: profile.defaultMode };
    const values = await readConfig(file, opts);
    assert.deepEqual(values, parseConfig(text, opts));
    assert.equal(values.sv_hostname, `botLANd ${profile.short} Server`);
    assert.equal(values.sv_maxclients, '18');
    assert.ok(+values.sv_maxclients <= (id === 'mw3' ? 18 : 64));
    assert.equal(values.bots_main, '1');
    assert.equal(values.bots_manage_fill, '8');
    assert.equal(values[id === 'bo1' ? 'bot_difficulty' : 'bots_skill'], id === 'bo1' ? 'normal' : id === 'bo2' ? '1' : '3');
    assert.equal(values.bots_main_firstishost, ['cod4', 'waw', 'mw2', 'mw3'].includes(id) ? '0' : undefined);
    assert.deepEqual(validateValues(values, opts, text), values);
    const document = await readDocument(file, opts);
    assert.deepEqual(document.values, values);
    assert.equal(document.entries.find(entry => entry.key === 'sv_hostname').masked, false);
    assert.equal((await previewConfig(file, { sv_hostname: 'My LAN Server' }, opts)).changed, true);
    assert.equal(await fs.readFile(file, 'utf8'), text);

    const rotation = rotationText(profile, ['mp_alpha', 'mp_bravo'], profile.defaultMode, false);
    assert.match(rotation, /mp_alpha/);
    assert.equal(text.includes(`exec ${path.basename(profile.rotation)}`), id === 'mw3' || id === 'bo2');
    if (id === 'mw3') assert.match(text, /^set fs_game "mods\/bots"\r?$/m);
    else assert.doesNotMatch(text, /(?:^|\r\n)set fs_game /);
    await assert.rejects(fs.stat(path.join(gamePath, profile.rotation)), { code: 'ENOENT' });
  }
});

test('a newly created starter uses the normal transactional preview and byte-for-byte backup', async t => {
  const dir = await temporary(t);
  const gamePath = path.join(dir, 'cod4');
  await fs.mkdir(gamePath);
  const file = await createStarterConfig('cod4', gamePath);
  const original = await fs.readFile(file);
  const opts = { id: 'cod4', target: 'base', mode: 'dom' };
  const preview = await previewConfig(file, { sv_hostname: 'Private Match' }, opts);
  await saveConfig(file, { sv_hostname: 'Private Match' }, { ...opts, token: preview.token });
  assert.equal((await readConfig(file, opts)).sv_hostname, 'Private Match');
  const backups = (await fs.readdir(path.dirname(file))).filter(name => name.startsWith('botserver.cfg.bak-'));
  assert.equal(backups.length, 1);
  assert.deepEqual(await fs.readFile(path.join(path.dirname(file), backups[0])), original);
});

test('IW5 and T6 starter includes pass the existing preflight rotation and mod rules without creating mode files', async t => {
  const dir = await temporary(t);
  const oldLocalAppData = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = dir;
  try {
    for (const id of ['mw3', 'bo2']) {
      const gamePath = path.join(dir, id);
      await fs.mkdir(gamePath);
      const manager = new ServerManager(path.join(dir, `${id}-settings.json`), () => {}, dir);
      manager.data.games[id] = { gamePath };
      const modeFile = id === 'mw3' ? path.join(gamePath, 'admin', 'DOM_default.dsr') : path.join(gamePath, 'main', 'gamesettings', 'dom.cfg');
      await fs.mkdir(path.dirname(modeFile), { recursive: true });
      const modeContents = id === 'bo2' ? 'set_gametype dom\r\ngts timelimit 10\r\n' : 'gameOpt commonOption.timeLimit 10\r\n';
      await fs.writeFile(modeFile, modeContents);
      await createStarterConfig(id, gamePath);
      const check = await manager.check(id);
      assert.ok(!check.blockers.some(message => message.startsWith('Base config must exec') || message.includes('overrides the Bot Warfare mod')), check.blockers.join('\n'));
      assert.equal(await fs.readFile(modeFile, 'utf8'), modeContents);
      assert.equal((await fs.readdir(path.dirname(modeFile))).filter(name => name.endsWith('.dsr') || name.endsWith('.cfg')).includes(path.basename(modeFile)), true);
    }
  } finally {
    if (oldLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = oldLocalAppData;
  }
});

test('existing configs are never changed and concurrent creation has exactly one winner', async t => {
  const dir = await temporary(t);
  const gamePath = path.join(dir, 'bo2');
  await fs.mkdir(path.join(gamePath, 'main'), { recursive: true });
  const file = path.join(gamePath, profileFor('bo2').config);
  const original = Buffer.from('set sv_hostname "Existing custom server"\n');
  await fs.writeFile(file, original);
  await assert.rejects(createStarterConfig('bo2', gamePath), { code: 'EEXIST' });
  assert.deepEqual(await fs.readFile(file), original);
  assert.deepEqual(await fs.readdir(path.dirname(file)), ['dedicated.cfg']);

  const racePath = path.join(dir, 'mw3');
  await fs.mkdir(racePath);
  const attempts = await Promise.allSettled(Array.from({ length: 12 }, () => createStarterConfig('mw3', racePath)));
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(result => result.status === 'rejected' && result.reason.code === 'EEXIST').length, 11);
  const raceFile = path.join(racePath, profileFor('mw3').config);
  assert.equal(attempts.find(result => result.status === 'fulfilled').value, raceFile);
  assert.equal(await fs.readFile(raceFile, 'utf8'), starterText('mw3'));
  assert.deepEqual(await fs.readdir(path.dirname(raceFile)), ['server.cfg']);
});

test('filesystems without hard-link support fall back to an exclusive copy', async t => {
  const dir = await temporary(t);
  const gamePath = path.join(dir, 'cod4');
  await fs.mkdir(gamePath);
  const originalLink = fs.link;
  fs.link = async () => { const error = new Error('hard links are not supported'); error.code = 'EPERM'; throw error; };
  try {
    const file = await createStarterConfig('cod4', gamePath);
    assert.equal(await fs.readFile(file, 'utf8'), starterText('cod4'));
  } finally { fs.link = originalLink; }
  assert.deepEqual(await fs.readdir(path.join(gamePath, 'main')), ['botserver.cfg']);
});

test('a failed atomic publish does not leave a partial config or staging file', async t => {
  const dir = await temporary(t);
  const gamePath = path.join(dir, 'cod4');
  await fs.mkdir(gamePath);
  const originalLink = fs.link;
  fs.link = async () => { const error = new Error('simulated link failure'); error.code = 'EACCES'; throw error; };
  try { await assert.rejects(createStarterConfig('cod4', gamePath), /simulated link failure/); }
  finally { fs.link = originalLink; }
  assert.deepEqual(await fs.readdir(path.join(gamePath, 'main')), []);
  await createStarterConfig('cod4', gamePath);
  assert.equal(await fs.readFile(path.join(gamePath, profileFor('cod4').config), 'utf8'), starterText('cod4'));
});

test('invalid game IDs and missing, relative, or non-directory game paths are rejected without writes', async t => {
  const dir = await temporary(t);
  const missing = path.join(dir, 'not-installed');
  const regularFile = path.join(dir, 'file');
  await fs.writeFile(regularFile, 'untouched');
  await assert.rejects(createStarterConfig('bogus', dir), /Unknown game/);
  assert.throws(() => starterText('bogus'), /Unknown game/);
  for (const gamePath of ['', undefined, '.', missing, regularFile]) {
    await assert.rejects(createStarterConfig('bo1', gamePath), /game folder/i);
  }
  assert.equal(await fs.readFile(regularFile, 'utf8'), 'untouched');
  assert.deepEqual((await fs.readdir(dir)).sort(), ['file']);
});
