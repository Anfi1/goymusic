import { app, BrowserWindow, ipcMain, shell, session, screen, dialog } from 'electron'
import { join, dirname } from 'path'
import { pathToFileURL } from 'url'
import { spawn, exec, ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { writeFileSync, appendFileSync, existsSync, mkdirSync, readFileSync, copyFileSync, unlinkSync, readdirSync, openSync, closeSync } from 'fs'
import * as DiscordRPC from 'discord-rpc'
import { autoUpdater, NsisUpdater } from 'electron-updater'
import { createScLikesController, type ScLikeRequest, type ScRefreshRequest, type ScSetTokensRequest } from './scLikes'

process.env.DIST = join(__dirname, '../dist')
process.env.PUBLIC = app.isPackaged ? process.env.DIST : join(__dirname, '../public')

app.name = 'GoyMusic'
const windowsAppId = 'com.goymusic.app'
if (process.platform === 'win32') {
  app.setAppUserModelId(windowsAppId)
  app.on('browser-window-created', (_event, window) => window.setAppDetails({ appId: windowsAppId }))
}

let isShuttingDown = false
let installRequested = false

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

function getLiveMainWindow() {
  if (isShuttingDown || !win || win.isDestroyed()) return null
  return win.webContents?.isDestroyed() === false ? win : null
}

// Между выходом старого процесса и перезапуском блокировкой владеет NSIS.
function installerIsWriting(): boolean {
  if (process.platform !== 'win32' || !app.isPackaged) return false
  try {
    closeSync(openSync(join(app.getPath('temp'), `${windowsAppId}.update-lock`), 'r'))
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EBUSY'
  }
}

const gotTheLock = !installerIsWriting() && app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.exit(0)
} else {
  app.on('second-instance', (_event, argv) => activatePrimary(argv))

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

    if (process.argv.some(arg => arg.startsWith('goymusic://'))) {
      win?.webContents.once('did-finish-load', () => activatePrimary(process.argv))
    }
  })
}

function activatePrimary(argv: string[]) {
  const primary = getLiveMainWindow()
  if (!primary || installRequested) return
  if (primary.isMinimized()) primary.restore()
  primary.show()
  primary.focus()
  const url = argv.find(arg => arg.startsWith('goymusic://'))
  if (!url) return
  const deliver = () => {
    if (getLiveMainWindow() === primary && !installRequested) primary.webContents.send('deep-link', url)
  }
  if (primary.webContents.isLoadingMainFrame()) primary.webContents.once('did-finish-load', deliver)
  else deliver()
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
let rpcRetryTimeout: NodeJS.Timeout | undefined

function initRPC() {
  if (rpc || isShuttingDown) return

  logToFile('Attempting to connect to Discord RPC...')
  rpc = new DiscordRPC.Client({ transport: 'ipc' })
  
  rpc.on('ready', () => {
    logToFile('Discord RPC ready')
    if (rpcRetryTimeout) {
      clearTimeout(rpcRetryTimeout)
      rpcRetryTimeout = undefined
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
  if (rpcRetryTimeout || isShuttingDown) return
  logToFile('Scheduling Discord RPC reconnection in 120 seconds...')
  rpcRetryTimeout = setTimeout(() => {
    rpcRetryTimeout = undefined
    initRPC()
  }, 120000) // Increased to 120 seconds to minimize idle activity
}

// Central dispatcher for Python responses
const pendingCalls = new Map<string, { resolve: Function, reject: Function, timeout: NodeJS.Timeout }>()

function createPyProc() {
  const root = getAppRoot();
  const scriptPath = join(root, 'python', 'api.py')
  
  // Priority: Bundled portable Python -> Venv -> System Python, и в dev тоже.
  // venv\Scripts\python.exe лишь запускает системный Python, а тот идёт через VPN: ссылки
  // googlevideo привязаны к IP резолвера, и renderer, который ходит напрямую, получает на
  // них 403. Встроенный python.exe в исключениях VPN. Пакеты в него ставить так:
  // python\bin\python.exe -m pip install -r python\requirements.txt
  const bundledPython = join(root, 'python', 'bin', 'python.exe')
  const venvPython = join(root, 'venv', 'Scripts', 'python.exe')
  const candidates = [bundledPython, venvPython, 'python', 'python3', 'py'];
  
  logToFile(`Searching for Python interpreter...`);
  logToFile(`Bundled path: ${bundledPython} (exists: ${existsSync(bundledPython)})`);
  logToFile(`Script Path: ${scriptPath}`);

  tryNextPython(candidates, 0, scriptPath, root);
}

function tryNextPython(candidates: string[], index: number, scriptPath: string, root: string) {
  if (isShuttingDown) return
  if (index >= candidates.length) {
    logToFile(`ERROR: Could not start Python with any of the candidates.`);
    getLiveMainWindow()?.webContents.send('py:event', {
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
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        PYTHONIOENCODING: 'utf-8',
        GOYMUSIC_USER_DATA: getUserDataDir()
      }
    });

    pyProc = proc
    const onStartError = (err: Error) => {
      if (pyProc !== proc) return
      pyProc = null
      logToFile(`Failed to start with ${pyPath}: ${err.message}`)
      tryNextPython(candidates, index + 1, scriptPath, root)
    }
    proc.once('error', onStartError)
    proc.once('spawn', () => {
      proc.removeListener('error', onStartError)
      logToFile(`Python process spawned successfully: ${pyPath}`)
      setupPyHandlers(proc, pyPath)
    })

  } catch (e: any) {
    logToFile(`Exception while starting ${pyPath}: ${e.message}`);
    tryNextPython(candidates, index + 1, scriptPath, root);
  }
}

function setupPyHandlers(proc: ChildProcess, usedPath: string) {
  let buffer = ''
  proc.stdout?.on('data', (data) => {
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
      getLiveMainWindow()?.webContents.send('py:event', msg)
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

  proc.stderr?.on('data', (data) => {
    logToFile(`Python: ${data.toString()}`);
  })

  proc.on('close', (code) => {
    logToFile(`Python process (${usedPath}) exited with code ${code}`);
    if (pyProc !== proc) return
    pyProc = null
    stopPoTokenTimers()
    getLiveMainWindow()?.webContents.send('py:event', { event: 'backend_dead', code });
  })

  proc.on('error', (err) => {
    logToFile(`Process error (${usedPath}): ${err.message}`);
  })

  // Первый минтинг PO Token - с задержкой, чтобы python успел прочитать
  // browser.json (persist:google-auth сессия должна быть уже залогинена заранее
  // через auth:start, иначе минтинг просто ничего не поймает и это не страшно -
  // резолв продолжит работать по старой схеме pytubefix/yt-dlp).
  if (pyProc !== proc || isShuttingDown) return
  firstPoTokenCheck = setTimeout(refreshPoToken, 5000)
  periodicPoTokenCheck = setInterval(refreshPoToken, 1000 * 60 * 60 * 3)
}

let firstPoTokenCheck: NodeJS.Timeout | undefined
let periodicPoTokenCheck: NodeJS.Timeout | undefined
let firstUpdateCheck: NodeJS.Timeout | undefined
let periodicUpdateCheck: NodeJS.Timeout | undefined

function stopPoTokenTimers() {
  clearTimeout(firstPoTokenCheck)
  clearInterval(periodicPoTokenCheck)
}

function stopWindowTimers() {
  stopPoTokenTimers()
  clearTimeout(firstUpdateCheck)
  clearInterval(periodicUpdateCheck)
}

function exitPyProc() {
  if (pyProc != null) {
    pyProc.kill()
    pyProc = null
  }
  //killScChrome()
}

function killScChrome() {
  const scDir = join(app.getPath('userData'), 'sc-chrome')
  const escaped = scDir.replace(/\\/g, '\\\\')
  exec(
    `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\\"name='chrome.exe'\\\" | Where-Object { $_.CommandLine -like '*${escaped}*' } | Stop-Process -Force"`,
    () => {} // silence errors
  )
}

function initAutoUpdater() {
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  // NSIS-апдейтер по умолчанию не знает, что юзер ставил приложение в кастомную
  // папку (allowToChangeInstallationDirectory), и тихий инсталлятор без /D=...
  // падает в дефолтный путь — рядом появляется вторая, отдельная установка.
  // installDirectory явно указывает обновляться поверх текущей директории.
  if (autoUpdater instanceof NsisUpdater) {
    autoUpdater.installDirectory = dirname(app.getPath('exe'))
  }

  autoUpdater.on('update-available', (info) => {
    logToFile(`Update available: ${info.version}`)
    getLiveMainWindow()?.webContents.send('update:available', {
      version: info.version,
      releaseNotes: info.releaseNotes
    })
  })

  autoUpdater.on('update-not-available', (info) => {
    logToFile('No update available')
    getLiveMainWindow()?.webContents.send('update:not-available', {
      version: info?.version || app.getVersion()
    })
  })

  autoUpdater.on('download-progress', (progress) => {
    getLiveMainWindow()?.webContents.send('update:progress', {
      percent: progress.percent,
      speed: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total
    })
  })

  autoUpdater.on('update-downloaded', () => {
    logToFile('Update downloaded, ready to install')
    getLiveMainWindow()?.webContents.send('update:downloaded')
  })

  autoUpdater.on('error', (err) => {
    logToFile(`Auto-updater error: ${err.message}`)
    getLiveMainWindow()?.webContents.send('update:error', { message: err.message })
  })

  const safeCheck = () => {
    if (isShuttingDown) return
    autoUpdater.checkForUpdates().catch((err: any) => {
      logToFile(`Update check failed: ${err.message}`)
    })
  }

  firstUpdateCheck = setTimeout(safeCheck, 5000)
  periodicUpdateCheck = setInterval(safeCheck, 60 * 60 * 1000)
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
    backgroundColor: '#00000000',
    icon: join(process.env.PUBLIC!, 'icon.png'),
    vibrancy: 'under-window',
    backgroundMaterial: 'mica',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      webSecurity: false, 
      spellcheck: false, 
      backgroundThrottling: true,
      devTools: !app.isPackaged || process.argv.includes('--devtools')
    },
  })

  if (windowState.isMaximized) {
    win.maximize();
  }

  const mainWindow = win
  const memoryTimer = setInterval(() => {
    if (getLiveMainWindow() !== mainWindow) return
    session.defaultSession.clearCache()
    mainWindow.webContents.executeJavaScript('window.gc && window.gc()').catch(() => {})
  }, 1000 * 60 * 5)

  mainWindow.on('close', saveWindowConfig)
  mainWindow.once('closed', () => {
    clearInterval(memoryTimer)
    if (win !== mainWindow) return
    win = null
    if (process.platform === 'win32' && !isShuttingDown) app.quit()
  })
  mainWindow.on('focus', () => getLiveMainWindow()?.webContents.send('win:focus-changed', true))
  mainWindow.on('blur', () => getLiveMainWindow()?.webContents.send('win:focus-changed', false))

  // Filter for both imagery and video playback domains
  const filter = {
    urls: [
      '*://*.googleusercontent.com/*',
      '*://*.ggpht.com/*',
      '*://*.googlevideo.com/*'
    ]
  }

  // Handle outgoing headers
  // Дефолтный User-Agent Electron содержит "Electron/x.x.x" прямым текстом - для
  // CDN googlevideo.com это явный сигнал не-браузерного клиента, из-за которого
  // <audio> внутри приложения ловит 403/Format error там, где та же ссылка,
  // открытая в настоящем браузере, играет нормально. Подчищаем так же, как уже
  // сделано для auth- и SoundCloud-сессий (см. ниже).
  const cleanChromeUA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`
  session.defaultSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    details.requestHeaders['Referer'] = 'https://music.youtube.com/'
    details.requestHeaders['Origin'] = 'https://music.youtube.com'
    details.requestHeaders['User-Agent'] = cleanChromeUA
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

  // Capture renderer console output to app.log
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const prefix = [' VERBOSE', ' INFO', ' WARNING', ' ERROR'][level] || '';
    logToFile(`[renderer${prefix}] ${message} (${sourceId}:${line})`);
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (gotTheLock && !isShuttingDown && !installRequested && !win) {
    createWindow()
  }
})

app.once('before-quit', () => {
  isShuttingDown = true
  stopWindowTimers()
  clearTimeout(rpcRetryTimeout)
  scLikes.dispose()
  exitPyProc()
})

ipcMain.handle('app:get-version', () => app.getVersion())

// Auto-updater IPC handlers
ipcMain.handle('update:check', async () => {
  const currentVersion = app.getVersion()
  if (!app.isPackaged) {
    return { status: 'dev' as const, currentVersion }
  }
  try {
    const result = await autoUpdater.checkForUpdates()
    if (!result) {
      return { status: 'up-to-date' as const, currentVersion }
    }
    const latestVersion = result.updateInfo?.version
    const available = typeof result.isUpdateAvailable === 'boolean'
      ? result.isUpdateAvailable
      : Boolean(latestVersion && latestVersion !== currentVersion)
    if (available && latestVersion) {
      return { status: 'available' as const, version: latestVersion, currentVersion }
    }
    return { status: 'up-to-date' as const, currentVersion }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logToFile(`Manual update check error: ${message}`)
    return { status: 'error' as const, currentVersion, message }
  }
})

ipcMain.handle('update:download', async () => {
  await autoUpdater.downloadUpdate()
})

ipcMain.handle('update:install', async () => {
  if (installRequested || isShuttingDown) return
  installRequested = true
  autoUpdater.once('error', () => { installRequested = false })
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

// Тот же механизм, что и IPC 'py:call', но вызываемый напрямую из main-процесса
// (например, для отправки свежего PO Token без похода через renderer).
function callPython(command: string, args: any = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!pyProc || !pyProc.stdin || !pyProc.stdout) {
      reject('Python process not available')
      return
    }

    const callId = args.callId || randomUUID();

    const LONG_RUNNING = new Set(['yandex_import_streaming'])
    const timeoutMs = LONG_RUNNING.has(command) ? 7_200_000 : 300000 // 2h for import, 5min otherwise
    const timeout = setTimeout(() => {
      pendingCalls.delete(callId)
      reject(`Python call timeout: ${command} (${callId})`)
    }, timeoutMs)

    pendingCalls.set(callId, { resolve, reject, timeout })
    pyProc.stdin.write(JSON.stringify({ command, ...args, callId }) + '\n')
  })
}

// IPC bridge for Python
ipcMain.handle('py:call', async (event, command, args = {}) => {
  return callPython(command, args)
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
  if (isShuttingDown) return { status: 'cancelled' }
  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
  
  // Use a completely isolated and sandboxed session for auth
  const authSession = session.fromPartition('persist:google-auth', { cache: false });
  await authSession.clearStorageData();
  if (isShuttingDown) return { status: 'cancelled' }

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
    let closeTimer: NodeJS.Timeout | undefined

    const filter = {
      urls: ['https://music.youtube.com/youtubei/v1/*']
    };

    // Listen for the ytmusicapi headers on the auth session
    authSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
      if (!captured && !isShuttingDown && !loginWin.isDestroyed()) {
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
            
            getLiveMainWindow()?.webContents.send('py:event', { event: 'auth_complete' });
            
            closeTimer = setTimeout(() => {
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

    loginWin.once('closed', () => {
      clearTimeout(closeTimer)
      if (!captured) resolve({ status: 'cancelled' });
    });
  });
});

// --- PO Token: минтинг через скрытое окно на РЕАЛЬНОЙ залогиненной сессии ---
// Вместо отдельного Node-сервера (bgutil) или реверс-инжиниренного JS-солвера
// (pytubefix) используем уже имеющийся у нас настоящий Chromium: открываем скрытое
// окно на той же сессии persist:google-auth, что и логин, даём реальной странице
// music.youtube.com самой сделать то, что она обычно делает, и ловим готовый токен
// из сетевого запроса. Оттуда же снимаем dataSyncId, который иначе недоступен.
//
// ВАЖНО, чтобы не строить ложных ожиданий: ранний спайк показал, что этот токен
// открывает web_music adaptive-форматы (opus 251) - это оказалось НЕВЕРНО. Такие
// URL стабильно дают code=4 Format error в реальном <audio>, а позже выяснилось,
// что всё семейство web вообще SABR-only и форматов не отдаёт. Сейчас токен и
// dataSyncId уходят только в авторизованную попытку tv/web/mweb в python
// (_try_yt_dlp_cookies) - единственный реально работающий путь резолва.
// Помогают ли они там - не проверено: изолировать эффект не получилось.
interface PoTokenResult { token: string | null; dataSyncId: string | null }

let poTokenMintInFlight: Promise<PoTokenResult> | null = null;

function mintPoToken(): Promise<PoTokenResult> {
  if (poTokenMintInFlight) return poTokenMintInFlight;

  poTokenMintInFlight = (async () => {
    let win: BrowserWindow | null = null;
    try {
      const sess = session.fromPartition('persist:google-auth', { cache: false });

      // Обёртка-объект вместо голого let - TS иначе слишком агрессивно сужает
      // тип переменной, мутируемой из вложенного колбэка, до `never`.
      const box: { pot: string | null } = { pot: null };
      const filter = { urls: ['*://*.googlevideo.com/videoplayback*'] };
      sess.webRequest.onBeforeRequest(filter, (details, callback) => {
        if (!box.pot) {
          const m = details.url.match(/[?&]pot=([^&]+)/);
          if (m) box.pot = decodeURIComponent(m[1]);
        }
        // Сам медиафайл нам не нужен - экономим трафик и не грузим реальное аудио.
        callback({ cancel: true });
      });

      win = new BrowserWindow({
        width: 900,
        height: 700,
        show: false,
        webPreferences: {
          session: sess,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        }
      });
      // Скрытое окно НЕ значит беззвучное - блокировка videoplayback-запроса не ловит
      // всё (например SABR-чанки идут по другому пути), так что глушим звук явно на
      // уровне Electron, а не полагаемся только на webRequest-фильтр.
      win.webContents.setAudioMuted(true);

      win.loadURL('https://music.youtube.com/watch?v=dQw4w9WgXcQ');

      const mintWindow = win
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer)
          clearInterval(check)
          mintWindow.removeListener('closed', finish)
          resolve()
        }
        const timer = setTimeout(finish, 15000)
        const check = setInterval(() => { if (box.pot) finish() }, 250)
        mintWindow.once('closed', finish)
      });

      // Снимаем перехватчик, чтобы не мешать возможному параллельному логину
      // через тот же partition.
      sess.webRequest.onBeforeRequest(filter, null as any);

      // dataSyncId недоступен через голый API-запрос (ytmusicapi) - он кладётся
      // в ytcfg только настоящей отрендеренной страницей. Без него GVS PO Token
      // принимается CDN только для маленького "пробного" запроса, а на реальном
      // проигрывании (большой Range/без Range) сервер отдаёт 403 - см. warning
      // yt-dlp "missing Data Sync ID for account. Formats may not work."
      let dataSyncId: string | null = null;
      if (!isShuttingDown && !win.isDestroyed() && win.webContents?.isDestroyed() === false) {
        try {
          dataSyncId = await win.webContents.executeJavaScript(
            "(function(){ try { return (window.ytcfg && window.ytcfg.get && window.ytcfg.get('DATASYNC_ID')) || null; } catch(e) { return null; } })()"
          );
        } catch (e) {
          logToFile(`Failed to read DATASYNC_ID from page: ${e}`);
        }
      }

      if (box.pot) {
        logToFile(`PO Token minted (${box.pot.length} chars), dataSyncId ${dataSyncId ? 'present' : 'MISSING'}`);
      } else {
        logToFile('PO Token mint: timed out without capturing a token');
      }
      return { token: box.pot, dataSyncId };
    } catch (e: any) {
      logToFile(`PO Token mint failed: ${e?.message || e}`);
      return { token: null, dataSyncId: null };
    } finally {
      if (win && !win.isDestroyed()) win.close();
      poTokenMintInFlight = null;
    }
  })();

  return poTokenMintInFlight;
}

async function refreshPoToken() {
  if (isShuttingDown || !pyProc) return
  const { token, dataSyncId } = await mintPoToken();
  if (token && pyProc && !isShuttingDown) {
    try {
      await callPython('set_po_token', { token, dataSyncId });
    } catch (e) {
      logToFile(`Failed to send PO Token to Python: ${e}`);
    }
  }
}

// --- SoundCloud: быстрые лайки через session.fetch(), вход и выход ---
const scLikes = createScLikesController({
  getSession: (partition) => session.fromPartition(partition),
  createWindow: (opts) => {
    return new BrowserWindow({
      x: opts.x,
      y: opts.y,
      width: opts.width,
      height: opts.height,
      show: opts.show,
      title: opts.title,
      autoHideMenuBar: opts.autoHideMenuBar,
      webPreferences: {
        session: opts.session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
  },
  getMainBounds: () => {
    const mw = getLiveMainWindow()
    return mw ? mw.getBounds() : null
  },
  getWorkAreaForBounds: (bounds) =>
    bounds ? screen.getDisplayMatching(bounds).workArea : screen.getPrimaryDisplay().workArea,
  isShuttingDown: () => isShuttingDown,
  chromeVersion: process.versions.chrome,
  log: logToFile,
})

ipcMain.handle('sc:login', () => scLikes.login())
ipcMain.handle('sc:logout', () => scLikes.logout())
ipcMain.handle('sc:like', (_event, payload: ScLikeRequest) => scLikes.like(payload))
ipcMain.handle('sc:refresh', (_event, payload?: ScRefreshRequest) => scLikes.refresh(payload))
ipcMain.handle('sc:set-tokens', (_event, payload: ScSetTokensRequest) => scLikes.setTokens(payload))

// Путь к кастомному профилю Chrome для лайков SC.
ipcMain.handle('sc:profile-path', () => {
  return join(app.getPath('userData'), 'sc-chrome')
})

// Ручной выбор Chromium-браузера (Chrome/Edge/Brave/...) для лайков SC, если автоопределение не подошло.
ipcMain.handle('sc:pick-browser', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    title: 'Выберите исполняемый файл браузера',
    filters: [{ name: 'Executable', extensions: ['exe'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
})

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

// Материал фона окна (Mica для обычной тёмной темы, Acrylic для стеклянной) -- Windows only.
ipcMain.on('win:set-background-material', (_event, material: 'mica' | 'acrylic') => {
  win?.setBackgroundMaterial(material)
})

ipcMain.handle('win:get-bounds', () => {
  if (!win) return null
  return win.getBounds()
})

function sendWindowState() {
  const target = getLiveMainWindow()
  if (!target) return
  target.webContents.send('win:state-changed', {
    isMaximized: target.isMaximized(),
    isFullScreen: target.isFullScreen()
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

ipcMain.handle('songs:list-files', () => {
  return readdirSync(getSongsPath(), { withFileTypes: true }).filter(e => e.isFile()).map(e => e.name);
})

// Копия привязок рядом с файлами: переживает переустановку и сброс данных приложения.
const OVERRIDES_MANIFEST = 'goymusic-overrides.json';

ipcMain.handle('songs:read-manifest', () => {
  try {
    return JSON.parse(readFileSync(join(getSongsPath(), OVERRIDES_MANIFEST), 'utf8'));
  } catch {
    return null;
  }
})

ipcMain.handle('songs:write-manifest', (event, data: unknown) => {
  writeFileSync(join(getSongsPath(), OVERRIDES_MANIFEST), JSON.stringify(data, null, 1));
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

ipcMain.handle('songs:import-file', async (event, filePrefix?: string) => {
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
    const filename = filePrefix ? `${filePrefix}_${Date.now()}.${ext}` : `local_${nextSongsFileId()}.${ext}`;
    const destPath = join(songsPath, filename);

    copyFileSync(sourcePath, destPath);
    return { status: 'ok', filename, sourcePath };
  } catch (e) {
    return { status: 'error', message: String(e) };
  }
})
