import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { YTMTrack } from '../api/yt';
import { TrackRow } from './molecules/TrackRow';
import { ArtistView } from './organisms/ArtistView';
import { PlayerBar } from './organisms/PlayerBar';
import { player } from '../api/player';
import { reloadLikedIndex, resetLikedIndexForTests } from '../api/likedIndex';
import { likedStore } from '../api/likedStore';
import {
  applyArtistTrackLikeStatus,
  resolveArtistTrackLikeStatus,
  selectDisplayedArtistSongs,
  type ArtistLikeLookup,
} from './organisms/artistLikeStatus';

const scMockState = { likedIds: new Set<string>() };
const yandexMockState = { likedIds: new Set<string>() };

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useSyncExternalStore: (sub: any, getSnap: any, getServerSnap?: any) =>
      actual.useSyncExternalStore(sub, getSnap, getServerSnap ?? getSnap),
  };
});

vi.mock('./atoms/Toast', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

vi.mock('../api/player', () => ({
  player: {
    currentTrack: null as YTMTrack | null,
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
    playTrackList: vi.fn(),
    playSingle: vi.fn(),
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
  likedManager: {
    toggleLike: vi.fn(),
    toggleDislike: vi.fn(),
    subscribe: () => () => {},
  },
}));

vi.mock('../api/scLikedManager', () => ({
  scLikedManager: {
    subscribe: () => () => {},
  },
}));

vi.mock('../api/likedStore', () => ({
  likedStore: {
    getAllTracks: vi.fn().mockResolvedValue([]),
    getAllScTracks: vi.fn().mockResolvedValue([]),
    getAllYandexTracks: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../api/localOverrides', () => ({
  getOverride: vi.fn().mockResolvedValue(undefined),
  onOverrideChanged: () => () => {},
}));

vi.mock('../api/stream', () => ({
  requestPrefetch: vi.fn(),
  cancelPrefetchRequest: vi.fn(),
}));

vi.mock('../utils/desktopLayout', () => ({
  isDeckLayout: () => false,
  subscribeDesktopLayout: () => () => {},
}));

vi.mock('../api/soundcloud', () => ({
  isSoundCloudId: (id: string | undefined | null) => !!id && id.includes('soundcloud.com'),
  getSoundCloudArtist: vi.fn().mockResolvedValue(null),
  isScTrackLiked: (scId: string | undefined) => !!scId && scMockState.likedIds.has(scId),
}));

vi.mock('../api/yandex', () => ({
  isYandexArtistId: (id: string | undefined | null) => !!id && id.startsWith('yandex:'),
  getYandexArtist: vi.fn().mockResolvedValue(null),
  getYandexAlbumTracks: vi.fn().mockResolvedValue(null),
  isYandexTrackLiked: (yandexId: string | undefined) => !!yandexId && yandexMockState.likedIds.has(yandexId),
}));

vi.mock('../api/yt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/yt')>();
  return {
    ...actual,
    getArtistDetail: vi.fn().mockResolvedValue(null),
    getArtistSongs: vi.fn().mockResolvedValue({ tracks: [], continuation: null }),
    getContinuation: vi.fn().mockResolvedValue({ tracks: [], continuation: null }),
    getAlbum: vi.fn().mockResolvedValue(null),
  };
});

function makeTrack(overrides: Partial<YTMTrack> & { id: string }): YTMTrack {
  return {
    title: 'Track',
    artists: ['dope17'],
    album: 'Album',
    duration: '2:30',
    thumbUrl: 'https://example.com/thumb.jpg',
    ...overrides,
  };
}

afterEach(() => {
  (player as any).currentTrack = null;
  scMockState.likedIds.clear();
  yandexMockState.likedIds.clear();
  resetLikedIndexForTests();
  vi.clearAllMocks();
});

describe('artistLikeStatus resolution', () => {
  it('promotes tracks matched in likedTrackIds to LIKE even when API omits or clears likeStatus', () => {
    const songs: YTMTrack[] = [
      makeTrack({ id: 'yt-server-liked', title: 'Server Liked', likeStatus: 'LIKE' }),
      makeTrack({ id: 'yt-missing-status', title: 'Missing Status', likeStatus: undefined }),
      makeTrack({ id: 'yt-indifferent', title: 'Stale Indifferent', likeStatus: 'INDIFFERENT' }),
      makeTrack({ id: 'yt-unliked', title: 'Not Liked', likeStatus: 'INDIFFERENT' }),
    ];
    const lookup: ArtistLikeLookup = {
      likedTrackIds: new Set(['yt-missing-status', 'yt-indifferent']),
    };

    const filtered = selectDisplayedArtistSongs(songs, true, lookup);
    expect(filtered.map(t => t.id)).toEqual([
      'yt-server-liked',
      'yt-missing-status',
      'yt-indifferent',
    ]);
    // Каждый трек в фильтре "Likes only" обязан иметь likeStatus === 'LIKE' для отображения сердечка.
    expect(filtered.every(t => t.likeStatus === 'LIKE')).toBe(true);

    const allResolved = selectDisplayedArtistSongs(songs, false, lookup);
    expect(allResolved.map(t => [t.id, t.likeStatus])).toEqual([
      ['yt-server-liked', 'LIKE'],
      ['yt-missing-status', 'LIKE'],
      ['yt-indifferent', 'LIKE'],
      ['yt-unliked', 'INDIFFERENT'],
    ]);
  });

  it('preserves server LIKE when local liked mirror is empty', () => {
    const track = makeTrack({ id: 'yt-1', likeStatus: 'LIKE' });
    const lookup: ArtistLikeLookup = { likedTrackIds: new Set() };
    expect(resolveArtistTrackLikeStatus(track, lookup)).toBe('LIKE');
  });

  it('gives live track-like-updated overrides top precedence over stale API and store entries', () => {
    const songs: YTMTrack[] = [
      makeTrack({ id: 'yt-unliked-live', likeStatus: 'LIKE' }),
      makeTrack({ id: 'yt-disliked-live', likeStatus: 'LIKE' }),
      makeTrack({ id: 'yt-liked-live', likeStatus: undefined }),
    ];
    const lookup: ArtistLikeLookup = {
      likedTrackIds: new Set(['yt-unliked-live', 'yt-disliked-live']),
      overrides: {
        'yt-unliked-live': 'INDIFFERENT',
        'yt-disliked-live': 'DISLIKE',
        'yt-liked-live': 'LIKE',
      },
    };

    const allResolved = selectDisplayedArtistSongs(songs, false, lookup);
    expect(allResolved.map(t => [t.id, t.likeStatus])).toEqual([
      ['yt-unliked-live', 'INDIFFERENT'],
      ['yt-disliked-live', 'DISLIKE'],
      ['yt-liked-live', 'LIKE'],
    ]);

    const likesOnly = selectDisplayedArtistSongs(songs, true, lookup);
    expect(likesOnly.map(t => t.id)).toEqual(['yt-liked-live']);
    expect(likesOnly[0].likeStatus).toBe('LIKE');
  });

  it('resolves SoundCloud and Yandex liked tracks by store IDs, track IDs, and in-memory sets', () => {
    const scByScId = makeTrack({
      id: 'https://soundcloud.com/dope17/song-a',
      source: 'soundcloud',
      scId: '101',
      likeStatus: undefined,
    });
    const scByMemory = makeTrack({
      id: 'https://soundcloud.com/dope17/song-b',
      source: 'soundcloud',
      scId: '102',
      likeStatus: undefined,
    });
    const yxByYandexId = makeTrack({
      id: 'yandex:201',
      source: 'yandex',
      yandexId: '201',
      likeStatus: undefined,
    });
    const yxByMemory = makeTrack({
      id: 'yandex:202',
      source: 'yandex',
      yandexId: '202',
      likeStatus: undefined,
    });
    const unlikedSc = makeTrack({
      id: 'https://soundcloud.com/dope17/song-c',
      source: 'soundcloud',
      scId: '103',
      likeStatus: undefined,
    });

    const lookup: ArtistLikeLookup = {
      likedTrackIds: new Set(),
      likedScIds: new Set(['101']),
      likedYandexIds: new Set(['201']),
      isScLiked: (scId) => scId === '102',
      isYandexLiked: (yandexId) => yandexId === '202',
    };

    const filtered = selectDisplayedArtistSongs(
      [scByScId, scByMemory, yxByYandexId, yxByMemory, unlikedSc],
      true,
      lookup,
    );
    expect(filtered.map(t => t.id)).toEqual([
      scByScId.id,
      scByMemory.id,
      yxByYandexId.id,
      yxByMemory.id,
    ]);
    expect(filtered.every(t => t.likeStatus === 'LIKE')).toBe(true);
  });

  it('keeps referential stability when track likeStatus does not change', () => {
    const a = makeTrack({ id: 'a', likeStatus: 'LIKE' });
    const b = makeTrack({ id: 'b', likeStatus: undefined });
    const list = [a, b];

    const unchanged = applyArtistTrackLikeStatus(list, { likedTrackIds: new Set(['a']) });
    expect(unchanged).toBe(list);
    expect(unchanged[0]).toBe(a);
    expect(unchanged[1]).toBe(b);

    const partial = applyArtistTrackLikeStatus(list, { likedTrackIds: new Set(['a', 'b']) });
    expect(partial).not.toBe(list);
    expect(partial[0]).toBe(a);
    expect(partial[1]).not.toBe(b);
    expect(partial[1].likeStatus).toBe('LIKE');
  });
});

describe('visual heart icon rendering for artist tracks', () => {
  it('renders filled heart in TrackRow for tracks promoted via likedTrackIds', () => {
    const rawSong = makeTrack({ id: 'yt-dope17-1', title: 'dope17 track', likeStatus: undefined });
    const [resolvedSong] = selectDisplayedArtistSongs([rawSong], true, {
      likedTrackIds: new Set(['yt-dope17-1']),
    });

    const client = new QueryClient();
    const markup = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          'table',
          null,
          createElement(
            'tbody',
            null,
            createElement(TrackRow, { index: 1, ...resolvedSong }),
          ),
        ),
      ),
    );
    client.clear();

    expect(markup).toContain('aria-label="Unlike"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('fill="var(--danger)"');
  });

  it('renders filled heart in ArtistView Top Songs when cached track has undefined likeStatus but is liked', () => {
    const artistId = 'https://soundcloud.com/dope17';
    scMockState.likedIds.add('777');

    const client = new QueryClient();
    client.setQueryData(['artist', artistId], {
      name: 'dope17',
      thumbUrl: 'https://example.com/artist.jpg',
      isSoundCloud: true,
      topSongs: [
        makeTrack({
          id: 'https://soundcloud.com/dope17/cached-track',
          title: 'Cached Track',
          source: 'soundcloud',
          scId: '777',
          likeStatus: undefined,
        }),
      ],
      allTracks: [
        makeTrack({
          id: 'https://soundcloud.com/dope17/cached-track',
          title: 'Cached Track',
          source: 'soundcloud',
          scId: '777',
          likeStatus: undefined,
        }),
      ],
      scAlbums: [],
      scPlaylists: [],
      related: [],
    });

    const markup = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(ArtistView, {
          artistId,
          onSelectArtist: vi.fn(),
          onSelectAlbum: vi.fn(),
          onSelectPlaylist: vi.fn(),
          onSheetBackChange: vi.fn(),
        }),
      ),
    );
    client.clear();

    expect(markup).toContain('Cached Track');
    expect(markup).toContain('aria-label="Unlike"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('fill="var(--danger)"');
  });

  it('renders filled heart in PlayerBar when currentTrack has undefined likeStatus but is in likedStore', async () => {
    vi.mocked(likedStore.getAllTracks).mockResolvedValueOnce([
      { trackId: 'Lojtv9DCqdA', originalIndex: 0, syncedAt: 1 },
    ]);
    await reloadLikedIndex();

    (player as any).currentTrack = makeTrack({
      id: 'Lojtv9DCqdA',
      title: 'ESCORT',
      artists: ['Nikitata'],
      likeStatus: undefined,
    });

    const client = new QueryClient();
    const markup = renderToStaticMarkup(
      createElement(QueryClientProvider, { client }, createElement(PlayerBar)),
    );
    client.clear();

    expect(markup).toContain('ESCORT');
    expect(markup).toContain('aria-label="Unlike"');
    expect(markup).toContain('data-tooltip="Unlike"');
    expect(markup).toContain('fill="var(--danger)"');
  });
});
