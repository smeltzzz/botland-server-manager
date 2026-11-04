// Browser-only design preview. This module is loaded only by the Vite dev server
// when the Electron preload is absent; packaged builds never use these fixtures.
import type { ConfigDocument, ConfigField, Game, GameId, ManagerApi, ManagerEvent, MapData, Snapshot } from './types';

const base: Pick<Game, 'options' | 'config' | 'blockers' | 'warnings' | 'logs' | 'status' | 'pid' | 'startedAt'> = {
  options: { port: 28961, mode: 'dom', shuffle: true, selectedMaps: [], gamePath: '', lan: true },
  config: { sv_hostname: 'botLANd — Domination', sv_maxclients: '18', bots_main: '1', bots_manage_fill: '14', bots_skill: '4', bots_team: 'autoassign', bots_manage_fill_mode: '0', bots_play_obj: '1', scr_dom_timelimit: '15', scr_dom_scorelimit: '200' },
  blockers: [], warnings: [], logs: [], status: 'stopped', pid: null, startedAt: null,
};
const definitions: [GameId, string, string, string, Game['family'], string, number][] = [
  ['cod4', 'Call of Duty 4', 'CoD4', 'Modern Warfare', 'mw', 'CoD4R / IW3x', 28962],
  ['waw', 'World at War', 'WaW', 'Call of Duty', 'neutral', 'Plutonium T4', 28963],
  ['mw2', 'Modern Warfare 2', 'MW2', 'Call of Duty', 'mw', 'IW4x', 28964],
  ['bo1', 'Black Ops', 'BO1', 'Call of Duty', 'bo', 'Plutonium T5', 28961],
  ['mw3', 'Modern Warfare 3', 'MW3', 'Call of Duty', 'mw', 'Plutonium IW5', 27016],
  ['bo2', 'Black Ops II', 'BO2', 'Call of Duty', 'bo', 'Plutonium T6', 4976],
];
const snapshot: Snapshot = { root: 'C:\\Example\\GameServers', games: definitions.map(([id, title, short, subtitle, family, engine, port]) => ({
  ...base, id, title, short, subtitle, family, engine, config: { ...base.config },
  gamePath: `C:\\Example\\SteamLibrary\\steamapps\\common\\${title}`,
  configPath: `C:\\Example\\SteamLibrary\\steamapps\\common\\${title}\\main\\server.cfg`,
  options: { ...base.options, port, lan: id !== 'bo1' },
  warnings: id === 'bo1' ? ['The existing BO1 launch profile does not use -lan. Add the LAN firewall rule from the Overview tab to restrict network access.'] : [],
})) };
const pool = ['mp_crash', 'mp_crossfire', 'mp_backlot', 'mp_bloc', 'mp_bog', 'mp_broadcast', 'mp_chinatown', 'mp_creek', 'mp_killhouse', 'mp_pipeline', 'mp_shipment', 'mp_showdown', 'mp_strike', 'mp_vacant', 'mp_cargoship', 'mp_citystreets', 'mp_convoy', 'mp_countdown', 'mp_farm', 'mp_overgrown'];
const subscribers = new Set<(event: ManagerEvent) => void>();
const emit = () => subscribers.forEach(listener => listener({ type: 'state', snapshot: structuredClone(snapshot) }));
const find = (id: GameId) => snapshot.games.find(game => game.id === id)!;
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
  return {
    snapshot: async () => structuredClone(snapshot),
    maps: async (id): Promise<MapData> => ({ maps: pool, modes: id === 'mw3' ? [{ value: 'DOM_default', label: 'DOM' }] : [{ value: 'dom', label: 'Domination' }, { value: 'tdm', label: 'Team Deathmatch' }, { value: 'dm', label: 'Free for All' }] }),
    start: async id => { const game = find(id); game.status = 'running'; game.pid = 4108; game.startedAt = new Date().toISOString(); game.logs = [{ at: new Date().toISOString(), level: 'info', message: `Started ${game.engine} with the selected map rotation.` }]; emit(); },
    stop: async id => { const game = find(id); game.status = 'stopped'; game.pid = null; emit(); },
    chooseFolder: async () => false, chooseRoot: async () => false, openConfig: async () => false,
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
