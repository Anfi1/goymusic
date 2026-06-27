export type TrackSource = 'youtube' | 'soundcloud';

export function resolveSource(value: unknown): TrackSource {
  if (typeof value === 'string' && value.toLowerCase() === 'soundcloud') {
    return 'soundcloud';
  }
  return 'youtube';
}
