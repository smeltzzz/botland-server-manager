const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const gameIds = new Set(['waw', 'bo1', 'mw3', 'bo2']);
const maxFileBytes = 64 * 1024;
const maxCipherBytes = 16 * 1024;
const invalidStore = 'Stored server keys are unavailable.';

function validId(id) {
  if (typeof id !== 'string' || !gameIds.has(id)) throw new Error('Invalid Plutonium game ID.');
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function decodeCipher(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxCipherBytes * 4 / 3 + 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error(invalidStore);
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > maxCipherBytes || bytes.toString('base64') !== value) throw new Error(invalidStore);
  return bytes;
}

async function decryptKey(safeStorage, stored, asyncProvider) {
  const bytes = decodeCipher(stored);
  try {
    const key = asyncProvider ? (await safeStorage.decryptStringAsync(bytes)).result : safeStorage.decryptString(bytes);
    if (typeof key !== 'string' || !key) throw new Error(invalidStore);
    return key;
  } catch {
    throw new Error(invalidStore);
  } finally {
    bytes.fill(0);
  }
}

// Instantiate in Electron's main process with a file path under
// app.getPath('userData') and Electron's safeStorage. Never pass get() results
// through IPC or state snapshots.
class KeyStore {
  constructor(filePath, safeStorage) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('A private absolute key-store path is required.');
    const asyncProvider = safeStorage && typeof safeStorage.isAsyncEncryptionAvailable === 'function' &&
      typeof safeStorage.encryptStringAsync === 'function' && typeof safeStorage.decryptStringAsync === 'function';
    const syncProvider = safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' &&
      typeof safeStorage.encryptString === 'function' && typeof safeStorage.decryptString === 'function';
    if (!asyncProvider && !syncProvider) throw new Error('Electron safeStorage is required.');
    this.filePath = filePath;
    this.safeStorage = safeStorage;
    this.asyncProvider = asyncProvider;
    this.queue = Promise.resolve();
  }

  // Fail closed rather than using safeStorage's unencrypted fallback (including
  // on Windows when no user encryption provider is available).
  async requireEncryption() {
    let available = false;
    try {
      available = (this.asyncProvider
        ? await this.safeStorage.isAsyncEncryptionAvailable()
        : this.safeStorage.isEncryptionAvailable()) === true;
    } catch { /* unavailable */ }
    if (!available) throw new Error('Secure key storage is unavailable.');
  }

  run(work) {
    const pending = this.queue.then(work);
    this.queue = pending.then(() => {}, () => {});
    return pending;
  }

  async read() {
    let body;
    try {
      const info = await fs.lstat(this.filePath);
      if (!info.isFile() || info.size > maxFileBytes) throw new Error(invalidStore);
      body = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw new Error(invalidStore);
    }
    try {
      if (Buffer.byteLength(body, 'utf8') > maxFileBytes) throw new Error(invalidStore);
      const document = JSON.parse(body);
      if (!plainObject(document) || document.version !== 1 || !plainObject(document.keys) ||
          Object.keys(document).some(key => !['version', 'keys'].includes(key))) throw new Error(invalidStore);
      for (const [id, value] of Object.entries(document.keys)) {
        validId(id);
        decodeCipher(value);
      }
      return document.keys;
    } catch {
      // Neither malformed file content nor decryptor exceptions should reach UI/logs.
      throw new Error(invalidStore);
    }
  }

  async write(keys) {
    const body = JSON.stringify({ version: 1, keys });
    if (Buffer.byteLength(body, 'utf8') > maxFileBytes) throw new Error(invalidStore);
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temp = `${this.filePath}.${crypto.randomUUID()}.tmp`;
    let handle;
    try {
      handle = await fs.open(temp, 'wx', 0o600);
      await handle.writeFile(body, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temp, this.filePath);
    } finally {
      if (handle) await handle.close().catch(() => {});
      await fs.rm(temp, { force: true }).catch(() => {});
    }
  }

  async save(id, key) {
    validId(id);
    if (typeof key !== 'string' || !key || key.length > 4096 || /[\x00-\x1f\x7f]/.test(key) || !key.trim()) {
      throw new Error('Invalid server key.');
    }
    return this.run(async () => {
      await this.requireEncryption();
      const keys = await this.read();
      let cipher;
      try {
        cipher = this.asyncProvider ? await this.safeStorage.encryptStringAsync(key) : this.safeStorage.encryptString(key);
        // A misconfigured/mock provider must not accidentally persist the input.
        if (!Buffer.isBuffer(cipher) || !cipher.length || cipher.length > maxCipherBytes || cipher.toString('utf8') === key) {
          throw new Error('Invalid ciphertext.');
        }
        keys[id] = cipher.toString('base64');
      } catch {
        throw new Error('Could not encrypt server key.');
      }
      await this.write(keys);
    });
  }

  async has(id) {
    validId(id);
    return this.run(async () => {
      await this.requireEncryption();
      const stored = (await this.read())[id];
      if (stored === undefined) return false;
      await decryptKey(this.safeStorage, stored, this.asyncProvider);
      return true;
    });
  }

  // Backend only: callers must never return this value through preload/IPC.
  async get(id) {
    validId(id);
    return this.run(async () => {
      await this.requireEncryption();
      const stored = (await this.read())[id];
      return stored === undefined ? null : await decryptKey(this.safeStorage, stored, this.asyncProvider);
    });
  }

  async remove(id) {
    validId(id);
    return this.run(async () => {
      await this.requireEncryption();
      const keys = await this.read();
      if (!Object.hasOwn(keys, id)) return false;
      delete keys[id];
      await this.write(keys);
      return true;
    });
  }
}

module.exports = { KeyStore };
