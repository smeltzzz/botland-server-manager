const { Inflate } = require('fflate');

// Archive bytes are held in memory; output limits apply to the sum of *all*
// entries, including directories, before any entry is inflated.
const ARCHIVE_LIMITS = Object.freeze({
  maxInputBytes: 80 * 1024 * 1024,
  maxExtractedBytes: 200 * 1024 * 1024,
  maxEntries: 10000,
  maxEntryBytes: 50 * 1024 * 1024,
});

const decoder = new TextDecoder('utf-8', { fatal: true });
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value >>> 0;
});

function fail(message) {
  throw new Error(`Invalid ZIP archive: ${message}`);
}

function bounds(bytes, offset, length, end = bytes.length) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > end) {
    fail('truncated or out-of-bounds record');
  }
}

function extraFields(bytes, start, length) {
  const end = start + length;
  bounds(bytes, start, length);
  for (let position = start; position < end;) {
    bounds(bytes, position, 4, end);
    const field = bytes.readUInt16LE(position);
    const size = bytes.readUInt16LE(position + 2);
    position += 4;
    bounds(bytes, position, size, end);
    // ZIP64, AES and alternate Unicode names make metadata ambiguous.
    if (field === 0x0001 || field === 0x9901 || field === 0x7075) fail('unsupported extra field');
    position += size;
  }
}

function nameOf(bytes, directory) {
  let name;
  try { name = decoder.decode(bytes); } catch { fail('invalid UTF-8 filename'); }
  if (!name || /[\u0000-\u001f\u007f]/u.test(name)) fail('empty or control-character filename');
  if (name.startsWith('/') || name.startsWith('\\') || /^[a-zA-Z]:/u.test(name)) fail('absolute path');
  const parts = name.replace(/\\/gu, '/').split('/');
  if (directory && parts.at(-1) === '') parts.pop();
  if (parts.some(part => part === '..')) fail('parent traversal');
  // Remove harmless repeated separators and dot components, but never a parent.
  const normalized = parts.filter(part => part && part !== '.').map(part => part.normalize('NFC'));
  if (!normalized.length) fail('empty path');
  for (const part of normalized) {
    // Windows alternate streams, device names and invalid filename characters
    // must not become a write target if a caller later persists these files.
    if (/[<>:"|?*]/u.test(part) || /[. ]$/u.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)) {
      fail('unsafe Windows path component');
    }
  }
  return normalized.join('/');
}

function checksum(data, previous = 0xffffffff) {
  let crc = previous;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return crc >>> 0;
}

function readModArchive(input, options = {}) {
  if (!(input instanceof Uint8Array)) throw new TypeError('ZIP input must be a Buffer or Uint8Array');
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const limits = { ...ARCHIVE_LIMITS, ...options };
  for (const key of Object.keys(ARCHIVE_LIMITS)) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 0 || limits[key] > ARCHIVE_LIMITS[key]) {
      throw new RangeError(`${key} must be an integer between 0 and ${ARCHIVE_LIMITS[key]}`);
    }
  }
  if (bytes.length > limits.maxInputBytes) fail('compressed input limit exceeded');
  if (bytes.length < 22) fail('missing end of central directory');

  // EOCD may have up to 65535 bytes of comment; insist it ends at EOF.
  let eocd = -1;
  for (let pos = bytes.length - 22; pos >= Math.max(0, bytes.length - 22 - 65535); pos--) {
    if (bytes.readUInt32LE(pos) === 0x06054b50 && pos + 22 + bytes.readUInt16LE(pos + 20) === bytes.length) {
      eocd = pos;
      break;
    }
  }
  if (eocd < 0) fail('missing end of central directory');
  if (bytes.readUInt16LE(eocd + 4) || bytes.readUInt16LE(eocd + 6) ||
      bytes.readUInt16LE(eocd + 8) !== bytes.readUInt16LE(eocd + 10)) fail('multi-disk ZIP unsupported');
  const count = bytes.readUInt16LE(eocd + 10);
  const size = bytes.readUInt32LE(eocd + 12);
  const start = bytes.readUInt32LE(eocd + 16);
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff) fail('ZIP64 unsupported');
  if (count > limits.maxEntries) fail('entry count limit exceeded');
  if (start + size !== eocd) fail('invalid central directory bounds');

  const entries = [];
  const names = new Set();
  const files = new Set();
  const parents = new Set();
  let total = 0;
  let cursor = start;
  for (let i = 0; i < count; i++) {
    bounds(bytes, cursor, 46, eocd);
    if (bytes.readUInt32LE(cursor) !== 0x02014b50) fail('invalid central directory entry');
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const crc = bytes.readUInt32LE(cursor + 16);
    const compressed = bytes.readUInt32LE(cursor + 20);
    const unpacked = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const disk = bytes.readUInt16LE(cursor + 34);
    const attributes = bytes.readUInt32LE(cursor + 38);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const end = cursor + 46 + nameLength + extraLength + commentLength;
    bounds(bytes, cursor, end - cursor, eocd);
    if (flags & (1 | 0x40 | 0x2000)) fail('encrypted entry');
    if (flags & ~(0x800 | 0x8)) fail('unsupported ZIP flags');
    if (method !== 0 && method !== 8) fail('unsupported compression method');
    if (disk || compressed === 0xffffffff || unpacked === 0xffffffff || localOffset === 0xffffffff) fail('ZIP64 or multi-disk entry unsupported');
    if (!nameLength) fail('empty filename');
    extraFields(bytes, cursor + 46 + nameLength, extraLength);
    const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const slash = rawName.at(-1) === 47 || rawName.at(-1) === 92;
    const dosDirectory = !!(attributes & 0x10);
    const unixType = (attributes >>> 16) & 0o170000;
    if (attributes & (0x08 | 0x40) || (unixType && unixType !== 0o100000 && unixType !== 0o040000)) fail('special entry');
    if ((dosDirectory && !slash) || (unixType === 0o040000 && !slash) || (unixType === 0o100000 && slash)) {
      fail('inconsistent directory entry');
    }
    const directory = slash;
    const name = nameOf(rawName, directory);
    const key = name.toLowerCase();
    if (names.has(key)) fail('duplicate or case-colliding path');
    names.add(key);
    if (!directory) files.add(key);
    for (let at = key.indexOf('/'); at >= 0; at = key.indexOf('/', at + 1)) {
      const parent = key.slice(0, at);
      if (files.has(parent)) fail('file is also a directory');
      parents.add(parent);
    }
    if (!directory && parents.has(key)) fail('file is also a directory');
    if (unpacked > limits.maxEntryBytes) fail('single entry limit exceeded');
    total += unpacked;
    if (total > limits.maxExtractedBytes) fail('total extracted size limit exceeded');
    entries.push({ name, rawName, directory, flags, method, crc, compressed, unpacked, localOffset });
    cursor = end;
  }
  if (cursor !== eocd) fail('central directory size mismatch');

  // Verify every local header and payload range before decompressing anything.
  const ranges = [];
  for (const entry of entries) {
    const at = entry.localOffset;
    bounds(bytes, at, 30, start);
    if (bytes.readUInt32LE(at) !== 0x04034b50) fail('missing local header');
    const flags = bytes.readUInt16LE(at + 6);
    if (flags !== entry.flags || bytes.readUInt16LE(at + 8) !== entry.method) fail('local header mismatch');
    const localCrc = bytes.readUInt32LE(at + 14);
    const localCompressed = bytes.readUInt32LE(at + 18);
    const localUnpacked = bytes.readUInt32LE(at + 22);
    const nameLength = bytes.readUInt16LE(at + 26);
    const extraLength = bytes.readUInt16LE(at + 28);
    const dataStart = at + 30 + nameLength + extraLength;
    bounds(bytes, at, dataStart - at, start);
    if (!bytes.subarray(at + 30, at + 30 + nameLength).equals(entry.rawName)) fail('local filename mismatch');
    extraFields(bytes, at + 30 + nameLength, extraLength);
    if (localCompressed === 0xffffffff || localUnpacked === 0xffffffff) fail('ZIP64 unsupported');
    if (entry.flags & 8) {
      if (localCrc && localCrc !== entry.crc || localCompressed && localCompressed !== entry.compressed ||
          localUnpacked && localUnpacked !== entry.unpacked) fail('local sizes mismatch');
    } else if (localCrc !== entry.crc || localCompressed !== entry.compressed || localUnpacked !== entry.unpacked) {
      fail('local sizes mismatch');
    }
    let dataEnd = dataStart + entry.compressed;
    bounds(bytes, dataStart, entry.compressed, start);
    if (entry.flags & 8) {
      bounds(bytes, dataEnd, 12, start);
      const descriptor = bytes.readUInt32LE(dataEnd) === 0x08074b50 &&
        bytes.readUInt32LE(dataEnd + 4) === entry.crc ? 4 : 0;
      bounds(bytes, dataEnd, descriptor + 12, start);
      if (bytes.readUInt32LE(dataEnd + descriptor) !== entry.crc ||
          bytes.readUInt32LE(dataEnd + descriptor + 4) !== entry.compressed ||
          bytes.readUInt32LE(dataEnd + descriptor + 8) !== entry.unpacked) fail('invalid data descriptor');
      dataEnd += descriptor + 12;
    }
    ranges.push([at, dataEnd]);
    entry.dataStart = dataStart;
  }
  ranges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++) if (ranges[i][0] < ranges[i - 1][1]) fail('overlapping entries');

  const result = new Map();
  for (const entry of entries) {
    const data = bytes.subarray(entry.dataStart, entry.dataStart + entry.compressed);
    let output;
    if (entry.method === 0) {
      if (entry.compressed !== entry.unpacked) fail('stored entry size mismatch');
      output = Buffer.from(data);
    } else {
      if (!data.length) fail('empty DEFLATE stream');
      output = Buffer.alloc(entry.unpacked);
      let position = 0;
      const inflater = new Inflate(chunk => {
        if (position + chunk.length > output.length) fail('DEFLATE output exceeds declared size');
        output.set(chunk, position);
        position += chunk.length;
      });
      // Bound per-push memory even if the declared uncompressed size is a lie.
      for (let offset = 0; offset < data.length; offset += 1024) {
        const end = Math.min(offset + 1024, data.length);
        inflater.push(data.subarray(offset, end), end === data.length);
      }
      if (position !== output.length) fail('DEFLATE output size mismatch');
    }
    if (((checksum(output) ^ 0xffffffff) >>> 0) !== entry.crc) fail('CRC mismatch');
    if (entry.directory) {
      if (output.length) fail('directory contains data');
    } else {
      result.set(entry.name, output);
    }
  }
  return result;
}

module.exports = { readModArchive, ARCHIVE_LIMITS };
