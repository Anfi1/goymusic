import { useMemo, useCallback, useState, useEffect, useTransition, useRef } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { getLikedSongs, getPlaylistTracks, getAlbum, getContinuation, YTMTrack } from '../api/yt';
import { player } from '../api/player';
import { likedStore, LikedEntry } from '../api/likedStore';
import { likedManager } from '../api/likedManager';

export type PlaylistType = 'liked' | 'playlist' | 'album';
export type SortMode = 'date' | 'album';

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
  const [localTracks, setLocalTracks] = useState<LikedEntry[]>([]);
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
  
  const queryKey = ['playlist-infinite', type, id];
  const isLiked = type === 'liked' || id === 'LM';

  useEffect(() => {
    if (isLiked) {
      likedStore.getAllTracks().then(tracks => {
        setLocalTracks(tracks);
        setIsLocalLoading(false);
      });
      likedManager.sync();
      const unsub = likedManager.subscribe((tracks, syncing) => {
        setLocalTracks(tracks);
        setManagerSyncing(syncing);
        setIsLocalLoading(false);
      });
      return () => {
        unsub();
        triggerGC(); // Clean up memory when leaving Liked Songs
      };
    } else {
      setIsLocalLoading(false);
      return () => triggerGC(); // Clean up memory when leaving any playlist
    }
  }, [isLiked]);

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
        const res = await getContinuation(pageParam as string);
        return { tracks: res.tracks, continuation: res.continuation, totalCount: res.tracks.length, metadata: null as any };
      }

      if (isLiked) {
        const res = await getPlaylistTracks('LM', 100, signal);
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
        
        // Use a faster check for local data
        const localCount = await likedStore.getVirtualCount();
        const hasLocal = localCount > 0;
        
        return { 
          tracks: hasLocal ? [] : res.tracks, 
          continuation: hasLocal ? null : (res.continuation || null), 
          totalCount: metadata.trackCount, 
          metadata 
        };
      } 
      
      if (type === 'playlist' && id) {
        const res = await getPlaylistTracks(id, 200, signal);
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

  const { data: virtualCount } = useQuery({
    queryKey: ['liked-virtual-count'],
    queryFn: () => likedStore.getVirtualCount(),
    enabled: isLiked
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

  const baseTracks = useMemo(() => {
    let tracks: YTMTrack[] = [];

    if (isLiked && localTracks.length > 0) {
      tracks = localTracks.map(e => e.track);
    } else {
      tracks = data?.pages.flatMap(page => (page as any).tracks) || [];
    }

    const seen = new Set();
    return tracks.filter(track => {
      if (!track.id || seen.has(track.id)) return false;
      seen.add(track.id);
      return true;
    }).map(getStableTrack);
  }, [data, localTracks, isLiked, getStableTrack]);

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
        trackCount: virtualCount || base.trackCount || localTracks.length,
      } as PlaylistMetadata;
    }
    return base;
  }, [data, virtualCount, isLiked, localTracks]);

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
    hasNextPage: isLiked ? false : hasNextPage,
    isFetchingNextPage: finalSyncing,
    fetchNextPage,
    syncPlayerQueue,
    refetch,
    sortMode,
    setSortMode,
    isSorting: isPending
  }), [allTracks, metadata, totalReportedCount, isLoading, isError, hasNextPage, finalSyncing, fetchNextPage, syncPlayerQueue, refetch, isLiked, sortMode, setSortMode, isPending]);
};
