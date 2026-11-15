const { isMarkedAsUntransferable } = require('node:worker_threads');

const errorTypes = { Error, TypeError, RangeError };
const fixedErrors = new Set([
  'ZIP input must be a Buffer or Uint8Array',
  'Unknown Bot Warfare game.', 'Unknown Bot Warfare channel.',
  'Bot Warfare archive entries must be a Map.',
  'CoD4 Bot Warfare CodeCallback_PlayerConnect anchor mismatch.',
  'CoD4 Bot Warfare CodeCallback_PlayerConnect body mismatch.',
  'Bot Warfare archive missing required file.',
  'Bot Warfare archive missing required waypoints.',
  'Bot Warfare source layout missing or ambiguous.',
  'Empty Bot Warfare waypoint.', 'Empty Bot Warfare source file.',
  'Invalid UTF-8 Bot Warfare source.',
  'Invalid archive worker request.', 'Unknown archive worker operation.',
  'Invalid archive worker result.', 'Archive worker output limit exceeded.',
  'Archive processing failed.',
]);
const relativeErrors = [
  ['Bot Warfare archive missing required file: ', 'Bot Warfare archive missing required file.'],
  ['Bot Warfare archive missing required waypoints: ', 'Bot Warfare archive missing required waypoints.'],
  ['Bot Warfare source layout missing or ambiguous: ', 'Bot Warfare source layout missing or ambiguous.'],
  ['Empty Bot Warfare waypoint: ', 'Empty Bot Warfare waypoint.'],
  ['Empty Bot Warfare source file: ', 'Empty Bot Warfare source file.'],
];

// Never forward stacks, filesystem paths, arbitrary thrown objects or untrusted
// archive filenames. Keep the parser's finite diagnostic reasons useful.
function archiveError(error) {
  const text = typeof error?.message === 'string' ? error.message : '';
  let message = 'Archive processing failed.';
  if (fixedErrors.has(text) || /^Invalid ZIP archive: [A-Za-z0-9 -]{1,120}$/u.test(text) ||
      /^(?:maxInputBytes|maxExtractedBytes|maxEntries|maxEntryBytes) must be an integer between 0 and [0-9]{1,10}$/u.test(text) ||
      /^Development Bot Warfare source layout unsupported for (?:cod4|mw2|mw3|waw|bo1|bo2)\.$/u.test(text)) {
    message = text;
  } else if (error?.code === 'ERR_ENCODING_INVALID_ENCODED_DATA') {
    message = 'Invalid UTF-8 Bot Warfare source.';
  } else {
    message = relativeErrors.find(([prefix]) => text.startsWith(prefix))?.[1] || message;
  }
  const name = Object.hasOwn(errorTypes, error?.name) ? error.name : 'Error';
  return { name, message };
}
function restoreError(raw) {
  const safe = archiveError(raw);
  return new errorTypes[safe.name](safe.message);
}

function restoreFiles(raw, limits) {
  if (!(raw instanceof Map)) throw new Error('Invalid archive worker result.');
  if (raw.size > limits.maxEntries) throw new Error('Archive worker output limit exceeded.');
  const files = new Map();
  let size = 0;
  for (const [name, body] of raw) {
    if (typeof name !== 'string' || !name || !(body instanceof Uint8Array) || !(body.buffer instanceof ArrayBuffer)) {
      throw new Error('Invalid archive worker result.');
    }
    size += body.byteLength;
    if (body.byteLength > limits.maxEntryBytes || size > limits.maxExtractedBytes) {
      throw new Error('Archive worker output limit exceeded.');
    }
    // Structured cloning preserves Map but converts Buffers to Uint8Arrays.
    // Re-wrap transferred storage, rather than copying the extracted payloads
    // (up to 200 MiB) again on the Electron main thread.
    files.set(name, Buffer.from(body.buffer, body.byteOffset, body.byteLength));
  }
  return files;
}
function transferFiles(raw, limits) {
  const files = restoreFiles(raw, limits);
  const transfers = new Set();
  for (const [name, body] of files) {
    // Small Buffers share an untransferable Node slab. Never clone or expose
    // that whole slab; give those views their own exact-size backing store.
    const bytes = body.byteOffset === 0 && body.byteLength === body.buffer.byteLength && !isMarkedAsUntransferable(body.buffer)
      ? body : Uint8Array.from(body);
    files.set(name, bytes);
    transfers.add(bytes.buffer);
  }
  return { files, transferList: [...transfers] };
}
function restorePlan(raw, limits) {
  if (!raw || !['game', 'plutonium'].includes(raw.target) || typeof raw.base !== 'string' || raw.base.length > 128 ||
      (raw.storageCode !== undefined && !['iw5', 't4', 't5', 't6'].includes(raw.storageCode)) ||
      !Array.isArray(raw.patches) || raw.patches.length > 32 || raw.patches.some(patch => typeof patch !== 'string' || patch.length > 256)) {
    throw new Error('Invalid archive worker result.');
  }
  return { target: raw.target, base: raw.base, ...(raw.storageCode === undefined ? {} : { storageCode: raw.storageCode }),
    files: restoreFiles(raw.files, limits), patches: raw.patches };
}

module.exports = { archiveError, restoreError, restoreFiles, transferFiles, restorePlan };
