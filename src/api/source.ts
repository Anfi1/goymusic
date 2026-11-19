export type TrackSource = 'youtube' | 'soundcloud' | 'yandex';

export function isYoutubeVideoId(value: unknown): value is string {
  return typeof value === 'string' && value.length === 11 && !/[^A-Za-z0-9_-]/.test(value);
}

export function resolveSource(value: unknown): TrackSource {
  if (typeof value === 'string') {
    const v = value.toLowerCase();
    if (v === 'soundcloud') return 'soundcloud';
    if (v === 'yandex') return 'yandex';
  }
  return 'youtube';
}
