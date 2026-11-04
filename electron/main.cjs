const path = require('node:path');
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, session, shell } = require('electron');
const { ServerManager } = require('./manager.cjs');
const { KeyStore } = require('./key-store.cjs');
const { BotWarfareSource } = require('./botwarfare-source.cjs');
const { BotWarfareInstaller } = require('./botwarfare-install.cjs');
const { SessionLogs } = require('./session-logs.cjs');
const { discoverConnectAddresses } = require('./connect-address.cjs');
const { profileFor } = require('./profiles.cjs');
const { sourceRepos } = require('./schema.cjs');

const engineGuides = {
  cod4: 'https://iw3x.com/setup#hosting',
  mw2: 'https://github.com/iw4x/iw4x-client',
  waw: 'https://plutonium.pw/docs/server/t4/setting-up-a-server/',
  bo1: 'https://plutonium.pw/docs/server/t5/setting-up-a-server/',
  mw3: 'https://plutonium.pw/docs/server/iw5/setting-up-a-server/',
  bo2: 'https://plutonium.pw/docs/server/t6/setting-up-a-server/',
};

/** @type {import('electron').BrowserWindow | undefined} */
let window;
/** @type {ServerManager | undefined} */
let manager;
let quitAfterStop = false;
let stoppingForQuit = false;

async function migrateSettings() {
  // The product name controls Electron's userData folder. Preserve existing
  // preferences when upgrading from the previous capitalization of the app.
  const oldSettings = path.join(app.getPath('appData'), 'BotLANd Server Manager', 'settings.json');
  const newSettings = path.join(app.getPath('userData'), 'settings.json');
  if (oldSettings.toLowerCase() === newSettings.toLowerCase()) return;
  await fs.mkdir(path.dirname(newSettings), { recursive: true });
  try { await fs.copyFile(oldSettings, newSettings, constants.COPYFILE_EXCL); }
  catch (error) { if (!['ENOENT', 'EEXIST'].includes(error.code)) throw error; }
}

async function createWindow() {
  const defaultRoot = app.isPackaged ? '' : path.resolve(__dirname, '..', '..');
  await migrateSettings();
  const modSource = new BotWarfareSource({ userData: app.getPath('userData') });
  const modInstaller = new BotWarfareInstaller({ source: modSource, localAppData: process.env.LOCALAPPDATA,
    isRunning: id => manager?.instances.has(id) || false });
  manager = new ServerManager(path.join(app.getPath('userData'), 'settings.json'), data => {
    // Server output can arrive while the renderer is reloading or gone; sending to a
    // disposed frame throws and must not crash the main process or end a stream handler.
    try { if (window && !window.isDestroyed()) window.webContents.send('manager:event', data); } catch { /* Renderer unavailable. */ }
  }, defaultRoot, { keyStore: new KeyStore(path.join(app.getPath('userData'), 'keys.json'), safeStorage),
    modSource, modInstaller, sessionLogs: new SessionLogs({ userData: app.getPath('userData') }) });
  const recoveredSettings = await manager.initialize();
  await manager.rescanInstallations();
  window = new BrowserWindow({
    width: 1380, height: 860, minWidth: 980, minHeight: 680,
    backgroundColor: '#1B1A19', autoHideMenuBar: true, show: false,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.once('ready-to-show', () => window.show());
  window.on('close', event => {
    if (quitAfterStop) return;
    if (stoppingForQuit) { event.preventDefault(); return; }
    if (!manager?.hasRunning()) return;
    event.preventDefault();
    requestQuit();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  if (app.isPackaged) await window.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  else await window.loadURL('http://127.0.0.1:5173');
  // Metadata checks run in the background and never delay the first window.
  manager.checkBotUpdates?.().catch(() => {});
  if (recoveredSettings) {
    dialog.showMessageBox(window, {
      type: 'warning', title: 'Settings were reset',
      message: 'botLANd could not read its saved settings and started with defaults.',
      detail: `A copy of the unreadable file was kept at:\n${recoveredSettings}`,
    }).catch(() => {});
  }
}

function focusWindow() {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.focus();
}

// A second copy would manage the same servers and overwrite the same rotation
// files, so hand off to the running instance instead.
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
else app.on('second-instance', focusWindow);

if (primaryInstance) app.whenReady().then(() => {
  // The UI needs no camera, microphone, notifications or similar web permissions.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  ipcMain.handle('manager:action', async (_event, action, payload = {}) => {
    if (!manager) throw new Error('Server manager is not ready.');
    if (!window || _event.sender !== window.webContents || _event.senderFrame !== window.webContents.mainFrame) throw new Error('Invalid window.');
    if (typeof action !== 'string' || !payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid request.');
    const id = payload.id;
    switch (action) {
      case 'snapshot': return manager.snapshot();
      case 'maps': return manager.maps(id);
      case 'start': return manager.start(id);
      case 'stop': return manager.stop(id);
      case 'setAutoRestart': return manager.setAutoRestart(id, payload.enabled);
      case 'rescanOrphans': return manager.rescanOrphans();
      case 'copyConnectAddress': {
        profileFor(id);
        if (typeof payload.address !== 'string' || manager.instances.get(id)?.status !== 'running') throw new Error('Start this server before copying its address.');
        const port = manager.instances.get(id).activePort;
        const connect = discoverConnectAddresses(port);
        if (!connect.candidates.some(candidate => candidate.connectAddress === payload.address)) throw new Error('That local connect address is no longer available. Refresh the page.');
        clipboard.writeText(payload.address);
        return true;
      }
      case 'saveOptions': return manager.saveOptions(id, payload.values);
      case 'document': return manager.document(id, payload.target, payload.mode);
      case 'previewSettings': return manager.previewSettings(id, payload.target, payload.mode, payload.values, payload.expectedPath);
      case 'commitSettings': return manager.commitSettings(id, payload.target, payload.mode, payload.values, payload.token, payload.expectedPath);
      case 'listConfigBackups': return manager.listConfigBackups(id, payload.target, payload.mode);
      case 'previewConfigRestore': return manager.previewConfigRestore(id, payload.target, payload.mode, payload.backupId);
      case 'restoreConfigBackup': return manager.restoreConfigBackup(id, payload.target, payload.mode, payload.backupId, payload.token);
      case 'pruneConfigBackups': return manager.pruneConfigBackups(id, payload.target, payload.mode, payload.ids);
      case 'artwork': return manager.artwork(id, payload.kind);
      case 'firewallStatus': return manager.firewallStatus(id);
      case 'firewallApply': return manager.firewallApply(id);
      case 'firewallRemove': return manager.firewallRemove(id);
      case 'openDocs': return shell.openExternal(sourceRepos[profileFor(id).id]);
      case 'chooseArtwork': return manager.chooseArtwork(id, payload.kind, window, dialog);
      case 'resetArtwork': return manager.resetArtwork(id, payload.kind);
      case 'openDocument': {
        const { file } = await manager.configTarget(id, payload.target, payload.mode);
        const error = await shell.openPath(file);
        if (error) throw new Error(error);
        return true;
      }
      case 'chooseFolder': return manager.chooseFolder(id, window, dialog);
      case 'chooseRoot': return manager.chooseRoot(window, dialog);
      case 'rescanInstallations': return manager.rescanInstallations();
      case 'createStarterConfig': return manager.createStarterConfig(id);
      case 'botStatus': return manager.botStatus(id);
      case 'botAction': return manager.botAction(id, payload.operation, payload.versionId);
      case 'setBotChannel': return manager.setBotChannel(id, payload.channel);
      case 'checkBotUpdates': return manager.checkBotUpdates(true);
      case 'setUpdateChecks': return manager.setUpdateChecks(payload.enabled);
      case 'saveKey': return manager.saveKey(id, payload.key);
      case 'removeKey': return manager.removeKey(id);
      case 'importKey': return manager.importKey(id);
      case 'openKeyPage': return shell.openExternal('https://platform.plutonium.pw/serverkeys/');
      case 'openEngineGuide': return shell.openExternal(engineGuides[profileFor(id).id]);
      case 'openConfig': {
        const profile = profileFor(id);
        const gamePath = await manager.gamePath(id);
        if (!gamePath) throw new Error('Game folder not found.');
        const error = await shell.openPath(path.join(gamePath, profile.config));
        if (error) throw new Error(error);
        return true;
      }
      default: throw new Error('Unknown action.');
    }
  });
  createWindow().catch(error => { dialog.showErrorBox('botLANd could not start', error.message); app.quit(); });
});

function requestQuit() {
  if (stoppingForQuit) return;
  const options = {
    type: 'warning', buttons: ['Keep app open', 'Stop servers and exit'], defaultId: 0, cancelId: 0,
    title: 'Servers are still running', message: 'Stop your managed servers before closing botLANd?',
    detail: 'Stopping a server ends its current game session. Only processes started by this app will be targeted.',
  };
  const result = window && !window.isDestroyed() ? dialog.showMessageBoxSync(window, options) : dialog.showMessageBoxSync(options);
  if (result !== 1) return;
  stoppingForQuit = true;
  manager.stopAll().then(() => {
    stoppingForQuit = false;
    if (manager.hasRunning()) {
      dialog.showErrorBox('Servers still running', 'A managed server could not be stopped. The app will remain open so you can try again.');
    } else { quitAfterStop = true; app.quit(); }
  }).catch(error => { stoppingForQuit = false; dialog.showErrorBox('Could not close', error.message); });
}
app.on('before-quit', event => {
  if (quitAfterStop) return;
  if (stoppingForQuit) { event.preventDefault(); return; }
  if (!manager?.hasRunning()) return;
  event.preventDefault();
  requestQuit();
});
app.on('window-all-closed', () => app.quit());
