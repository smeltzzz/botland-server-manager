const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { ServerLogTail, logCandidates } = require('../electron/log-tail.cjs');

async function fixture(work) {
  const base = path.join(process.env.LOCALAPPDATA || require('node:os').tmpdir(), 'Temp', 'opencode');
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'botland-log-tail-'));
  try {
    const gamePath = path.join(root, 'game');
    const localAppData = path.join(root, 'local');
    await fs.mkdir(gamePath);
    await fs.mkdir(localAppData);
    await work({ root, gamePath, localAppData });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
async function put(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}
function tail(id, gamePath, localAppData, lines, options = {}) {
  return new ServerLogTail({ id, gamePath, localAppData, onLine: line => lines.push(line), ...options });
}

const expected = {
  cod4: ['mods/mp_bots/console_mp.log', 'main/console_mp.log', 'main/console.log', 'mods/mp_bots/games_mp.log', 'main/games_mp.log'],
  waw: ['t4/mods/mp_bots/console_mp.log', 't4/main/console_mp.log', 't4/mods/mp_bots/games_mp.log', 't4/main/games_mp.log', 'mods/mp_bots/console_mp.log', 'main/console_mp.log', 'mods/mp_bots/games_mp.log', 'main/games_mp.log'],
  mw2: ['userraw/console_mp.log', 'main/console_mp.log', 'userraw/console.log', 'userraw/games_mp.log', 'main/games_mp.log'],
  bo1: ['t5/mods/mp_bots/console_mp.log', 't5/main/console_mp.log', 't5/mods/mp_bots/games_mp.log', 't5/mods/mp_bots/logs/games_mp.log', 't5/main/games_mp.log', 'main/console_mp.log', 'main/games_mp.log'],
  mw3: ['iw5/console_mp.log', 'iw5/logs/games_mp.log', 'iw5/games_mp.log', 'main/console_mp.log', 'main/games_mp.log'],
  bo2: ['t6/main/console_mp.log', 't6/main/logs/games_mp.log', 't6/main/games_mp.log', 'main/console_mp.log', 'main/games_mp.log'],
};

test('only six fixed engine log allowlists, rooted at the game and Plutonium storage', async () => fixture(async ({ gamePath, localAppData }) => {
  for (const [id, relative] of Object.entries(expected)) {
    const candidates = logCandidates({ id, gamePath, localAppData });
    assert.deepEqual(candidates.map(c => c.relative), relative);
    for (const candidate of candidates) {
      assert.equal(candidate.file, path.join(candidate.root, ...candidate.relative.split('/')));
      assert.ok(candidate.root === gamePath || candidate.root === path.join(localAppData, 'Plutonium', 'storage'));
      assert.doesNotMatch(candidate.file, /\.(?:bat|cfg)$/i);
    }
  }
  assert.throws(() => logCandidates({ id: 'constructor', gamePath, localAppData }), /Unknown game/);
  assert.throws(() => logCandidates({ id: 'cod4', gamePath: '../bad', localAppData }), /absolute log root/);
  assert.throws(() => logCandidates({ id: 'bo2', gamePath, localAppData: `${localAppData}${path.sep}..${path.sep}other` }), /absolute log root/);
  assert.equal(logCandidates({ id: 'cod4', gamePath: '', localAppData }).length, 0);
}));

test('skips old sessions, decodes split UTF-8, withholds incomplete lines, and redacts before delivery', async () => fixture(async ({ gamePath, localAppData }) => {
  const file = path.join(gamePath, 'main', 'console_mp.log');
  await put(file, 'previous session\n');
  const lines = [];
  const reader = tail('cod4', gamePath, localAppData, lines, { redact: value => value.replace(/private-key/g, '[redacted]') });
  try {
    await reader.start();
    await fs.appendFile(file, Buffer.from('hello\r\nsecret private-key\npart '));
    await reader.poll();
    assert.deepEqual(lines, ['hello', 'secret [redacted]']);
    const unicode = Buffer.from('💙 world\n');
    await fs.appendFile(file, unicode.subarray(0, 2));
    await reader.poll();
    assert.equal(lines.length, 2);
    await fs.appendFile(file, unicode.subarray(2));
    await reader.poll();
    assert.deepEqual(lines, ['hello', 'secret [redacted]', 'part 💙 world']);
    await reader.stop();
    await fs.appendFile(file, 'after stop\n');
    await reader.poll();
    assert.equal(lines.length, 3);
  } finally { await reader.stop(); }
}));

test('finds newly created files, switches to the freshest candidate, and resumes saved offsets', async () => fixture(async ({ gamePath, localAppData }) => {
  const first = path.join(gamePath, 'main', 'console_mp.log');
  const second = path.join(gamePath, 'mods', 'mp_bots', 'console_mp.log');
  const lines = [];
  await put(first, 'old\n');
  const reader = tail('cod4', gamePath, localAppData, lines);
  try {
    await reader.start();
    await fs.appendFile(first, 'one\n');
    await reader.poll();
    await put(second, 'new-file\n');
    await fs.utimes(second, new Date(Date.now() + 20_000), new Date(Date.now() + 20_000));
    await reader.poll();
    await fs.appendFile(first, 'two\n');
    await fs.utimes(first, new Date(Date.now() + 30_000), new Date(Date.now() + 30_000));
    await reader.poll();
    assert.deepEqual(lines, ['one', 'new-file', 'two']);
    await fs.rm(first);
    await fs.appendFile(second, 'back\n');
    await reader.poll();
    assert.deepEqual(lines, ['one', 'new-file', 'two', 'back']);
    await put(first, 'recreated\n');
    await fs.utimes(first, new Date(Date.now() + 40_000), new Date(Date.now() + 40_000));
    await reader.poll();
    assert.deepEqual(lines, ['one', 'new-file', 'two', 'back', 'recreated']);
  } finally { await reader.stop(); }
}));

test('starts over after truncation or replacement without joining partial old text', async () => fixture(async ({ gamePath, localAppData }) => {
  const file = path.join(localAppData, 'Plutonium', 'storage', 't6', 'main', 'console_mp.log');
  await put(file, 'old session\n');
  const lines = [];
  const reader = tail('bo2', gamePath, localAppData, lines);
  try {
    await reader.start();
    await fs.appendFile(file, 'unfinished-fragment');
    await reader.poll();
    await fs.writeFile(file, 'new\n');
    await reader.poll();
    assert.deepEqual(lines, ['new']);
    await fs.rename(file, `${file}.old`);
    await fs.writeFile(file, 'replacement\n');
    await reader.poll();
    assert.deepEqual(lines, ['new', 'replacement']);
  } finally { await reader.stop(); }
}));

test('detects same-size rewrites beyond the head but ignores timestamp-only touches', async () => fixture(async ({ gamePath, localAppData }) => {
  const file = path.join(gamePath, 'main', 'console_mp.log');
  const header = `${'H'.repeat(63)}\n`;
  const padding = `${'x'.repeat(20_000)}\n`;
  await put(file, `${header}${padding}old-entry\n`);
  const lines = [];
  const reader = tail('cod4', gamePath, localAppData, lines);
  const mtime = Date.now() + 30_000;
  try {
    await reader.start();
    assert.deepEqual(lines, []);
    await fs.utimes(file, new Date(mtime), new Date(mtime));
    await reader.poll();
    assert.deepEqual(lines, []);

    const handle = await fs.open(file, 'r+');
    try { await handle.write(Buffer.from('new-entry\n'), 0, 10, Buffer.byteLength(header + padding)); }
    finally { await handle.close(); }
    assert.equal((await fs.stat(file)).size, Buffer.byteLength(`${header}${padding}old-entry\n`));
    await fs.utimes(file, new Date(mtime + 10_000), new Date(mtime + 10_000));
    await reader.poll();
    assert.deepEqual(lines, [header.trimEnd(), 'new-entry']);
    await fs.utimes(file, new Date(mtime + 20_000), new Date(mtime + 20_000));
    await reader.poll();
    assert.deepEqual(lines, [header.trimEnd(), 'new-entry']);
    await fs.appendFile(file, 'fresh\n');
    await fs.utimes(file, new Date(mtime + 30_000), new Date(mtime + 30_000));
    await reader.poll();
    await fs.utimes(file, new Date(mtime + 40_000), new Date(mtime + 40_000));
    await reader.poll();
    assert.deepEqual(lines, [header.trimEnd(), 'new-entry', 'fresh']);
  } finally { await reader.stop(); }
}));

test('bounds bytes, callbacks, and partial lines; never reads unknown files', async () => fixture(async ({ gamePath, localAppData }) => {
  const file = path.join(gamePath, 'userraw', 'console_mp.log');
  const unrelated = path.join(gamePath, 'userraw', 'private.cfg');
  await put(unrelated, 'do-not-read\n');
  const lines = [];
  const reader = tail('mw2', gamePath, localAppData, lines);
  try {
    await reader.start();
    await put(file, `${'x'.repeat(30_000)}\n${'a\n'.repeat(200_000)}`);
    await reader.poll();
    assert.ok(reader.states.get(file).offset <= 256 * 1024);
    assert.ok(lines.length <= 200);
    assert.equal(lines.some(line => line.includes('x') || line.includes('do-not-read')), false);
    for (let i = 0; i < 4; i++) await reader.poll();
    assert.ok(lines.length <= 1000);
    assert.ok(reader.states.get(file).partial.length <= 8192);
    assert.ok(reader.states.get(file).pending.length <= 16 * 1024);
  } finally { await reader.stop(); }
}));

test('polls automatically and stops idempotently without launching any process', async () => fixture(async ({ gamePath, localAppData }) => {
  const file = path.join(gamePath, 'main', 'console_mp.log');
  await put(file, 'prior\n');
  const lines = [];
  const reader = tail('cod4', gamePath, localAppData, lines, { intervalMs: 10 });
  try {
    await reader.start();
    await reader.start();
    await fs.appendFile(file, 'automatic\n');
    for (let i = 0; i < 30 && lines.length === 0; i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.deepEqual(lines, ['automatic']);
    await reader.stop();
    await reader.stop();
    assert.equal(reader.timer, null);
  } finally { await reader.stop(); }
}));

test('does not follow a symlink outside the fixed log path', async t => fixture(async ({ root, gamePath, localAppData }) => {
  const outside = path.join(root, 'private.txt');
  const link = path.join(gamePath, 'main', 'console_mp.log');
  await put(outside, 'private-key\n');
  await fs.mkdir(path.dirname(link), { recursive: true });
  try { await fs.symlink(outside, link, 'file'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('OS disallows file symlinks'); return; }
    throw error;
  }
  const lines = [];
  const reader = tail('cod4', gamePath, localAppData, lines);
  try {
    await reader.start();
    await reader.poll();
    assert.deepEqual(lines, []);
    assert.equal(reader.states.size, 0);
  } finally { await reader.stop(); }
}));

test('rejects junctions in log parent directories', async t => fixture(async ({ root, gamePath, localAppData }) => {
  const outside = path.join(root, 'private-directory');
  await put(path.join(outside, 'console_mp.log'), 'private-key\n');
  try { await fs.symlink(outside, path.join(gamePath, 'main'), 'junction'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('OS disallows junctions'); return; }
    throw error;
  }
  const lines = [];
  const reader = tail('cod4', gamePath, localAppData, lines);
  try {
    await reader.start();
    await reader.poll();
    assert.deepEqual(lines, []);
    assert.equal(reader.states.size, 0);
  } finally { await reader.stop(); }
}));
