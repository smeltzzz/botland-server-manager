// Browser-only design preview. This module is loaded only by the Vite dev server
// when the Electron preload is absent; packaged builds never use these fixtures.
import type { BotStatus, ConfigDocument, ConfigField, Game, GameId, ManagerApi, ManagerEvent, MapData, Snapshot } from './types';

const base: Pick<Game, 'options' | 'config' | 'blockers' | 'warnings' | 'logs' | 'status' | 'pid' | 'startedAt' | 'connect' | 'orphan' | 'restart' | 'setup'> = {
  setup: { folder: false, engine: null, plutonium: null, key: null, bots: false, config: false, maps: false },
  options: { port: 28961, mode: 'dom', shuffle: true, selectedMaps: [], gamePath: '', lan: true },
  config: { sv_hostname: 'botLANd â€” Domination', sv_maxclients: '18', bots_main: '1', bots_manage_fill: '14', bots_skill: '4', bots_team: 'autoassign', bots_manage_fill_mode: '0', bots_play_obj: '1', scr_dom_timelimit: '15', scr_dom_scorelimit: '200' },
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
// MW3 starts without a server config so the preview shows the checklist step.
const configured = new Set<GameId>(['cod4', 'bo1']);
const plutoniumGames = new Set<GameId>(['waw', 'bo1', 'mw3', 'bo2']);
const snapshot: Snapshot = { plutonium: { available: true, installed: true, updating: false, lastUpdated: '2026-11-09T18:00:00.000Z', error: null }, updatesEnabled: true, updates: { cod4: { status: 'current', latest: { tag: 'v2.1.0' }, updateAvailable: true } }, games: definitions.map(([id, title, short, subtitle, family, engine, port]) => ({
  ...base, id, title, short, subtitle, family, engine, modBusy: false, config: { ...base.config },
  installed: detected.has(id), pathSource: detected.has(id) ? 'steam' : 'none',
  keyStatus: id === 'cod4' || id === 'mw2' ? 'not-required' : fakeKeyPresence.has(id) ? 'stored' : 'missing',
  gamePath: detected.has(id) ? `C:\\Example\\SteamLibrary\\steamapps\\common\\${title}` : '',
  configPath: detected.has(id) ? `C:\\Example\\SteamLibrary\\steamapps\\common\\${title}\\main\\server.cfg` : '',
  // Match the real per-title defaults: IW5 uses .dsr ruleset names, not gametypes.
  options: { ...base.options, port, mode: id === 'mw3' ? 'DOM_default' : 'dom', lan: id !== 'bo1' },
  connect: { ...base.connect, candidates: [] }, restart: { ...base.restart },
  orphan: id === 'mw3' ? { pid: 8124, port, reason: 'Sample preview: an unverified listener uses this port.' } : null,
  warnings: id === 'bo1' ? ['The existing BO1 launch profile does not use -lan. Add the LAN firewall rule from the Overview tab to restrict network access.'] : [],
})) };
const pool = ['mp_crash', 'mp_crossfire', 'mp_backlot', 'mp_bloc', 'mp_bog', 'mp_broadcast', 'mp_chinatown', 'mp_creek', 'mp_killhouse', 'mp_pipeline', 'mp_shipment', 'mp_showdown', 'mp_strike', 'mp_vacant', 'mp_cargoship', 'mp_citystreets', 'mp_convoy', 'mp_countdown', 'mp_farm', 'mp_overgrown'];
// Mirror electron/maps.cjs modeOptions: IW3/IW4 call team deathmatch "war",
// T4/T5 call it "tdm", and IW5/T6 read their mode names from installed files.
function demoModes(id: GameId): MapData['modes'] {
  if (id === 'mw3') return [{ value: 'DOM_default', label: 'DOM' }];
  if (id === 'cod4' || id === 'mw2') return [
    { value: 'dom', label: 'Domination' }, { value: 'war', label: 'Team Deathmatch' },
    { value: 'dm', label: 'Free for All' }, { value: 'sd', label: 'Search & Destroy' },
  ];
  return [
    { value: 'dom', label: 'Domination' }, { value: 'tdm', label: 'Team Deathmatch' },
    { value: 'dm', label: 'Free for All' }, { value: 'sd', label: 'Search & Destroy' },
  ];
}
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
const demoModeValues = new Map<string, Record<string, string>>();
const modeKey = (id: GameId, mode: string) => `${id}:${mode}`;
const demoModeDefaults = { timelimit: '5', scorelimit: '200', hardcoremode: '0' };
const demoManifest = (id: GameId, ref: string, channel: 'stable' | 'development' = 'stable'): NonNullable<BotStatus['manifest']> => ({
  channel, ref, refType: channel === 'stable' ? 'tag' : 'commit', sha256: 'a'.repeat(64), date: '2026-10-20T12:00:00.000Z', repo: `https://github.com/ineedbots/${botRepos[id]}_bot_warfare`, patches: [],
});
const botStatuses: Record<GameId, BotStatus> = Object.fromEntries(definitions.map(([id]) => [id, {
  state: id === 'cod4' ? 'installed' : id === 'bo1' ? 'unknown' : 'not-installed', targetPath: '',
  manifest: id === 'cod4' ? demoManifest(id, 'v2.0.0') : null,
  channel: 'stable', source: { supported: true, ref: 'v2.1.0', notes: 'Demo release summary. No download occurs in browser preview.', status: 'Sample release available' },
}])) as Record<GameId, BotStatus>;
// Derive the checklist flags and blockers the same way the real preflight does.
function readiness(game: Game) {
  const id = game.id;
  const plutonium = plutoniumGames.has(id);
  game.keyStatus = plutonium ? fakeKeyPresence.has(id) ? 'stored' : 'missing' : 'not-required';
  game.configMissing = game.installed && !configured.has(id);
  game.setup = { folder: game.installed, engine: plutonium ? null : game.installed, plutonium: plutonium ? snapshot.plutonium.installed : null,
    key: plutonium ? game.keyStatus === 'stored' : null, bots: game.installed && botStatuses[id].state !== 'not-installed',
    config: game.installed && configured.has(id), maps: game.installed };
  const blockers: string[] = [];
  if (!game.installed) blockers.push(`${game.short} was not found in your Steam libraries. Choose its installed game folder to continue.`);
  if (game.setup.plutonium === false) blockers.push('Plutonium is not installed. Click Install Plutonium in this game\'s setup checklist.');
  if (game.setup.key === false) blockers.push(`Plutonium server key needed for ${game.short}. Paste your key in this game's setup checklist.`);
  if (game.installed && !game.setup.bots) blockers.push(`${game.short} Bot Warfare is not installed. Click Install Bot Warfare in this game's setup checklist.`);
  if (game.configMissing) blockers.push('Server config missing. Click Create server config in this game\'s setup checklist.');
  game.blockers = blockers;
}
function updateDemoReadiness(id: GameId) {
  readiness(find(id));
  emit();
}
snapshot.games.forEach(readiness);
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
  const game = find(id);
  const selectedMode = mode || game.options.mode;
  const values = target === 'base' ? { ...game.config } : { ...demoModeDefaults, ...demoModeValues.get(modeKey(id, selectedMode)) };
  const slotCap = ['mw2', 'mw3', 'bo2'].includes(id) ? 18 : 64;
  const fields = target === 'base' ? demoFields.map(field => ['sv_maxclients', 'bots_manage_fill'].includes(field.key) ? { ...field, max: slotCap } : field) : [{ key: 'timelimit', sourceKey: 'timelimit', label: 'Time limit', section: 'Match rules', type: 'integer' as const, min: 0, max: 120 }];
  const path = target === 'base'
    ? game.configPath
    : id === 'mw3'
      ? `${game.gamePath}\\admin\\${selectedMode}.dsr`
      : `${game.gamePath}\\main\\gamesettings\\${selectedMode}.cfg`;
  return { path, target, mode: selectedMode, sourceRepo: `https://github.com/ineedbots/${id}_bot_warfare`, values, fields,
    entries: Object.entries(values).map(([key, value]) => ({ key, value, masked: false, hasValue: true, count: 1 })) };
}
export function createDemoManager(): ManagerApi {
  document.documentElement.dataset.demo = 'true';
  // Remember applied rules so the preview does not "lose" them on the next refresh.
  const firewallRules: Partial<Record<GameId, 'lan' | 'any'>> = {};
  return {
    snapshot: async () => structuredClone(snapshot),
    copyDiagnostics: async () => false, // Browser preview never writes to the clipboard.
    setUnsavedChanges: async () => true,
    maps: async (id): Promise<MapData> => ({ maps: pool, modes: demoModes(id) }),
    start: async id => { const game = find(id); if (!game.installed || game.blockers.length) throw new Error('Resolve the setup checks before starting.'); game.status = 'running'; game.pid = 4108; game.activePort = game.options.port; game.startedAt = new Date().toISOString(); game.restart = { ...game.restart, attempts: 0, nextAttemptAt: null, cutOff: false }; demoConnect(game); game.logs = [{ at: new Date().toISOString(), level: 'info', source: 'manager', message: `Started ${game.engine} with the selected map rotation.` }, { at: new Date().toISOString(), level: 'info', source: 'stdout', message: 'Demo server output (no game process launched).' }]; emit(); },
    stop: async id => { const game = find(id); game.status = 'stopped'; game.pid = null; game.activePort = null; game.connect = { primaryAddress: null, ambiguous: false, candidates: [] }; game.restart.nextAttemptAt = null; emit(); },
    copyConnectAddress: async (id, address) => { const game = find(id); return game.status === 'running' && game.connect.candidates.some(candidate => candidate.connectAddress === address); },
    setAutoRestart: async (id, enabled) => { find(id).restart.enabled = enabled; emit(); },
    rescanOrphans: async () => { emit(); },
    chooseFolder: async id => { const game = find(id); game.installed = true; game.pathSource = 'manual'; game.gamePath = `C:\\Example\\SelectedGames\\${game.title}`; game.configPath = `${game.gamePath}\\main\\server.cfg`; updateDemoReadiness(id); return true; },
    rescanInstallations: async () => { emit(); },
    createStarterConfig: async id => { const game = find(id); if (!game.installed) throw new Error('Choose a game folder first.'); game.config.sv_hostname = `botLANd ${game.short} Server`; configured.add(id); updateDemoReadiness(id); return game.configPath; },
    listConfigBackups: async () => [],
    previewConfigRestore: async () => { throw new Error('No sample backups are available.'); },
    restoreConfigBackup: async () => { throw new Error('No sample backups are available.'); },
    pruneConfigBackups: async () => { throw new Error('No sample backups are available.'); },
    botStatus: async id => structuredClone({ ...botStatuses[id], targetPath: `${find(id).gamePath}\\mods\\bots` }),
    botAction: async (id, operation) => {
      const game = find(id);
      const bot = botStatuses[id];
      if (!game.installed || game.status !== 'stopped' || game.modBusy) throw new Error('Stop the server and choose a game folder first.');
      if (operation === 'update' && bot.state !== 'installed') throw new Error('No managed version to update.');
      game.modBusy = true; emit();
      try {
        if (operation === 'remove') bot.manifest = null;
        else bot.manifest = demoManifest(id, bot.source.ref || 'v2.1.0', bot.channel);
        bot.state = operation === 'remove' ? 'not-installed' : 'installed';
        snapshot.updates[id] = { status: 'current', latest: { tag: 'v2.1.0' }, updateAvailable: false };
      } finally { game.modBusy = false; updateDemoReadiness(id); }
    },
    setBotChannel: async (id, channel) => {
      if (channel === 'development' && id !== 'cod4' && id !== 'bo2') throw new Error('Development builds are not available for this game.');
      botStatuses[id].channel = channel;
      botStatuses[id].source = { supported: true, ref: channel === 'stable' ? 'v2.1.0' : 'abcdef1234567890', notes: 'Demo release summary. No download occurs in browser preview.', status: 'Sample release available' };
      emit();
    },
    checkBotUpdates: async () => { snapshot.updates.cod4 = { status: 'current', latest: { tag: 'v2.1.0' }, updateAvailable: botStatuses.cod4.manifest?.ref !== 'v2.1.0' }; emit(); },
    setUpdateChecks: async enabled => { snapshot.updatesEnabled = enabled; emit(); },
    saveKey: async (id, key) => { if (!key.trim()) throw new Error('A key is required.'); fakeKeyPresence.add(id); updateDemoReadiness(id); },
    removeKey: async id => { fakeKeyPresence.delete(id); updateDemoReadiness(id); },
    resetKeyStore: async () => false,
    updatePlutonium: async () => { snapshot.plutonium = { ...snapshot.plutonium, installed: true, updating: false, lastUpdated: new Date().toISOString(), error: null }; snapshot.games.forEach(readiness); emit(); return true; },
    openKeyPage: async () => {}, openEngineGuide: async () => {}, openConfig: async () => false,
    document: async (id, target, mode) => demoDocument(id, target, mode),
    previewSettings: async (id, target, mode, values) => ({ token: '0'.repeat(64), changed: true, changes: Object.entries(values).map(([key, after]) => ({ key, label: key, before: demoDocument(id, target, mode).values[key] ?? '(not set)', after, duplicates: 1 })) }),
    commitSettings: async (id, target, mode, values) => {
      if (target === 'base') Object.assign(find(id).config, values);
      else demoModeValues.set(modeKey(id, mode), { ...demoDocument(id, target, mode).values, ...values });
      emit();
      return demoDocument(id, target, mode);
    },
    artwork: async () => null, openDocs: async () => {}, chooseArtwork: async () => false, resetArtwork: async () => null, openDocument: async () => false,
    firewallStatus: async id => ({ name: `botLANd ${find(id).short} UDP`, port: find(id).activePort ?? find(id).options.port, state: firewallRules[id] ?? 'missing' }),
    firewallApply: async id => { firewallRules[id] = id === 'bo1' || find(id).options.lan ? 'lan' : 'any'; return { name: `botLANd ${find(id).short} UDP`, port: find(id).activePort ?? find(id).options.port, state: firewallRules[id] }; },
    firewallRemove: async id => { delete firewallRules[id]; return { name: `botLANd ${find(id).short} UDP`, port: find(id).activePort ?? find(id).options.port, state: 'missing' }; },
    // Mirror the real manager's validation: a browser preview must not confirm
    // options that the desktop app would reject.
    saveOptions: async (id, values) => {
      const game = find(id);
      if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).some(key => !['port', 'mode', 'shuffle', 'selectedMaps', 'lan'].includes(key))) throw new Error('Invalid server options.');
      if ('port' in values && (!Number.isInteger(values.port) || (values.port as number) < 1024 || (values.port as number) > 65535)) throw new Error('Port must be between 1024 and 65535.');
      if ('mode' in values && !demoModes(id).some(mode => mode.value === values.mode)) throw new Error('This game mode is not available in the installation.');
      if ('shuffle' in values && typeof values.shuffle !== 'boolean') throw new Error('Invalid shuffle option.');
      if ('lan' in values && typeof values.lan !== 'boolean') throw new Error('Invalid visibility option.');
      if ('selectedMaps' in values) {
        if (!Array.isArray(values.selectedMaps) || values.selectedMaps.some(map => typeof map !== 'string' || !pool.includes(map)) || new Set(values.selectedMaps).size !== values.selectedMaps.length) throw new Error('Map selection contains missing or duplicate maps.');
        if (id === 'bo2' && values.selectedMaps.length === 1) throw new Error('Black Ops II needs at least two maps.');
      }
      Object.assign(game.options, values, id === 'bo1' ? { lan: false } : {});
      emit();
    },
    subscribe: listener => { subscribers.add(listener); return () => { subscribers.delete(listener); }; },
  };
}
