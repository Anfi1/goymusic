import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { TableVirtuoso } from 'react-virtuoso';
import { useQuery, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
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
  Users, Loader2, Check, Plus, Eye, Headphones
} from 'lucide-react';
import styles from './ArtistView.module.css';
import trackStyles from '../molecules/TrackRow.module.css';
import { TrackContextMenu, TrackContextMenuHandle } from './TrackContextMenu';

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
  const trackMenuRef = useRef<TrackContextMenuHandle>(null);

  const handleContextMenu = useCallback((e: React.MouseEvent, track: YTMTrack) => {
    e.preventDefault();
    trackMenuRef.current?.open(e, track);
  }, []);

  // 1. Fetch Basic Artist Details (Fast)
  const { data: detail, isLoading } = useQuery({
    queryKey: ['artist', artistId],
    queryFn: () => getArtistDetail(artistId),
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
    if (detail?.seeAllSongsId) setViewMode('all-songs');
  }, [detail?.seeAllSongsId]);

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
    isLoading: isSongsInitialLoading,
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

  const allSongs = useMemo(() => {
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
    setViewMode('main');
    setIsBioExpanded(false);
  }, [artistId]);

  const renderTableHead = useCallback(() => (
    <tr className={styles.tableHeader}>
      <th>#</th><th>Title</th><th>Album</th><th>Time</th>
    </tr>
  ), []);

  // Virtuoso Components for Table structure
  const TableComponents = useMemo(() => ({
    Table: (props: any) => <table {...props} className={styles.trackList} />,
    TableHead: React.forwardRef<HTMLTableSectionElement>((props, ref) => (
      <thead {...props} ref={ref} className={styles.tableHeader} />
    )),
    TableRow: (props: any) => {
      const index = props['data-index'];
      const song = allSongs[index];
      const isActive = activeTrackId === song?.id;
      return (
        <tr 
          {...props} 
          className={`${trackStyles.row} ${isActive ? trackStyles.active : ''} ${song?.isAvailable === false ? trackStyles.unavailable : ''}`}
          onClick={() => song?.isAvailable !== false && player.playTrackList(allSongs, index, `artist-songs-${artistId}`)}
          onContextMenu={(e) => song && handleContextMenu(e, song)}
        />
      );
    },
    TableBody: React.forwardRef<HTMLTableSectionElement>((props, ref) => <tbody {...props} ref={ref} />),
  }), [allSongs, activeTrackId, artistId, handleContextMenu]);

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

  if (viewMode === 'all-songs') {
    return (
      <div className={styles.container} style={{ padding: 0, gap: 0 }}>
        <header className={styles.viewHeader} style={{ padding: '2rem 2rem 1rem 2rem' }}>
          <button className={styles.backBtn} onClick={() => setViewMode('main')}><ArrowLeft size={24} /></button>
          <h1 className={styles.viewTitle}>Top Songs</h1>
          {(isSongsInitialLoading || (isSongsFetching && !isFetchingNextPage)) && <Loader2 className="animate-spin" size={20} style={{ marginLeft: '1rem', opacity: 0.5 }} />}
        </header>
        <div style={{ flex: 1, position: 'relative' }}>
          {isSongsInitialLoading ? (
            <div style={{ padding: '0 2rem' }}>
              <table className={styles.trackList}>
                <tbody>{Array.from({ length: 15 }).map((_, i) => <TrackRowSkeleton key={i} index={i} />)}</tbody>
              </table>
            </div>
          ) : (
            <TableVirtuoso
              style={{ height: '100%' }}
              data={allSongs}
              fixedHeaderContent={renderTableHead}
              increaseViewportBy={400}
              endReached={() => {
                if (hasNextPage && !isFetchingNextPage) {
                  fetchNextPage();
                }
              }}
              itemContent={(index, song) => (
                <TrackRow 
                  index={index + 1} {...song}
                  isActive={activeTrackId === song.id}
                  isPlaying={isPlaying} 
                  renderOnlyCells={true}
                  onSelectArtist={onSelectArtist} 
                  onSelectAlbum={onSelectAlbum}
                  onContextMenu={(e) => handleContextMenu(e, song)}
                />
              )}
              components={{
                ...TableComponents,
                TableFoot: () => isFetchingNextPage ? (
                  <div style={{ padding: '2rem', display: 'flex', justifyContent: 'center' }}>
                    <Loader2 className="animate-spin" size={24} />
                  </div>
                ) : null
              }}
            />
          )}
        </div>
        <TrackContextMenu ref={trackMenuRef} />
      </div>
    );
  }

  if (viewMode === 'discography') {
    const items = discography.filter(item => item.category === discoCategory);
    return (
      <div className={styles.container} ref={containerRef}>
        <header className={styles.viewHeader}>
          <button className={styles.backBtn} onClick={() => setViewMode('main')}><ArrowLeft size={24} /></button>
          <div className={styles.viewSwitcher}>
            <button className={`${styles.viewTab} ${discoCategory === 'Album' ? styles.active : ''}`} onClick={() => setDiscoCategory('Album')}>Albums</button>
            <button className={`${styles.viewTab} ${discoCategory === 'Single' ? styles.active : ''}`} onClick={() => setDiscoCategory('Single')}>Singles & EPs</button>
          </div>
        </header>
        <div className={styles.grid}>
          {items.map(item => (
            <MediaCard key={item.id} {...item} onClick={() => onSelectAlbum(item.id)} onPlayClick={async () => {
              const albumData = await getAlbum(item.id);
              if (albumData?.tracks?.length) player.playTrackList(albumData.tracks, 0, item.id);
            }} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.container} ref={containerRef}>
      <header className={styles.header}>
        <div className={styles.bannerWrapper}>
          <LazyImage src={detail.thumbUrl} alt={detail.name} className={styles.bannerImage} />
          <div className={styles.bannerOverlay}>
            <div>
              <h1 className={styles.name}>{detail.name}</h1>
              <div className={styles.stats}>
                {detail.monthlyListeners && <div className={styles.statItem}><Headphones size={16} /><span>{detail.monthlyListeners} monthly listeners</span></div>}
                {detail.subscribers && <div className={styles.statItem}><Users size={16} /><span>{detail.subscribers} subscribers</span></div>}
                {detail.views && <div className={styles.statItem}><Eye size={16} /><span>{detail.views} total views</span></div>}
              </div>
              <div className={styles.headerActions}>
                <button className={`${styles.subscribeBtn} ${detail.subscribed ? styles.subscribed : ''}`} onClick={handleToggleSubscribe}>
                  {detail.subscribed ? <><Check size={18} /> Subscribed</> : <><Plus size={18} /> Subscribe</>}
                </button>
              </div>
            </div>
          </div>
        </div>
      </header>

      {detail.topSongs?.length > 0 && (
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>Top Songs</h2>
            {detail.seeAllSongsId && <button className={styles.seeAllBtn} onClick={handleSeeAllSongs}>See all <ChevronRight size={16} /></button>}
          </div>
          <table className={styles.trackList}>
            <tbody>{detail.topSongs.map((track, i) => (
              <TrackRow 
                key={track.id} 
                index={i + 1} 
                {...track} 
                isActive={activeTrackId === track.id} 
                isPlaying={isPlaying} 
                onSelectArtist={onSelectArtist} 
                onSelectAlbum={onSelectAlbum} 
                onClick={() => player.playSingle(track)} 
                onContextMenu={(e) => handleContextMenu(e, track)}
              />
            ))}</tbody>
          </table>
        </section>
      )}

      {discography.length > 0 && (
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>Discography</h2>
            <button className={styles.seeAllBtn} onClick={() => { setViewMode('discography'); setDiscoCategory('Album'); }}>See All <ChevronRight size={16} /></button>
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

      {detail.description && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>About</h2>
          <div className={styles.bioContainer}>
            <p className={`${styles.bio} ${isBioExpanded ? styles.expanded : ''}`}>{detail.description}</p>
            {detail.description.length > 200 && <button className={styles.expandBtn} onClick={() => setIsBioExpanded(!isBioExpanded)}>{isBioExpanded ? 'Show less' : 'Read more...'}</button>}
          </div>
        </section>
      )}
      <TrackContextMenu ref={trackMenuRef} />
    </div>
  );
});
