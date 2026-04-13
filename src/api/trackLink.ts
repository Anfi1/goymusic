import { YTMTrack } from './yt';

const WEB = 'https://goymusic.vercel.app/';

interface TrackMeta { t: string; a: string[] }

function encodeMeta(data: TrackMeta): string {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function decodeMeta(str: string): TrackMeta | null {
  try {
    const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch { return null; }
}

export function getTrackLink(track: YTMTrack): string {
  const meta = encodeMeta({ t: track.title ?? '', a: track.artists ?? [] });
  return `${WEB}track/${track.id}/${meta}`;
}

export function getAlbumLink(browseId: string): string {
  return `${WEB}album/${browseId}`;
}

export type ParsedDeepLink =
  | { type: 'track'; id: string; title: string; artists: string[]; thumbUrl: string }
  | { type: 'album'; id: string };

export function parseDeepLink(url: string): ParsedDeepLink | null {
  const trackMatch = url.match(/^goymusic:\/\/track\/([^/?#/]+)(?:\/([^/?#]+))?/);
  if (trackMatch) {
    const meta = trackMatch[2] ? decodeMeta(trackMatch[2]) : null;
    const id = trackMatch[1];
    return {
      type: 'track',
      id,
      title: meta?.t ?? '',
      artists: meta?.a ?? [],
      thumbUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    };
  }

  const albumMatch = url.match(/^goymusic:\/\/album\/([^/?#]+)/);
  if (albumMatch) return { type: 'album', id: albumMatch[1] };

  return null;
}
