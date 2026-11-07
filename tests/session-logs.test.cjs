const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { redactLog, SessionLogs } = require('../electron/session-logs.cjs');

async function tempUserData(t) {
  const root = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp', 'opencode');
  await fs.mkdir(root, { recursive: true });
  const userData = await fs.mkdtemp(path.join(root, 'botland-session-logs-'));
  t.after(() => fs.rm(userData, { recursive: true, force: true }));
  return userData;
}

const entry = message => ({ at: '2026-11-03T10:15:30.000Z', level: 'info', message });

// Use synthetic values assembled at runtime. Assert only booleans when testing
// secrecy, so a failed assertion cannot print the value to the test runner.
test('redactLog masks a supplied key and generic quoted, unquoted and set assignments', () => {
  const key = ['ephemeral', 'test', 'key'].join('-');
  const secrets = ['first value', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'two words exposed'];
  const raw = [
    `echo ${key} in unrelated output`,
    `set rcon_password "${secrets[0]}"; GUID: ${secrets[1]}`,
    `+set key ${secrets[2]} auth_token='${secrets[3]}'`,
    `--api-secret=${secrets[4]} admin_passwd: ${secrets[5]}`,
    `password=${secrets[6]} ordinary_setting=public`,
    `secret="${secrets[7]}`,
  ].join('\n');
  const safe = redactLog(raw, key);
  for (const secret of [key, ...secrets]) assert.equal(safe.includes(secret), false);
  assert.equal(safe.includes('ordinary_setting=public'), true);
  assert.equal((safe.match(/\[REDACTED\]/g) || []).length >= 9, true);
  assert.equal(redactLog('normal output'), 'normal output');
  assert.equal(redactLog('key=hidden').includes('hidden'), false);
  const additional = ['auth-value', 'rcon-value', 'bearer-value', 'basic-value'];
  const extra = redactLog([
    `set sv_auth ${additional[0]}`,
    `rcon: ${additional[1]}`,
    `Authorization: Bearer ${additional[2]}`,
    `Proxy-Authorization: Basic ${additional[3]}`,
  ].join('\n'));
  for (const secret of additional) assert.equal(extra.includes(secret), false);
  assert.equal(extra.includes('Authorization: [REDACTED]'), true);
  const variants = ['seta-value', 'sets-value', 'setu-value', 'plus-seta-value', 'bare-value'];
  const variantText = redactLog([
    `seta rcon_password "${variants[0]}"`,
    `sets auth_token '${variants[1]}'`,
    `setu sv_password ${variants[2]}`,
    `+seta key ${variants[3]}`,
    `rcon_password "${variants[4]}"`,
  ].join('\n'));
  for (const secret of variants) assert.equal(variantText.includes(secret), false);
  assert.equal((variantText.match(/\[REDACTED\]/g) || []).length >= variants.length, true);
  // The manager joins output chunks into a complete line before calling addLog.
  const chunks = ['server reports ', key.slice(0, 9), key.slice(9)];
  assert.equal(redactLog(chunks.join(''), key).includes(key), false);
  let error;
  try { redactLog({ toString() { throw new Error(key); } }, key); } catch (caught) { error = caught; }
  assert.equal(error?.message === 'Could not redact log.', true);
});

test('persists only redacted JSONL under app userData, with separate files per game', async t => {
  const userData = await tempUserData(t);
  const logs = new SessionLogs({ userData });
  const key = ['private', 'launch', 'fixture'].join('-');
  const file = await logs.start('bo2', { key });
  assert.equal(path.relative(path.join(userData, 'session-logs', 'bo2'), file).startsWith('..'), false);
  const second = await logs.start('waw');
  assert.notEqual(file, second);
  await logs.append('bo2', entry(`ready ${key} token=another-private-value`));
  await logs.append('waw', entry('ready'));
  await logs.close('bo2');
  const text = await fs.readFile(file, 'utf8');
  assert.equal(text.includes(key), false);
  assert.equal(text.includes('another-private-value'), false);
  assert.deepEqual(JSON.parse(text.trim()), entry('ready [REDACTED] token=[REDACTED]'));
  assert.equal((await fs.readFile(second, 'utf8')).includes('ready'), true);
  await assert.rejects(logs.append('bo2', entry('late')), { message: 'No active session log.' });
  assert.throws(() => logs.start('../outside'), { message: 'Unknown game.' });
  await logs.close('waw');
});

test('a failed append closes the session and does not expose an input error containing a key', async t => {
  const userData = await tempUserData(t);
  const logs = new SessionLogs({ userData });
  const key = ['private', 'error', 'fixture'].join('-');
  const file = await logs.start('bo2', { key });
  const broken = { get message() { throw new Error(key); } };
  let failure;
  try { await logs.append('bo2', broken); } catch (error) { failure = error; }
  assert.equal(failure?.message === 'Could not append session log.', true);
  assert.equal(failure.message.includes(key), false);
  assert.equal(logs.sessions.has('bo2'), false);
  assert.equal((await fs.readFile(file, 'utf8')).includes(key), false);
});

test('truncates oversized UTF-8 entries to the byte cap without a broken JSON line', async t => {
  const userData = await tempUserData(t);
  const logs = new SessionLogs({ userData, maxBytes: 150 });
  const file = await logs.start('cod4');
  await logs.append('cod4', entry('🙂'.repeat(500)));
  await logs.close('cod4');
  const body = await fs.readFile(file);
  assert.equal(body.length <= 150, true);
  const saved = JSON.parse(body.toString('utf8').trim());
  assert.equal(saved.message.endsWith('[truncated]'), true);
  assert.equal(saved.message.includes('\uFFFD'), false);
  assert.equal(saved.message.startsWith('🙂'), true);
  assert.equal(Array.from(saved.message).some(character => character.length === 1 && /[\uD800-\uDFFF]/.test(character)), false);
});

test('queues appends, rotates at the size limit, and retains only recent sessions', async t => {
  const userData = await tempUserData(t);
  const logs = new SessionLogs({ userData, maxBytes: 180, maxSessions: 2 });
  const dir = path.join(userData, 'session-logs', 'bo1');
  const first = await logs.start('bo1');
  await fs.writeFile(path.join(dir, 'user-notes.txt'), 'do not remove');
  await Promise.all(Array.from({ length: 24 }, (_, index) => logs.append('bo1', entry(`entry-${index}`))));
  await logs.close('bo1');
  const files = (await fs.readdir(dir)).filter(name => name.endsWith('.jsonl'));
  assert.equal(files.length, 2);
  assert.equal(files.includes(path.basename(first)), false);
  assert.equal(await fs.readFile(path.join(dir, 'user-notes.txt'), 'utf8'), 'do not remove');
  const records = [];
  for (const name of files) {
    const body = await fs.readFile(path.join(dir, name));
    assert.equal(body.length <= 180, true);
    records.push(...body.toString('utf8').trim().split('\n').map(JSON.parse));
  }
  assert.equal(records.some(record => record.message === 'entry-23'), true);
  assert.equal(new Set(records.map(record => record.message)).size, records.length);
});

test('start, append, rotate and close serialize in call order and rotation keeps the in-memory key', async t => {
  const userData = await tempUserData(t);
  const logs = new SessionLogs({ userData, maxSessions: 3 });
  const key = ['rotate', 'key', 'fixture'].join('-');
  const opened = logs.start('mw3', { key });
  const written = logs.append('mw3', entry(`first ${key}`));
  const rotated = logs.rotate('mw3');
  const next = logs.append('mw3', entry(`second ${key}`));
  const closed = logs.close('mw3');
  const [first, , second] = await Promise.all([opened, written, rotated, next, closed]);
  assert.notEqual(first, second);
  for (const [file, expected] of [[first, 'first [REDACTED]'], [second, 'second [REDACTED]']]) {
    const text = await fs.readFile(file, 'utf8');
    assert.equal(text.includes(key), false);
    assert.equal(JSON.parse(text.trim()).message, expected);
  }
  assert.equal(logs.sessions.has('mw3'), false);
});
