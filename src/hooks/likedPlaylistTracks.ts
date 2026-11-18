import type { HydratedLikedEntry, HydratedScLikedEntry } from '../api/likedStore';
import type { YTMTrack } from '../api/yt';

// A local SC like is not evidence that the YouTube mirror has been populated.
export function likedPlaylistTracks(
  local: HydratedLikedEntry[] | null,
  pages: readonly { tracks: YTMTrack[] }[] | undefined,
  soundCloud: HydratedScLikedEntry[],
): YTMTrack[] {
  const timed = soundCloud.map(entry => ({ track: entry.track, time: entry.likedAt }));
  const untimed: YTMTrack[] = [];
  if (local) {
    // The store and import checkpoints already provide originalIndex order.
    for (const entry of local) {
      if (entry.likedAt) timed.push({ track: entry.track, time: entry.likedAt });
      else untimed.push(entry.track);
    }
  } else if (pages) {
    for (const page of pages) for (const track of page.tracks) untimed.push(track);
  }
  timed.sort((a, b) => b.time - a.time);
  return [...timed.map(entry => entry.track), ...untimed].map(track =>
    track.likeStatus === 'LIKE' ? track : { ...track, likeStatus: 'LIKE' });
}
