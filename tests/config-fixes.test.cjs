const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { parseConfig, updateConfigText, readConfig, readDocument, previewConfig, saveConfig } = require('../electron/config.cjs');
const { scanMaps, modeOptions } = require('../electron/maps.cjs');
const { profiles } = require('../electron/profiles.cjs');

async function temporaryDirectory(prefix, run) {
  const root = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp', 'opencode');
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, prefix));
  try { await run(dir); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
}

test('config edits keep each untouched line ending, including when appending a setting', async () => {
  const original = 'set sv_hostname "Old"\n// keep this line\r\nset sv_maxclients "18"\ncustom directive\r\n';
  const updated = updateConfigText(original, { sv_hostname: 'New', sv_maxclients: '20', bots_main: '1' });
  assert.equal(updated, 'set sv_hostname "New"\n// keep this line\r\nset sv_maxclients "20"\ncustom directive\r\nset bots_main "1"\r\n');
  await temporaryDirectory('botland-mixed-', async dir => {
    const file = path.join(dir, 'server.cfg');
    await fs.writeFile(file, original);
    const preview = await previewConfig(file, { sv_hostname: 'Old' });
    assert.equal(preview.changed, false);
    const reviewed = await previewConfig(file, { sv_hostname: 'New' });
    await saveConfig(file, { sv_hostname: 'New' }, { token: reviewed.token });
    assert.equal(await fs.readFile(file, 'utf8'), original.replace('"Old"', '"New"'));
  });
});

test('simultaneous commits with the same preview token cannot both succeed', async () => {
  await temporaryDirectory('botland-concurrent-', async dir => {
    const file = path.join(dir, 'server.cfg');
    const original = Buffer.from('set sv_maxclients "18"\r\n// untouched\n', 'utf8');
    await fs.writeFile(file, original);
    const { token } = await previewConfig(file, { sv_maxclients: '20' }, { id: 'cod4' });
    const results = await Promise.allSettled([
      saveConfig(file, { sv_maxclients: '20' }, { token }),
      saveConfig(file, { sv_maxclients: '22' }, { token }),
    ]);
    assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected']);
    assert.match(results[1].reason.message, /changed since preview/i);
    assert.equal(await fs.readFile(file, 'utf8'), 'set sv_maxclients "20"\r\n// untouched\n');
    const files = await fs.readdir(dir);
    const backups = files.filter(name => name.startsWith('server.cfg.bak-'));
    assert.equal(backups.length, 1);
    assert.deepEqual(await fs.readFile(path.join(dir, backups[0])), original);
    assert.equal(files.some(name => name.endsWith('.tmp')), false);
  });
});

test('a review token only commits the values that were previewed', async () => {
  await temporaryDirectory('botland-token-', async dir => {
    const file = path.join(dir, 'server.cfg');
    await fs.writeFile(file, 'set sv_maxclients "18"\nset sv_hostname "Old"\n');
    const { token } = await previewConfig(file, { sv_maxclients: '20', sv_hostname: 'New' }, { id: 'cod4' });
    await assert.rejects(saveConfig(file, { sv_maxclients: '24', sv_hostname: 'New' }, { id: 'cod4', token }), /changed since preview/i);
    await assert.rejects(saveConfig(file, { sv_maxclients: '20' }, { id: 'cod4', token }), /changed since preview/i);
    assert.equal(await fs.readFile(file, 'utf8'), 'set sv_maxclients "18"\nset sv_hostname "Old"\n');
    // Key order and case do not matter for the same reviewed values.
    await saveConfig(file, { SV_HOSTNAME: 'New', sv_maxclients: '20' }, { id: 'cod4', token });
    assert.equal(await fs.readFile(file, 'utf8'), 'set sv_maxclients "20"\nset sv_hostname "New"\n');
  });
});

test('an external edit during a save is not overwritten', async () => {
  await temporaryDirectory('botland-external-', async dir => {
    const file = path.join(dir, 'server.cfg');
    await fs.writeFile(file, 'set sv_maxclients "18"\n');
    const token = (await previewConfig(file, { sv_maxclients: '20' }, { id: 'cod4' })).token;
    const originalWrite = fs.writeFile;
    fs.writeFile = async (target, ...args) => {
      const result = await originalWrite(target, ...args);
      if (String(target).endsWith('.tmp')) await originalWrite(file, 'set sv_maxclients "22"\n');
      return result;
    };
    try { await assert.rejects(saveConfig(file, { sv_maxclients: '20' }, { id: 'cod4', token }), /changed since preview/i); }
    finally { fs.writeFile = originalWrite; }
    assert.equal(await fs.readFile(file, 'utf8'), 'set sv_maxclients "22"\n');
    assert.equal((await fs.readdir(dir)).some(name => name.endsWith('.tmp')), false);
  });
});

test('separate saves retain both byte-for-byte backups even in the same millisecond', async () => {
  await temporaryDirectory('botland-backups-', async dir => {
    const file = path.join(dir, 'server.cfg');
    const first = Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('set sv_maxclients "18"\r\n')]);
    await fs.writeFile(file, first);
    const NativeDate = Date;
    global.Date = class extends NativeDate {
      constructor(...args) { super(...(args.length ? args : ['2026-10-29T10:00:00.123Z'])); }
    };
    try {
      await saveConfig(file, { sv_maxclients: '20' });
      const second = await fs.readFile(file);
      await saveConfig(file, { sv_maxclients: '22' });
      const backups = (await fs.readdir(dir)).filter(name => name.startsWith('server.cfg.bak-')).sort();
      assert.equal(backups.length, 2);
      assert.deepEqual((await Promise.all(backups.map(name => fs.readFile(path.join(dir, name))))).sort(Buffer.compare), [first, second].sort(Buffer.compare));
      assert.equal((await fs.readFile(file)).subarray(0, 3).equals(first.subarray(0, 3)), true);
    } finally { global.Date = NativeDate; }
  });
});

test('block-commented assignments cannot replace the active configuration', () => {
  const source = 'set sv_maxclients "18"\n/*\nset sv_maxclients "64"\n*/\n';
  assert.equal(require('../electron/config.cjs').parseConfig(source, { id: 'cod4' }).sv_maxclients, '18');
  const changed = updateConfigText(source, { sv_maxclients: '20' }, { id: 'cod4' });
  assert.equal(changed, source.replace('"18"', '"20"'));
});

test('BO2 mode scan ignores comments and checks the effective gametype', async () => {
  await temporaryDirectory('botland-bo2-modes-', async dir => {
    const folder = path.join(dir, 'main', 'gamesettings');
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, 'dom.cfg'), '/* set_gametype dom */\nset_gametype zm\n');
    await fs.writeFile(path.join(folder, 'tdm.cfg'), '// set_gametype zm\nset_gametype tdm\n');
    assert.deepEqual(await modeOptions(profiles.bo2, dir), [{ value: 'tdm', label: 'TDM' }]);
  });
});

test('MW3 map scan offers only mp_ fastfiles with a matching load file', async () => {
  await temporaryDirectory('botland-mw3-maps-', async dir => {
    const zone = path.join(dir, 'zone', 'english');
    await fs.mkdir(zone, { recursive: true });
    for (const name of ['mp_alpha.ff', 'mp_alpha_load.ff', 'mp_missing.ff', 'co_alpha.ff', 'co_alpha_load.ff', 'oilrig.ff', 'oilrig_load.ff']) {
      await fs.writeFile(path.join(zone, name), '');
    }
    const maps = await scanMaps(profiles.mw3, dir);
    assert.ok(maps.includes('mp_alpha'));
    for (const name of ['mp_missing', 'co_alpha', 'oilrig']) assert.ok(!maps.includes(name));
    assert.ok(maps.every(name => name.startsWith('mp_')));
  });
});

test('values containing block-comment markers are rejected so later lines stay active', async () => {
  const source = 'set sv_hostname "a"\nset sv_maxclients "18"\n';
  for (const value of ['My /* LAN', 'end */ here']) {
    assert.throws(() => updateConfigText(source, { sv_hostname: value }, { id: 'cod4' }), /Comment markers/);
  }
  // Line comments inside a quoted value remain allowed (for example URLs).
  const url = updateConfigText(source, { sv_hostname: 'http://lan.example' }, { id: 'cod4' });
  assert.deepEqual(parseConfig(url, { id: 'cod4' }), { sv_hostname: 'http://lan.example', sv_maxclients: '18' });
});

test('Latin-1 config files refuse characters they cannot store instead of corrupting them', async () => {
  await temporaryDirectory('botland-latin1-', async dir => {
    const file = path.join(dir, 'server.cfg');
    const original = Buffer.from('set sv_hostname "Caf\xe9"\r\n', 'latin1');
    await fs.writeFile(file, original);
    await assert.rejects(previewConfig(file, { sv_hostname: 'Star \u2605' }, { id: 'cod4' }), /Latin-1/);
    await assert.rejects(saveConfig(file, { sv_hostname: 'Star \u2605' }, { id: 'cod4' }), /Latin-1/);
    assert.deepEqual(await fs.readFile(file), original);
    // Latin-1 characters still round-trip in the file's own encoding.
    const { token } = await previewConfig(file, { sv_hostname: 'Caf\xe9 Bar' }, { id: 'cod4' });
    await saveConfig(file, { sv_hostname: 'Caf\xe9 Bar' }, { id: 'cod4', token });
    assert.deepEqual(await fs.readFile(file), Buffer.from('set sv_hostname "Caf\xe9 Bar"\r\n', 'latin1'));
    // UTF-8 files keep accepting any character.
    const utf8 = path.join(dir, 'utf8.cfg');
    await fs.writeFile(utf8, 'set sv_hostname "Old"\n');
    const reviewed = await previewConfig(utf8, { sv_hostname: 'Star \u2605' }, { id: 'cod4' });
    await saveConfig(utf8, { sv_hostname: 'Star \u2605' }, { id: 'cod4', token: reviewed.token });
    assert.equal(await fs.readFile(utf8, 'utf8'), 'set sv_hostname "Star \u2605"\n');
  });
});

test('UTF-16 configs are decoded, validated and saved in their original endianness', async () => {
  await temporaryDirectory('botland-utf16-', async dir => {
    const text = 'set sv_hostname "Old"\r\nset sv_maxclients "18"\r\n';
    const snapshot = encoding => {
      const bytes = Buffer.from(text, 'utf16le');
      if (encoding === 'utf16be') bytes.swap16();
      return Buffer.concat([Buffer.from(encoding === 'utf16le' ? [0xff, 0xfe] : [0xfe, 0xff]), bytes]);
    };
    for (const encoding of ['utf16le', 'utf16be']) {
      const file = path.join(dir, `${encoding}.cfg`);
      await fs.writeFile(file, snapshot(encoding));
      assert.deepEqual(await readConfig(file, { id: 'cod4' }), { sv_hostname: 'Old', sv_maxclients: '18' });
      const document = await readDocument(file, { id: 'cod4' });
      assert.equal(document.entries.find(entry => entry.key === 'sv_hostname').value, 'Old');
      const preview = await previewConfig(file, { sv_hostname: 'Star \u2605' }, { id: 'cod4' });
      assert.equal(preview.changed, true);
      await saveConfig(file, { sv_hostname: 'Star \u2605' }, { id: 'cod4', token: preview.token });
      const expectedText = text.replace('"Old"', '"Star \u2605"');
      const expectedBytes = Buffer.from(expectedText, 'utf16le');
      if (encoding === 'utf16be') expectedBytes.swap16();
      assert.deepEqual(await fs.readFile(file), Buffer.concat([
        Buffer.from(encoding === 'utf16le' ? [0xff, 0xfe] : [0xfe, 0xff]), expectedBytes,
      ]));
    }
  });
});

test('BO2 mode scan keeps line boundaries around multi-line block comments', async () => {
  await temporaryDirectory('botland-bo2-comment-lines-', async dir => {
    const folder = path.join(dir, 'main', 'gamesettings');
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, 'tdm.cfg'), 'set_gametype zm /* old\n*/ set_gametype tdm\n');
    assert.deepEqual(await modeOptions(profiles.bo2, dir), [{ value: 'tdm', label: 'TDM' }]);
  });
});

test('parses bot_difficulty assignments without set prefix', () => {
  const source = 'bot_difficulty "hard"\r\n';
  assert.equal(parseConfig(source, { id: 'bo1' }).bot_difficulty, 'hard');
});
