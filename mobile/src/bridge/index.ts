import { commands } from './yandex';

// Десктоп общается с Python ровно через window.bridge. На Android Python нет, поэтому
// подставляем тот же интерфейс: yandex_*-команды выполняем в JS, остальные (YouTube,
// SoundCloud, локальные файлы) честно отвечают ошибкой -- UI такие ответы переживает,
// он и на десктопе получает их при выключенных интеграциях.
const UNSUPPORTED_OK: Record<string, any> = {
  // authenticated: true -- обязательный обман. Без YouTube-аккаунта App.tsx рисует
  // экран входа вместо приложения, и до Yandex-интерфейса просто не добраться.
  // Данные YouTube при этом всё равно пустые (см. остальные заглушки ниже).
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
  sc_client_id: { status: 'error', message: 'SoundCloud недоступен в мобильной сборке' },
};

async function pyCall(command: string, args: any = {}): Promise<any> {
  const fn = commands[command];
  if (fn) {
    try {
      return await fn(args || {});
    } catch (e: any) {
      console.warn(`[bridge] ${command} failed`, e);
      return { status: 'error', message: String(e?.message || e) };
    }
  }
  if (command in UNSUPPORTED_OK) return UNSUPPORTED_OK[command];
  return { status: 'error', message: `Команда "${command}" недоступна в мобильной сборке` };
}

// На телефоне единственный рабочий источник -- Яндекс, поэтому включаем его и делаем
// главной сразу, иначе после установки пользователь видит пустой YouTube-интерфейс.
function applyMobileDefaults() {
  if (localStorage.getItem('goymusic-mobile-initialized') === 'true') return;
  localStorage.setItem('yandex-enabled', 'true');
  localStorage.setItem('ytm-home-source', 'yandex');
  localStorage.setItem('sc-enabled', 'false');
  localStorage.setItem('goymusic-mobile-initialized', 'true');
}

export function installMobileBridge() {
  applyMobileDefaults();
  const noop = () => {};
  const unsub = () => noop;
  (window as any).bridge = {
    ping: async () => 'pong',
    pyCall,
    pyCancel: noop,
    onPyEvent: unsub,
    onDeepLink: unsub,
    onWindowState: unsub,
    onFocusChanged: unsub,
    openExternal: async (url: string) => { window.open(url, '_blank'); },
    authStart: async () => ({ status: 'error', message: 'YouTube-вход недоступен в мобильной сборке' }),
    scLogin: async () => ({ status: 'error', message: 'SoundCloud недоступен в мобильной сборке' }),
    // Оконных кнопок на телефоне нет -- заглушки, чтобы TitleBar не падал.
    winMinimize: noop, winMaximize: noop, winFullscreen: noop, winClose: noop,
    winSetBackgroundMaterial: noop,
    winGetBounds: async () => ({ width: window.innerWidth, height: window.innerHeight }),
    setRPC: noop, clearRPC: noop, openLogs: noop,
  };
}
