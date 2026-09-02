export type TrackSource = 'youtube' | 'soundcloud' | 'yandex';

export function resolveSource(value: unknown): TrackSource {
  if (typeof value === 'string') {
    const v = value.toLowerCase();
    if (v === 'soundcloud') return 'soundcloud';
    if (v === 'yandex') return 'yandex';
  }
  return 'youtube';
}
