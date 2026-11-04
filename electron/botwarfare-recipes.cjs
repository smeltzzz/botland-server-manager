const { zipSync } = require('fflate');

// Pure archive-to-install plans. The caller resolves base beneath the selected
// game or Plutonium storage root; this module neither reads nor writes files.
const TARGETS = Object.freeze({
  cod4: { target: 'game', base: 'mods/mp_bots' },
  mw2: { target: 'game', base: 'userraw' },
  mw3: { target: 'plutonium', storageCode: 'iw5', base: 'mods/bots' },
  waw: { target: 'plutonium', storageCode: 't4', base: 'mods/mp_bots' },
  bo1: { target: 'plutonium', storageCode: 't5', base: 'mods/mp_bots' },
  bo2: { target: 'plutonium', storageCode: 't6', base: 'scripts/mp' },
});

const COD4_ROOT = 'Add to root of CoD4x server/mods/mp_bots/';
const MW2_ROOT = 'Move files to root of MW2 folder/mods/mp_bots/';
const CALLBACK = 'maps/mp/gametypes/_callbacksetup.gsx';
const CLIENT_ID_LINES = [
  '// Cod4R\'s qol.ff replaces _clientids.gsc and no longer assigns clientid, but stock',
  '// scripts (_gameobjects, _globallogic damage code) still index arrays by it.',
  'if ( !isDefined( level.clientid ) )',
  '\tlevel.clientid = 0;',
  'if ( !isDefined( self.clientid ) )',
  '{',
  '\tself.clientid = level.clientid;',
  '\tlevel.clientid++;',
  '}',
];

function required(entries, name) {
  const bytes = entries.get(name);
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw new Error(`Bot Warfare archive missing required file: ${name}`);
  return bytes;
}

function waypoints(entries, prefix, files, requiredCount = false) {
  let count = 0;
  for (const [name, bytes] of entries) {
    if (!name.startsWith(prefix)) continue;
    const filename = name.slice(prefix.length);
    if (!filename || filename.includes('/') || !filename.toLowerCase().endsWith('.csv')) continue;
    if (!Buffer.isBuffer(bytes) || !bytes.length) throw new Error(`Empty Bot Warfare waypoint: ${name}`);
    files.set('scriptdata/waypoints/' + filename, Buffer.from(bytes));
    count++;
  }
  if (requiredCount && !count) throw new Error(`Bot Warfare archive missing required waypoints: ${prefix}*.csv`);
}

// Keep the original newline convention and refuse to guess if upstream changes
// the callback. Reprocessing a previously patched archive is byte-for-byte safe.
function patchCallback(bytes, patches) {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const functions = [...text.matchAll(/^CodeCallback_PlayerConnect\(\)[ \t]*\r?$/gm)];
  const anchor = /^CodeCallback_PlayerConnect\(\)[ \t]*(\r?\n)\{[ \t]*\1([ \t]*)self endon\( "disconnect" \);[ \t]*(\r?\n)/gm;
  const matches = [...text.matchAll(anchor)];
  if (functions.length !== 1 || matches.length !== 1 || matches[0].index !== functions[0].index) {
    throw new Error('CoD4 Bot Warfare CodeCallback_PlayerConnect anchor mismatch.');
  }
  const match = matches[0];
  const after = text.slice(match.index + match[0].length);
  const indent = match[2];
  const newline = match[3];
  const snippet = CLIENT_ID_LINES.map(line => indent + line).join(newline) + newline;
  const patched = after.startsWith(snippet);
  const following = patched ? after.slice(snippet.length) : after;
  if (!following.startsWith(`${indent}[[level.callbackPlayerConnect]]();`)) {
    throw new Error('CoD4 Bot Warfare CodeCallback_PlayerConnect body mismatch.');
  }
  if (patched) return Buffer.from(bytes);
  patches.push('Cod4R clientid initialization');
  return Buffer.from(text.slice(0, match.index + match[0].length) + snippet + after, 'utf8');
}

// GitHub source ZIPs have one generated top-level directory. Also accept a
// root-level tree, but never choose between multiple plausible source trees.
function sourceRoot(entries, marker) {
  const roots = new Set();
  for (const name of entries.keys()) {
    if (name === marker) roots.add('');
    else if (name.endsWith('/' + marker)) {
      const root = name.slice(0, -marker.length);
      if (!root.slice(0, -1).includes('/')) roots.add(root);
    }
  }
  if (roots.size !== 1) throw new Error(`Bot Warfare source layout missing or ambiguous: ${marker}`);
  return [...roots][0];
}

function cod4Development(entries, files, patches) {
  const root = sourceRoot(entries, CALLBACK);
  const callback = patchCallback(required(entries, root + CALLBACK), patches);
  // Check both the bot runtime and its Cod4x adapter before constructing an
  // IWD. A partial source snapshot must not become an apparently valid mod.
  for (const name of ['maps/mp/bots/_bot.gsc', 'scripts/mp/bots.gsc', 'scripts/mp/bots_adapter_cod4x.gsc']) {
    required(entries, root + name);
  }
  const content = Object.create(null);
  for (const [name, bytes] of entries) {
    if (!name.startsWith(root)) continue;
    const relative = name.slice(root.length);
    if (!/^(?:maps|scripts)\//u.test(relative) || /\.(?:gsx|bat|cmd|ps1|cfg|exe)$/iu.test(relative)) continue;
    if (!Buffer.isBuffer(bytes) || !bytes.length) throw new Error(`Empty Bot Warfare source file: ${name}`);
    content[relative] = new Uint8Array(bytes);
  }
  files.set('z_svr_bots.iwd', Buffer.from(zipSync(content, { level: 6 })));
  files.set(CALLBACK, callback);
  waypoints(entries, root + 'scriptdata/waypoints/', files);
  patches.push('CoD4: build IWD from source maps/ and scripts/ (excluding .gsx)');
}

function bo2Source(entries, files) {
  const root = sourceRoot(entries, 'scripts/mp/bots.gsc');
  for (const name of ['bots.gsc', 'bots_adapter_pt6.gsc']) {
    files.set(name, Buffer.from(required(entries, root + 'scripts/mp/' + name)));
  }
}

/**
 * @param {string} id Game profile id.
 * @param {'stable'|'development'} channel Source channel.
 * @param {Map<string, Buffer>} entries Normalized, collision-checked readModArchive output.
 * @returns {{target: 'game'|'plutonium', storageCode?: string, base: string, files: Map<string, Buffer>, patches: string[]}}
 */
function recipeFor(id, channel, entries) {
  if (typeof id !== 'string' || !Object.hasOwn(TARGETS, id)) throw new Error('Unknown Bot Warfare game.');
  if (channel !== 'stable' && channel !== 'development') throw new Error('Unknown Bot Warfare channel.');
  if (!(entries instanceof Map)) throw new TypeError('Bot Warfare archive entries must be a Map.');
  const files = new Map();
  const patches = [];
  if (channel === 'development') {
    if (id === 'cod4') cod4Development(entries, files, patches);
    else if (id === 'bo2') bo2Source(entries, files); // Same verified source layout as the pinned T6 snapshot.
    else throw new Error(`Development Bot Warfare source layout unsupported for ${id}.`);
  } else if (id === 'cod4') {
    files.set('z_svr_bots.iwd', Buffer.from(required(entries, COD4_ROOT + 'z_svr_bots.iwd')));
    files.set(CALLBACK, patchCallback(required(entries, COD4_ROOT + CALLBACK), patches));
    waypoints(entries, COD4_ROOT + 'scriptdata/waypoints/', files, true);
  } else if (id === 'mw2') {
    // IW4x in this app runs with fs_game empty and looks for IWDs in userraw.
    files.set('z_svr_bots.iwd', Buffer.from(required(entries, MW2_ROOT + 'z_svr_bots.iwd')));
    waypoints(entries, MW2_ROOT + 'scriptdata/waypoints/', files, true);
  } else if (id === 'mw3') {
    files.set('z_svr_bots.iwd', Buffer.from(required(entries, 'z_svr_bots.iwd')));
  } else if (id === 'waw') {
    files.set('z_svr_bots.iwd', Buffer.from(required(entries, 'mp_bots/z_svr_bots.iwd')));
  } else if (id === 'bo1') {
    const prefix = 'Move to root of Black Ops folder/mods/mp_bots/';
    for (const name of ['description.txt', 'mod.ff', 'mp_bots.iwd']) {
      files.set(name, Buffer.from(required(entries, prefix + name)));
    }
  } else {
    bo2Source(entries, files);
  }
  return { ...TARGETS[id], files, patches };
}

module.exports = { recipeFor };
