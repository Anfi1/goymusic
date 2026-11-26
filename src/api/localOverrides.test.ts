import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isOverrideGainMeasured,
  parseSongFile,
  songFileId,
  type LocalOverride,
} from './localOverrides';

const sc = 'https://soundcloud.com/astrallsh/lirika-sabyst';
const ids = new Map([[songFileId(sc), sc]]);

function createFakeIndexedDB() {
  const rows = new Map<string, LocalOverride>();

  const makeReq = <T,>(getResult: () => T) => {
    const req: any = { result: undefined, error: null, onsuccess: null, onerror: null };
    queueMicrotask(() => {
      req.result = getResult();
      req.onsuccess?.({ target: req });
    });
    return req;
  };

  const db: any = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => ({}),
    transaction: () => {
      const tx: any = { oncomplete: null, onerror: null, error: null };
      let pendingOps = 0;
      const scheduleComplete = () => {
        pendingOps++;
        queueMicrotask(() => {
          pendingOps--;
          if (pendingOps === 0) {
            queueMicrotask(() => tx.oncomplete?.());
          }
        });
      };
      tx.objectStore = () => ({
        get: (key: string) => {
          scheduleComplete();
          return makeReq(() => {
            const v = rows.get(key);
            return v ? { ...v } : undefined;
          });
        },
        put: (val: LocalOverride) => {
          rows.set(val.videoId, { ...val });
          scheduleComplete();
          return makeReq(() => val.videoId);
        },
        delete: (key: string) => {
          rows.delete(key);
          scheduleComplete();
          return makeReq(() => undefined);
        },
        clear: () => {
          rows.clear();
          scheduleComplete();
          return makeReq(() => undefined);
        },
        getAll: () => {
          scheduleComplete();
          return makeReq(() => Array.from(rows.values(), v => ({ ...v })));
        },
      });
      return tx;
    },
  };

  const fakeIdb = {
    open: () => {
      const req: any = { result: db, onupgradeneeded: null, onsuccess: null, onerror: null };
      queueMicrotask(() => {
        req.onsuccess?.({ target: req });
      });
      return req;
    },
  };

  return { rows, fakeIdb };
}

describe('parseSongFile', () => {
  it('YouTube id из имени загрузки и сохраненного потока', () => {
    expect(parseSongFile('-BsKsvePPxs_1774472485646.opus', ids)).toEqual({ videoId: '-BsKsvePPxs', addedAt: 1774472485646 });
    expect(parseSongFile('dl_direct_7IzOHlMCkSw_1783684295092.m4a', ids)?.videoId).toBe('7IzOHlMCkSw');
  });

  it('SC-трек находится по sanitize своего URL', () => {
    expect(songFileId(sc)).toBe('https---soundcloud.com-astrallsh-lirika-sabyst');
    expect(parseSongFile('dl_direct_https---soundcloud.com-astrallsh-lirika-sabyst_1789428471620.m4a', ids)?.videoId).toBe(sc);
  });

  it('файлы без id не привязываются', () => {
    expect(parseSongFile('sc_tmp_1783142268968.m4a', ids)).toBeNull();
    expect(parseSongFile('local_2.mp3', ids)).toBeNull();
    expect(parseSongFile('dl_direct_https---soundcloud.com-unknown-track_1789428471620.m4a', ids)).toBeNull();
  });
});

describe('isOverrideGainMeasured', () => {
  it('возвращает false для нечисловых и невалидных значений даже при gainMeasured=true', () => {
    expect(isOverrideGainMeasured({ gainDb: Number.NaN, gainMeasured: true })).toBe(false);
    expect(isOverrideGainMeasured({ gainDb: Number.POSITIVE_INFINITY, gainMeasured: true })).toBe(false);
    expect(isOverrideGainMeasured({ gainDb: Number.NEGATIVE_INFINITY })).toBe(false);
    expect(isOverrideGainMeasured({ gainDb: undefined as unknown as number, gainMeasured: true })).toBe(false);
  });

  it('возвращает true для явно измеренного 0 и для существующих ненулевых значений', () => {
    expect(isOverrideGainMeasured({ gainDb: 0, gainMeasured: true })).toBe(true);
    expect(isOverrideGainMeasured({ gainDb: 7.4 })).toBe(true);
    expect(isOverrideGainMeasured({ gainDb: -3.1 })).toBe(true);
  });

  it('возвращает false для устаревшего незмеренного 0 и при явном gainMeasured=false даже с ненулевым gainDb', () => {
    expect(isOverrideGainMeasured({ gainDb: 0 })).toBe(false);
    expect(isOverrideGainMeasured({ gainDb: 0, gainMeasured: false })).toBe(false);
    expect(isOverrideGainMeasured({ gainDb: 6.5, gainMeasured: false })).toBe(false);
  });
});

describe('updateOverrideGain & restoreOverridesFromFolder', () => {
  let rows: Map<string, LocalOverride>;
  let writeOverridesManifest: ReturnType<typeof vi.fn>;
  let readOverridesManifest: ReturnType<typeof vi.fn>;
  let listSongFiles: ReturnType<typeof vi.fn>;
  let getSongsPath: ReturnType<typeof vi.fn>;
  let pyCall: ReturnType<typeof vi.fn>;
  let dispatchEvent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    const fake = createFakeIndexedDB();
    rows = fake.rows;
    writeOverridesManifest = vi.fn().mockResolvedValue(undefined);
    readOverridesManifest = vi.fn().mockResolvedValue([]);
    listSongFiles = vi.fn().mockResolvedValue([]);
    getSongsPath = vi.fn().mockResolvedValue('C:\\songs');
    pyCall = vi.fn();
    dispatchEvent = vi.fn();

    vi.stubGlobal('indexedDB', fake.fakeIdb);
    vi.stubGlobal('window', {
      bridge: {
        writeOverridesManifest,
        readOverridesManifest,
        listSongFiles,
        getSongsPath,
        pyCall,
      },
      dispatchEvent,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('updateOverrideGain тихо обновляет gainDb + gainMeasured без события local-override-changed', async () => {
    const mod = await import('./localOverrides');
    rows.set('vid1', {
      videoId: 'vid1',
      filename: 'track_1.m4a',
      sourceUrl: 'https://soundcloud.com/a/b',
      sourceType: 'direct',
      gainDb: 0,
      addedAt: 1000,
    });

    const updated = await mod.updateOverrideGain('vid1', 'track_1.m4a', 8.25);

    expect(updated).toBe(true);
    expect(rows.get('vid1')).toMatchObject({
      videoId: 'vid1',
      filename: 'track_1.m4a',
      gainDb: 8.25,
      gainMeasured: true,
    });
    expect(writeOverridesManifest).toHaveBeenCalledTimes(1);
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it('updateOverrideGain возвращает false при отсутствующей записи или несовпадении filename', async () => {
    const mod = await import('./localOverrides');
    rows.set('vid1', {
      videoId: 'vid1',
      filename: 'new_file.m4a',
      sourceUrl: 'u',
      sourceType: 'direct',
      gainDb: 0,
      addedAt: 1000,
    });

    expect(await mod.updateOverrideGain('missing', 'a.m4a', 5)).toBe(false);
    expect(await mod.updateOverrideGain('vid1', 'old_file.m4a', 5)).toBe(false);
    expect(rows.get('vid1')?.gainDb).toBe(0);
    expect(rows.get('vid1')?.gainMeasured).toBeUndefined();
    expect(writeOverridesManifest).not.toHaveBeenCalled();
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it('restoreOverridesFromFolder проставляет gainMeasured=true только при валидном measured замере', async () => {
    const mod = await import('./localOverrides');
    listSongFiles.mockResolvedValue([
      'AAAAAAAAAAA_1774472485646.opus',
      'BBBBBBBBBBB_1774472485647.opus',
    ]);
    pyCall.mockImplementation(async (_cmd: string, args: { filename: string }) => {
      if (args.filename.startsWith('AAAAAAAAAAA')) {
        return { status: 'ok', gainDb: 0, measured: true };
      }
      return { status: 'ok', gainDb: 0, measured: false };
    });

    const count = await mod.restoreOverridesFromFolder([]);
    expect(count).toBe(2);
    expect(rows.get('AAAAAAAAAAA')?.gainMeasured).toBe(true);
    expect(rows.get('BBBBBBBBBBB')?.gainMeasured).toBeUndefined();
  });

  it('updateOverrideGain возвращает false и не зависает при tx.onabort в IndexedDB', async () => {
    vi.resetModules();
    const abortDb: any = {
      objectStoreNames: { contains: () => true },
      createObjectStore: () => ({}),
      transaction: () => {
        const tx: any = { oncomplete: null, onerror: null, onabort: null };
        tx.objectStore = () => ({
          get: () => {
            const req: any = { result: undefined, onsuccess: null, onerror: null };
            queueMicrotask(() => tx.onabort?.());
            return req;
          },
          put: () => ({}),
        });
        return tx;
      },
    };
    vi.stubGlobal('indexedDB', {
      open: () => {
        const req: any = { result: abortDb, onupgradeneeded: null, onsuccess: null, onerror: null };
        queueMicrotask(() => req.onsuccess?.({ target: req }));
        return req;
      },
    });

    const mod = await import('./localOverrides');
    const result = await Promise.race([
      mod.updateOverrideGain('vid1', 'a.m4a', 5),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 100)),
    ]);
    expect(result).toBe(false);
    expect(writeOverridesManifest).not.toHaveBeenCalled();
  });
});
