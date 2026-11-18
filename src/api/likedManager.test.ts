import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { likedStore, type LikedEntry } from './likedStore';
import { tracksStore } from './tracks';
import { likedManager } from './likedManager';
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
  vi.spyOn(likedStore, 'getYtImportState').mockResolvedValue(null);
  vi.spyOn(likedStore, 'getYtImportCompletedVersion').mockResolvedValue(1);
  vi.spyOn(likedStore, 'saveYtImportPage').mockResolvedValue(undefined);
  vi.spyOn(likedStore, 'setYtImportState').mockResolvedValue(undefined);
  vi.spyOn(likedStore, 'commitYtImport').mockImplementation(async entries => { committed = entries; });
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
  it('repairs a one-row v1 mirror whose saved virtual count already matches YouTube', async () => {
    committed = committed.slice(0, 1);
    metadata.delete('b'); metadata.delete('c');
    pyCall.mockResolvedValueOnce({ status: 'ok', tracks: [a, b], trackCount: 3, continuation: 'next' })
      .mockResolvedValueOnce({ status: 'ok', tracks: [c], continuation: null });
    expect((await refresh()).visible).toEqual(['a', 'b', 'c']);
    expect(pyCall.mock.calls.map(([command]) => command)).toEqual(['get_playlist_tracks', 'get_continuation']);
    expect(likedStore.commitYtImport).toHaveBeenCalledOnce();
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
    vi.spyOn(likedStore, 'clearYtImport').mockResolvedValue(undefined);
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

  it('one SC like does not hide paged YouTube results without a usable mirror', () => {
    const sc = { ...song('sc'), source: 'soundcloud' as const };
    const rows = likedPlaylistTracks(null, [{ tracks: [a, b] }, { tracks: [c] }], [
      { scId: '1', trackId: sc.id, track: sc, likedAt: 123 },
    ]);
    expect(rows.map(t => t.id)).toEqual(['sc', 'a', 'b', 'c']);
    expect(rows.every(t => t.likeStatus === 'LIKE')).toBe(true);
  });
});
