import { app, BrowserWindow, ipcMain, shell, session, screen, dialog } from 'electron'
import { join, dirname } from 'path'
import { pathToFileURL } from 'url'
import { spawn, ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { writeFileSync, appendFileSync, existsSync, mkdirSync, readFileSync, copyFileSync, unlinkSync } from 'fs'
import * as DiscordRPC from 'discord-rpc'
import { autoUpdater } from 'electron-updater'

process.env.DIST = join(__dirname, '../dist')
process.env.PUBLIC = app.isPackaged ? process.env.DIST : join(__dirname, '../public')

let win: BrowserWindow | null
let pyProc: ChildProcess | null
let logPath: string = '';

function logToFile(msg: string) {
  const timestamp = new Date().toISOString();
  const logMsg = `[${timestamp}] ${msg}\n`;
  console.log(msg);
  try {
    if (logPath) appendFileSync(logPath, logMsg);
  } catch (e) {
    // Fallback to console if file is not writable
  }
}

// Optimization flags for lower memory and CPU usage
app.commandLine.appendSwitch('enable-features', 'CalculateNativeWinOcclusion,IntensiveWakeUpThrottling,AutomaticTabDiscarding');
app.commandLine.appendSwitch('disable-site-isolation-trials');
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=256 --expose-gc --max-semi-space-size=64'); 

// Periodic memory cleanup
setInterval(() => {
  if (win) {
    session.defaultSession.clearCache();
    // Force V8 GC if exposed
    win.webContents.executeJavaScript('window.gc && window.gc()').catch(() => {});
  }
}, 1000 * 60 * 5); // Every 5 minutes

// Single Instance Lock
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
    const url = argv.find(arg => arg.startsWith('goymusic://'))
    if (url) handleDeepLink(url)
  })

  app.whenReady().then(() => {
    // True portable logs: next to the executable/resources
    const root = getAppRoot();
    logPath = join(root, 'app.log');
    
    // Clear log on start
    try { writeFileSync(logPath, ''); } catch(e) {}

    logToFile(`App starting... Version: ${app.getVersion()}`);
    logToFile(`Platform: ${process.platform}, Arch: ${process.arch}`);
    logToFile(`Packaged: ${app.isPackaged}`);
    logToFile(`AppData: ${app.getPath('userData')}`);

    migrateUserData()

    // В dev-режиме нужно явно передать путь к скрипту, иначе Electron
    // получит URL как первый аргумент и попытается загрузить его как модуль
    // Регистрация протокола только в packaged-сборке.
    // В dev-режиме (vite) setAsDefaultProtocolClient работает некорректно —
    // протокол тестируется через npm run dist.
    if (app.isPackaged) {
      app.setAsDefaultProtocolClient('goymusic')
    }

    createPyProc()
    createWindow()
    initRPC()
    initAutoUpdater()

    // Открытие по протоколу при холодном старте (приложение не было запущено)
    const startUrl = process.argv.find(arg => arg.startsWith('goymusic://'))
    if (startUrl) {
      win?.webContents.once('did-finish-load', () => handleDeepLink(startUrl))
    }
  })
}

function handleDeepLink(url: string) {
  if (!win || !url.startsWith('goymusic://')) return
  win.webContents.send('deep-link', url)
  if (win.isMinimized()) win.restore()
  win.focus()
}

function getAppRoot() {
  return app.isPackaged ? process.resourcesPath : process.cwd();
}

function getUserDataDir() {
  return app.getPath('userData');
}

function migrateUserData() {
  if (!app.isPackaged) return;
  const oldRoot = getAppRoot();
  const newRoot = getUserDataDir();
  const filesToMigrate = ['browser.json', 'window-config.json'];

  for (const file of filesToMigrate) {
    const oldPath = join(oldRoot, file);
    const newPath = join(newRoot, file);
    if (existsSync(oldPath) && !existsSync(newPath)) {
      try {
        copyFileSync(oldPath, newPath);
        unlinkSync(oldPath);
        logToFile(`Migrated ${file} to ${newRoot}`);
      } catch (e) {
        logToFile(`Failed to migrate ${file}: ${e}`);
      }
    }
  }
}

// Discord RPC
const clientId = '985877044523044885'
let rpc: DiscordRPC.Client | null = null
let rpcRetryTimeout: NodeJS.Timeout | null = null

function initRPC() {
  if (rpc) return

  logToFile('Attempting to connect to Discord RPC...')
  rpc = new DiscordRPC.Client({ transport: 'ipc' })
  
  rpc.on('ready', () => {
    logToFile('Discord RPC ready')
    if (rpcRetryTimeout) {
      clearTimeout(rpcRetryTimeout)
      rpcRetryTimeout = null
    }
  })

  rpc.on('disconnected', () => {
    logToFile('Discord RPC disconnected')
    rpc = null
    scheduleRPCRetry()
  })

  rpc.login({ clientId }).catch((err: any) => {
    logToFile(`Failed to connect to Discord RPC: ${err.message || err}`);
    rpc = null
    scheduleRPCRetry()
  })
}

function scheduleRPCRetry() {
  if (rpcRetryTimeout) return
  logToFile('Scheduling Discord RPC reconnection in 120 seconds...')
  rpcRetryTimeout = setTimeout(() => {
    rpcRetryTimeout = null
    initRPC()
  }, 120000) // Increased to 120 seconds to minimize idle activity
}

// Central dispatcher for Python responses
const pendingCalls = new Map<string, { resolve: Function, reject: Function, timeout: NodeJS.Timeout }>()

function createPyProc() {
  const isPackaged = app.isPackaged
  const root = getAppRoot();
  const scriptPath = join(root, 'python', 'api.py')
  
  // Priority: Bundled portable Python -> Venv -> System Python
  const bundledPython = join(root, 'python', 'bin', 'python.exe')
  const venvPython = join(root, 'venv', 'Scripts', 'python.exe')
  const candidates = [bundledPython, venvPython, 'python', 'python3', 'py'];
  
  logToFile(`Searching for Python interpreter...`);
  logToFile(`Bundled path: ${bundledPython} (exists: ${existsSync(bundledPython)})`);
  logToFile(`Script Path: ${scriptPath}`);

  tryNextPython(candidates, 0, scriptPath, root);
}

function tryNextPython(candidates: string[], index: number, scriptPath: string, root: string) {
  if (index >= candidates.length) {
    logToFile(`ERROR: Could not start Python with any of the candidates.`);
    win?.webContents.send('py:event', { 
      event: 'backend_dead', 
      code: -1, 
      error: 'Python not found. Please install Python 3.13 and add it to PATH.' 
    });
    return;
  }

  const pyPath = candidates[index];
  logToFile(`Attempting to start Python using: ${pyPath}`);

  try {
    const proc = spawn(pyPath, [scriptPath], {
      cwd: root,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        PYTHONIOENCODING: 'utf-8',
        GOYMUSIC_USER_DATA: getUserDataDir()
      }
    });

    // We need to check if it actually started
    proc.on('error', (err: any) => {
      logToFile(`Failed to start with ${pyPath}: ${err.message}`);
      if (!pyProc) { // If we haven't successfully started yet
        tryNextPython(candidates, index + 1, scriptPath, root);
      }
    });

    // If no error within 500ms, assume it's working
    const startTimeout = setTimeout(() => {
      if (!pyProc) {
        pyProc = proc;
        logToFile(`Successfully started Python with: ${pyPath}`);
        setupPyHandlers(pyPath);
      }
    }, 500);

    proc.on('spawn', () => {
      // Modern node versions support this
      clearTimeout(startTimeout);
      if (!pyProc) {
        pyProc = proc;
        logToFile(`Python process spawned successfully: ${pyPath}`);
        setupPyHandlers(pyPath);
      }
    });

  } catch (e: any) {
    logToFile(`Exception while starting ${pyPath}: ${e.message}`);
    tryNextPython(candidates, index + 1, scriptPath, root);
  }
}

function setupPyHandlers(usedPath: string) {
  if (!pyProc) return;

  let buffer = ''
  pyProc.stdout?.on('data', (data) => {
    const str = data.toString();
    buffer += str;
    let lines = buffer.split('\n')
    buffer = lines.pop() || ''
    
    for (const line of lines) {
    if (!line.trim()) continue
    try {
    const msg = JSON.parse(line.trim())

    // If it's an event, always send it to the frontend
    if (msg.event) {
      win?.webContents.send('py:event', msg)
    }

    // Only resolve the call if it has a callId AND is NOT an event
    // Events are intermediate messages and shouldn't resolve the primary call
    if (msg.callId && !msg.event && pendingCalls.has(msg.callId)) {
      const { resolve, timeout } = pendingCalls.get(msg.callId)!
      clearTimeout(timeout)
      pendingCalls.delete(msg.callId)
      resolve(msg)
    }
    } catch (e) {
    logToFile(`Python stdout (${usedPath}): ${line}`);
    }
    }  })

  pyProc.stderr?.on('data', (data) => {
    logToFile(`Python: ${data.toString()}`);
  })

  pyProc.on('close', (code) => {
    logToFile(`Python process (${usedPath}) exited with code ${code}`);
    pyProc = null;
    win?.webContents.send('py:event', { event: 'backend_dead', code });
  })

  pyProc.on('error', (err) => {
    logToFile(`Process error (${usedPath}): ${err.message}`);
  })
}

function exitPyProc() {
  if (pyProc != null) {
    pyProc.kill()
    pyProc = null
  }
}

function initAutoUpdater() {
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', (info) => {
    logToFile(`Update available: ${info.version}`)
    win?.webContents.send('update:available', {
      version: info.version,
      releaseNotes: info.releaseNotes
    })
  })

  autoUpdater.on('update-not-available', () => {
    logToFile('No update available')
  })

  autoUpdater.on('download-progress', (progress) => {
    win?.webContents.send('update:progress', {
      percent: progress.percent,
      speed: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total
    })
  })

  autoUpdater.on('update-downloaded', () => {
    logToFile('Update downloaded, ready to install')
    win?.webContents.send('update:downloaded')
  })

  autoUpdater.on('error', (err) => {
    logToFile(`Auto-updater error: ${err.message}`)
    win?.webContents.send('update:error', { message: err.message })
  })

  const safeCheck = () => {
    autoUpdater.checkForUpdates().catch((err: any) => {
      logToFile(`Update check failed: ${err.message}`)
    })
  }

  setTimeout(safeCheck, 5000)
  setInterval(safeCheck, 60 * 60 * 1000)
}

function getWindowConfigPath() {
  return join(getUserDataDir(), 'window-config.json');
}

function readWindowConfig(): any {
  const p = getWindowConfigPath();
  try {
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    logToFile(`Failed to read window config: ${e}`);
  }
  return {};
}

function writeWindowConfig(cfg: any) {
  try {
    writeFileSync(getWindowConfigPath(), JSON.stringify(cfg));
  } catch (e) {
    logToFile(`Failed to write window config: ${e}`);
  }
}

function saveWindowConfig() {
  if (!win) return;
  try {
    const bounds = win.getBounds();
    const isMaximized = win.isMaximized();
    const prev = readWindowConfig();
    writeWindowConfig({ ...prev, ...bounds, isMaximized });
  } catch (e) {
    logToFile(`Failed to save window config: ${e}`);
  }
}

function createWindow() {
  let windowState = {
    x: undefined as number | undefined,
    y: undefined as number | undefined,
    width: 1024,
    height: 700,
    isMaximized: false
  };

  // Try to load saved state
  try {
    const configPath = getWindowConfigPath();
    if (existsSync(configPath)) {
      const saved = JSON.parse(require('fs').readFileSync(configPath, 'utf8'));
      windowState = { ...windowState, ...saved };
    } else {
      // Fallback to cursor position if no config
      const { x, y } = screen.getCursorScreenPoint();
      const currentDisplay = screen.getDisplayNearestPoint({ x, y });
      windowState.x = currentDisplay.bounds.x + (currentDisplay.bounds.width - windowState.width) / 2;
      windowState.y = currentDisplay.bounds.y + (currentDisplay.bounds.height - windowState.height) / 2;
    }
  } catch (e) {
    logToFile(`Error loading window config: ${e}`);
  }

  win = new BrowserWindow({
    x: windowState.x,
    y: windowState.y,
    width: windowState.width,
    height: windowState.height,
    minWidth: 1024,
    minHeight: 700,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#09090f', 
    icon: join(process.env.PUBLIC!, 'icon.png'),
    vibrancy: 'under-window', 
    backgroundMaterial: 'mica', 
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      webSecurity: false, 
      spellcheck: false, 
      backgroundThrottling: true,
      devTools: !app.isPackaged
    },
  })

  if (windowState.isMaximized) {
    win.maximize();
  }

  win.on('close', saveWindowConfig);
  win.on('focus', () => win?.webContents.send('win:focus-changed', true))
  win.on('blur', () => win?.webContents.send('win:focus-changed', false))

  // Filter for both imagery and video playback domains
  const filter = {
    urls: [
      '*://*.googleusercontent.com/*',
      '*://*.ggpht.com/*',
      '*://*.googlevideo.com/*'
    ]
  }

  // Handle outgoing headers
  session.defaultSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    details.requestHeaders['Referer'] = 'https://music.youtube.com/'
    details.requestHeaders['Origin'] = 'https://music.youtube.com'
    callback({ requestHeaders: details.requestHeaders })
  })

  // Handle incoming headers (Inject CORS)
  session.defaultSession.webRequest.onHeadersReceived(filter, (details, callback) => {
    const responseHeaders = details.responseHeaders || {}
    responseHeaders['Access-Control-Allow-Origin'] = ['*']
    responseHeaders['Access-Control-Allow-Methods'] = ['GET, POST, OPTIONS']
    responseHeaders['Access-Control-Allow-Headers'] = ['Content-Type, Range, Authorization']
    responseHeaders['Access-Control-Expose-Headers'] = ['Content-Length, Content-Range']
    callback({ responseHeaders })
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(join(process.env.DIST!, 'index.html'))
  }

  win.on('maximize', sendWindowState)
  win.on('unmaximize', sendWindowState)
  win.on('enter-full-screen', sendWindowState)
  win.on('leave-full-screen', sendWindowState)
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.on('will-quit', exitPyProc)
app.on('before-quit', exitPyProc)

// Auto-updater IPC handlers
ipcMain.handle('update:check', async () => {
  try {
    const result = await autoUpdater.checkForUpdates()
    return result ? { version: result.updateInfo.version } : null
  } catch (e: any) {
    logToFile(`Manual update check error: ${e.message}`)
    return null
  }
})

ipcMain.handle('update:download', async () => {
  await autoUpdater.downloadUpdate()
})

ipcMain.handle('update:install', async () => {
  exitPyProc()
  autoUpdater.quitAndInstall(true, true)
})

// RPC Update handler
ipcMain.on('rpc:set', (event, data) => {
  if (!rpc) return
  
  const { title, artist, isPlaying, thumbUrl, duration, currentTime } = data
  
  const presence: any = {
    details: title,
    state: `by ${artist}`,
    largeImageKey: thumbUrl || 'ytm',
    largeImageText: title,
    smallImageKey: isPlaying ? 'play' : 'pause',
    smallImageText: isPlaying ? 'Listening' : 'Paused',
    instance: false,
    type: 2, // LISTENING type
  }

  if (isPlaying && currentTime !== undefined) {
    const now = Date.now()
    // Show elapsed time (counting up)
    presence.startTimestamp = Math.floor(now - (currentTime * 1000))
  }

  rpc.setActivity(presence).catch(() => {
    // Silently fail if Discord closed
    rpc = null
  })
})

ipcMain.on('rpc:clear', () => {
  if (rpc) {
    rpc.clearActivity().catch(() => {
      rpc = null
    })
  }
})

// IPC bridge for Python
ipcMain.handle('py:call', async (event, command, args = {}) => {
  return new Promise((resolve, reject) => {
    if (!pyProc || !pyProc.stdin || !pyProc.stdout) {
      reject('Python process not available')
      return
    }

    const callId = (args as any).callId || randomUUID();

    const LONG_RUNNING = new Set(['yandex_import_streaming'])
    const timeoutMs = LONG_RUNNING.has(command) ? 7_200_000 : 300000 // 2h for import, 5min otherwise
    const timeout = setTimeout(() => {
      pendingCalls.delete(callId)
      reject(`Python call timeout: ${command} (${callId})`)
    }, timeoutMs)

    pendingCalls.set(callId, { resolve, reject, timeout })
    pyProc.stdin.write(JSON.stringify({ command, ...args, callId }) + '\n')
  })
})

ipcMain.handle('py:cancel', async (event, callId) => {
  if (pyProc && pyProc.stdin) {
    // If it's still pending in Electron, clean it up
    if (pendingCalls.has(callId)) {
      const { timeout, reject } = pendingCalls.get(callId)!
      clearTimeout(timeout)
      pendingCalls.delete(callId)
      reject(new Error('Cancelled by client'))
    }
    // Inform Python to stop/ignore
    pyProc.stdin.write(JSON.stringify({ command: 'cancel', callId }) + '\n')
  }
})

// Interactive Login Helper
// Interactive Login Helper
// Interactive Login Helper
ipcMain.handle('auth:start', async () => {
  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
  
  // Use a completely isolated and sandboxed session for auth
  const authSession = session.fromPartition('persist:google-auth', { cache: false });
  await authSession.clearStorageData();

  // Aggressively strip Electron identifiers from headers
  authSession.webRequest.onBeforeSendHeaders((details, callback) => {
    details.requestHeaders['User-Agent'] = userAgent;
    // Google uses these headers to detect Electron/Chromium derivatives
    delete details.requestHeaders['sec-ch-ua'];
    delete details.requestHeaders['Sec-Ch-Ua'];
    delete details.requestHeaders['sec-ch-ua-mobile'];
    delete details.requestHeaders['sec-ch-ua-platform'];
    callback({ requestHeaders: details.requestHeaders });
  });

  const loginWin = new BrowserWindow({
    width: 800,
    height: 700,
    title: 'Sign in to YouTube Music',
    autoHideMenuBar: false, // Show menu bar so it looks more like a real window
    webPreferences: {
      session: authSession,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true, // Crucial for hiding Node.js/Electron specific JS variables from Google
      webSecurity: true
    }
  });

  loginWin.loadURL('https://accounts.google.com/ServiceLogin?service=youtube&continue=https://music.youtube.com/');

  return new Promise((resolve) => {
    let captured = false;

    const filter = {
      urls: ['https://music.youtube.com/youtubei/v1/*']
    };

    // Listen for the ytmusicapi headers on the auth session
    authSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
      if (!captured) {
        const headers = details.requestHeaders;
        const auth = headers['Authorization'] || headers['authorization'];
        const cookie = headers['Cookie'] || headers['cookie'];
        
        // Only capture when we have the actual signed-in auth token
        if (auth && auth.startsWith('SAPISIDHASH') && cookie) {
          captured = true;
          
          const browserData = {
            "User-Agent": userAgent,
            "Accept": headers['Accept'] || headers['accept'] || "*/*",
            "Accept-Language": headers['Accept-Language'] || headers['accept-language'] || "en-US,en;q=0.9",
            "Content-Type": headers['Content-Type'] || headers['content-type'] || "application/json",
            "X-Goog-AuthUser": headers['X-Goog-AuthUser'] || headers['x-goog-authuser'] || "0",
            "x-origin": "https://music.youtube.com",
            "Cookie": cookie,
            "Authorization": auth
          };

          try {
            const root = getUserDataDir();
            const path = join(root, 'browser.json');
            writeFileSync(path, JSON.stringify(browserData, null, 4));
            
            win?.webContents.send('py:event', { event: 'auth_complete' });
            
            setTimeout(() => {
              if (!loginWin.isDestroyed()) loginWin.close();
            }, 1000);
            
            resolve({ status: 'ok' });
          } catch (e) {
            resolve({ status: 'error', message: 'Failed to save credentials' });
          }
        }
      }
      callback({ requestHeaders: details.requestHeaders });
    });

    loginWin.on('closed', () => {
      if (!captured) resolve({ status: 'cancelled' });
    });
  });
});

ipcMain.handle('open-external', async (event, url) => {
  await shell.openExternal(url)
})

ipcMain.on('win:minimize', () => win?.minimize())
ipcMain.on('win:maximize', () => {
  if (win?.isMaximized()) {
    win.unmaximize()
  } else {
    win?.maximize()
  }
})
ipcMain.on('win:fullscreen', () => {
  if (win) {
    win.setFullScreen(!win.isFullScreen())
  }
})
ipcMain.on('win:close', () => win?.close())

function sendWindowState() {
  if (!win) return
  win.webContents.send('win:state-changed', {
    isMaximized: win.isMaximized(),
    isFullScreen: win.isFullScreen()
  })
}

// In createWindow, add these:
// win.on('maximize', sendWindowState)
// win.on('unmaximize', sendWindowState)
// win.on('enter-full-screen', sendWindowState)
// win.on('leave-full-screen', sendWindowState)
ipcMain.handle('ping', () => 'pong')

ipcMain.handle('open-logs', async () => {
  if (existsSync(logPath)) {
    await shell.openPath(logPath);
  } else {
    logToFile('Log file not found when trying to open it');
  }
})

ipcMain.handle('app:clear-cache', async () => {
  try {
    if (logPath && existsSync(logPath)) {
      writeFileSync(logPath, ''); // Clear content
    }
    return { status: 'ok' };
  } catch (e) {
    return { status: 'error', message: String(e) };
  }
})

// Songs folder IPC handlers
function getSongsPath(): string {
  try {
    const cfg = readWindowConfig();
    if (cfg.songsPath) {
      mkdirSync(cfg.songsPath, { recursive: true });
      return cfg.songsPath;
    }
  } catch (e) {
    logToFile(`getSongsPath error: ${e}`);
  }
  const defaultPath = join(getUserDataDir(), 'songs');
  mkdirSync(defaultPath, { recursive: true });
  return defaultPath;
}

function nextSongsFileId(): number {
  const cfg = readWindowConfig();
  const next = Number.isFinite(cfg.songsFileCounter) ? (cfg.songsFileCounter + 1) : 1;
  cfg.songsFileCounter = next;
  writeWindowConfig(cfg);
  return next;
}

ipcMain.handle('songs:get-path', () => {
  return getSongsPath();
})

ipcMain.handle('songs:set-path', (event, newPath: string) => {
  try {
    const cfg: any = readWindowConfig();
    cfg.songsPath = newPath || '';
    writeWindowConfig(cfg);
    if (newPath) mkdirSync(newPath, { recursive: true });
    return { status: 'ok' };
  } catch (e) {
    return { status: 'error', message: String(e) };
  }
})

ipcMain.handle('songs:file-exists', (event, filename: string) => {
  return existsSync(join(getSongsPath(), filename));
})

ipcMain.handle('songs:get-file-url', (event, filename: string) => {
  const songsPath = getSongsPath();
  return pathToFileURL(join(songsPath, filename)).href;
})

ipcMain.handle('songs:open-folder', async (event, filename?: string) => {
  const songsPath = getSongsPath();
  if (filename) {
    shell.showItemInFolder(join(songsPath, filename));
  } else {
    await shell.openPath(songsPath);
  }
})

ipcMain.handle('songs:pick-folder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: 'Выберите папку для сохранения треков',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
})

ipcMain.handle('songs:delete-file', async (event, filename: string) => {
  try {
    const songsPath = getSongsPath();
    const full = join(songsPath, filename);
    if (!existsSync(full)) return { status: 'ok', existed: false };
    unlinkSync(full);
    return { status: 'ok', existed: true };
  } catch (e) {
    return { status: 'error', message: String(e) };
  }
})

ipcMain.handle('songs:import-file', async () => {
  try {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      title: 'Выберите аудиофайл для привязки',
      filters: [
        { name: 'Audio', extensions: ['mp3', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'flac', 'webm'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return { status: 'cancelled' };

    const sourcePath = result.filePaths[0];
    const songsPath = getSongsPath();
    const ext = sourcePath.split('.').pop() || 'audio';
    const id = nextSongsFileId();
    const filename = `local_${id}.${ext}`;
    const destPath = join(songsPath, filename);

    copyFileSync(sourcePath, destPath);
    return { status: 'ok', filename, sourcePath };
  } catch (e) {
    return { status: 'error', message: String(e) };
  }
})
