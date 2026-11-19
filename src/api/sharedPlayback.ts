import type { QueryClient } from '@tanstack/react-query';
import { player } from './player';
import { resolveScTrack } from './soundcloud';
import { loadVideoCard } from './trackCredits';
import type { ParsedDeepLink } from './trackLink';
import type { YTMTrack } from './yt';

export async function playSharedTrack(link: Extract<ParsedDeepLink, { type: 'track' }>, client: QueryClient) {
  const { id, source, title, artists, thumbUrl, scUrl, yandexId, startTime } = link;
  let track: YTMTrack = { id, source, title, artists, thumbUrl, scUrl, yandexId, album: '', duration: '' };
  if (source === 'soundcloud' && scUrl) track = await resolveScTrack(scUrl) ?? track;
  void player.startRadio(track, startTime);
  if (source === 'youtube') {
    const card = await loadVideoCard(client, id);
    if (card?.id === id) player.applySharedVideoCard(card);
  }
}
