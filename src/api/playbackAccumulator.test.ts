import { describe, it, expect } from 'vitest';
import { PlaybackAccumulator } from './playbackAccumulator';

describe('PlaybackAccumulator', () => {
  it('tick копит секунды только при isPlaying и заданном треке', () => {
    const acc = new PlaybackAccumulator();
    acc.tick(true);            // трек не задан — не копим
    expect(acc.drain()).toBeNull();

    acc.setActiveTrack('a');
    acc.tick(false);           // пауза — не копим
    acc.tick(true);
    acc.tick(true);
    expect(acc.drain()).toEqual({ trackId: 'a', seconds: 2 });
  });

  it('drain обнуляет счётчик (дельты не двоятся)', () => {
    const acc = new PlaybackAccumulator();
    acc.setActiveTrack('a');
    acc.tick(true);
    expect(acc.drain()).toEqual({ trackId: 'a', seconds: 1 });
    expect(acc.drain()).toBeNull(); // после слива копить нечего
    acc.tick(true);
    expect(acc.drain()).toEqual({ trackId: 'a', seconds: 1 });
  });

  it('setActiveTrack сливает предыдущий трек и сбрасывает счётчик', () => {
    const acc = new PlaybackAccumulator();
    acc.setActiveTrack('a');
    acc.tick(true);
    acc.tick(true);
    const flush = acc.setActiveTrack('b');
    expect(flush).toEqual({ trackId: 'a', seconds: 2 });
    // новый трек начинает с нуля
    acc.tick(true);
    expect(acc.drain()).toEqual({ trackId: 'b', seconds: 1 });
  });

  it('setActiveTrack на тот же трек возвращает null и не сбрасывает', () => {
    const acc = new PlaybackAccumulator();
    acc.setActiveTrack('a');
    acc.tick(true);
    expect(acc.setActiveTrack('a')).toBeNull();
    expect(acc.drain()).toEqual({ trackId: 'a', seconds: 1 });
  });

  it('setActiveTrack возвращает null если предыдущих секунд не было', () => {
    const acc = new PlaybackAccumulator();
    acc.setActiveTrack('a');         // трека до этого не было
    expect(acc.setActiveTrack('b')).toBeNull(); // у 'a' 0 секунд
  });

  it('setActiveTrack(null) сливает активный трек', () => {
    const acc = new PlaybackAccumulator();
    acc.setActiveTrack('a');
    acc.tick(true);
    expect(acc.setActiveTrack(null)).toEqual({ trackId: 'a', seconds: 1 });
  });
});
