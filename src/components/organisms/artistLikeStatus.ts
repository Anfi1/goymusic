import type { YTMTrack } from '../../api/yt';
import {
  hydrateTracksLikeStatus,
  resolveTrackLikeStatus,
  type TrackLikeLookup,
  type TrackLikeStatus,
} from '../../api/likedIndex';

export type { TrackLikeStatus };
export type ArtistLikeLookup = TrackLikeLookup;

export function resolveArtistTrackLikeStatus(
  track: Pick<YTMTrack, 'id' | 'likeStatus' | 'source' | 'scId' | 'yandexId'>,
  lookup: ArtistLikeLookup,
): TrackLikeStatus {
  return resolveTrackLikeStatus(track, lookup);
}

export function applyArtistTrackLikeStatus(
  tracks: readonly YTMTrack[],
  lookup: ArtistLikeLookup,
): YTMTrack[] {
  return hydrateTracksLikeStatus(tracks, lookup);
}

export function selectDisplayedArtistSongs(
  tracks: readonly YTMTrack[],
  likesOnly: boolean,
  lookup: ArtistLikeLookup,
): YTMTrack[] {
  const resolved = hydrateTracksLikeStatus(tracks, lookup);
  if (!likesOnly) return resolved;
  return resolved.filter(song => song.likeStatus === 'LIKE');
}
