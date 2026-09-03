// Мобильная точка входа. Порядок здесь важен: и мост, и отключение Web Audio должны
// встать ДО того, как импортируется десктопный код -- модули ../src обращаются к
// window.bridge уже на этапе инициализации (например yandex.ts подтягивает лайки).
import { installMobileBridge } from './bridge';
import './mobile.css';

// Cross-origin поток Яндекса нельзя пропускать через createMediaElementSource --
// получится тишина (CDN не отдаёт CORS-заголовки, проверено). Убираем конструктор:
// initAudioContext в ../src/api/player.ts обёрнут в try/catch, поймает исключение и
// оставит audioContext = null, а воспроизведение пойдёт обычным <audio>.
delete (window as any).AudioContext;
delete (window as any).webkitAudioContext;

// Плеер выставляет audio.crossOrigin = "anonymous" (нужно для Web Audio на десктопе).
// На мобиле это смертельно: с заголовком Origin CDN Яндекса отвечает 403 вместо 206
// (проверено на живой ссылке). Web Audio тут всё равно выключен, так что глушим сеттер.
Object.defineProperty(HTMLMediaElement.prototype, 'crossOrigin', {
  get: () => null,
  set: () => {},
  configurable: true,
});

// Классы из ../src сгенерированы CSS-модулями и в разных файлах совпадают (.container
// есть у половины компонентов), поэтому по ним не прицелиться. Помечаем нужные узлы
// своими классами -- надёжнее, чем :has() и селекторы по подстроке.
function tagLayout() {
  const tag = () => {
    const now = document.querySelector('[class*="nowPlaying"]');
    const player = now?.parentElement;
    if (player && !player.classList.contains('goy-player')) player.classList.add('goy-player');

    // Тот же признак, что в mobile.css: боковое меню -- это sidebar, но не rightSidebar
    // (в разметке два aside, и по тегу их не различить).
    const side = [...document.querySelectorAll('[class*="sidebar"]')].find(
      (e) => !/rightSidebar/.test(e.className.toString()),
    );
    if (side && !side.classList.contains('goy-sidebar')) side.classList.add('goy-sidebar');
  };
  tag();
  new MutationObserver(tag).observe(document.body, { childList: true, subtree: true });
}

// Сайдбар на телефоне уезжает в выдвижную панель (см. mobile.css), значит нужна
// кнопка его вызова. Делаем её здесь, а не в ../src -- десктоп не трогаем.
function installNavToggle() {
  const btn = document.createElement('button');
  btn.id = 'goy-nav-toggle';
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Меню');
  btn.textContent = '☰';
  btn.addEventListener('click', () => document.body.classList.toggle('goy-nav-open'));
  document.body.appendChild(btn);

  const close = () => document.body.classList.remove('goy-nav-open');

  // Клик по затемнению закрывает панель.
  document.addEventListener('click', (e) => {
    if (!document.body.classList.contains('goy-nav-open')) return;
    const target = e.target as HTMLElement;
    if (target === btn || btn.contains(target)) return;
    if (!target.closest('.goy-sidebar')) close();
  }, true);

  // Переход в другой раздел тоже закрывает. Пункты сайдбара -- обычные div без role,
  // по клику их не отличить от разворачивания «Account», поэтому следим за самим
  // переходом: App.tsx пишет текущий экран в localStorage.
  let lastView = localStorage.getItem('goymusic-active-view');
  setInterval(() => {
    const now = localStorage.getItem('goymusic-active-view');
    if (now === lastView) return;
    lastView = now;
    close();
  }, 250);
}

async function boot() {
  // Мост ставится до импорта ../src: модули рендерера дёргают window.bridge
  // уже на инициализации.
  await installMobileBridge();

  const [{ default: React }, ReactDOM, { QueryClient, QueryClientProvider }, { default: App }, { initMediaSession }] =
    await Promise.all([
      import('react'),
      import('react-dom/client'),
      import('@tanstack/react-query'),
      import('@desktop/App'),
      import('@desktop/api/mediaSession'),
    ]);

  initMediaSession();

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 1000 * 60 * 5,
        gcTime: 1000 * 60,
        refetchOnWindowFocus: false,
        refetchOnMount: false,
        retry: 1,
      },
    },
  });

  tagLayout();
  installNavToggle();

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </React.StrictMode>,
  );
}

boot();
