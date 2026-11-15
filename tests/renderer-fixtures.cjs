// Schema-backed, memory-only renderer services. Importing this helper never
// initializes ServerManager, discovers an installation, reads a config/key, or
// invokes an installer/firewall/clipboard API.
const path = require('node:path');
const { profiles, order } = require('../electron/profiles.cjs');
const { schemaFor, sourceRepos } = require('../electron/schema.cjs');

const maps = ['mp_crash', 'mp_crossfire', 'mp_backlot', 'mp_bloc', 'mp_bog', 'mp_broadcast', 'mp_chinatown', 'mp_creek', 'mp_killhouse', 'mp_pipeline', 'mp_shipment', 'mp_showdown', 'mp_strike', 'mp_vacant', 'mp_cargoship', 'mp_citystreets', 'mp_convoy', 'mp_countdown', 'mp_farm', 'mp_overgrown'];
function modesFor(id) {
  if (id === 'mw3') return [{ value: 'DOM_default', label: 'DOM default' }, { value: 'TDM_default', label: 'TDM default' }];
  const deathmatch = id === 'cod4' || id === 'mw2' ? 'war' : 'tdm';
  return [{ value: 'dom', label: 'Domination' }, { value: deathmatch, label: 'Team Deathmatch' }, { value: 'sd', label: 'Search & Destroy' }];
}
function logFixture(index, message = `Synthetic streamed output ${String(index).padStart(3, '0')}`) {
  return { at: new Date(Date.UTC(2026, 10, 1, 12, 0, index)).toISOString(),
    level: index % 11 === 0 ? 'error' : 'info', source: ['manager', 'stdout', 'stderr', 'g_log'][index % 4], message };
}
function schemaDocument(id, target = 'base', mode = profiles[id].defaultMode, variant = 'standard') {
  const game = profiles[id];
  const fields = structuredClone(schemaFor(id, target, mode).fields);
  const values = {};
  for (const field of fields) {
    const value = field.default ?? field.choices?.[0]?.value ?? String(field.min ?? 0);
    values[field.key] = field.type === 'text' ? field.key === 'sv_hostname' ? `Synthetic ${game.short} server` : 'Synthetic message of the day with enough words to test wrapping at narrow widths.' : value;
  }
  if (target === 'base') {
    values.sv_maxclients = ['mw2', 'mw3', 'bo2'].includes(id) ? '18' : '32';
    values.bots_manage_fill = '14';
    if (variant === 'conditional') {
      values.bots_team = 'custom';
      if (fields.some(field => field.key === 'bots_skill' && field.choices?.some(choice => choice.value === '8'))) values.bots_skill = '8';
    }
    if (variant === 'defaults') for (const field of fields) if (field.default !== undefined) delete values[field.key];
  }
  const gamePath = `C:\\Example\\SyntheticGames\\${id}`;
  const file = target === 'base' ? path.win32.join(gamePath, game.config)
    : id === 'mw3' ? path.win32.join(gamePath, 'admin', `${mode}.dsr`) : path.win32.join(gamePath, 'main', 'gamesettings', `${mode}.cfg`);
  const entries = Object.entries(values).map(([key, value]) => ({ key, value, masked: false, hasValue: value !== '', count: key === 'sv_hostname' ? 2 : 1 }));
  if (target === 'base') entries.push(
    { key: 'rcon_password', value: '', masked: true, hasValue: true, count: 1 },
    { key: '_synthetic_extra', value: 'Unknown setting remains editable', masked: false, hasValue: true, count: 1 },
    { key: 'bots_manage_add', value: '0', masked: false, hasValue: true, count: 1 },
  );
  return { path: file, target, mode, sourceRepo: sourceRepos[id], values, fields, entries };
}
function createRendererFixtures() {
  let variant = 'standard';
  let locale = 'en';
  const listeners = new Set();
  const documents = new Map();
  let deferredPreview = null;
  const state = { locale, updatesEnabled: false, updates: {},
    plutonium: { available: true, installed: true, updating: false, lastUpdated: null, error: null },
    games: order.map(id => {
      const profile = profiles[id];
      const plutonium = profile.engine.startsWith('Plutonium');
      const doc = schemaDocument(id);
      return { id, title: profile.title, short: profile.short, subtitle: 'Offline synthetic fixture', family: profile.family, engine: profile.engine,
        installed: true, pathSource: 'manual', gamePath: path.win32.dirname(path.win32.dirname(doc.path)), configPath: doc.path,
        keyStatus: plutonium ? 'stored' : 'not-required', modBusy: false, engineBusy: false,
        setup: { folder: true, engine: plutonium ? null : true, plutonium: plutonium ? true : null, key: plutonium ? true : null, bots: true, config: true, maps: true },
        options: { port: profile.defaultPort, mode: profile.defaultMode, shuffle: true, selectedMaps: [], lan: id !== 'bo1', gamePath: '' },
        config: { sv_hostname: doc.values.sv_hostname, sv_maxclients: doc.values.sv_maxclients, bots_manage_fill: doc.values.bots_manage_fill },
        connect: { primaryAddress: null, ambiguous: false, candidates: [] }, orphan: null,
        restart: { enabled: false, attempts: 0, nextAttemptAt: null, cutOff: false }, blockers: [], warnings: [],
        status: 'stopped', pid: null, startedAt: null, activePort: null,
      };
    }),
  };
  // Snapshots carry no logs; the renderer seeds each game through getLogs.
  const logs = Object.fromEntries(order.map(id => [id, Array.from({ length: 120 }, (_, index) => logFixture(index))]));
  const emit = () => { for (const listener of listeners) listener({ type: 'state', snapshot: structuredClone(state) }); };
  const keyFor = (id, target, mode) => `${id}:${target}:${mode}`;
  const services = {
    snapshot: async () => structuredClone(state),
    getLogs: async id => structuredClone(logs[id] || []),
    setLocale: async next => { locale = next; state.locale = locale; emit(); },
    maps: async id => ({ maps: [...maps], modes: modesFor(id) }),
    document: async (id, target = 'base', mode = profiles[id].defaultMode) => structuredClone(documents.get(keyFor(id, target, mode)) || schemaDocument(id, target, mode, variant)),
    botStatus: async id => ({ state: 'installed', targetPath: `C:\\Example\\SyntheticGames\\${id}\\mods\\bots`, channel: 'stable', manifest: {
      channel: 'stable', ref: 'v-synthetic', refType: 'tag', sha256: 'a'.repeat(64), date: '2026-11-01T12:00:00.000Z', repo: sourceRepos[id], patches: [],
    }, source: { supported: true, ref: 'v-synthetic', notes: 'Synthetic upstream status. No network or installation is available to this harness.', status: 'Synthetic current release' } }),
    firewallStatus: async id => ({ name: `botLANd ${profiles[id].short} UDP`, port: profiles[id].defaultPort, state: id === 'bo1' ? 'any' : 'lan', managed: true }),
    listConfigBackups: async () => [
      { id: 'synthetic-backup-1', date: '2026-11-01T12:00:00.000Z', bytes: 1200 },
      { id: 'synthetic-backup-2', date: '2026-10-31T12:00:00.000Z', bytes: 1100 },
    ],
    previewSettings: async (id, target, mode, values) => {
      const doc = await services.document(id, target, mode);
      const result = { token: '0'.repeat(64), changed: true, changes: Object.entries(values).map(([key, after]) => ({ key,
        label: doc.fields.find(field => field.key === key)?.label || key, before: doc.values[key] || '(not set)', after, duplicates: 1 })) };
      if (deferredPreview) return deferredPreview(result);
      return result;
    },
    // Explicitly permitted only for audit setup/interaction. These mutations
    // are plain JS objects, not calls to config or backup writers.
    commitSettings: async (id, target, mode, values) => {
      const doc = await services.document(id, target, mode);
      Object.assign(doc.values, values);
      for (const entry of doc.entries) if (Object.hasOwn(values, entry.key)) entry.value = values[entry.key];
      documents.set(keyFor(id, target, mode), doc);
      return structuredClone(doc);
    },
    previewConfigRestore: async () => ({ token: '1'.repeat(64), summary: { changed: true, currentBytes: 1200, backupBytes: 1100 } }),
    setUnsavedChanges: async () => true,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  return { services, state, logs, setVariant: next => { variant = next; documents.clear(); },
    deferPreview: callback => { deferredPreview = callback; }, emit };
}
module.exports = { createRendererFixtures, schemaDocument, modesFor, logFixture };
