import type { YTMTrack } from '../api/yt';
import { MOOD_CATEGORIES, assignCategory, groupKey, type MoodCategory } from './moodCategories';

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

/** Категории-настроения для панели «Подобрать» (без служебных all/genre/soundcloud). */
export function moodTagCategories(): MoodCategory[] {
  return MOOD_CATEGORIES.filter(c => c.id !== 'all' && c.id !== 'genre' && c.id !== 'soundcloud');
}

/** Для каждого выбранного настроения — его YT-миксы из пула станций. */
export function pickMixesForMoods<T extends { title: string; kind: string }>(
  moodIds: string[],
  stations: T[],
): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  for (const id of moodIds) result[id] = [];
  for (const st of stations) {
    if (st.kind !== 'yt') continue;
    const cat = assignCategory(groupKey(st.title));
    if (cat && result[cat.id]) result[cat.id].push(st);
  }
  return result;
}
