const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (fn) => {
  const handler = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('kesit', {
  info: () => ipcRenderer.invoke('app:info'),
  state: () => ipcRenderer.invoke('server:state'),
  start: () => ipcRenderer.invoke('server:start'),
  stop: () => ipcRenderer.invoke('server:stop'),
  restart: () => ipcRenderer.invoke('server:restart'),
  logs: () => ipcRenderer.invoke('server:logs'),
  clearLogs: () => ipcRenderer.invoke('server:clearLogs'),
  openWeb: () => ipcRenderer.invoke('open:web'),
  openData: () => ipcRenderer.invoke('open:data'),
  openLogFile: () => ipcRenderer.invoke('open:logFile'),
  openExternal: (url) => ipcRenderer.invoke('open:external', url),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  chooseDataDir: () => ipcRenderer.invoke('settings:chooseDataDir'),
  updateState: () => ipcRenderer.invoke('update:state'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onLog: on('server:log'),
  onState: on('server:state'),
  onUpdate: on('update:state'),
});
