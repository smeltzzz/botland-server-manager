const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { appIds } = require('./artwork.cjs');
const { order, profileFor, bootstrapPath } = require('./profiles.cjs');

const steamKey = 'HKCU\\Software\\Valve\\Steam';
/** @typedef {{ regQuery?: (args: string[]) => Promise<string>, bootstrapperPath?: string }} DetectionOptions */
/** @typedef {{ gamePath: string, installed: boolean, enginePath: string, engineInstalled: boolean }} GameDetection */
const multiplayerFiles = {
  cod4: 'iw3mp.exe', waw: 'CoDWaWmp.exe', mw2: 'iw4mp.exe',
  bo1: 'BlackOpsMP.exe', mw3: 'iw5mp.exe', bo2: 't6mp.exe',
};

/** Run one fixed, read-only registry query. Pass an async regQuery(args) in tests. */
function querySteamRegistry(args) {
  return new Promise((resolve, reject) => {
    execFile('reg', args, { windowsHide: true, timeout: 3000, maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

/** Return only absolute local/UNC paths without controls or traversal segments. */
function safeDirectory(value) {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f\x7f"<>|?*]/.test(value)) return '';
  const directory = value.trim();
  if (!path.isAbsolute(directory) || /^\\\\[?.]\\/.test(directory) || directory.split(/[\\/]/).includes('..')) return '';
  return path.resolve(directory);
}

function parseSteamPath(output) {
  if (typeof output !== 'string') return '';
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*SteamPath\s+REG_SZ\s+(.+?)\s*$/i);
    if (match) {
      const value = match[1].trim();
      return safeDirectory(value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value);
    }
  }
  return '';
}

/** Minimal Steam KeyValues parser: quoted strings, escaped slashes/quotes and nested objects. */
function parseVdf(text) {
  if (typeof text !== 'string' || text.length > 2_000_000) throw new Error('Invalid VDF.');
  const tokens = [];
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (i < text.length) {
    if (/\s/.test(text[i])) { i++; continue; }
    if (text.slice(i, i + 2) === '//') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (text[i] === '{' || text[i] === '}') { tokens.push(text[i++]); continue; }
    if (text[i] !== '"') throw new Error('Invalid VDF token.');
    i++;
    let value = '';
    let closed = false;
    while (i < text.length) {
      const char = text[i++];
      if (char === '"') { closed = true; break; }
      if (char === '\\' && (text[i] === '\\' || text[i] === '"')) value += text[i++];
      else value += char;
    }
    if (!closed) throw new Error('Unterminated VDF string.');
    tokens.push({ value });
  }
  let position = 0;
  function object(depth, nested) {
    if (depth > 16) throw new Error('VDF nesting limit exceeded.');
    const result = Object.create(null);
    while (position < tokens.length && tokens[position] !== '}') {
      const key = tokens[position++];
      const next = tokens[position++];
      if (!key || typeof key !== 'object' || !next) throw new Error('Invalid VDF pair.');
      if (next === '{') result[key.value] = object(depth + 1, true);
      else if (typeof next === 'object') result[key.value] = next.value;
      else throw new Error('Invalid VDF value.');
    }
    if (nested && tokens[position++] !== '}') throw new Error('Unclosed VDF object.');
    return result;
  }
  const result = object(0, false);
  if (position !== tokens.length) throw new Error('Unexpected VDF closing brace.');
  return result;
}

function field(object, key) {
  if (!object || typeof object !== 'object') return undefined;
  const match = Object.keys(object).find(name => name.toLowerCase() === key.toLowerCase());
  return match === undefined ? undefined : object[match];
}

async function isDirectory(file) {
  try { return (await fs.stat(file)).isDirectory(); } catch { return false; }
}
async function isFile(file) {
  try { return (await fs.stat(file)).isFile(); } catch { return false; }
}
async function readVdf(file) {
  try {
    if ((await fs.stat(file)).size > 2_000_000) return null;
    return parseVdf(await fs.readFile(file, 'utf8'));
  } catch { return null; }
}

/**
 * Discover the primary Steam directory and all valid old/new libraryfolders paths.
 * @param {DetectionOptions} [options]
 * @returns {Promise<{steamPath: string, libraries: string[]}>}
 */
async function steamLibraries({ regQuery = querySteamRegistry } = {}) {
  let steamPath = '';
  try { steamPath = parseSteamPath(await regQuery(['query', steamKey, '/v', 'SteamPath'])); } catch { /* Steam not registered. */ }
  if (!steamPath || !await isDirectory(steamPath)) return { steamPath: '', libraries: [] };
  const libraries = [steamPath];
  const vdf = await readVdf(path.join(steamPath, 'steamapps', 'libraryfolders.vdf'));
  const folders = field(vdf, 'libraryfolders');
  if (folders && typeof folders === 'object') {
    for (const [index, entry] of Object.entries(folders)) {
      if (!/^\d+$/.test(index)) continue;
      const directory = safeDirectory(typeof entry === 'string' ? entry : field(entry, 'path'));
      if (directory && !libraries.some(existing => existing.toLowerCase() === directory.toLowerCase()) && await isDirectory(directory)) libraries.push(directory);
    }
  }
  return { steamPath, libraries };
}

function safeInstallDir(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 255 &&
    !/[\\/:*?"<>|\x00-\x1f\x7f]/.test(value) && value !== '.' && value !== '..' &&
    !/[. ]$/.test(value) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
}

/**
 * Check a manually browsed folder without requiring a Steam manifest.
 * The global Plutonium engine can be present even when the game is missing.
 * @param {string} id
 * @param {string} folder
 * @param {DetectionOptions} [options]
 * @returns {Promise<GameDetection>}
 */
async function inspectGameFolder(id, folder, { bootstrapperPath = bootstrapPath() } = {}) {
  const profile = profileFor(id);
  const directory = safeDirectory(folder);
  const installed = Boolean(directory && await isDirectory(directory) && await isFile(path.join(directory, multiplayerFiles[id])));
  const gamePath = installed ? directory : '';
  const engineCandidate = profile.executable === 'plutonium' ? safeDirectory(bootstrapperPath) :
    (installed ? path.join(directory, profile.executable) : '');
  const engineInstalled = Boolean(engineCandidate && await isFile(engineCandidate));
  return { gamePath, installed, enginePath: engineInstalled ? engineCandidate : '', engineInstalled };
}

/** Manifest + MP files must agree; libraryfolders `apps` hints alone are not evidence. */
async function steamGame(id, libraries, options) {
  const appId = appIds[id];
  for (const library of libraries) {
    const manifest = await readVdf(path.join(library, 'steamapps', `appmanifest_${appId}.acf`));
    const state = field(manifest, 'AppState');
    if (!state || String(field(state, 'appid')) !== appId) continue;
    const folder = field(state, 'installdir');
    if (!safeInstallDir(folder)) continue;
    const result = await inspectGameFolder(id, path.join(library, 'steamapps', 'common', folder), options);
    if (result.installed) return result;
  }
  return inspectGameFolder(id, '', options);
}

/**
 * Per-game results are safe to use as suggestions; a missing install never supplies a gamePath.
 * @param {DetectionOptions} [options]
 * @returns {Promise<{steamPath: string, libraries: string[], games: Record<string, GameDetection>}>}
 */
async function detectSteamGames(options = {}) {
  const { steamPath, libraries } = await steamLibraries(options);
  const games = Object.fromEntries(await Promise.all(order.map(async id => [id, await steamGame(id, libraries, options)])));
  return { steamPath, libraries, games };
}

/** @param {string} id @param {DetectionOptions} [options] @returns {Promise<GameDetection>} */
async function detectGame(id, options = {}) {
  profileFor(id);
  const { libraries } = await steamLibraries(options);
  return steamGame(id, libraries, options);
}

module.exports = { parseVdf, parseSteamPath, steamLibraries, inspectGameFolder, detectSteamGames, detectGame };
