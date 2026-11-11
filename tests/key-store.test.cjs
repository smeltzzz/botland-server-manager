const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { KeyStore } = require('../electron/key-store.cjs');

async function fixture(work) {
  const root = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp', 'opencode');
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'botland-keys-'));
  try { return await work(path.join(dir, 'private', 'keys.json'), dir); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
}

function fakeSafeStorage() {
  const secret = crypto.randomBytes(32);
  let available = true;
  return {
    setAvailable(value) { available = value; },
    isEncryptionAvailable() { return available; },
    encryptString(value) {
      const nonce = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', secret, nonce);
      const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), body]);
    },
    decryptString(value) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', secret, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}

test('prefers Electron async safeStorage without calling deprecated synchronous methods', async () => fixture(async file => {
  const provider = fakeSafeStorage();
  const asyncProvider = {
    isAsyncEncryptionAvailable: async () => provider.isEncryptionAvailable(),
    encryptStringAsync: async value => provider.encryptString(value),
    decryptStringAsync: async bytes => ({ result: provider.decryptString(bytes), shouldReEncrypt: false }),
    isEncryptionAvailable: () => { throw new Error('Deprecated method called.'); },
    encryptString: () => { throw new Error('Deprecated method called.'); },
    decryptString: () => { throw new Error('Deprecated method called.'); },
  };
  const store = new KeyStore(file, asyncProvider);
  await store.save('waw', 'synthetic-async-key');
  assert.equal(await store.has('waw'), true);
  assert.equal(await store.get('waw'), 'synthetic-async-key');
  assert.equal(await store.remove('waw'), true);
  provider.setAvailable(false);
  await assert.rejects(store.save('waw', 'synthetic-async-key'), /unavailable/);
}));

test('encrypted keys survive a new store instance; only presence is returned by has', async () => fixture(async (file, dir) => {
  const provider = fakeSafeStorage();
  const store = new KeyStore(file, provider);
  const key = 'private-token-987654';
  assert.equal(await store.has('waw'), false);
  assert.equal(await store.get('waw'), null);
  assert.equal(await store.remove('waw'), false);
  await store.save('waw', key);
  assert.equal(await store.has('waw'), true);
  assert.equal(await new KeyStore(file, provider).get('waw'), key);
  const contents = await fs.readFile(file, 'utf8');
  assert.equal(contents.includes(key), false);
  assert.deepEqual(Object.keys(JSON.parse(contents).keys), ['waw']);
  assert.deepEqual(await fs.readdir(path.dirname(file)), ['keys.json']);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(file)).mode & 0o077, 0);
    assert.equal((await fs.stat(path.dirname(file))).mode & 0o077, 0);
  }
  assert.equal((await fs.readdir(dir)).length, 1);
}));

test('serializes simultaneous saves, replaces keys and removes one game without losing others', async () => fixture(async file => {
  const store = new KeyStore(file, fakeSafeStorage());
  await Promise.all(['waw', 'bo1', 'mw3', 'bo2'].map(id => store.save(id, `key-for-${id}`)));
  for (const id of ['waw', 'bo1', 'mw3', 'bo2']) assert.equal(await store.get(id), `key-for-${id}`);
  await store.save('bo1', 'replacement');
  assert.equal(await store.get('bo1'), 'replacement');
  assert.equal(await store.remove('waw'), true);
  assert.equal(await store.has('waw'), false);
  assert.equal(await store.get('bo2'), 'key-for-bo2');
  assert.equal(await store.remove('bo1'), true);
  assert.equal(await store.remove('mw3'), true);
  assert.equal(await store.remove('bo2'), true);
  assert.equal(await store.get('bo2'), null);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).keys, {});
}));

test('rejects invalid game IDs and key input before writing', async () => fixture(async file => {
  assert.throws(() => new KeyStore('keys.json', fakeSafeStorage()), /absolute key-store path/);
  assert.throws(() => new KeyStore(file, {}), /safeStorage is required/);
  const store = new KeyStore(file, fakeSafeStorage());
  for (const id of ['cod4', 'mw2', '../bo2', '', null, '__proto__']) {
    await assert.rejects(store.save(id, 'secret'));
    await assert.rejects(store.has(id));
    await assert.rejects(store.get(id));
    await assert.rejects(store.remove(id));
  }
  for (const key of ['', '  ', 'value\r\nmore', 'value\0more', 123, 'x'.repeat(4097)]) {
    await assert.rejects(store.save('bo2', key), /Invalid server key/);
  }
  // The failed validations above must not create a store or spill input to disk.
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
}));

test('refuses every operation when encryption is unavailable without touching the file', async () => fixture(async file => {
  const provider = fakeSafeStorage();
  const store = new KeyStore(file, provider);
  await store.save('mw3', 'keep-this-secret');
  const original = await fs.readFile(file);
  provider.setAvailable(false);
  for (const operation of [store.save('mw3', 'new-secret'), store.has('mw3'), store.get('mw3'), store.remove('mw3')]) {
    await assert.rejects(operation, /Secure key storage is unavailable/);
  }
  assert.deepEqual(await fs.readFile(file), original);
  provider.setAvailable(true);
  assert.equal(await store.get('mw3'), 'keep-this-secret');
}));

test('rejects malformed, unexpected and tampered data with generic errors, without rewriting it', async () => fixture(async file => {
  const provider = fakeSafeStorage();
  const store = new KeyStore(file, provider);
  await store.save('bo2', 'unpublished-secret');
  const valid = JSON.parse(await fs.readFile(file, 'utf8'));
  const badFiles = [
    '{"private":"unpublished-secret"',
    JSON.stringify({ version: 1, keys: { cod4: 'AAAA' } }),
    JSON.stringify({ version: 1, keys: { bo2: '!!!unpublished-secret!!!' } }),
    JSON.stringify({ version: 2, keys: valid.keys }),
    JSON.stringify({ version: 1, keys: { bo2: valid.keys.bo2 }, extra: 'unpublished-secret' }),
  ];
  for (const body of badFiles) {
    await fs.writeFile(file, body);
    for (const operation of [() => store.has('bo2'), () => store.get('bo2'), () => store.save('waw', 'new-secret'), () => store.remove('bo2')]) {
      await assert.rejects(operation(), error => error.message === 'Stored server keys are unavailable.' &&
        !String(error.stack).includes('unpublished-secret'));
    }
    assert.equal(await fs.readFile(file, 'utf8'), body);
  }
  valid.keys.bo2 = Buffer.from(valid.keys.bo2, 'base64').map((byte, index) => index === 28 ? byte ^ 1 : byte).toString('base64');
  await fs.writeFile(file, JSON.stringify(valid));
  await assert.rejects(store.has('bo2'), { message: 'Stored server keys are unavailable.' });
  await assert.rejects(store.get('bo2'), { message: 'Stored server keys are unavailable.' });
}));

test('rejects a provider that returns plaintext and leaves an existing store intact on write failure', async () => fixture(async file => {
  const provider = fakeSafeStorage();
  const store = new KeyStore(file, provider);
  await store.save('waw', 'existing-secret');
  const original = await fs.readFile(file);
  const badProvider = { ...provider, encryptString: value => Buffer.from(value) };
  await assert.rejects(new KeyStore(file, badProvider).save('bo1', 'unprotected-secret'), /Could not encrypt server key/);
  assert.deepEqual(await fs.readFile(file), original);

  const rename = fs.rename;
  fs.rename = async () => { throw new Error('simulated rename failure'); };
  try {
    await assert.rejects(store.save('bo1', 'new-secret'), /simulated rename failure/);
  } finally { fs.rename = rename; }
  assert.deepEqual(await fs.readFile(file), original);
  assert.deepEqual(await fs.readdir(path.dirname(file)), ['keys.json']);
  assert.equal(await store.get('waw'), 'existing-secret');
}));

test('reports why a key is unavailable: encryption, damaged file, or another Windows profile', async () => fixture(async file => {
  const provider = fakeSafeStorage();
  const store = new KeyStore(file, provider);
  await store.save('waw', 'profile-a-secret');
  provider.setAvailable(false);
  await assert.rejects(store.has('waw'), { code: 'encryption-unavailable' });
  provider.setAvailable(true);

  // Same file, but this profile's encryption key differs (e.g. restored from another account).
  const otherProfile = new KeyStore(file, fakeSafeStorage());
  await assert.rejects(otherProfile.has('waw'), { code: 'unreadable', message: 'Stored server keys are unavailable.' });
  await assert.rejects(otherProfile.get('waw'), { code: 'unreadable' });
  assert.equal(await otherProfile.has('bo2'), false, 'games without a stored key are unaffected');

  await fs.writeFile(file, '{"not":"a key store"');
  await assert.rejects(store.has('waw'), { code: 'damaged' });
  await assert.rejects(store.save('waw', 'new-secret'), { code: 'damaged' });
}));

test('saving a key replaces an entry this profile cannot decrypt and leaves the others alone', async () => fixture(async file => {
  const oldProfile = new KeyStore(file, fakeSafeStorage());
  for (const id of ['waw', 'bo1', 'mw3']) await oldProfile.save(id, `old-${id}-secret`);

  const store = new KeyStore(file, fakeSafeStorage());
  for (const id of ['waw', 'bo1', 'mw3']) await assert.rejects(store.has(id), { code: 'unreadable' });
  await store.save('waw', 'fresh-waw-secret');
  assert.equal(await store.has('waw'), true);
  assert.equal(await store.get('waw'), 'fresh-waw-secret');
  await assert.rejects(store.has('bo1'), { code: 'unreadable' });
  await assert.rejects(store.has('mw3'), { code: 'unreadable' });
  assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(file, 'utf8')).keys).sort(), ['bo1', 'mw3', 'waw']);
  assert.equal((await fs.readFile(file, 'utf8')).includes('fresh-waw-secret'), false);
}));

test('resetDamaged keeps the unreadable file aside, never touches a readable one, and lets keys be saved again', async () => fixture(async (file, dir) => {
  const provider = fakeSafeStorage();
  const store = new KeyStore(file, provider);
  assert.equal(await store.resetDamaged(), null, 'a missing store is not damaged');
  await store.save('bo2', 'readable-secret');
  const original = await fs.readFile(file);
  assert.equal(await store.resetDamaged(), null);
  assert.deepEqual(await fs.readFile(file), original, 'a readable store is left untouched');

  // An entry another profile wrote is unreadable, not damaged, so it is also left alone.
  const otherProfile = new KeyStore(file, fakeSafeStorage());
  assert.equal(await otherProfile.resetDamaged(), null);
  assert.deepEqual(await fs.readFile(file), original);

  const damaged = '{"version":1,"keys":{"waw":"%%%not-base64%%%"}}';
  await fs.writeFile(file, damaged);
  await assert.rejects(store.save('waw', 'blocked-secret'), { code: 'damaged' });
  provider.setAvailable(false);
  const moved = await store.resetDamaged();
  provider.setAvailable(true);
  assert.match(moved, /^keys\.json\.corrupt-/);
  assert.equal(await fs.readFile(path.join(path.dirname(file), moved), 'utf8'), damaged, 'the bad file is kept, not deleted');
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  assert.equal(await store.has('waw'), false);
  await store.save('waw', 'fresh-secret');
  assert.equal(await store.get('waw'), 'fresh-secret');
  assert.equal((await fs.readdir(path.dirname(file))).length, 2);
  assert.equal((await fs.readdir(dir)).length, 1);
}));
