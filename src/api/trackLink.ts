import { YTMTrack } from './yt';

// Единое место для генерации ссылок.
// Чтобы вернуться на сырой протокол — заменить WEB на 'goymusic:/'
const WEB = 'https://anfi1.github.io/goymusic/#';

interface TrackMeta { t: string; a: string[]; th: string; }

function encodeMeta(data: TrackMeta): string {
  return btoa(encodeURIComponent(JSON.stringify(data)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function decodeMeta(str: string): TrackMeta | null {
  try {
    const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(decodeURIComponent(atob(base64)));
  } catch { return null; }
}

export function getTrackLink(track: YTMTrack): string {
  const meta = encodeMeta({ t: track.title, a: track.artists ?? [], th: track.thumbUrl ?? '' });
  return `${WEB}track/${track.id}/${meta}`;
}

export function getAlbumLink(browseId: string): string {
  return `${WEB}album/${browseId}`;
}

export type ParsedDeepLink =
  | { type: 'track'; id: string; title: string; artists: string[]; thumbUrl: string }
  | { type: 'album'; id: string };

/** Парсит входящий goymusic:// URL */
export function parseDeepLink(url: string): ParsedDeepLink | null {
  const trackMatch = url.match(/^goymusic:\/\/track\/([^/?#/]+)(?:\/([^/?#]+))?/);
  if (trackMatch) {
    const meta = trackMatch[2] ? decodeMeta(trackMatch[2]) : null;
    return {
      type: 'track',
      id: trackMatch[1],
      title: meta?.t ?? '',
      artists: meta?.a ?? [],
      thumbUrl: meta?.th ?? '',
    };
  }

  const albumMatch = url.match(/^goymusic:\/\/album\/([^/?#]+)/);
  if (albumMatch) return { type: 'album', id: albumMatch[1] };

  return null;
}
