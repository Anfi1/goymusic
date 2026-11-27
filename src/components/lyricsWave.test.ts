import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LyricsView, prefersReducedMotion, scrollContainerToTop } from './organisms/LyricsView';
import { MyWaveView } from './organisms/MyWaveView';
import { player } from '../api/player';

vi.mock('../api/player', () => ({
  player: {
    currentTrack: null as any,
    isPlaying: false,
    queueSourceId: null as string | null,
    queue: [] as any[],
    currentIndex: -1,
    currentTime: 0,
    duration: 180,
    buffered: [],
    volume: 80,
    muted: false,
    shuffle: false,
    repeat: 'off' as const,
    subscribe: () => () => {},
    togglePlay: vi.fn(),
    toggleShuffle: vi.fn(),
    toggleRepeat: vi.fn(),
    seek: vi.fn(),
    prev: vi.fn(),
    next: vi.fn(),
    setVolume: vi.fn(),
    toggleMute: vi.fn(),
    playTrackList: vi.fn(),
    playAt: vi.fn(),
  },
}));

vi.mock('../api/yt', () => ({
  getLyrics: vi.fn(async () => null),
  getComments: vi.fn(async () => ({ description: '', comments: [], continuation: null })),
  getHomeFeed: vi.fn(async () => []),
  getRadioTracks: vi.fn(async () => []),
  getHomeSource: vi.fn(() => 'youtube'),
  getMoodCategories: vi.fn(async () => []),
  getMoodPlaylists: vi.fn(async () => []),
  getPlaylist: vi.fn(async () => null),
}));

vi.mock('../api/soundcloud', () => ({
  isSoundCloudEnabled: vi.fn(() => false),
  isScAuthed: vi.fn(() => false),
  getScWaveStations: vi.fn(async () => []),
  getScStationTracks: vi.fn(async () => []),
  interleaveMany: vi.fn(() => []),
}));

vi.mock('../api/yandex', () => ({
  isYandexEnabled: vi.fn(() => false),
  getYandexWaveTracks: vi.fn(async () => []),
}));

vi.mock('../api/likedIndex', () => ({
  useLikedLookup: vi.fn(() => ({ ytIds: new Set(), scIds: new Set(), yandexIds: new Set(), overrides: new Map() })),
  resolveTrackLikeStatus: vi.fn(() => 'INDIFFERENT'),
}));

vi.mock('../api/likedManager', () => ({
  likedManager: { toggleLike: vi.fn(), toggleDislike: vi.fn() },
}));

vi.mock('../api/historyManager', () => ({
  historyManager: { getRecent: vi.fn(async () => []) },
}));

vi.mock('./organisms/QueuePanel', () => ({
  QueuePanel: () => createElement('div', { 'data-testid': 'queue-panel' }),
}));

vi.mock('./organisms/TrackOverrideDialog', () => ({
  TrackOverrideDialog: () => null,
}));

function renderWithQuery(node: React.ReactElement): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, node));
}

const sampleTrack = {
  id: 'yt-track-1',
  title: 'Night Drive',
  artists: ['Artist A'],
  artistIds: ['art-1'],
  album: 'Album A',
  duration: '3:00',
  thumbUrl: 'https://example.com/art.jpg',
  source: 'youtube' as const,
};

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => { storage.set(k, String(v)); },
    removeItem: (k: string) => { storage.delete(k); },
  });
});

afterEach(() => {
  (player as any).currentTrack = null;
  (player as any).isPlaying = false;
  (player as any).queueSourceId = null;
  vi.unstubAllGlobals();
});

describe('LyricsView scroll reset & expand controls', () => {
  it('scrollContainerToTop сбрасывает scrollTop мгновенно и безопасно переносит null/отсутствие scrollTo', () => {
    const scrollTo = vi.fn();
    const el = { scrollTop: 950, scrollTo };
    scrollContainerToTop(el);
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'instant' });
    expect(el.scrollTop).toBe(0);

    const legacyEl = { scrollTop: 420 };
    scrollContainerToTop(legacyEl);
    expect(legacyEl.scrollTop).toBe(0);

    expect(() => scrollContainerToTop(null)).not.toThrow();
  });

  it('prefersReducedMotion учитывает matchMedia и безопасен в Node', () => {
    expect(prefersReducedMotion()).toBe(false);
    vi.stubGlobal('window', {
      matchMedia: vi.fn().mockReturnValue({ matches: true }),
    });
    expect(prefersReducedMotion()).toBe(true);
  });

  it('LyricsView.module.css не задает scroll-behavior: smooth на контейнере (не ломает мгновенный сброс скролла)', () => {
    const css = readFileSync(resolve(__dirname, 'organisms/LyricsView.module.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/scroll-behavior\s*:\s*smooth/i);
  });

  it('LyricsView рендерит кнопку перехода в Мою волну в боковом режиме и кнопку возврата в waveMode', () => {
    (player as any).currentTrack = sampleTrack;

    const sideHtml = renderWithQuery(
      createElement(LyricsView, { isVisible: true, waveMode: false, onExpandToWave: () => {} })
    );
    expect(sideHtml).toContain('Открыть большие тексты в Моей волне');
    expect(sideHtml).not.toContain('aria-label="Свернуть"');

    const waveHtml = renderWithQuery(
      createElement(LyricsView, { isVisible: true, waveMode: true, onCollapseFromWave: () => {} })
    );
    expect(waveHtml).toContain('aria-label="Свернуть"');
    expect(waveHtml).not.toContain('Открыть большие тексты в Моей волне');
  });
});

describe('MyWaveView current-queue big lyrics mode', () => {
  it('с preserveCurrentQueue + initialShowLyrics показывает текущий трек, бейдж Сейчас играет и открытую панель больших текстов без сброса очереди', () => {
    (player as any).currentTrack = sampleTrack;
    (player as any).isPlaying = true;
    (player as any).queueSourceId = 'playlist-liked';

    const html = renderWithQuery(
      createElement(MyWaveView, {
        initialShowLyrics: true,
        preserveCurrentQueue: true,
        launchNonce: 1,
        onCollapseLyrics: () => {},
      })
    );

    expect(html).toContain('Night Drive');
    expect(html).toContain('Сейчас играет');
    expect(html).toContain('lyricsPanelVisible');
    expect(html).toContain('aria-label="Свернуть"');
    expect(html).not.toContain('Выбери станцию слева');
  });

  it('при обычном открытии Моей волны без preserveCurrentQueue сохраняет прежний стартовый экран волны', () => {
    (player as any).currentTrack = sampleTrack;
    (player as any).isPlaying = true;
    (player as any).queueSourceId = 'playlist-liked';

    const html = renderWithQuery(createElement(MyWaveView, {}));

    expect(html).toContain('Выбери станцию слева');
    expect(html).not.toContain('Сейчас играет');
    expect(html).not.toContain('lyricsPanelVisible');
  });
});
