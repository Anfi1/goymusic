/// <reference types="vite/client" />

declare module "*.module.css" {
  const classes: { [key: string]: string };
  export default classes;
}

interface Window {
  bridge: {
    ping: () => Promise<string>;
    pyCall: (command: string, args?: any) => Promise<any>;
    pyCancel: (callId: string) => Promise<void>;
    onPyEvent: (callback: (event: any) => void) => () => void;
    openExternal: (url: string) => Promise<void>;
    authStart: () => Promise<any>;
    winMinimize: () => void;
    winMaximize: () => void;
    winFullscreen: () => void;
    winClose: () => void;
    onWindowState: (callback: (state: { isMaximized: boolean, isFullScreen: boolean }) => void) => () => void;
    onFocusChanged: (callback: (focused: boolean) => void) => () => void;
    setRPC: (data: {
      title: string;
      artist: string;
      isPlaying: boolean;
      thumbUrl?: string;
      duration?: number;
      currentTime?: number;
    }) => void;
    clearRPC: () => void;
    openLogs: () => Promise<void>;
    clearCache: () => Promise<any>;
    getSongsPath: () => Promise<string>;
    setSongsPath: (path: string) => Promise<any>;
    songFileExists: (filename: string) => Promise<boolean>;
    getSongFileUrl: (filename: string) => Promise<string>;
    openSongsFolder: (filename?: string) => Promise<any>;
    pickSongsFolder: () => Promise<string | null>;
    deleteSongFile: (filename: string) => Promise<any>;
    importSongFile: () => Promise<any>;
    checkForUpdates: () => Promise<{ version: string } | null>;
    downloadUpdate: () => Promise<void>;
    installUpdate: () => Promise<void>;
    onUpdateAvailable: (callback: (info: { version: string; releaseNotes?: any }) => void) => () => void;
    onUpdateProgress: (callback: (progress: { percent: number; speed: number; transferred: number; total: number }) => void) => () => void;
    onUpdateDownloaded: (callback: () => void) => () => void;
    onUpdateError: (callback: (err: { message: string }) => void) => () => void;
    onDeepLink: (callback: (url: string) => void) => () => void;
  }
}
