import type { YTMTrack } from '../api/yt';
import { MOOD_CATEGORIES, assignCategory, groupKey, type MoodCategory } from './moodCategories';

function parseDuration(dur: string): number {
  if (!dur) return 0;
  const parts = dur.split(':').map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

function trackDedupKey(track: YTMTrack): string {
  if (track.source === 'soundcloud' || track.scUrl) {
    const secs = parseDuration(track.duration);
    const bucket = Math.floor(secs / 2) * 2;
    return `sc:${(track.title || '').toLowerCase()}:${bucket}`;
  }
  return track.id;
}

/**
 * Round-robin смешивание нескольких трек-листов: берём позицию 0 у всех,
 * затем позицию 1 и т.д. Дедуп по id (для YT) или названию+длительности (для SC).
 * Обрезка до cap.
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
        if (!track?.id) continue;
        const key = trackDedupKey(track);
        if (!seen.has(key)) {
          seen.add(key);
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
