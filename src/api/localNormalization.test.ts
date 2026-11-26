import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalOverride } from './localOverrides';
import type { YTMTrack } from './yt';

describe('stream.ts local override loudness & prefetch priority', () => {
  let getOverride: ReturnType<typeof vi.fn>;
  let setOverride: ReturnType<typeof vi.fn>;
  let updateOverrideGain: ReturnType<typeof vi.fn>;
  let songFileExists: ReturnType<typeof vi.fn>;
  let getSongFileUrl: ReturnType<typeof vi.fn>;
  let getSongsPath: ReturnType<typeof vi.fn>;
  let pyCall: ReturnType<typeof vi.fn>;
  let cacheInit: ReturnType<typeof vi.fn>;
  let cacheGet: ReturnType<typeof vi.fn>;
  let cacheIsFresh: ReturnType<typeof vi.fn>;
  let cacheSet: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    getOverride = vi.fn();
    setOverride = vi.fn().mockResolvedValue(undefined);
    updateOverrideGain = vi.fn().mockResolvedValue(true);
    songFileExists = vi.fn().mockResolvedValue(true);
    getSongFileUrl = vi.fn(async (name: string) => `file:///C:/songs/${name}`);
    getSongsPath = vi.fn().mockResolvedValue('C:\\songs');
    pyCall = vi.fn();
    cacheInit = vi.fn().mockResolvedValue(undefined);
    cacheGet = vi.fn().mockResolvedValue(null);
    cacheIsFresh = vi.fn().mockResolvedValue(false);
    cacheSet = vi.fn().mockResolvedValue(undefined);

    vi.stubGlobal('window', {
      bridge: { songFileExists, getSongFileUrl, getSongsPath, pyCall },
    });

    vi.doMock('./localOverrides', () => ({
      getOverride,
      setOverride,
      updateOverrideGain,
      isOverrideGainMeasured: (o: Pick<LocalOverride, 'gainDb' | 'gainMeasured'>) => {
        if (typeof o.gainDb !== 'number' || !Number.isFinite(o.gainDb)) return false;
        if (o.gainMeasured === true) return true;
        if (o.gainMeasured === false) return false;
        return o.gainDb !== 0;
      },
    }));

    vi.doMock('./cache', () => ({
      streamCache: {
        init: cacheInit,
        get: cacheGet,
        set: cacheSet,
        delete: vi.fn().mockResolvedValue(undefined),
        isFresh: cacheIsFresh,
        getLoudness: vi.fn().mockResolvedValue(null),
        setLoudness: vi.fn().mockResolvedValue(undefined),
      },
    }));
  });

  afterEach(() => {
    vi.doUnmock('./localOverrides');
    vi.doUnmock('./cache');
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('getLocalOverrideEntry возвращает loudness: null для устаревшего gainDb=0 и число для измеренного', async () => {
    const stream = await import('./stream');
    getOverride.mockResolvedValueOnce({
      videoId: 'sc1',
      filename: 'dope17.m4a',
      sourceUrl: 'https://soundcloud.com/a/dope17',
      sourceType: 'direct',
      gainDb: 0,
      addedAt: 1,
    });
    expect(await stream.getLocalOverrideEntry('sc1')).toEqual({
      url: 'file:///C:/songs/dope17.m4a',
      expires: 9999999999,
      loudness: null,
    });

    getOverride.mockResolvedValueOnce({
      videoId: 'sc2',
      filename: 'exact0.m4a',
      sourceUrl: 'u',
      sourceType: 'direct',
      gainDb: 0,
      gainMeasured: true,
      addedAt: 1,
    });
    expect(await stream.getLocalOverrideEntry('sc2')).toEqual({
      url: 'file:///C:/songs/exact0.m4a',
      expires: 9999999999,
      loudness: 0,
    });
  });

  it('ensureLocalLoudness дедуплицирует параллельные вызовы и тихо сохраняет результат', async () => {
    const stream = await import('./stream');
    getOverride.mockResolvedValue({
      videoId: 'vidA',
      filename: 'a.m4a',
      sourceUrl: 'u',
      sourceType: 'direct',
      gainDb: 0,
      addedAt: 1,
    });
    let resolveAnalyze!: (val: unknown) => void;
    pyCall.mockImplementationOnce(() => new Promise((r) => { resolveAnalyze = r; }));

    const p1 = stream.ensureLocalLoudness('vidA');
    const p2 = stream.ensureLocalLoudness('vidA');
    await vi.waitFor(() => expect(pyCall).toHaveBeenCalledTimes(1));
    expect(pyCall).toHaveBeenCalledWith('analyze_file', { filename: 'a.m4a', songsPath: 'C:\\songs' });

    resolveAnalyze({ status: 'ok', gainDb: 6.75, measured: true });
    expect(await Promise.all([p1, p2])).toEqual([6.75, 6.75]);
    expect(updateOverrideGain).toHaveBeenCalledExactlyOnceWith('vidA', 'a.m4a', 6.75);
  });

  it('ensureLocalLoudness не склеивает замененный файл в старый промис и возвращает null при устаревшем updateOverrideGain', async () => {
    const stream = await import('./stream');
    let currentFilename = 'old.m4a';
    getOverride.mockImplementation(async () => ({
      videoId: 'vidSwap',
      filename: currentFilename,
      sourceUrl: 'u',
      sourceType: 'direct',
      gainDb: 0,
      addedAt: 1,
    }));

    let resolveOld!: (v: unknown) => void;
    let resolveNew!: (v: unknown) => void;
    pyCall.mockImplementation((_cmd: string, args: { filename: string }) => new Promise((r) => {
      if (args.filename === 'old.m4a') resolveOld = r;
      else if (args.filename === 'new.m4a') resolveNew = r;
    }));
    updateOverrideGain.mockImplementation(async (_vid: string, filename: string) => filename === currentFilename);

    const pOld = stream.ensureLocalLoudness('vidSwap');
    await vi.waitFor(() => expect(pyCall).toHaveBeenCalledTimes(1));

    // Пользователь заменил локальный файл, пока старый еще анализировался
    currentFilename = 'new.m4a';
    const pNew = stream.ensureLocalLoudness('vidSwap');
    await vi.waitFor(() => expect(pyCall).toHaveBeenCalledTimes(2));
    expect(pyCall).toHaveBeenNthCalledWith(2, 'analyze_file', { filename: 'new.m4a', songsPath: 'C:\\songs' });

    // Старый анализ завершился: updateOverrideGain вернет false -> ensureLocalLoudness должен вернуть null
    resolveOld({ status: 'ok', gainDb: 11.5, measured: true });
    expect(await pOld).toBeNull();

    // Новый анализ завершился: успешно сохраняется и возвращает 3.5
    resolveNew({ status: 'ok', gainDb: 3.5, measured: true });
    expect(await pNew).toBe(3.5);
  });

  it('ensureLocalLoudness запоминает провал для (videoId, filename) на сессию и не зацикливается', async () => {
    const stream = await import('./stream');
    getOverride.mockResolvedValue({
      videoId: 'silent1',
      filename: 'silent_v1.m4a',
      sourceUrl: 'u',
      sourceType: 'local',
      gainDb: 0,
      addedAt: 1,
    });
    pyCall.mockResolvedValueOnce({ status: 'ok', gainDb: 0, measured: false });

    expect(await stream.ensureLocalLoudness('silent1')).toBeNull();
    expect(await stream.ensureLocalLoudness('silent1')).toBeNull();
    expect(pyCall).toHaveBeenCalledTimes(1);
    expect(updateOverrideGain).not.toHaveBeenCalled();

    // При замене файла для того же videoId замер запускается снова
    getOverride.mockResolvedValue({
      videoId: 'silent1',
      filename: 'silent_v2.m4a',
      sourceUrl: 'u',
      sourceType: 'local',
      gainDb: 0,
      addedAt: 2,
    });
    pyCall.mockResolvedValueOnce({ status: 'ok', gainDb: 4.2, measured: true });
    expect(await stream.ensureLocalLoudness('silent1')).toBe(4.2);
    expect(pyCall).toHaveBeenCalledTimes(2);
  });

  it('prefetchStreamUrl проверяет локальный override раньше scRegistry и не дергает SC-стрим', async () => {
    const stream = await import('./stream');
    const scId = 'https://soundcloud.com/artist/track';
    stream.registerSoundCloudTrack(scId, scId);
    getOverride.mockResolvedValue({
      videoId: scId,
      filename: 'sc_local.m4a',
      sourceUrl: scId,
      sourceType: 'direct',
      gainDb: 5,
      addedAt: 1,
    });

    await stream.prefetchStreamUrl(scId);
    expect(pyCall).not.toHaveBeenCalled();
  });

  it('getStreamUrl при фоновом перекачивании пропавшего файла обновляет gainDb и gainMeasured', async () => {
    const stream = await import('./stream');
    const scId = 'https://soundcloud.com/artist/missing';
    stream.registerSoundCloudTrack(scId, scId);
    getOverride.mockResolvedValue({
      videoId: scId,
      filename: 'missing.m4a',
      sourceUrl: scId,
      sourceType: 'soundcloud',
      gainDb: 0,
      addedAt: 1,
    });
    songFileExists.mockResolvedValue(false);
    pyCall.mockImplementation(async (cmd: string) => {
      if (cmd === 'download_track') {
        return { status: 'ok', filename: 'redownloaded.m4a', gainDb: 0, gainMeasured: true };
      }
      if (cmd === 'get_preview_url') {
        return { status: 'ok', streamUrl: 'https://cdn.example/sc.mp3', loudness: null };
      }
      return { status: 'error' };
    });

    const entry = await stream.getStreamUrl(scId);
    expect(entry?.url).toBe('https://cdn.example/sc.mp3');
    await vi.waitFor(() => {
      expect(setOverride).toHaveBeenCalledWith(expect.objectContaining({
        videoId: scId,
        filename: 'redownloaded.m4a',
        gainDb: 0,
        gainMeasured: true,
      }));
    });
  });
});

describe('PlayerStore local loudness auto-healing & seamless local preload', () => {
  const audioInstances: FakeAudio[] = [];
  let overrideListener: ((e: CustomEvent) => void) | null = null;
  let getStreamUrl: ReturnType<typeof vi.fn>;
  let getLocalOverrideEntry: ReturnType<typeof vi.fn>;
  let ensureLocalLoudness: ReturnType<typeof vi.fn>;
  let ensureLoudness: ReturnType<typeof vi.fn>;
  let prefetchStreamUrl: ReturnType<typeof vi.fn>;
  let streamCacheGet: ReturnType<typeof vi.fn>;
  let gainOps: Array<{ op: string; value?: number; time?: number }>;
  let mockGainParam: {
    value: number;
    cancelScheduledValues: ReturnType<typeof vi.fn>;
    setValueAtTime: ReturnType<typeof vi.fn>;
    linearRampToValueAtTime: ReturnType<typeof vi.fn>;
  };

  class FakeAudio extends EventTarget {
    src = '';
    volume = 1;
    currentTime = 0;
    duration = 120;
    paused = false;
    ended = false;
    play = vi.fn().mockResolvedValue(undefined);
    pause = vi.fn();
    load = vi.fn();
    removeAttribute(attr: string) {
      if (attr === 'src') this.src = '';
    }
    constructor() {
      super();
      audioInstances.push(this);
    }
  }

  beforeEach(() => {
    vi.resetModules();
    audioInstances.length = 0;
    overrideListener = null;
    gainOps = [];

    mockGainParam = {
      value: 1.0,
      cancelScheduledValues: vi.fn((t: number) => gainOps.push({ op: 'cancel', time: t })),
      setValueAtTime: vi.fn((v: number, t: number) => {
        mockGainParam.value = v;
        gainOps.push({ op: 'set', value: v, time: t });
      }),
      linearRampToValueAtTime: vi.fn((v: number, t: number) => {
        mockGainParam.value = v;
        gainOps.push({ op: 'ramp', value: v, time: t });
      }),
    };

    getStreamUrl = vi.fn();
    getLocalOverrideEntry = vi.fn().mockResolvedValue(null);
    ensureLocalLoudness = vi.fn().mockResolvedValue(null);
    ensureLoudness = vi.fn().mockResolvedValue(null);
    prefetchStreamUrl = vi.fn().mockResolvedValue(undefined);
    streamCacheGet = vi.fn().mockResolvedValue(null);

    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    vi.stubGlobal('Audio', FakeAudio);
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    vi.stubGlobal('window', Object.assign(new EventTarget(), {
      bridge: { clearRPC: vi.fn(), setRPC: vi.fn(), pyCall: vi.fn().mockResolvedValue({ status: 'ok' }) },
      AudioContext: class {
        currentTime = 10;
        state = 'running';
        destination = {};
        resume = vi.fn().mockResolvedValue(undefined);
        suspend = vi.fn().mockResolvedValue(undefined);
        createMediaElementSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
        createGain = vi.fn(() => ({ gain: mockGainParam, connect: vi.fn(), disconnect: vi.fn() }));
        createAnalyser = vi.fn(() => ({
          fftSize: 8192,
          smoothingTimeConstant: 0.65,
          frequencyBinCount: 4096,
          connect: vi.fn(),
          disconnect: vi.fn(),
        }));
        createBiquadFilter = vi.fn(() => ({
          type: 'peaking',
          frequency: { value: 1000 },
          gain: { value: 0 },
          Q: { value: 1 },
          connect: vi.fn(),
          disconnect: vi.fn(),
        }));
      },
    }));

    vi.doMock('./yt', () => ({
      getQueueRecommendations: vi.fn().mockResolvedValue({ tracks: [] }),
      rateSong: vi.fn(),
      searchMore: vi.fn().mockResolvedValue([]),
    }));
    vi.doMock('./soundcloud', () => ({
      searchSoundCloud: vi.fn().mockResolvedValue([]),
      isSoundCloudEnabled: () => false,
      interleaveMany: (lists: YTMTrack[][]) => lists.flat(),
      pickBestScMatch: () => null,
      isSoundCloudId: () => false,
      getScRecommendations: vi.fn().mockResolvedValue([]),
      isDuplicateTrack: () => false,
      createTrackDedupIndex: () => ({ has: () => false, add: () => {} }),
      getQueueDedupIndex: () => ({ has: () => false, add: () => {} }),
    }));
    vi.doMock('./yandex', () => ({
      searchYandex: vi.fn().mockResolvedValue([]),
      isYandexEnabled: () => false,
      getYandexRecommendations: vi.fn().mockResolvedValue([]),
      getYandexWaveTracks: vi.fn().mockResolvedValue([]),
      yandexRotorFeedback: vi.fn(),
      yandexPlayAudio: vi.fn(),
    }));
    vi.doMock('./stream', () => ({
      getStreamUrl,
      prefetchStreamUrl,
      getExpirationFromUrl: () => Math.floor(Date.now() / 1000) + 3600,
      registerSoundCloudTrack: vi.fn(),
      registerYandexTrack: vi.fn(),
      ensureLoudness,
      ensureLocalLoudness,
      getLocalOverrideEntry,
    }));
    vi.doMock('./cache', () => ({
      streamCache: {
        init: async () => {},
        clearExpired: async () => {},
        get: streamCacheGet,
      },
    }));
    vi.doMock('./likedManager', () => ({ likedManager: { toggleLike: vi.fn(), toggleDislike: vi.fn() } }));
    vi.doMock('./localOverrides', () => ({
      deleteOverride: vi.fn().mockResolvedValue(undefined),
      onOverrideChanged: (cb: (e: CustomEvent) => void) => { overrideListener = cb; return () => {}; },
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

  const makeTrack = (id: string): YTMTrack => ({
    id,
    title: `Track ${id}`,
    artists: ['Artist'],
    album: '',
    duration: '2:00',
    thumbUrl: '',
    source: 'youtube',
  });

  it('якорит рамп setValueAtTime и автодомеряет локальный файл с loudness: null', async () => {
    const { player } = await import('./player');
    player.rpcEnabled = false;

    let resolveMeasure!: (v: number | null) => void;
    ensureLocalLoudness.mockImplementationOnce(() => new Promise((r) => { resolveMeasure = r; }));
    getStreamUrl.mockResolvedValueOnce({
      url: 'file:///C:/songs/dope17.m4a',
      expires: 9999999999,
      loudness: null,
    });

    await player.playSingle(makeTrack('local-unmeasured'));

    expect(ensureLocalLoudness).toHaveBeenCalledExactlyOnceWith('local-unmeasured');
    expect(ensureLoudness).not.toHaveBeenCalled();

    // Временный безопасный +6 dB (~0.501) и якорение setValueAtTime перед linearRamp
    const lastThree = gainOps.slice(-3);
    expect(lastThree.map(x => x.op)).toEqual(['cancel', 'set', 'ramp']);
    expect(lastThree[2].value).toBeCloseTo(Math.pow(10, -6 / 20), 3);

    // После замера применяется реальный гейн +9 dB
    resolveMeasure(9);
    await Promise.resolve();
    await Promise.resolve();

    const finalThree = gainOps.slice(-3);
    expect(finalThree.map(x => x.op)).toEqual(['cancel', 'set', 'ramp']);
    expect(finalThree[2].value).toBeCloseTo(Math.pow(10, -9 / 20), 3);

    // Если трек сменился до завершения замера, поздний результат игнорируется
    let resolveLate!: (v: number | null) => void;
    ensureLocalLoudness.mockImplementationOnce(() => new Promise((r) => { resolveLate = r; }));
    getStreamUrl
      .mockResolvedValueOnce({ url: 'file:///C:/songs/first.m4a', expires: 9999999999, loudness: null })
      .mockResolvedValueOnce({ url: 'https://cdn.example/second.m4a', expires: 9999999999, loudness: 2 });

    await player.playSingle(makeTrack('local-stale'));
    await player.playSingle(makeTrack('remote-next'));
    const opsCountAfterSwitch = gainOps.length;
    resolveLate(12);
    await Promise.resolve();
    await Promise.resolve();
    expect(gainOps.length).toBe(opsCountAfterSwitch);
  });

  it('preloadNextTrack берет локальный override первым, а бесшовный next() сохраняет isCurrentTrackLocal и нормализацию', async () => {
    const { player } = await import('./player');
    player.rpcEnabled = false;

    const t1 = makeTrack('t1');
    const t2 = makeTrack('t2');
    getStreamUrl.mockResolvedValueOnce({
      url: 'https://cdn.example/t1.m4a',
      expires: 9999999999,
      loudness: 3,
    });
    getLocalOverrideEntry.mockResolvedValueOnce({
      url: 'file:///C:/songs/t2.m4a',
      expires: 9999999999,
      loudness: 7.5,
    });

    await player.playTrackList([t1, t2], 0, 'PL1');
    audioInstances[0].dispatchEvent(new Event('canplay'));
    await vi.waitFor(() => expect(player.isStreamLoading).toBe(false));

    // Триггерим preloadNextTrack (как за 5с до конца)
    await (player as any).preloadNextTrack();
    expect(getLocalOverrideEntry).toHaveBeenCalledWith('t2');
    expect(audioInstances[1].src).toBe('file:///C:/songs/t2.m4a');
    expect(streamCacheGet).not.toHaveBeenCalled();

    // Бесшовный переход на t2
    gainOps.length = 0;
    await player.next();
    expect(player.currentTrack?.id).toBe('t2');
    expect(player.isCurrentTrackLocal).toBe(true);
    expect(audioInstances[1].play).toHaveBeenCalled();
    expect(gainOps.at(-1)?.value).toBeCloseTo(Math.pow(10, -7.5 / 20), 3);
  });

  it('onOverrideChanged сбрасывает preloadedTrackId/preloadedEntry для предзагруженного трека', async () => {
    const { player } = await import('./player');
    player.rpcEnabled = false;

    const t1 = makeTrack('t1');
    const t2 = makeTrack('t2');
    getStreamUrl
      .mockResolvedValueOnce({ url: 'https://cdn.example/t1.m4a', expires: 9999999999, loudness: 0 })
      .mockResolvedValueOnce({ url: 'file:///C:/songs/t2_new.m4a', expires: 9999999999, loudness: 5 });
    getLocalOverrideEntry.mockResolvedValueOnce({
      url: 'file:///C:/songs/t2_old.m4a',
      expires: 9999999999,
      loudness: 2,
    });

    await player.playTrackList([t1, t2], 0, 'PL1');
    await (player as any).preloadNextTrack();
    expect((player as any).preloadedTrackId).toBe('t2');

    // Override для предзагруженного t2 изменился -> предзагрузка и idleAudio.src должны сброситься
    overrideListener?.(new CustomEvent('local-override-changed', { detail: { videoId: 't2', action: 'set' } }));
    expect((player as any).preloadedTrackId).toBeNull();
    expect((player as any).preloadedEntry).toBeNull();
    expect(audioInstances[1].src).toBe('');
  });

  it('onOverrideChanged во время in-flight preloadNextTrack отбрасывает устаревший результат предзагрузки', async () => {
    const { player } = await import('./player');
    player.rpcEnabled = false;

    const t1 = makeTrack('t1');
    const t2 = makeTrack('t2');
    getStreamUrl.mockResolvedValueOnce({ url: 'https://cdn.example/t1.m4a', expires: 9999999999, loudness: 0 });

    let resolvePreload!: (v: unknown) => void;
    getLocalOverrideEntry.mockImplementationOnce(() => new Promise((r) => { resolvePreload = r; }));

    await player.playTrackList([t1, t2], 0, 'PL1');
    const preloadPromise = (player as any).preloadNextTrack();
    await vi.waitFor(() => expect(getLocalOverrideEntry).toHaveBeenCalledWith('t2'));

    // Событие смены override прилетает ПОКА preloadNextTrack ждет ответа
    overrideListener?.(new CustomEvent('local-override-changed', { detail: { videoId: 't2', action: 'set' } }));
    resolvePreload({ url: 'file:///C:/songs/t2_stale.m4a', expires: 9999999999, loudness: 2 });
    await preloadPromise;

    expect((player as any).preloadedTrackId).toBeNull();
    expect((player as any).preloadedEntry).toBeNull();
    expect(audioInstances[1].src).toBe('');
  });

  it('playbackId защищает ensureLoudnessFor при перезапуске того же trackId и инкрементится при бесшовном next()', async () => {
    const { player } = await import('./player');
    player.rpcEnabled = false;

    const t1 = makeTrack('same-id');
    const t2 = makeTrack('next-id');
    let resolveOldMeasure!: (v: number | null) => void;
    ensureLocalLoudness.mockImplementationOnce(() => new Promise((r) => { resolveOldMeasure = r; }));
    getStreamUrl
      .mockResolvedValueOnce({ url: 'file:///C:/songs/old.m4a', expires: 9999999999, loudness: null })
      .mockResolvedValueOnce({ url: 'file:///C:/songs/new.m4a', expires: 9999999999, loudness: 2 });

    await player.playTrackList([t1, t2], 0, 'PL1');
    // Перезапускаем ТОТ ЖЕ trackId (например, после смены override на файл с известным gainDb=2)
    overrideListener?.(new CustomEvent('local-override-changed', { detail: { videoId: 'same-id', action: 'set' } }));
    await vi.waitFor(() => expect(getStreamUrl).toHaveBeenCalledTimes(2));

    const opsAfterReload = gainOps.length;
    // Старый замер для того же trackId прилетает с опозданием -> должен быть отброшен по playbackId
    resolveOldMeasure(11);
    await Promise.resolve();
    await Promise.resolve();
    expect(gainOps.length).toBe(opsAfterReload);

    // Бесшовный переход на t2 должен увеличить playbackId
    const pidBeforeSeamless = (player as any).playbackId;
    getLocalOverrideEntry.mockResolvedValueOnce({
      url: 'file:///C:/songs/t2.m4a',
      expires: 9999999999,
      loudness: 4,
    });
    await (player as any).preloadNextTrack();
    await player.next();
    expect((player as any).playbackId).toBeGreaterThan(pidBeforeSeamless);
  });
});

describe('yt.ts getLyrics AbortSignal cancellation', () => {
  let pyCall: ReturnType<typeof vi.fn>;
  let pyCancel: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    pyCall = vi.fn();
    pyCancel = vi.fn();
    vi.stubGlobal('window', { bridge: { pyCall, pyCancel } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('сразу возвращает null без pyCall, если signal уже aborted', async () => {
    const { getLyrics } = await import('./yt');
    const ac = new AbortController();
    ac.abort();

    const res = await getLyrics('Artist', 'Title', 180, 'vid1', undefined, ac.signal);
    expect(res).toBeNull();
    expect(pyCall).not.toHaveBeenCalled();
    expect(pyCancel).not.toHaveBeenCalled();
  });

  it('вызывает pyCancel с тем же callId при abort и снимает слушатель после завершения', async () => {
    const { getLyrics } = await import('./yt');

    // 1. Отмена в полете
    const ac1 = new AbortController();
    let resolveCall!: (v: unknown) => void;
    pyCall.mockImplementationOnce(() => new Promise((r) => { resolveCall = r; }));

    const p1 = getLyrics('Artist', 'Title', 180, 'vid1', undefined, ac1.signal);
    expect(pyCall).toHaveBeenCalledTimes(1);
    const sentCallId = pyCall.mock.calls[0][1].callId;
    expect(typeof sentCallId).toBe('string');

    ac1.abort();
    expect(pyCancel).toHaveBeenCalledExactlyOnceWith(sentCallId);
    resolveCall({ status: 'error', message: 'Cancelled by client' });
    expect(await p1).toBeNull();

    // 2. Успешное завершение: последующий abort не должен вызывать pyCancel
    pyCancel.mockClear();
    const ac2 = new AbortController();
    pyCall.mockResolvedValueOnce({ status: 'ok', plainLyrics: 'hello', syncedLyrics: '[00:01.00] hello', instrumental: false });

    const res = await getLyrics('Artist', 'Title', 180, 'vid2', undefined, ac2.signal);
    expect(res).toEqual({ plainLyrics: 'hello', syncedLyrics: '[00:01.00] hello', instrumental: false });

    ac2.abort();
    expect(pyCancel).not.toHaveBeenCalled();
  });
});
