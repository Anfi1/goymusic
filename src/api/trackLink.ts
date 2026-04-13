// Единое место для генерации ссылок.
// Чтобы вернуться на сырой протокол — заменить WEB на 'goymusic:/'
const WEB = 'https://anfi1.github.io/goymusic/#';

export function getTrackLink(videoId: string): string {
  return `${WEB}track/${videoId}`;
}

export function getAlbumLink(browseId: string): string {
  return `${WEB}album/${browseId}`;
}

/** Парсит входящий deep link URL, возвращает объект или null */
export function parseDeepLink(url: string): { type: 'track'; id: string } | { type: 'album'; id: string } | null {
  const trackMatch = url.match(/^goymusic:\/\/track\/([^/?#]+)/);
  if (trackMatch) return { type: 'track', id: trackMatch[1] };

  const albumMatch = url.match(/^goymusic:\/\/album\/([^/?#]+)/);
  if (albumMatch) return { type: 'album', id: albumMatch[1] };

  return null;
}
