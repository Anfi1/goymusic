import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { likedStore, type LikedEntry, type YtImportSnapshot, type YtImportState, YT_IMPORT_VERSION } from './likedStore';
import { tracksStore } from './tracks';
import { likedManager, likedSyncLabel, getPendingScLikeChanges, clearPendingScLikeQueue, whenScLikeQueueIdle } from './likedManager';
import type { YTMTrack } from './yt';
import { likedPlaylistTracks } from '../hooks/likedPlaylistTracks';

// The renderer singleton reads its preference once, during module initialization.
vi.hoisted(() => vi.stubGlobal('localStorage', { getItem: () => null }));

const scMocks = vi.hoisted(() => {
  let disconnectHook: (() => void) | null = null;
  let pendingProvider: (() => Map<string, unknown>) | null = null;
  return {
    isScAuthed: vi.fn(() => false),
    scSetLiked: vi.fn(async () => true),
    setScLikedInMemory: vi.fn(),
    registerScDisconnectHook: vi.fn((hook: () => void) => {
      disconnectHook = hook;
      return () => { if (disconnectHook === hook) disconnectHook = null; };
    }),
    getDisconnectHook: () => disconnectHook,
    addLocal: vi.fn(async () => {}),
    removeLocal: vi.fn(async () => {}),
    registerScPendingChangesProvider: vi.fn((provider: () => Map<string, unknown>) => {
      pendingProvider = provider;
    }),
    getPendingProvider: () => pendingProvider,
  };
});

vi.mock('./soundcloud', () => ({
  isScAuthed: scMocks.isScAuthed,
  scSetLiked: scMocks.scSetLiked,
  setScLikedInMemory: scMocks.setScLikedInMemory,
  registerScDisconnectHook: scMocks.registerScDisconnectHook,
}));
vi.mock('./yandex', () => ({}));
vi.mock('./scLikedManager', () => ({
  scLikedManager: {
    addLocal: scMocks.addLocal,
    removeLocal: scMocks.removeLocal,
  },
  registerScPendingChangesProvider: scMocks.registerScPendingChangesProvider,
}));

const song = (id: string): YTMTrack => ({ id, title: id, album: 'Fixture album', duration: '2:30', thumbUrl: '' });
const [a, b, c] = ['a', 'b', 'c'].map(song);
const pyCall = vi.fn();
let committed: LikedEntry[];
let metadata: Map<string, YTMTrack>;

beforeEach(() => {
  vi.stubGlobal('window', { bridge: { pyCall }, dispatchEvent: vi.fn(), setTimeout: vi.fn() });
  pyCall.mockReset();
  committed = [a, b, c].map((t, originalIndex) => ({ trackId: t.id, originalIndex, syncedAt: 1 }));
  metadata = new Map([a, b, c].map(t => [t.id, t]));
  vi.spyOn(likedStore, 'getAllTracks').mockImplementation(async () => committed);
  vi.spyOn(likedStore, 'getVirtualCount').mockResolvedValue(3);
  let checkpoint: YtImportState | null = null;
  let snapshot: YtImportSnapshot | null = null;
  const staged: LikedEntry[] = [];
  vi.spyOn(likedStore, 'getYtImportState').mockImplementation(async () => checkpoint);
  vi.spyOn(likedStore, 'getYtImportTracks').mockImplementation(async () => [...staged]);
  let completedVersion = 1;
  vi.spyOn(likedStore, 'getYtImportCompletedVersion').mockImplementation(async () => completedVersion);
  vi.spyOn(likedStore, 'getYtImportSnapshot').mockImplementation(async () => snapshot);
  vi.spyOn(likedStore, 'saveYtImportPage').mockImplementation(async (entries, state) => {
    staged.push(...entries);
    checkpoint = state;
  });
  vi.spyOn(likedStore, 'setYtImportState').mockImplementation(async state => { checkpoint = state; });
  vi.spyOn(likedStore, 'clearYtImport').mockImplementation(async () => { staged.length = 0; checkpoint = null; });
  vi.spyOn(likedStore, 'commitYtImport').mockImplementation(async (entries, _, nextSnapshot) => {
    committed = entries;
    completedVersion = YT_IMPORT_VERSION;
    snapshot = nextSnapshot;
    staged.length = 0;
    checkpoint = null;
  });
  vi.spyOn(tracksStore, 'upsertTracksBatch').mockImplementation(async tracks => {
    for (const t of tracks) metadata.set(t.id, t);
  });
  vi.spyOn(tracksStore, 'getTracks').mockImplementation(async ids =>
    new Map(ids.filter(id => metadata.has(id)).map(id => [id, metadata.get(id)!])));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Exercise the real IPC adapter, sync and hydration/selection used by usePlaylist.
async function refresh() {
  const snapshots: string[][] = [];
  const stop = likedManager.subscribe(entries => snapshots.push(entries.map(e => e.trackId)));
  try { await likedManager.sync(); } finally { stop(); }
  const local = await likedStore.hydrateTracks(committed);
  return { visible: likedPlaylistTracks(local, undefined, []).map(t => t.id), snapshots };
}

describe('Liked Songs mirror', () => {
  it('checks an up-to-date mirror without reporting the cached rows as newly imported', async () => {
    const head = { status: 'ok', tracks: [a, b], trackCount: 3, continuation: 'next' };
    pyCall.mockResolvedValueOnce(head).mockResolvedValueOnce({ status: 'ok', tracks: [c] });
    expect((await refresh()).visible).toEqual(['a', 'b', 'c']);
    pyCall.mockResolvedValueOnce(head);
    const phases: string[] = [];
    const stop = likedManager.subscribeProgress(() => phases.push(likedManager.getProgress().phase));
    try {
      await refresh();
      expect(phases).toEqual(['checking', 'idle']);
      expect(pyCall).toHaveBeenCalledTimes(3);
    } finally { stop(); }
  });

  it('checks only the first page on reopen after a completed short import, then refreshes on change or expiry', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(100);
    const head = { status: 'ok', tracks: [a], trackCount: 9, continuation: 'next' };
    const tail = { status: 'ok', tracks: [b] };
    pyCall.mockResolvedValueOnce(head).mockResolvedValueOnce(tail);
    expect((await refresh()).visible).toEqual(['a', 'b', 'c']);

    clock.mockReturnValue(100 + 5 * 60 * 1000);
    pyCall.mockResolvedValueOnce({ ...head, continuation: 'rotated' });
    expect((await refresh()).visible).toEqual(['a', 'b', 'c']);
    expect(pyCall.mock.calls.map(([command]) => command)).toEqual([
      'get_playlist_tracks', 'get_continuation', 'get_playlist_tracks',
    ]);

    const changed = { ...head, tracks: [song('new'), a] };
    pyCall.mockResolvedValueOnce(changed).mockResolvedValueOnce(tail);
    expect((await refresh()).visible).toEqual(['new', 'a', 'b', 'c']);

    clock.mockReturnValue(100 + 21 * 60 * 1000);
    pyCall.mockResolvedValueOnce(changed).mockResolvedValueOnce({ status: 'ok', tracks: [c, b] });
    expect((await refresh()).visible).toEqual(['new', 'a', 'c', 'b']);
  });

  it('reports saved YouTube pages during a refresh without counting the visible cache', async () => {
    const labels: (string | null)[] = [];
    const stop = likedManager.subscribeProgress(() => labels.push(likedSyncLabel(likedManager.getProgress())));
    const whileSaving: (string | null)[] = [];
    vi.mocked(likedStore.saveYtImportPage).mockImplementation(async () => {
      whileSaving.push(likedSyncLabel(likedManager.getProgress()));
    });
    pyCall.mockResolvedValueOnce({ status: 'ok', tracks: [a], trackCount: 4, unavailableCount: 1, continuation: 'next' })
      .mockResolvedValueOnce({ status: 'ok', tracks: [b, c] });
    try {
      const refreshing = refresh();
      // A second caller must not reset progress or start a competing import.
      await likedManager.sync();
      const { snapshots } = await refreshing;
      expect(snapshots.every(ids => ids.join() === 'a,b,c')).toBe(true);
      expect(pyCall).toHaveBeenCalledTimes(2);
      expect(whileSaving).toEqual(['Checking YouTube likes…', 'Syncing YouTube likes: 2 of 4']);
      expect(labels).toEqual([
        'Checking YouTube likes…', 'Syncing YouTube likes: 2 of 4', 'Syncing YouTube likes: 4 of 4',
        'Saving YouTube likes…', null,
      ]);
    } finally { stop(); }
  });

  it('restores checkpoint progress, leaves an unknown total unknown, and stops on failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(likedStore.getYtImportState).mockResolvedValue({
      version: YT_IMPORT_VERSION, status: 'importing', ytTotal: null, unavailableCount: 1,
      downloadedCount: 2, continuation: 'checkpoint', headIds: ['a'], headUnavailableCount: 0, startedAt: 1, updatedAt: 2,
    });
    vi.mocked(likedStore.getYtImportTracks).mockResolvedValue(committed.slice(0, 2));
    pyCall.mockResolvedValueOnce({ status: 'ok', tracks: [a], continuation: 'first-page' })
      .mockResolvedValueOnce({ status: 'error', message: 'offline' });
    const labels: (string | null)[] = [];
    const stop = likedManager.subscribeProgress(() => labels.push(likedSyncLabel(likedManager.getProgress())));
    try {
      expect((await refresh()).visible).toEqual(['a', 'b', 'c']);
      expect(pyCall.mock.calls[1][1].token).toBe('checkpoint');
      expect(labels).toEqual(['Checking YouTube likes…', 'Syncing YouTube likes: 3 processed', 'YouTube likes sync failed']);
      expect(likedStore.commitYtImport).not.toHaveBeenCalled();
    } finally { stop(); }
  });

  it('resumes a failed last request without downloading earlier pages again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const head = { status: 'ok', tracks: [a], trackCount: 3, continuation: 'middle' };
    pyCall.mockResolvedValueOnce(head)
      .mockResolvedValueOnce({ status: 'ok', tracks: [c], continuation: 'last' })
      .mockResolvedValueOnce({ status: 'error', message: 'offline' });
    expect((await refresh()).visible).toEqual(['a', 'b', 'c']);
    pyCall.mockResolvedValueOnce(head)
      .mockResolvedValueOnce({ status: 'ok', tracks: [song('new')], continuation: null });
    expect((await refresh()).visible).toEqual(['a', 'c', 'new']);
    expect(pyCall.mock.calls[4][1].token).toBe('last');
  });

  it('restarts from a fresh cursor when the saved one is rejected again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const head = { status: 'ok', tracks: [b], trackCount: 2, continuation: 'expired' };
    const fresh = { ...head, continuation: 'fresh' };
    const error = { status: 'error', message: 'cursor unavailable' };
    pyCall.mockResolvedValueOnce(head).mockResolvedValueOnce(error);
    expect((await refresh()).visible).toEqual(['a', 'b', 'c']);
    pyCall.mockResolvedValueOnce(fresh).mockResolvedValueOnce(error);
    expect((await refresh()).visible).toEqual(['a', 'b', 'c']);
    pyCall.mockResolvedValueOnce(fresh).mockResolvedValueOnce({ status: 'ok', tracks: [c], continuation: null });
    expect((await refresh()).visible).toEqual(['b', 'c']);
    expect([1, 3, 5].map(i => pyCall.mock.calls[i][1].token)).toEqual(['expired', 'expired', 'fresh']);
  });

  it('does not resume a continuation cycle', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const head = { status: 'ok', tracks: [b], trackCount: 2, continuation: 'loop' };
    pyCall.mockResolvedValueOnce(head).mockResolvedValueOnce({ status: 'ok', tracks: [c], continuation: 'loop' });
    expect((await refresh()).visible).toEqual(['a', 'b', 'c']);
    pyCall.mockResolvedValueOnce({ ...head, continuation: 'fresh' })
      .mockResolvedValueOnce({ status: 'ok', tracks: [a], continuation: null });
    expect((await refresh()).visible).toEqual(['b', 'a']);
    expect(pyCall.mock.calls[3][1].token).toBe('fresh');
  });

  it('follows a cursor-only page and commits at the explicit end of a complete playlist', async () => {
    pyCall.mockResolvedValueOnce({ status: 'ok', tracks: [b], trackCount: 2, continuation: 'middle' })
      .mockResolvedValueOnce({ status: 'ok', tracks: [], unavailableCount: 0, continuation: 'last' })
      .mockResolvedValueOnce({ status: 'ok', tracks: [c], unavailableCount: 0, continuation: 'end' })
      .mockResolvedValueOnce({ status: 'ok', tracks: [], unavailableCount: 0, continuation: null });
    expect((await refresh()).visible).toEqual(['b', 'c']);
  });

  it('repairs a one-row v1 mirror whose saved virtual count already matches YouTube', async () => {
    committed = committed.slice(0, 1);
    metadata.delete('b'); metadata.delete('c');
    pyCall.mockResolvedValueOnce({ status: 'ok', tracks: [a, b], trackCount: 3, continuation: 'next' })
      .mockResolvedValueOnce({ status: 'ok', tracks: [c], continuation: null });
    expect((await refresh()).visible).toEqual(['a', 'b', 'c']);
    expect(pyCall.mock.calls.map(([command]) => command)).toEqual(['get_playlist_tracks', 'get_continuation']);
    expect(likedStore.commitYtImport).toHaveBeenCalledOnce();
    expect(committed.every(entry => entry.likedAt === undefined)).toBe(true);
  });

  it.each([false, true])('repairs v2 mirrors without trusting v2 checkpoints (checkpoint: %s)', async withCheckpoint => {
    vi.mocked(likedStore.getYtImportCompletedVersion).mockResolvedValue(2);
    committed[0].likedAt = 123;
    committed[1] = { ...committed[1], trackId: 'old' };
    if (withCheckpoint) {
      // Persisted before the parser could recover b from its playlist row.
      vi.mocked(likedStore.getYtImportState).mockResolvedValue({
        version: 2, status: 'importing', ytTotal: 3, unavailableCount: 1,
        downloadedCount: 1, continuation: 'old-last', headIds: ['a'], startedAt: 1, updatedAt: 2,
      } as unknown as YtImportState);
      vi.mocked(likedStore.getYtImportTracks).mockResolvedValue(committed.slice(0, 1));
    }
    pyCall.mockResolvedValueOnce({ status: 'ok', tracks: [a], trackCount: 3, continuation: 'middle' })
      .mockImplementationOnce(async (_, { token }) => token === 'middle'
        ? { status: 'ok', tracks: [b], continuation: 'last' }
        : { status: 'ok', tracks: [c], continuation: null })
      .mockResolvedValueOnce({ status: 'ok', tracks: [c], continuation: null });
    expect((await refresh()).visible).toEqual(['a', 'b', 'c']);
    expect(committed.map(entry => entry.likedAt)).toEqual([123, committed[1].syncedAt, undefined]);
  });

  it.each(['eleventh ID', 'unavailable count'])('rejects a checkpoint when the first page changes its %s', async change => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const prefix = Array.from({ length: 10 }, (_, i) => song(`head-${i}`));
    const head = { status: 'ok', tracks: [...prefix, a], trackCount: 12, continuation: 'old',
      unavailableCount: change === 'unavailable count' ? 1 : 0 };
    pyCall.mockResolvedValueOnce(head).mockResolvedValueOnce({ status: 'error', message: 'offline' });
    await refresh();
    const tracks = [...prefix, change === 'eleventh ID' ? b : a];
    pyCall.mockResolvedValueOnce({ ...head, tracks, unavailableCount: 0, continuation: 'fresh' })
      .mockResolvedValueOnce({ status: 'ok', tracks: [c], continuation: null });
    expect((await refresh()).visible).toEqual([...tracks.map(t => t.id), 'c']);
    expect(pyCall.mock.calls[3][1].token).toBe('fresh');
  });

  it('does not skip an unavailable row newly reported in the first page', async () => {
    vi.mocked(likedStore.getYtImportCompletedVersion).mockResolvedValue(YT_IMPORT_VERSION);
    pyCall.mockResolvedValueOnce({ status: 'ok', tracks: [a], trackCount: 3, unavailableCount: 1, continuation: 'next' })
      .mockResolvedValueOnce({ status: 'ok', tracks: [c], continuation: null });
    expect((await refresh()).visible).toEqual(['a', 'c']);
  });

  it.each([false, true])('imports every returned page when the header overcounts (cached: %s)', async cached => {
    if (!cached) committed = [];
    pyCall.mockResolvedValueOnce({ status: 'ok', tracks: [a, b], trackCount: 7, continuation: 'last' })
      .mockResolvedValueOnce({ status: 'ok', tracks: [b, song('new')], unavailableCount: 0, continuation: null });
    const { visible } = await refresh();
    expect(visible).toEqual(cached ? ['a', 'b', 'new', 'c'] : ['a', 'b', 'new']);
    expect(likedManager.getProgress().phase).toBe('idle');
    expect(likedStore.commitYtImport).toHaveBeenCalledWith(expect.any(Array), 3, expect.any(Object));
  });

  it.each([{ tail: [] }, { tail: [b] }])('keeps cached likes after a short empty or overlapping last page (%#)', async ({ tail }) => {
    pyCall.mockResolvedValueOnce({ status: 'ok', tracks: [a, b], trackCount: 4, continuation: 'end' })
      .mockResolvedValueOnce({ status: 'ok', tracks: tail, unavailableCount: 0, continuation: null });
    expect((await refresh()).visible).toEqual(['a', 'b', 'c']);
    expect(likedManager.getProgress().phase).toBe('idle');
  });

  it.each([
    [{ status: 'error', message: 'not authenticated' }],
    [{ status: 'ok', tracks: [a], trackCount: 9 }],
    [{ status: 'ok', tracks: [a], trackCount: null }],
    [{ status: 'ok', tracks: [a], trackCount: 4, continuation: 'next' }, { status: 'error' }],
  ])('never publishes a partial replacement on an incomplete refresh (%#)', async (...[first, next]) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    pyCall.mockResolvedValueOnce(first);
    if (next) pyCall.mockResolvedValueOnce(next);
    const { visible, snapshots } = await refresh();
    expect(visible).toEqual(['a', 'b', 'c']);
    expect(snapshots.every(ids => ids.join() === 'a,b,c')).toBe(true);
    expect(likedStore.commitYtImport).not.toHaveBeenCalled();
  });

  it.each(['like', 'dislike'] as const)('does not undo an album %s while a continuation is in flight', async action => {
    const albumTrack = song('album-track');
    if (action === 'like') committed = []; // first import; the pending LM snapshot predates our new like
    else committed = [{ trackId: albumTrack.id, originalIndex: 0, syncedAt: 1 }];
    metadata.set(albumTrack.id, albumTrack);
    vi.stubGlobal('CustomEvent', class {});
    vi.spyOn(likedStore, 'getMinIndex').mockResolvedValue(0);
    vi.spyOn(likedStore, 'setVirtualCount').mockResolvedValue(undefined);
    vi.spyOn(tracksStore, 'upsertTrack').mockImplementation(async t => { metadata.set(t.id, t); });
    vi.spyOn(likedStore, 'putTrack').mockImplementation(async entry => { committed = [entry, ...committed]; });
    vi.spyOn(likedStore, 'deleteTrack').mockImplementation(async id => { committed = committed.filter(e => e.trackId !== id); });
    let success = false;
    pyCall.mockResolvedValueOnce({ status: 'ok', tracks: [a], trackCount: 2, continuation: 'next' })
      .mockImplementationOnce(async () => {
        success = action === 'like'
          ? await likedManager.toggleLike(albumTrack, 'INDIFFERENT')
          : await likedManager.toggleDislike(albumTrack, 'LIKE');
        return { status: 'ok', tracks: [action === 'like' ? b : albumTrack], continuation: null };
      })
      .mockResolvedValueOnce({ status: 'ok' });
    const { visible } = await refresh();
    expect(success).toBe(true);
    expect(visible).toEqual(action === 'like' ? [albumTrack.id] : []);
    expect(likedStore.commitYtImport).not.toHaveBeenCalled();
    expect(likedStore.clearYtImport).toHaveBeenCalledOnce();
  });

  it('accepts authoritative removals and explicitly unavailable rows', async () => {
    pyCall.mockResolvedValueOnce({ status: 'ok', tracks: [c], trackCount: 2, unavailableCount: 1 });
    expect((await refresh()).visible).toEqual(['c']);
    pyCall.mockResolvedValueOnce({ status: 'ok', tracks: [], trackCount: 0 });
    expect((await refresh()).visible).toEqual([]);
  });

  it('keeps YouTube order and inserts dated SC likes before the undated tail', () => {
    const youtube = [a, b, c, song('batch'), song('undated')].map((track, originalIndex) => ({
      track, trackId: track.id, originalIndex, syncedAt: 1100,
      likedAt: [1000, 1000, 800, 1100, undefined][originalIndex],
    }));
    const soundCloud = [0, 700, 900].map(likedAt => {
      const track = { ...song(`sc-${likedAt}`), source: 'soundcloud' as const };
      return { track, trackId: track.id, scId: track.id, likedAt };
    });
    expect(likedPlaylistTracks(youtube, undefined, soundCloud).map(t => t.id))
      .toEqual(['a', 'b', 'sc-900', 'c', 'sc-700', 'batch', 'undated', 'sc-0']);
    expect(likedPlaylistTracks(youtube, undefined, []).map(t => t.id))
      .toEqual(['a', 'b', 'c', 'batch', 'undated']);
  });

  it('one SC like does not hide paged YouTube results without a usable mirror', () => {
    const sc = { ...song('sc'), source: 'soundcloud' as const };
    const rows = likedPlaylistTracks(null, [{ tracks: [a, b] }, { tracks: [c] }], [
      { scId: '1', trackId: sc.id, track: sc, likedAt: 123 },
    ]);
    expect(rows.map(t => t.id)).toEqual(['sc', 'a', 'b', 'c']);
    expect(rows.every(t => t.likeStatus === 'LIKE')).toBe(true);
  });
});

describe('SoundCloud optimistic toggleLike', () => {
  const scTrack: YTMTrack = {
    id: 'https://soundcloud.com/artist/track-1',
    scId: 'sc-1',
    scUrl: 'https://soundcloud.com/artist/track-1',
    title: 'SC Track 1',
    artists: ['SC Artist'],
    album: '',
    duration: '3:15',
    thumbUrl: '',
    source: 'soundcloud',
  };

  let events: Array<{ type: string; detail: any }>;

  beforeEach(() => {
    clearPendingScLikeQueue();
    scMocks.isScAuthed.mockReset();
    scMocks.scSetLiked.mockReset();
    scMocks.setScLikedInMemory.mockReset();
    scMocks.addLocal.mockReset();
    scMocks.removeLocal.mockReset();

    events = [];
    vi.stubGlobal('window', {
      bridge: { pyCall },
      dispatchEvent: vi.fn((ev: Event) => {
        events.push({ type: ev.type, detail: (ev as CustomEvent).detail });
        return true;
      }),
      setTimeout: vi.fn(),
    });
  });

  afterEach(async () => {
    clearPendingScLikeQueue();
    await whenScLikeQueueIdle();
  });

  it('мгновенно обновляет UI и локальное зеркало до ответа scSetLiked и очищает pending после успеха', async () => {
    scMocks.isScAuthed.mockReturnValue(true);
    let resolveRemote!: (ok: boolean) => void;
    scMocks.scSetLiked.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
      resolveRemote = resolve;
    }));

    const result = await likedManager.toggleLike(scTrack, 'INDIFFERENT');

    expect(result).toBe(true);
    expect(scMocks.setScLikedInMemory).toHaveBeenCalledWith('sc-1', true);
    expect(scMocks.addLocal).toHaveBeenCalledWith({ ...scTrack, likeStatus: 'LIKE' });
    expect(events).toContainEqual({
      type: 'track-like-updated',
      detail: { id: scTrack.id, status: 'success', likeStatus: 'LIKE' },
    });
    expect(getPendingScLikeChanges().get('sc-1')).toEqual({ track: scTrack, liked: true });

    resolveRemote(true);
    await whenScLikeQueueIdle();

    expect(getPendingScLikeChanges().size).toBe(0);
  });

  it('откатывает состояние при неудаче scSetLiked через track-like-updated со status: success', async () => {
    scMocks.isScAuthed.mockReturnValue(true);
    let resolveRemote!: (ok: boolean) => void;
    scMocks.scSetLiked.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
      resolveRemote = resolve;
    }));

    const result = await likedManager.toggleLike(scTrack, 'INDIFFERENT');
    expect(result).toBe(true);
    events = [];

    resolveRemote(false);
    await whenScLikeQueueIdle();

    expect(scMocks.setScLikedInMemory).toHaveBeenLastCalledWith('sc-1', false);
    expect(scMocks.removeLocal).toHaveBeenCalledWith('sc-1');
    expect(events).toEqual([
      {
        type: 'track-like-updated',
        detail: { id: scTrack.id, status: 'success', likeStatus: 'INDIFFERENT' },
      },
    ]);
    expect(getPendingScLikeChanges().size).toBe(0);
  });

  it('при мгновенной ошибке scSetLiked откат срабатывает ПОСЛЕ кода после await toggleLike (TrackRow/PlayerStore)', async () => {
    scMocks.isScAuthed.mockReturnValue(true);
    scMocks.scSetLiked.mockResolvedValueOnce(false);

    const timeline: string[] = [];
    vi.stubGlobal('window', {
      bridge: { pyCall },
      dispatchEvent: vi.fn((ev: Event) => {
        const detail = (ev as CustomEvent).detail;
        events.push({ type: ev.type, detail });
        if (ev.type === 'track-like-updated') {
          timeline.push(`event:${detail.status}:${detail.likeStatus}`);
        }
        return true;
      }),
      setTimeout: vi.fn(),
    });

    const ok = await likedManager.toggleLike(scTrack, 'INDIFFERENT');
    expect(ok).toBe(true);
    // Имитируем TrackRow.tsx / player.ts, которые обновляют состояние сразу после await toggleLike()
    timeline.push('caller-post-await:LIKE');

    await whenScLikeQueueIdle();

    expect(timeline).toEqual([
      'event:success:LIKE',
      'caller-post-await:LIKE',
      'event:success:INDIFFERENT',
    ]);
  });

  it('откатывает неудачный unlike обратно в LIKE со status: success', async () => {
    scMocks.isScAuthed.mockReturnValue(true);
    scMocks.scSetLiked.mockResolvedValueOnce(false);

    const result = await likedManager.toggleLike(scTrack, 'LIKE');
    expect(result).toBe(true);
    await whenScLikeQueueIdle();

    expect(scMocks.removeLocal).toHaveBeenCalledWith('sc-1');
    expect(scMocks.addLocal).toHaveBeenCalledWith({ ...scTrack, likeStatus: 'LIKE' });
    expect(scMocks.setScLikedInMemory).toHaveBeenLastCalledWith('sc-1', true);
    expect(events[events.length - 1]).toEqual({
      type: 'track-like-updated',
      detail: { id: scTrack.id, status: 'success', likeStatus: 'LIKE' },
    });
  });

  it('clearPendingScLikeQueue и зарегистрированные хуки disconnect/pending работают корректно', async () => {
    const disconnectHook = scMocks.getDisconnectHook();
    const pendingProvider = scMocks.getPendingProvider();
    expect(typeof disconnectHook).toBe('function');
    expect(typeof pendingProvider).toBe('function');

    scMocks.isScAuthed.mockReturnValue(true);
    let resolveRemote!: (ok: boolean) => void;
    scMocks.scSetLiked.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
      resolveRemote = resolve;
    }));

    await likedManager.toggleLike(scTrack, 'INDIFFERENT');
    expect(pendingProvider!().has('sc-1')).toBe(true);
    events = [];
    scMocks.removeLocal.mockClear();

    disconnectHook!();
    resolveRemote(false);
    await whenScLikeQueueIdle();

    expect(scMocks.removeLocal).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(getPendingScLikeChanges().size).toBe(0);
  });

  it('сохраняет offline localOnly путь без авторизации SoundCloud', async () => {
    scMocks.isScAuthed.mockReturnValue(false);

    const result = await likedManager.toggleLike(scTrack, 'INDIFFERENT');

    expect(result).toBe(true);
    expect(scMocks.scSetLiked).not.toHaveBeenCalled();
    expect(scMocks.addLocal).toHaveBeenCalledWith({ ...scTrack, likeStatus: 'LIKE' }, true);
    expect(events).toContainEqual({
      type: 'track-like-updated',
      detail: { id: scTrack.id, status: 'success', likeStatus: 'LIKE' },
    });
    expect(events.some(e => e.type === 'app-toast' && e.detail.type === 'info')).toBe(true);
  });
});

describe('YouTube likeTargetId grouping, sync, and synchronized rating', () => {
  const trackWithTarget = (id: string, likeTargetId?: string): YTMTrack => ({
    ...song(id),
    ...(likeTargetId ? { likeTargetId } : {}),
  });

  let events: Array<{ type: string; detail: any }>;

  beforeEach(() => {
    events = [];
    vi.stubGlobal('CustomEvent', class FakeCustomEvent {
      type: string;
      detail: any;
      constructor(type: string, init?: { detail?: any }) {
        this.type = type;
        this.detail = init?.detail;
      }
    });
    vi.stubGlobal('window', {
      bridge: { pyCall },
      dispatchEvent: vi.fn((ev: any) => {
        events.push({ type: ev.type, detail: ev.detail });
        return true;
      }),
      setTimeout: vi.fn(),
    });
    vi.spyOn(likedStore, 'getMinIndex').mockResolvedValue(0);
    vi.spyOn(likedStore, 'setVirtualCount').mockResolvedValue(undefined);
    vi.spyOn(tracksStore, 'upsertTrack').mockImplementation(async t => { metadata.set(t.id, t); });
    vi.spyOn(likedStore, 'putTrack').mockImplementation(async entry => {
      const idx = committed.findIndex(e => e.trackId === entry.trackId);
      if (idx >= 0) committed[idx] = entry;
      else committed = [entry, ...committed];
    });
    vi.spyOn(likedStore, 'deleteTrack').mockImplementation(async id => {
      committed = committed.filter(e => e.trackId !== id);
    });
  });

  it('bumps YT_IMPORT_VERSION to 4 and awaits transaction completion in deleteTrack/putTrack', async () => {
    expect(YT_IMPORT_VERSION).toBe(4);

    vi.restoreAllMocks();
    let completeDelete!: () => void;
    let abortDelete!: () => void;
    let abortPut!: () => void;
    const fakeDb = {
      transaction: vi.fn((_store: string, _mode: string) => {
        const tx: any = {
          error: new Error('tx aborted'),
          objectStore: () => ({
            delete: vi.fn(),
            put: vi.fn(),
          }),
        };
        if (fakeDb.transaction.mock.calls.length === 1) {
          completeDelete = () => tx.oncomplete?.();
        } else if (fakeDb.transaction.mock.calls.length === 2) {
          abortDelete = () => tx.onabort?.();
        } else {
          abortPut = () => tx.onabort?.();
        }
        return tx;
      }),
    };
    const prevDb = (likedStore as any).db;
    const initSpy = vi.spyOn(likedStore, 'init').mockResolvedValue(undefined);
    (likedStore as any).db = fakeDb;
    try {
      let resolved = false;
      const p1 = likedStore.deleteTrack('Loj').then(() => { resolved = true; });
      await Promise.resolve();
      await Promise.resolve();
      expect(resolved).toBe(false);
      completeDelete();
      await p1;
      expect(resolved).toBe(true);

      const p2 = likedStore.deleteTrack('Loj');
      await Promise.resolve();
      abortDelete();
      await expect(p2).rejects.toThrow('tx aborted');

      const p3 = likedStore.putTrack({ trackId: 'Loj', originalIndex: 0, syncedAt: 1 });
      await Promise.resolve();
      abortPut();
      await expect(p3).rejects.toThrow('tx aborted');
    } finally {
      (likedStore as any).db = prevDb;
      initSpy.mockRestore();
    }
  });

  it('stores single counterpart likeTargetId on LikedEntry (ESCORT: Loj -> 6r1)', async () => {
    const escort = trackWithTarget('Loj', '6r1');
    pyCall.mockResolvedValueOnce({ status: 'ok', tracks: [escort], trackCount: 1, continuation: null });

    const { visible } = await refresh();
    expect(visible).toEqual(['Loj']);
    expect(committed).toHaveLength(1);
    expect(committed[0].likeTargetIds).toEqual(['6r1']);
  });

  it.each([
    { label: 'playable first (Cq4 then SZm)', rows: () => [trackWithTarget('Cq4'), trackWithTarget('Cq4', 'SZm')], expectedTargets: ['Cq4', 'SZm'] },
    { label: 'counterpart first (SZm then Cq4)', rows: () => [trackWithTarget('Cq4', 'SZm'), trackWithTarget('Cq4')], expectedTargets: ['SZm', 'Cq4'] },
  ])('groups duplicate displayId rows with distinct likeTargetIds on same page ($label)', async ({ rows, expectedTargets }) => {
    pyCall.mockResolvedValueOnce({ status: 'ok', tracks: rows(), trackCount: 2, continuation: null });

    const { visible } = await refresh();
    expect(visible).toEqual(['Cq4']);
    expect(committed).toHaveLength(1);
    expect(committed[0].likeTargetIds).toEqual(expectedTargets);
    expect(likedStore.commitYtImport).toHaveBeenCalledWith(expect.any(Array), 1, expect.any(Object));
  });

  it('groups duplicate displayId rows across pages and preserves targets through resume checkpoint', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const head = { status: 'ok', tracks: [trackWithTarget('Cq4')], trackCount: 3, continuation: 'p2' };
    pyCall
      .mockResolvedValueOnce(head)
      .mockResolvedValueOnce({ status: 'ok', tracks: [trackWithTarget('Cq4', 'SZm')], continuation: 'p3' })
      .mockResolvedValueOnce({ status: 'error', message: 'offline' });

    expect((await refresh()).visible).toEqual(['a', 'b', 'c']);

    pyCall
      .mockResolvedValueOnce(head)
      .mockResolvedValueOnce({ status: 'ok', tracks: [trackWithTarget('Loj', '6r1')], continuation: null });

    const { visible } = await refresh();
    expect(visible).toEqual(['Cq4', 'Loj']);
    expect(committed).toHaveLength(2);
    expect(committed[0].likeTargetIds).toEqual(['Cq4', 'SZm']);
    expect(committed[1].likeTargetIds).toEqual(['6r1']);
  });

  it('treats grouped duplicate targets as complete count (shortCount=false) and prunes external unlikes', async () => {
    committed = [
      { trackId: 'Cq4', originalIndex: 0, syncedAt: 1 },
      { trackId: 'unliked-outside', originalIndex: 1, syncedAt: 1 },
    ];
    metadata.set('Cq4', song('Cq4'));
    metadata.set('unliked-outside', song('unliked-outside'));

    pyCall.mockResolvedValueOnce({
      status: 'ok',
      tracks: [trackWithTarget('Cq4'), trackWithTarget('Cq4', 'SZm')],
      trackCount: 2,
      continuation: null,
    });

    const { visible } = await refresh();
    expect(visible).toEqual(['Cq4']);
    expect(committed.map(e => e.trackId)).toEqual(['Cq4']);
    expect(committed[0].likeTargetIds).toEqual(['Cq4', 'SZm']);
  });

  it('still detects shortCount on pagination overlap with the same likeTargetId and merges prior targets on truncated tail', async () => {
    committed = [
      { trackId: 'Cq4', originalIndex: 0, syncedAt: 1, likeTargetIds: ['Cq4', 'SZm'] },
      { trackId: 'Loj', originalIndex: 1, syncedAt: 1, likeTargetIds: ['6r1'] },
      { trackId: 'tail', originalIndex: 2, syncedAt: 1 },
    ];
    metadata.set('Cq4', song('Cq4'));
    metadata.set('Loj', song('Loj'));
    metadata.set('tail', song('tail'));

    pyCall
      .mockResolvedValueOnce({ status: 'ok', tracks: [trackWithTarget('Cq4'), trackWithTarget('Loj', '6r1')], trackCount: 4, continuation: 'end' })
      .mockResolvedValueOnce({ status: 'ok', tracks: [trackWithTarget('Loj', '6r1')], unavailableCount: 0, continuation: null });

    const { visible } = await refresh();
    expect(visible).toEqual(['Cq4', 'Loj', 'tail']);
    // Усеченный синк не должен потерять ранее известный counterpart SZm у Cq4.
    const cq4 = committed.find(e => e.trackId === 'Cq4');
    expect(cq4?.likeTargetIds).toEqual(['Cq4', 'SZm']);
  });

  it('unlikes ESCORT (Loj -> 6r1) by rating 6r1 INDIFFERENT and notifying both Loj and 6r1', async () => {
    committed = [{ trackId: 'Loj', originalIndex: 0, syncedAt: 1, likeTargetIds: ['6r1'] }];
    vi.mocked(likedStore.getVirtualCount).mockResolvedValue(1);
    pyCall.mockResolvedValue({ status: 'ok' });

    const ok = await likedManager.toggleLike(trackWithTarget('Loj', '6r1'), 'LIKE');
    expect(ok).toBe(true);
    expect(pyCall).toHaveBeenCalledTimes(1);
    expect(pyCall).toHaveBeenCalledWith('rate_song', expect.objectContaining({ videoId: '6r1', status: 'INDIFFERENT' }));
    expect(committed).toEqual([]);
    expect(likedStore.setVirtualCount).toHaveBeenCalledWith(0);

    const updatedIds = events
      .filter(e => e.type === 'track-like-updated' && e.detail.status === 'success' && e.detail.likeStatus === 'INDIFFERENT')
      .map(e => e.detail.id);
    expect(new Set(updatedIds)).toEqual(new Set(['Loj', '6r1']));
  });

  it('unlikes grouped duplicate (Cq4 + SZm) by rating both targets INDIFFERENT and notifying both', async () => {
    committed = [{ trackId: 'Cq4', originalIndex: 0, syncedAt: 1, likeTargetIds: ['Cq4', 'SZm'] }];
    vi.mocked(likedStore.getVirtualCount).mockResolvedValue(1);
    pyCall.mockResolvedValue({ status: 'ok' });

    const ok = await likedManager.toggleLike(trackWithTarget('Cq4'), 'LIKE');
    expect(ok).toBe(true);
    const rated = pyCall.mock.calls.filter(([cmd]) => cmd === 'rate_song').map(([, args]) => [args.videoId, args.status]);
    expect(rated).toEqual([['Cq4', 'INDIFFERENT'], ['SZm', 'INDIFFERENT']]);
    expect(committed).toEqual([]);

    const updatedIds = events
      .filter(e => e.type === 'track-like-updated' && e.detail.status === 'success' && e.detail.likeStatus === 'INDIFFERENT')
      .map(e => e.detail.id);
    expect(new Set(updatedIds)).toEqual(new Set(['Cq4', 'SZm']));
  });

  it('unlikes by counterpart id (6r1), removes Loj from store, and notifies both 6r1 and Loj', async () => {
    committed = [{ trackId: 'Loj', originalIndex: 0, syncedAt: 1, likeTargetIds: ['6r1'] }];
    vi.mocked(likedStore.getVirtualCount).mockResolvedValue(1);
    pyCall.mockResolvedValue({ status: 'ok' });

    const ok = await likedManager.toggleLike(trackWithTarget('6r1'), 'LIKE');
    expect(ok).toBe(true);
    expect(pyCall).toHaveBeenCalledTimes(1);
    expect(pyCall).toHaveBeenCalledWith('rate_song', expect.objectContaining({ videoId: '6r1', status: 'INDIFFERENT' }));
    expect(committed).toEqual([]);

    const updatedIds = events
      .filter(e => e.type === 'track-like-updated' && e.detail.status === 'success' && e.detail.likeStatus === 'INDIFFERENT')
      .map(e => e.detail.id);
    expect(new Set(updatedIds)).toEqual(new Set(['6r1', 'Loj']));
  });

  it('keeps only failed targets on partial unlike failure and returns false', async () => {
    committed = [{ trackId: 'Cq4', originalIndex: 0, syncedAt: 1, likeTargetIds: ['Cq4', 'SZm'] }];
    pyCall.mockImplementation(async (_cmd, args) => {
      if (args.videoId === 'Cq4') return { status: 'ok' };
      return { status: 'error', message: 'rate failed' };
    });

    const ok = await likedManager.toggleLike(trackWithTarget('Cq4'), 'LIKE');
    expect(ok).toBe(false);
    expect(committed).toHaveLength(1);
    expect(committed[0].trackId).toBe('Cq4');
    expect(committed[0].likeTargetIds).toEqual(['SZm']);
    expect(events).toContainEqual({
      type: 'track-like-updated',
      detail: { id: 'Cq4', status: 'error' },
    });
  });

  it('re-likes Loj via playable id without attaching stale likeTargetId 6r1', async () => {
    committed = [];
    vi.mocked(likedStore.getVirtualCount).mockResolvedValue(0);
    pyCall.mockResolvedValue({ status: 'ok' });

    const ok = await likedManager.toggleLike(trackWithTarget('Loj', '6r1'), 'INDIFFERENT');
    expect(ok).toBe(true);
    expect(pyCall).toHaveBeenCalledTimes(1);
    expect(pyCall).toHaveBeenCalledWith('rate_song', expect.objectContaining({ videoId: 'Loj', status: 'LIKE' }));
    expect(committed).toHaveLength(1);
    expect(committed[0].trackId).toBe('Loj');
    expect(committed[0].likeTargetIds).toBeUndefined();
    expect(likedStore.setVirtualCount).toHaveBeenCalledWith(1);
  });

  it('dislikes ESCORT (Loj -> 6r1) by disliking Loj, unliking 6r1, removing Loj, and notifying both', async () => {
    committed = [{ trackId: 'Loj', originalIndex: 0, syncedAt: 1, likeTargetIds: ['6r1'] }];
    vi.mocked(likedStore.getVirtualCount).mockResolvedValue(1);
    pyCall.mockResolvedValue({ status: 'ok' });

    const ok = await likedManager.toggleDislike(trackWithTarget('Loj', '6r1'), 'LIKE');
    expect(ok).toBe(true);
    const rated = pyCall.mock.calls.filter(([cmd]) => cmd === 'rate_song').map(([, args]) => [args.videoId, args.status]);
    expect(rated).toEqual([['Loj', 'DISLIKE'], ['6r1', 'INDIFFERENT']]);
    expect(committed).toEqual([]);
    expect(likedStore.setVirtualCount).toHaveBeenCalledWith(0);

    const updated = events.filter(e => e.type === 'track-like-updated').map(e => e.detail);
    expect(updated).toContainEqual({ id: 'Loj', status: 'success', likeStatus: 'DISLIKE' });
    expect(updated).toContainEqual({ id: '6r1', status: 'success', likeStatus: 'INDIFFERENT' });
  });

  it('keeps failed counterpart in store when dislike succeeds on playable id but counterpart unlike fails', async () => {
    committed = [{ trackId: 'Cq4', originalIndex: 0, syncedAt: 1, likeTargetIds: ['Cq4', 'SZm'] }];
    pyCall.mockImplementation(async (_cmd, args) => {
      if (args.videoId === 'Cq4' && args.status === 'DISLIKE') return { status: 'ok' };
      return { status: 'error', message: 'unlike failed' };
    });

    const ok = await likedManager.toggleDislike(trackWithTarget('Cq4'), 'LIKE');
    expect(ok).toBe(true);
    expect(committed).toHaveLength(1);
    expect(committed[0].likeTargetIds).toEqual(['SZm']);

    const updated = events.filter(e => e.type === 'track-like-updated').map(e => e.detail);
    expect(updated).toContainEqual({ id: 'Cq4', status: 'success', likeStatus: 'DISLIKE' });
    expect(updated.some(d => d.id === 'SZm' && d.likeStatus === 'INDIFFERENT')).toBe(false);
  });

  it('merges playable id into existing likeTargetIds when liking an already-stored entry without inflating virtualCount', async () => {
    committed = [{ trackId: 'Loj', originalIndex: 5, syncedAt: 1, likedAt: 777, likeTargetIds: ['6r1'] }];
    vi.mocked(likedStore.getVirtualCount).mockResolvedValue(1);
    pyCall.mockResolvedValue({ status: 'ok' });

    const ok = await likedManager.toggleLike(trackWithTarget('Loj', '6r1'), 'INDIFFERENT');
    expect(ok).toBe(true);
    expect(pyCall).toHaveBeenCalledTimes(1);
    expect(pyCall).toHaveBeenCalledWith('rate_song', expect.objectContaining({ videoId: 'Loj', status: 'LIKE' }));
    expect(committed).toHaveLength(1);
    expect(committed[0].originalIndex).toBe(5);
    expect(committed[0].likedAt).toBe(777);
    expect(committed[0].likeTargetIds).toEqual(['6r1', 'Loj']);
    expect(likedStore.setVirtualCount).not.toHaveBeenCalled();
  });

  it('unlikes both likeTargetId and playable id when no matching entry exists in local store', async () => {
    committed = [];
    vi.mocked(likedStore.getVirtualCount).mockResolvedValue(0);
    pyCall.mockResolvedValue({ status: 'ok' });

    const ok = await likedManager.toggleLike(trackWithTarget('Loj', '6r1'), 'LIKE');
    expect(ok).toBe(true);
    const rated = pyCall.mock.calls.filter(([cmd]) => cmd === 'rate_song').map(([, args]) => [args.videoId, args.status]);
    expect(rated).toEqual([['6r1', 'INDIFFERENT'], ['Loj', 'INDIFFERENT']]);

    const updatedIds = events
      .filter(e => e.type === 'track-like-updated' && e.detail.status === 'success' && e.detail.likeStatus === 'INDIFFERENT')
      .map(e => e.detail.id);
    expect(new Set(updatedIds)).toEqual(new Set(['Loj', '6r1']));
  });

  it('keeps staged checkpoint consistent if saveYtImportPage fails while merging a second likeTargetId', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const savedCalls: LikedEntry[][] = [];
    vi.mocked(likedStore.saveYtImportPage)
      .mockImplementationOnce(async (entries) => {
        savedCalls.push(entries);
      })
      .mockRejectedValueOnce(new Error('IDB quota'));

    pyCall
      .mockResolvedValueOnce({ status: 'ok', tracks: [trackWithTarget('Cq4')], trackCount: 2, continuation: 'p2' })
      .mockResolvedValueOnce({ status: 'ok', tracks: [trackWithTarget('Cq4', 'SZm')], continuation: null });

    await refresh();
    expect(savedCalls).toHaveLength(1);
    expect(savedCalls[0]).toHaveLength(1);
    expect(savedCalls[0][0].likeTargetIds).toBeUndefined();
    expect(likedStore.commitYtImport).not.toHaveBeenCalled();
  });

  it('rejects deleteTrack and putTrack with fallback Error when tx.onabort has null tx.error', async () => {
    vi.restoreAllMocks();
    const abortFns: Array<() => void> = [];
    const fakeDb = {
      transaction: vi.fn(() => {
        const tx: any = {
          error: null,
          objectStore: () => ({ delete: vi.fn(), put: vi.fn() }),
        };
        abortFns.push(() => tx.onabort?.());
        return tx;
      }),
    };
    const prevDb = (likedStore as any).db;
    const initSpy = vi.spyOn(likedStore, 'init').mockResolvedValue(undefined);
    (likedStore as any).db = fakeDb;
    try {
      const pDel = likedStore.deleteTrack('Loj');
      await Promise.resolve();
      abortFns[0]();
      const delErr = await pDel.catch(e => e);
      expect(delErr).toBeInstanceOf(Error);
      expect(delErr.message).toBe('IDB transaction aborted');

      const pPut = likedStore.putTrack({ trackId: 'Loj', originalIndex: 0, syncedAt: 1 });
      await Promise.resolve();
      abortFns[1]();
      const putErr = await pPut.catch(e => e);
      expect(putErr).toBeInstanceOf(Error);
      expect(putErr.message).toBe('IDB transaction aborted');
    } finally {
      (likedStore as any).db = prevDb;
      initSpy.mockRestore();
    }
  });

  it('falls back to matching stored entries by track.likeTargetId on unlike and dislike, without touching unrelated entries on primary match', async () => {
    // 1. Unlike: stored entry keyed by 'other' with likeTargetIds: ['6r1'], clicked from display track Loj -> 6r1
    committed = [{ trackId: 'other', originalIndex: 0, syncedAt: 1, likeTargetIds: ['6r1'] }];
    vi.mocked(likedStore.getVirtualCount).mockResolvedValue(1);
    pyCall.mockResolvedValue({ status: 'ok' });

    expect(await likedManager.toggleLike(trackWithTarget('Loj', '6r1'), 'LIKE')).toBe(true);
    expect(pyCall.mock.calls.filter(([cmd]) => cmd === 'rate_song').map(([, a]) => [a.videoId, a.status]))
      .toEqual([['6r1', 'INDIFFERENT']]);
    expect(committed).toEqual([]);
    const unlikedIds = events
      .filter(e => e.type === 'track-like-updated' && e.detail.status === 'success' && e.detail.likeStatus === 'INDIFFERENT')
      .map(e => e.detail.id);
    expect(new Set(unlikedIds)).toEqual(new Set(['Loj', '6r1', 'other']));

    // 2. Dislike: stored entry keyed directly by '6r1', clicked from Loj -> 6r1 with currentStatus LIKE
    pyCall.mockReset();
    pyCall.mockResolvedValue({ status: 'ok' });
    events = [];
    committed = [{ trackId: '6r1', originalIndex: 0, syncedAt: 1 }];
    vi.mocked(likedStore.getVirtualCount).mockResolvedValue(1);

    expect(await likedManager.toggleDislike(trackWithTarget('Loj', '6r1'), 'LIKE')).toBe(true);
    expect(pyCall.mock.calls.filter(([cmd]) => cmd === 'rate_song').map(([, a]) => [a.videoId, a.status]))
      .toEqual([['Loj', 'DISLIKE'], ['6r1', 'INDIFFERENT']]);
    expect(committed).toEqual([]);
    const dislikedDetails = events.filter(e => e.type === 'track-like-updated').map(e => e.detail);
    expect(dislikedDetails).toContainEqual({ id: 'Loj', status: 'success', likeStatus: 'DISLIKE' });
    expect(dislikedDetails).toContainEqual({ id: '6r1', status: 'success', likeStatus: 'INDIFFERENT' });

    // 3. Guard: when primary match exists for Loj, fallback does NOT touch separate 6r1 entry
    pyCall.mockReset();
    pyCall.mockResolvedValue({ status: 'ok' });
    events = [];
    committed = [
      { trackId: 'Loj', originalIndex: 0, syncedAt: 1 },
      { trackId: '6r1', originalIndex: 1, syncedAt: 1 },
    ];
    expect(await likedManager.toggleLike(trackWithTarget('Loj', '6r1'), 'LIKE')).toBe(true);
    expect(committed.map(e => e.trackId)).toEqual(['6r1']);
  });

  it('strips stale likeTargetId from tracksStore on fresh re-like and does not emit false INDIFFERENT for 6r1 on later unlike', async () => {
    committed = [];
    metadata.clear();
    vi.mocked(likedStore.getVirtualCount).mockResolvedValue(0);
    pyCall.mockResolvedValue({ status: 'ok' });

    expect(await likedManager.toggleLike(trackWithTarget('Loj', '6r1'), 'INDIFFERENT')).toBe(true);
    expect(metadata.get('Loj')?.likeTargetId).toBeUndefined();

    // Позже пользователь снимает лайк с того же неперемонтированного TrackRow (со старым likeTargetId='6r1').
    pyCall.mockReset();
    pyCall.mockResolvedValue({ status: 'ok' });
    events = [];

    expect(await likedManager.toggleLike(trackWithTarget('Loj', '6r1'), 'LIKE')).toBe(true);
    expect(pyCall.mock.calls.filter(([cmd]) => cmd === 'rate_song').map(([, a]) => [a.videoId, a.status]))
      .toEqual([['Loj', 'INDIFFERENT']]);
    const updatedIds = events
      .filter(e => e.type === 'track-like-updated' && e.detail.status === 'success')
      .map(e => e.detail.id);
    expect(updatedIds).toEqual(['Loj']);
  });

  it('emits INDIFFERENT for succeeded counterpart target on partial unlike failure while emitting error for clicked id', async () => {
    committed = [{ trackId: 'Cq4', originalIndex: 0, syncedAt: 1, likeTargetIds: ['Cq4', 'SZm'] }];
    pyCall.mockImplementation(async (_cmd, args) => {
      if (args.videoId === 'SZm') return { status: 'ok' };
      return { status: 'error', message: 'rate failed' };
    });

    expect(await likedManager.toggleLike(trackWithTarget('Cq4'), 'LIKE')).toBe(false);
    expect(committed).toHaveLength(1);
    expect(committed[0].likeTargetIds).toEqual(['Cq4']);
    const updated = events.filter(e => e.type === 'track-like-updated').map(e => e.detail);
    expect(updated).toContainEqual({ id: 'SZm', status: 'success', likeStatus: 'INDIFFERENT' });
    expect(updated).toContainEqual({ id: 'Cq4', status: 'error' });
  });

  it('merges implicit trackId target on truncated v4 sync, but avoids polluting counterpart on truncated v3->v4 upgrade', async () => {
    // v4 mirror: localEntry { trackId: 'Cq4' } без likeTargetIds; усеченный синк увидел только Cq4 -> SZm
    vi.mocked(likedStore.getYtImportCompletedVersion).mockResolvedValue(YT_IMPORT_VERSION);
    committed = [{ trackId: 'Cq4', originalIndex: 0, syncedAt: 1 }];
    metadata.set('Cq4', song('Cq4'));
    pyCall
      .mockResolvedValueOnce({ status: 'ok', tracks: [trackWithTarget('Cq4', 'SZm')], trackCount: 3, continuation: 'end' })
      .mockResolvedValueOnce({ status: 'ok', tracks: [], unavailableCount: 0, continuation: null });

    await refresh();
    expect(committed.find(e => e.trackId === 'Cq4')?.likeTargetIds).toEqual(['SZm', 'Cq4']);

    // v3 mirror: localEntry { trackId: 'Loj' } без likeTargetIds; усеченный синк увидел Loj -> 6r1
    vi.mocked(likedStore.getYtImportCompletedVersion).mockResolvedValue(3);
    committed = [{ trackId: 'Loj', originalIndex: 0, syncedAt: 1 }];
    metadata.set('Loj', song('Loj'));
    pyCall
      .mockResolvedValueOnce({ status: 'ok', tracks: [trackWithTarget('Loj', '6r1')], trackCount: 3, continuation: 'end' })
      .mockResolvedValueOnce({ status: 'ok', tracks: [], unavailableCount: 0, continuation: null });

    await refresh();
    expect(committed.find(e => e.trackId === 'Loj')?.likeTargetIds).toEqual(['6r1']);
  });

  it('invalidates fingerprint and resume checkpoint when a page-1 track changes its likeTargetId', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const clock = vi.spyOn(Date, 'now').mockReturnValue(100);

    // 1. Fingerprint invalidation within 15m when Loj switches target 6r1 -> 9z9
    pyCall.mockResolvedValueOnce({ status: 'ok', tracks: [trackWithTarget('Loj', '6r1')], trackCount: 1, continuation: null });
    await refresh();
    expect(committed[0].likeTargetIds).toEqual(['6r1']);

    clock.mockReturnValue(100 + 2 * 60 * 1000);
    pyCall.mockResolvedValueOnce({ status: 'ok', tracks: [trackWithTarget('Loj', '9z9')], trackCount: 1, continuation: null });
    await refresh();
    expect(committed[0].likeTargetIds).toEqual(['9z9']);

    // 2. Checkpoint invalidation when page-1 target changes before resume
    pyCall
      .mockResolvedValueOnce({ status: 'ok', tracks: [trackWithTarget('Loj', '6r1')], trackCount: 2, continuation: 'old-cur' })
      .mockResolvedValueOnce({ status: 'error', message: 'offline' });
    await refresh();

    pyCall
      .mockResolvedValueOnce({ status: 'ok', tracks: [trackWithTarget('Loj', '9z9')], trackCount: 2, continuation: 'fresh-cur' })
      .mockResolvedValueOnce({ status: 'ok', tracks: [song('b')], continuation: null });
    await refresh();
    expect(pyCall.mock.calls[5][1].token).toBe('fresh-cur');
    expect(committed[0].likeTargetIds).toEqual(['9z9']);
  });
});
