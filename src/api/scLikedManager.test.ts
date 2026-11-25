import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { likedStore, type ScLikedEntry } from './likedStore';
import { tracksStore } from './tracks';
import type { YTMTrack } from './yt';
import type { PendingScLikeChange } from './scLikeQueue';

const scApiMocks = vi.hoisted(() => ({
  isScAuthed: vi.fn(() => true),
  getScLikedMeta: vi.fn(),
  getScLikedEntries: vi.fn(),
  addScLocalOnlyId: vi.fn(),
  removeScLocalOnlyId: vi.fn(),
  loadScLocalOnlyIds: vi.fn(async () => {}),
}));

vi.mock('./soundcloud', () => scApiMocks);

import { registerScPendingChangesProvider, scLikedManager } from './scLikedManager';

function makeTrack(scId: string): YTMTrack {
  return {
    id: `https://soundcloud.com/artist/${scId}`,
    scId,
    scUrl: `https://soundcloud.com/artist/${scId}`,
    title: `Track ${scId}`,
    artists: ['Artist'],
    album: '',
    duration: '3:00',
    thumbUrl: '',
    source: 'soundcloud',
  };
}

describe('scLikedManager.sync pending overlay', () => {
  let storedEntries: ScLikedEntry[];
  let virtualCount: number;
  let upsertedTracks: Map<string, YTMTrack>;

  beforeEach(() => {
    storedEntries = [];
    virtualCount = 0;
    upsertedTracks = new Map();

    scApiMocks.isScAuthed.mockReset().mockReturnValue(true);
    scApiMocks.getScLikedMeta.mockReset();
    scApiMocks.getScLikedEntries.mockReset();
    scApiMocks.addScLocalOnlyId.mockReset();
    scApiMocks.removeScLocalOnlyId.mockReset();
    scApiMocks.loadScLocalOnlyIds.mockReset().mockResolvedValue(undefined);

    vi.spyOn(likedStore, 'getAllScTracks').mockImplementation(async () => [...storedEntries]);
    vi.spyOn(likedStore, 'getScVirtualCount').mockImplementation(async () => virtualCount);
    vi.spyOn(likedStore, 'setScVirtualCount').mockImplementation(async (count) => { virtualCount = count; });
    vi.spyOn(likedStore, 'replaceScTracks').mockImplementation(async (entries) => {
      storedEntries = [...entries];
    });
    vi.spyOn(likedStore, 'putScTrack').mockImplementation(async (entry) => {
      storedEntries = [entry, ...storedEntries.filter(e => e.scId !== entry.scId)];
    });
    vi.spyOn(likedStore, 'deleteScTrack').mockImplementation(async (scId) => {
      storedEntries = storedEntries.filter(e => e.scId !== scId);
    });
    vi.spyOn(tracksStore, 'upsertTrack').mockImplementation(async (track) => {
      upsertedTracks.set(track.id, track);
    });

    registerScPendingChangesProvider(() => new Map());
  });

  afterEach(() => {
    registerScPendingChangesProvider(() => new Map());
    vi.restoreAllMocks();
  });

  it('накладывает pending liked=true поверх серверного списка и сохраняет трек в tracksStore', async () => {
    const trackC = makeTrack('c');
    storedEntries = [
      { scId: 'a', trackId: makeTrack('a').id, likedAt: 200 },
      { scId: 'b', trackId: makeTrack('b').id, likedAt: 100 },
    ];
    virtualCount = 2;

    scApiMocks.getScLikedMeta.mockResolvedValueOnce({ count: 2, headIds: ['a', 'b'] });
    scApiMocks.getScLikedEntries.mockResolvedValueOnce([
      { scId: 'a', trackId: makeTrack('a').id, likedAt: 200 },
      { scId: 'b', trackId: makeTrack('b').id, likedAt: 100 },
    ]);

    const pending = new Map<string, PendingScLikeChange>([
      ['c', { track: trackC, liked: true }],
    ]);
    registerScPendingChangesProvider(() => new Map(pending));

    const notified: ScLikedEntry[][] = [];
    const unsub = scLikedManager.subscribe((entries, syncing) => {
      if (!syncing) notified.push(entries);
    });
    try {
      await scLikedManager.sync();
    } finally {
      unsub();
    }

    expect(scApiMocks.getScLikedEntries).toHaveBeenCalledTimes(1);
    expect(storedEntries.map(e => e.scId)).toEqual(['c', 'a', 'b']);
    expect(upsertedTracks.get(trackC.id)).toEqual({ ...trackC, likeStatus: 'LIKE' });
    expect(virtualCount).toBe(3);
    expect(notified[notified.length - 1].map(e => e.scId)).toEqual(['c', 'a', 'b']);
  });

  it('отфильтровывает pending liked=false, чтобы sync не воскрешал оптимистично снятый лайк', async () => {
    const trackA = makeTrack('a');
    storedEntries = [
      { scId: 'a', trackId: trackA.id, likedAt: 200 },
      { scId: 'b', trackId: makeTrack('b').id, likedAt: 100 },
    ];
    virtualCount = 2;

    scApiMocks.getScLikedMeta.mockResolvedValueOnce({ count: 2, headIds: ['a', 'b'] });
    scApiMocks.getScLikedEntries.mockResolvedValueOnce([
      { scId: 'a', trackId: trackA.id, likedAt: 200 },
      { scId: 'b', trackId: makeTrack('b').id, likedAt: 100 },
    ]);

    registerScPendingChangesProvider(() => new Map<string, PendingScLikeChange>([
      ['a', { track: trackA, liked: false }],
    ]));

    await scLikedManager.sync();

    expect(storedEntries.map(e => e.scId)).toEqual(['b']);
    expect(virtualCount).toBe(1);
  });

  it('не дублирует pending liked=true, если трек уже присутствует в серверном ответе', async () => {
    const trackA = makeTrack('a');
    storedEntries = [];
    virtualCount = 0;

    scApiMocks.getScLikedMeta.mockResolvedValueOnce({ count: 1, headIds: ['a'] });
    scApiMocks.getScLikedEntries.mockResolvedValueOnce([
      { scId: 'a', trackId: trackA.id, likedAt: 200 },
    ]);

    registerScPendingChangesProvider(() => new Map<string, PendingScLikeChange>([
      ['a', { track: trackA, liked: true }],
    ]));

    await scLikedManager.sync();

    expect(storedEntries.map(e => e.scId)).toEqual(['a']);
    expect(virtualCount).toBe(1);
  });

  it('сохраняет fast-path без полной выгрузки, когда pending пуст и head/count совпадают', async () => {
    storedEntries = [
      { scId: 'a', trackId: makeTrack('a').id, likedAt: 200 },
      { scId: 'b', trackId: makeTrack('b').id, likedAt: 100 },
    ];
    virtualCount = 2;

    scApiMocks.getScLikedMeta.mockResolvedValueOnce({ count: 2, headIds: ['a', 'b'] });

    await scLikedManager.sync();

    expect(scApiMocks.getScLikedEntries).not.toHaveBeenCalled();
    expect(storedEntries.map(e => e.scId)).toEqual(['a', 'b']);
  });

  it('сериализует быстрые addLocal -> removeLocal, чтобы медленный addLocal не перетирал удаление', async () => {
    const trackX = makeTrack('x');
    let releaseUpsert!: () => void;
    vi.mocked(tracksStore.upsertTrack).mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseUpsert = resolve;
    }));

    const addPromise = scLikedManager.addLocal(trackX);
    const removePromise = scLikedManager.removeLocal('x');

    // Ждем один тик, чтобы addLocal дошел до await upsertTrack
    await Promise.resolve();
    await Promise.resolve();
    releaseUpsert();

    await Promise.all([addPromise, removePromise]);

    expect(storedEntries).toEqual([]);
    expect(virtualCount).toBe(0);
  });
});
