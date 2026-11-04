const { contextBridge, ipcRenderer } = require('electron');

/** @param {string} action @param {Record<string, unknown>} [payload] */
const invoke = (action, payload) => ipcRenderer.invoke('manager:action', action, payload);
contextBridge.exposeInMainWorld('manager', {
  snapshot: () => invoke('snapshot'),
  maps: (id) => invoke('maps', { id }),
  start: (id) => invoke('start', { id }),
  stop: (id) => invoke('stop', { id }),
  chooseFolder: (id) => invoke('chooseFolder', { id }),
  chooseRoot: () => invoke('chooseRoot'),
  rescanInstallations: () => invoke('rescanInstallations'),
  createStarterConfig: (id) => invoke('createStarterConfig', { id }),
  botStatus: (id) => invoke('botStatus', { id }),
  botAction: (id, operation, versionId) => invoke('botAction', { id, operation, versionId }),
  setBotChannel: (id, channel) => invoke('setBotChannel', { id, channel }),
  checkBotUpdates: () => invoke('checkBotUpdates'),
  setUpdateChecks: (enabled) => invoke('setUpdateChecks', { enabled }),
  saveKey: (id, key) => invoke('saveKey', { id, key }),
  removeKey: (id) => invoke('removeKey', { id }),
  importKey: (id) => invoke('importKey', { id }),
  openKeyPage: () => invoke('openKeyPage'),
  openEngineGuide: (id) => invoke('openEngineGuide', { id }),
  document: (id, target, mode) => invoke('document', { id, target, mode }),
  previewSettings: (id, target, mode, values, expectedPath) => invoke('previewSettings', { id, target, mode, values, expectedPath }),
  commitSettings: (id, target, mode, values, token, expectedPath) => invoke('commitSettings', { id, target, mode, values, token, expectedPath }),
  artwork: (id, kind) => invoke('artwork', { id, kind }),
  firewallStatus: (id) => invoke('firewallStatus', { id }),
  firewallApply: (id) => invoke('firewallApply', { id }),
  firewallRemove: (id) => invoke('firewallRemove', { id }),
  openDocs: (id) => invoke('openDocs', { id }),
  chooseArtwork: (id, kind) => invoke('chooseArtwork', { id, kind }),
  resetArtwork: (id, kind) => invoke('resetArtwork', { id, kind }),
  openDocument: (id, target, mode) => invoke('openDocument', { id, target, mode }),
  saveOptions: (id, values) => invoke('saveOptions', { id, values }),
  openConfig: (id) => invoke('openConfig', { id }),
  subscribe: (listener) => {
    if (typeof listener !== 'function') return () => {};
    const handler = (_event, data) => listener(data);
    ipcRenderer.on('manager:event', handler);
    return () => ipcRenderer.removeListener('manager:event', handler);
  },
});
