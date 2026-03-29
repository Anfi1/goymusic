import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('bridge', {
  ping: () => ipcRenderer.invoke('ping'),
  pyCall: (command: string, args?: any) => ipcRenderer.invoke('py:call', command, args),
  pyCancel: (callId: string) => ipcRenderer.invoke('py:cancel', callId),
  onPyEvent: (callback: (msg: any) => void) => {
    const listener = (_e: any, msg: any) => callback(msg);
    ipcRenderer.on('py:event', listener);
    return () => ipcRenderer.removeListener('py:event', listener);
  },
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  authStart: () => ipcRenderer.invoke('auth:start'),
  winMinimize: () => ipcRenderer.send('win:minimize'),
  winMaximize: () => ipcRenderer.send('win:maximize'),
  winFullscreen: () => ipcRenderer.send('win:fullscreen'),
  winClose: () => ipcRenderer.send('win:close'),
  onWindowState: (callback: (state: { isMaximized: boolean, isFullScreen: boolean }) => void) => {
    const listener = (e: any, state: any) => callback(state);
    ipcRenderer.on('win:state-changed', listener);
    return () => ipcRenderer.removeListener('win:state-changed', listener);
  },
  onFocusChanged: (callback: (focused: boolean) => void) => {
    const listener = (e: any, focused: boolean) => callback(focused);
    ipcRenderer.on('win:focus-changed', listener);
    return () => ipcRenderer.removeListener('win:focus-changed', listener);
  },
  setRPC: (data: any) => ipcRenderer.send('rpc:set', data),
  clearRPC: () => ipcRenderer.send('rpc:clear'),
  openLogs: () => ipcRenderer.invoke('open-logs'),
  clearCache: () => ipcRenderer.invoke('app:clear-cache'),
  getSongsPath: () => ipcRenderer.invoke('songs:get-path'),
  setSongsPath: (path: string) => ipcRenderer.invoke('songs:set-path', path),
  getSongFileUrl: (filename: string) => ipcRenderer.invoke('songs:get-file-url', filename),
  openSongsFolder: (filename?: string) => ipcRenderer.invoke('songs:open-folder', filename),
  pickSongsFolder: () => ipcRenderer.invoke('songs:pick-folder'),
  deleteSongFile: (filename: string) => ipcRenderer.invoke('songs:delete-file', filename),
  importSongFile: () => ipcRenderer.invoke('songs:import-file'),

  // Auto-updater
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateAvailable: (callback: (info: any) => void) => {
    const listener = (_e: any, info: any) => callback(info);
    ipcRenderer.on('update:available', listener);
    return () => ipcRenderer.removeListener('update:available', listener);
  },
  onUpdateProgress: (callback: (progress: any) => void) => {
    const listener = (_e: any, progress: any) => callback(progress);
    ipcRenderer.on('update:progress', listener);
    return () => ipcRenderer.removeListener('update:progress', listener);
  },
  onUpdateDownloaded: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('update:downloaded', listener);
    return () => ipcRenderer.removeListener('update:downloaded', listener);
  },
  onUpdateError: (callback: (err: any) => void) => {
    const listener = (_e: any, err: any) => callback(err);
    ipcRenderer.on('update:error', listener);
    return () => ipcRenderer.removeListener('update:error', listener);
  },
})
