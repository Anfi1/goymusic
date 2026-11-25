import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensureScClientId,
  formatScDuration,
  getScLikeMode,
  getScToken,
  getScUid,
  interleaveTracks,
  isScTrackLiked,
  mergeTracks,
  pickBestScMatch,
  registerScDisconnectHook,
  scDisconnect,
  scEntryToTrack,
  scSetLiked,
  setScLikeMode,
  setScLikedInMemory,
} from './soundcloud';
import { likedStore } from './likedStore';
import type { YTMTrack } from './yt';

describe('formatScDuration', () => {
  it('форматирует секунды в M:SS', () => {
    expect(formatScDuration(0)).toBe('0:00');
    expect(formatScDuration(5)).toBe('0:05');
    expect(formatScDuration(65)).toBe('1:05');
    expect(formatScDuration(600)).toBe('10:00');
  });
  it('null/undefined/отрицательное → 0:00', () => {
    expect(formatScDuration(null)).toBe('0:00');
    expect(formatScDuration(undefined)).toBe('0:00');
    expect(formatScDuration(-5)).toBe('0:00');
  });
});

describe('scEntryToTrack', () => {
  it('маппит SC-результат в YTMTrack с source и scUrl', () => {
    const t = scEntryToTrack({
      url: 'https://soundcloud.com/a/b', title: 'Song', artist: 'Art',
      duration: 125, thumbUrl: 'http://t', source: 'soundcloud',
    });
    expect(t.id).toBe('https://soundcloud.com/a/b');
    expect(t.scUrl).toBe('https://soundcloud.com/a/b');
    expect(t.source).toBe('soundcloud');
    expect(t.title).toBe('Song');
    expect(t.artists).toEqual(['Art']);
    expect(t.duration).toBe('2:05');
  });
  it('пустой artist → пустой массив artists', () => {
    const t = scEntryToTrack({ url: 'u', title: 'x', artist: '', duration: 0, thumbUrl: '', source: 'soundcloud' });
    expect(t.artists).toEqual([]);
  });
});

describe('mergeTracks', () => {
  const yt = (n: number): YTMTrack[] => Array.from({ length: n }, (_, i) => ({ id: 'y' + i, title: 'y' + i, album: '', duration: '0:00', thumbUrl: '', source: 'youtube' }));
  const sc = (n: number): YTMTrack[] => Array.from({ length: n }, (_, i) => ({ id: 's' + i, title: 's' + i, album: '', duration: '0:00', thumbUrl: '', source: 'soundcloud' }));

  it('чередует 2 YT : 1 SC', () => {
    const out = mergeTracks(yt(4), sc(2));
    expect(out.map(t => t.id)).toEqual(['y0', 'y1', 's0', 'y2', 'y3', 's1']);
  });
  it('остатки YT идут в конец', () => {
    const out = mergeTracks(yt(5), sc(1));
    expect(out.map(t => t.id)).toEqual(['y0', 'y1', 's0', 'y2', 'y3', 'y4']);
  });
  it('пустой SC → исходный YT', () => {
    expect(mergeTracks(yt(3), []).map(t => t.id)).toEqual(['y0', 'y1', 'y2']);
  });
  it('пустой YT → SC в конце', () => {
    expect(mergeTracks([], sc(2)).map(t => t.id)).toEqual(['s0', 's1']);
  });
});

describe('interleaveTracks', () => {
  const yt = (n: number): YTMTrack[] => Array.from({ length: n }, (_, i) => ({ id: 'y' + i, title: 'y' + i, album: '', duration: '0:00', thumbUrl: '', source: 'youtube' }));
  const sc = (n: number): YTMTrack[] => Array.from({ length: n }, (_, i) => ({ id: 's' + i, title: 's' + i, album: '', duration: '0:00', thumbUrl: '', source: 'soundcloud' }));

  it('пустые списки → пусто', () => {
    expect(interleaveTracks([], [])).toEqual([]);
  });
  it('равные длины → строгое чередование 1:1', () => {
    expect(interleaveTracks(yt(3), sc(3)).map(t => t.id)).toEqual(['y0', 's0', 'y1', 's1', 'y2', 's2']);
  });
  it('a длиннее → хвост a в конце', () => {
    expect(interleaveTracks(yt(4), sc(2)).map(t => t.id)).toEqual(['y0', 's0', 'y1', 's1', 'y2', 'y3']);
  });
  it('b длиннее → хвост b в конце', () => {
    expect(interleaveTracks(yt(1), sc(3)).map(t => t.id)).toEqual(['y0', 's0', 's1', 's2']);
  });
});

describe('pickBestScMatch', () => {
  const cand = (id: string, dur: string): YTMTrack => ({ id, title: id, album: '', duration: dur, thumbUrl: '', source: 'soundcloud' });

  it('пустой список → null', () => {
    expect(pickBestScMatch([], 180)).toBeNull();
  });
  it('неизвестная длительность (target<=0) → первый', () => {
    const c = [cand('a', '3:00'), cand('b', '4:00')];
    expect(pickBestScMatch(c, 0)?.id).toBe('a');
  });
  it('выбирает ближайший по длительности', () => {
    const c = [cand('a', '3:30'), cand('b', '3:02'), cand('c', '5:00')];
    expect(pickBestScMatch(c, 180)?.id).toBe('b'); // 182с ближе к 180
  });
  it('никого в пределах допуска → null', () => {
    const c = [cand('a', '5:00'), cand('b', '6:00')];
    expect(pickBestScMatch(c, 180, 15)).toBeNull();
  });
});

describe('SoundCloud fast likes mode & scSetLiked', () => {
  let storage: Map<string, string>;
  let pyCall: ReturnType<typeof vi.fn>;
  let scLike: ReturnType<typeof vi.fn>;
  let scLogout: ReturnType<typeof vi.fn>;
  let getScProfileDir: ReturnType<typeof vi.fn>;
  let winGetBounds: ReturnType<typeof vi.fn>;
  let dispatchEvent: ReturnType<typeof vi.fn>;
  let dispatchedEvents: Array<{ type: string; detail: any }>;

  beforeEach(async () => {
    storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => (storage.has(key) ? storage.get(key)! : null),
      setItem: (key: string, value: string) => { storage.set(key, String(value)); },
      removeItem: (key: string) => { storage.delete(key); },
    });

    dispatchedEvents = [];
    dispatchEvent = vi.fn((ev: Event) => {
      dispatchedEvents.push({ type: ev.type, detail: (ev as CustomEvent).detail });
      return true;
    });

    pyCall = vi.fn();
    scLike = vi.fn();
    scLogout = vi.fn().mockResolvedValue({ status: 'ok' });
    getScProfileDir = vi.fn().mockResolvedValue('C:\\sc-profile');
    winGetBounds = vi.fn().mockResolvedValue({ x: 0, y: 0, width: 1200, height: 800 });

    vi.stubGlobal('window', {
      bridge: { pyCall, scLike, scLogout, getScProfileDir, winGetBounds },
      dispatchEvent,
    });

    vi.spyOn(likedStore, 'getAllScTracks').mockResolvedValue([]);
    vi.spyOn(likedStore, 'clearScTracks').mockResolvedValue(undefined);
    vi.spyOn(likedStore, 'putScTracksBatch').mockResolvedValue(undefined);
    vi.spyOn(likedStore, 'setScVirtualCount').mockResolvedValue(undefined);

    // Сбрасываем кэш client_id и scLikedSet между тестами
    await scDisconnect();
    pyCall.mockReset();
    scLike.mockReset();
    scLogout.mockReset();
    scLogout.mockResolvedValue({ status: 'ok' });
    dispatchedEvents = [];
    dispatchEvent.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('getScLikeMode по умолчанию возвращает electron и переключается на legacy и обратно', () => {
    expect(getScLikeMode()).toBe('electron');
    setScLikeMode('legacy');
    expect(getScLikeMode()).toBe('legacy');
    setScLikeMode('electron');
    expect(getScLikeMode()).toBe('electron');
  });

  it('setScLikedInMemory синхронно обновляет isScTrackLiked', () => {
    expect(isScTrackLiked('42')).toBe(false);
    setScLikedInMemory('42', true);
    expect(isScTrackLiked('42')).toBe(true);
    setScLikedInMemory('42', false);
    expect(isScTrackLiked('42')).toBe(false);
  });

  it('ensureScClientId кэширует результат и при force=true запрашивает свежий client_id', async () => {
    pyCall
      .mockResolvedValueOnce({ status: 'ok', clientId: 'cid-1', appVersion: 'v1' })
      .mockResolvedValueOnce({ status: 'ok', clientId: 'cid-2', appVersion: 'v2' });

    expect(await ensureScClientId(false)).toEqual({ cid: 'cid-1', appVersion: 'v1' });
    expect(await ensureScClientId(false)).toEqual({ cid: 'cid-1', appVersion: 'v1' });
    expect(pyCall).toHaveBeenCalledTimes(1);
    expect(pyCall).toHaveBeenNthCalledWith(1, 'sc_client_id', {});

    expect(await ensureScClientId(true)).toEqual({ cid: 'cid-2', appVersion: 'v2' });
    expect(pyCall).toHaveBeenCalledTimes(2);
    expect(pyCall).toHaveBeenNthCalledWith(2, 'sc_client_id', { force: true });
  });

  it('в режиме electron подгружает отсутствующий uid через sc_me, вызывает bridge.scLike и не трогает nodriver', async () => {
    storage.set('sc-oauth-token', 'tok-123');
    pyCall.mockImplementation(async (cmd: string) => {
      if (cmd === 'sc_me') return { status: 'ok', connected: true, id: 777 };
      if (cmd === 'sc_client_id') return { status: 'ok', clientId: 'cid-ok', appVersion: '170000' };
      throw new Error(`Unexpected pyCall: ${cmd}`);
    });
    scLike.mockResolvedValueOnce({ status: 'ok', liked: 'liked', verified: false });

    const ok = await scSetLiked('9001', 'https://soundcloud.com/artist/track', true);

    expect(ok).toBe(true);
    expect(getScUid()).toBe('777');
    expect(isScTrackLiked('9001')).toBe(true);
    expect(scLike).toHaveBeenCalledTimes(1);
    expect(scLike).toHaveBeenCalledWith({
      uid: '777',
      scId: '9001',
      scUrl: 'https://soundcloud.com/artist/track',
      liked: true,
      oauthToken: 'tok-123',
      clientId: 'cid-ok',
      appVersion: '170000',
    });
    expect(pyCall.mock.calls.some(([cmd]) => cmd === 'sc_like_nodriver')).toBe(false);
  });

  it('при 401 один раз обновляет client_id (force: true) и успешно повторяет bridge.scLike', async () => {
    storage.set('sc-oauth-token', 'tok-123');
    storage.set('sc-uid', '777');
    pyCall
      .mockResolvedValueOnce({ status: 'ok', clientId: 'cid-old', appVersion: 'v1' })
      .mockResolvedValueOnce({ status: 'ok', clientId: 'cid-new', appVersion: 'v2' });
    scLike
      .mockResolvedValueOnce({ status: 'unauthorized', message: 'HTTP 401' })
      .mockResolvedValueOnce({ status: 'ok', liked: 'liked', verified: false });

    const ok = await scSetLiked('9002', 'https://soundcloud.com/artist/t2', true);

    expect(ok).toBe(true);
    expect(isScTrackLiked('9002')).toBe(true);
    expect(pyCall).toHaveBeenNthCalledWith(2, 'sc_client_id', { force: true });
    expect(scLike).toHaveBeenCalledTimes(2);
    expect(scLike).toHaveBeenNthCalledWith(2, expect.objectContaining({
      clientId: 'cid-new',
      appVersion: 'v2',
    }));
    expect(dispatchedEvents).toEqual([]);
  });

  it('при повторном 401 не зацикливается, показывает error toast и не сбрасывает токен/зеркало', async () => {
    storage.set('sc-oauth-token', 'tok-expired');
    storage.set('sc-uid', '777');
    pyCall
      .mockResolvedValueOnce({ status: 'ok', clientId: 'cid-1', appVersion: 'v1' })
      .mockResolvedValueOnce({ status: 'ok', clientId: 'cid-2', appVersion: 'v2' });
    scLike
      .mockResolvedValueOnce({ status: 'unauthorized', message: 'HTTP 401' })
      .mockResolvedValueOnce({ status: 'unauthorized', message: 'HTTP 401' });

    const clearSpy = vi.mocked(likedStore.clearScTracks);
    clearSpy.mockClear();

    const ok = await scSetLiked('9003', 'https://soundcloud.com/artist/t3', true);

    expect(ok).toBe(false);
    expect(scLike).toHaveBeenCalledTimes(2);
    expect(getScToken()).toBe('tok-expired');
    expect(getScUid()).toBe('777');
    expect(scLogout).not.toHaveBeenCalled();
    expect(clearSpy).not.toHaveBeenCalled();
    expect(dispatchedEvents).toHaveLength(1);
    expect(dispatchedEvents[0].type).toBe('app-toast');
    expect(dispatchedEvents[0].detail.type).toBe('error');
    expect(dispatchedEvents[0].detail.message).toContain('SoundCloud');
  });

  it('при статусе cancelled возвращает false и показывает toast об отмене проверки', async () => {
    storage.set('sc-oauth-token', 'tok-123');
    storage.set('sc-uid', '777');
    pyCall.mockResolvedValueOnce({ status: 'ok', clientId: 'cid-1', appVersion: 'v1' });
    scLike.mockResolvedValueOnce({ status: 'cancelled', message: 'Verification cancelled' });

    const ok = await scSetLiked('9004', 'https://soundcloud.com/artist/t4', true);

    expect(ok).toBe(false);
    expect(dispatchedEvents).toHaveLength(1);
    expect(dispatchedEvents[0].type).toBe('app-toast');
    expect(['info', 'error']).toContain(dispatchedEvents[0].detail.type);
  });

  it('при отсутствии client_id показывает error toast и не вызывает bridge.scLike', async () => {
    storage.set('sc-oauth-token', 'tok-123');
    storage.set('sc-uid', '777');
    pyCall.mockResolvedValueOnce({ status: 'error', message: 'not found' });

    const ok = await scSetLiked('9005', 'https://soundcloud.com/artist/t5', true);

    expect(ok).toBe(false);
    expect(pyCall).toHaveBeenCalledWith('sc_client_id', {});
    expect(scLike).not.toHaveBeenCalled();
    expect(dispatchedEvents).toHaveLength(1);
    expect(dispatchedEvents[0].detail.type).toBe('error');
  });

  it('при статусе error от bridge.scLike возвращает false и показывает error toast', async () => {
    storage.set('sc-oauth-token', 'tok-123');
    storage.set('sc-uid', '777');
    pyCall.mockResolvedValueOnce({ status: 'ok', clientId: 'cid-1', appVersion: 'v1' });
    scLike.mockResolvedValueOnce({ status: 'error', message: 'HTTP 500' });

    const ok = await scSetLiked('9009', 'https://soundcloud.com/artist/t9', true);

    expect(ok).toBe(false);
    expect(dispatchedEvents).toHaveLength(1);
    expect(dispatchedEvents[0].type).toBe('app-toast');
    expect(dispatchedEvents[0].detail.type).toBe('error');
    expect(dispatchedEvents[0].detail.message).toContain('HTTP 500');
  });

  it('в режиме legacy использует sc_like_nodriver и не вызывает bridge.scLike', async () => {
    setScLikeMode('legacy');
    storage.set('sc-oauth-token', 'tok-123');
    pyCall.mockResolvedValueOnce({ status: 'ok', liked: 'liked' });

    const ok = await scSetLiked('9006', 'https://soundcloud.com/artist/t6', true);

    expect(ok).toBe(true);
    expect(scLike).not.toHaveBeenCalled();
    expect(pyCall).toHaveBeenCalledWith('sc_like_nodriver', expect.objectContaining({
      scId: '9006',
      liked: true,
      oauthToken: 'tok-123',
      profileDir: 'C:\\sc-profile',
    }));
    expect(isScTrackLiked('9006')).toBe(true);
  });

  it('если bridge.scLike отсутствует (Android), безопасно откатывается на legacy-путь без исключений', async () => {
    storage.set('sc-oauth-token', 'tok-123');
    vi.stubGlobal('window', {
      bridge: { pyCall, getScProfileDir, winGetBounds },
      dispatchEvent,
    });
    pyCall.mockResolvedValueOnce({ status: 'ok', liked: 'liked' });

    const ok = await scSetLiked('9007', 'https://soundcloud.com/artist/t7', true);
    expect(ok).toBe(true);
    expect(pyCall).toHaveBeenCalledWith('sc_like_nodriver', expect.objectContaining({ scId: '9007' }));

    // Полное отсутствие getScProfileDir на мобильной платформе возвращает false без throw
    vi.stubGlobal('window', { bridge: { pyCall }, dispatchEvent });
    expect(await scSetLiked('9008', 'https://soundcloud.com/artist/t8', true)).toBe(false);
  });

  it('scDisconnect вызывает зарегистрированные disconnect-хуки и bridge.scLogout', async () => {
    const hook = vi.fn();
    const unregister = registerScDisconnectHook(hook);
    try {
      await scDisconnect();
      expect(hook).toHaveBeenCalledTimes(1);
      expect(scLogout).toHaveBeenCalledTimes(1);
    } finally {
      unregister();
    }
  });

  it('in-flight scSetLiked, завершившийся ok после scDisconnect, не засоряет scLikedSet', async () => {
    storage.set('sc-oauth-token', 'tok-123');
    storage.set('sc-uid', '777');
    pyCall.mockResolvedValueOnce({ status: 'ok', clientId: 'cid-1', appVersion: 'v1' });

    let resolveLike!: (res: { status: 'ok'; liked: 'liked'; verified: boolean }) => void;
    scLike.mockImplementationOnce(() => new Promise((resolve) => {
      resolveLike = resolve;
    }));

    const likePromise = scSetLiked('9010', 'https://soundcloud.com/artist/t10', true);
    await Promise.resolve();
    await Promise.resolve();

    await scDisconnect();
    resolveLike({ status: 'ok', liked: 'liked', verified: false });
    await likePromise;

    expect(isScTrackLiked('9010')).toBe(false);
  });
});
