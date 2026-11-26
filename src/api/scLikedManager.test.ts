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

  it('не затирает быстрый лайк, который начался и успел подтвердиться пока шел getScLikedEntries', async () => {
    const trackA = makeTrack('a');
    const trackC = makeTrack('c');
    storedEntries = [{ scId: 'a', trackId: trackA.id, likedAt: 200 }];
    virtualCount = 1;

    const pending = new Map<string, PendingScLikeChange>();
    registerScPendingChangesProvider(() => new Map(pending));

    scApiMocks.getScLikedMeta.mockResolvedValueOnce({ count: 2, headIds: ['x', 'a'] });
    let resolveEntries!: (entries: ScLikedEntry[]) => void;
    let markEntriesStarted!: () => void;
    const entriesStarted = new Promise<void>((r) => { markEntriesStarted = r; });
    scApiMocks.getScLikedEntries.mockImplementationOnce(() => {
      markEntriesStarted();
      return new Promise<ScLikedEntry[]>((resolve) => {
        resolveEntries = resolve;
      });
    });

    const syncPromise = scLikedManager.sync();
    await entriesStarted;

    // Во время синка пользователь ставит быстрый лайк (~150мс): addLocal + вход/выход из pending до ответа сервера
    pending.set('c', { track: trackC, liked: true });
    await scLikedManager.addLocal({ ...trackC, likeStatus: 'LIKE' });
    pending.delete('c');

    // Сервер возвращает устаревший снимок без 'c'
    resolveEntries([
      { scId: 'x', trackId: makeTrack('x').id, likedAt: 300 },
      { scId: 'a', trackId: trackA.id, likedAt: 200 },
    ]);
    await syncPromise;

    expect(storedEntries.map(e => e.scId)).toEqual(['c', 'x', 'a']);
    expect(virtualCount).toBe(3);
  });

  it('не воскрешает быстрый анлайк, который подтвердился пока шел getScLikedEntries', async () => {
    const trackA = makeTrack('a');
    const trackB = makeTrack('b');
    storedEntries = [
      { scId: 'a', trackId: trackA.id, likedAt: 200 },
      { scId: 'b', trackId: trackB.id, likedAt: 100 },
    ];
    virtualCount = 2;

    const pending = new Map<string, PendingScLikeChange>();
    registerScPendingChangesProvider(() => new Map(pending));

    scApiMocks.getScLikedMeta.mockResolvedValueOnce({ count: 3, headIds: ['x', 'a', 'b'] });
    let resolveEntries!: (entries: ScLikedEntry[]) => void;
    let markEntriesStarted!: () => void;
    const entriesStarted = new Promise<void>((r) => { markEntriesStarted = r; });
    scApiMocks.getScLikedEntries.mockImplementationOnce(() => {
      markEntriesStarted();
      return new Promise<ScLikedEntry[]>((resolve) => {
        resolveEntries = resolve;
      });
    });

    const syncPromise = scLikedManager.sync();
    await entriesStarted;

    // Быстрый анлайк 'a' подтверждается до завершения getScLikedEntries
    pending.set('a', { track: trackA, liked: false });
    await scLikedManager.removeLocal('a');
    pending.delete('a');

    // Сервер возвращает устаревший снимок, где 'a' еще присутствует
    resolveEntries([
      { scId: 'x', trackId: makeTrack('x').id, likedAt: 300 },
      { scId: 'a', trackId: trackA.id, likedAt: 200 },
      { scId: 'b', trackId: trackB.id, likedAt: 100 },
    ]);
    await syncPromise;

    expect(storedEntries.map(e => e.scId)).toEqual(['x', 'b']);
    expect(virtualCount).toBe(2);
  });

  it('не затирает pendingAtStart лайк, который был добавлен до старта sync и подтвердился во время sync', async () => {
    const trackA = makeTrack('a');
    const trackC = makeTrack('c');
    // addLocal уже прошел до sync(), а запрос еще в pending на старте sync()
    storedEntries = [
      { scId: 'c', trackId: trackC.id, likedAt: 500 },
      { scId: 'a', trackId: trackA.id, likedAt: 200 },
    ];
    virtualCount = 2;

    const pending = new Map<string, PendingScLikeChange>([
      ['c', { track: trackC, liked: true }],
    ]);
    registerScPendingChangesProvider(() => new Map(pending));

    scApiMocks.getScLikedMeta.mockResolvedValueOnce({ count: 1, headIds: ['a'] });
    let resolveEntries!: (entries: ScLikedEntry[]) => void;
    let markEntriesStarted!: () => void;
    const entriesStarted = new Promise<void>((r) => { markEntriesStarted = r; });
    scApiMocks.getScLikedEntries.mockImplementationOnce(() => {
      markEntriesStarted();
      return new Promise<ScLikedEntry[]>((resolve) => {
        resolveEntries = resolve;
      });
    });

    const syncPromise = scLikedManager.sync();
    await entriesStarted;

    // Запрос подтвердился до возврата fresh
    pending.delete('c');

    resolveEntries([{ scId: 'a', trackId: trackA.id, likedAt: 200 }]);
    await syncPromise;

    expect(storedEntries.map(e => e.scId)).toEqual(['c', 'a']);
    expect(virtualCount).toBe(2);
  });

  it('при раннем выходе !meta уведомляет свежим списком, если addLocal прошел во время getScLikedMeta', async () => {
    const trackA = makeTrack('a');
    const trackC = makeTrack('c');
    storedEntries = [{ scId: 'a', trackId: trackA.id, likedAt: 200 }];
    virtualCount = 1;

    let resolveMeta!: (meta: { count: number; headIds: string[] } | null) => void;
    let markMetaStarted!: () => void;
    const metaStarted = new Promise<void>((r) => { markMetaStarted = r; });
    scApiMocks.getScLikedMeta.mockImplementationOnce(() => {
      markMetaStarted();
      return new Promise((resolve) => {
        resolveMeta = resolve;
      });
    });

    const notified: ScLikedEntry[][] = [];
    const unsub = scLikedManager.subscribe((entries, syncing) => {
      if (!syncing) notified.push(entries);
    });
    try {
      const syncPromise = scLikedManager.sync();
      await metaStarted;
      await scLikedManager.addLocal({ ...trackC, likeStatus: 'LIKE' });
      resolveMeta(null);
      await syncPromise;
    } finally {
      unsub();
    }

    expect(notified[notified.length - 1].map(e => e.scId)).toEqual(['c', 'a']);
  });

  it('не затирает локальное зеркало SC-лайков, если getScLikedEntries вернул null (401/сетевая ошибка)', async () => {
    const trackA = makeTrack('a');
    const trackB = makeTrack('b');
    storedEntries = [
      { scId: 'a', trackId: trackA.id, likedAt: 200 },
      { scId: 'b', trackId: trackB.id, likedAt: 100 },
    ];
    virtualCount = 2;

    scApiMocks.getScLikedMeta.mockResolvedValueOnce({ count: 3, headIds: ['c', 'a'] });
    scApiMocks.getScLikedEntries.mockResolvedValueOnce(null);

    await scLikedManager.sync();

    expect(storedEntries.map(e => e.scId)).toEqual(['a', 'b']);
    expect(virtualCount).toBe(2);
    expect(likedStore.replaceScTracks).not.toHaveBeenCalled();
  });
});
