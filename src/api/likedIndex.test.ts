import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { YTMTrack } from './yt';
import {
  hydrateTrackLikeStatus,
  hydrateTracksLikeStatus,
  likedIndex,
  reloadLikedIndex,
  resetLikedIndexForTests,
  resolveTrackLikeStatus,
  useLikedLookup,
  type TrackLikeLookup,
} from './likedIndex';

const storeMocks = vi.hoisted(() => ({
  ytEntries: [] as Array<{ trackId: string; originalIndex: number; syncedAt: number; likeTargetIds?: string[] }>,
  scEntries: [] as Array<{ scId: string; trackId: string; likedAt: number }>,
  yandexEntries: [] as Array<{ yandexId: string; trackId: string; likedAt: number }>,
  getAllTracks: vi.fn(),
  getAllScTracks: vi.fn(),
  getAllYandexTracks: vi.fn(),
  ytListeners: new Set<() => void>(),
  scListeners: new Set<() => void>(),
  scLikedMem: new Set<string>(),
  yandexLikedMem: new Set<string>(),
}));

vi.mock('./likedStore', () => ({
  likedStore: {
    getAllTracks: (...args: unknown[]) => storeMocks.getAllTracks(...args),
    getAllScTracks: (...args: unknown[]) => storeMocks.getAllScTracks(...args),
    getAllYandexTracks: (...args: unknown[]) => storeMocks.getAllYandexTracks(...args),
  },
}));

vi.mock('./likedManager', () => ({
  likedManager: {
    get isEnabled() { return true; },
    subscribe: (fn: () => void) => {
      storeMocks.ytListeners.add(fn);
      return () => { storeMocks.ytListeners.delete(fn); };
    },
  },
}));

vi.mock('./scLikedManager', () => ({
  scLikedManager: {
    subscribe: (fn: () => void) => {
      storeMocks.scListeners.add(fn);
      return () => { storeMocks.scListeners.delete(fn); };
    },
  },
}));

vi.mock('./soundcloud', () => ({
  isScTrackLiked: (scId: string | undefined) => !!scId && storeMocks.scLikedMem.has(scId),
}));

vi.mock('./yandex', () => ({
  isYandexTrackLiked: (yandexId: string | undefined) => !!yandexId && storeMocks.yandexLikedMem.has(yandexId),
}));

function makeTrack(overrides: Partial<YTMTrack> & { id: string }): YTMTrack {
  return {
    title: 'ESCORT',
    artists: ['Nikitata'],
    album: 'Album',
    duration: '2:15',
    thumbUrl: 'https://example.com/thumb.jpg',
    ...overrides,
  };
}

class FakeWindow extends EventTarget {
  dispatchCustom(type: string, detail?: unknown) {
    const ev = new Event(type) as Event & { detail?: unknown };
    ev.detail = detail;
    this.dispatchEvent(ev);
  }
}

async function flushMicrotasks(count = 4) {
  for (let i = 0; i < count; i++) {
    await Promise.resolve();
  }
}

let fakeWindow: FakeWindow;

beforeEach(() => {
  storeMocks.ytEntries = [];
  storeMocks.scEntries = [];
  storeMocks.yandexEntries = [];
  storeMocks.scLikedMem.clear();
  storeMocks.yandexLikedMem.clear();
  storeMocks.ytListeners.clear();
  storeMocks.scListeners.clear();

  storeMocks.getAllTracks.mockImplementation(async () => [...storeMocks.ytEntries]);
  storeMocks.getAllScTracks.mockImplementation(async () => [...storeMocks.scEntries]);
  storeMocks.getAllYandexTracks.mockImplementation(async () => [...storeMocks.yandexEntries]);

  fakeWindow = new FakeWindow();
  vi.stubGlobal('window', fakeWindow);
  resetLikedIndexForTests();
});

afterEach(() => {
  resetLikedIndexForTests();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('likedIndex pure resolution & hydration', () => {
  it('hydrates Album/Playlist/Artist tracks across YT, SC (id & scId), and Yandex (id & yandexId)', async () => {
    storeMocks.ytEntries = [{ trackId: 'Lojtv9DCqdA', originalIndex: 0, syncedAt: 1 }];
    storeMocks.scEntries = [{ scId: '5001', trackId: 'https://soundcloud.com/a/old-slug', likedAt: 1 }];
    storeMocks.yandexEntries = [{ yandexId: '9001', trackId: 'yandex:9001', likedAt: 1 }];
    storeMocks.scLikedMem.add('5002');
    storeMocks.yandexLikedMem.add('9002');

    await reloadLikedIndex();
    const lookup = likedIndex.getSnapshot();
    expect(lookup.loaded).toBe(true);

    const tracks: YTMTrack[] = [
      makeTrack({ id: 'Lojtv9DCqdA', likeStatus: undefined }),
      makeTrack({ id: 'Lojtv9DCqdA', likeStatus: 'INDIFFERENT' }),
      makeTrack({ id: 'https://soundcloud.com/a/new-slug', source: 'soundcloud', scId: '5001', likeStatus: undefined }),
      makeTrack({ id: 'https://soundcloud.com/a/mem-track', source: 'soundcloud', scId: '5002', likeStatus: undefined }),
      makeTrack({ id: 'yandex:9001', source: 'yandex', yandexId: '9001', likeStatus: undefined }),
      makeTrack({ id: 'yandex:9002', source: 'yandex', yandexId: '9002', likeStatus: undefined }),
      makeTrack({ id: 'unliked-yt', likeStatus: 'INDIFFERENT' }),
    ];

    const hydrated = hydrateTracksLikeStatus(tracks, lookup);
    expect(hydrated.map(t => t.likeStatus)).toEqual([
      'LIKE',
      'LIKE',
      'LIKE',
      'LIKE',
      'LIKE',
      'LIKE',
      'INDIFFERENT',
    ]);
    // Неизмененный трек сохраняет исходную ссылку объекта.
    expect(hydrated[6]).toBe(tracks[6]);
  });

  it('keeps referential stability when no tracks change', () => {
    const t1 = makeTrack({ id: 'a', likeStatus: 'LIKE' });
    const t2 = makeTrack({ id: 'b', likeStatus: undefined });
    const list = [t1, t2];
    const lookup: TrackLikeLookup = { likedTrackIds: new Set(['a']) };

    expect(hydrateTrackLikeStatus(t1, lookup)).toBe(t1);
    expect(hydrateTracksLikeStatus(list, lookup)).toBe(list);
  });

  it('keeps HistoryView Yandex liked tracks as LIKE and demotes only truly unliked stale tracks when loaded', () => {
    const yxLikedByStore = makeTrack({ id: 'yandex:77', source: 'yandex', yandexId: '77', likeStatus: 'LIKE' });
    const yxLikedByMem = makeTrack({ id: 'yandex:88', source: 'yandex', yandexId: '88', likeStatus: undefined });
    const staleUnlikedYt = makeTrack({ id: 'old-yt', likeStatus: 'LIKE' });
    const staleUnlikedYx = makeTrack({ id: 'yandex:99', source: 'yandex', yandexId: '99', likeStatus: 'LIKE' });

    const unloadedLookup: TrackLikeLookup = {
      likedTrackIds: new Set(),
      loaded: false,
    };
    expect(resolveTrackLikeStatus(staleUnlikedYt, unloadedLookup, { demoteStaleLike: true })).toBe('LIKE');

    const loadedLookup: TrackLikeLookup = {
      likedTrackIds: new Set(['yandex:77']),
      likedYandexIds: new Set(['77']),
      isYandexLiked: (id) => id === '88',
      loaded: true,
    };
    expect(resolveTrackLikeStatus(yxLikedByStore, loadedLookup, { demoteStaleLike: true })).toBe('LIKE');
    expect(resolveTrackLikeStatus(yxLikedByMem, loadedLookup, { demoteStaleLike: true })).toBe('LIKE');
    expect(resolveTrackLikeStatus(staleUnlikedYt, loadedLookup, { demoteStaleLike: true })).toBe('INDIFFERENT');
    expect(resolveTrackLikeStatus(staleUnlikedYx, loadedLookup, { demoteStaleLike: true })).toBe('INDIFFERENT');
  });
});

describe('likedIndex live events, coalescing, and reconciliation', () => {
  it('overrides stale cached LIKE to INDIFFERENT on live unlike and does not snap back after store reload', async () => {
    storeMocks.ytEntries = [{ trackId: 'Lojtv9DCqdA', originalIndex: 0, syncedAt: 1 }];
    const unsub = likedIndex.subscribe(() => {});
    await flushMicrotasks();

    const cachedTrack = makeTrack({ id: 'Lojtv9DCqdA', likeStatus: 'LIKE' });
    expect(resolveTrackLikeStatus(cachedTrack, likedIndex.getSnapshot())).toBe('LIKE');

    // Пользователь снял лайк: запись удалена из IDB, но React Query кэш еще хранит likeStatus: 'LIKE'.
    storeMocks.ytEntries = [];
    fakeWindow.dispatchCustom('track-like-updated', {
      id: 'Lojtv9DCqdA',
      status: 'success',
      likeStatus: 'INDIFFERENT',
    });
    await flushMicrotasks();
    expect(resolveTrackLikeStatus(cachedTrack, likedIndex.getSnapshot())).toBe('INDIFFERENT');

    // После последующей перезагрузки сторов статус не должен откатываться обратно в устаревший LIKE.
    await reloadLikedIndex();
    expect(resolveTrackLikeStatus(cachedTrack, likedIndex.getSnapshot())).toBe('INDIFFERENT');

    unsub();
  });

  it('coalesces a burst of 1,500 broadcastYandexLikes events to 1 notification and clears pinned overrides on reload', async () => {
    let notifications = 0;
    const unsub = likedIndex.subscribe(() => { notifications++; });
    await flushMicrotasks();
    notifications = 0;

    // Имитируем loadYandexLikedIds(): заполняем in-memory set, шлем yandex-likes-loaded и 1500 синхронных событий.
    const total = 1500;
    for (let i = 0; i < total; i++) {
      storeMocks.yandexLikedMem.add(String(i));
    }
    fakeWindow.dispatchCustom('yandex-likes-loaded');
    for (let i = 0; i < total; i++) {
      fakeWindow.dispatchCustom('track-like-updated', {
        id: `yandex:${i}`,
        status: 'success',
        likeStatus: 'LIKE',
      });
    }

    // Все 1500 синхронных событий схлопываются в один микротаск-флаш + один reload.
    await flushMicrotasks(8);
    expect(notifications).toBeLessThanOrEqual(2);

    const afterBurst = likedIndex.getSnapshot();
    const overrideSize = afterBurst.overrides instanceof Map ? afterBurst.overrides.size : Object.keys(afterBurst.overrides || {}).length;
    expect(overrideSize).toBe(0);

    // Проверяем, что треки не залипли в overrides: после удаления трека из yandexLikedMem он перестает быть LIKE.
    storeMocks.yandexLikedMem.delete('42');
    await reloadLikedIndex();
    const removedTrack = makeTrack({ id: 'yandex:42', source: 'yandex', yandexId: '42', likeStatus: undefined });
    expect(resolveTrackLikeStatus(removedTrack, likedIndex.getSnapshot())).toBeUndefined();

    // А оставшиеся треки по-прежнему LIKE.
    const keptTrack = makeTrack({ id: 'yandex:43', source: 'yandex', yandexId: '43', likeStatus: undefined });
    expect(resolveTrackLikeStatus(keptTrack, likedIndex.getSnapshot())).toBe('LIKE');

    unsub();
  });

  it('coalesces 1,500 track-like-updated events without reload into exactly 1 subscriber notification', async () => {
    let notifications = 0;
    const unsub = likedIndex.subscribe(() => { notifications++; });
    await flushMicrotasks();
    notifications = 0;

    for (let i = 0; i < 1500; i++) {
      fakeWindow.dispatchCustom('track-like-updated', {
        id: `yt-${i}`,
        status: 'success',
        likeStatus: 'LIKE',
      });
    }

    await flushMicrotasks();
    expect(notifications).toBe(1);
    expect(resolveTrackLikeStatus(makeTrack({ id: 'yt-1499' }), likedIndex.getSnapshot())).toBe('LIKE');
    unsub();
  });

  it('resolves Yandex track by yandex: id prefix even when track.yandexId is omitted', async () => {
    storeMocks.yandexLikedMem.add('123');
    await reloadLikedIndex();
    const trackWithoutYandexId = makeTrack({
      id: 'yandex:123',
      source: 'yandex',
      likeStatus: undefined,
    });
    expect(resolveTrackLikeStatus(trackWithoutYandexId, likedIndex.getSnapshot())).toBe('LIKE');

    // Также проверяем при наличии записи только в likedYandexIds без likedTrackIds и in-memory set.
    const lookupByYandexSetOnly: TrackLikeLookup = {
      likedTrackIds: new Set(),
      likedYandexIds: new Set(['456']),
    };
    expect(
      resolveTrackLikeStatus(makeTrack({ id: 'yandex:456', source: 'yandex', likeStatus: undefined }), lookupByYandexSetOnly),
    ).toBe('LIKE');
  });

  it('preserves previous sets, avoids loaded=true demotion, and keeps overrides on transient IDB error', async () => {
    // 1. Первичная ошибка чтения YT не должна переводить loaded в true и сбрасывать лайки в HistoryView.
    storeMocks.getAllTracks.mockRejectedValueOnce(new Error('IDB busy'));
    await reloadLikedIndex();
    const afterInitialFail = likedIndex.getSnapshot();
    expect(afterInitialFail.loaded).toBe(false);
    expect(
      resolveTrackLikeStatus(makeTrack({ id: 'yt-1', likeStatus: 'LIKE' }), afterInitialFail, { demoteStaleLike: true }),
    ).toBe('LIKE');

    // 2. Успешная загрузка заполняет стор и помечает loaded=true.
    storeMocks.ytEntries = [{ trackId: 'yt-1', originalIndex: 0, syncedAt: 1 }];
    await reloadLikedIndex();
    expect(likedIndex.getSnapshot().loaded).toBe(true);
    expect(resolveTrackLikeStatus(makeTrack({ id: 'yt-1', likeStatus: undefined }), likedIndex.getSnapshot())).toBe('LIKE');

    // 3. Повторный сбой чтения YT сохраняет прошлый набор ytTrackIds и не сбрасывает live LIKE.
    const unsub = likedIndex.subscribe(() => {});
    await flushMicrotasks();
    fakeWindow.dispatchCustom('track-like-updated', {
      id: 'yt-new',
      status: 'success',
      likeStatus: 'LIKE',
    });
    await flushMicrotasks();

    storeMocks.getAllTracks.mockRejectedValueOnce(new Error('IDB transient error'));
    await reloadLikedIndex();
    const afterTransientFail = likedIndex.getSnapshot();
    expect(resolveTrackLikeStatus(makeTrack({ id: 'yt-1', likeStatus: undefined }), afterTransientFail)).toBe('LIKE');
    expect(resolveTrackLikeStatus(makeTrack({ id: 'yt-new', likeStatus: undefined }), afterTransientFail)).toBe('LIKE');
    unsub();
  });

  it('does not prune an unconfirmed SC LIKE override before IDB commit finishes', async () => {
    const unsub = likedIndex.subscribe(() => {});
    await flushMicrotasks();

    // Имитируем неавторизованный SC localOnly-лайк: событие пришло до завершения асинхронного addLocal().
    const scUrl = 'https://soundcloud.com/dope17/local-only';
    fakeWindow.dispatchCustom('track-like-updated', {
      id: scUrl,
      status: 'success',
      likeStatus: 'LIKE',
    });
    await flushMicrotasks();

    // Побочный reloadLikedIndex() читает IDB до записи sc_liked -> LIKE-переопределение должно сохраниться.
    await reloadLikedIndex();
    expect(
      resolveTrackLikeStatus(makeTrack({ id: scUrl, source: 'soundcloud', scId: '808', likeStatus: undefined }), likedIndex.getSnapshot()),
    ).toBe('LIKE');

    // Как только addLocal() записал трек в sc_liked, последующий reload безопасно очищает override.
    storeMocks.scEntries = [{ scId: '808', trackId: scUrl, likedAt: 1 }];
    await reloadLikedIndex();
    const snap = likedIndex.getSnapshot();
    expect(snap.overrides instanceof Map ? snap.overrides.has(scUrl) : false).toBe(false);
    expect(
      resolveTrackLikeStatus(makeTrack({ id: scUrl, source: 'soundcloud', scId: '808', likeStatus: undefined }), snap),
    ).toBe('LIKE');
    unsub();
  });

  it('clears stale INDIFFERENT override on remote re-like sync while protecting in-flight SC unlike', async () => {
    // --- Часть 1: YT удаленный повторный лайк с телефона/веба ---
    storeMocks.ytEntries = [{ trackId: 'yt-relike', originalIndex: 0, syncedAt: 1 }];
    const unsub = likedIndex.subscribe(() => {});
    await flushMicrotasks();

    // Снимаем лайк локально: IDB очищен, кэш все еще держит stale LIKE.
    storeMocks.ytEntries = [];
    fakeWindow.dispatchCustom('track-like-updated', {
      id: 'yt-relike',
      status: 'success',
      likeStatus: 'INDIFFERENT',
    });
    await flushMicrotasks();
    await reloadLikedIndex();
    const ytTrack = makeTrack({ id: 'yt-relike', likeStatus: 'LIKE' });
    expect(resolveTrackLikeStatus(ytTrack, likedIndex.getSnapshot())).toBe('INDIFFERENT');

    // Позже синк подтянул повторный лайк с телефона обратно в IDB -> INDIFFERENT очищается.
    storeMocks.ytEntries = [{ trackId: 'yt-relike', originalIndex: 0, syncedAt: 2 }];
    await reloadLikedIndex();
    expect(resolveTrackLikeStatus(ytTrack, likedIndex.getSnapshot())).toBe('LIKE');

    // --- Часть 2: SC in-flight unlike защищен, а удаленный SC re-like очищает INDIFFERENT ---
    const scUrl = 'https://soundcloud.com/dope17/re-like';
    storeMocks.scEntries = [{ scId: '909', trackId: scUrl, likedAt: 1 }];
    storeMocks.scLikedMem.add('909');
    await reloadLikedIndex();

    // Оптимистичный SC unlike: setScLikedInMemory(false) + track-like-updated до удаления из IDB!
    storeMocks.scLikedMem.delete('909');
    fakeWindow.dispatchCustom('track-like-updated', {
      id: scUrl,
      status: 'success',
      likeStatus: 'INDIFFERENT',
    });
    await flushMicrotasks();

    // Reload во время in-flight removeLocal (IDB еще содержит старую запись, но isScTrackLiked === false) не должен вернуть LIKE.
    await reloadLikedIndex();
    const scTrack = makeTrack({ id: scUrl, source: 'soundcloud', scId: '909', likeStatus: 'LIKE' });
    expect(resolveTrackLikeStatus(scTrack, likedIndex.getSnapshot())).toBe('INDIFFERENT');

    // Когда удаленный синк подтвердил повторный лайк и в IDB, и в isScTrackLiked -> INDIFFERENT снимается.
    storeMocks.scLikedMem.add('909');
    await reloadLikedIndex();
    expect(resolveTrackLikeStatus(scTrack, likedIndex.getSnapshot())).toBe('LIKE');

    unsub();
  });

  it('preserves a live user click that arrives while an async IDB reload is in flight', async () => {
    let resolveYt!: (v: Array<{ trackId: string; originalIndex: number; syncedAt: number }>) => void;
    storeMocks.getAllTracks.mockImplementationOnce(
      () => new Promise(res => { resolveYt = res; }),
    );

    const unsub = likedIndex.subscribe(() => {});
    // Пока initial reload ждет IDB, пользователь ставит лайк треку.
    fakeWindow.dispatchCustom('track-like-updated', {
      id: 'in-flight-like',
      status: 'success',
      likeStatus: 'LIKE',
    });
    await flushMicrotasks();

    // Устаревший снимок IDB резолвится без нового трека.
    resolveYt([]);
    await flushMicrotasks();

    expect(resolveTrackLikeStatus(makeTrack({ id: 'in-flight-like' }), likedIndex.getSnapshot())).toBe('LIKE');
    unsub();
  });
});

describe('useLikedLookup SSR safety', () => {
  it('renders via renderToStaticMarkup without throwing or triggering IDB scans during SSR', () => {
    function Probe() {
      const lookup = useLikedLookup();
      return createElement('span', { 'data-loaded': String(!!lookup.loaded) }, String(lookup.likedTrackIds.size));
    }

    const markup = renderToStaticMarkup(createElement(Probe));
    expect(markup).toContain('data-loaded="false"');
    expect(storeMocks.getAllTracks).not.toHaveBeenCalled();
  });
});

describe('likedIndex likeTargetIds indexing and re-like precedence', () => {
  it('indexes both trackId and likeTargetIds so Loj, 6r1, and counterpart references resolve to LIKE', async () => {
    storeMocks.ytEntries = [
      { trackId: 'Loj', originalIndex: 0, syncedAt: 1, likeTargetIds: ['6r1'] },
      { trackId: 'Cq4', originalIndex: 1, syncedAt: 1, likeTargetIds: ['Cq4', 'SZm'] },
    ];

    await reloadLikedIndex();
    const snap = likedIndex.getSnapshot();

    expect(resolveTrackLikeStatus(makeTrack({ id: 'Loj', likeStatus: undefined }), snap)).toBe('LIKE');
    expect(resolveTrackLikeStatus(makeTrack({ id: '6r1', likeStatus: undefined }), snap)).toBe('LIKE');
    expect(resolveTrackLikeStatus(makeTrack({ id: 'other-display', likeTargetId: '6r1', likeStatus: undefined }), snap)).toBe('LIKE');
    expect(resolveTrackLikeStatus(makeTrack({ id: 'Cq4', likeStatus: undefined }), snap)).toBe('LIKE');
    expect(resolveTrackLikeStatus(makeTrack({ id: 'SZm', likeStatus: undefined }), snap)).toBe('LIKE');
  });

  it('clears both Loj and 6r1 on unlike, then keeps re-liked Loj as LIKE after reload while 6r1 stays INDIFFERENT', async () => {
    storeMocks.ytEntries = [{ trackId: 'Loj', originalIndex: 0, syncedAt: 1, likeTargetIds: ['6r1'] }];
    const unsub = likedIndex.subscribe(() => {});
    await flushMicrotasks();

    const cachedPlayable = makeTrack({ id: 'Loj', likeTargetId: '6r1', likeStatus: 'LIKE' });
    const cachedCounterpart = makeTrack({ id: '6r1', likeStatus: 'LIKE' });
    const uncachedCounterpart = makeTrack({ id: '6r1', likeStatus: undefined });
    expect(resolveTrackLikeStatus(cachedPlayable, likedIndex.getSnapshot())).toBe('LIKE');
    expect(resolveTrackLikeStatus(uncachedCounterpart, likedIndex.getSnapshot())).toBe('LIKE');

    // Снятие лайка удаляет запись из IDB и шлет INDIFFERENT для Loj и 6r1.
    storeMocks.ytEntries = [];
    fakeWindow.dispatchCustom('track-like-updated', { id: 'Loj', status: 'success', likeStatus: 'INDIFFERENT' });
    fakeWindow.dispatchCustom('track-like-updated', { id: '6r1', status: 'success', likeStatus: 'INDIFFERENT' });
    await flushMicrotasks();
    await reloadLikedIndex();

    expect(resolveTrackLikeStatus(cachedPlayable, likedIndex.getSnapshot())).toBe('INDIFFERENT');
    expect(resolveTrackLikeStatus(cachedCounterpart, likedIndex.getSnapshot())).toBe('INDIFFERENT');

    // Повторный лайк Loj пишет в IDB только trackId Loj без 6r1 и шлет LIKE для Loj.
    // После reload override Loj снимается, а override 6r1 = INDIFFERENT остается в liveOverrides.
    storeMocks.ytEntries = [{ trackId: 'Loj', originalIndex: -1, syncedAt: 2 }];
    fakeWindow.dispatchCustom('track-like-updated', { id: 'Loj', status: 'success', likeStatus: 'LIKE' });
    await flushMicrotasks();
    await reloadLikedIndex();

    const afterRelike = likedIndex.getSnapshot();
    expect(afterRelike.overrides instanceof Map ? afterRelike.overrides.has('Loj') : false).toBe(false);
    expect(afterRelike.overrides instanceof Map ? afterRelike.overrides.get('6r1') : undefined).toBe('INDIFFERENT');

    // track.id в likedTrackIds обязан победить устаревший likeTargetId='6r1' в overrides!
    expect(resolveTrackLikeStatus(cachedPlayable, afterRelike)).toBe('LIKE');
    expect(resolveTrackLikeStatus(cachedCounterpart, afterRelike)).toBe('INDIFFERENT');
    unsub();
  });

  it('respects exact precedence: track.id override > track.id liked > likeTargetId override > likeTargetId liked', () => {
    // 1. track.id override побеждает все остальное
    expect(resolveTrackLikeStatus(
      makeTrack({ id: 'Loj', likeTargetId: '6r1', likeStatus: 'LIKE' }),
      { likedTrackIds: new Set(['Loj', '6r1']), overrides: new Map([['Loj', 'DISLIKE'], ['6r1', 'LIKE']]) },
    )).toBe('DISLIKE');

    // 2. track.id в likedTrackIds побеждает likeTargetId override
    expect(resolveTrackLikeStatus(
      makeTrack({ id: 'Loj', likeTargetId: '6r1', likeStatus: undefined }),
      { likedTrackIds: new Set(['Loj']), overrides: new Map([['6r1', 'INDIFFERENT']]) },
    )).toBe('LIKE');

    // 3. likeTargetId override побеждает likeTargetId в likedTrackIds
    expect(resolveTrackLikeStatus(
      makeTrack({ id: 'other', likeTargetId: '6r1', likeStatus: 'LIKE' }),
      { likedTrackIds: new Set(['6r1']), overrides: new Map([['6r1', 'INDIFFERENT']]) },
    )).toBe('INDIFFERENT');

    // 4. likeTargetId в likedTrackIds дает LIKE при отсутствии совпадения по track.id
    expect(resolveTrackLikeStatus(
      makeTrack({ id: 'other', likeTargetId: '6r1', likeStatus: undefined }),
      { likedTrackIds: new Set(['6r1']) },
    )).toBe('LIKE');
  });

  it('keeps DISLIKE override on partial dislike failure while trackId stays in yt_liked with only failed counterpart target', async () => {
    storeMocks.ytEntries = [{ trackId: 'Cq4', originalIndex: 0, syncedAt: 1, likeTargetIds: ['Cq4', 'SZm'] }];
    const unsub = likedIndex.subscribe(() => {});
    await flushMicrotasks();

    // rateSong('Cq4', 'DISLIKE') прошел, а rateSong('SZm', 'INDIFFERENT') упал:
    // в yt_liked осталась запись { trackId: 'Cq4', likeTargetIds: ['SZm'] }.
    storeMocks.ytEntries = [{ trackId: 'Cq4', originalIndex: 0, syncedAt: 1, likeTargetIds: ['SZm'] }];
    fakeWindow.dispatchCustom('track-like-updated', { id: 'Cq4', status: 'success', likeStatus: 'DISLIKE' });
    await flushMicrotasks();
    await reloadLikedIndex();

    const afterPartial = likedIndex.getSnapshot();
    expect(resolveTrackLikeStatus(makeTrack({ id: 'Cq4', likeStatus: 'LIKE' }), afterPartial)).toBe('DISLIKE');
    expect(resolveTrackLikeStatus(makeTrack({ id: 'SZm', likeStatus: undefined }), afterPartial)).toBe('LIKE');

    // Если позже Cq4 реально перелайкнули с телефона (он снова стал target), DISLIKE снимается.
    storeMocks.ytEntries = [{ trackId: 'Cq4', originalIndex: 0, syncedAt: 2, likeTargetIds: ['Cq4', 'SZm'] }];
    await reloadLikedIndex();
    expect(resolveTrackLikeStatus(makeTrack({ id: 'Cq4', likeStatus: undefined }), likedIndex.getSnapshot())).toBe('LIKE');
    unsub();
  });
});
