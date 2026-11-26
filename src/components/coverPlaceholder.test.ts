import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CoverPlaceholder } from './atoms/CoverPlaceholder';
import { LazyImage, shouldRequestLazyImageLoad } from './atoms/LazyImage';
import { TrackRow } from './molecules/TrackRow';
import { QueueItem } from './molecules/QueueItem';
import { PlayerBar } from './organisms/PlayerBar';
import { TrackOverrideDialog } from './organisms/TrackOverrideDialog';
import HistoryCharts, { resolveLegendImageSrc } from './organisms/HistoryCharts';
import { player } from '../api/player';

vi.mock('react-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-dom')>();
  return {
    ...actual,
    createPortal: (node: React.ReactNode) => node,
  };
});

vi.mock('./atoms/Toast', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

vi.mock('../api/player', () => ({
  player: {
    currentTrack: null as any,
    isPlaying: false,
    isStreamLoading: false,
    queueSourceId: null,
    queueSourceType: null,
    currentTime: 0,
    duration: 0,
    buffered: [],
    loop: null,
    volume: 80,
    autoplay: false,
    shuffle: false,
    repeat: 'off',
    hasStreamError: false,
    errorSkipCount: 0,
    subscribe: () => () => {},
    togglePlay: vi.fn(),
    toggleMute: vi.fn(),
    toggleAutoplay: vi.fn(),
    toggleShuffle: vi.fn(),
    toggleRepeat: vi.fn(),
    setVolume: vi.fn(),
    seek: vi.fn(),
    setLoop: vi.fn(),
    prev: vi.fn(),
    next: vi.fn(),
    rateCurrentTrack: vi.fn(),
  },
}));

vi.mock('../api/likedManager', () => ({
  likedManager: { toggleLike: vi.fn(), toggleDislike: vi.fn() },
}));

vi.mock('../api/localOverrides', () => ({
  getOverride: vi.fn().mockResolvedValue(undefined),
  onOverrideChanged: () => () => {},
  setOverride: vi.fn(),
  deleteOverride: vi.fn(),
  songFileId: (id: string) => id,
}));

vi.mock('../api/stream', () => ({
  requestPrefetch: vi.fn(),
  cancelPrefetchRequest: vi.fn(),
}));

vi.mock('../utils/desktopLayout', () => ({
  isDeckLayout: () => false,
  subscribeDesktopLayout: () => () => {},
}));

vi.mock('../api/yt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/yt')>();
  return {
    ...actual,
    getArtistDetail: vi.fn().mockResolvedValue(null),
  };
});

afterEach(() => {
  (player as any).currentTrack = null;
  vi.clearAllMocks();
});

describe('CoverPlaceholder and cover fallbacks', () => {
  it('renders CoverPlaceholder with music icon and optional fixed size', () => {
    const proportional = renderToStaticMarkup(createElement(CoverPlaceholder));
    expect(proportional).toContain('data-cover-placeholder=""');
    expect(proportional).toContain('aria-hidden="true"');
    expect(proportional).toContain('<svg');

    const fixed = renderToStaticMarkup(createElement(CoverPlaceholder, { iconSize: 18, className: 'custom-slot' }));
    expect(fixed).toContain('custom-slot');
    expect(fixed).toContain('width="18"');
    expect(fixed).toContain('height="18"');
  });

  it('renders CoverPlaceholder immediately in LazyImage when src is empty or whitespace', () => {
    for (const emptySrc of ['', '   ', undefined]) {
      const markup = renderToStaticMarkup(createElement(LazyImage, { src: emptySrc, alt: '' }));
      expect(markup).toContain('data-cover-placeholder=""');
      expect(markup).toContain('<svg');
      expect(markup).not.toContain('<img');
    }

    const customFallback = renderToStaticMarkup(
      createElement(LazyImage, { src: '', alt: '', fallback: createElement('span', { 'data-custom': 'yes' }) })
    );
    expect(customFallback).toContain('data-custom="yes"');
    expect(customFallback).not.toContain('data-cover-placeholder=""');

    const withSrc = renderToStaticMarkup(
      createElement(LazyImage, { src: 'https://example.com/cover.jpg', alt: '' })
    );
    expect(withSrc).not.toContain('data-cover-placeholder=""');
  });

  it('always renders cover wrapper, CoverPlaceholder, and SourceBadge in TrackRow even when thumbUrl is empty', () => {
    const client = new QueryClient();
    const scMarkup = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          'table',
          null,
          createElement(
            'tbody',
            null,
            createElement(TrackRow, {
              id: 'https://soundcloud.com/u/t',
              index: 1,
              title: 'No Cover SC',
              artists: ['Artist'],
              album: 'SoundCloud',
              duration: '3:12',
              thumbUrl: '',
              source: 'soundcloud',
            })
          )
        )
      )
    );
    expect(scMarkup).toContain('data-cover-placeholder=""');
    expect(scMarkup).toContain('data-tooltip="SoundCloud"');

    const ytMarkup = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          'table',
          null,
          createElement(
            'tbody',
            null,
            createElement(TrackRow, {
              id: 'dQw4w9WgXcQ',
              index: 2,
              title: 'No Cover YT',
              artists: ['Artist'],
              album: 'Album',
              duration: '3:00',
              thumbUrl: undefined,
              source: 'youtube',
            })
          )
        )
      )
    );
    expect(ytMarkup).toContain('data-cover-placeholder=""');
    client.clear();
  });

  it('renders CoverPlaceholder in QueueItem when thumbUrl is missing', () => {
    const client = new QueryClient();
    const markup = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(QueueItem, {
          id: 'sc-1',
          index: 0,
          title: 'Queue Track',
          artists: ['Artist'],
          thumbUrl: '',
          source: 'soundcloud',
        })
      )
    );
    expect(markup).toContain('data-cover-placeholder=""');
    expect(markup).toContain('width="18"');
    expect(markup).toContain('data-tooltip="SoundCloud"');
    client.clear();
  });

  it('keeps PlayerBar empty slot iconless with no track, and shows CoverPlaceholder when current track lacks thumbUrl', () => {
    const client = new QueryClient();

    (player as any).currentTrack = null;
    const idleMarkup = renderToStaticMarkup(
      createElement(QueryClientProvider, { client }, createElement(PlayerBar))
    );
    expect(idleMarkup).not.toContain('data-cover-placeholder=""');

    (player as any).currentTrack = {
      id: 'https://soundcloud.com/u/t',
      title: 'Coverless Track',
      artists: ['Artist'],
      album: 'SoundCloud',
      duration: '2:45',
      thumbUrl: '',
      source: 'soundcloud',
    };
    const activeMarkup = renderToStaticMarkup(
      createElement(QueryClientProvider, { client }, createElement(PlayerBar))
    );
    expect(activeMarkup).toContain('data-cover-placeholder=""');
    expect(activeMarkup).toContain('width="22"');
    client.clear();
  });

  it('renders CoverPlaceholder in HistoryCharts legend when artwork is missing', () => {
    const markup = renderToStaticMarkup(
      createElement(HistoryCharts, {
        rawHistory: [
          {
            timestamp: Date.now(),
            listenedSeconds: 180,
            track: {
              id: 'sc-1',
              title: 'No Cover',
              artists: ['Artist'],
              album: '',
              duration: '3:00',
              thumbUrl: '',
              source: 'soundcloud',
            },
          } as any,
        ],
        onClose: () => {},
      })
    );
    expect(markup).toContain('data-cover-placeholder=""');
    expect(markup).toContain('width="16"');
  });

  it('renders CoverPlaceholder in TrackOverrideDialog header when track thumbUrl is empty', () => {
    vi.stubGlobal('document', { body: {} });
    const markup = renderToStaticMarkup(
      createElement(TrackOverrideDialog, {
        track: {
          id: 'https://soundcloud.com/u/t',
          title: 'Coverless Track',
          artists: ['Artist'],
          album: 'SoundCloud',
          duration: '2:10',
          thumbUrl: '',
          source: 'soundcloud',
        },
        isOpen: true,
        onClose: () => {},
      })
    );
    expect(markup).toContain('data-cover-placeholder=""');
    expect(markup).toContain('width="18"');
    vi.unstubAllGlobals();
  });

  it('falls back from whitespace-only or failed artistThumb to track image in HistoryCharts', () => {
    const failed = new Set<string>(['https://cdn.example/broken-artist.jpg']);

    expect(
      resolveLegendImageSrc('artist', '   ', 'https://cdn.example/track.jpg', failed)
    ).toBe('https://cdn.example/track.jpg');

    expect(
      resolveLegendImageSrc('artist', 'https://cdn.example/broken-artist.jpg', 'https://cdn.example/track.jpg', failed)
    ).toBe('https://cdn.example/track.jpg');

    expect(
      resolveLegendImageSrc('artist', '  https://cdn.example/artist.jpg  ', 'https://cdn.example/track.jpg', failed)
    ).toBe('https://cdn.example/artist.jpg');

    failed.add('https://cdn.example/track.jpg');
    expect(
      resolveLegendImageSrc('artist', '   ', 'https://cdn.example/track.jpg', failed)
    ).toBe('');
  });

  it('blocks LazyImage re-enqueue while retry backoff or error fallback is active', () => {
    expect(
      shouldRequestLazyImageLoad({
        isIntersecting: true,
        isAllowedToLoad: false,
        isLoaded: false,
        hasSrc: true,
        isRetrying: false,
        showErrorState: false,
        showFallback: false,
      })
    ).toBe(true);

    expect(
      shouldRequestLazyImageLoad({
        isIntersecting: true,
        isAllowedToLoad: false,
        isLoaded: false,
        hasSrc: true,
        isRetrying: true,
        showErrorState: false,
        showFallback: false,
      })
    ).toBe(false);

    expect(
      shouldRequestLazyImageLoad({
        isIntersecting: true,
        isAllowedToLoad: false,
        isLoaded: false,
        hasSrc: true,
        isRetrying: false,
        showErrorState: true,
        showFallback: false,
      })
    ).toBe(false);
  });
});
