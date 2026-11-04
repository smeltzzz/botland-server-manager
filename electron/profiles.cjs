const path = require('node:path');

// Only public, non-secret data belongs here. Plutonium keys are stored
// separately with Electron safeStorage and never belong in profiles.
/**
 * @typedef {Object} GameProfile
 * @property {string} id
 * @property {string} title
 * @property {string} short
 * @property {string} subtitle
 * @property {string} family
 * @property {string} engine
 * @property {string} folder
 * @property {string} launcher
 * @property {string} config
 * @property {string} rotation
 * @property {string} executable
 * @property {number} defaultPort
 * @property {string} defaultMode
 * @property {string} mod
 * @property {'gametype'|'dsr'|'gamesettings'} modeType
 */
const profiles = {
  cod4: { id: 'cod4', title: 'Call of Duty 4', short: 'CoD4', subtitle: 'Modern Warfare', family: 'mw', engine: 'CoD4R / IW3x', folder: '1-CoD4-Server', launcher: '!start_mp_server.bat', config: 'main/botserver.cfg', rotation: 'main/botserver_rotation.cfg', executable: 'Cod4R-DedRun.exe', defaultPort: 28962, defaultMode: 'dom', mod: 'mods/mp_bots', modeType: 'gametype' },
  waw: { id: 'waw', title: 'World at War', short: 'WaW', subtitle: 'Call of Duty', family: 'neutral', engine: 'Plutonium T4', folder: '2-WaW-Server', launcher: '!start_mp_server.bat', config: 'main/server.cfg', rotation: 'main/server_live.cfg', executable: 'plutonium', defaultPort: 28963, defaultMode: 'dom', mod: 'mods/mp_bots', modeType: 'gametype' },
  mw2: { id: 'mw2', title: 'Modern Warfare 2', short: 'MW2', subtitle: 'Call of Duty', family: 'mw', engine: 'IW4x', folder: '3-MW2-Server', launcher: 'DedicatedServerLAN.bat', config: 'userraw/serverlan.cfg', rotation: 'userraw/serverlan_rotation.cfg', executable: 'iw4x.exe', defaultPort: 28964, defaultMode: 'dom', mod: '', modeType: 'gametype' },
  bo1: { id: 'bo1', title: 'Black Ops', short: 'BO1', subtitle: 'Call of Duty', family: 'bo', engine: 'Plutonium T5', folder: '4-BO1-Server', launcher: '!start_mp_server.bat', config: 'main/server.cfg', rotation: 'main/server_live.cfg', executable: 'plutonium', defaultPort: 28961, defaultMode: 'dom', mod: 'mods/mp_bots', modeType: 'gametype' },
  mw3: { id: 'mw3', title: 'Modern Warfare 3', short: 'MW3', subtitle: 'Call of Duty', family: 'mw', engine: 'Plutonium IW5', folder: '5-MW3-Server', launcher: '!start_mp_server.bat', config: 'admin/server.cfg', rotation: 'admin/server_live.cfg', executable: 'plutonium', defaultPort: 27016, defaultMode: 'DOM_default', mod: 'mods/bots', modeType: 'dsr' },
  bo2: { id: 'bo2', title: 'Black Ops II', short: 'BO2', subtitle: 'Call of Duty', family: 'bo', engine: 'Plutonium T6', folder: '6-BO2-Server', launcher: '!start_mp_server.bat', config: 'main/dedicated.cfg', rotation: 'main/rotation_dom_shuffled.cfg', executable: 'plutonium', defaultPort: 4976, defaultMode: 'dom', mod: '', modeType: 'gamesettings' },
};

const order = ['cod4', 'waw', 'mw2', 'bo1', 'mw3', 'bo2'];
/** @param {unknown} id @returns {GameProfile} */
function profileFor(id) {
  if (typeof id !== 'string' || !Object.hasOwn(profiles, id)) throw new Error('Unknown game.');
  return profiles[id];
}
function launcherPath(root, profile) { return path.join(root, profile.folder, profile.launcher); }
function bootstrapPath() { return path.join(process.env.LOCALAPPDATA || '', 'Plutonium', 'bin', 'plutonium-bootstrapper-win32.exe'); }
module.exports = { profiles, order, profileFor, launcherPath, bootstrapPath };
