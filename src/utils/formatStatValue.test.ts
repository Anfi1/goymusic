import { describe, it, expect } from 'vitest';
import { formatStatValue } from './formatStatValue';
import { markPopularTracks } from './popularTracks';

describe('formatStatValue', () => {
  it('сокращает прослушивания из строк YouTube Music', () => {
    expect(formatStatValue('981 тыс. прослушиваний')).toBe('981K');
    expect(formatStatValue('1,4 млн прослушиваний')).toBe('1.4M');
    expect(formatStatValue('12 млн прослушиваний')).toBe('12M');
    expect(formatStatValue('950 прослушиваний')).toBe('950');
    expect(formatStatValue('5.2M plays')).toBe('5.2M');
  });
});

describe('markPopularTracks', () => {
  const t = (id: string, views?: string) => ({ id, title: id, album: '', duration: '', thumbUrl: '', views });

  it('помечает ~20% самых прослушиваемых: 3 из 15', () => {
    const tracks = Array.from({ length: 15 }, (_, i) => t(`t${i}`, `${(i + 1) * 10} тыс. прослушиваний`));
    const best = markPopularTracks(tracks).filter(x => x.best).map(x => x.id);
    expect(best).toEqual(['t12', 't13', 't14']);
    expect(markPopularTracks(tracks).filter(x => x.tier === 'hot').map(x => x.id)).toEqual(['t14']);
    expect(markPopularTracks(tracks).some(x => x.tier === 'top')).toBe(false);
  });

  it('от 50 треков три уровня: 20 молний на 100 треков, по трети на уровень', () => {
    const tracks = Array.from({ length: 100 }, (_, i) => t(`t${i}`, `${i + 1} тыс.`));
    const marked = markPopularTracks(tracks).filter(x => x.best);
    expect(marked).toHaveLength(20);
    expect(marked.filter(x => x.tier === 'top')).toHaveLength(7);
    expect(marked.filter(x => x.tier === 'hot')).toHaveLength(7);
    expect(marked.filter(x => x.tier === 'top').every(x => +x.id.slice(1) >= 93)).toBe(true);
  });

  it('треки без прослушиваний не помечаются, короткие релизы не трогаются', () => {
    expect(markPopularTracks([t('a', '5 млн'), t('b'), t('c', '1 млн'), t('d', '2 млн')]).filter(x => x.best).map(x => x.id)).toEqual(['a']);
    expect(markPopularTracks([t('a', '5 млн'), t('b', '1 млн')]).some(x => x.best)).toBe(false);
  });
});
