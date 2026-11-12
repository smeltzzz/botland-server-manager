const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { StringDecoder } = require('node:string_decoder');
const { profiles, order, profileFor, bootstrapPath } = require('./profiles.cjs');
const { readConfig, readDocument, previewConfig, saveConfig, parseEntries, withoutBlockComments, decode } = require('./config.cjs');
const { schemaFor, sourceRepos } = require('./schema.cjs');
const { artworkFor, loadImage } = require('./artwork.cjs');
const { scanMaps, modeOptions, rotationText, writeRotation } = require('./maps.cjs');
const { detectSteamGames, inspectGameFolder } = require('./detection.cjs');
const { createStarterConfig: writeStarterConfig } = require('./starter-config.cjs');
const { listBackups, previewRestore, restoreBackup, pruneBackups } = require('./config-backups.cjs');
const { discoverConnectAddresses } = require('./connect-address.cjs');
const { findPossibleOrphans } = require('./orphan-detect.cjs');
const { ServerLogTail } = require('./log-tail.cjs');
const { redactLog } = require('./session-logs.cjs');
const { buildFirewallApplyLines, buildFirewallRemoveLines } = require('./firewall-rule.cjs');
const { SOURCES } = require('./botwarfare-source.cjs');
const exec = promisify(execFile);
const safeName = /^[a-z0-9_]+$/i;
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
function isPlainObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
// Resolves true once isClosed() holds (checked on 'close'), or false after ms.
function waitForClose(child, isClosed, ms) {
  return new Promise(resolve => {
    if (isClosed()) return resolve(true);
    const onClose = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { child.off('close', onClose); resolve(isClosed()); }, ms);
    child.once('close', onClose);
  });
}
async function peMachine(file) {
  const handle = await fs.open(file, 'r');
  try {
    const dos = Buffer.alloc(64);
    if ((await handle.read(dos, 0, dos.length, 0)).bytesRead !== dos.length || dos.toString('ascii', 0, 2) !== 'MZ') throw new Error('Invalid game executable.');
    const pe = Buffer.alloc(6);
    if ((await handle.read(pe, 0, pe.length, dos.readUInt32LE(0x3c))).bytesRead !== pe.length || pe.toString('ascii', 0, 4) !== 'PE\0\0') throw new Error('Invalid game executable.');
    return pe.readUInt16LE(4);
  } finally { await handle.close(); }
}

class ServerManager {
  /** @param {string} settingsPath @param {(event: object) => void} notify
   * @param {{keyStore?: import('./key-store.cjs').KeyStore, detectInstallations?: typeof detectSteamGames,
   * modSource?: import('./botwarfare-source.cjs').BotWarfareSource, modInstaller?: import('./botwarfare-install.cjs').BotWarfareInstaller,
   * restartTimers?: {now: () => number, setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout},
   * sessionLogs?: import('./session-logs.cjs').SessionLogs, findPossibleOrphans?: typeof findPossibleOrphans,
   * networkInterfaces?: typeof os.networkInterfaces, createLogTail?: (options: object) => ServerLogTail,
   * plutonium?: import('./plutonium-update.cjs').PlutoniumUpdater,
   * engineUpdater?: import('./engine-update.cjs').EngineUpdater}} [services] */
  constructor(settingsPath, notify, services = {}) {
    this.settingsPath = settingsPath;
    this.notify = notify;
    this.data = { games: {}, updatesEnabled: true };
    this.plutonium = services.plutonium;
    this.engineUpdater = services.engineUpdater;
    this.engineBusy = new Set();
    this.keyStore = services.keyStore;
    this.detectInstallations = services.detectInstallations || detectSteamGames;
    // Explicitly refreshed at app startup; standalone test managers stay isolated
    // from the developer's real Steam library and game installations.
    this.detected = null;
    this.modSource = services.modSource;
    this.modInstaller = services.modInstaller;
    this.modBusy = new Set();
    this.botUpdates = {};
    this.instances = new Map();
    this.logs = new Map();
    this.sessionCleanup = new Map();
    this.persistQueue = Promise.resolve();
    this.mutationQueue = Promise.resolve();
    this.broadcastSequence = 0;
    this.lastBroadcast = 0;
    this.stopTimeout = 5000;
    this.gracefulStopTimeout = 3000;
    this.restartDelays = [2000, 4000, 8000, 16000, 30000];
    this.restartWindow = 10 * 60 * 1000;
    this.restartTimers = services.restartTimers || { now: Date.now, setTimeout, clearTimeout };
    this.restarts = new Map();
    this.sessionLogs = services.sessionLogs;
    this.findPossibleOrphans = services.findPossibleOrphans || findPossibleOrphans;
    this.networkInterfaces = services.networkInterfaces || os.networkInterfaces;
    this.createLogTail = services.createLogTail || (options => new ServerLogTail(options));
    this.orphans = new Map();
    this.orphanScan = null;
    this.orphanTimer = null;
    this.shuttingDown = false;
  }
  // Returns the path of a preserved copy when unreadable settings were reset.
  async initialize() {
    let text;
    try { text = await fs.readFile(this.settingsPath, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    let stored;
    try { stored = JSON.parse(text); } catch { stored = undefined; }
    if (!isPlainObject(stored)) {
      const backup = `${this.settingsPath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      await fs.copyFile(this.settingsPath, backup);
      return backup;
    }
    if (typeof stored.updatesEnabled === 'boolean') this.data.updatesEnabled = stored.updatesEnabled;
    if (isPlainObject(stored.games)) {
      for (const id of order) {
        const entry = stored.games[id];
        if (!isPlainObject(entry)) continue;
        const game = { ...entry };
        if (game.artwork !== undefined) {
          game.artwork = isPlainObject(game.artwork)
            ? Object.fromEntries(Object.entries(game.artwork).filter(([kind, file]) => ['hero', 'cover'].includes(kind) && typeof file === 'string'))
            : {};
        }
        this.data.games[id] = game;
      }
    }
    return null;
  }
  persist(data = this.data) {
    const contents = JSON.stringify(data, null, 2);
    const write = async () => {
      await fs.mkdir(path.dirname(this.settingsPath), { recursive: true });
      const temp = `${this.settingsPath}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.writeFile(temp, contents, 'utf8');
        // Antivirus scanners and the search indexer briefly lock files on
        // Windows; retry a replace that fails with a transient sharing error.
        for (let attempt = 0; ; attempt++) {
          try { await fs.rename(temp, this.settingsPath); break; }
          catch (error) {
            if (attempt >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
            await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
          }
        }
      } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
    };
    const pending = this.persistQueue.then(write);
    this.persistQueue = pending.catch(() => {});
    return pending;
  }
  updateSettings(update) {
    const write = async () => {
      const next = structuredClone(this.data);
      update(next);
      await this.persist(next);
      this.data = next;
    };
    const pending = this.mutationQueue.then(write);
    this.mutationQueue = pending.catch(() => {});
    return pending;
  }
  options(id) {
    const profile = profileFor(id);
    const stored = this.data.games?.[id] || {};
    // Visibility is enforced by launch arguments built in buildCommand, never by
    // config files. BO1's launch profile has no -lan path, so it stays public.
    // Stored values come from a user-writable file; apply the saveOptions rules.
    const port = Number.isInteger(stored.port) && stored.port >= 1024 && stored.port <= 65535 ? stored.port : profile.defaultPort;
    const mode = typeof stored.mode === 'string' && safeName.test(stored.mode) ? stored.mode : profile.defaultMode;
    const selectedMaps = Array.isArray(stored.selectedMaps) ? [...new Set(stored.selectedMaps.filter(m => typeof m === 'string' && safeName.test(m)))].slice(0, 300) : [];
    return { port, mode, shuffle: typeof stored.shuffle === 'boolean' ? stored.shuffle : true, selectedMaps, gamePath: typeof stored.gamePath === 'string' ? stored.gamePath : '', lan: profile.id === 'bo1' ? false : typeof stored.lan === 'boolean' ? stored.lan : true };
  }
  // Plutonium storage and the bootstrapper live under %LOCALAPPDATA%. Without
  // it, paths would resolve against the working directory and must not be used.
  localAppData() {
    const value = process.env.LOCALAPPDATA || '';
    return value && path.isAbsolute(value) ? value : '';
  }
  async gamePath(id) {
    const opts = this.options(id);
    return opts.gamePath || this.detected?.games?.[id]?.gamePath || '';
  }
  ensureOrphanTimer() {
    if (this.orphanTimer || this.shuttingDown) return;
    this.orphanTimer = setInterval(() => { this.rescanOrphans().catch(() => {}); }, 60_000);
    this.orphanTimer.unref?.();
  }
  async rescanInstallations() {
    this.detected = await this.detectInstallations();
    await this.rescanOrphans();
    // Keep the read-only diagnostic off the snapshot path. Only a real startup
    // installation scan installs this unref'd periodic refresh.
    this.ensureOrphanTimer();
    await this.broadcastState();
  }
  async rescanOrphans() {
    if (this.orphanScan) return this.orphanScan;
    const scan = (async () => {
      const candidates = (await Promise.all(order.map(async id => ({ id, port: this.options(id).port,
        gamePath: await this.gamePath(id) })))).filter(item => item.gamePath);
      let findings = [];
      try { findings = await this.findPossibleOrphans(candidates); }
      catch { /* Netstat is optional; an unavailable scan cannot prove occupancy. */ }
      this.orphans = new Map(findings.filter(item => item && !this.ownsListener(item) &&
        candidates.some(candidate => candidate.id === item.id && candidate.port === item.port))
        .map(item => [item.id, { pid: item.pid, port: item.port, reason: item.reason }]));
      await this.broadcastState();
      return [...this.orphans.entries()];
    })();
    this.orphanScan = scan;
    try { return await scan; } finally { if (this.orphanScan === scan) this.orphanScan = null; }
  }
  // A listener belongs to this app when its PID is an owned child, or when an
  // ambiguous (PID-less) listener sits on a port an owned instance has bound.
  ownsListener(listener) {
    if (!listener) return false;
    return [...this.instances.values()].some(instance => {
      const pid = instance.child?.pid;
      if (Number.isInteger(pid) && pid > 0 && pid === listener.pid) return true;
      return listener.pid === null && Boolean(instance.activePort) && instance.activePort === listener.port &&
        (instance.status === 'running' || instance.status === 'starting' || instance.status === 'stopping');
    });
  }
  // `reason` is only set for 'unavailable' and is never secret: 'unreadable' (the
  // stored key cannot be decrypted by this Windows profile), 'damaged' (keys.json
  // is malformed) or 'encryption-unavailable' (Windows encryption is not usable).
  async keyState(id) {
    if (profileFor(id).executable !== 'plutonium') return { status: 'not-required', reason: null };
    if (!this.keyStore) return { status: 'missing', reason: null };
    try { return { status: await this.keyStore.has(id) ? 'stored' : 'missing', reason: null }; }
    catch (error) {
      const reason = ['damaged', 'unreadable', 'encryption-unavailable'].includes(error?.code) ? error.code : 'unreadable';
      return { status: 'unavailable', reason };
    }
  }
  async saveKey(id, key) {
    if (profileFor(id).executable !== 'plutonium') throw new Error('This game does not use a Plutonium server key.');
    if (!this.keyStore) throw new Error('Secure key storage is unavailable.');
    try { await this.keyStore.save(id, key); }
    catch (error) {
      if (error?.code === 'damaged') throw new Error('The saved key file (keys.json) is damaged. Click Reset key storage, then paste the key again.');
      if (error?.code === 'encryption-unavailable') throw new Error('Windows encryption is unavailable for this user, so the key cannot be stored securely.');
      throw error;
    }
    // The key is stored; a failed refresh must not report the save as failed.
    await this.broadcastState().catch(() => {});
  }
  // Sets a damaged keys.json aside (never deletes it) so keys can be pasted again.
  // Resolves false, changing nothing, when the file is readable.
  async resetKeyStore() {
    if (!this.keyStore || typeof this.keyStore.resetDamaged !== 'function') throw new Error('Secure key storage is unavailable.');
    const moved = await this.keyStore.resetDamaged();
    if (moved !== null) await this.broadcastState().catch(() => {});
    return moved !== null;
  }
  async removeKey(id) {
    if (profileFor(id).executable !== 'plutonium') throw new Error('This game does not use a Plutonium server key.');
    if (!this.keyStore) throw new Error('Secure key storage is unavailable.');
    await this.keyStore.remove(id);
    await this.broadcastState().catch(() => {});
  }
  // A Plutonium server is "active" from Start until its process has exited.
  plutoniumActive(exceptId) {
    return [...this.instances].some(([otherId, instance]) => otherId !== exceptId &&
      profileFor(otherId).executable === 'plutonium' && instance.status !== 'restarting');
  }
  async plutoniumStatus() {
    if (!this.plutonium) return { available: false, installed: Boolean(this.localAppData()) && await exists(bootstrapPath()), updating: false, lastUpdated: null, error: null };
    try { return { available: true, ...await this.plutonium.status() }; }
    catch { return { available: true, installed: false, updating: this.plutonium.updating, lastUpdated: null, error: null }; }
  }
  // Explicit "Install Plutonium" / "Update Plutonium now". The updater replaces
  // files the running bootstrapper uses, so every Plutonium server must be stopped.
  async updatePlutonium() {
    if (!this.plutonium) throw new Error('The Plutonium updater is unavailable.');
    if (this.shuttingDown) throw new Error('The manager is shutting down.');
    if (this.plutoniumActive()) throw new Error('Stop every Plutonium server (WaW, BO1, MW3 and BO2) before updating Plutonium.');
    const pending = this.plutonium.update();
    await this.broadcastState().catch(() => {});
    try { await pending; }
    finally { await this.broadcastState().catch(() => {}); }
    return true;
  }
  // IW3x DedRun and IW4x updates are explicit setup actions, never part of
  // Start. Reserve the game before the first await so neither a launch nor a
  // Bot Warfare change can overlap engine files being replaced.
  async updateEngine(id) {
    if (id !== 'cod4' && id !== 'mw2') throw new Error('Only CoD4 and MW2 have an engine update action.');
    if (!this.engineUpdater) throw new Error('Engine updates are unavailable.');
    if (this.shuttingDown) throw new Error('The manager is shutting down.');
    if (this.instances.get(id)?.status === 'restarting') this.cancelRestart(id);
    if (this.instances.has(id) || this.engineBusy.has(id) || this.modBusy.has(id)) throw new Error('Stop this server and finish other changes before updating its engine.');
    this.engineBusy.add(id);
    try {
      await this.broadcastState().catch(() => {});
      const gamePath = await this.gamePath(id);
      if (!gamePath || !(await inspectGameFolder(id, gamePath)).installed) throw new Error('Select an installed game folder before updating its engine.');
      await this.engineUpdater.update(id, gamePath);
      return true;
    } finally {
      this.engineBusy.delete(id);
      await this.broadcastState().catch(() => {});
    }
  }
  botChannel(id) {
    profileFor(id);
    return this.data.games?.[id]?.botChannel === 'development' ? 'development' : 'stable';
  }
  async setBotChannel(id, channel) {
    profileFor(id);
    if (!['stable', 'development'].includes(channel)) throw new Error('Unknown Bot Warfare channel.');
    if (channel === 'development' && !['cod4', 'bo2'].includes(id)) {
      throw new Error('A verified development build is not available for this game. Use stable.');
    }
    await this.updateSettings(data => { data.games[id] = { ...data.games[id], botChannel: channel }; });
    await this.broadcastState().catch(() => {});
  }
  restartState(id) {
    let state = this.restarts.get(id);
    if (!state) {
      state = { crashes: [], attempts: 0, nextAttemptAt: null, cutOff: false, timer: null, suppressed: false };
      this.restarts.set(id, state);
    }
    return state;
  }
  cancelRestart(id) {
    const state = this.restarts.get(id);
    if (state?.timer !== null && state?.timer !== undefined) this.restartTimers.clearTimeout(state.timer);
    if (state) { state.timer = null; state.nextAttemptAt = null; }
    const instance = this.instances.get(id);
    if (instance?.status === 'restarting') this.instances.delete(id);
  }
  async setAutoRestart(id, enabled) {
    profileFor(id);
    if (typeof enabled !== 'boolean') throw new Error('Automatic restart must be on or off.');
    const state = this.restartState(id);
    if (!enabled) state.suppressed = true;
    try {
      await this.updateSettings(data => { data.games[id] = { ...data.games[id], autoRestart: enabled }; });
    } catch (error) { state.suppressed = false; throw error; }
    if (!enabled) this.cancelRestart(id);
    else state.suppressed = false;
    await this.broadcastState().catch(() => {});
  }
  async setUpdateChecks(enabled) {
    if (typeof enabled !== 'boolean') throw new Error('Update checks must be on or off.');
    await this.updateSettings(data => { data.updatesEnabled = enabled; });
    if (!enabled) this.botUpdates = {};
    await this.broadcastState().catch(() => {});
    if (enabled) this.checkBotUpdates(false).catch(() => {});
  }
  async checkBotUpdates(force = false) {
    if (!this.modSource || !this.modInstaller || (!this.data.updatesEnabled && !force)) return;
    const installed = {};
    await Promise.all(order.map(async id => {
      try {
        const gamePath = await this.gamePath(id);
        if (!gamePath || !(await inspectGameFolder(id, gamePath)).installed) return;
        const status = await this.modInstaller.status(id, gamePath);
        if (status.manifest) installed[id] = status.manifest;
      } catch { /* A missing install must not block the other update checks. */ }
    }));
    try {
      const updates = await this.modSource.checkUpdates({ installed, force });
      // Turning checks off while an earlier request is in flight must not
      // repopulate its badges after the user disabled them.
      if (!force && !this.data.updatesEnabled) return;
      this.botUpdates = updates;
    } catch { /* An offline or rate-limited update check never interrupts startup. */ }
    await this.broadcastState();
  }
  async botStatus(id) {
    const profile = profileFor(id);
    const gamePath = await this.gamePath(id);
    if (!gamePath || !(await inspectGameFolder(id, gamePath)).installed) throw new Error(`Select an installed ${profile.short} game folder first.`);
    if (!this.modInstaller || !this.modSource) throw new Error('Bot Warfare installer is unavailable.');
    const [status, resolved] = await Promise.all([
      this.modInstaller.status(id, gamePath),
      this.data.updatesEnabled ? this.modSource.resolveSource(id, this.botChannel(id)) : Promise.resolve(null),
    ]);
    const source = resolved ? { supported: resolved.supported, ref: resolved.ref, notes: resolved.notes, status: resolved.status }
      : { supported: this.botChannel(id) === 'stable' || ['cod4', 'bo2'].includes(id),
        ref: this.botChannel(id) === 'stable' ? SOURCES[id].tag || SOURCES[id].commit : null,
        notes: 'Update checks are off. Use Check now to see upstream release notes.', status: 'disabled' };
    return { ...status, channel: this.botChannel(id), source };
  }
  async botAction(id, operation) {
    profileFor(id);
    if (!['install', 'update', 'reinstall', 'remove'].includes(operation)) throw new Error('Unknown Bot Warfare action.');
    if (!this.modInstaller) throw new Error('Bot Warfare installer is unavailable.');
    // A pending restart has no live process; changing mod files cancels that retry.
    if (this.instances.get(id)?.status === 'restarting') this.cancelRestart(id);
    if (this.modBusy.has(id) || this.engineBusy.has(id) || this.instances.has(id)) throw new Error('Stop this server and finish engine changes before changing Bot Warfare.');
    // Reserve the game synchronously. start() checks this set before spawning,
    // closing the race between a download and a server starting mid-install.
    this.modBusy.add(id);
    try {
      await this.broadcastState();
      const gamePath = await this.gamePath(id);
      if (!gamePath || !(await inspectGameFolder(id, gamePath)).installed) throw new Error('Select an installed game folder first.');
      const status = await this.modInstaller.status(id, gamePath);
      if (operation === 'install' && status.state === 'installed') throw new Error('Bot Warfare is already managed. Use Update or Reinstall.');
      if (operation === 'update' && status.state !== 'installed') throw new Error('Install Bot Warfare before updating it.');
      if (operation === 'remove') await this.modInstaller.remove(id, gamePath);
      else await this.modInstaller.install(id, gamePath, this.botChannel(id));
      if (this.botUpdates[id]) {
        // A fresh install is current; after a remove the answer is unknown until
        // the next check, which runs in the background.
        const fresh = ['install', 'update', 'reinstall'].includes(operation);
        this.botUpdates[id] = { ...this.botUpdates[id], updateAvailable: fresh ? false : null };
        if (!fresh) Promise.resolve().then(() => this.checkBotUpdates(false)).catch(() => {});
      }
    } finally {
      this.modBusy.delete(id);
      await this.broadcastState().catch(() => {});
    }
  }
  async check(id) {
    const profile = profileFor(id);
    const options = this.options(id);
    const gamePath = await this.gamePath(id);
    const configPath = path.join(gamePath, profile.config);
    const blockers = [];
    const warnings = [];
    const pathSource = options.gamePath ? 'manual' : gamePath ? 'steam' : 'none';
    const inspected = this.detected && gamePath ? await inspectGameFolder(id, gamePath) : null;
    const installed = inspected ? inspected.installed : Boolean(gamePath && await exists(gamePath));
    const { status: keyStatus, reason: keyReason } = await this.keyState(id);
    let configMissing = false;
    // Structured readiness for the setup checklist: true/false per step, or
    // null when the step does not apply to this game.
    const plutonium = profile.executable === 'plutonium';
    const setup = { folder: installed, engine: plutonium ? null : false, plutonium: plutonium ? false : null,
      key: plutonium ? keyStatus === 'stored' : null, bots: false, config: false, maps: false };
    const count = () => blockers.length;
    if (!installed) {
      blockers.push(gamePath
        ? `${profile.short} multiplayer files were not found in ${gamePath}. Choose the folder containing the game executable.`
        : `${profile.short} was not found in your Steam libraries. Choose its installed game folder to continue.`);
    } else {
      configMissing = !await exists(configPath);
      if (configMissing) blockers.push(`Server config missing at ${configPath}. Click Create server config in this game's setup checklist.`);
      const engineStart = count();
      if (profile.id === 'cod4' && !await exists(path.join(gamePath, profile.executable))) blockers.push(`Cod4R/IW3x DedRun missing at ${path.join(gamePath, profile.executable)}. Follow the IW3x hosting guide to install it; stock CoD4x is not supported.`);
      if (profile.id === 'mw2' && !await exists(path.join(gamePath, profile.executable))) blockers.push(`IW4x executable missing at ${path.join(gamePath, profile.executable)}. Install IW4x in the selected MW2 game folder.`);
      if (profile.id === 'mw3') {
        try {
          // Current Plutonium IW5 also starts with a downgraded Steam install whose
          // iw5mp.exe is x64. Architecture alone does not establish compatibility.
          if (![0x14c, 0x8664].includes(await peMachine(path.join(gamePath, 'iw5mp.exe')))) blockers.push('MW3 multiplayer executable has an unsupported PE architecture.');
        } catch { blockers.push('MW3 multiplayer executable is missing or invalid. Select a working MW3 game folder.'); }
        if (!await exists(path.join(gamePath, 'mss32.dll'))) blockers.push('MW3 game runtime mss32.dll is missing. Restore compatible MW3 game files; do not copy a DLL from another game.');
      }
      if (!plutonium) setup.engine = count() === engineStart;
      const botsStart = count();
      if (profile.id === 'cod4' && !await exists(path.join(gamePath, 'mods', 'mp_bots', 'z_svr_bots.iwd'))) blockers.push(`CoD4 Bot Warfare missing at ${path.join(gamePath, 'mods', 'mp_bots', 'z_svr_bots.iwd')}. Click Install Bot Warfare in this game's setup checklist.`);
      if (profile.id === 'mw2' && !await exists(path.join(gamePath, 'userraw', 'z_svr_bots.iwd'))) blockers.push(`MW2 Bot Warfare missing at ${path.join(gamePath, 'userraw', 'z_svr_bots.iwd')}. Click Install Bot Warfare in this game's setup checklist.`);
      if (!plutonium) setup.bots = count() === botsStart;
    }
    if (installed && (id === 'cod4' || id === 'mw2') && this.engineUpdater?.prepareLaunch) {
      try { await this.engineUpdater.prepareLaunch(id, gamePath); }
      catch (error) { blockers.push(error.message || 'An engine update needs review before starting this server.'); }
    }
    if (profile.executable === 'plutonium' && !this.localAppData()) {
      blockers.push('The Windows LOCALAPPDATA folder is not set for this user, so Plutonium cannot be located. Sign in with a normal Windows account or restore the LOCALAPPDATA environment variable.');
    } else if (profile.executable === 'plutonium') {
      setup.plutonium = await exists(bootstrapPath());
      if (!setup.plutonium) blockers.push(`Plutonium is not installed (expected at ${bootstrapPath()}). Click Install Plutonium in this game's setup checklist.`);
      if (keyStatus === 'missing') blockers.push(`Plutonium server key needed for ${profile.short}. Paste your key in this game's setup checklist.`);
      if (keyStatus === 'unavailable') {
        if (keyReason === 'damaged') blockers.push(`The saved key file (keys.json) is damaged. Click Reset key storage in the ${profile.short} Server key panel (the old file is kept), then paste your key again.`);
        else if (keyReason === 'encryption-unavailable') blockers.push('Encrypted server keys cannot be read for this Windows user because Windows encryption is unavailable. Sign in with a normal Windows account and check Windows encryption; plaintext storage is never used.');
        else blockers.push(`The saved ${profile.short} server key cannot be read by this Windows profile (it was probably saved under another account or profile). Paste your key again in the Server key panel to replace it.`);
      }
      if (profile.id === 'bo1') warnings.push('BO1 has no -lan launch flag. Keep its LAN firewall rule active from the Overview tab to restrict network access.');
      const botsStart = count();
      if (id === 'mw3') {
        const storageArchive = path.join(process.env.LOCALAPPDATA || '', 'Plutonium', 'storage', 'iw5', ...profile.mod.split('/'), 'z_svr_bots.iwd');
        const gameArchive = path.join(gamePath, ...profile.mod.split('/'), 'z_svr_bots.iwd');
        if (!await exists(storageArchive) && (!gamePath || !await exists(gameArchive))) blockers.push('IW5 Bot Warfare archive missing: mods\\bots\\z_svr_bots.iwd. Install the mod in the game folder or Plutonium IW5 storage.');
      } else if (id === 'waw' || id === 'bo1') {
        const storageCode = id === 'waw' ? 't4' : 't5';
        const modFiles = id === 'waw' ? ['z_svr_bots.iwd'] : ['mod.ff', 'mp_bots.iwd'];
        const storageMod = path.join(process.env.LOCALAPPDATA || '', 'Plutonium', 'storage', storageCode, ...profile.mod.split('/'));
        const gameMod = gamePath ? path.join(gamePath, ...profile.mod.split('/')) : '';
        for (const name of modFiles) {
          if (!await exists(path.join(storageMod, name)) && (!gameMod || !await exists(path.join(gameMod, name)))) {
            blockers.push(`${profile.short} Bot Warfare ${name} is missing from ${storageMod}. Install the upstream mod before starting a bot server.`);
          }
        }
      }
      if (id === 'bo2') {
        const scripts = path.join(process.env.LOCALAPPDATA || '', 'Plutonium', 'storage', 't6', 'scripts', 'mp');
        for (const name of ['bots.gsc', 'bots_adapter_pt6.gsc']) {
          if (!await exists(path.join(scripts, name))) blockers.push(`T6 Bot Warfare ${name} is missing from ${scripts}. Install the upstream scripts before starting a bot server.`);
        }
      }
      setup.bots = installed && count() === botsStart;
    }
    if (installed) {
      const mapsStart = count();
      const [available, modes] = await Promise.all([scanMaps(profile, gamePath), modeOptions(profile, gamePath)]);
      if (!modes.some(mode => mode.value === options.mode)) {
        blockers.push(profile.id === 'mw3'
          ? `IW5 mode recipe missing: admin\\${options.mode}.dsr. Install the IW5 server configs or choose an installed mode.`
          : profile.id === 'bo2'
            ? `T6 multiplayer ruleset missing: main\\gamesettings\\${options.mode}.cfg must declare set_gametype ${options.mode}. Install a matching mode file or choose an installed mode.`
            : `The saved ${profile.short} mode is unavailable. Choose an installed mode.`);
      }
      if (!available.length) blockers.push(`No playable multiplayer maps found for ${profile.short}. Verify the game installation and multiplayer map files.`);
      if (id === 'bo2' && available.length < 2) blockers.push('BO2 requires at least two installed multiplayer maps. Verify the game installation.');
      if (options.selectedMaps.some(name => !available.includes(name))) blockers.push('Saved map selection contains maps no longer installed. Review Maps & modes.');
      if (id === 'bo2' && options.selectedMaps.length === 1) blockers.push('BO2 requires at least two selected maps. Review Maps & modes.');
      setup.maps = count() === mapsStart;
    }
    const configStart = count();
    // Without a game folder configPath is relative to the working directory, which must never be read.
    if ((id === 'mw3' || id === 'bo2') && gamePath && await exists(configPath)) {
      try {
        // Decode like the config editor does, so UTF-16 configs are checked correctly.
        const body = withoutBlockComments(decode(await fs.readFile(configPath)).text);
        const rotation = path.basename(profile.rotation).toLowerCase();
        const included = body.split(/\r?\n/).some(line => {
          const statement = line.split('//', 1)[0].trim();
          const match = statement.match(/^exec\s+(?:"([^"]+)"|'([^']+)'|([^\s;]+))\s*;?\s*$/i);
          return match && path.basename((match[1] || match[2] || match[3]).replaceAll('\\', '/')).toLowerCase() === rotation;
        });
        if (!included) blockers.push(`Base config must exec ${path.basename(profile.rotation)} for rotations to load.`);
        if (id === 'mw3') {
          const mod = parseEntries(body).get('fs_game');
          if (mod && mod.value.toLowerCase().replaceAll('\\', '/') !== profile.mod) blockers.push('IW5 server.cfg overrides the Bot Warfare mod. Set fs_game to mods/bots.');
        }
      } catch { blockers.push(`Could not read server config: ${profile.config.replaceAll('/', '\\')}`); }
    }
    setup.config = installed && !configMissing && count() === configStart;
    return { gamePath, installed, pathSource, keyStatus, keyReason, configMissing, setup, blockers, warnings, options };
  }
  async snapshot() {
    const games = await Promise.all(order.map(async id => {
      const profile = profiles[id];
      const result = await this.check(id);
      let config = {};
      if (result.installed && !result.configMissing) {
        try { config = await readConfig(path.join(result.gamePath, profile.config), { id, target: 'base', mode: result.options.mode }); }
        catch { if (!result.blockers.some(x => x.startsWith('Could not read server config'))) result.blockers.push(`Could not read server config: ${profile.config.replaceAll('/', '\\')}`); }
      }
      const instance = this.instances.get(id);
      const restart = this.restarts.get(id);
      if (restart && instance?.status === 'running' && instance.startedAt && this.restartTimers.now() - Date.parse(instance.startedAt) > this.restartWindow) {
        restart.crashes = [];
        restart.attempts = 0;
      }
      return { id, title: profile.title, short: profile.short, subtitle: profile.subtitle, family: profile.family, engine: profile.engine,
        configPath: result.gamePath ? path.join(result.gamePath, profile.config) : '',
        gamePath: result.gamePath, installed: result.installed, pathSource: result.pathSource, keyStatus: result.keyStatus, keyReason: result.keyReason ?? null,
        configMissing: result.configMissing, setup: result.setup,
        modBusy: this.modBusy.has(id), engineBusy: this.engineBusy.has(id), config, options: result.options, blockers: result.blockers, warnings: result.warnings,
        status: instance?.status || 'stopped', pid: instance?.child?.pid ?? null, startedAt: instance?.startedAt ?? null,
        activePort: instance?.activePort ?? null,
        connect: instance?.status === 'running' && instance.activePort
          ? discoverConnectAddresses(instance.activePort, this.networkInterfaces)
          : { primaryAddress: null, ambiguous: false, candidates: [] },
        orphan: (() => {
          const orphan = this.orphans.get(id);
          const owned = this.ownsListener(orphan);
          return orphan?.port === result.options.port && !owned ? orphan : null;
        })(),
        restart: { enabled: this.data.games?.[id]?.autoRestart === true, attempts: restart?.attempts || 0,
          nextAttemptAt: restart?.nextAttemptAt || null, cutOff: restart?.cutOff || false },
        logs: (this.logs.get(id) || []).slice(-120) };
    }));
    return { games, updatesEnabled: this.data.updatesEnabled, updates: this.botUpdates, plutonium: await this.plutoniumStatus() };
  }
  // Snapshots are built asynchronously and can finish out of order. A snapshot
  // that finishes after a newer one has been sent is stale and is dropped.
  async broadcastState() {
    const sequence = ++this.broadcastSequence;
    const snapshot = await this.snapshot();
    if (sequence < this.lastBroadcast) return;
    this.lastBroadcast = sequence;
    this.notify({ type: 'state', snapshot });
  }
  addLog(id, text, level = 'info', key = '', source = 'manager') {
    // Bound the input before running the redaction patterns. If a key crosses
    // that boundary, drop its partial prefix rather than publishing it.
    const activeKey = key || this.instances.get(id)?.logKey || '';
    const raw = String(text);
    let end = Math.min(raw.length, 4000);
    if (raw.length > end && typeof activeKey === 'string' && activeKey.length > 1) {
      for (let start = Math.max(0, end - activeKey.length + 1); start < end; start++) {
        if (activeKey.startsWith(raw.slice(start, end))) { end = start; break; }
      }
    }
    const message = redactLog(raw.slice(0, end), activeKey).slice(0, 2000);
    const entry = { at: new Date().toISOString(), level, message, source };
    const lines = this.logs.get(id) || [];
    lines.push(entry);
    if (lines.length > 400) lines.splice(0, lines.length - 400);
    this.logs.set(id, lines);
    if (this.instances.get(id)?.sessionOpen && this.sessionLogs) {
      // A failed disk append closes the session log instead of retrying (and
      // failing) on every following line.
      const instance = this.instances.get(id);
      const stopDiskLog = () => { if (instance) instance.sessionOpen = false; };
      try { Promise.resolve(this.sessionLogs.append(id, entry)).catch(stopDiskLog); }
      catch { stopDiskLog(); /* Disk logging is optional and must not interrupt the server. */ }
    }
    this.notify({ type: 'log', id, entry });
  }
  // A failed tail or optional disk log never changes process ownership. Cleanup
  // is idempotent because a failed launch and its child's close may race.
  releaseSession(id, instance) {
    if (!instance.cleanupPromise) {
      instance.cleanupPromise = (async () => {
        try { await instance.logTail?.stop(); } catch { /* Logging is best effort. */ }
        instance.sessionOpen = false;
        if (this.sessionLogs && instance.sessionStarted) {
          try { await this.sessionLogs.close(id); } catch { /* Keep the lifecycle independent of disk I/O. */ }
        }
        instance.logKey = '';
      })();
      const cleanup = instance.cleanupPromise;
      this.sessionCleanup.set(id, cleanup);
      cleanup.finally(() => { if (this.sessionCleanup.get(id) === cleanup) this.sessionCleanup.delete(id); }).catch(() => {});
    }
    return instance.cleanupPromise;
  }
  async maps(id, gamePathOverride) {
    const profile = profileFor(id);
    const gamePath = gamePathOverride || await this.gamePath(id);
    if (!gamePath || !await exists(gamePath)) throw new Error('Select an installed game folder first.');
    const [maps, modes] = await Promise.all([scanMaps(profile, gamePath), modeOptions(profile, gamePath)]);
    return { maps, modes };
  }
  async saveOptions(id, values) {
    profileFor(id);
    if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).some(k => !['port', 'mode', 'shuffle', 'selectedMaps', 'lan'].includes(k))) throw new Error('Invalid server options.');
    const changes = {};
    // Scan the installation at most once per save.
    let installation;
    const installed = () => (installation ??= this.maps(id));
    if ('port' in values) {
      if (!Number.isInteger(values.port) || values.port < 1024 || values.port > 65535) throw new Error('Port must be between 1024 and 65535.');
      changes.port = values.port;
    }
    if ('mode' in values) {
      if (typeof values.mode !== 'string' || !safeName.test(values.mode)) throw new Error('Invalid game mode.');
      const modes = (await installed()).modes;
      if (!modes.some(m => m.value === values.mode)) throw new Error('This game mode is not available in the installation.');
      changes.mode = values.mode;
    }
    if ('shuffle' in values) {
      if (typeof values.shuffle !== 'boolean') throw new Error('Invalid shuffle option.');
      changes.shuffle = values.shuffle;
    }
    if ('lan' in values) {
      if (typeof values.lan !== 'boolean') throw new Error('Invalid visibility option.');
      if (id !== 'bo1') changes.lan = values.lan;
    }
    if ('selectedMaps' in values) {
      if (!Array.isArray(values.selectedMaps) || values.selectedMaps.length > 300 || values.selectedMaps.some(m => typeof m !== 'string' || !safeName.test(m))) throw new Error('Invalid map selection.');
      const available = new Set((await installed()).maps);
      if (values.selectedMaps.some(m => !available.has(m)) || new Set(values.selectedMaps).size !== values.selectedMaps.length) throw new Error('Map selection contains missing or duplicate maps.');
      if (id === 'bo2' && (values.selectedMaps.length || available.size) < 2) throw new Error('Black Ops II needs at least two maps.');
      changes.selectedMaps = values.selectedMaps;
    }
    await this.updateSettings(data => { data.games[id] = { ...data.games[id], ...this.options(id), ...changes }; });
    await this.broadcastState().catch(() => {});
  }
  async chooseFolder(id, dialogWindow, dialog) {
    profileFor(id);
    const suggested = await this.gamePath(id);
    const result = await dialog.showOpenDialog(dialogWindow, { title: `Select ${profileFor(id).title} game folder`, properties: ['openDirectory'], ...(suggested ? { defaultPath: suggested } : {}) });
    if (result.canceled || !result.filePaths[0]) return false;
    const inspected = await inspectGameFolder(id, result.filePaths[0]);
    if (!inspected.installed) throw new Error(`No ${profileFor(id).short} multiplayer game executable was found in that folder. Choose the actual game installation.`);
    const busy = () => {
      if (this.instances.get(id)?.status === 'starting') throw new Error('Wait for this server to finish starting before changing its game folder.');
      if (this.modBusy.has(id) || this.engineBusy.has(id)) throw new Error('Wait for the engine or Bot Warfare change to finish before changing this game folder.');
    };
    busy();
    await this.updateSettings(data => {
      busy();
      data.games[id] = { ...data.games[id], ...this.options(id), gamePath: result.filePaths[0] };
    });
    await this.broadcastState().catch(() => {}); return true;
  }
  async createStarterConfig(id) {
    profileFor(id);
    const gamePath = await this.gamePath(id);
    if (!(await inspectGameFolder(id, gamePath)).installed) throw new Error('Select an installed game folder before creating a starter config.');
    const file = await writeStarterConfig(id, gamePath);
    // The file now exists; a refresh failure must not report the creation as failed.
    await this.broadcastState().catch(() => {});
    return file;
  }
  async configTarget(id, target = 'base', mode) {
    const profile = profileFor(id);
    const gamePath = await this.gamePath(id);
    if (!gamePath) throw new Error('Select the game folder first.');
    const selectedMode = mode || this.options(id).mode;
    // The mode also names base-config rule fields (scr_<mode>_*), so validate it for every target.
    if (typeof selectedMode !== 'string' || !safeName.test(selectedMode)) throw new Error('Invalid mode name.');
    schemaFor(id, target, selectedMode);
    if (target === 'base') return { file: path.join(gamePath, profile.config), mode: selectedMode };
    const modes = await modeOptions(profile, gamePath);
    if (!modes.some(item => item.value === selectedMode)) throw new Error('Selected mode is not installed.');
    const file = id === 'mw3' ? path.join(gamePath, 'admin', `${selectedMode}.dsr`)
      : path.join(gamePath, 'main', 'gamesettings', `${selectedMode}.cfg`);
    if (!await exists(file)) throw new Error('Mode rules file is missing.');
    return { file, mode: selectedMode };
  }
  async document(id, target = 'base', mode) {
    const { file, mode: selectedMode } = await this.configTarget(id, target, mode);
    const details = await readDocument(file, { id, target, mode: selectedMode });
    return { ...details, path: file, target, mode: selectedMode, sourceRepo: sourceRepos[id] };
  }
  assertConfigPath(file, expectedPath) {
    if (expectedPath !== undefined && (typeof expectedPath !== 'string' || path.resolve(file).toLowerCase() !== path.resolve(expectedPath).toLowerCase())) {
      throw new Error('The game folder changed. Reload the configuration before editing.');
    }
  }
  async previewSettings(id, target, mode, values, expectedPath) {
    const { file, mode: selectedMode } = await this.configTarget(id, target, mode);
    this.assertConfigPath(file, expectedPath);
    return previewConfig(file, values, { id, target, mode: selectedMode });
  }
  async commitSettings(id, target, mode, values, token, expectedPath) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new Error('Review the changes before saving.');
    const { file, mode: selectedMode } = await this.configTarget(id, target, mode);
    this.assertConfigPath(file, expectedPath);
    await saveConfig(file, values, { id, target, mode: selectedMode, token });
    // The file is already committed. A failed notification or reload must not
    // turn that successful write into a reported save failure.
    await this.broadcastState().catch(() => {});
    try {
      return await this.document(id, target, selectedMode);
    } catch {
      throw new Error('The configuration was saved, but it could not be reloaded. Reopen Configuration to refresh it before making more changes.');
    }
  }
  async listConfigBackups(id, target = 'base', mode) {
    const { file } = await this.configTarget(id, target, mode);
    return listBackups(file);
  }
  async previewConfigRestore(id, target, mode, backupId) {
    const { file } = await this.configTarget(id, target, mode);
    return previewRestore(file, backupId);
  }
  async restoreConfigBackup(id, target, mode, backupId, token) {
    const { file } = await this.configTarget(id, target, mode);
    const restored = await restoreBackup(file, backupId, token);
    // The restore is already on disk; a failed refresh must not report it as failed.
    await this.broadcastState().catch(() => {});
    return restored;
  }
  async pruneConfigBackups(id, target, mode, ids) {
    const { file } = await this.configTarget(id, target, mode);
    return pruneBackups(file, ids);
  }
  async artwork(id, kind) {
    profileFor(id);
    // Steam artwork lives under the Steam client install, which detection may
    // find outside Program Files (custom library or non-default install).
    const steamCache = this.detected?.steamPath
      ? path.join(this.detected.steamPath, 'appcache', 'librarycache')
      : '';
    // Only the header and cover can be replaced with a custom image.
    const override = kind === 'hero' || kind === 'cover' ? this.data.games[id]?.artwork?.[kind] : undefined;
    return artworkFor(id, kind, override, steamCache ? [steamCache] : []);
  }
  async chooseArtwork(id, kind, dialogWindow, dialog) {
    profileFor(id);
    if (!['hero', 'cover'].includes(kind)) throw new Error('Unknown artwork type.');
    const result = await dialog.showOpenDialog(dialogWindow, { title: `Choose ${kind} artwork`, properties: ['openFile'], filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }] });
    if (result.canceled || !result.filePaths[0]) return false;
    const selected = result.filePaths[0];
    if (!await loadImage(selected)) throw new Error('Image must be a valid JPG, PNG or WebP under 6 MB.');
    await this.updateSettings(data => { data.games[id] = { ...data.games[id], artwork: { ...data.games[id]?.artwork, [kind]: selected } }; });
    return true;
  }
  async resetArtwork(id, kind) {
    profileFor(id);
    if (!['hero', 'cover'].includes(kind)) throw new Error('Unknown artwork type.');
    await this.updateSettings(data => { if (data.games[id]?.artwork) delete data.games[id].artwork[kind]; });
    return this.artwork(id, kind);
  }
  // `netstat -p udp` lists IPv4 sockets only, so a listener bound to [::] would be
  // missed. Query both families; one failing (e.g. IPv6 disabled) is tolerated.
  async portInUse(port) {
    const results = await Promise.allSettled(['udp', 'udpv6'].map(protocol =>
      exec('netstat.exe', ['-ano', '-p', protocol], { timeout: 7000, windowsHide: true, maxBuffer: 3_000_000 })));
    if (results.every(result => result.status === 'rejected')) throw results[0].reason;
    return results.some(result => result.status === 'fulfilled' && String(result.value.stdout).split(/\r?\n/).some(line => {
      const match = line.match(/^\s*UDP\s+(\S+)\s+(?:\S+\s+)?(\d+)\s*$/i);
      return !!match && +match[1].slice(match[1].lastIndexOf(':') + 1) === port;
    }));
  }

  // botLANd manages exactly one named inbound rule per game and never touches
  // rules it did not create. Creating or changing a rule needs an elevation
  // prompt; reading it runs unelevated.
  firewallName(id) { return `botLANd ${profileFor(id).short} UDP`; }
  // A running server keeps the port it was launched with, so its rule must
  // cover that port until it stops; otherwise use the saved port.
  firewallPort(id) {
    profileFor(id);
    return this.instances.get(id)?.activePort ?? this.options(id).port;
  }
  // Reads matching rules through the NetSecurity cmdlets, whose enum values
  // (Inbound, Allow, LocalSubnet…) do not depend on the Windows display
  // language, unlike netsh's localized "show rule" output.
  async firewallQuery(name) {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$ProgressPreference = 'SilentlyContinue'",
      `$found = @(Get-NetFirewallRule -DisplayName '${name.replaceAll("'", "''")}' -ErrorAction SilentlyContinue -ErrorVariable lookupErrors)`,
      "$failure = @($lookupErrors | Where-Object { $_.CategoryInfo.Category -ne 'ObjectNotFound' })",
      'if ($failure.Count) { throw $failure[0] }',
      '$rules = foreach ($rule in $found) {',
      '  $ports = $rule | Get-NetFirewallPortFilter',
      '  $addresses = $rule | Get-NetFirewallAddressFilter',
      '  $apps = $rule | Get-NetFirewallApplicationFilter',
      '  $services = $rule | Get-NetFirewallServiceFilter',
      '  [pscustomobject]@{ group = [string]$rule.Group; description = [string]$rule.Description; source = [string]$rule.PolicyStoreSourceType; enabled = [string]$rule.Enabled; direction = [string]$rule.Direction; action = [string]$rule.Action; profile = [string]$rule.Profile; protocol = [string]$ports.Protocol; localPort = @($ports.LocalPort | ForEach-Object { [string]$_ }); remotePort = @($ports.RemotePort | ForEach-Object { [string]$_ }); localAddress = @($addresses.LocalAddress | ForEach-Object { [string]$_ }); remoteAddress = @($addresses.RemoteAddress | ForEach-Object { [string]$_ }); program = [string]$apps.Program; service = [string]$services.Service }',
      '}',
      'ConvertTo-Json -InputObject @($rules) -Compress -Depth 4',
    ].join('\n');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout: 20000, windowsHide: true, maxBuffer: 1_000_000 });
    const rules = JSON.parse(String(stdout).trim() || '[]');
    if (!Array.isArray(rules)) throw new Error('Unexpected firewall query result.');
    return rules;
  }
  async firewallStatus(id) {
    profileFor(id);
    const port = this.firewallPort(id);
    const name = this.firewallName(id);
    let rules;
    try { rules = await this.firewallQuery(name); }
    catch { return { name, port, state: 'unknown' }; }
    if (!rules.length) return { name, port, state: 'missing' };
    // Duplicate rules with this name are not something botLANd created; Update replaces them all.
    if (rules.length > 1) return { name, port, state: 'drift' };
    const rule = rules[0] || {};
    const list = value => (Array.isArray(value) ? value : [value]).map(item => String(item ?? '').trim().toLowerCase());
    const enabled = String(rule.enabled).toLowerCase() === 'true';
    const inbound = String(rule.direction).toLowerCase() === 'inbound';
    const allowed = String(rule.action).toLowerCase() === 'allow';
    const udp = ['udp', '17'].includes(String(rule.protocol).toLowerCase());
    const ports = list(rule.localPort);
    const portOk = ports.length === 1 && ports[0] === String(port);
    const remote = list(rule.remoteAddress);
    const owned = rule.group === 'botLANd.ServerManager' && rule.description === 'Managed by botLANd Server Manager (UDP)';
    const legacy = typeof rule.group === 'string' && typeof rule.description === 'string' &&
      !rule.group.trim() && !rule.description.trim();
    const exact = String(rule.source).toLowerCase() === 'local' && String(rule.profile).toLowerCase() === 'any' &&
      list(rule.remotePort).join() === 'any' && list(rule.localAddress).join() === 'any' &&
      String(rule.program).toLowerCase() === 'any' && String(rule.service).toLowerCase() === 'any';
    const state = (!owned && !legacy) || !exact || !enabled || !inbound || !allowed || !udp || !portOk || remote.length !== 1 ? 'drift'
      : remote[0] === 'localsubnet' ? 'lan' : remote[0] === 'any' ? 'any' : 'drift';
    // Only a correctly filtered, strictly marked local rule may guard BO1.
    // An unmarked legacy rule can be replaced by Apply after its full elevated
    // fingerprint check, but must not be mistaken for botLANd ownership here.
    return { name, port, state, ...(owned ? { managed: true } : {}), ...(legacy ? { legacy: true } : {}) };
  }
  async runElevated(lines) {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'botland-elevate-'));
    const resultFile = path.join(workspace, 'result.json');
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$message = ''",
      'try {',
      ...lines.map(line => '  ' + line),
      '} catch {',
      '  $message = [string]$_',
      '}',
      `@{ ok = [string]::IsNullOrEmpty($message); message = $message } | ConvertTo-Json | Set-Content -LiteralPath '${resultFile.replaceAll("'", "''")}' -Encoding UTF8`,
    ].join('\n');
    // Pass the script inline rather than as a file in a user-writable folder,
    // so nothing can be swapped in between the UAC prompt and execution.
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    // A declined UAC prompt is ERROR_CANCELLED (1223); its message text is
    // localized, so report the native code as the exit code instead.
    const command = `try { $p = Start-Process -WindowStyle Hidden -Verb RunAs -PassThru -Wait powershell.exe `
      + `-ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}') } `
      + `catch { $e = $_.Exception; while ($e) { if ($e.NativeErrorCode -eq 1223) { exit 1223 }; $e = $e.InnerException }; throw }; `
      + `if ($p) { $p.WaitForExit(); exit $p.ExitCode }`;
    try {
      try {
        await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
          { timeout: 120000, windowsHide: true, maxBuffer: 1_000_000 });
      } catch (error) {
        const text = `${error?.stderr ?? ''} ${error?.stdout ?? ''}`;
        if (error?.code === 1223 || /cancel/i.test(text)) throw new Error('The elevation prompt was canceled, so the firewall was not changed.');
        if (error?.killed || error?.signal) throw new Error('Timed out waiting for the administrator prompt; the change may still apply. Refresh the rule status.');
        throw new Error('Windows could not complete the firewall change. Approve the administrator prompt and try again.');
      }
      let result;
      try { result = JSON.parse((await fs.readFile(resultFile, 'utf8')).replace(/^\uFEFF/, '')); }
      catch { throw new Error('Windows did not report the firewall outcome. Check the rule in the Overview panel.'); }
      if (result?.ok !== true) throw new Error(`The firewall change failed: ${String(result?.message || 'the elevated script did not report success.').slice(0, 300)}`);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
    }
  }
  // BO1 always launches public (no -lan), so its firewall rule is the only LAN
  // guard and is always scoped to the local subnet. Scope follows the saved
  // visibility even while a server runs, so a live server can be tightened.
  firewallScope(id) {
    return profileFor(id).id === 'bo1' || this.options(id).lan !== false ? 'lan' : 'any';
  }
  async firewallApply(id) {
    const port = this.firewallPort(id);
    const name = this.firewallName(id);
    const scope = this.firewallScope(id) === 'lan' ? 'localsubnet' : 'any';
    await this.runElevated(buildFirewallApplyLines({ name, port, scope }));
    return this.firewallStatus(id);
  }
  async firewallRemove(id) {
    profileFor(id);
    const name = this.firewallName(id);
    await this.runElevated(buildFirewallRemoveLines({ name }));
    return this.firewallStatus(id);
  }

  buildCommand(profile, gamePath, port, mode, key, lan = true) {
    if (profile.id === 'cod4') return { file: path.join(gamePath, profile.executable), argv0: profile.executable, cwd: gamePath,
      args: ['-nogui', '+set', 'dedicated', lan ? '1' : '2', '+set', 'sv_pure', '0', '+set', 'net_port', String(port), '+set', 'fs_game', profile.mod, '+exec', 'botserver.cfg', '+exec', 'botserver_rotation.cfg', '+map_rotate'] };
    // IW4x interprets an absolute argv[0] containing spaces as a console command.
    if (profile.id === 'mw2') return { file: path.join(gamePath, profile.executable), argv0: 'iw4x.exe', cwd: gamePath,
      args: ['-dedicated', '-stdout', '+set', 'fs_game', '', '+set', 'sv_lanonly', lan ? '1' : '0', '+set', 'net_port', String(port), '+exec', 'serverlan.cfg', '+exec', 'serverlan_rotation.cfg', '+set', 'g_gametype', mode, '+set', 'logfile', '1', '+set', 'party_enable', '0', '+map_rotate'] };
    const codes = { waw: 't4mp', bo1: 't5mp', mw3: 'iw5mp', bo2: 't6mp' };
    const args = [codes[profile.id], gamePath, '-dedicated'];
    // BO1's launch profile has no -lan path; the other Plutonium titles flip with it.
    if (profile.id !== 'bo1' && lan) args.push('-lan');
    if (profile.id === 'mw3') args.push('+start_map_rotate');
    args.push('+set', 'key', key, '+set', 'net_port', String(port));
    if (profile.mod) args.push('+set', 'fs_game', profile.mod);
    if (profile.id === 'bo1') args.push('+set', 'net_ip', '0.0.0.0');
    if (profile.id === 'mw3') args.push('+set', 'sv_config', 'server.cfg');
    else args.push('+exec', path.basename(profile.config));
    if (profile.id === 'waw' || profile.id === 'bo1') args.push('+exec', path.basename(profile.rotation));
    if (profile.id !== 'mw3') args.push('+map_rotate');
    return { file: bootstrapPath(), cwd: path.join(process.env.LOCALAPPDATA || '', 'Plutonium'), args };
  }
  scheduleRestart(id, instance) {
    const state = this.restartState(id);
    if (this.shuttingDown || instance.noRestart || state.suppressed || this.data.games?.[id]?.autoRestart !== true || this.modBusy.has(id) || this.engineBusy.has(id)) return false;
    const now = this.restartTimers.now();
    // An uninterrupted healthy run starts a fresh crash budget.
    if (instance.startedAt && now - Date.parse(instance.startedAt) > this.restartWindow) state.crashes = [];
    state.crashes = state.crashes.filter(at => now - at < this.restartWindow);
    state.crashes.push(now);
    state.attempts = state.crashes.length;
    if (state.attempts > this.restartDelays.length) {
      state.cutOff = true;
      this.addLog(id, 'Automatic restart stopped after repeated crashes. Start manually to clear the cutoff.', 'error');
      return false;
    }
    const delay = this.restartDelays[state.attempts - 1];
    instance.status = 'restarting';
    instance.child = null;
    instance.startedAt = null;
    instance.activePort = null;
    state.nextAttemptAt = new Date(now + delay).toISOString();
    state.timer = this.restartTimers.setTimeout(() => {
      state.timer = null;
      state.nextAttemptAt = null;
      if (this.instances.get(id) !== instance || state.suppressed || this.shuttingDown || (this.modBusy.has(id) || this.engineBusy.has(id)) || this.data.games?.[id]?.autoRestart !== true) {
        if (this.instances.get(id) === instance) this.instances.delete(id);
        this.broadcastState().catch(() => {});
        return;
      }
      // A slow file-tail drain must not close a newly opened retry session.
      this.releaseSession(id, instance).then(() => {
        if (this.instances.get(id) !== instance || state.suppressed || this.shuttingDown || (this.modBusy.has(id) || this.engineBusy.has(id)) || this.data.games?.[id]?.autoRestart !== true) {
          if (this.instances.get(id) === instance) this.instances.delete(id);
          this.broadcastState().catch(() => {});
          return;
        }
        this.instances.delete(id);
        // Any outcome must refresh the UI; otherwise a refused retry leaves a
        // stale "restarting" card that no longer matches a managed instance.
        this.launch(id, true).catch(() => {}).finally(() => { this.broadcastState().catch(() => {}); });
      }).catch(() => {});
    }, delay);
    this.addLog(id, `Server exited unexpectedly. Restart attempt ${state.attempts} in ${delay / 1000}s.`, 'error');
    return true;
  }
  async start(id) { return this.launch(id, false); }
  async launch(id, retry) {
    const profile = profileFor(id);
    if (this.shuttingDown) throw new Error('The manager is shutting down.');
    if (!retry && this.instances.get(id)?.status === 'restarting') this.cancelRestart(id);
    // Closing an earlier session may still be draining its tail. Never let that
    // close race a new session opened for this game (manual or automatic retry).
    if (this.sessionCleanup.has(id)) await this.sessionCleanup.get(id);
    if (this.shuttingDown) throw new Error('The manager is shutting down.');
    if (this.instances.has(id)) throw new Error('This server is already starting or running.');
    if (this.modBusy.has(id)) throw new Error('Wait for the Bot Warfare change to finish before starting this server.');
    if (this.engineBusy.has(id)) throw new Error('Wait for the engine update to finish before starting this server.');
    if (this.modInstaller && typeof this.modInstaller.prepareLaunch === 'function') {
      const gamePath = await this.gamePath(id);
      if (gamePath) {
        try { await this.modInstaller.prepareLaunch(id, gamePath); }
        catch (error) {
          const message = `Could not finish recovering an interrupted Bot Warfare change, so the server was not started: ${error.message}`;
          if (retry) this.restartState(id).cutOff = true;
          this.addLog(id, message, 'error');
          throw new Error(message);
        }
      }
      // Recovery is asynchronous; re-check what a concurrent action may have changed.
      if (this.shuttingDown) throw new Error('The manager is shutting down.');
      if (this.instances.has(id)) throw new Error('This server is already starting or running.');
      if (this.modBusy.has(id)) throw new Error('Wait for the Bot Warfare change to finish before starting this server.');
    if (this.engineBusy.has(id)) throw new Error('Wait for the engine update to finish before starting this server.');
    }
    const restart = this.restartState(id);
    if (!retry) { restart.crashes = []; restart.attempts = 0; restart.cutOff = false; }
    else if (restart.cutOff || restart.suppressed || this.data.games?.[id]?.autoRestart !== true) return;
    const instance = { status: 'starting', child: null, startedAt: null, activePort: null, cancelled: false, stopPromise: null, closed: false,
      logKey: '', logTail: null, sessionOpen: false, sessionStarted: false, cleanupPromise: null };
    instance.launchDone = new Promise(resolve => { instance.resolveLaunch = resolve; });
    this.instances.set(id, instance);
    let launchKey = '';
    try {
      await this.broadcastState();
      if (profile.executable === 'plutonium' && this.plutonium) {
        // Another Plutonium server is using the bootstrapper; updating now would
        // replace files under it, so this launch uses the installed version.
        await this.plutonium.prepareLaunch({ skip: this.plutoniumActive(id), log: (text, level = 'info') => this.addLog(id, text, level) });
        if (instance.cancelled) throw new Error('Launch cancelled.');
      }
      const check = await this.check(id);
      if (check.blockers.length) throw new Error(check.blockers.join(' '));
      const { gamePath, options } = check;
      if (this.engineUpdater && (id === 'cod4' || id === 'mw2')) await this.engineUpdater.prepareLaunch(id, gamePath);
      instance.activePort = options.port;
      // T5 has no -lan argument. Refuse to start it until its local-subnet
      // firewall rule has been verified; a warning alone cannot keep it LAN-only.
      if (id === 'bo1') {
        const firewall = await this.firewallStatus(id);
        if (firewall.state !== 'lan' || firewall.managed !== true) throw new Error('BO1 needs a verified botLANd LAN-only firewall rule before starting. Create or replace it on the Overview tab, then try again.');
      }
      for (const [otherId, other] of this.instances) if (otherId !== id && other.status !== 'stopped' && (other.activePort ?? this.options(otherId).port) === options.port) throw new Error(`UDP ${options.port} is already assigned to another running server.`);
      // If the port cannot be inspected, let the game itself report a bind failure
      // rather than blocking a launch on a diagnostic tool.
      let portBusy = false;
      try { portBusy = await this.portInUse(options.port); }
      catch {
        // A manual Start can leave port diagnosis to the engine. Automatic
        // replacement cannot risk overlapping an unknown leftover process.
        if (retry) throw new Error(`Could not verify UDP ${options.port} is free. Automatic restart is blocked; inspect the port and start manually.`);
        this.addLog(id, `Could not check whether UDP ${options.port} is free; starting anyway.`, 'info');
      }
      if (portBusy) throw new Error(`UDP port ${options.port} is already in use. Stop the other server or choose a different port.`);
      const { maps, modes } = await this.maps(id, gamePath);
      if (!modes.some(m => m.value === options.mode)) throw new Error('Selected game mode is no longer installed.');
      const chosen = options.selectedMaps.length ? options.selectedMaps : maps;
      if (chosen.some(m => !maps.includes(m))) throw new Error('A selected map is no longer installed. Update the map selection.');
      if (!chosen.length) throw new Error('No installed multiplayer maps found.');
      const key = profile.executable === 'plutonium' ? await this.keyStore?.get(id) : '';
      launchKey = key || '';
      instance.logKey = launchKey;
      if (profile.executable === 'plutonium' && !key) throw new Error('Plutonium server key is not available. Paste it on this game\'s Overview.');
      const rotation = rotationText(profile, chosen, options.mode, options.shuffle);
      if (instance.cancelled) throw new Error('Launch cancelled.');
      await writeRotation(path.join(gamePath, profile.rotation), rotation);
      if (instance.cancelled) throw new Error('Launch cancelled.');
      const command = this.buildCommand(profile, gamePath, options.port, options.mode, key, options.lan);
      if (this.sessionLogs) {
        try {
          await this.sessionLogs.start(id, { key: launchKey });
          instance.sessionStarted = true;
          instance.sessionOpen = true;
        } catch { /* A full or unavailable log directory must not block launch. */ }
      }
      try {
        instance.logTail = this.createLogTail({ id, gamePath,
          onLine: line => this.addLog(id, line, 'info', launchKey, 'file') });
        await instance.logTail.start();
      } catch {
        try { await instance.logTail?.stop(); } catch { /* Best effort. */ }
        instance.logTail = null;
      }
      // Turning automatic restart off while a retry was preparing cancels it.
      if (retry && (restart.suppressed || this.data.games?.[id]?.autoRestart !== true)) instance.cancelled = true;
      if (instance.cancelled) throw new Error('Launch cancelled.');
      const visibility = id === 'bo1' ? 'no -lan; firewall-scoped' : options.lan === false ? 'public' : 'LAN';
      this.addLog(id, `Starting ${profile.engine} on UDP ${options.port} (${visibility}) with ${chosen.length} maps.`, 'info');
      const child = spawn(command.file, command.args, { cwd: command.cwd, argv0: command.argv0, windowsHide: true, stdio: [id === 'cod4' ? 'pipe' : 'ignore', 'pipe', 'pipe'], shell: false });
      instance.child = child;
      if (id === 'cod4' && child.stdin) {
        child.stdin.on('error', () => {}); // A closed console pipe must never crash the app.
        instance.consoleErrorHandled = true;
      }
      let spawned = false;
      // Buffer whole lines so a secret split across stdout chunks is never published.
      for (const [stream, level, source] of [[child.stdout, 'info', 'stdout'], [child.stderr, 'error', 'stderr']]) {
        if (!stream) continue;
        let pending = '';
        // After an oversized line is omitted, discard its remainder up to the
        // next newline so the tail is not published as a separate line.
        let dropping = false;
        // A multi-byte UTF-8 character may be split across chunks.
        const decoder = new StringDecoder('utf8');
        stream.on('data', chunk => {
          pending += typeof chunk === 'string' ? chunk : decoder.write(chunk);
          const lines = pending.split(/\r?\n/);
          pending = lines.pop();
          for (const line of lines) {
            if (dropping) { dropping = false; continue; }
            this.addLog(id, line, level, key, source);
          }
          if (pending.length > 16_000) {
            if (!dropping) this.addLog(id, '[Long server output line omitted]', 'info', key, source);
            dropping = true;
            pending = '';
          }
        });
        stream.on('end', () => { pending += decoder.end(); if (pending && !dropping) this.addLog(id, pending, level, key, source); });
      }
      child.on('error', error => { if (spawned) this.addLog(id, `Process error: ${error.message}`, 'error', key); });
      child.on('close', (code, signal) => {
        instance.closed = true;
        const wasStopping = instance.status === 'stopping' || instance.cancelled;
        const managed = this.instances.get(id) === instance;
        // Log the exit before any restart scheduling so the console reads in order.
        if (spawned) this.addLog(id, wasStopping ? 'Server stopped.' : `Server exited (code ${code ?? 'unknown'}${signal ? `, ${signal}` : ''}).`, wasStopping || code === 0 ? 'info' : 'error');
        const restarting = managed && !wasStopping && spawned && Number.isInteger(child.pid) && child.pid > 0 && this.scheduleRestart(id, instance);
        // Register session cleanup before releasing the slot, so an immediate
        // Start waits for the previous session log to close.
        this.releaseSession(id, instance).catch(() => {});
        if (managed && !restarting) this.instances.delete(id);
        this.broadcastState().catch(() => {});
      });
      await new Promise((resolve, reject) => {
        const onSpawn = () => { child.off('error', onError); child.off('close', onClose); spawned = true; resolve(); };
        const onError = error => { child.off('spawn', onSpawn); child.off('close', onClose); reject(error); };
        const onClose = () => { child.off('spawn', onSpawn); child.off('error', onError); reject(new Error('Server closed before spawning.')); };
        child.once('spawn', onSpawn);
        child.once('error', onError);
        child.once('close', onClose);
      });
      if (instance.closed) return;
      if (instance.cancelled) throw new Error('Launch cancelled.');
      instance.status = 'running';
      instance.startedAt = new Date().toISOString();
      // A renderer refresh failure cannot undo a successfully spawned process.
      await this.broadcastState().catch(() => {});
    } catch (error) {
      if (retry && !instance.cancelled) {
        restart.cutOff = true;
        this.addLog(id, 'Automatic restart blocked by launch preflight or process error. Start manually after resolving it.', 'error');
      }
      if (instance.cancelled) this.addLog(id, 'Launch cancelled.', 'info');
      else this.addLog(id, `Could not start: ${error.message}`, 'error', launchKey);
      if (!instance.child?.pid && this.instances.get(id) === instance) this.instances.delete(id);
      await this.broadcastState().catch(() => {});
      throw error;
    } finally {
      // A child object can exist without a PID when spawn itself failed; Node
      // does not guarantee a 'close' for it, so release the session here.
      if (!instance.child?.pid && !instance.closed && instance.status !== 'restarting') await this.releaseSession(id, instance);
      instance.resolveLaunch();
    }
  }
  async stopChild(id, instance) {
    try { this.addLog(id, 'Stopping this server and its child processes…', 'info'); } catch { /* A renderer notification must not prevent shutdown. */ }
    const child = instance.child;
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    const restore = async message => {
      // The process is still alive, even if this stop cancelled its launch.
      instance.status = 'running';
      instance.cancelled = false;
      instance.startedAt ??= new Date().toISOString();
      instance.stopPromise = null;
      try { await this.broadcastState(); } catch { /* Keep the original stop failure. */ }
      throw new Error(message);
    };
    // Record the close event before killing so a fast close is not missed.
    let sawClose = false;
    const markClosed = () => { sawClose = true; };
    child.once('close', markClosed);
    const isClosed = () => sawClose || this.instances.get(id) !== instance;
    try {
      if (id === 'cod4' && !exited() && child.stdin && typeof child.stdin.write === 'function' && !child.stdin.destroyed && child.stdin.writable !== false) {
        // Cod4R documents `quit` for its -nogui console; no other engine has a verified protocol.
        if (!instance.consoleErrorHandled) {
          child.stdin.on('error', () => {}); // A broken console pipe must not crash the manager.
          instance.consoleErrorHandled = true;
        }
        try {
          child.stdin.write('quit\n');
          this.addLog(id, 'Waiting for Cod4R to quit gracefully…', 'info');
          if (await waitForClose(child, isClosed, this.gracefulStopTimeout)) {
            if (instance.closed) await this.releaseSession(id, instance);
            return;
          }
        } catch { /* Broken stdin: fall through to taskkill for this owned PID. */ }
      }
      if (!exited() && !isClosed()) {
        try { await exec('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { timeout: 15000, windowsHide: true }); }
        catch (error) {
          if (this.instances.get(id) === instance && !exited()) await restore(`Could not stop server: ${error.message}`);
        }
      }
      if (await waitForClose(child, isClosed, this.stopTimeout)) {
        if (instance.closed) await this.releaseSession(id, instance);
        return;
      }
      if (!exited()) await restore('The server process did not exit. Try stopping it again.');
      // The process is gone, but a leftover process still holds its output
      // pipes, so 'close' never fires. Release them so the instance can end.
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (await waitForClose(child, isClosed, 1000)) {
        if (instance.closed) await this.releaseSession(id, instance);
        return;
      }
    } finally { child.off('close', markClosed); }
    const cleanup = this.releaseSession(id, instance);
    if (this.instances.get(id) === instance) {
      this.instances.delete(id);
      try {
        this.addLog(id, 'The server process exited, but a leftover process kept its output open. botLANd no longer manages it; close it from Task Manager if it is still running.', 'error');
        await this.broadcastState();
      } catch { /* The instance is already released. */ }
    }
    await cleanup;
  }
  async stop(id) {
    profileFor(id);
    const instance = this.instances.get(id);
    if (!instance) throw new Error('No running server is managed for this game.');
    if (instance.status === 'restarting') {
      this.cancelRestart(id);
      await this.broadcastState().catch(() => {});
      return;
    }
    if (instance.status === 'stopping') return instance.stopPromise || instance.launchDone;
    if (!instance.child?.pid && instance.status !== 'starting') throw new Error('No running server is managed for this game.');
    instance.cancelled = true;
    instance.noRestart = true; // Even a failed taskkill must not turn a later exit into an automatic retry.
    instance.status = 'stopping';
    instance.stopPromise = (async () => {
      try { await this.broadcastState(); } catch { /* Shutdown must continue if the UI cannot refresh. */ }
      if (!instance.child?.pid) await instance.launchDone;
      if (this.instances.get(id) === instance && instance.child?.pid) await this.stopChild(id, instance);
    })();
    return instance.stopPromise;
  }
  async stopAll() {
    this.shuttingDown = true;
    if (this.orphanTimer) clearInterval(this.orphanTimer);
    this.orphanTimer = null;
    await Promise.allSettled([...this.instances.keys()].map(id => this.stop(id)));
    // The UI remains open after a failed stop; allow a later manual Start while
    // retaining noRestart on the surviving children from this quit attempt.
    if (this.hasRunning()) {
      this.shuttingDown = false;
      // A quit that failed must not permanently disable the periodic orphan scan.
      this.ensureOrphanTimer();
    }
  }
  // Undo a quit that was abandoned after stopAll(), so Start, automatic
  // restart and the periodic orphan scan work again.
  cancelShutdown() {
    if (!this.shuttingDown) return;
    this.shuttingDown = false;
    this.ensureOrphanTimer();
  }
  hasRunning() { return this.instances.size > 0; }
  // A Bot Warfare change rewrites game files; quitting in the middle of it
  // would leave recovery to the next launch.
  hasModWork() { return this.modBusy.size > 0 || this.engineBusy.size > 0 || Boolean(this.plutonium?.updating); }
}
module.exports = { ServerManager };
