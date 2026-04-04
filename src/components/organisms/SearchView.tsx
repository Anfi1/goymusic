import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { searchMusic, searchMore } from '../../api/yt';
import { player } from '../../api/player';
import { LazyImage } from '../atoms/LazyImage';
import { Skeleton } from '../atoms/Skeleton';
import { ArtistCard } from '../molecules/ArtistCard';
import { TrackRow } from '../molecules/TrackRow';
import { QueueItem } from '../molecules/QueueItem';
import { ContextMenu, ContextMenuItem } from '../molecules/ContextMenu';
import { Play, ChevronLeft, ChevronRight, MoveRight } from 'lucide-react';
import { Virtuoso } from 'react-virtuoso';
import styles from './SearchView.module.css';

interface SearchViewProps {
  searchQuery: string;
  onSelectArtist: (id: string) => void;
  onSelectAlbum: (id: string) => void;
  onSelectPlaylist: (id: string, title: string) => void;
  onSearchAgain: (query: string) => void;
}

type FilterMode = 'all' | 'songs' | 'videos' | 'albums';

const PAGE_SIZE = 20;

// Matches QueueItem layout: cover 44px | title+artist | duration
const QueueItemSkeleton = () => (
  <div className={styles.skeletonRow}>
    <Skeleton width={44} height={44} borderRadius={8} />
    <div className={styles.skeletonRowInfo}>
      <Skeleton width="55%" height={13} borderRadius={4} />
      <Skeleton width="35%" height={11} borderRadius={4} />
    </div>
    <Skeleton width={32} height={12} borderRadius={4} />
  </div>
);

// Matches albumCardGrid: full-width square image + 2 text lines
const AlbumCardSkeleton = () => (
  <div className={styles.albumCardSkeleton}>
    <div className={styles.albumSkeletonImg} />
    <Skeleton width="75%" height={13} borderRadius={4} />
    <Skeleton width="50%" height={11} borderRadius={4} />
  </div>
);

// Matches Top Result card: 88x88 cover + title + meta
const TopResultSkeleton = () => (
  <div className={styles.topResultCard} style={{ pointerEvents: 'none', maxWidth: 420 }}>
    <Skeleton width={88} height={88} borderRadius={10} />
    <div className={styles.topResultInfo}>
      <Skeleton width={160} height={18} borderRadius={5} />
      <Skeleton width={100} height={13} borderRadius={4} />
    </div>
  </div>
);

export const SearchView: React.FC<SearchViewProps> = ({
  searchQuery,
  onSelectArtist,
  onSelectAlbum,
  onSelectPlaylist,
  onSearchAgain
}) => {
  const { data: searchData, isLoading } = useQuery({
    queryKey: ['search', searchQuery],
    queryFn: () => searchMusic(searchQuery),
    enabled: !!searchQuery,
    staleTime: 0,
    gcTime: 0,
  });

  const [activeFilter, setActiveFilter] = useState<FilterMode>('all');

  // Per-filter cache: preserves results when switching tabs, cleared on new search query
  const filterCache = useRef<Record<string, { items: any[]; offset: number; hasMore: boolean }>>({});
  const [filterState, setFilterState] = useState<{ items: any[]; offset: number; hasMore: boolean }>(
    { items: [], offset: 0, hasMore: true }
  );
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [filteredInitialLoading, setFilteredInitialLoading] = useState(false);

  // Clear cache when query changes
  useEffect(() => {
    filterCache.current = {};
    likeOverridesRef.current = {};
    setFilterState({ items: [], offset: 0, hasMore: true });
    setActiveFilter('all');
    setLikeOverrides({});
  }, [searchQuery]);

  // Restore or init state when switching filter
  useEffect(() => {
    if (activeFilter === 'all') return;
    const cached = filterCache.current[activeFilter];
    if (cached) {
      setFilterState(cached);
    } else {
      setFilterState({ items: [], offset: 0, hasMore: true });
    }
  }, [activeFilter]);

  const filteredItems = filterState.items;

  const loadFilteredPage = useCallback(async () => {
    if (isLoadingMore || !filterState.hasMore || activeFilter === 'all') return;
    const isFirst = filterState.items.length === 0;
    if (isFirst) setFilteredInitialLoading(true); else setIsLoadingMore(true);
    try {
      const items = await searchMore(searchQuery, filterState.offset, activeFilter as any);
      const newState = {
        items: [...filterState.items, ...items],
        offset: filterState.offset + PAGE_SIZE,
        hasMore: items.length >= PAGE_SIZE,
      };
      filterCache.current[activeFilter] = newState;
      setFilterState(newState);
    } finally {
      setIsLoadingMore(false);
      setFilteredInitialLoading(false);
    }
  }, [isLoadingMore, filterState, activeFilter, searchQuery]);

  // Load first page when entering a filter with no data
  useEffect(() => {
    if (activeFilter !== 'all' && filterState.items.length === 0 && !isLoadingMore && !filteredInitialLoading) {
      loadFilteredPage();
    }
  }, [activeFilter, filterState.items.length, isLoadingMore, filteredInitialLoading, loadFilteredPage]);

  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, item: any } | null>(null);
  const [activeTrackId, setActiveTrackId] = useState<string | undefined>(player.currentTrack?.id);
  const [isPlaying, setIsPlaying] = useState<boolean>(player.isPlaying);
  // Синхронные переопределения likeStatus — ref чтобы были доступны сразу при ремаунте Virtuoso
  const likeOverridesRef = useRef<Record<string, string>>({});
  const [likeOverrides, setLikeOverrides] = useState<Record<string, string>>({});

  useEffect(() => {
    return player.subscribe((event) => {
      if (event === 'tick') return;
      setActiveTrackId(player.currentTrack?.id);
      setIsPlaying(player.isPlaying);
    });
  }, []);

  useEffect(() => {
    const handler = (e: CustomEvent) => {
      const { id, status, likeStatus: newStatus } = e.detail;
      if (status !== 'success') return;
      // Обновляем ref синхронно (доступен при ремаунте элементов Virtuoso до перерендера)
      likeOverridesRef.current = { ...likeOverridesRef.current, [id]: newStatus };
      setLikeOverrides({ ...likeOverridesRef.current });
      // Обновляем filterState и кэш для вкладок songs/videos
      setFilterState(prev => ({
        ...prev,
        items: prev.items.map(item => item.id === id ? { ...item, likeStatus: newStatus } : item)
      }));
      Object.keys(filterCache.current).forEach(key => {
        const cached = filterCache.current[key];
        if (cached) {
          filterCache.current[key] = {
            ...cached,
            items: cached.items.map(item => item.id === id ? { ...item, likeStatus: newStatus } : item)
          };
        }
      });
    };
    window.addEventListener('track-like-updated', handler as EventListener);
    return () => window.removeEventListener('track-like-updated', handler as EventListener);
  }, []);

  // Reset to 'all' when search query changes
  useEffect(() => {
    setActiveFilter('all');
  }, [searchQuery]);

  const topResult = searchData?.top;
  const correction = searchData?.correction;
  const tracks = searchData?.tracks || [];
  const artists = searchData?.artists || [];
  const albums = searchData?.albums || [];

  const artistsScrollRef = useRef<HTMLDivElement>(null);
  const albumsScrollRef = useRef<HTMLDivElement>(null);
  const [canScrollArtists, setCanScrollArtists] = useState({ left: false, right: true });
  const [canScrollAlbums, setCanScrollAlbums] = useState({ left: false, right: true });

  const checkScroll = useCallback(() => {
    if (artistsScrollRef.current) {
      const { scrollLeft, scrollWidth, clientWidth } = artistsScrollRef.current;
      setCanScrollArtists({ left: scrollLeft > 10, right: scrollLeft < scrollWidth - clientWidth - 10 });
    }
    if (albumsScrollRef.current) {
      const { scrollLeft, scrollWidth, clientWidth } = albumsScrollRef.current;
      setCanScrollAlbums({ left: scrollLeft > 10, right: scrollLeft < scrollWidth - clientWidth - 10 });
    }
  }, []);

  useEffect(() => {
    checkScroll();
    window.addEventListener('resize', checkScroll);
    return () => window.removeEventListener('resize', checkScroll);
  }, [checkScroll, searchData]);

  const scrollSection = (ref: React.RefObject<HTMLDivElement | null>, dir: 'left' | 'right') => {
    ref.current?.scrollBy({ left: dir === 'left' ? -600 : 600, behavior: 'smooth' });
    setTimeout(checkScroll, 400);
  };

  const menuItems: ContextMenuItem[] = [{
    label: 'Play Now', icon: Play,
    onClick: () => {
      if (!contextMenu) return;
      const item = contextMenu.item;
      if (item.type === 'artist' || item.resultType === 'artist') onSelectArtist(item.id);
      else if (item.type === 'album' || item.resultType === 'album') onSelectAlbum(item.id);
      else if (item.type === 'playlist' || item.resultType === 'playlist') onSelectPlaylist(item.id, item.title || item.name);
      else player.playSingle(item);
    }
  }];

  const tabs: { key: FilterMode; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'songs', label: 'Songs' },
    { key: 'videos', label: 'Videos' },
    { key: 'albums', label: 'Albums' },
  ];

  return (
    <div className={styles.container}>
      {/* Tab bar */}
      <div className={styles.tabBar}>
        {tabs.map(t => (
          <button
            key={t.key}
            className={`${styles.tab} ${activeFilter === t.key ? styles.tabActive : ''}`}
            onClick={() => setActiveFilter(t.key)}
          >{t.label}</button>
        ))}
        {correction && (
          <div className={styles.correction}>
            Did you mean:
            <button className={styles.correctionLink} onClick={() => onSearchAgain(correction)}>
              {correction}
            </button>
          </div>
        )}
      </div>

      {/* ── All results ────────────────────────────────── */}
      {activeFilter === 'all' && (
        <div className={styles.searchContent}>
          {isLoading ? (
            <>
              <div className={styles.section}>
                <Skeleton width={90} height={16} borderRadius={4} />
                <TopResultSkeleton />
              </div>
              <div className={styles.section}>
                <Skeleton width={60} height={16} borderRadius={4} />
                <div className={styles.skeletonTrackList}>
                  {Array.from({ length: 5 }).map((_, i) => <QueueItemSkeleton key={i} />)}
                </div>
              </div>
            </>
          ) : (
            <>
              {topResult && (
                <section className={styles.section}>
                  <h2 className={styles.sectionTitle}>Top Result</h2>
                  <div
                    className={styles.topResultCard}
                    onClick={() => {
                      if (topResult.resultType === 'artist') onSelectArtist(topResult.id);
                      else if (topResult.resultType === 'album') onSelectAlbum(topResult.id);
                      else if (topResult.resultType === 'playlist') onSelectPlaylist(topResult.id, topResult.title || topResult.name);
                      else player.playSingle(topResult);
                    }}
                    onContextMenu={(e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, item: topResult }); }}
                  >
                    <div className={styles.topResultThumbWrapper}>
                      <LazyImage src={topResult.thumbUrl} className={`${styles.topResultThumb} ${topResult.resultType === 'artist' ? styles.round : ''}`} />
                    </div>
                    <div className={styles.topResultInfo}>
                      <div className={styles.topResultTitle}>{topResult.title || topResult.name}</div>
                      <div className={styles.topResultMeta}>
                        <span className={styles.capitalize}>{topResult.resultType}</span>
                        {topResult.artists && (<>
                          {' • '}
                          {topResult.artists.map((name: string, idx: number) => (
                            <React.Fragment key={idx}>
                              <span
                                className={topResult.artistIds?.[idx] ? styles.songLink : ''}
                                onClick={(e) => { const aid = topResult.artistIds?.[idx]; if (aid) { e.stopPropagation(); onSelectArtist(aid); } }}
                              >{name}</span>
                              {idx < topResult.artists.length - 1 && ', '}
                            </React.Fragment>
                          ))}
                        </>)}
                        {topResult.views && <span> • {topResult.views}</span>}
                      </div>
                    </div>
                  </div>
                </section>
              )}

              {tracks.length > 0 && (
                <section className={styles.section}>
                  <button className={styles.sectionTitleBtn} onClick={() => setActiveFilter('songs')}>
                    Songs <MoveRight size={15} className={styles.sectionArrow} />
                  </button>
                  <table className={styles.trackList} style={{ borderCollapse: 'collapse', tableLayout: 'fixed', width: '100%' }}>
                    <colgroup>
                      <col style={{ width: 48 }} />
                      <col style={{ width: '45%' }} />
                      <col style={{ width: '35%' }} />
                      <col style={{ width: 100 }} />
                    </colgroup>
                    <tbody>
                      {tracks.map((track, i) => (
                        <TrackRow
                          key={track.id}
                          index={i + 1}
                          {...track}
                          likeStatus={likeOverrides[track.id] ?? track.likeStatus}
                          isActive={activeTrackId === track.id}
                          isPlaying={isPlaying}
                          onClick={() => player.playTrackList(tracks, i, searchQuery)}
                          onSelectArtist={onSelectArtist}
                          onSelectAlbum={onSelectAlbum}
                        />
                      ))}
                    </tbody>
                  </table>
                </section>
              )}

              {artists.length > 0 && (
                <section className={styles.section}>
                  <h2 className={styles.sectionTitle}>Artists</h2>
                  <div className={styles.scrollWrapper}>
                    {canScrollArtists.left && (
                      <button className={`${styles.scrollNavBtn} ${styles.left}`} onClick={() => scrollSection(artistsScrollRef, 'left')}><ChevronLeft size={24} /></button>
                    )}
                    <div className={styles.horizontalScroll} ref={artistsScrollRef} onScroll={checkScroll}>
                      {artists.map(artist => <ArtistCard key={artist.id} {...artist} onClick={() => onSelectArtist(artist.id)} />)}
                    </div>
                    {canScrollArtists.right && (
                      <button className={`${styles.scrollNavBtn} ${styles.right}`} onClick={() => scrollSection(artistsScrollRef, 'right')}><ChevronRight size={24} /></button>
                    )}
                  </div>
                </section>
              )}

              {albums.length > 0 && (
                <section className={styles.section}>
                  <button className={styles.sectionTitleBtn} onClick={() => setActiveFilter('albums')}>
                    Albums <MoveRight size={15} className={styles.sectionArrow} />
                  </button>
                  <div className={styles.scrollWrapper}>
                    {canScrollAlbums.left && (
                      <button className={`${styles.scrollNavBtn} ${styles.left}`} onClick={() => scrollSection(albumsScrollRef, 'left')}><ChevronLeft size={24} /></button>
                    )}
                    <div className={styles.horizontalScroll} ref={albumsScrollRef} onScroll={checkScroll}>
                      {albums.map(album => (
                        <div
                          key={album.id}
                          className={styles.albumCard}
                          onClick={() => onSelectAlbum(album.id)}
                          onContextMenu={(e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, item: { ...album, type: 'album' } }); }}
                        >
                          <LazyImage src={album.thumbUrl} className={styles.albumThumb} />
                          <div className={styles.albumTitle}>{album.title}</div>
                          <div className={styles.albumArtists}>
                            {album.artists.map((name: string, idx: number) => (
                              <React.Fragment key={idx}>
                                <span
                                  className={album.artistIds?.[idx] ? styles.songLink : ''}
                                  onClick={(e) => { const aid = album.artistIds?.[idx]; if (aid) { e.stopPropagation(); onSelectArtist(aid); } }}
                                >{name}</span>
                                {idx < album.artists.length - 1 && ', '}
                              </React.Fragment>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                    {canScrollAlbums.right && (
                      <button className={`${styles.scrollNavBtn} ${styles.right}`} onClick={() => scrollSection(albumsScrollRef, 'right')}><ChevronRight size={24} /></button>
                    )}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      )}

      {/* ── Songs / Videos filtered ───────────────────── */}
      {(activeFilter === 'songs' || activeFilter === 'videos') && (
        <>
          {filteredItems.length === 0 && (filteredInitialLoading || isLoadingMore) ? (
            <div className={styles.skeletonTrackList} style={{ padding: '0 1rem' }}>
              {Array.from({ length: 12 }).map((_, i) => <QueueItemSkeleton key={i} />)}
            </div>
          ) : (
            <Virtuoso
              style={{ flex: 1 }}
              data={filteredItems}
              endReached={loadFilteredPage}
              overscan={400}
              itemContent={(index, track) => {
                const effectiveLikeStatus = likeOverridesRef.current[track.id] ?? track.likeStatus;
                return (
                  <div className={styles.queueItemWrapper}>
                    <QueueItem
                      key={track.id}
                      id={track.id}
                      index={index}
                      title={track.title}
                      artists={track.artists}
                      artistIds={track.artistIds}
                      thumbUrl={track.thumbUrl}
                      duration={track.duration}
                      likeStatus={effectiveLikeStatus}
                      isActive={activeTrackId === track.id}
                      trackData={{ ...track, likeStatus: effectiveLikeStatus }}
                      onClick={() => player.playTrackList(filteredItems, index, searchQuery)}
                      onContextMenu={(e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, item: track }); }}
                      onSelectArtist={onSelectArtist}
                    />
                  </div>
                );
              }}
              components={{
                Footer: () => isLoadingMore ? (
                  <div className={styles.skeletonTrackList} style={{ padding: '0 1rem' }}>
                    {Array.from({ length: 4 }).map((_, i) => <QueueItemSkeleton key={i} />)}
                  </div>
                ) : null
              }}
            />
          )}
        </>
      )}

      {/* ── Albums filtered ───────────────────────────── */}
      {activeFilter === 'albums' && (
        <>
          {filteredItems.length === 0 && (filteredInitialLoading || isLoadingMore) ? (
            <div className={styles.albumsGrid}>
              {Array.from({ length: 12 }).map((_, i) => <AlbumCardSkeleton key={i} />)}
            </div>
          ) : (
            <div className={styles.albumsGrid}>
              {filteredItems.map(album => (
                <div
                  key={album.id}
                  className={styles.albumCardGrid}
                  onClick={() => onSelectAlbum(album.id)}
                  onContextMenu={(e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, item: { ...album, type: 'album' } }); }}
                >
                  <LazyImage src={album.thumbUrl} className={styles.albumThumbGrid} />
                  <div className={styles.albumTitle}>{album.title}</div>
                  <div className={styles.albumArtists}>
                    {(album.artists || []).map((name: string, idx: number) => (
                      <React.Fragment key={idx}>
                        <span
                          className={album.artistIds?.[idx] ? styles.songLink : ''}
                          onClick={(e) => { const aid = album.artistIds?.[idx]; if (aid) { e.stopPropagation(); onSelectArtist(aid); } }}
                        >{name}</span>
                        {idx < (album.artists || []).length - 1 && ', '}
                      </React.Fragment>
                    ))}
                  </div>
                </div>
              ))}
              {isLoadingMore && Array.from({ length: 6 }).map((_, i) => <AlbumCardSkeleton key={`sk-${i}`} />)}
              {!isLoadingMore && filterState.hasMore && filteredItems.length > 0 && (
                <button className={styles.loadMoreBtn} onClick={loadFilteredPage}>Load more</button>
              )}
            </div>
          )}
        </>
      )}

      {contextMenu && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} items={menuItems} onClose={() => setContextMenu(null)} />
      )}
    </div>
  );
};
