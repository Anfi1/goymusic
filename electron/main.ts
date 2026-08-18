import { app, BrowserWindow, ipcMain, shell, session, screen, dialog } from 'electron'
import { join, dirname } from 'path'
import { pathToFileURL } from 'url'
import { spawn, exec, ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { writeFileSync, appendFileSync, existsSync, mkdirSync, readFileSync, copyFileSync, unlinkSync } from 'fs'
import * as DiscordRPC from 'discord-rpc'
import { autoUpdater, NsisUpdater } from 'electron-updater'

process.env.DIST = join(__dirname, '../dist')
process.env.PUBLIC = app.isPackaged ? process.env.DIST : join(__dirname, '../public')

app.name = 'GoyMusic'
app.setAppUserModelId('com.goymusic.app')

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
  
  // Priority: Venv -> Bundled portable Python -> System Python
  // В dev-режиме venv содержит pip-пакеты (nodriver), bundled — нет.
  const bundledPython = join(root, 'python', 'bin', 'python.exe')
  const venvPython = join(root, 'venv', 'Scripts', 'python.exe')
  const candidates = isPackaged
    ? [bundledPython, venvPython, 'python', 'python3', 'py']
    : [venvPython, bundledPython, 'python', 'python3', 'py'];
  
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

  // Первый минтинг PO Token - с задержкой, чтобы python успел прочитать
  // browser.json (persist:google-auth сессия должна быть уже залогинена заранее
  // через auth:start, иначе минтинг просто ничего не поймает и это не страшно -
  // резолв продолжит работать по старой схеме pytubefix/yt-dlp).
  setTimeout(() => { refreshPoToken(); }, 5000);
}

// TTL GVS PO Token не документирован и не проверен на практике - берём
// консервативный интервал, чтобы не гонять токен впустую и не словить протухший.
setInterval(() => { refreshPoToken(); }, 1000 * 60 * 60 * 3); // Every 3 hours

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

      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 15000);
        const check = setInterval(() => {
          if (box.pot) { clearTimeout(timer); clearInterval(check); resolve(); }
        }, 250);
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
      if (win && !win.isDestroyed()) {
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
  const { token, dataSyncId } = await mintPoToken();
  if (token && pyProc) {
    try {
      await callPython('set_po_token', { token, dataSyncId });
    } catch (e) {
      logToFile(`Failed to send PO Token to Python: ${e}`);
    }
  }
}

// --- SoundCloud webview: надёжный лайк в обход DataDome (write из реального контекста soundcloud.com) ---
const SC_PARTITION = 'persist:soundcloud'
// UA и client-hints строим от РЕАЛЬНОЙ версии Chromium внутри Electron.
// Раньше был хардкод Chrome/122 при движке ~138 — рассинхрон UA↔движок↔hints
// это классический сигнал для DataDome. Теперь всё согласовано с реальным Chromium.
const SC_CHROME_VER = process.versions.chrome || '122.0.0.0'
const SC_CHROME_MAJOR = SC_CHROME_VER.split('.')[0]
const SC_WIN_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${SC_CHROME_VER} Safari/537.36`
const SC_CH_UA = `"Chromium";v="${SC_CHROME_MAJOR}", "Google Chrome";v="${SC_CHROME_MAJOR}", "Not.A/Brand";v="24"`
let scWin: BrowserWindow | null = null
let scSessionReady = false

// Маскируем Electron под обычный Chrome: согласованные UA + client-hints,
// иначе DataDome (анти-бот SoundCloud) блокирует вход и лайки.
function getScSession() {
  const sess = session.fromPartition(SC_PARTITION)
  if (!scSessionReady) {
    sess.setUserAgent(SC_WIN_UA)
    sess.webRequest.onBeforeSendHeaders((details, callback) => {
      const h = details.requestHeaders
      h['User-Agent'] = SC_WIN_UA
      h['sec-ch-ua'] = SC_CH_UA
      h['sec-ch-ua-mobile'] = '?0'
      h['sec-ch-ua-platform'] = '"Windows"'
      callback({ requestHeaders: h })
    })
    scSessionReady = true
  }
  return sess
}

// Stealth-патч navigator в main-world ДО скриптов страницы (через CDP, без понижения
// безопасности окна). Прячет признаки автоматизации, на которые смотрит DataDome.
const SC_STEALTH_JS = `(() => {
  try { Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false }); } catch (e) {}
  try { Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] }); } catch (e) {}
  try { window.chrome = window.chrome || {}; window.chrome.runtime = window.chrome.runtime || {}; } catch (e) {}
  try {
    const mk = (name) => ({ name, filename: '', description: '', length: 1 });
    const plugins = [mk('PDF Viewer'), mk('Chrome PDF Viewer'), mk('Chromium PDF Viewer')];
    Object.defineProperty(navigator, 'plugins', { get: () => plugins });
    Object.defineProperty(navigator, 'mimeTypes', { get: () => [{ type: 'application/pdf' }] });
  } catch (e) {}
  try {
    const orig = navigator.permissions && navigator.permissions.query;
    if (orig) navigator.permissions.query = (p) => (p && p.name === 'notifications')
      ? Promise.resolve({ state: Notification.permission })
      : orig.call(navigator.permissions, p);
  } catch (e) {}
  try {
    const getParam = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (p) {
      if (p === 37445) return 'Google Inc. (Intel)';
      if (p === 37446) return 'ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)';
      return getParam.call(this, p);
    };
  } catch (e) {}
})();`

function installScStealth(w: BrowserWindow) {
  try {
    const dbg = w.webContents.debugger
    if (!dbg.isAttached()) dbg.attach('1.3')
    dbg.sendCommand('Page.enable').catch(() => {})
    dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: SC_STEALTH_JS }).catch(() => {})
  } catch (e) {
    console.warn('[soundcloud] stealth attach failed', e)
  }
}

async function ensureScWindow(show: boolean): Promise<BrowserWindow> {
  if (scWin && !scWin.isDestroyed()) {
    if (show) scWin.show()
    return scWin
  }
  const sess = getScSession()
  scWin = new BrowserWindow({
    width: 1000,
    height: 800,
    show,
    title: 'SoundCloud',
    autoHideMenuBar: true,
    // sandbox: true прячет Node/Electron-переменные от детекта (как в auth:start)
    webPreferences: { session: sess, sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  scWin.webContents.setUserAgent(SC_WIN_UA)
  installScStealth(scWin)
  scWin.on('closed', () => { scWin = null })
  await scWin.loadURL('https://soundcloud.com/discover')
  return scWin
}

// Окно входа: резолвим, когда в сессии появилась кука oauth_token (пользователь залогинился).
ipcMain.handle('sc:login', async () => {
  const win = await ensureScWindow(true)
  win.show()
  const sess = session.fromPartition(SC_PARTITION)
  return new Promise((resolve) => {
    let done = false
    const finish = (payload: any) => { if (!done) { done = true; clearInterval(timer); resolve(payload) } }
    const check = async () => {
      try {
        const cookies = await sess.cookies.get({ name: 'oauth_token' })
        const tok = cookies.find(c => c.domain?.includes('soundcloud.com'))?.value || cookies[0]?.value
        if (tok) {
          finish({ status: 'ok', token: tok })
          setTimeout(() => { if (scWin && !scWin.isDestroyed()) scWin.hide() }, 800)
        }
      } catch { /* ignore */ }
    }
    const timer = setInterval(check, 1500)
    win.on('closed', () => finish({ status: 'cancelled' }))
    check()
  })
})

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
