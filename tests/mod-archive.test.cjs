const test = require('node:test');
const assert = require('node:assert/strict');
const { zipSync } = require('fflate');
const { readModArchive, ARCHIVE_LIMITS } = require('../electron/mod-archive.cjs');

function zip(entries, options = {}) {
  const files = Object.create(null);
  for (const [name, body] of entries) files[name] = Buffer.from(body);
  return Buffer.from(zipSync(files, options));
}

function central(zipBytes) {
  const eocd = zipBytes.length - 22;
  const count = zipBytes.readUInt16LE(eocd + 10);
  let cursor = zipBytes.readUInt32LE(eocd + 16);
  const offsets = [];
  for (let i = 0; i < count; i++) {
    offsets.push(cursor);
    cursor += 46 + zipBytes.readUInt16LE(cursor + 28) + zipBytes.readUInt16LE(cursor + 30) + zipBytes.readUInt16LE(cursor + 32);
  }
  return offsets;
}

function rename(zipBytes, index, name) {
  const at = central(zipBytes)[index];
  const raw = Buffer.from(name);
  assert.equal(raw.length, zipBytes.readUInt16LE(at + 28), 'replacement filename must have the same byte length');
  raw.copy(zipBytes, at + 46);
  raw.copy(zipBytes, zipBytes.readUInt32LE(at + 42) + 30);
  return zipBytes;
}

function descriptorZip() {
  const original = zip([['file.txt', 'hello']]);
  const at = central(original)[0];
  const end = original.length - 22;
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50, 0);
  original.copy(descriptor, 4, at + 16, at + 28);
  const withDescriptor = Buffer.concat([original.subarray(0, at), descriptor, original.subarray(at)]);
  withDescriptor.writeUInt32LE(at + descriptor.length, end + descriptor.length + 16);
  withDescriptor.writeUInt16LE(8, 6);
  withDescriptor.writeUInt16LE(8, at + descriptor.length + 8);
  withDescriptor.fill(0, 14, 26);
  return withDescriptor;
}

test('reads files only, normalizes POSIX paths and preserves binary contents', () => {
  const bytes = zip([['release/', ''], ['release/mods/', ''], ['release/mods/a.iwd', Buffer.from([0, 128, 255])], ['release/README.txt', 'text']]);
  const files = readModArchive(bytes);
  assert.ok(files instanceof Map);
  assert.deepEqual([...files.keys()], ['release/mods/a.iwd', 'release/README.txt']);
  assert.deepEqual(files.get('release/mods/a.iwd'), Buffer.from([0, 128, 255]));
  assert.equal(files.get('release/README.txt').toString(), 'text');
  assert.deepEqual([...readModArchive(rename(zip([['foo/bar.txt', 'ok']]), 0, 'foo\\bar.txt')).keys()], ['foo/bar.txt']);
  assert.deepEqual([...readModArchive(descriptorZip()).keys()], ['file.txt']);
});

test('rejects traversal, absolute paths, drive names, NUL and Windows devices', () => {
  const names = ['../bad.txt', 'a/../b.txt', '/root.txt', 'C:evil.txt', '\\host.txt', 'a\0bad.txt', 'CON/x.txt', 'x:bad.txt'];
  for (const name of names) {
    const template = 'x'.repeat(Buffer.byteLength(name));
    const archive = rename(zip([[template, 'content']]), 0, name);
    assert.throws(() => readModArchive(archive), /path|filename|character|traversal|component/u, name);
  }
});

test('rejects duplicate, case-colliding, normalized and file/directory-conflicting names', () => {
  for (const pair of [['a.txt', 'a.txt'], ['A.txt', 'a.txt'], ['a/./b', 'a/b'], ['a', 'a/b'], ['a/b', 'a']]) {
    // zipSync takes distinct keys; mutate equal-length names afterward.
    const bytes = zip([['x'.repeat(pair[0].length), 'one'], ['y'.repeat(pair[1].length), 'two']]);
    rename(bytes, 0, pair[0]);
    rename(bytes, 1, pair[1]);
    assert.throws(() => readModArchive(bytes), /duplicate|directory/u, pair.join(' and '));
  }
  const colliding = zip([['e\u0301.txt', 'one'], ['é.txt', 'two']]);
  assert.throws(() => readModArchive(colliding), /duplicate/u);
});

test('rejects symlinks, special entries, encrypted entries and unsupported compression', () => {
  for (const mode of [0o120777, 0o060644, 0o020666]) {
    const bytes = zip([['link', 'target']]);
    bytes.writeUInt32LE((mode << 16) >>> 0, central(bytes)[0] + 38);
    assert.throws(() => readModArchive(bytes), /special/u);
  }
  for (const flags of [1, 0x40]) {
    const bytes = zip([['file', 'data']]);
    bytes.writeUInt16LE(flags, 6);
    bytes.writeUInt16LE(flags, central(bytes)[0] + 8);
    assert.throws(() => readModArchive(bytes), /encrypted/u);
  }
  const bytes = zip([['file', 'data']]);
  bytes.writeUInt16LE(99, 8);
  bytes.writeUInt16LE(99, central(bytes)[0] + 10);
  assert.throws(() => readModArchive(bytes), /compression/u);
});

test('rejects invalid UTF-8, ZIP64 metadata, overlapping records and broken descriptors', () => {
  const invalidName = zip([['x', 'data']]);
  invalidName[central(invalidName)[0] + 46] = 0xff;
  invalidName[30] = 0xff;
  assert.throws(() => readModArchive(invalidName), /UTF-8/u);

  const zip64 = zip([['file', 'data']]);
  zip64.writeUInt32LE(0xffffffff, central(zip64)[0] + 24);
  assert.throws(() => readModArchive(zip64), /ZIP64/u);

  const overlap = zip([['first', 'one'], ['second', 'two']]);
  const [first, second] = central(overlap);
  const firstOffset = overlap.readUInt32LE(first + 42);
  overlap.writeUInt32LE(firstOffset, second + 42);
  assert.throws(() => readModArchive(overlap), /mismatch|overlap/u);

  const descriptor = descriptorZip();
  const at = central(descriptor)[0];
  const descriptorStart = at - 16;
  descriptor.writeUInt32LE(0, descriptorStart + 4);
  assert.throws(() => readModArchive(descriptor), /descriptor/u);
});

test('enforces compressed input, entry count, total output and single-entry limits before inflating', () => {
  const bytes = zip([['a', '1234'], ['b', '5678']], { level: 9 });
  assert.throws(() => readModArchive(bytes, { maxInputBytes: bytes.length - 1 }), /compressed input/u);
  assert.throws(() => readModArchive(bytes, { maxEntries: 1 }), /entry count/u);
  assert.throws(() => readModArchive(bytes, { maxEntryBytes: 3 }), /single entry/u);
  assert.throws(() => readModArchive(bytes, { maxExtractedBytes: 7 }), /total extracted/u);
  assert.equal(readModArchive(bytes, { maxEntries: 2, maxEntryBytes: 4, maxExtractedBytes: 8 }).size, 2);
  assert.throws(() => readModArchive(bytes, { maxEntries: ARCHIVE_LIMITS.maxEntries + 1 }), RangeError);
});

test('rejects forged size bomb, bad CRC and truncated local or central data', () => {
  const bomb = zip([['bomb', Buffer.alloc(1024 * 1024, 65)]], { level: 9 });
  const at = central(bomb)[0];
  bomb.writeUInt32LE(16, at + 24);
  bomb.writeUInt32LE(16, 22);
  assert.throws(() => readModArchive(bomb), /DEFLATE output/u);

  const crc = zip([['file', 'payload']]);
  crc.writeUInt32LE(0, central(crc)[0] + 16);
  crc.writeUInt32LE(0, 14);
  assert.throws(() => readModArchive(crc), /CRC/u);

  const valid = zip([['file', 'payload']]);
  assert.throws(() => readModArchive(valid.subarray(0, valid.length - 1)), /central directory/u);
  const broken = Buffer.from(valid);
  broken.writeUInt32LE(broken.length, central(broken)[0] + 42);
  assert.throws(() => readModArchive(broken), /out-of-bounds/u);
  const mismatched = Buffer.from(valid);
  mismatched.writeUInt32LE(9999, central(mismatched)[0] + 20);
  mismatched.writeUInt32LE(9999, 18);
  assert.throws(() => readModArchive(mismatched), /out-of-bounds/u);
});
