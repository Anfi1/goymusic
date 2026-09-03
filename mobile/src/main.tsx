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

installMobileBridge();

async function boot() {
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

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </React.StrictMode>,
  );
}

boot();
