import { describe, it, expect } from 'vitest';
import { blendTracks } from './curatedMix';
import type { YTMTrack } from '../api/yt';

const t = (id: string): YTMTrack => ({ id, title: id } as YTMTrack);

describe('blendTracks', () => {
  it('перемешивает списки round-robin', () => {
    const a = [t('a1'), t('a2'), t('a3')];
    const b = [t('b1'), t('b2')];
    expect(blendTracks([a, b]).map(x => x.id)).toEqual(['a1', 'b1', 'a2', 'b2', 'a3']);
  });

  it('дедупит по id', () => {
    const a = [t('x'), t('a2')];
    const b = [t('x'), t('b2')];
    expect(blendTracks([a, b]).map(x => x.id)).toEqual(['x', 'a2', 'b2']);
  });

  it('соблюдает cap', () => {
    const a = Array.from({ length: 100 }, (_, i) => t('a' + i));
    expect(blendTracks([a], 60)).toHaveLength(60);
  });

  it('устойчив к пустым спискам', () => {
    expect(blendTracks([[], []])).toEqual([]);
    expect(blendTracks([])).toEqual([]);
  });
});
