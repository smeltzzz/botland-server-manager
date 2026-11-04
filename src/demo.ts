// Browser-only design preview. This module is loaded only by the Vite dev server
// when the Electron preload is absent; packaged builds never use these fixtures.
import type { BotStatus, ConfigDocument, ConfigField, Game, GameId, ManagerApi, ManagerEvent, MapData, Snapshot } from './types';

const base: Pick<Game, 'options' | 'config' | 'blockers' | 'warnings' | 'logs' | 'status' | 'pid' | 'startedAt' | 'connect' | 'orphan' | 'restart'> = {
  options: { port: 28961, mode: 'dom', shuffle: true, selectedMaps: [], gamePath: '', lan: true },
  config: { sv_hostname: 'botLANd — Domination', sv_maxclients: '18', bots_main: '1', bots_manage_fill: '14', bots_skill: '4', bots_team: 'autoassign', bots_manage_fill_mode: '0', bots_play_obj: '1', scr_dom_timelimit: '15', scr_dom_scorelimit: '200' },
  blockers: [], warnings: [], logs: [], status: 'stopped', pid: null, startedAt: null,
  connect: { primaryAddress: null, ambiguous: false, candidates: [] }, orphan: null,
  restart: { enabled: false, attempts: 0, nextAttemptAt: null, cutOff: false },
};
const definitions: [GameId, string, string, string, Game['family'], string, number][] = [
  ['cod4', 'Call of Duty 4', 'CoD4', 'Modern Warfare', 'mw', 'CoD4R / IW3x', 28962],
  ['waw', 'World at War', 'WaW', 'Call of Duty', 'neutral', 'Plutonium T4', 28963],
  ['mw2', 'Modern Warfare 2', 'MW2', 'Call of Duty', 'mw', 'IW4x', 28964],
  ['bo1', 'Black Ops', 'BO1', 'Call of Duty', 'bo', 'Plutonium T5', 28961],
  ['mw3', 'Modern Warfare 3', 'MW3', 'Call of Duty', 'mw', 'Plutonium IW5', 27016],
  ['bo2', 'Black Ops II', 'BO2', 'Call of Duty', 'bo', 'Plutonium T6', 4976],
];
const detected = new Set<GameId>(['cod4', 'bo1', 'mw3']);
// Only presence is modeled in this browser fixture; no actual key string is kept.
const fakeKeyPresence = new Set<GameId>(['bo1']);
const snapshot: Snapshot = { root: '', updatesEnabled: true, updates: { cod4: { status: 'checked', latest: { tag: 'v2.1.0' }, updateAvailable: true } }, games: definitions.map(([id, title, short, subtitle, family, engine, port]) => ({
  ...base, id, title, short, subtitle, family, engine, modBusy: false, config: { ...base.config },
  installed: detected.has(id), pathSource: detected.has(id) ? 'steam' : 'none',
  keyStatus: id === 'cod4' || id === 'mw2' ? 'not-required' : fakeKeyPresence.has(id) ? 'stored' : 'missing',
  gamePath: detected.has(id) ? `C:\\Example\\SteamLibrary\\steamapps\\common\\${title}` : '',
  configPath: detected.has(id) ? `C:\\Example\\SteamLibrary\\steamapps\\common\\${title}\\main\\server.cfg` : '',
  options: { ...base.options, port, lan: id !== 'bo1' },
  connect: { ...base.connect, candidates: [] }, restart: { ...base.restart },
  orphan: id === 'mw3' ? { pid: 8124, port, reason: 'Sample preview: an unverified listener uses this port.' } : null,
  blockers: detected.has(id) ? id === 'mw3' ? ['A Plutonium server key is required.'] : [] : ['Game folder not found.'],
  warnings: id === 'bo1' ? ['The existing BO1 launch profile does not use -lan. Add the LAN firewall rule from the Overview tab to restrict network access.'] : [],
})) };
const pool = ['mp_crash', 'mp_crossfire', 'mp_backlot', 'mp_bloc', 'mp_bog', 'mp_broadcast', 'mp_chinatown', 'mp_creek', 'mp_killhouse', 'mp_pipeline', 'mp_shipment', 'mp_showdown', 'mp_strike', 'mp_vacant', 'mp_cargoship', 'mp_citystreets', 'mp_convoy', 'mp_countdown', 'mp_farm', 'mp_overgrown'];
const subscribers = new Set<(event: ManagerEvent) => void>();
const emit = () => subscribers.forEach(listener => listener({ type: 'state', snapshot: structuredClone(snapshot) }));
const find = (id: GameId) => snapshot.games.find(game => game.id === id)!;
function demoConnect(game: Game) {
  const port = game.options.port;
  const candidates = [{ adapter: 'Home Wi-Fi', address: '192.168.1.24', scope: 'private', label: 'Local network', connectAddress: `192.168.1.24:${port}` }];
  if (game.id === 'cod4') candidates.push({ adapter: 'Demo VPN', address: '10.8.0.5', scope: 'private', label: 'VPN network', connectAddress: `10.8.0.5:${port}` });
  game.connect = { primaryAddress: candidates.length === 1 ? candidates[0].address : null, ambiguous: candidates.length > 1, candidates };
}
const botRepos: Record<GameId, string> = { cod4: 'iw3', waw: 't4', mw2: 'iw4', bo1: 't5', mw3: 'iw5', bo2: 't6' };
const demoManifest = (id: GameId, ref: string, channel: 'stable' | 'development' = 'stable'): NonNullable<BotStatus['manifest']> => ({
  channel, ref, refType: channel === 'stable' ? 'tag' : 'commit', sha256: 'a'.repeat(64), date: '2026-10-20T12:00:00.000Z', repo: `https://github.com/ineedbots/${botRepos[id]}_bot_warfare`, patches: [],
});
const botStatuses: Record<GameId, BotStatus> = Object.fromEntries(definitions.map(([id]) => [id, {
  state: id === 'cod4' ? 'installed' : id === 'bo1' ? 'unknown' : 'not-installed', targetPath: '',
  manifest: id === 'cod4' ? demoManifest(id, 'v2.0.0') : null,
  versions: id === 'cod4' ? [{ versionId: 'demo-previous', date: '2026-09-01T12:00:00.000Z', manifest: { ref: 'v1.9.0', channel: 'stable' } }] : [],
  channel: 'stable', source: { supported: true, ref: 'v2.1.0', notes: 'Demo release summary. No download occurs in browser preview.', status: 'Sample release available' },
}])) as Record<GameId, BotStatus>;
function updateDemoReadiness(id: GameId) {
  const game = find(id);
  game.keyStatus = id === 'cod4' || id === 'mw2' ? 'not-required' : fakeKeyPresence.has(id) ? 'stored' : 'missing';
  game.blockers = !game.installed ? ['Game folder not found.'] : game.keyStatus === 'missing' ? ['A Plutonium server key is required.'] : [];
  emit();
}
const demoFields: ConfigField[] = [
  { key: 'sv_hostname', sourceKey: 'sv_hostname', label: 'Server name', section: 'Server & access', type: 'text' },
  { key: 'sv_maxclients', sourceKey: 'sv_maxclients', label: 'Player slots', section: 'Server & access', type: 'integer', min: 2, max: 64 },
  { key: 'bots_main', sourceKey: 'bots_main', label: 'Enable Bot Warfare', section: 'Bot population', type: 'select', choices: [{ value: '1', label: 'On' }, { value: '0', label: 'Off' }] },
  { key: 'bots_manage_fill', sourceKey: 'bots_manage_fill', label: 'Fill target', section: 'Bot population', type: 'integer', min: 0, max: 64 },
  { key: 'bots_manage_fill_mode', sourceKey: 'bots_manage_fill_mode', label: 'Fill mode', section: 'Bot population', type: 'select', choices: [{ value: '0', label: 'Players + bots' }, { value: '1', label: 'Bots only' }, { value: '4', label: 'Balance teams' }] },
  { key: 'bots_team', sourceKey: 'bots_team', label: 'Bot team', section: 'Teams & balance', type: 'select', choices: [{ value: 'autoassign', label: 'Auto-assign' }, { value: 'custom', label: 'Custom split' }] },
  { key: 'bots_skill', sourceKey: 'bots_skill', label: 'Bot skill', section: 'Difficulty', type: 'integer', min: 0, max: 9 },
  { key: 'bots_play_obj', sourceKey: 'bots_play_obj', label: 'Play objectives', section: 'Bot behavior', type: 'select', choices: [{ value: '1', label: 'On' }, { value: '0', label: 'Off' }] },
  { key: 'scr_dom_timelimit', sourceKey: 'scr_dom_timelimit', label: 'Time limit', section: 'Match rules', type: 'integer', min: 0, max: 120 },
];
function demoDocument(id: GameId, target: 'base' | 'mode', mode?: string): ConfigDocument {
  const values = target === 'base' ? { ...find(id).config } : { timelimit: '5', scorelimit: '200', hardcoremode: '0' };
  const fields = target === 'base' ? demoFields : [{ key: 'timelimit', sourceKey: 'timelimit', label: 'Time limit', section: 'Match rules', type: 'integer' as const, min: 0, max: 120 }];
  return { path: find(id).configPath, target, mode: mode || find(id).options.mode, sourceRepo: `https://github.com/ineedbots/${id}_bot_warfare`, values, fields,
    entries: Object.entries(values).map(([key, value]) => ({ key, value, masked: false, hasValue: true, count: 1 })) };
}
export function createDemoManager(): ManagerApi {
  document.documentElement.dataset.demo = 'true';
  return {
    snapshot: async () => structuredClone(snapshot),
    maps: async (id): Promise<MapData> => ({ maps: pool, modes: id === 'mw3' ? [{ value: 'DOM_default', label: 'DOM' }] : [{ value: 'dom', label: 'Domination' }, { value: 'tdm', label: 'Team Deathmatch' }, { value: 'dm', label: 'Free for All' }] }),
    start: async id => { const game = find(id); if (!game.installed || game.blockers.length) throw new Error('Resolve the setup checks before starting.'); game.status = 'running'; game.pid = 4108; game.startedAt = new Date().toISOString(); game.restart = { ...game.restart, attempts: 0, nextAttemptAt: null, cutOff: false }; demoConnect(game); game.logs = [{ at: new Date().toISOString(), level: 'info', source: 'manager', message: `Started ${game.engine} with the selected map rotation.` }, { at: new Date().toISOString(), level: 'info', source: 'stdout', message: 'Demo server output (no game process launched).' }]; emit(); },
    stop: async id => { const game = find(id); game.status = 'stopped'; game.pid = null; game.connect = { primaryAddress: null, ambiguous: false, candidates: [] }; game.restart.nextAttemptAt = null; emit(); },
    copyConnectAddress: async (id, address) => { const game = find(id); return game.status === 'running' && game.connect.candidates.some(candidate => candidate.connectAddress === address); },
    setAutoRestart: async (id, enabled) => { find(id).restart.enabled = enabled; emit(); },
    rescanOrphans: async () => { emit(); },
    chooseFolder: async id => { const game = find(id); game.installed = true; game.pathSource = 'manual'; game.gamePath = `C:\\Example\\SelectedGames\\${game.title}`; game.configPath = `${game.gamePath}\\main\\server.cfg`; updateDemoReadiness(id); return true; },
    chooseRoot: async () => { snapshot.root = 'C:\\Example\\OptionalScripts'; emit(); return true; },
    rescanInstallations: async () => { emit(); },
    createStarterConfig: async id => { const game = find(id); if (!game.installed) throw new Error('Choose a game folder first.'); game.config.sv_hostname = `botLANd ${game.short} Server`; emit(); return game.configPath; },
    listConfigBackups: async () => [],
    previewConfigRestore: async () => { throw new Error('No sample backups are available.'); },
    restoreConfigBackup: async () => { throw new Error('No sample backups are available.'); },
    pruneConfigBackups: async () => { throw new Error('No sample backups are available.'); },
    botStatus: async id => structuredClone({ ...botStatuses[id], targetPath: `${find(id).gamePath}\\mods\\bots` }),
    botAction: async (id, operation, versionId) => {
      const game = find(id);
      const bot = botStatuses[id];
      if (!game.installed || game.status !== 'stopped' || game.modBusy) throw new Error('Stop the server and choose a game folder first.');
      if (operation === 'update' && bot.state !== 'installed') throw new Error('No managed version to update.');
      if (operation === 'restore' && !bot.versions.some(version => version.versionId === versionId)) throw new Error('Choose a previous managed version.');
      game.modBusy = true; emit();
      try {
        if ((operation === 'update' || operation === 'reinstall') && bot.manifest) bot.versions.unshift({ versionId: `demo-${Date.now()}`, date: bot.manifest.date, manifest: { ref: bot.manifest.ref, channel: bot.manifest.channel } });
        if (operation === 'restore') {
          const version = bot.versions.find(entry => entry.versionId === versionId)!;
          bot.manifest = demoManifest(id, version.manifest?.ref || 'previous', version.manifest?.channel === 'development' ? 'development' : 'stable');
        } else if (operation === 'remove') bot.manifest = null;
        else bot.manifest = demoManifest(id, bot.source.ref || 'v2.1.0', bot.channel);
        bot.state = operation === 'remove' ? 'not-installed' : 'installed';
        snapshot.updates[id] = { status: 'checked', latest: { tag: 'v2.1.0' }, updateAvailable: false };
      } finally { game.modBusy = false; emit(); }
    },
    setBotChannel: async (id, channel) => {
      if (channel === 'development' && id !== 'cod4' && id !== 'bo2') throw new Error('Development builds are not available for this game.');
      botStatuses[id].channel = channel;
      botStatuses[id].source = { supported: true, ref: channel === 'stable' ? 'v2.1.0' : 'abcdef1234567890', notes: 'Demo release summary. No download occurs in browser preview.', status: 'Sample release available' };
      emit();
    },
    checkBotUpdates: async () => { snapshot.updates.cod4 = { status: 'checked', latest: { tag: 'v2.1.0' }, updateAvailable: botStatuses.cod4.manifest?.ref !== 'v2.1.0' }; emit(); },
    setUpdateChecks: async enabled => { snapshot.updatesEnabled = enabled; emit(); },
    saveKey: async (id, key) => { if (!key.trim()) throw new Error('A key is required.'); fakeKeyPresence.add(id); updateDemoReadiness(id); },
    removeKey: async id => { fakeKeyPresence.delete(id); updateDemoReadiness(id); },
    importKey: async id => { if (!snapshot.root || id !== 'mw3') return false; fakeKeyPresence.add(id); updateDemoReadiness(id); return true; },
    openKeyPage: async () => {}, openEngineGuide: async () => {}, openConfig: async () => false,
    document: async (id, target, mode) => demoDocument(id, target, mode),
    previewSettings: async (id, target, mode, values) => ({ token: '0'.repeat(64), changed: true, changes: Object.entries(values).map(([key, after]) => ({ key, label: key, before: demoDocument(id, target, mode).values[key] ?? '(not set)', after, duplicates: 1 })) }),
    commitSettings: async (id, target, mode, values) => { if (target === 'base') Object.assign(find(id).config, values); emit(); return demoDocument(id, target, mode); },
    artwork: async () => null, openDocs: async () => {}, chooseArtwork: async () => false, resetArtwork: async () => null, openDocument: async () => false,
    firewallStatus: async id => ({ name: `botLANd ${find(id).short} UDP`, port: find(id).options.port, state: 'missing' }),
    firewallApply: async id => ({ name: `botLANd ${find(id).short} UDP`, port: find(id).options.port, state: id === 'bo1' || find(id).options.lan ? 'lan' : 'any' }),
    firewallRemove: async id => ({ name: `botLANd ${find(id).short} UDP`, port: find(id).options.port, state: 'missing' }),
    // Mirror the real manager: BO1 has no LAN launch path and always stays public.
    saveOptions: async (id, values) => { Object.assign(find(id).options, values, id === 'bo1' ? { lan: false } : {}); emit(); },
    subscribe: listener => { subscribers.add(listener); return () => { subscribers.delete(listener); }; },
  };
}
