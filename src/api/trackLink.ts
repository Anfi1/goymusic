import type { YTMTrack } from './yt';
import { isYoutubeVideoId, type TrackSource } from './source';

const WEB = 'https://goymusic.vercel.app/';

export function getTrackLink(track: YTMTrack, startTime?: number): string {
  if (track.source === 'soundcloud' && track.scUrl) {
    const slug = track.scUrl.replace(/^https:\/\/soundcloud\.com\//, '');
    return `${WEB}track/sc/${slug}`;
  }
  const meta = { t: track.title || '', a: track.artists || [], i: track.thumbUrl || '' };
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(meta))));
  // URL-safe base64: replace + with - and / with _
  const safeB64 = b64.replace(/\+/g, '-').replace(/\//g, '_');
  const timeParam = startTime && startTime > 0 ? `&t=${startTime}` : '';
  return `${WEB}track/${track.id}?m=${safeB64}${timeParam}`;
}

export function getAlbumLink(browseId: string): string {
  return `${WEB}album/${browseId}`;
}

export type ParsedDeepLink =
  | { type: 'track'; id: string; title: string; artists: string[]; thumbUrl: string; scUrl?: string; source: TrackSource; yandexId?: string; startTime?: number }
  | { type: 'album'; id: string };

function decodeMeta(search: string): { t?: string; a?: string[]; i?: string } {
  try {
    const params = new URLSearchParams(search);
    const m = params.get('m');
    if (!m) return {};
    // URL-safe base64: replace - with + and _ with /
    const base64 = m.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const meta = JSON.parse(new TextDecoder().decode(bytes));
    return {
      t: typeof meta?.t === 'string' ? meta.t : undefined,
      a: Array.isArray(meta?.a) ? meta.a.filter((name: unknown) => typeof name === 'string') : undefined,
      i: typeof meta?.i === 'string' && /^https:\/\/(?:i\.ytimg\.com|lh3\.googleusercontent\.com|avatars\.yandex\.net)\//.test(meta.i) ? meta.i : undefined,
    };
  } catch { return {}; }
}

export function parseDeepLink(url: string): ParsedDeepLink | null {
  const scMatch = url.match(/^goymusic:\/\/track\/sc\/([\w-]+\/[\w-]+)\/?(?:[?#].*)?$/);
  if (scMatch) {
    return {
      type: 'track',
      id: `sc/${scMatch[1]}`,
      title: '',
      artists: [],
      thumbUrl: '',
      scUrl: `https://soundcloud.com/${scMatch[1]}`,
      source: 'soundcloud',
    };
  }

  const trackMatch = url.match(/^goymusic:\/\/track\/([^/?#]+)\/?(?:[?#].*)?$/);
  if (trackMatch) {
    const id = trackMatch[1];
    const yandexId = /^yandex:(\d+)$/.exec(id)?.[1];
    if (!yandexId && !isYoutubeVideoId(id)) return null;
    const qIdx = url.indexOf('?');
    const search = qIdx >= 0 ? url.slice(qIdx) : '';
    const meta = decodeMeta(search);
    const params = new URLSearchParams(search);
    const t = params.get('t');
    const seconds = Number(t);
    const startTime = Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined;
    return {
      type: 'track',
      id,
      source: yandexId ? 'yandex' : 'youtube',
      yandexId,
      title: meta.t || '',
      artists: meta.a || [],
      thumbUrl: meta.i || (yandexId ? '' : `https://i.ytimg.com/vi/${id}/hqdefault.jpg`),
      startTime,
    };
  }

  const albumMatch = url.match(/^goymusic:\/\/album\/([^/?#]+)/);
  if (albumMatch) return { type: 'album', id: albumMatch[1] };

  return null;
}