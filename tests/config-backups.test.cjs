const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { listBackups, previewRestore, restoreBackup, pruneBackups } = require('../electron/config-backups.cjs');
const { previewConfig, saveConfig } = require('../electron/config.cjs');

const root = path.join(process.env.LOCALAPPDATA || require('node:os').tmpdir(), 'Temp', 'opencode');
async function fixture(run) {
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'config-backups-'));
  try { await run(dir); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
}
async function savedConfig(file, original) {
  await fs.writeFile(file, original);
  const preview = await previewConfig(file, { sv_hostname: 'After' });
  await saveConfig(file, { sv_hostname: 'After' }, { token: preview.token });
  return (await listBackups(file))[0];
}
const bomConfig = Buffer.from('\ufeffset sv_hostname "Before"\r\nset rcon_password "extremely-private-password"\r\nset key "private-server-key"\r\n');

test('lists only exact config.cjs backup names with opaque IDs and dates', async () => fixture(async dir => {
  const file = path.join(dir, 'server.cfg');
  const original = Buffer.from('set sv_hostname "Before"\n');
  const item = await savedConfig(file, original);
  assert.match(item.id, /^[0-9a-f]{64}$/);
  assert.match(item.date, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.equal(item.bytes, original.length);
  assert.equal(JSON.stringify(item).includes(dir), false);
  await fs.writeFile(`${file}.bak-not-a-save`, 'unrelated');
  await fs.writeFile(`${file}.bak-2026-01-01T00-00-00-000Z-not-a-uuid`, 'unrelated');
  assert.equal((await listBackups(file)).length, 1);
  await assert.rejects(listBackups('server.cfg'), /absolute/);
  await assert.rejects(previewRestore(file, '../server.cfg'), /Invalid backup ID/);
}));

test('preview never exposes secrets; restore retains selected backup and exact original bytes', async () => fixture(async dir => {
  const file = path.join(dir, 'server.cfg');
  const item = await savedConfig(file, bomConfig);
  const edited = await fs.readFile(file);
  const preview = await previewRestore(file, item.id);
  assert.match(preview.token, /^[0-9a-f]{64}$/);
  assert.equal(preview.summary.changed, true);
  assert.equal(preview.summary.contents, '••••••');
  assert.equal(JSON.stringify(preview).includes('extremely-private-password'), false);
  assert.equal(JSON.stringify(preview).includes('private-server-key'), false);
  const result = await restoreBackup(file, item.id, preview.token);
  assert.deepEqual(await fs.readFile(file), bomConfig);
  const listed = await listBackups(file);
  assert.equal(listed.length, 2);
  assert.ok(listed.some(entry => entry.id === item.id));
  assert.ok(listed.some(entry => entry.id === result.backupId && entry.bytes === edited.length));
  const files = await fs.readdir(dir);
  const beforeRestore = files.find(name => name.startsWith('server.cfg.bak-') && crypto.createHash('sha256').update(JSON.stringify(['config-backup-v1', file, name])).digest('hex') === item.id);
  const savedEdited = files.find(name => name.startsWith('server.cfg.bak-') && name !== beforeRestore);
  assert.deepEqual(await fs.readFile(path.join(dir, beforeRestore)), bomConfig);
  assert.deepEqual(await fs.readFile(path.join(dir, savedEdited)), edited);
}));

test('restore copies Latin-1 bytes and mixed line endings without decoding', async () => fixture(async dir => {
  const file = path.join(dir, 'server.cfg');
  const original = Buffer.from([0x73, 0x65, 0x74, 0x20, 0x73, 0x76, 0x5f, 0x68, 0x6f, 0x73, 0x74, 0x6e, 0x61, 0x6d, 0x65, 0x20, 0x22, 0xe9, 0x22, 0x0d, 0x0a, 0x2f, 0x2f, 0x20, 0xff, 0x0a]);
  const item = await savedConfig(file, original);
  const { token } = await previewRestore(file, item.id);
  await restoreBackup(file, item.id, token);
  assert.deepEqual(await fs.readFile(file), original);
}));

test('current or backup changes after preview refuse restore without creating a new backup', async () => fixture(async dir => {
  const file = path.join(dir, 'server.cfg');
  const item = await savedConfig(file, bomConfig);
  const before = await listBackups(file);
  const preview = await previewRestore(file, item.id);
  await fs.appendFile(file, Buffer.from('// external edit\r\n'));
  await assert.rejects(restoreBackup(file, item.id, preview.token), /changed since preview/);
  assert.equal((await listBackups(file)).length, before.length);
  const next = await previewRestore(file, item.id);
  const backupName = (await fs.readdir(dir)).find(name => name.startsWith('server.cfg.bak-'));
  await fs.appendFile(path.join(dir, backupName), Buffer.from('// changed backup\r\n'));
  await assert.rejects(restoreBackup(file, item.id, next.token), /changed since preview/);
  assert.equal((await listBackups(file)).length, before.length);
}));

test('two simultaneous restores with the same token cannot both commit', async () => fixture(async dir => {
  const file = path.join(dir, 'server.cfg');
  const original = Buffer.from('set sv_hostname "Before"\n');
  const item = await savedConfig(file, original);
  const preview = await previewRestore(file, item.id);
  const results = await Promise.allSettled([restoreBackup(file, item.id, preview.token), restoreBackup(file, item.id, preview.token)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.deepEqual(await fs.readFile(file), original);
  assert.equal((await listBackups(file)).length, 2);
}));

test('failed restore publish preserves the config and removes staged files and the new backup', async () => fixture(async dir => {
  const file = path.join(dir, 'server.cfg');
  const item = await savedConfig(file, bomConfig);
  const edited = await fs.readFile(file);
  const { token } = await previewRestore(file, item.id);
  const before = (await fs.readdir(dir)).sort();
  const rename = fs.rename;
  let attempts = 0;
  let staged = [];
  try {
    fs.rename = async (...args) => {
      if (args[1] !== file) return rename(...args);
      attempts++;
      staged = (await fs.readdir(dir)).filter(name => !before.includes(name));
      throw Object.assign(new Error('simulated publish failure'), { code: 'EPERM' });
    };
    await assert.rejects(restoreBackup(file, item.id, token), /Could not write server\.cfg.*read-only or in use/);
  } finally { fs.rename = rename; }
  assert.equal(attempts, 1);
  assert.equal(staged.filter(name => name.endsWith('.tmp')).length, 1);
  assert.equal(staged.filter(name => name.startsWith('server.cfg.bak-')).length, 1);
  assert.deepEqual(await fs.readFile(file), edited);
  assert.deepEqual(await fs.readdir(dir).then(names => names.sort()), before);
  assert.deepEqual((await listBackups(file)).map(entry => entry.id), [item.id]);
  const result = await restoreBackup(file, item.id, token);
  assert.deepEqual(await fs.readFile(file), bomConfig);
  assert.equal((await listBackups(file)).some(entry => entry.id === result.backupId && entry.bytes === edited.length), true);
}));

test('duplicate timestamps remain distinct; prune requires explicit own IDs and does not delete foreign files', async () => fixture(async dir => {
  const file = path.join(dir, 'server.cfg');
  const other = path.join(dir, 'other.cfg');
  const item = await savedConfig(file, Buffer.from('set sv_hostname "Before"\n'));
  const first = (await fs.readdir(dir)).find(name => name.startsWith('server.cfg.bak-'));
  const duplicate = first.replace(/[0-9a-f]{8}-[0-9a-f-]{27}$/, crypto.randomUUID());
  assert.notEqual(duplicate, first);
  await fs.copyFile(path.join(dir, first), path.join(dir, duplicate));
  await savedConfig(other, Buffer.from('set sv_hostname "Other"\n'));
  const foreign = (await listBackups(other))[0];
  const list = await listBackups(file);
  assert.equal(list.length, 2);
  assert.equal(list[0].date, list[1].date);
  assert.notEqual(list[0].id, list[1].id);
  await assert.rejects(pruneBackups(file), /Explicit/);
  await assert.rejects(pruneBackups(file, []), /Explicit/);
  await assert.rejects(pruneBackups(file, [item.id, foreign.id]), /not found/);
  assert.equal((await listBackups(file)).length, 2);
  await assert.rejects(previewRestore(file, foreign.id), /not found/);
  await pruneBackups(file, [item.id]);
  assert.equal((await listBackups(file)).length, 1);
  assert.equal((await listBackups(other)).length, 1);
}));

test('failed prune reports partial progress and continues deleting the other selected backups', async () => fixture(async dir => {
  const file = path.join(dir, 'server.cfg');
  const other = path.join(dir, 'other.cfg');
  await savedConfig(file, Buffer.from('set sv_hostname "Before"\n'));
  for (const hostname of ['Second', 'Third']) {
    const preview = await previewConfig(file, { sv_hostname: hostname });
    await saveConfig(file, { sv_hostname: hostname }, { token: preview.token });
  }
  const selected = await listBackups(file);
  assert.equal(selected.length, 3);
  const failed = selected[0];
  const name = (await fs.readdir(dir)).find(name => name.startsWith('server.cfg.bak-') && crypto.createHash('sha256').update(JSON.stringify(['config-backup-v1', file, name])).digest('hex') === failed.id);
  assert.ok(name);
  const otherBackup = await savedConfig(other, Buffer.from('set sv_hostname "Other"\n'));
  const unlink = fs.unlink;
  const attempted = [];
  try {
    fs.unlink = async backup => {
      attempted.push(backup);
      if (backup === path.join(dir, name)) throw Object.assign(new Error('simulated locked backup'), { code: 'EBUSY' });
      return unlink(backup);
    };
    await assert.rejects(pruneBackups(file, selected.map(entry => entry.id)), /Removed 2 of 3 backups;.*read-only or in use/);
  } finally { fs.unlink = unlink; }
  assert.equal(attempted.length, 3);
  assert.equal(attempted[0], path.join(dir, name));
  assert.deepEqual((await listBackups(file)).map(entry => entry.id), [failed.id]);
  assert.deepEqual((await listBackups(other)).map(entry => entry.id), [otherBackup.id]);
  assert.deepEqual(await pruneBackups(file, [failed.id]), { removed: 1 });
  assert.deepEqual(await listBackups(file), []);
}));

test('rejects linked config files and backups', async t => fixture(async dir => {
  const file = path.join(dir, 'server.cfg');
  const item = await savedConfig(file, Buffer.from('set sv_hostname "Before"\n'));
  const hardlink = path.join(dir, 'hardlink.cfg');
  await fs.link(file, hardlink);
  await assert.rejects(listBackups(file), /regular|unlinked/);
  await fs.unlink(hardlink);
  const linked = path.join(dir, 'linked.cfg');
  try { await fs.symlink(file, linked, 'file'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('Creating file symlinks requires privileges on this host.');
    throw error;
  }
  await assert.rejects(listBackups(linked), /regular|unlinked/);
  const backupName = (await fs.readdir(dir)).find(name => name.startsWith('server.cfg.bak-'));
  await fs.unlink(path.join(dir, backupName));
  await fs.symlink(file, path.join(dir, backupName), 'file');
  assert.deepEqual(await listBackups(file), []);
  await assert.rejects(previewRestore(file, item.id), /not found/);
  await assert.rejects(pruneBackups(file, [item.id]), /not found/);
}));

test('resolves a junctioned game folder to its real location for backups', async () => fixture(async dir => {
  // Games moved to another drive are commonly reached through a junction; the
  // backups saved through that path must remain listable through it.
  const file = path.join(dir, 'server.cfg');
  await savedConfig(file, Buffer.from('set sv_hostname "Before"\n'));
  const junction = path.join(dir, 'junction');
  await fs.symlink(dir, junction, process.platform === 'win32' ? 'junction' : 'dir');
  const direct = await listBackups(file);
  const linked = await listBackups(path.join(junction, 'server.cfg'));
  assert.equal(linked.length, 1);
  assert.deepEqual(linked.map(item => item.date), direct.map(item => item.date));
}));
