import React, { useState, useEffect, useRef, useMemo, useCallback, memo, Fragment } from 'react';
import { useQuery, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import { TableVirtuoso } from 'react-virtuoso';
import { 
  getArtistDetail, 
  getArtistSongs, 
  getAlbum, 
  subscribeArtist, 
  unsubscribeArtist,
  getContinuation,
  YTMTrack 
} from '../../api/yt';
import { TrackRow } from '../molecules/TrackRow';
import { MediaCard } from '../molecules/MediaCard';
import { Carousel } from '../molecules/Carousel';
import { Skeleton } from '../atoms/Skeleton';
import { TrackRowSkeleton } from '../molecules/TrackRowSkeleton';
import { LazyImage } from '../atoms/LazyImage';
import { player } from '../../api/player';
import { 
  ChevronRight, ArrowLeft,
  Users, Loader2, Check, Plus, Eye, Headphones, CheckCircle,
  Music, Clock
} from 'lucide-react';
import styles from './ArtistView.module.css';
import trackStyles from '../molecules/TrackRow.module.css';
import { TrackContextMenu, TrackContextMenuHandle } from './TrackContextMenu';

const AllSongsColumnGroup = memo(() => (
  <colgroup>
    <col style={{ width: 48 }} />
    <col />
    <col style={{ width: '30%', maxWidth: 250 }} />
    <col style={{ width: 110 }} />
  </colgroup>
));

const AllSongsTable = React.forwardRef<HTMLTableElement, any>((props, ref) => (
  <table 
    {...props} 
    ref={ref} 
    className={styles.trackList} 
    style={{ ...props.style, tableLayout: 'fixed', borderCollapse: 'collapse', width: '100%' }}
  >
    <AllSongsColumnGroup />
    {props.children}
  </table>
));

const AllSongsTableRow = React.forwardRef<HTMLTableRowElement, any>((props, ref) => {
  const { item, ...rest } = props;
  return <tr {...rest} ref={ref} className={trackStyles.row} />;
});
AllSongsTableRow.displayName = 'AllSongsTableRow';


import { isSoundCloudId, getSoundCloudArtist } from '../../api/soundcloud';

interface ArtistViewProps {
  artistId: string;
  onSelectArtist: (id: string) => void;
  onSelectAlbum: (id: string) => void;
  onSelectPlaylist: (id: string, title: string) => void;
  onViewModeChange?: (mode: ViewMode) => void;
}

type ViewMode = 'main' | 'all-songs' | 'discography';

export const ArtistView = React.memo<ArtistViewProps>(({ 
  artistId, 
  onSelectArtist,
  onSelectAlbum,
  onSelectPlaylist,
  onViewModeChange
}) => {
  const queryClient = useQueryClient();
  const [viewMode, setViewMode] = useState<ViewMode>('main');
  const [discoCategory, setDiscoCategory] = useState<'Album' | 'Single'>('Album');
  const [isBioExpanded, setIsBioExpanded] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const trackMenuRef = useRef<TrackContextMenuHandle>(null);

  const handleContextMenu = useCallback((e: React.MouseEvent, track: YTMTrack) => {
    e.preventDefault();
    trackMenuRef.current?.open(e, track);
  }, []);

  const isSoundCloudArtist = isSoundCloudId(artistId);

  // Wrapped setViewMode that also notifies parent about view mode changes
  const setViewModeWithNotification = useCallback((mode: ViewMode) => {
    setViewMode(mode);
    onViewModeChange?.(mode);
  }, [onViewModeChange]);

  // Close modal with exit animation
  const closeModal = useCallback(() => {
    setIsClosing(true);
    setTimeout(() => {
      setViewModeWithNotification('main');
      setIsClosing(false);
    }, 200);
  }, [setViewModeWithNotification]);

  // Notify parent on mount that we're in main mode (restores global back button)
  useEffect(() => {
    onViewModeChange?.('main');
  }, []);

  const isModalOpen = viewMode === 'all-songs' || viewMode === 'discography';

  // Lock parent scroll when modal is open
  useEffect(() => {
    if (isModalOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [isModalOpen]);



  // 1. Fetch Basic Artist Details (Fast). Для SC-артиста — минимальный detail (имя, аватар, треки).
  const { data: detail, isLoading } = useQuery({
    queryKey: ['artist', artistId],
    queryFn: async () => {
      if (isSoundCloudArtist) {
        const sc = await getSoundCloudArtist(artistId);
        if (!sc) return null;
        return {
          name: sc.name,
          thumbUrl: sc.thumbUrl,
          artistPro: sc.artistPro,
          verified: sc.verified,
          description: sc.description,
          followersCount: sc.followersCount,
          tracksCount: sc.tracksCount,
          topSongs: sc.popular,
          allTracks: sc.tracks,
          scAlbums: sc.albums,
          scPlaylists: sc.playlists,
          related: sc.related,
          isSoundCloud: true,
        } as any;
      }
      return getArtistDetail(artistId);
    },
    staleTime: 1000 * 60 * 10,
  });

  // 2. Background Fetch Full Discography (Albums + Singles)
  const { data: fullAlbums = [] } = useQuery({
    queryKey: ['artist-albums', detail?.albumsId, detail?.albumsParams],
    queryFn: async () => {
      const res = await getArtistSongs(detail!.albumsId!, detail!.albumsParams);
      return res.tracks.map(item => ({ ...item, category: 'Album' }));
    },
    enabled: !!detail?.albumsId,
  });

  const { data: fullSingles = [] } = useQuery({
    queryKey: ['artist-albums-singles', detail?.singlesId, detail?.singlesParams],
    queryFn: async () => {
      const res = await getArtistSongs(detail!.singlesId!, detail!.singlesParams);
      return res.tracks.map(item => ({ ...item, category: 'Single' }));
    },
    enabled: !!detail?.singlesId,
  });

  // 3. Background Fetch Full Videos
  const { data: fullVideos = [] } = useQuery({
    queryKey: ['artist-videos-full', detail?.videosId],
    queryFn: async () => {
      const res = await getArtistSongs(detail!.videosId!);
      return res.tracks;
    },
    enabled: !!detail?.videosId,
  });

  // Combine for UI
  const discography = useMemo(() => {
    if (!detail) return [];
    const albums = fullAlbums.length > 0 ? fullAlbums : (detail.albumsPreview || []);
    const singles = fullSingles.length > 0 ? fullSingles : (detail.singlesPreview || []);
    
    return [...albums, ...singles].sort((a, b) => {
      const yearA = parseInt(a.year?.replace(/\D/g, '') || '0');
      const yearB = parseInt(b.year?.replace(/\D/g, '') || '0');
      return yearB - yearA;
    });
  }, [detail, fullAlbums, fullSingles]);

  // Auto-switch to Singles/EPs on first open if no albums
  const hasCheckedDiscoRef = useRef(false);
  useEffect(() => {
    if (viewMode === 'discography' && !hasCheckedDiscoRef.current && discography.length > 0) {
      hasCheckedDiscoRef.current = true;
      const hasAlbums = discography.some(item => item.category === 'Album');
      const hasSingles = discography.some(item => item.category === 'Single');
      if (!hasAlbums && hasSingles) {
        setDiscoCategory('Single');
      }
    }
    if (viewMode !== 'discography') {
      hasCheckedDiscoRef.current = false;
    }
  }, [viewMode, discography]);

  const videos = useMemo(() => {
    if (!detail) return [];
    return fullVideos.length > 0 ? fullVideos : (detail.videosPreview || []);
  }, [detail, fullVideos]);

  const playlists = useMemo(() => {
    if (!detail) return [];
    return detail.playlistsPreview || [];
  }, [detail]);

  const related = useMemo(() => {
    if (!detail) return [];
    return detail.related || [];
  }, [detail]);

  // Handlers
  const handleSeeAllSongs = useCallback(() => {
    setViewModeWithNotification('all-songs');
  }, []);

  const handleToggleSubscribe = useCallback(async () => {
    if (!detail || !detail.channelId) return;
    try {
      const success = detail.subscribed 
        ? await unsubscribeArtist(detail.channelId)
        : await subscribeArtist(detail.channelId);
      
      if (success) {
        queryClient.setQueryData(['artist', artistId], {
          ...detail,
          subscribed: !detail.subscribed
        });
      }
    } catch (e) { console.error(e); }
  }, [detail, artistId, queryClient]);

  // Infinite Fetch All Songs
  const { 
    data: allSongsPages, 
    isLoading: isSongsInitialLoadingYT,
    isFetching: isSongsFetching,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage
  } = useInfiniteQuery({
    queryKey: ['artist-songs-infinite', detail?.seeAllSongsId, detail?.seeAllSongsParams],
    queryFn: async ({ pageParam }) => {
      if (pageParam) {
        return getContinuation(pageParam);
      }
      return getArtistSongs(detail!.seeAllSongsId!, detail!.seeAllSongsParams);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.continuation,
    enabled: viewMode === 'all-songs' && !!detail?.seeAllSongsId,
  });

  // Для SC артистов загрузка не нужна — все треки уже есть
  const isSongsInitialLoading = detail?.isSoundCloud ? false : isSongsInitialLoadingYT;

  const allSongs = useMemo(() => {
    // Для SC артистов — все треки из detail.allTracks
    if (detail?.isSoundCloud && detail?.allTracks) {
      return detail.allTracks;
    }
    const fetchedSongs = allSongsPages?.pages.flatMap(page => page.tracks) || [];
    // Если мы только зашли в режим See All и данных еще нет, показываем topSongs из превью
    if (fetchedSongs.length === 0 && detail?.topSongs) {
      return detail.topSongs;
    }
    return fetchedSongs;
  }, [allSongsPages, detail]);

  // UI State
  const [activeTrackId, setActiveTrackId] = useState<string | undefined>(player.currentTrack?.id);
  const [isPlaying, setIsPlaying] = useState<boolean>(player.isPlaying);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    return player.subscribe((event) => {
      if (event === 'tick') return;
      setActiveTrackId(player.currentTrack?.id);
      setIsPlaying(player.isPlaying);
    });
  }, []);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTo({ top: 0, behavior: 'instant' });
    }
  }, [viewMode, discoCategory]);

  useEffect(() => {
    setViewModeWithNotification('main');
    setIsBioExpanded(false);
  }, [artistId]);

  if (isLoading) {
    return (
      <div className={styles.container}>
        <header className={styles.header}><Skeleton width="100%" height={300} borderRadius={24} /></header>
        <section className={styles.section}>
          <Skeleton width={150} height={32} borderRadius={4} style={{ marginBottom: '1.5rem' }} />
          <table className={styles.trackList}>
            <tbody>{Array.from({ length: 5 }).map((_, i) => <TrackRowSkeleton key={i} index={i} />)}</tbody>
          </table>
        </section>
      </div>
    );
  }

  if (!detail) return <div className={styles.container}>Artist not found.</div>;

  return (
    <div className={`${styles.container} ${isModalOpen ? styles.scrollLocked : ''}`} ref={containerRef} data-artist-view>
      <header className={styles.header}>
        <div className={styles.bannerWrapper}>
          <LazyImage src={detail.thumbUrl} alt={detail.name} className={styles.bannerImage} />
          <div className={styles.bannerOverlay}>
              <div>
                <div className={styles.badgesRow}>
                  {detail.artistPro && <span className="pro-badge pro-badge--lg" data-tooltip="Artist PRO"><span>★</span></span>}
                  {detail.verified && <CheckCircle size={32} className={`verified-badge-lg ${styles.verifiedBadge}`} data-tooltip="Verified" />}
                </div>
                <h1 className={styles.name}>{detail.name}</h1>
              <div className={styles.stats}>
                {detail.monthlyListeners && <div className={styles.statItem}><Headphones size={16} /><span>{detail.monthlyListeners} monthly listeners</span></div>}
                {detail.subscribers && <div className={styles.statItem}><Users size={16} /><span>{detail.subscribers} subscribers</span></div>}
                {detail.isSoundCloud && detail.followersCount > 0 && <div className={styles.statItem}><Users size={16} /><span>{detail.followersCount.toLocaleString()} followers</span></div>}
                {detail.isSoundCloud && detail.tracksCount > 0 && <div className={styles.statItem}><span>{detail.tracksCount} tracks</span></div>}
                {detail.views && <div className={styles.statItem}><Eye size={16} /><span>{detail.views} total views</span></div>}
              </div>
              {!detail.isSoundCloud && (
                <div className={styles.headerActions}>
                  <button className={`${styles.subscribeBtn} ${detail.subscribed ? styles.subscribed : ''}`} onClick={handleToggleSubscribe}>
                    {detail.subscribed ? <><Check size={18} /> Subscribed</> : <><Plus size={18} /> Subscribe</>}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      {detail.topSongs?.length > 0 && (
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>Top Songs</h2>
            {detail.isSoundCloud && detail.allTracks?.length > detail.topSongs?.length && (
              <button className={styles.seeAllBtn} onClick={() => setViewModeWithNotification('all-songs')}>See all <ChevronRight size={16} /></button>
            )}
            {detail.seeAllSongsId && <button className={styles.seeAllBtn} onClick={handleSeeAllSongs}>See all <ChevronRight size={16} /></button>}
          </div>
          <table className={styles.trackList}>
            <tbody>{detail.topSongs.map((track: YTMTrack, i: number) => (
              <TrackRow 
                key={track.id} 
                index={i + 1} 
                {...track} 
                isActive={activeTrackId === track.id} 
                isPlaying={isPlaying} 
                onSelectArtist={onSelectArtist} 
                onSelectAlbum={onSelectAlbum} 
                onClick={() => detail.isSoundCloud
                  ? player.playTrackList(detail.topSongs, i, 'sc-artist-' + artistId)
                  : player.playSingle(track)}
                onContextMenu={(e) => handleContextMenu(e, track)}
              />
            ))}</tbody>
          </table>
        </section>
      )}

      {/* SC: Альбомы */}
      {detail.isSoundCloud && detail.scAlbums?.length > 0 && (
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>Albums</h2>
          </div>
          <Carousel 
            items={detail.scAlbums}
            renderItem={(item) => (
              <MediaCard 
                key={item.id} 
                {...item} 
                onClick={() => onSelectAlbum(item.id)} 
              />
            )}
          />
        </section>
      )}

      {/* SC: Плейлисты */}
      {detail.isSoundCloud && detail.scPlaylists?.length > 0 && (
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>Playlists</h2>
          </div>
          <Carousel 
            items={detail.scPlaylists.map((p: any) => ({ id: p.url, title: p.title, thumbUrl: p.thumbUrl, artists: [detail.name] }))}
            renderItem={(item) => (
              <MediaCard 
                key={item.id} 
                {...item} 
                onClick={() => onSelectPlaylist(item.id, item.title)} 
              />
            )}
          />
        </section>
      )}

      {discography.length > 0 && (
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>Discography</h2>
            <button className={styles.seeAllBtn} onClick={() => { setViewModeWithNotification('discography'); setDiscoCategory('Album'); }}>See All <ChevronRight size={16} /></button>
          </div>
          <Carousel 
            items={discography}
            renderItem={(item) => (
              <MediaCard 
                key={item.id} 
                {...item} 
                onClick={() => onSelectAlbum(item.id)} 
                onPlayClick={async () => {
                  const albumData = await getAlbum(item.id);
                  if (albumData?.tracks?.length) player.playTrackList(albumData.tracks, 0, item.id);
                }}
              />
            )}
          />
        </section>
      )}

      {videos.length > 0 && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Videos</h2>
          <Carousel 
            items={videos}
            renderItem={(video) => (
              <MediaCard 
                key={video.id} 
                {...video} 
                type="video" 
                onClick={() => player.playSingle({ id: video.id, title: video.title, thumbUrl: video.thumbUrl, duration: '' } as any)} 
              />
            )}
          />
        </section>
      )}

      {playlists.length > 0 && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Playlists</h2>
          <Carousel 
            items={playlists}
            renderItem={(p) => (
              <MediaCard 
                key={p.id} 
                {...p} 
                type="playlist" 
                onClick={() => onSelectPlaylist(p.id, p.title)} 
              />
            )}
          />
        </section>
      )}

      {related.length > 0 && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Related</h2>
          <Carousel 
            items={related}
            renderItem={(artist) => (
              <MediaCard 
                key={artist.id} 
                id={artist.id} 
                title={artist.name} 
                thumbUrl={artist.thumbUrl} 
                type="artist" 
                description={artist.subscribers ? `${artist.subscribers} subscribers` : undefined} 
                onClick={() => onSelectArtist(artist.id)} 
              />
            )}
          />
        </section>
      )}

      {/* SC: Описание (после Related) */}
      {detail.isSoundCloud && detail.description && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>About</h2>
          <div className={styles.bioContainer}>
            <p className={`${styles.bio} ${isBioExpanded ? styles.expanded : ''}`}>{detail.description}</p>
            {detail.description.length > 200 && (
              <button className={styles.expandBtn} onClick={() => setIsBioExpanded(!isBioExpanded)}>
                {isBioExpanded ? 'Show less' : 'Read more'}
              </button>
            )}
          </div>
        </section>
      )}

      {!detail.isSoundCloud && detail.description && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>About</h2>
          <div className={styles.bioContainer}>
            <p className={`${styles.bio} ${isBioExpanded ? styles.expanded : ''}`}>{detail.description}</p>
            {detail.description.length > 200 && <button className={styles.expandBtn} onClick={() => setIsBioExpanded(!isBioExpanded)}>{isBioExpanded ? 'Show less' : 'Read more...'}</button>}
          </div>
        </section>
      )}
      <TrackContextMenu ref={trackMenuRef} />

      {/* All Songs Modal */}
      {viewMode === 'all-songs' && (
        <div className={`${styles.allSongsView} ${isClosing ? styles.closing : ''}`}>
          <button className={styles.allSongsBackBtn} onClick={closeModal}>
            <ArrowLeft size={22} />
          </button>
          <header className={styles.allSongsHeader}>
            <h1 className={styles.allSongsTitle}>All Songs</h1>
            <div className={styles.allSongsArtistInfo}>
              {detail.thumbUrl && (
                <img src={detail.thumbUrl} alt={detail.name} className={styles.allSongsArtistAvatar} />
              )}
              <span className={styles.allSongsArtistName}>{detail.name}</span>
              <span className={styles.allSongsTrackCount}>
                {isSongsInitialLoading ? (
                  <Loader2 size={12} className={styles.trackCountSpinner} />
                ) : null}
                {isSongsInitialLoading ? 'Loading...' : `${allSongs.length} tracks`}
              </span>
            </div>
          </header>
          <div className={styles.allSongsContent}>
            {isSongsInitialLoading ? (
              <div className={styles.allSongsTrackList}>
                <table className={styles.trackList} style={{ tableLayout: 'fixed' }}>
                  <AllSongsColumnGroup />
                  <thead>
                    <tr className={styles.tableHeaderRow}>
                      <th style={{ textAlign: 'center' }}>#</th>
                      <th>Title</th>
                      <th>Album</th>
                      <th style={{ textAlign: 'right', paddingRight: 24 }}>
                        <Clock size={14} style={{ opacity: 0.5 }} />
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {Array.from({ length: 15 }).map((_, i) => (
                      <TrackRowSkeleton key={`skeleton-${i}`} index={i} />
                    ))}
                  </tbody>
                </table>
              </div>
            ) : allSongs.length === 0 ? (
              <div className={styles.allSongsEmpty}>
                <Music size={64} className={styles.allSongsEmptyIcon} />
                <div className={styles.allSongsEmptyText}>No songs found</div>
                <div className={styles.allSongsEmptyHint}>This artist doesn't have any tracks yet</div>
              </div>
            ) : (
              <div className={styles.virtuosoWrapper}>
                <TableVirtuoso
                  style={{ height: '100%' }}
                  data={allSongs}
                  overscan={400}
                  increaseViewportBy={500}
                  fixedItemHeight={56}
                  endReached={() => { if (hasNextPage && !isFetchingNextPage) fetchNextPage(); }}
                  computeItemKey={(index, track) => track.id || index}
                  fixedHeaderContent={() => (
                    <tr className={styles.tableHeaderRow}>
                      <th style={{ textAlign: 'center' }}>#</th>
                      <th>Title</th>
                      <th>Album</th>
                      <th style={{ textAlign: 'right', paddingRight: 24 }}>
                        <Clock size={14} style={{ opacity: 0.5 }} />
                      </th>
                    </tr>
                  )}
                  components={{
                    Table: AllSongsTable,
                    TableRow: AllSongsTableRow,
                  }}
                  itemContent={(index, song) => (
                    <TrackRow
                      index={index + 1}
                      {...song}
                      isActive={activeTrackId === song.id}
                      isPlaying={isPlaying}
                      onSelectArtist={onSelectArtist}
                      onSelectAlbum={onSelectAlbum}
                      onClick={() => player.playTrackList(allSongs, index)}
                      onContextMenu={(e) => handleContextMenu(e, song)}
                      renderOnlyCells
                    />
                  )}
                />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Discography Modal */}
      {viewMode === 'discography' && (() => {
        const items = discography.filter(item => item.category === discoCategory);
        const isLoading = fullAlbums.length === 0 && fullSingles.length === 0 && (!!detail?.albumsId || !!detail?.singlesId);
        return (
          <div className={`${styles.allSongsView} ${isClosing ? styles.closing : ''}`}>
            <button className={styles.allSongsBackBtn} onClick={closeModal}>
              <ArrowLeft size={22} />
            </button>
            <header className={styles.discoHeader}>
              <div className={styles.viewSwitcher}>
                <button className={`${styles.viewTab} ${discoCategory === 'Album' ? styles.active : ''}`} onClick={() => setDiscoCategory('Album')}>Albums</button>
                <button className={`${styles.viewTab} ${discoCategory === 'Single' ? styles.active : ''}`} onClick={() => setDiscoCategory('Single')}>Singles & EPs</button>
              </div>
            </header>
            <div className={styles.allSongsContent}>
              {isLoading ? (
                <div className={styles.discoLoadingGrid}>
                  {Array.from({ length: 8 }).map((_, i) => (
                    <div key={i} className={styles.discoSkeletonCard}>
                      <div className={styles.discoSkeletonArt} />
                      <div className={styles.discoSkeletonText} />
                      <div className={styles.discoSkeletonTextShort} />
                    </div>
                  ))}
                </div>
              ) : items.length === 0 ? (
                <div className={styles.allSongsEmpty}>
                  <Music size={64} className={styles.allSongsEmptyIcon} />
                  <div className={styles.allSongsEmptyText}>No releases found</div>
                </div>
              ) : (
                <div className={styles.discoGrid}>
                  {items.map(item => (
                    <MediaCard key={item.id} {...item} onClick={() => onSelectAlbum(item.id)} onPlayClick={async () => {
                      const albumData = await getAlbum(item.id);
                      if (albumData?.tracks?.length) player.playTrackList(albumData.tracks, 0, item.id);
                    }} />
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })()}
    </div>
  );
});
