const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { decode, parseConfig, readConfig, readDocument, previewConfig, saveConfig, updateConfigText } = require('../electron/config.cjs');
const { redactLog, SessionLogs } = require('../electron/session-logs.cjs');

const opts = { id: 'cod4' };
async function fixture(t) {
  const root = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp', 'opencode');
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, 'botland-sweep15-config-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

// Only synthetic credentials. Secrecy assertions avoid printing them on failure.
test('chained commands fail closed for reads and previews, with no changed bytes or backups', async t => {
  const directory = await fixture(t);
  const secret = ['synthetic', 'chained', 'credential'].join('-');
  for (const head of ['public', '"public"']) {
    const file = path.join(directory, head.startsWith('"') ? 'quoted.cfg' : 'bare.cfg');
    const text = `// keep Café\nset sv_hostname ${head}; set rcon_password "${secret}"\r\nset sv_maxclients "18"\n`;
    const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]);
    await fs.writeFile(file, original);
    const check = error => /Cannot safely read config/.test(error.message) && !error.message.includes(secret);
    assert.throws(() => parseConfig(text, opts), check);
    await assert.rejects(readDocument(file, opts), check);
    await assert.rejects(previewConfig(file, { sv_hostname: 'After' }, opts), check);
    await assert.rejects(saveConfig(file, { sv_hostname: 'After' }, opts), check);
    assert.deepEqual(await fs.readFile(file), original);
    assert.equal((await fs.readdir(directory)).some(name => name.includes('.bak-') || name.endsWith('.tmp')), false);
  }
});

test('quoted semicolons and comment markers stay literal; line comments cannot open block comments', async t => {
  const directory = await fixture(t);
  const file = path.join(directory, 'comments.cfg');
  const secret = ['synthetic', 'comment', 'credential'].join('-');
  const literal = 'LAN; http://example.test/*literal*/';
  const source = `set sv_hostname "${literal}" // /* not a block\r\nset rcon_password "${secret}"\nset sv_maxclients 18 /* actual comment */\r\n`;
  await fs.writeFile(file, source);
  assert.equal(parseConfig(source, opts).sv_hostname, literal);
  assert.equal(parseConfig(source, opts).sv_maxclients, '18');
  const document = await readDocument(file, opts);
  assert.equal(JSON.stringify(document).includes(secret), false);
  assert.equal(document.entries.find(entry => entry.key === 'rcon_password').masked, true);
  const review = await previewConfig(file, { sv_hostname: 'After' }, opts);
  assert.equal(review.changes[0].before, literal);
  assert.equal(JSON.stringify(review).includes(secret), false);
  const changed = updateConfigText(source, { sv_hostname: 'After' }, opts);
  assert.equal(changed, source.replace(`"${literal}"`, '"After"'));
  for (const prefix of ['//', '#', ';']) {
    const comment = `${prefix} unmatched " and /* are just comment text\n`;
    assert.equal(parseConfig(comment + 'set sv_hostname "Public"\n', opts).sv_hostname, 'Public');
  }
});

test('valid BOM-marked UTF-8 preserves literal values, mixed endings and byte-for-byte backups', async t => {
  const directory = await fixture(t);
  const file = path.join(directory, 'valid.cfg');
  const text = 'set sv_hostname "Café; /*literal*/"\r\nset sv_maxclients "18"\n// untouched\r\n';
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const original = Buffer.concat([bom, Buffer.from(text)]);
  await fs.writeFile(file, original);
  const review = await previewConfig(file, { sv_maxclients: '20' }, opts);
  await saveConfig(file, { sv_maxclients: '20' }, { ...opts, token: review.token });
  assert.deepEqual(await fs.readFile(file), Buffer.concat([bom, Buffer.from(text.replace('"18"', '"20"'))]));
  const backup = (await fs.readdir(directory)).find(name => name.includes('.bak-'));
  assert.deepEqual(await fs.readFile(path.join(directory, backup)), original);
});

test('editing around inline and multiline block comments never deletes preserved commands', () => {
  for (const comment of ['/* keep */', '/* keep\r\nset sv_hostname hidden\r\n*/']) {
    const source = `set sv_hostname Old ${comment}\r\nset sv_maxclients "18"\n`;
    const changed = updateConfigText(source, { sv_hostname: 'After' }, opts);
    assert.equal(changed, source + 'set sv_hostname "After"\r\n');
    assert.equal(parseConfig(changed, opts).sv_hostname, 'After');
  }
});

test('last active duplicate with a block comment appends an effective override without editing earlier assignments', () => {
  for (const comment of ['/* keep */', '/* keep\r\nset sv_hostname hidden\r\n*/']) {
    const source = `set sv_hostname Earlier\r\nset sv_hostname Last ${comment}\r\n// set sv_hostname ignored\r\n`;
    const changed = updateConfigText(source, { sv_hostname: 'After' }, opts);
    assert.equal(changed, source + 'set sv_hostname "After"\r\n');
    assert.equal(parseConfig(changed, opts).sv_hostname, 'After');
  }
});

test('ambiguous escaped or unterminated config quotes fail closed without echoing content', async t => {
  const directory = await fixture(t);
  const file = path.join(directory, 'ambiguous.cfg');
  const secret = ['synthetic', 'ambiguous', 'credential'].join('-');
  for (const text of [`set sv_hostname "Old\\"; set rcon_password ${secret}\n`, `set sv_hostname "Old; set rcon_password ${secret}`]) {
    await fs.writeFile(file, text);
    const check = error => /Cannot safely read config/.test(error.message) && !error.message.includes(secret);
    assert.throws(() => parseConfig(text, opts), check);
    await assert.rejects(readDocument(file, opts), check);
    await assert.rejects(previewConfig(file, { sv_hostname: 'After' }, opts), check);
    await assert.rejects(saveConfig(file, { sv_hostname: 'After' }, opts), check);
    assert.deepEqual(await fs.readFile(file), Buffer.from(text));
  }
  assert.deepEqual(await fs.readdir(directory), ['ambiguous.cfg']);
});

test('invalid BOM-marked UTF-8 fails closed for reads, previews and saves without backups', async t => {
  const directory = await fixture(t);
  const file = path.join(directory, 'invalid.cfg');
  for (const invalid of [[0xc3, 0x28], [0xe2, 0x82], [0xff]]) {
    const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('set sv_hostname "'), Buffer.from(invalid), Buffer.from('"\r\n')]);
    await fs.writeFile(file, original);
    assert.throws(() => decode(original), /not valid UTF-8/);
    await assert.rejects(readConfig(file, opts), /not valid UTF-8/);
    await assert.rejects(readDocument(file, opts), /not valid UTF-8/);
    await assert.rejects(previewConfig(file, { sv_hostname: 'After' }, opts), /not valid UTF-8/);
    await assert.rejects(saveConfig(file, { sv_hostname: 'After' }, opts), /not valid UTF-8/);
    assert.deepEqual(await fs.readFile(file), original);
  }
  assert.deepEqual(await fs.readdir(directory), ['invalid.cfg']);
  // An extra literal U+FEFF after the encoding marker must not silently vanish.
  assert.equal(decode(Buffer.from('\ufeff\ufeff// preserved\n')).text, '\ufeff// preserved\n');
});

test('bare sensitive log commands redact values without crossing separators or line boundaries', () => {
  const names = ['rcon_password', 'sv_password', 'key', 'sv_adminguid', 'auth_token'];
  for (const [index, name] of names.entries()) {
    const secret = `synthetic-bare-${index}`;
    for (const prefix of ['', 'console: ', ';', '+']) {
      const safe = redactLog(`${prefix}${name}\t${secret}; sv_hostname Public, next=visible`);
      assert.equal(safe.includes(secret), false);
      assert.equal(safe.endsWith('; sv_hostname Public, next=visible'), true);
    }
  }
  assert.equal(redactLog('key\nnormal output'), 'key\nnormal output');
  assert.equal(redactLog('rcon_password; sv_hostname Public'), 'rcon_password; sv_hostname Public');
  assert.equal(redactLog('ordinary_setting public'), 'ordinary_setting public');
  assert.equal(redactLog('key bare, next=visible'), 'key [REDACTED], next=visible');
  const secret = ['synthetic', 'malformed', 'two words'].join('-');
  assert.equal(redactLog(`rcon_password "${secret}`).includes(secret), false);
});

test('bare credentials are redacted before persisted session log truncation', async t => {
  const userData = await fixture(t);
  const logs = new SessionLogs({ userData, maxBytes: 160 });
  const secret = 'synthetic-bare-credential-'.repeat(30);
  const file = await logs.start('cod4');
  try {
    await logs.append('cod4', { at: '2026-11-13T12:00:00.000Z', level: 'info', message: `rcon_password ${secret}; ${'public output '.repeat(100)}` });
  } finally { await logs.close('cod4'); }
  const bytes = await fs.readFile(file);
  assert.equal(bytes.length <= 160, true);
  const { message } = JSON.parse(bytes.toString('utf8'));
  assert.equal(message.includes('synthetic-bare'), false);
  assert.equal(message.startsWith('rcon_password [REDACTED]; '), true);
  assert.equal(message.endsWith('[truncated]'), true);
});
