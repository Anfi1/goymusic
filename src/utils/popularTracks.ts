import type { YTMTrack } from '../api/yt';
import { parseStatValue } from './formatStatValue';

// Молния, как у Яндекса: самые прослушиваемые треки альбома, примерно 3 из 15.
// Помеченные делятся на уровни: верхняя треть -- хиты. В больших альбомах молний
// много, там уровня три: треть самых топовых, треть хитов, остальные.
const POPULAR_SHARE = 0.2;
const THREE_TIERS_FROM = 50;

export function markPopularTracks(tracks: YTMTrack[]): YTMTrack[] {
  const plays = tracks.map(t => parseStatValue(t.views));
  const ranked = plays.filter((v): v is number => v !== null).sort((a, b) => b - a);
  if (ranked.length < 3) return tracks;
  const popularCount = Math.ceil(ranked.length * POPULAR_SHARE);
  const threshold = (share: number) => ranked[Math.ceil(popularCount * share) - 1];
  const popular = threshold(1);
  const threeTiers = ranked.length >= THREE_TIERS_FROM;
  const top = threeTiers ? threshold(1 / 3) : Infinity;
  const hot = threshold(threeTiers ? 2 / 3 : 1 / 3);
  return tracks.map((t, i) => {
    const v = plays[i] ?? -1;
    if (v < popular) return t;
    const tier = v >= top ? 'top' : v >= hot ? 'hot' : undefined;
    return { ...t, best: true, tier };
  });
}
