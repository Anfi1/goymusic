import { describe, expect, it } from 'vitest';
import { buildSavedStreamOverride, resolveMeasuredGain } from './overrideSave';

describe('buildSavedStreamOverride', () => {
  it('prefers measured downloadRes.gainDb and stores permanent SoundCloud permalink as sourceUrl', () => {
    const result = buildSavedStreamOverride({
      track: {
        id: 'https://soundcloud.com/artist/song',
        source: 'soundcloud',
        scUrl: 'https://soundcloud.com/artist/song-canonical',
      },
      cachedUrl: 'https://cf-media.sndcdn.com/audio.mp3?Policy=expired',
      cachedLoudness: null,
      storedLoudness: -7.2,
      downloadRes: {
        filename: 'dl_direct_sc_1.mp3',
        gainDb: -8.5,
        gainMeasured: true,
      },
      now: 1700000000000,
    });

    expect(result).toEqual({
      videoId: 'https://soundcloud.com/artist/song',
      filename: 'dl_direct_sc_1.mp3',
      sourceUrl: 'https://soundcloud.com/artist/song-canonical',
      sourceType: 'soundcloud',
      gainDb: -8.5,
      gainMeasured: true,
      addedAt: 1700000000000,
    });
  });

  it('falls back to storedLoudness for SoundCloud when download measurement fails and cachedLoudness is null', () => {
    const result = buildSavedStreamOverride({
      track: { id: 'https://soundcloud.com/artist/song', source: 'soundcloud' },
      cachedUrl: 'https://cf-media.sndcdn.com/audio.mp3',
      cachedLoudness: null,
      storedLoudness: -6.4,
      downloadRes: {
        filename: 'dl_direct_sc_2.mp3',
        gainDb: 0,
        gainMeasured: false,
      },
      now: 1700000000001,
    });

    expect(result.gainDb).toBe(-6.4);
    expect(result.gainMeasured).toBe(true);
    expect(result.sourceType).toBe('soundcloud');
    expect(result.sourceUrl).toBe('https://soundcloud.com/artist/song');
  });

  it('prefers cachedLoudness over storedLoudness when download measurement is unavailable', () => {
    const result = buildSavedStreamOverride({
      track: { id: 'dQw4w9WgXcQ', source: 'youtube' },
      cachedUrl: 'https://rr1---sn.googlevideo.com/videoplayback',
      cachedLoudness: -4.2,
      storedLoudness: -5.0,
      downloadRes: {
        filename: 'dl_direct_yt_1.m4a',
        gainDb: 0,
        gainMeasured: false,
      },
      now: 1700000000002,
    });

    expect(result.gainDb).toBe(-4.2);
    expect(result.gainMeasured).toBe(true);
    expect(result.sourceType).toBe('youtube');
  });

  it('treats omitted gainMeasured with gainDb 0 as unmeasured and falls back to cached/stored loudness', () => {
    const withCached = buildSavedStreamOverride({
      track: { id: 'dQw4w9WgXcQ', source: 'youtube' },
      cachedUrl: 'https://rr1---sn.googlevideo.com/videoplayback',
      cachedLoudness: -5.5,
      storedLoudness: -6.0,
      downloadRes: {
        filename: 'dl_direct_legacy_zero.m4a',
        gainDb: 0,
      },
      now: 1700000000002,
    });
    expect(withCached.gainDb).toBe(-5.5);
    expect(withCached.gainMeasured).toBe(true);

    const withStored = buildSavedStreamOverride({
      track: { id: 'https://soundcloud.com/artist/song', source: 'soundcloud' },
      cachedUrl: 'https://cf-media.sndcdn.com/audio.mp3',
      cachedLoudness: null,
      storedLoudness: -7.1,
      downloadRes: {
        filename: 'dl_direct_sc_legacy_zero.mp3',
        gainDb: 0,
      },
      now: 1700000000002,
    });
    expect(withStored.gainDb).toBe(-7.1);
    expect(withStored.gainMeasured).toBe(true);

    const withNone = buildSavedStreamOverride({
      track: { id: 'dQw4w9WgXcQ', source: 'youtube' },
      cachedUrl: 'https://rr1---sn.googlevideo.com/videoplayback',
      cachedLoudness: null,
      storedLoudness: null,
      downloadRes: {
        filename: 'dl_direct_none.m4a',
        gainDb: 0,
      },
      now: 1700000000002,
    });
    expect(withNone.gainDb).toBe(0);
    expect(withNone.gainMeasured).toBe(false);
  });

  it('preserves explicit 0 dB when downloadRes.gainMeasured is true', () => {
    const result = buildSavedStreamOverride({
      track: { id: 'dQw4w9WgXcQ', source: 'youtube' },
      cachedUrl: 'https://rr1---sn.googlevideo.com/videoplayback',
      cachedLoudness: -5.0,
      storedLoudness: -6.0,
      downloadRes: {
        filename: 'dl_direct_yt_zero.m4a',
        gainDb: 0,
        gainMeasured: true,
      },
      now: 1700000000003,
    });

    expect(result.gainDb).toBe(0);
    expect(result.gainMeasured).toBe(true);
  });

  it('accepts finite non-zero downloadRes.gainDb when gainMeasured flag is omitted', () => {
    const result = buildSavedStreamOverride({
      track: { id: 'dQw4w9WgXcQ' },
      cachedUrl: 'https://rr1---sn.googlevideo.com/videoplayback',
      cachedLoudness: null,
      storedLoudness: null,
      downloadRes: {
        filename: 'dl_direct_legacy.m4a',
        gainDb: -3.5,
      },
      now: 1700000000004,
    });

    expect(result.gainDb).toBe(-3.5);
    expect(result.gainMeasured).toBe(true);
  });

  it('ignores non-finite values and returns gainDb 0 with gainMeasured false when all sources fail', () => {
    const result = buildSavedStreamOverride({
      track: { id: 'dQw4w9WgXcQ' },
      cachedUrl: 'https://rr1---sn.googlevideo.com/videoplayback',
      cachedLoudness: Number.NaN,
      storedLoudness: Number.POSITIVE_INFINITY,
      downloadRes: {
        filename: 'dl_direct_unmeasured.m4a',
        gainDb: Number.NaN,
        gainMeasured: true,
      },
      now: 1700000000005,
    });

    expect(result.gainDb).toBe(0);
    expect(result.gainMeasured).toBe(false);
  });

  it('uses safe sourceType and permanent sourceUrl to avoid re-downloading ephemeral CDN URLs', () => {
    // SoundCloud с permalink в id
    const scById = buildSavedStreamOverride({
      track: { id: 'https://soundcloud.com/a/b' },
      cachedUrl: 'https://cf-media.sndcdn.com/a.mp3?Policy=123',
      downloadRes: { filename: 'a.mp3', gainDb: -2, gainMeasured: true },
      now: 1,
    });
    expect(scById.sourceType).toBe('soundcloud');
    expect(scById.sourceUrl).toBe('https://soundcloud.com/a/b');

    // SoundCloud с scUrl при непрозрачном id
    const scByScUrl = buildSavedStreamOverride({
      track: { id: 'sc:999', source: 'soundcloud', scUrl: 'https://soundcloud.com/a/c' },
      cachedUrl: 'https://cf-hls-media.sndcdn.com/stream.m3u8',
      downloadRes: { filename: 'b.mp3', gainDb: -2, gainMeasured: true },
      now: 1,
    });
    expect(scByScUrl.sourceType).toBe('soundcloud');
    expect(scByScUrl.sourceUrl).toBe('https://soundcloud.com/a/c');

    // SoundCloud без постоянного permalink -> local, чтобы stream.ts не пытался качать протухший CDN URL
    const scNoPermalink = buildSavedStreamOverride({
      track: { id: 'sc-123', source: 'soundcloud' },
      cachedUrl: 'https://cf-hls-media.soundcloud.com/stream.m3u8?Policy=exp',
      downloadRes: { filename: 'b2.mp3', gainDb: -2, gainMeasured: true },
      now: 1,
    });
    expect(scNoPermalink.sourceType).toBe('local');
    expect(scNoPermalink.sourceUrl).toBe('https://cf-hls-media.soundcloud.com/stream.m3u8?Policy=exp');

    // Yandex (по source или по временному CDN URL) -> local
    const yandexBySource = buildSavedStreamOverride({
      track: { id: 'yandex:42', source: 'yandex' },
      cachedUrl: 'https://s123.storage.yandex.net/get-mp3/a',
      downloadRes: { filename: 'c.mp3', gainDb: -2, gainMeasured: true },
      now: 1,
    });
    expect(yandexBySource.sourceType).toBe('local');
    expect(yandexBySource.sourceUrl).toBe('https://s123.storage.yandex.net/get-mp3/a');

    const yandexByCdn = buildSavedStreamOverride({
      track: { id: '42' },
      cachedUrl: 'https://s456.storage.yandex.net/get-mp3/sign/track.mp3',
      downloadRes: { filename: 'c2.mp3', gainDb: -2, gainMeasured: true },
      now: 1,
    });
    expect(yandexByCdn.sourceType).toBe('local');

    // YouTube остается youtube
    const yt = buildSavedStreamOverride({
      track: { id: 'dQw4w9WgXcQ' },
      cachedUrl: 'https://rr1.googlevideo.com/videoplayback',
      downloadRes: { filename: 'd.m4a', gainDb: -2, gainMeasured: true },
      now: 1,
    });
    expect(yt.sourceType).toBe('youtube');
    expect(yt.sourceUrl).toBe('https://rr1.googlevideo.com/videoplayback');
  });
});

describe('resolveMeasuredGain', () => {
  it('honors explicit boolean flag when gainDb is finite', () => {
    expect(resolveMeasuredGain(0, true)).toEqual({ gainDb: 0, gainMeasured: true });
    expect(resolveMeasuredGain(-6.2, true)).toEqual({ gainDb: -6.2, gainMeasured: true });
    expect(resolveMeasuredGain(0, false)).toEqual({ gainDb: 0, gainMeasured: false });
  });

  it('defaults gainDb to 0 and gainMeasured to false for non-finite values', () => {
    expect(resolveMeasuredGain(Number.NaN, true)).toEqual({ gainDb: 0, gainMeasured: false });
    expect(resolveMeasuredGain(undefined, true)).toEqual({ gainDb: 0, gainMeasured: false });
    expect(resolveMeasuredGain(Number.POSITIVE_INFINITY)).toEqual({ gainDb: 0, gainMeasured: false });
  });

  it('infers gainMeasured from finite non-zero gainDb when flag is omitted', () => {
    expect(resolveMeasuredGain(-4.8)).toEqual({ gainDb: -4.8, gainMeasured: true });
    expect(resolveMeasuredGain(0)).toEqual({ gainDb: 0, gainMeasured: false });
    expect(resolveMeasuredGain(null)).toEqual({ gainDb: 0, gainMeasured: false });
  });
});
