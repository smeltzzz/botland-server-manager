// Shape validation for renderer → main `manager:action` payloads. This only
// checks types and sizes so malformed input is rejected before it reaches the
// ServerManager; semantic validation (modes installed, tokens, etc.) stays in
// the manager. Keep in sync with electron/preload.cjs and src/types.ts.
const { profiles } = require('./profiles.cjs');

const MAX_STRING = 4096;
const MAX_PATH = 32_768;
const MAX_LIST = 1000;
const MAX_VALUES = 500;

function fail(message) { throw new Error(message); }
function isPlain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function gameId(value) {
  if (typeof value !== 'string' || !Object.hasOwn(profiles, value)) fail('Invalid game id.');
}
function string(value, label, max = MAX_STRING, optional = false) {
  if (optional && value === undefined) return;
  if (typeof value !== 'string' || value.length > max) fail(`Invalid ${label}.`);
}
function boolean(value, label) {
  if (typeof value !== 'boolean') fail(`Invalid ${label}.`);
}
function stringList(value, label, maxItems = MAX_LIST, maxLength = MAX_STRING) {
  if (!Array.isArray(value) || value.length > maxItems || !value.every(item => typeof item === 'string' && item.length <= maxLength)) fail(`Invalid ${label}.`);
}
function configTarget(payload) {
  if (payload.target !== undefined && payload.target !== 'base' && payload.target !== 'mode') fail('Invalid config target or mode.');
  if (payload.mode !== undefined && (typeof payload.mode !== 'string' || payload.mode.length > 64)) fail('Invalid config target or mode.');
}
function configValues(values) {
  if (!isPlain(values)) fail('Invalid config values.');
  const entries = Object.entries(values);
  if (entries.length > MAX_VALUES || !entries.every(([key, value]) => key.length <= 128 && typeof value === 'string' && value.length <= MAX_STRING)) fail('Invalid config values.');
}
function options(values) {
  if (!isPlain(values)) fail('Invalid options.');
  for (const [key, value] of Object.entries(values)) {
    if (key === 'port') { if (typeof value !== 'number' || !Number.isFinite(value)) fail('Invalid port.'); }
    else if (key === 'mode') string(value, 'mode', 64);
    else if (key === 'shuffle' || key === 'lan') boolean(value, key);
    else if (key === 'selectedMaps') stringList(value, 'map selection', MAX_LIST, 128);
    else fail('Invalid options.');
  }
}

const idOnly = new Set(['getLogs', 'maps', 'start', 'stop', 'chooseFolder', 'useDetectedFolder', 'createStarterConfig', 'botStatus',
  'removeKey', 'openEngineGuide', 'firewallStatus', 'firewallApply', 'firewallRemove', 'openDocs', 'openConfig']);

function validatePayload(action, payload) {
  if (typeof action !== 'string' || !isPlain(payload)) fail('Invalid request.');
  if (idOnly.has(action)) { gameId(payload.id); return; }
  switch (action) {
    case 'setAutoRestart': gameId(payload.id); boolean(payload.enabled, 'restart setting'); return;
    case 'copyConnectAddress': gameId(payload.id); string(payload.address, 'connect address', 256); return;
    case 'botAction': gameId(payload.id); string(payload.operation, 'Bot Warfare operation', 32); return;
    case 'setBotChannel': gameId(payload.id); string(payload.channel, 'Bot Warfare channel', 32); return;
    case 'setUpdateChecks': boolean(payload.enabled, 'update-check setting'); return;
    case 'saveKey': gameId(payload.id); string(payload.key, 'server key'); return;
    case 'chooseArtwork': case 'resetArtwork': gameId(payload.id); string(payload.kind, 'artwork kind', 16); return;
    case 'saveOptions': gameId(payload.id); options(payload.values); return;
    case 'document': case 'listConfigBackups': case 'openDocument': gameId(payload.id); configTarget(payload); return;
    case 'previewSettings':
      gameId(payload.id); configTarget(payload); configValues(payload.values);
      string(payload.expectedPath, 'config path', MAX_PATH, true); return;
    case 'commitSettings':
      gameId(payload.id); configTarget(payload); configValues(payload.values);
      string(payload.token, 'preview token', 128); string(payload.expectedPath, 'config path', MAX_PATH, true); return;
    case 'previewConfigRestore': gameId(payload.id); configTarget(payload); string(payload.backupId, 'backup id', 128); return;
    case 'restoreConfigBackup':
      gameId(payload.id); configTarget(payload); string(payload.backupId, 'backup id', 128); string(payload.token, 'preview token', 128); return;
    case 'pruneConfigBackups': gameId(payload.id); configTarget(payload); stringList(payload.ids, 'backup ids', MAX_LIST, 128); return;
    default: // Remaining actions take no payload fields or validate their own (setLocale, copyText, setUnsavedChanges).
  }
}

module.exports = { validatePayload };
