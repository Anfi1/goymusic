import { YTMTrack } from './yt';

const WEB = 'https://goymusic.vercel.app/';

export function getTrackLink(track: YTMTrack): string {
  if (track.source === 'soundcloud' && track.scUrl) {
    const slug = track.scUrl.replace(/^https:\/\/soundcloud\.com\//, '');
    return `${WEB}track/sc/${slug}`;
  }
  const meta = { t: track.title || '', a: track.artists || [], i: track.thumbUrl || '' };
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(meta))));
  return `${WEB}track/${track.id}?m=${b64}`;
}

export function getAlbumLink(browseId: string): string {
  return `${WEB}album/${browseId}`;
}

export type ParsedDeepLink =
  | { type: 'track'; id: string; title: string; artists: string[]; thumbUrl: string; scUrl?: string; source?: string }
  | { type: 'album'; id: string };

function decodeMeta(search: string): { t?: string; a?: string[]; i?: string } {
  try {
    const params = new URLSearchParams(search);
    const m = params.get('m');
    if (!m) return {};
    const bytes = Uint8Array.from(atob(m), c => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch { return {}; }
}

export function parseDeepLink(url: string): ParsedDeepLink | null {
  const scMatch = url.match(/^goymusic:\/\/track\/sc\/([\w-]+\/[\w-]+)/);
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

  const trackMatch = url.match(/^goymusic:\/\/track\/([^/?#/]+)/);
  if (trackMatch) {
    const qIdx = url.indexOf('?');
    const meta = qIdx >= 0 ? decodeMeta(url.slice(qIdx)) : {};
    return {
      type: 'track',
      id: trackMatch[1],
      title: meta.t || '',
      artists: meta.a || [],
      thumbUrl: meta.i || `https://i.ytimg.com/vi/${trackMatch[1]}/hqdefault.jpg`,
    };
  }

  const albumMatch = url.match(/^goymusic:\/\/album\/([^/?#]+)/);
  if (albumMatch) return { type: 'album', id: albumMatch[1] };

  return null;
}