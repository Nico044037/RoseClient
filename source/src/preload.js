const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rose', {
  appInfo: () => ipcRenderer.invoke('app:info'),
  authStatus: () => ipcRenderer.invoke('auth:status'),
  authLogout: () => ipcRenderer.invoke('auth:logout'),
  listInstances: () => ipcRenderer.invoke('instances:list'),
  createInstance: data => ipcRenderer.invoke('instances:create', data),
  importMrpack: () => ipcRenderer.invoke('instances:importMrpack'),
  importModrinthProfiles: () => ipcRenderer.invoke('instances:importModrinthProfiles'),
  selectInstance: id => ipcRenderer.invoke('instances:select', id),
  repairRoseMod: id => ipcRenderer.invoke('instances:repairRoseMod', id),
  searchMods: data => ipcRenderer.invoke('modrinth:search', data),
  listMods: instanceId => ipcRenderer.invoke('mods:list', instanceId),
  installMod: data => ipcRenderer.invoke('modrinth:install', data),
  startGame: instanceId => ipcRenderer.invoke('game:start', instanceId),
  gameStatus: instanceId => ipcRenderer.invoke('game:status', instanceId),
  stopGame: instanceId => ipcRenderer.invoke('game:stop', instanceId),
  openPath: path => ipcRenderer.invoke('shell:openPath', path),
  getLogs: () => ipcRenderer.invoke('logs:get'),
  clearLogs: () => ipcRenderer.invoke('logs:clear'),
  openLogFile: () => ipcRenderer.invoke('logs:openFile'),
  onLogEntry: callback => { const listener = (_event, entry) => callback(entry); ipcRenderer.on('logs:entry', listener); return () => ipcRenderer.removeListener('logs:entry', listener); },
  onLogsCleared: callback => { const listener = () => callback(); ipcRenderer.on('logs:cleared', listener); return () => ipcRenderer.removeListener('logs:cleared', listener); }
});