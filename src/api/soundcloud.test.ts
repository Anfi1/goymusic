import { describe, it, expect } from 'vitest';
import { formatScDuration, scEntryToTrack, mergeTracks, interleaveTracks, pickBestScMatch } from './soundcloud';
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
