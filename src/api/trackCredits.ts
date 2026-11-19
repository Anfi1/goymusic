import type { QueryClient } from '@tanstack/react-query';
import { getTrackCard, type YTMTrack } from './yt';
import { isYoutubeVideoId } from './source';

export function canLookUpVideo(id: string | undefined, source: unknown): id is string {
  return (source == null || source === 'youtube') && isYoutubeVideoId(id);
}

// Shared by the deep link and explicit author clicks. Rendering a row never starts a request.
export function loadVideoCard(client: QueryClient, videoId: string): Promise<YTMTrack | null> {
  if (!isYoutubeVideoId(videoId)) return Promise.resolve(null);
  return client.fetchQuery({
    queryKey: ['video-card', videoId],
    queryFn: () => getTrackCard(videoId),
    retry: false,
    staleTime: query => query.state.data ? 5 * 60_000 : 0,
  }).catch(() => null);
}

export function creditForVideo(videoId: string, name: string, card: YTMTrack | null): string | undefined {
  if (!card?.artists || card.id !== videoId) return;
  const index = card.artists.indexOf(name);
  if (index < 0 || index !== card.artists.lastIndexOf(name)) return;
  return card.artistIds?.[index] || undefined;
}

// Names and IDs form one ordered credit. Never borrow just an ID or overwrite catalog artists.
export function withVideoCredits(track: YTMTrack, from: YTMTrack): YTMTrack {
  if (track.id !== from.id || track.artistIds?.some(Boolean) || !from.artists?.length) return track;
  return { ...track, artists: from.artists, artistIds: from.artistIds };
}
