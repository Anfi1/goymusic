import React, { useState, useCallback, useMemo, memo, useEffect, useRef } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { getHomeSections, getAlbum, getPlaylistTracks, sendFeedback } from '../../api/yt';
import { player } from '../../api/player';
import { MediaCard } from '../molecules/MediaCard';
import { MediaCardSkeleton } from '../molecules/MediaCardSkeleton';
import { Carousel } from '../molecules/Carousel';
import { Skeleton } from '../atoms/Skeleton';
import {
  Pin, PinOff, Trash2, Play,
  ListMusic, Mic2, Disc, Library, Music2, Zap, LayoutGrid, RefreshCw
} from 'lucide-react';
import { ContextMenu, ContextMenuItem } from '../molecules/ContextMenu';
import { useToast } from '../atoms/Toast';
import { YTMHomeSection } from '../../api/yt';
import styles from './HomeView.module.css';

const getSectionIcon = (category: string | undefined, isFirst: boolean) => {
  if (isFirst) return Zap;
  switch (category?.toLowerCase()) {
    case 'artist': return Mic2;
    case 'album': return Disc;
    case 'playlist': return Library;
    case 'song': return Music2;
    default: return LayoutGrid;
  }
};

const FORBIDDEN_TITLES = ['new releases', 'новые релизы', 'новинки'];

function filterSection(section: YTMHomeSection): boolean {
  return !FORBIDDEN_TITLES.some(t => section.title?.toLowerCase().includes(t));
}

function normalizePins(section: YTMHomeSection, isFirst: boolean): YTMHomeSection {
  if (!isFirst || !section.contents) return section;
  let foundUnpinned = false;
  const contents = section.contents.map((item: any) => {
    if (!item.isPinned) foundUnpinned = true;
    return { ...item, isPinned: foundUnpinned ? false : item.isPinned };
  });
  return { ...section, contents };
}

const SectionSkeleton: React.FC<{ variant?: 'card' | 'row' }> = ({ variant = 'card' }) => (
  <div className={styles.section}>
    <div className={styles.sectionHeader}>
      <div className={styles.sectionTitleWrapper}>
        <Skeleton width={20} height={20} borderRadius="50%" />
        <div style={{ marginLeft: 12 }}><Skeleton width={180} height={24} borderRadius={4} /></div>
      </div>
    </div>
    <div className={variant === 'row' ? styles.songGrid : styles.horizontalScroll}>
      {Array.from({ length: 8 }).map((_, j) => (
        <MediaCardSkeleton key={j} variant={variant} className={variant === 'row' ? styles.songCard : styles.card} />
      ))}
    </div>
  </div>
);

export const HomeView: React.FC<{
  onSelectArtist: (id: string) => void;
  onSelectAlbum: (id: string) => void;
  onSelectPlaylist: (id: string, title: string) => void;
}> = memo(({ onSelectArtist, onSelectAlbum, onSelectPlaylist }) => {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, item: any } | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const {
    data,
    isLoading,
    isError,
    isFetching,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
  } = useInfiniteQuery({
    queryKey: ['home-sections'],
    queryFn: ({ pageParam }: { pageParam: string | null }) => getHomeSections(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.continuation ?? undefined,
    staleTime: 60 * 60 * 1000,
  });

  // Flatten + filter all loaded pages
  const sections = useMemo(() => {
    if (!data) return [];
    return data.pages
      .flatMap(p => p.sections)
      .filter(filterSection)
      .map((s, i) => normalizePins(s, i === 0));
  }, [data]);

  const pagesLoaded = data?.pages?.length ?? 0;
  const isBackgroundRefetch = isFetching && !isLoading && !isFetchingNextPage;
  const wasRefetchingRef = useRef(false);

  // After a background refetch (F5/invalidate) completes, trim cache to page 1.
  // This way old sections stay visible during the refetch and disappear only when fresh data is ready.
  useEffect(() => {
    if (isBackgroundRefetch) {
      wasRefetchingRef.current = true;
    } else if (wasRefetchingRef.current) {
      wasRefetchingRef.current = false;
      queryClient.setQueryData(['home-sections'], (old: any) => {
        if (!old?.pages?.length) return old;
        return { pages: [old.pages[0]], pageParams: [old.pageParams[0]] };
      });
    }
  }, [isBackgroundRefetch, queryClient]);

  // IntersectionObserver — preload next page(s) when 700px from container bottom.
  // Skip while background-refetching (isFetching && !isFetchingNextPage) so that
  // when the refetch completes, the effect re-runs and the sentinel re-fires.
  useEffect(() => {
    const isBackgroundRefetch = isFetching && !isFetchingNextPage;
    if (!sentinelRef.current || !containerRef.current || !hasNextPage || isBackgroundRefetch) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        if (pagesLoaded >= 2) {
          // Fetch 2 pages at once for smoother deep-scroll experience
          fetchNextPage().then(() => fetchNextPage());
        } else {
          fetchNextPage();
        }
      },
      { root: containerRef.current, rootMargin: '0px 0px 700px 0px' }
    );
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage, pagesLoaded, isFetching, isFetchingNextPage]);

  const handlePlayClick = useCallback(async (item: any) => {
    const type = item.type?.toLowerCase();
    if (type === 'song') {
      player.playSingle(item);
    } else if (type === 'album') {
      const albumData = await getAlbum(item.id);
      if (albumData?.tracks?.length) {
        player.playTrackList(albumData.tracks, 0, item.id, 'album', albumData.audioPlaylistId);
      }
    } else if (type === 'playlist') {
      const result = await getPlaylistTracks(item.id);
      if (result.tracks?.length) {
        player.playTrackList(result.tracks, 0, item.id, 'playlist');
      }
    }
  }, []);

  const handleFeedback = useCallback(async (token: string, action: 'pin' | 'unpin' | 'remove', itemTitle: string) => {
    setContextMenu(null);
    try {
      const success = await sendFeedback(token);
      if (success) {
        await queryClient.resetQueries({ queryKey: ['home-sections'] });
        showToast(action === 'pin' ? `Pinned "${itemTitle}"` : action === 'unpin' ? `Unpinned "${itemTitle}"` : `Removed "${itemTitle}"`, 'success');
      }
    } catch { showToast('Action failed', 'error'); }
  }, [queryClient, showToast]);

  const handleContextMenu = useCallback((e: React.MouseEvent, item: any) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, item });
  }, []);

  const handleItemClick = useCallback((item: any) => {
    const type = item.type?.toLowerCase();
    if (type === 'artist') onSelectArtist(item.id);
    else if (type === 'album') onSelectAlbum(item.id);
    else if (type === 'playlist') onSelectPlaylist(item.id, item.title);
    else if (type === 'song') onSelectAlbum(item.albumId || item.id);
  }, [onSelectArtist, onSelectAlbum, onSelectPlaylist]);

  const menuItems: ContextMenuItem[] = useMemo(() => {
    if (!contextMenu) return [];
    const item = contextMenu.item;
    const items: ContextMenuItem[] = [{ label: 'Play Now', icon: Play, onClick: () => handlePlayClick(item) }];
    if (item.albumId) items.push({ label: 'Go to Album', icon: ListMusic, onClick: () => onSelectAlbum(item.albumId) });
    if (item.playlistId) items.push({ label: 'Go to Playlist', icon: ListMusic, onClick: () => onSelectPlaylist(item.playlistId, item.title) });
    const tokens = item.menu_tokens;
    if (tokens) {
      if (item.isPinned && tokens.unpin) items.push({ label: 'Unpin', icon: PinOff, onClick: () => handleFeedback(tokens.unpin!, 'unpin', item.title) });
      else if (!item.isPinned && tokens.pin) items.push({ label: 'Pin', icon: Pin, onClick: () => handleFeedback(tokens.pin!, 'pin', item.title) });
      if (tokens.notInterested) items.push({ label: 'Not Interested', icon: Trash2, isDanger: true, onClick: () => handleFeedback(tokens.notInterested!, 'remove', item.title) });
    }
    return items;
  }, [contextMenu, handlePlayClick, onSelectAlbum, onSelectPlaylist, handleFeedback]);

  if (isLoading) {
    return (
      <div className={styles.container}>
        <SectionSkeleton variant="card" />
        <SectionSkeleton variant="row" />
        <SectionSkeleton variant="card" />
      </div>
    );
  }

  if (isError && sections.length === 0) {
    return <div className={styles.container} style={{ color: '#f38ba8', padding: 24 }}>Failed to load home feed.</div>;
  }

  return (
    <div ref={containerRef} className={styles.container}>
      {sections.map((section: any, idx: number) => {
        const Icon = getSectionIcon(section.category, idx === 0);
        const isSongGrid = section.category === 'song';
        return (
          <section
            key={`${section.title}-${idx}`}
            className={`${styles.section} ${isSongGrid ? styles.songSection : ''}`}
          >
            <div className={styles.sectionHeader}>
              <div className={styles.sectionTitleWrapper}>
                <Icon size={20} className={styles.sectionIcon} />
                <h2 className={styles.sectionTitle}>{section.title}</h2>
              </div>
              {idx === 0 && isFetching && !isFetchingNextPage && (
                <div className={styles.updatingBadge}>
                  <RefreshCw size={10} className={styles.spinIcon} />
                  Updating
                </div>
              )}
            </div>
            <Carousel
              items={section.contents}
              containerClassName={isSongGrid ? styles.songGrid : styles.horizontalScroll}
              renderItem={(item) => (
                <MediaCard
                  key={item.id}
                  {...item}
                  className={isSongGrid ? styles.songCard : styles.card}
                  variant={isSongGrid ? 'row' : 'card'}
                  onClick={() => handleItemClick(item)}
                  onPlayClick={() => handlePlayClick(item)}
                  onArtistClick={onSelectArtist}
                  onContextMenu={(e) => handleContextMenu(e, item)}
                />
              )}
            />
          </section>
        );
      })}

      {/* Sentinel — triggers prefetch 600px before reaching it */}
      {hasNextPage && <div ref={sentinelRef} style={{ height: 1 }} />}

      {isFetchingNextPage && (
        <>
          <SectionSkeleton variant="card" />
          <SectionSkeleton variant="row" />
        </>
      )}

      {contextMenu && <ContextMenu x={contextMenu.x} y={contextMenu.y} items={menuItems} onClose={() => setContextMenu(null)} />}
    </div>
  );
});
