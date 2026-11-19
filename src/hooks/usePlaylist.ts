import { useMemo, useCallback, useState, useEffect, useTransition, useRef } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { getPlaylistTracks, getAlbum, getContinuation, getTrackCard, YTMTrack } from '../api/yt';
import { isSoundCloudId, getSoundCloudAlbum, getSoundCloudPlaylist } from '../api/soundcloud';
import { isYandexAlbumRouteId, isYandexPlaylistRouteId, getYandexAlbumTracks, getYandexPlaylistTracks } from '../api/yandex';
import { player } from '../api/player';
import { likedStore, HydratedLikedEntry, HydratedScLikedEntry, LikedEntry, YT_IMPORT_VERSION } from '../api/likedStore';
import { likedPlaylistTracks } from './likedPlaylistTracks';
import { likedManager } from '../api/likedManager';
import { scLikedManager } from '../api/scLikedManager';
import { tracksStore } from '../api/tracks';
import { LOCAL_PLAYLIST_ID, getAllOverrides, onOverrideChanged } from '../api/localOverrides';

export type PlaylistType = 'liked' | 'playlist' | 'album';
export type SortMode = 'date' | 'album';
export const playlistQueryKey = (type: PlaylistType, id?: string) => ['playlist-infinite', type, id] as const;

export interface PlaylistMetadata {
  id?: string;
  title: string;
  type: string;
  thumbUrl: string;
  trackCount: number;
  description?: string;
  author?: { name: string; id?: string };
  owned?: boolean;
  privacy?: string;
  year?: string;
  duration?: string;
  duration_seconds?: number;
  audioPlaylistId?: string;
  likeStatus?: string;
  menu_tokens?: any;
  isPinned?: boolean;
  artists?: string[];
  artistIds?: string[];
}

const triggerGC = () => {
  if (typeof (window as any).gc === 'function') {
    try {
      (window as any).gc();
    } catch (e) {
      console.warn('Manual GC failed', e);
    }
  }
};

export const usePlaylist = (type: PlaylistType, id?: string) => {
  const queryClient = useQueryClient();
  const [localTracks, setLocalTracks] = useState<HydratedLikedEntry[]>([]);
  const [verifiedEmpty, setVerifiedEmpty] = useState(false);
  const [scEntries, setScEntries] = useState<HydratedScLikedEntry[]>([]);
  const [managerSyncing, setManagerSyncing] = useState(false);
  const [isLocalLoading, setIsLocalLoading] = useState(true);
  const [sortMode, setSortModeState] = useState<SortMode>(() => {
    return (localStorage.getItem('liked-songs-sort-mode') as SortMode) || 'date';
  });
  const [isPending, startTransition] = useTransition();
  
  // Track objects cache to maintain stable references
  const trackCacheRef = useRef<Map<string, YTMTrack>>(new Map());

  const setSortMode = useCallback((mode: SortMode) => {
    localStorage.setItem('liked-songs-sort-mode', mode);
    startTransition(() => {
      setSortModeState(mode);
    });
  }, []);
  
  const queryKey = playlistQueryKey(type, id);
  const isLiked = type === 'liked' || id === 'LM';

  useEffect(() => {
    if (isLiked) {
      let active = true;
      let revision = 0;
      const publish = async (entries: LikedEntry[], syncing: boolean, version: number) => {
        const hydrated = await likedStore.hydrateTracks(entries);
        const empty = !entries.length && await likedStore.getYtImportCompletedVersion() === YT_IMPORT_VERSION;
        if (!active || revision !== version) return;
        setLocalTracks(hydrated);
        setVerifiedEmpty(empty);
        setManagerSyncing(syncing);
        setIsLocalLoading(false);
      };
      likedStore.getAllTracks().then(entries => {
        if (active && revision === 0) return publish(entries, likedManager.isSyncing, 0);
      });
      const unsub = likedManager.subscribe((entries, syncing) => publish(entries, syncing, ++revision));
      likedManager.sync();
      // SC-лайки: мгновенно из локального стора + подписка + фоновая сверка (как у YT).
      likedStore.getAllScTracks().then(async entries => {
        const hydrated = await likedStore.hydrateScTracks(entries);
        setScEntries(hydrated);
      }).catch(() => {});
      const unsubSc = scLikedManager.subscribe(async (entries) => {
        const hydrated = await likedStore.hydrateScTracks(entries);
        setScEntries(hydrated);
      });
      scLikedManager.sync();
      return () => {
        active = false;
        unsub();
        unsubSc();
        triggerGC();
      };
    } else {
      setIsLocalLoading(false);
      const unsubOverrides = id === LOCAL_PLAYLIST_ID
        ? onOverrideChanged(() => queryClient.invalidateQueries({ queryKey: ['playlist-infinite', type, id] }))
        : undefined;
      return () => {
        unsubOverrides?.();
        triggerGC();
      };
    }
  }, [isLiked, id, type, queryClient]);

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading: isQueryLoading,
    isError,
    refetch
  } = useInfiniteQuery({
    queryKey,
    queryFn: async ({ pageParam, signal }) => {
      if (pageParam) {
        const res = await getContinuation(pageParam as string, isLiked);
        return { tracks: res.tracks, continuation: res.continuation, totalCount: res.tracks.length, metadata: null as any };
      }

      if (isLiked) {
        const res = await getPlaylistTracks('LM', null, signal);
        const metadata: PlaylistMetadata = {
          id: 'LM',
          title: (res as any).title || 'Liked Songs',
          type: 'AUTO PLAYLIST',
          description: (res as any).description,
          author: (res as any).author,
          owned: true,
          privacy: 'PRIVATE',
          year: (res as any).year,
          duration: (res as any).duration,
          duration_seconds: (res as any).duration_seconds,
          thumbUrl: (res as any).thumbUrl || res.tracks[0]?.thumbUrl || '',
          trackCount: res.trackCount || res.tracks.length,
          likeStatus: (res as any).likeStatus,
          menu_tokens: (res as any).menu_tokens,
          isPinned: (res as any).isPinned
        };
        
        return { tracks: res.tracks, continuation: res.continuation || null, totalCount: metadata.trackCount, metadata };
      } 
      
      if (id === LOCAL_PLAYLIST_ID) {
        const overrides = (await getAllOverrides()).sort((a, b) => b.addedAt - a.addedAt);
        const trackMap = await tracksStore.getTracks(overrides.map(o => o.videoId));
        for (const o of overrides) {
          if (trackMap.has(o.videoId) || isSoundCloudId(o.videoId)) continue;
          const card = await getTrackCard(o.videoId);
          if (!card) continue;
          trackMap.set(o.videoId, card);
          tracksStore.upsertTrack(card);
        }
        // Трек удалён с площадки и нигде не сохранён: показываем имя файла, играет он всё равно из файла
        const tracks = overrides.map(o => trackMap.get(o.videoId)
          ?? { id: o.videoId, title: o.filename.replace(/\.[^.]+$/, ''), artists: [], album: '', duration: '', thumbUrl: '' });
        const metadata: PlaylistMetadata = {
          id,
          title: 'Local',
          type: 'LOCAL FILES',
          description: 'Tracks that play from files in your Songs folder',
          thumbUrl: tracks[0]?.thumbUrl || '',
          trackCount: tracks.length,
        };
        return { tracks, continuation: null, totalCount: tracks.length, metadata };
      }

      if (type === 'playlist' && id) {
        if (isYandexPlaylistRouteId(id)) {
          const [, ownerId, kind] = id.split(':');
          const yd = await getYandexPlaylistTracks(kind, ownerId);
          const metadata: PlaylistMetadata = {
            id,
            title: yd?.title || 'Playlist',
            type: 'PLAYLIST',
            thumbUrl: yd?.tracks[0]?.thumbUrl || '',
            trackCount: yd?.tracks.length || 0,
          };
          return { tracks: yd?.tracks || [], continuation: null, totalCount: yd?.tracks.length || 0, metadata };
        }
        if (isSoundCloudId(id)) {
          const sc = await getSoundCloudPlaylist(id);
          const metadata: PlaylistMetadata = {
            id,
            title: sc?.title || 'Playlist',
            type: 'PLAYLIST',
            description: sc?.description,
            thumbUrl: sc?.thumbUrl || sc?.tracks[0]?.thumbUrl || '',
            trackCount: sc?.trackCount || sc?.tracks.length || 0,
          };
          return { tracks: sc?.tracks || [], continuation: null, totalCount: sc?.trackCount || sc?.tracks.length || 0, metadata };
        }
        // Read one shelf and its matching continuation, not a prefetched range with the first shelf's cursor.
        const res = await getPlaylistTracks(id, /^(VL)?RD/.test(id) ? 200 : null, signal);
        const metadata: PlaylistMetadata = {
          id,
          title: (res as any).title || 'Playlist',
          type: 'PLAYLIST',
          description: (res as any).description,
          author: (res as any).author,
          owned: (res as any).owned,
          privacy: (res as any).privacy,
          year: (res as any).year,
          duration: (res as any).duration,
          duration_seconds: (res as any).duration_seconds,
          thumbUrl: (res as any).thumbUrl || res.tracks[0]?.thumbUrl || '',
          trackCount: res.trackCount || res.tracks.length,
          likeStatus: (res as any).likeStatus,
          menu_tokens: (res as any).menu_tokens,
          isPinned: (res as any).isPinned
        };
        return { tracks: res.tracks, continuation: res.continuation || null, totalCount: res.trackCount, metadata };
      } else if (type === 'album' && id) {
        if (isYandexAlbumRouteId(id)) {
          const rawId = id.replace(/^yandex:/, '');
          const yd = await getYandexAlbumTracks(rawId);
          const metadata: PlaylistMetadata = {
            id,
            title: yd?.title || 'Album',
            type: yd?.albumType || 'ALBUM',
            thumbUrl: yd?.thumbUrl || '',
            trackCount: yd?.tracks.length || 0,
            artists: yd?.artists?.length ? yd.artists : (yd?.artist ? [yd.artist] : undefined),
            artistIds: yd?.artistIds?.length ? yd.artistIds : (yd?.artistId ? [yd.artistId] : undefined),
            likeStatus: yd?.liked ? 'LIKE' : undefined,
          };
          return { tracks: yd?.tracks || [], continuation: null, totalCount: yd?.tracks.length || 0, metadata };
        }
        if (isSoundCloudId(id)) {
          const sc = await getSoundCloudAlbum(id);
          const metadata: PlaylistMetadata = {
            id,
            title: sc?.title || 'Album',
            type: 'ALBUM',
            thumbUrl: sc?.thumbUrl || sc?.tracks[0]?.thumbUrl || '',
            trackCount: sc?.tracks.length || 0,
            artists: sc?.artists,
            artistIds: sc?.artistIds,
          };
          return { tracks: sc?.tracks || [], continuation: null, totalCount: sc?.tracks.length || 0, metadata };
        }
        const res = await getAlbum(id, signal);
        const metadata: PlaylistMetadata = {
          id: res?.id || id,
          title: res?.title || 'Album',
          type: res?.type || 'ALBUM',
          thumbUrl: res?.thumbUrl || '',
          trackCount: res?.trackCount || res?.tracks.length || 0,
          year: res?.year,
          duration: res?.duration,
          audioPlaylistId: res?.audioPlaylistId,
          likeStatus: res?.likeStatus,
          menu_tokens: res?.menu_tokens,
          isPinned: res?.isPinned,
          artists: res?.artists,
          artistIds: res?.artistIds,
          owned: (res as any).owned
        };
        return { tracks: res?.tracks || [], continuation: (res as any).continuation || null, totalCount: res?.trackCount || res?.tracks.length || 0, metadata };
      }
      
      return { tracks: [], continuation: null, totalCount: 0, metadata: null as any };
    },
    initialPageParam: null,
    getNextPageParam: (lastPage) => (lastPage as any).continuation,
    staleTime: 1000 * 60 * 5,
  });

  // Fast comparison helper
  const getStableTrack = useCallback((track: YTMTrack) => {
    if (!track.id) return track;
    const cached = trackCacheRef.current.get(track.id);
    if (cached && cached.likeStatus === track.likeStatus && cached.title === track.title) {
      return cached;
    }
    trackCacheRef.current.set(track.id, track);
    return track;
  }, []);

  const useLocalLikes = likedManager.isEnabled ? localTracks.length > 0 || verifiedEmpty : !data && localTracks.length > 0;

  const baseTracks = useMemo(() => {
    const tracks: YTMTrack[] = isLiked
      ? likedPlaylistTracks(useLocalLikes ? localTracks : null, data?.pages, scEntries)
      : data?.pages.flatMap(page => page.tracks) || [];

    // Playlist entries have their own setVideoIds. The same recording can occur
    // more than once, or have a different entry ID in another playlist.
    if (!isLiked && type === 'playlist' && data?.pages[0]?.metadata?.owned) return tracks.filter(track => track.id);

    const seen = new Set();
    return tracks.filter(track => {
      if (!track.id || seen.has(track.id)) return false;
      seen.add(track.id);
      return true;
    }).map(getStableTrack);
  }, [data, localTracks, scEntries, useLocalLikes, isLiked, type, getStableTrack]);

  const albumSortedTracks = useMemo(() => {
    if (!isLiked || localTracks.length === 0) return baseTracks;

    const indexMap = new Map<string, number>();
    const lowerAlbumMap = new Map<string, string>();
    
    for (let i = 0; i < localTracks.length; i++) {
      const track = localTracks[i].track;
      indexMap.set(track.id, localTracks[i].originalIndex);
      if (track.album && !lowerAlbumMap.has(track.album)) {
        lowerAlbumMap.set(track.album, track.album.toLowerCase());
      }
    }

    return [...baseTracks].sort((a, b) => {
      const albumA = a.album;
      const albumB = b.album;
      if (!albumA && albumB) return 1;
      if (albumA && !albumB) return -1;
      if (!albumA && !albumB) return (indexMap.get(a.id) ?? 0) - (indexMap.get(b.id) ?? 0);
      
      const lowerA = lowerAlbumMap.get(albumA!) || '';
      const lowerB = lowerAlbumMap.get(albumB!) || '';
      
      if (lowerA < lowerB) return -1;
      if (lowerA > lowerB) return 1;
      
      return (indexMap.get(a.id) ?? 0) - (indexMap.get(b.id) ?? 0);
    });
  }, [baseTracks, localTracks, isLiked]);

  const allTracks = sortMode === 'album' ? albumSortedTracks : baseTracks;

  const metadata = useMemo(() => {
    const base = (data?.pages[0] as any)?.metadata as PlaylistMetadata | null;
    if (isLiked && base) {
      return {
        ...base,
        trackCount: useLocalLikes ? localTracks.length + scEntries.length : base.trackCount + scEntries.length,
      } as PlaylistMetadata;
    }
    return base;
  }, [data, useLocalLikes, isLiked, localTracks, scEntries]);

  const totalReportedCount = useMemo(() => metadata?.trackCount || 0, [metadata]);

  const lastTrackIdsRef = useRef<string>("");
  const syncPlayerQueue = useCallback(() => {
    if (allTracks.length > 0) {
      const currentIds = allTracks.map(t => t.id).join(',') + '|' + allTracks.map(t => t.likeStatus).join(',');
      if (currentIds === lastTrackIdsRef.current) return;
      
      lastTrackIdsRef.current = currentIds;
      const sourceId = isLiked ? 'LM' : (id || 'unknown');
      player.updateQueueIfSourceMatches(sourceId, allTracks);
    }
  }, [allTracks, id, isLiked]);

  useEffect(() => {
    if (isLiked && allTracks.length > 0) {
      syncPlayerQueue();
    }
  }, [allTracks, isLiked, syncPlayerQueue]);

  const finalSyncing = isLiked ? (managerSyncing || isFetchingNextPage) : isFetchingNextPage;
  const isLoading = isLiked ? (isLocalLoading && isQueryLoading && localTracks.length === 0) : isQueryLoading;

  return useMemo(() => ({
    tracks: allTracks,
    metadata,
    totalReportedCount,
    isLoading,
    isError,
    hasNextPage: isLiked && (useLocalLikes || managerSyncing) ? false : hasNextPage,
    isFetchingNextPage: finalSyncing,
    fetchNextPage,
    syncPlayerQueue,
    refetch,
    sortMode,
    setSortMode,
    isSorting: isPending
  }), [allTracks, metadata, totalReportedCount, isLoading, isError, hasNextPage, finalSyncing, fetchNextPage, syncPlayerQueue, refetch, isLiked, useLocalLikes, managerSyncing, sortMode, setSortMode, isPending]);
};
