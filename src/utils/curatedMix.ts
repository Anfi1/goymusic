import type { YTMTrack } from '../api/yt';

/**
 * Round-robin смешивание нескольких трек-листов: берём позицию 0 у всех,
 * затем позицию 1 и т.д. Дедуп по id, обрезка до cap.
 */
export function blendTracks(trackLists: YTMTrack[][], cap = 60): YTMTrack[] {
  const lists = trackLists.filter(l => l.length > 0);
  const out: YTMTrack[] = [];
  const seen = new Set<string>();
  let pos = 0;
  while (out.length < cap) {
    let progressed = false;
    for (const list of lists) {
      if (pos < list.length) {
        progressed = true;
        const track = list[pos];
        if (track && !seen.has(track.id)) {
          seen.add(track.id);
          out.push(track);
          if (out.length >= cap) break;
        }
      }
    }
    if (!progressed) break;
    pos++;
  }
  return out;
}
