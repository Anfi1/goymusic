import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTrackDedupIndex,
  getQueueDedupIndex,
  isDuplicateTrack,
  normalizeSignature,
} from './soundcloud';
import type { YTMTrack } from './yt';

// Эталонная реализация прежнего алгоритма для проверки 100% эквивалентности
function legacyDurationToSec(d: string | undefined | null): number {
  if (!d) return 0;
  const parts = d.split(':').map(p => parseInt(p, 10));
  if (parts.some(isNaN)) return 0;
  return parts.reduce((acc, v) => acc * 60 + v, 0);
}

function legacyLevenshtein(a: string, b: string): number {
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  const dp: number[] = Array.from({ length: bl + 1 }, (_, i) => i);
  for (let i = 1; i <= al; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= bl; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[bl];
}

function legacyIsDuplicateTrack(a: YTMTrack, b: YTMTrack): boolean {
  const sigA = normalizeSignature(a);
  const sigB = normalizeSignature(b);
  if (sigA === sigB) return true;
  if (sigA.length === 0 || sigB.length === 0) return false;

  const durA = legacyDurationToSec(a.duration);
  const durB = legacyDurationToSec(b.duration);
  const durClose = durA <= 0 || durB <= 0 || Math.abs(durA - durB) <= 5;

  const maxLen = Math.max(sigA.length, sigB.length);
  const sim = maxLen === 0 ? 1 : 1 - legacyLevenshtein(sigA, sigB) / maxLen;
  if (sim >= 0.85 && durClose) return true;

  const artA = normalizeSignature({ ...a, title: '' } as YTMTrack);
  const artB = normalizeSignature({ ...b, title: '' } as YTMTrack);
  const titleA = normalizeSignature({ ...a, artists: [] } as YTMTrack);
  const titleB = normalizeSignature({ ...b, artists: [] } as YTMTrack);
  if (artA.length >= 8 && titleB.includes(artA) && durClose) return true;
  if (artB.length >= 8 && titleA.includes(artB) && durClose) return true;
  return false;
}

const track = (
  id: string,
  title: string,
  artists: string[],
  duration = '3:00',
): YTMTrack => ({
  id,
  title,
  artists,
  album: '',
  duration,
  thumbUrl: '',
  source: 'youtube',
});

describe('createTrackDedupIndex & isDuplicateTrack equivalence and speed', () => {
  it('совпадает с эталонной логикой на пограничных случаях', () => {
    const base = [
      track('1', 'Midnight City', ['M83'], '4:03'),
      track('2', 'Лето и арбалеты', ['Аким Апачев'], '3:20'),
      track('3', 'TrackWithTwentyChars', [], '2:30'),
      track('4', 'Random Song Name', ['LongArtistName123'], '3:10'),
      track('5', 'Unknown Dur Track', ['SomeBand'], '0:00'),
    ];
    const index = createTrackDedupIndex(base);

    const probes = [
      // точное совпадение id (даже если название сильно отличается)
      { t: track('1', 'Completely Different', ['Other'], '9:00'), expectMatch: true, exactId: true },
      // точное совпадение сигнатуры при разной длительности
      { t: track('p1', 'Midnight City!', ['M83'], '6:00'), expectMatch: true },
      // нечеткое >= 85% в допуске +-5с (граница ровно 5с)
      { t: track('p2', 'TrackWithTwentyChxrz', [], '2:35'), expectMatch: true },
      // та же строка, но разница 6с -> не дубль
      { t: track('p3', 'TrackWithTwentyChxrz', [], '2:36'), expectMatch: false },
      // 3 правки на 20 символов = ровно 0.85 -> дубль
      { t: track('p4', 'TrackWithTwentyChxyz', [], '2:30'), expectMatch: true },
      // 4 правки на 20 символов = 0.80 -> не дубль
      { t: track('p5', 'TrackWithTwentyCxxxx', [], '2:30'), expectMatch: false },
      // этап 3: title содержит артистов другого (>=8 символов) + длительность в +-5с
      { t: track('p6', 'LongArtistName123 (prod. x)', ['Uploader'], '3:15'), expectMatch: true },
      // этап 3, но разница > 5с -> не дубль
      { t: track('p7', 'LongArtistName123 (prod. x)', ['Uploader'], '3:16'), expectMatch: false },
      // обратный этап 3: артист запроса содержится в title из базы
      { t: track('p8', 'Anything', ['MidnightCity'], '4:05'), expectMatch: true },
      // неизвестная длительность в базе матчит любую длительность
      { t: track('p9', 'Unknown Dur Trak', ['SomeBand'], '5:40'), expectMatch: true },
      // неизвестная длительность в запросе матчит трек из базы
      { t: track('p10', 'Midnight Citx', ['M83'], ''), expectMatch: true },
      // кириллица и пунктуация
      { t: track('p11', 'Лето и арбалет', ['Аким Апачев'], '3:22'), expectMatch: true },
      // не дубль
      { t: track('p12', 'Totally Unrelated Song', ['Another Artist'], '3:00'), expectMatch: false },
    ];

    for (const { t, expectMatch, exactId } of probes) {
      expect(index.has(t), `index.has failed for ${t.id}`).toBe(expectMatch);
      expect(base.some(b => isDuplicateTrack(b, t)), `isDuplicateTrack failed for ${t.id}`).toBe(expectMatch);
      if (!exactId) {
        expect(base.some(b => legacyIsDuplicateTrack(b, t)), `legacy mismatch for ${t.id}`).toBe(expectMatch);
      }
    }
  });

  it('полная эквивалентность на наборе из 150 треков x 60 запросов', () => {
    const words = ['night', 'love', 'fire', 'neon', 'city', 'echo', 'wave', 'dream', 'ночь', 'ветер', 'луна', 'свет'];
    const artists = ['Daft Punk', 'The Weeknd', 'M83', 'Кино', 'Земфира', 'LongArtistOne', 'AnotherLongBand'];
    const mk = (seed: number, idPrefix: string): YTMTrack => {
      const w1 = words[seed % words.length];
      const w2 = words[(seed * 7 + 3) % words.length];
      const art = artists[(seed * 5 + 1) % artists.length];
      const sec = seed % 11 === 0 ? 0 : 90 + (seed * 17) % 240;
      const dur = sec === 0 ? '' : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
      return track(`${idPrefix}${seed}`, `${w1} ${w2} ${seed % 19}`, [art], dur);
    };

    const queue = Array.from({ length: 150 }, (_, i) => mk(i, 'q'));
    const queries = Array.from({ length: 60 }, (_, i) => {
      if (i % 4 === 0) {
        const base = queue[i];
        return track(`f${i}`, base.title.slice(0, -1) + 'x', base.artists || [], base.duration);
      }
      if (i % 4 === 1) {
        const base = queue[i];
        return track(`f${i}`, `${base.artists?.[0] || ''} remix`, ['SCUser'], base.duration);
      }
      return mk(i + 500, 'f');
    });

    const idx = createTrackDedupIndex(queue);
    for (const q of queries) {
      const expected = queue.some(b => legacyIsDuplicateTrack(b, q));
      expect(idx.has(q)).toBe(expected);
      expect(queue.some(b => isDuplicateTrack(b, q))).toBe(expected);
    }
  });

  it('укладывается в <25ms для 5,787 треков очереди x 72 свежих треков (кэшируемый WeakMap индекс)', () => {
    const vocabA = ['Aurora', 'Velvet', 'Crimson', 'Solar', 'Obsidian', 'Hollow', 'Static', 'Drift', 'Phantom', 'Mirror', 'Cinder', 'Pulse', 'Quartz', 'Ember', 'Vertex', 'Lucid'];
    const vocabB = ['Horizon', 'Cathedral', 'Frequency', 'Labyrinth', 'Monolith', 'Reverie', 'Cascade', 'Silhouette', 'Nostalgia', 'Paradox', 'Overdrive', 'Euphoria', 'Solstice', 'Tempest', 'Eclipse', 'Requiem'];
    const bands = ['Nordic', 'Kinetik', 'Valhalla', 'Sputnik', 'Zephyr', 'Monsoon', 'Vesper', 'Cobalt', 'Valkyrie', 'Orion', 'Mirage', 'Zenith', 'Krakow', 'Aether', 'Polaris', 'Cygnus'];

    const queue: YTMTrack[] = Array.from({ length: 5787 }, (_, i) => {
      const sec = 110 + (i % 240);
      const dur = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
      const t = `${vocabA[i % vocabA.length]} ${vocabB[(i * 7) % vocabB.length]} ${i.toString(36)}`;
      const a = `${bands[(i * 11) % bands.length]} ${vocabA[(i * 3 + 5) % vocabA.length]}`;
      return track(`q_${i}`, t, [a], dur);
    });
    const fresh: YTMTrack[] = Array.from({ length: 72 }, (_, i) => {
      const sec = 120 + (i * 13) % 220;
      const dur = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
      // Гарантированно уникальные названия, не похожие друг на друга и на очередь
      const t = `Omega${(i * 97 + 13).toString(36)} ${vocabB[i % vocabB.length]} Zeta${(i * 53 + 7).toString(36)} ${vocabA[(i * 5) % vocabA.length]}`;
      const a = `Studio${(i * 41 + 19).toString(36)} ${bands[(i * 3) % bands.length]}`;
      return track(`f_${i}`, t, [a], dur);
    });

    const t0 = performance.now();
    const queueIndex = getQueueDedupIndex(queue);
    const batchIndex = createTrackDedupIndex();
    const kept: YTMTrack[] = [];
    for (const t of fresh) {
      if (!batchIndex.has(t) && !queueIndex.has(t)) {
        batchIndex.add(t);
        kept.push(t);
      }
    }
    const coldMs = performance.now() - t0;

    // Повторный вызов для той же очереди должен переиспользовать WeakMap-индекс
    expect(getQueueDedupIndex(queue)).toBe(queueIndex);
    const t1 = performance.now();
    const keptWarm = fresh.filter(t => !getQueueDedupIndex(queue).has(t));
    const warmMs = performance.now() - t1;

    expect(kept).toHaveLength(72);
    expect(keptWarm).toHaveLength(72);
    console.log(`[bench] 5787x72 dedup: cold=${coldMs.toFixed(2)}ms, warm=${warmMs.toFixed(2)}ms`);
    // Запас для холодной сборки под параллельной нагрузкой CI (до фикса было ~2615ms)
    expect(coldMs).toBeLessThan(100);
    expect(warmMs).toBeLessThan(25);
  });
});

describe('PlayerStore queue reuse, rec gating, stale guards, and O(N) sync', () => {
  let getQueueRecommendations: ReturnType<typeof vi.fn>;
  let getScRecommendations: ReturnType<typeof vi.fn>;
  let getYandexRecommendations: ReturnType<typeof vi.fn>;
  let getYandexWaveTracks: ReturnType<typeof vi.fn>;
  let searchSoundCloud: ReturnType<typeof vi.fn>;
  let searchYandex: ReturnType<typeof vi.fn>;
  let getStreamUrl: ReturnType<typeof vi.fn>;
  let scEnabled: boolean;
  let yandexEnabled: boolean;

  class FakeAudio extends EventTarget {
    src = '';
    volume = 1;
    currentTime = 0;
    duration = 180;
    paused = false;
    ended = false;
    play = vi.fn().mockResolvedValue(undefined);
    pause = vi.fn();
    load = vi.fn();
    removeAttribute(attr: string) {
      if (attr === 'src') this.src = '';
    }
  }

  beforeEach(() => {
    vi.resetModules();
    scEnabled = false;
    yandexEnabled = false;
    getQueueRecommendations = vi.fn().mockResolvedValue({ tracks: [] });
    getScRecommendations = vi.fn().mockResolvedValue([]);
    getYandexRecommendations = vi.fn().mockResolvedValue([]);
    getYandexWaveTracks = vi.fn().mockResolvedValue([]);
    searchSoundCloud = vi.fn().mockResolvedValue([]);
    searchYandex = vi.fn().mockResolvedValue([]);
    getStreamUrl = vi.fn().mockResolvedValue({ url: 'https://cdn.example/a.m4a', expires: 9999999999, loudness: 0 });

    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    vi.stubGlobal('Audio', FakeAudio);
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    vi.stubGlobal('window', Object.assign(new EventTarget(), {
      bridge: { clearRPC: vi.fn(), setRPC: vi.fn(), pyCall: vi.fn().mockResolvedValue({ status: 'ok' }) },
    }));

    vi.doMock('./yt', () => ({
      getQueueRecommendations,
      rateSong: vi.fn(),
      searchMore: vi.fn().mockResolvedValue([]),
    }));
    vi.doMock('./soundcloud', async () => {
      const actual = await vi.importActual<typeof import('./soundcloud')>('./soundcloud');
      return {
        ...actual,
        searchSoundCloud,
        isSoundCloudEnabled: () => scEnabled,
        getScRecommendations,
      };
    });
    vi.doMock('./yandex', () => ({
      searchYandex,
      isYandexEnabled: () => yandexEnabled,
      getYandexRecommendations,
      getYandexWaveTracks,
      yandexRotorFeedback: vi.fn(),
      yandexPlayAudio: vi.fn(),
    }));
    vi.doMock('./stream', () => ({
      getStreamUrl,
      prefetchStreamUrl: vi.fn().mockResolvedValue(undefined),
      getExpirationFromUrl: () => Math.floor(Date.now() / 1000) + 3600,
      registerSoundCloudTrack: vi.fn(),
      registerYandexTrack: vi.fn(),
      ensureLoudness: vi.fn().mockResolvedValue(null),
      ensureLocalLoudness: vi.fn().mockResolvedValue(null),
      getLocalOverrideEntry: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock('./cache', () => ({
      streamCache: {
        init: async () => {},
        clearExpired: async () => {},
        get: vi.fn().mockResolvedValue(null),
      },
    }));
    vi.doMock('./likedManager', () => ({ likedManager: { toggleLike: vi.fn(), toggleDislike: vi.fn() } }));
    vi.doMock('./localOverrides', () => ({
      deleteOverride: vi.fn().mockResolvedValue(undefined),
      onOverrideChanged: vi.fn(),
      LOCAL_PLAYLIST_ID: 'LOCAL',
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock('./yt');
    vi.doUnmock('./soundcloud');
    vi.doUnmock('./yandex');
    vi.doUnmock('./stream');
    vi.doUnmock('./cache');
    vi.doUnmock('./likedManager');
    vi.doUnmock('./localOverrides');
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('playTrackList переиспользует this.queue и сохраняет recommendations в том же плейлисте, а startPlayback не шлет рекомендации далеко от конца', async () => {
    const { player } = await import('./player');
    player.rpcEnabled = false;
    vi.spyOn(player, 'initAudioContext').mockResolvedValue(undefined);

    const list = Array.from({ length: 100 }, (_, i) => track(`t_${i}`, `Title ${i}`, ['Art']));
    await player.playTrackList(list, 5, 'LM', 'playlist');

    // Далеко от конца (100 - 5 > 20) -> рекомендации не запрашиваются
    expect(getQueueRecommendations).not.toHaveBeenCalled();

    const firstQueueRef = player.queue;
    const preservedRecs = [track('rec_1', 'Rec 1', ['Art'])];
    player.recommendations = preservedRecs;

    // Клик по другому треку в том же плейлисте с тем же составом -> та же ссылка queue и те же recommendations
    await player.playTrackList(list.slice(), 10, 'LM', 'playlist');
    expect(player.queue).toBe(firstQueueRef);
    expect(player.queueIndex).toBe(10);
    expect(player.recommendations).toBe(preservedRecs);
    expect(getQueueRecommendations).not.toHaveBeenCalled();

    // Клик ближе 20 треков к концу -> рекомендации запрашиваются
    player.recommendations = [];
    await player.playTrackList(list.slice(), 85, 'LM', 'playlist');
    expect(player.queue).toBe(firstQueueRef);
    expect(getQueueRecommendations).toHaveBeenCalledTimes(1);
  });

  it('updateQueueIfSourceMatches сохраняет likeStatus за O(N) в обычном и shuffle режимах', async () => {
    const { player } = await import('./player');
    player.rpcEnabled = false;
    vi.spyOn(player, 'initAudioContext').mockResolvedValue(undefined);

    const list = Array.from({ length: 5787 }, (_, i) => ({
      ...track(`t_${i}`, `Title ${i}`, ['Art']),
      likeStatus: i === 10 ? ('LIKE' as const) : undefined,
    }));
    await player.playTrackList(list, 10, 'LM', 'playlist');

    const refreshed = list.map((t, i) => ({
      ...t,
      title: i === 5000 ? 'Updated Title' : t.title,
      likeStatus: i === 10 ? undefined : ('INDIFFERENT' as const),
    }));

    const t0 = performance.now();
    player.updateQueueIfSourceMatches('LM', refreshed);
    const elapsedMs = performance.now() - t0;

    expect(player.queue[10].likeStatus).toBe('LIKE');
    expect(player.queue[5000].title).toBe('Updated Title');
    expect(elapsedMs).toBeLessThan(50);

    // Также проверяем shuffle-режим на сохранение likeStatus и порядок
    player.toggleShuffle();
    const shuffledOrder = player.queue.map(t => t.id);
    const refreshed2 = refreshed.map(t => (t.id === 't_10' ? { ...t, title: 'Shuffled Update', likeStatus: undefined } : t));
    player.updateQueueIfSourceMatches('LM', refreshed2);
    expect(player.queue.map(t => t.id)).toEqual(shuffledOrder);
    const t10 = player.queue.find(t => t.id === 't_10');
    expect(t10?.title).toBe('Shuffled Update');
    expect(t10?.likeStatus).toBe('LIKE');
  });

  it('stale-track guard отбрасывает устаревшие ответы в SC, Yandex и multi-source радио', async () => {
    scEnabled = true;
    yandexEnabled = true;
    const { player } = await import('./player');
    player.rpcEnabled = false;
    vi.spyOn(player, 'initAudioContext').mockResolvedValue(undefined);

    // 1. SoundCloud radio stale guard
    let resolveSc!: (tracks: YTMTrack[]) => void;
    getScRecommendations.mockImplementationOnce(() => new Promise(r => { resolveSc = r; }));
    player.radioSources = ['soundcloud'];
    const sc1: YTMTrack = { ...track('https://soundcloud.com/a/1', 'One', ['A']), source: 'soundcloud', scUrl: 'https://soundcloud.com/a/1', scId: '1' };
    const sc2: YTMTrack = { ...track('https://soundcloud.com/a/2', 'Two', ['B']), source: 'soundcloud', scUrl: 'https://soundcloud.com/a/2', scId: '2' };
    player.currentTrack = sc1;
    player.queue = [sc1];
    const pSc = (player as any).fetchSoundCloudRadio(sc1.id, true);
    player.currentTrack = sc2;
    resolveSc([track('stale_sc', 'Stale SC', ['X'])]);
    await pSc;
    expect(player.recommendations).toEqual([]);

    // 2. Yandex radio stale guard
    let resolveYa!: (tracks: YTMTrack[]) => void;
    getYandexRecommendations.mockImplementationOnce(() => new Promise(r => { resolveYa = r; }));
    const ya1: YTMTrack = { ...track('ya1', 'YOne', ['A']), source: 'yandex', yandexId: '111' };
    const ya2: YTMTrack = { ...track('ya2', 'YTwo', ['B']), source: 'yandex', yandexId: '222' };
    player.currentTrack = ya1;
    player.queue = [ya1];
    const pYa = (player as any).fetchYandexRadio(ya1.id, true);
    player.currentTrack = ya2;
    resolveYa([track('stale_ya', 'Stale YA', ['X'])]);
    await pYa;
    expect(player.recommendations).toEqual([]);

    // 3. Multi-source stale guard
    let resolveYt!: (res: { tracks: YTMTrack[] }) => void;
    getQueueRecommendations.mockImplementationOnce(() => new Promise(r => { resolveYt = r; }));
    getScRecommendations.mockResolvedValueOnce([]);
    const yt1 = track('yt1', 'YT One', ['A']);
    const yt2 = track('yt2', 'YT Two', ['B']);
    player.currentTrack = yt1;
    player.queue = [yt1];
    const pMulti = (player as any).fetchMultiSourceRecommendations(yt1.id, true, new Set(['youtube', 'soundcloud']));
    player.currentTrack = yt2;
    resolveYt({ tracks: [track('stale_multi', 'Stale Multi', ['X'])] });
    await pMulti;
    expect(player.recommendations).toEqual([]);
  });
});
