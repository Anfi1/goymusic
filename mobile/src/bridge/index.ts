import { commands } from './yandex';
import {
  initNativeBackend, nativeCall, nativeCancel, nativeImportAuth, nativeReady,
  nativeStartError, nativeYoutubeLogin, onNativeEvent,
} from './native';

// На Android бэкенд -- тот же python/api.py, что и на десктопе, поднятый внутри
// процесса через Chaquopy. Поэтому доступны все команды: YouTube, SoundCloud, Yandex.
// Если питон почему-то не стартовал, остаётся JS-реализация Яндекса как запасной путь --
// приложение тогда работает урезанно, но не превращается в белый экран.
let useNative = false;

const JS_FALLBACK_OK: Record<string, any> = {
  check_auth: { status: 'ok', authenticated: true },
  load_auth: { status: 'ok', authenticated: true },
  get_user_info: { status: 'ok', user: null },
  get_library: { status: 'ok', items: [] },
  get_playlists: { status: 'ok', playlists: [] },
  get_liked_songs: { status: 'ok', tracks: [], continuation: null },
  get_home: { status: 'ok', sections: [] },
  get_home_sections: { status: 'ok', sections: [] },
  get_explore_releases: { status: 'ok', items: [] },
  get_mixed_for_you: { status: 'ok', items: [] },
  sc_liked_ids: { status: 'ok', ids: [] },
};

async function jsFallback(command: string, args: any): Promise<any> {
  const fn = commands[command];
  if (fn) {
    try {
      return await fn(args || {});
    } catch (e: any) {
      console.warn(`[bridge/js] ${command} failed`, e);
      return { status: 'error', message: String(e?.message || e) };
    }
  }
  if (command in JS_FALLBACK_OK) return JS_FALLBACK_OK[command];
  return { status: 'error', message: `Бэкенд не запущен: команда "${command}" недоступна` };
}

async function pyCall(command: string, args: any = {}): Promise<any> {
  if (useNative) {
    try {
      return await nativeCall(command, args);
    } catch (e: any) {
      console.warn(`[bridge/native] ${command} failed`, e);
      return { status: 'error', message: String(e?.message || e) };
    }
  }
  return jsFallback(command, args);
}

// Первый запуск: ключи хранятся в localStorage вебвью, а не в файлах, поэтому
// дефолты выставляем здесь. Yandex включаем сразу -- он работает и без входа в YouTube.
function applyMobileDefaults() {
  if (localStorage.getItem('goymusic-mobile-initialized') === 'true') return;
  localStorage.setItem('yandex-enabled', 'true');
  localStorage.setItem('ytm-home-source', 'yandex');
  localStorage.setItem('goymusic-mobile-initialized', 'true');
}

export async function installMobileBridge(): Promise<void> {
  applyMobileDefaults();
  initNativeBackend();

  const noop = () => {};
  (window as any).bridge = {
    ping: async () => 'pong',
    pyCall,
    pyCancel: (callId: string) => { if (useNative) nativeCancel(callId); },
    onPyEvent: (cb: (msg: any) => void) => onNativeEvent(cb),
    onDeepLink: () => noop,
    onWindowState: () => noop,
    onFocusChanged: () => noop,
    openExternal: async (url: string) => { window.open(url, '_blank'); },
    // Вход в YouTube: на десктопе открывается окно и перехватываются заголовки,
    // здесь -- нативный WebView, из которого забираются куки (ytmusicapi выводит
    // SAPISIDHASH из них сам). После входа перечитываем авторизацию в api.py.
    authStart: async () => {
      try {
        const res = await nativeYoutubeLogin();
        if (res?.status === 'ok') await pyCall('load_auth', {});
        return res;
      } catch (e: any) {
        return { status: 'error', message: String(e?.message || e) };
      }
    },
    scLogin: async () => pyCall('sc_login', {}),
    winMinimize: noop, winMaximize: noop, winFullscreen: noop, winClose: noop,
    winSetBackgroundMaterial: noop,
    winGetBounds: async () => ({ width: window.innerWidth, height: window.innerHeight }),
    setRPC: noop, clearRPC: noop, openLogs: noop,
    // Запасной путь входа: перенести browser.json с компьютера (см. mobile/README).
    importAuth: async (json: string) => {
      const res = await nativeImportAuth(json);
      if (res?.status === 'ok') await pyCall('load_auth', {});
      return res;
    },
  };

  // Чтобы вход можно было починить руками прямо из консоли отладки.
  (window as any).goymusicImportAuth = (json: string) => (window as any).bridge.importAuth(json);

  useNative = await nativeReady();
  if (!useNative) {
    console.warn('[bridge] python не поднялся, работаем на JS-реализации Яндекса:', nativeStartError());
  }
}
