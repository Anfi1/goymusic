import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { likedStore, type LikedEntry, type YtImportSnapshot, type YtImportState, YT_IMPORT_VERSION } from './likedStore';
import { tracksStore } from './tracks';
import { likedManager, likedSyncLabel } from './likedManager';
import type { YTMTrack } from './yt';
import { likedPlaylistTracks } from '../hooks/likedPlaylistTracks';

// The renderer singleton reads its preference once, during module initialization.
vi.hoisted(() => vi.stubGlobal('localStorage', { getItem: () => null }));
vi.mock('./soundcloud', () => ({}));
vi.mock('./yandex', () => ({}));
vi.mock('./scLikedManager', () => ({}));

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
