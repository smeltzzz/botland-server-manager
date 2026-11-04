const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { constants } = require('node:fs');

// config.cjs writes only this timestamp/UUID form. IDs are path-bound digests,
// never paths supplied by the caller or names returned to the UI.
const backupSuffix = /^\.bak-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const digestPattern = /^[0-9a-f]{64}$/;
const pending = new Map();
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function target(file) {
  if (typeof file !== 'string' || !file || file.includes('\0') || !path.isAbsolute(file) || path.normalize(file) !== file || file.endsWith(path.sep)) throw new Error('An absolute, normalized config file path is required.');
  if (process.platform === 'win32' && (file.startsWith('\\\\') || file.slice(2).includes(':') || file.split(/[\\/]/).some(part => /[. ]$/.test(part)))) throw new Error('Unsupported config file path.');
  return file;
}

function locked(file, action) {
  file = target(file);
  const key = process.platform === 'win32' ? file.toLowerCase() : file;
  const previous = pending.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(() => action(file));
  pending.set(key, current);
  return current.finally(() => { if (pending.get(key) === current) pending.delete(key); });
}

async function safeDirectory(file) {
  const dir = path.dirname(file);
  const root = path.parse(dir).root;
  let part = root;
  for (const segment of dir.slice(root.length).split(path.sep).filter(Boolean)) {
    part = path.join(part, segment);
    const stat = await fs.lstat(part);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Config directory must not contain links.');
  }
}

function regular(stat) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw new Error('Config and backups must be regular, unlinked files.');
}
function identity(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.nlink].map(String).join(':');
}
async function readRegular(file) {
  const before = await fs.lstat(file, { bigint: true });
  regular(before);
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat({ bigint: true });
    regular(opened);
    if (identity(before) !== identity(opened)) throw new Error('File changed during review.');
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const named = await fs.lstat(file, { bigint: true });
    regular(named);
    if (identity(before) !== identity(after) || identity(before) !== identity(named)) throw new Error('File changed during review.');
    return { bytes, identity: identity(before) };
  } finally { await handle.close(); }
}
function backupId(file, name) { return hash(Buffer.from(JSON.stringify(['config-backup-v1', file, name]))); }

async function candidates(file) {
  await safeDirectory(file);
  await readRegular(file);
  const prefix = `${path.basename(file)}.bak-`;
  const entries = await fs.readdir(path.dirname(file), { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    if (!entry.name.startsWith(prefix)) continue;
    const match = backupSuffix.exec(entry.name.slice(path.basename(file).length));
    if (!match || !entry.isFile() || entry.isSymbolicLink()) continue;
    const date = match[1].replace(/T(\d\d)-(\d\d)-(\d\d)-(\d\d\d)Z$/, 'T$1:$2:$3.$4Z');
    if (Number.isNaN(Date.parse(date))) continue;
    const backup = path.join(path.dirname(file), entry.name);
    const stat = await fs.lstat(backup, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) continue;
    found.push({ id: backupId(file, entry.name), date, bytes: Number(stat.size), backup });
  }
  return found;
}
async function selected(file, id) {
  if (typeof id !== 'string' || !digestPattern.test(id)) throw new Error('Invalid backup ID.');
  const item = (await candidates(file)).find(candidate => candidate.id === id);
  if (!item) throw new Error('Backup not found for this config.');
  return item;
}
function tokenFor(file, id, current, backup) {
  return hash(Buffer.from(JSON.stringify(['config-restore-v1', file, id, hash(current.bytes), current.identity, hash(backup.bytes), backup.identity])));
}
async function review(file, id) {
  const item = await selected(file, id);
  const current = await readRegular(file);
  const backup = await readRegular(item.backup);
  return { item, current, backup, token: tokenFor(file, id, current, backup) };
}
async function writeExclusive(file, bytes) {
  const handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  let complete = false;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    complete = true;
  } finally {
    if (!complete) {
      await handle.close().catch(() => {});
      await fs.rm(file, { force: true }).catch(() => {});
    }
  }
}
function newBackup(file) { return `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}`; }

async function listBackups(file) {
  return locked(file, async file => (await candidates(file))
    .map(({ id, date, bytes }) => ({ id, date, bytes }))
    .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id)));
}
async function previewRestore(file, id) {
  return locked(file, async file => {
    const { current, backup, token } = await review(file, id);
    return { token, summary: { changed: !current.bytes.equals(backup.bytes), currentBytes: current.bytes.length, backupBytes: backup.bytes.length, contents: '••••••' } };
  });
}
async function restoreBackup(file, id, token) {
  return locked(file, async file => {
    if (typeof token !== 'string' || !digestPattern.test(token)) throw new Error('Invalid restore token.');
    const { item, current, backup, token: expected } = await review(file, id);
    if (token !== expected) throw new Error('Config or backup changed since preview. Review the restore again.');
    await safeDirectory(file);
    const saved = newBackup(file);
    const temp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
    let replaced = false;
    let created = false;
    try {
      await writeExclusive(saved, current.bytes);
      created = true;
      await writeExclusive(temp, backup.bytes);
      // Check both paths again after the writes, not just the preview token.
      const now = await readRegular(file);
      const source = await readRegular(item.backup);
      await safeDirectory(file);
      if (tokenFor(file, id, now, source) !== expected) throw new Error('Config or backup changed during restore. Review the restore again.');
      await fs.rename(temp, file);
      replaced = true;
      return { backupId: backupId(file, path.basename(saved)) };
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
      if (created && !replaced) await fs.rm(saved, { force: true }).catch(() => {});
    }
  });
}
async function pruneBackups(file, ids) {
  return locked(file, async file => {
    if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !digestPattern.test(id)) || new Set(ids).size !== ids.length) throw new Error('Explicit, unique backup IDs are required.');
    const all = await candidates(file);
    const chosen = ids.map(id => {
      const item = all.find(candidate => candidate.id === id);
      if (!item) throw new Error('Backup not found for this config.');
      return item;
    });
    for (const item of chosen) {
      await safeDirectory(file);
      await readRegular(item.backup);
      await fs.unlink(item.backup);
    }
    return { removed: chosen.length };
  });
}
module.exports = { listBackups, previewRestore, restoreBackup, pruneBackups };
