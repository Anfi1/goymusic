import { YTMTrack } from './yt';

const WEB = 'https://goymusic.vercel.app/';

export function getTrackLink(track: YTMTrack): string {
  if (track.source === 'soundcloud' && track.scUrl) {
    const slug = track.scUrl.replace(/^https:\/\/soundcloud\.com\//, '');
    return `${WEB}track/sc/${slug}`;
  }
  return `${WEB}track/${track.id}`;
}

export function getAlbumLink(browseId: string): string {
  return `${WEB}album/${browseId}`;
}

export type ParsedDeepLink =
  | { type: 'track'; id: string; title: string; artists: string[]; thumbUrl: string }
  | { type: 'album'; id: string };

export function parseDeepLink(url: string): ParsedDeepLink | null {
  const scMatch = url.match(/^goymusic:\/\/track\/sc\/([\w-]+\/[\w-]+)/);
  if (scMatch) {
    return {
      type: 'track',
      id: `sc/${scMatch[1]}`,
      title: '',
      artists: [],
      thumbUrl: '',
    };
  }

  const trackMatch = url.match(/^goymusic:\/\/track\/([^/?#/]+)/);
  if (trackMatch) {
    return {
      type: 'track',
      id: trackMatch[1],
      title: '',
      artists: [],
      thumbUrl: `https://i.ytimg.com/vi/${trackMatch[1]}/hqdefault.jpg`,
    };
  }

  const albumMatch = url.match(/^goymusic:\/\/album\/([^/?#]+)/);
  if (albumMatch) return { type: 'album', id: albumMatch[1] };

  return null;
}