const path = require('node:path');
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, nativeImage, protocol, safeStorage, session, shell } = require('electron');
const { ServerManager } = require('./manager.cjs');
const { KeyStore } = require('./key-store.cjs');
const { BotWarfareSource } = require('./botwarfare-source.cjs');
const { BotWarfareInstaller } = require('./botwarfare-install.cjs');
const { SessionLogs } = require('./session-logs.cjs');
const { PlutoniumUpdater } = require('./plutonium-update.cjs');
const { EngineUpdater } = require('./engine-update.cjs');
const { discoverConnectAddresses } = require('./connect-address.cjs');
const { formatDiagnostics } = require('./diagnostics.cjs');
const { profileFor } = require('./profiles.cjs');
const { sourceRepos } = require('./schema.cjs');
const { ArtworkCache } = require('./artwork-cache.cjs');
const { artScheme, createArtworkHandler } = require('./artwork-protocol.cjs');
const { rendererScheme, rendererEntryUrl, rendererSchemeRegistration, createRendererHandler } = require('./renderer-protocol.cjs');
const { validatePayload } = require('./ipc-validate.cjs');

const engineGuides = {
  cod4: 'https://iw3x.com/setup#hosting',
  mw2: 'https://github.com/iw4x/launcher#readme',
  waw: 'https://plutonium.pw/docs/server/t4/setting-up-a-server/',
  bo1: 'https://plutonium.pw/docs/server/t5/setting-up-a-server/',
  mw3: 'https://plutonium.pw/docs/server/iw5/setting-up-a-server/',
  bo2: 'https://plutonium.pw/docs/server/t6/setting-up-a-server/',
};

// Serve the built renderer from a real origin instead of file://. This is what
// lets the packaged build disable `grantFileProtocolExtraPrivileges`, and it
// keeps the page out of file://'s broad read access.
if (typeof protocol?.registerSchemesAsPrivileged === 'function') {
  protocol.registerSchemesAsPrivileged([
    rendererSchemeRegistration,
    // Artwork is user-owned content, so it gets its own origin. The handler
    // resolves only known game/kind pairs; no URL text becomes a file path.
    { scheme: artScheme, privileges: { standard: true, secure: true } },
  ]);
}

const serveRenderer = createRendererHandler();


// Downscale JPEG/WebP banners for the renderer. PNG keeps its alpha channel and
// is only re-encoded when the source is much wider than the display size.
function encodeArtwork(buffer, { mime, width }) {
  try {
    const image = nativeImage.createFromBuffer(buffer);
    if (image.isEmpty()) return null;
    const size = image.getSize();
    if (!size.width || size.width <= width) return null;
    const resized = image.resize({ width, quality: 'good' });
    if (mime === 'image/png') {
      const png = resized.toPNG();
      return png.length ? { body: png, mime: 'image/png' } : null;
    }
    const jpeg = resized.toJPEG(82);
    return jpeg.length ? { body: jpeg, mime: 'image/jpeg' } : null;
  } catch { return null; }
}
const artworkCache = new ArtworkCache({ encode: encodeArtwork });
const serveArtwork = createArtworkHandler({ getManager: () => manager, cache: artworkCache });
/** @type {import('electron').BrowserWindow | undefined} */
let window;
/** @type {ServerManager | undefined} */
let manager;
let quitAfterStop = false;
let stoppingForQuit = false;
// The renderer reports unsaved configuration or rotation drafts, so a quit can
// ask about them once, before any server is stopped.
let rendererDirty = false;
let discardConfirmed = false;

async function migrateSettings() {
  // The product name controls Electron's userData folder. Preserve existing
  // preferences, saved keys and update metadata when upgrading from the
  // previous capitalization of the app. Losing keys.json would force every
  // Plutonium title to be set up again even though DPAPI can still read it.
  const oldRoot = path.join(app.getPath('appData'), 'BotLANd Server Manager');
  const newRoot = app.getPath('userData');
  if (oldRoot.toLowerCase() === newRoot.toLowerCase()) return;
  await fs.mkdir(newRoot, { recursive: true });
  for (const name of ['settings.json', 'keys.json', 'botwarfare-sources.json']) {
    try { await fs.copyFile(path.join(oldRoot, name), path.join(newRoot, name), constants.COPYFILE_EXCL); }
    catch (error) { if (!['ENOENT', 'EEXIST'].includes(error.code)) throw error; }
  }
}

async function createWindow() {
  await migrateSettings();
  const modSource = new BotWarfareSource({ userData: app.getPath('userData') });
  const modInstaller = new BotWarfareInstaller({ source: modSource, localAppData: process.env.LOCALAPPDATA,
    isRunning: id => manager?.instances.get(id) || false });
  manager = new ServerManager(path.join(app.getPath('userData'), 'settings.json'), data => {
    // Server output can arrive while the renderer is reloading or gone; sending to a
    // disposed frame throws and must not crash the main process or end a stream handler.
    try { if (window && !window.isDestroyed()) window.webContents.send('manager:event', data); } catch { /* Renderer unavailable. */ }
  }, { keyStore: new KeyStore(path.join(app.getPath('userData'), 'keys.json'), safeStorage),
    modSource, modInstaller, sessionLogs: new SessionLogs({ userData: app.getPath('userData') }),
    plutonium: new PlutoniumUpdater({ userData: app.getPath('userData') }),
    engineUpdater: new EngineUpdater({ userData: app.getPath('userData'), confirmOverwrite: async (id, file) => {
      if (!window || window.isDestroyed()) return false;
      const { response } = await dialog.showMessageBox(window, {
        type: 'warning', buttons: ['Keep existing file', 'Replace and continue'], defaultId: 0, cancelId: 0,
        title: `Replace existing ${profileFor(id).short} engine file?`,
        message: `Replace ${path.basename(file)} in your game folder?`,
        detail: 'This file was not installed by botLANd. Its original bytes are kept only while this update runs. The IW4x launcher may also replace other files it manages; back up any custom engine files first.',
      });
      return response === 1;
    } }) });
  const recoveredSettings = await manager.initialize();
  await manager.rescanInstallations();
  window = new BrowserWindow({
    width: 1380, height: 860, minWidth: 640, minHeight: 600,
    backgroundColor: '#1B1A19', autoHideMenuBar: true, show: false,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.once('ready-to-show', () => window.show());
  window.on('close', event => {
    if (quitAfterStop) return;
    if (stoppingForQuit || quitPromptOpen) { event.preventDefault(); return; }
    if (!needsQuitPrompt()) return;
    event.preventDefault();
    requestQuit();
  });
  // Windows sign-out or shutdown: there is no time for dialogs, so stop owned
  // servers (Cod4R gets its graceful quit first) and close session logs.
  window.on('session-end', () => {
    discardConfirmed = true;
    if (!stoppingForQuit) finishQuit();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-redirect', event => { if (!isAppOrigin(event?.url)) event.preventDefault(); });
  window.webContents.on('will-frame-navigate', event => { if (!isAppOrigin(event?.url)) event.preventDefault(); });
  // Ctrl+Plus/Minus/0 used to depend on the application menu, which is removed
  // from releases. Keep keyboard text zoom without restoring Reload/DevTools.
  const setZoom = delta => {
    if (!window || window.isDestroyed()) return;
    const current = window.webContents.getZoomFactor();
    const next = delta === 0 ? 1 : Math.min(3, Math.max(0.5, Math.round((current + delta) * 100) / 100));
    window.webContents.setZoomFactor(next);
  };
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.alt || !(input.control || input.meta)) return;
    if (input.key === '+' || input.key === '=' || input.key === 'Add') { event.preventDefault(); setZoom(0.1); }
    else if (input.key === '-' || input.key === 'Subtract') { event.preventDefault(); setZoom(-0.1); }
    else if (input.key === '0') { event.preventDefault(); setZoom(0); }
  });
  window.webContents.on('will-prevent-unload', event => {
    // The quit prompt already covered the unsaved drafts.
    if (discardConfirmed) { event.preventDefault(); return; }
    // Stays synchronous: Electron decides the unload as soon as this handler
    // returns, so preventDefault cannot be deferred until an async dialog resolves.
    const choice = dialog.showMessageBoxSync(window, {
      type: 'warning', buttons: ['Keep editing', 'Discard changes'], defaultId: 0, cancelId: 0,
      title: 'Unsaved changes', message: 'Discard your unsaved changes?',
      detail: 'Your configuration or rotation edits have not been saved.',
    });
    if (choice === 1) { event.preventDefault(); return; }
    // A quit that was waiting on this dialog must not bypass the running-server
    // check if the user keeps editing and later starts another server, and a
    // shutdown begun for that quit must not keep blocking Start.
    quitAfterStop = false;
    manager?.cancelShutdown?.();
  });
  if (app.isPackaged) Menu.setApplicationMenu(null); // No Reload or DevTools shortcuts in releases.
  if (typeof protocol?.handle === 'function') protocol.handle(rendererScheme, serveRenderer);
  if (typeof protocol?.handle === 'function') protocol.handle(artScheme, serveArtwork);
  if (app.isPackaged) await window.loadURL(rendererEntryUrl);
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

// The only origin app content may load from: app://botland when packaged, the
// Vite dev server otherwise.
function isAppOrigin(url) {
  if (typeof url !== 'string') return false;
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  const expected = new URL(app.isPackaged ? rendererEntryUrl : 'http://127.0.0.1:5173');
  return parsed.protocol === expected.protocol && parsed.host === expected.host;
}

// Defense in depth for any webContents (including ones not created here):
// no <webview>, no popups, no off-origin navigation.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.setWindowOpenHandler?.(() => ({ action: 'deny' }));
  contents.on('will-navigate', event => { if (!isAppOrigin(event?.url)) event.preventDefault(); });
  contents.on('will-redirect', event => { if (!isAppOrigin(event?.url)) event.preventDefault(); });
});

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
    validatePayload(action, payload);
    const id = payload.id;
    switch (action) {
      case 'snapshot': return manager.snapshot();
      case 'setUnsavedChanges': {
        if (typeof payload.dirty !== 'boolean') throw new Error('Invalid unsaved-changes state.');
        rendererDirty = payload.dirty;
        return true;
      }
      case 'copyDiagnostics': {
        clipboard.writeText(formatDiagnostics(await manager.snapshot(), app.getVersion(), process.platform, process.arch));
        return true;
      }
      case 'copyText': {
        if (typeof payload.text !== 'string' || payload.text.length > 200_000) throw new Error('Invalid text to copy.');
        clipboard.writeText(payload.text);
        return true;
      }
      case 'openLogs': {
        const directory = path.join(app.getPath('userData'), 'session-logs');
        await fs.mkdir(directory, { recursive: true });
        const error = await shell.openPath(directory);
        if (error) throw new Error(error);
        return true;
      }
      case 'getLogs': profileFor(id); return manager.getLogs(id);
      case 'maps': return manager.maps(id);
      case 'start': return manager.start(id);
      case 'stop': return manager.stop(id);
      case 'setAutoRestart': return manager.setAutoRestart(id, payload.enabled);
      case 'rescanOrphans': return manager.rescanOrphans();
      case 'copyConnectAddress': {
        profileFor(id);
        if (typeof payload.address !== 'string') throw new Error('Invalid connect address.');
        if (manager.instances.get(id)?.status !== 'running') throw new Error('Start this server before copying its address.');
        const port = manager.instances.get(id).activePort;
        const connect = discoverConnectAddresses(port, manager.networkInterfaces);
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
      case 'rescanInstallations': return manager.rescanInstallations();
      case 'useDetectedFolder': return manager.useDetectedFolder(id);
      case 'createStarterConfig': return manager.createStarterConfig(id);
      case 'botStatus': return manager.botStatus(id);
      case 'botAction': return manager.botAction(id, payload.operation);
      case 'setBotChannel': return manager.setBotChannel(id, payload.channel);
      case 'checkBotUpdates': return manager.checkBotUpdates(true);
      case 'setLocale': {
        if (typeof payload.locale !== 'string' || payload.locale.length > 20) throw new Error('Invalid interface language.');
        return manager.setLocale(payload.locale);
      }
      case 'setUpdateChecks': return manager.setUpdateChecks(payload.enabled);
      case 'saveKey': return manager.saveKey(id, payload.key);
      case 'removeKey': return manager.removeKey(id);
      case 'resetKeyStore': return manager.resetKeyStore();
      case 'updatePlutonium': return manager.updatePlutonium();
      case 'updateEngine': {
        if (id !== 'cod4' && id !== 'mw2') throw new Error('Unsupported engine update.');
        return manager.updateEngine(id);
      }
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

function needsQuitPrompt() { return Boolean(manager?.hasRunning() || manager?.hasModWork?.()); }
// Async message boxes keep the main process (IPC, log tails, server output)
// responsive while a quit prompt is open. quitPromptOpen stops a second close
// or before-quit from stacking another prompt or slipping past the first one.
let quitPromptOpen = false;
async function showBox(options) {
  quitPromptOpen = true;
  try {
    const { response } = window && !window.isDestroyed() ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
    return response;
  } finally { quitPromptOpen = false; }
}
function showInstallerBusy() {
  // Quitting mid-install would leave files for the next launch to recover.
  const plutonium = Boolean(manager?.plutonium?.updating);
  const engine = Boolean(manager?.engineBusy?.size);
  return showBox({
    type: 'info', buttons: ['OK'], defaultId: 0, cancelId: 0,
    title: plutonium ? 'Plutonium update in progress' : engine ? 'Engine update in progress' : 'Bot Warfare change in progress',
    message: plutonium ? 'Wait for the Plutonium update to finish before closing botLANd.' : engine ? 'Wait for the engine update to finish before closing botLANd.' : 'Wait for the Bot Warfare change to finish before closing botLANd.',
    detail: plutonium ? 'Closing now could leave Plutonium half-updated.' : engine ? 'Closing now could leave engine files or the IW4x launcher update incomplete.' : 'Closing now could leave the mod files half-updated. The change usually takes less than a minute.',
  });
}
async function finishQuit() {
  stoppingForQuit = true;
  try {
    // stopAll owns the shutdown guard and waits for launch preparation as well
    // as process termination. A disappearing instance can still have a log tail
    // or session close in flight, so drain that queue before the final check.
    await manager?.stopAll?.();
    await manager?.waitForSessionCleanup?.();
    if (manager?.hasModWork?.()) {
      stoppingForQuit = false;
      discardConfirmed = false;
      manager.cancelShutdown?.();
      showInstallerBusy().catch(() => {});
      return;
    }
    if (manager?.hasRunning()) {
      stoppingForQuit = false;
      discardConfirmed = false;
      manager.cancelShutdown?.();
      dialog.showErrorBox('Servers still running', 'A managed server could not be stopped. The app will remain open so you can try again.');
      return;
    }
    stoppingForQuit = false;
    quitAfterStop = true;
    app.quit();
  } catch (error) {
    stoppingForQuit = false;
    discardConfirmed = false;
    manager?.cancelShutdown?.();
    dialog.showErrorBox('Could not close', error.message);
  }
}
async function requestQuit() {
  if (stoppingForQuit || quitPromptOpen) return;
  if (manager?.hasModWork?.()) { await showInstallerBusy().catch(() => {}); return; }
  let result;
  try {
    result = await showBox({
    type: 'warning', buttons: ['Keep app open', 'Stop servers and exit'], defaultId: 0, cancelId: 0,
    title: 'Servers are still running', message: 'Stop your managed servers before closing botLANd?',
    detail: 'Stopping a server ends its current game session. Only processes started by this app will be targeted.'
      + (rendererDirty ? '\n\nYour unsaved configuration or rotation edits will also be discarded.' : ''),
    });
  } catch { return; }
  if (result !== 1 || stoppingForQuit) return;
  discardConfirmed = true;
  await finishQuit();
}
app.on('before-quit', event => {
  if (stoppingForQuit || quitPromptOpen) { event.preventDefault(); return; }
  // Do not let a prior confirmation bypass installer work or cleanup which
  // appeared while a stop, disk-log close, or native unload prompt was pending.
  if (quitAfterStop) {
    if (!needsQuitPrompt() && !manager?.hasPendingSessionCleanup?.()) return;
    quitAfterStop = false;
    discardConfirmed = false;
    manager?.cancelShutdown?.();
  }
  if (!needsQuitPrompt()) {
    if (!manager) return;
    // Even an apparently idle quit reserves the manager's shutdown guard.
    // Otherwise an IPC installer/launch could start during the native unsaved
    // draft prompt, after this initial no-work observation.
    event.preventDefault();
    finishQuit();
    return;
  }
  event.preventDefault();
  requestQuit();
});
app.on('window-all-closed', () => app.quit());
