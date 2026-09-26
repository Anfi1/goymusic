import { describe, expect, it } from 'vitest';
import { parseSongFile, songFileId } from './localOverrides';

const sc = 'https://soundcloud.com/astrallsh/lirika-sabyst';
const ids = new Map([[songFileId(sc), sc]]);

describe('parseSongFile', () => {
  it('YouTube id из имени загрузки и сохранённого потока', () => {
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
