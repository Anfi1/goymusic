import type { HydratedLikedEntry, HydratedScLikedEntry } from '../api/likedStore';
import type { YTMTrack } from '../api/yt';

// A local SC like is not evidence that the YouTube mirror has been populated.
export function likedPlaylistTracks(
  local: HydratedLikedEntry[] | null,
  pages: readonly { tracks: YTMTrack[] }[] | undefined,
  soundCloud: HydratedScLikedEntry[],
): YTMTrack[] {
  const sc = [...soundCloud].sort((a, b) => b.likedAt - a.likedAt);
  const tracks: YTMTrack[] = [];
  let scIndex = 0;
  let ytIndex = 0;
  let lastDate = Infinity;

  if (local) {
    // YouTube не отдает дату лайка. Локальные даты служат только опорами
    // для вставки SoundCloud: повтор или скачок вперед не меняет порядок YouTube.
    for (let i = 0; i < local.length; i++) {
      const date = local[i].likedAt;
      if (!date || date >= lastDate) continue;
      while (ytIndex < i) tracks.push(local[ytIndex++].track);
      while (scIndex < sc.length && sc[scIndex].likedAt > date) tracks.push(sc[scIndex++].track);
      tracks.push(local[ytIndex++].track);
      lastDate = date;
    }
  }

  // Датированные лайки не отправляются под весь хвост YouTube с неизвестными датами.
  while (scIndex < sc.length && sc[scIndex].likedAt > 0) tracks.push(sc[scIndex++].track);
  if (local) {
    while (ytIndex < local.length) tracks.push(local[ytIndex++].track);
  } else if (pages) {
    for (const page of pages) for (const track of page.tracks) tracks.push(track);
  }
  while (scIndex < sc.length) tracks.push(sc[scIndex++].track);
  return tracks.map(track => track.likeStatus === 'LIKE' ? track : { ...track, likeStatus: 'LIKE' });
}
