import React, { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import { TableVirtuoso } from 'react-virtuoso';
import { 
  getArtistDetail, 
  getArtistSongs, 
  getAlbum, 
  subscribeArtist, 
  unsubscribeArtist,
  getContinuation,
  type YTMChannelDetail,
  YTMTrack 
} from '../../api/yt';
import { TrackRow, TrackColumnGroup } from '../molecules/TrackRow';
import { MediaCard } from '../molecules/MediaCard';
import { Carousel } from '../molecules/Carousel';
import { Skeleton } from '../atoms/Skeleton';
import { TrackRowSkeleton } from '../molecules/TrackRowSkeleton';
import { LazyImage } from '../atoms/LazyImage';
import { player } from '../../api/player';
import { 
  ChevronRight, ChevronDown, ArrowLeft, Heart,
  Users, Loader2, Check, Plus, Eye, Headphones, CheckCircle,
  Music, Clock, Play, Shuffle
} from 'lucide-react';
import styles from './ArtistView.module.css';
import trackStyles from '../molecules/TrackRow.module.css';
import { TrackContextMenu, TrackContextMenuHandle } from './TrackContextMenu';
import { likedStore } from '../../api/likedStore';
import { SourceBadge } from '../atoms/SourceBadge';
import { formatStatValue } from '../../utils/formatStatValue';
import { isDeckLayout, subscribeDesktopLayout } from '../../utils/desktopLayout';

function extractDominantColor(url: string): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) { resolve('rgba(0,0,0,0.5)'); return; }
      canvas.width = 1;
      canvas.height = 1;
      ctx.drawImage(img, 0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      resolve(`rgba(${r}, ${g}, ${b}, 0.6)`);
    };
    img.onerror = () => resolve('rgba(0,0,0,0.5)');
    img.src = url;
  });
}

const AllSongsTable = React.forwardRef<HTMLTableElement, any>((props, ref) => (
  <table 
    {...props} 
    ref={ref} 
    className={styles.trackList} 
    style={{ ...props.style, tableLayout: 'fixed', borderCollapse: 'collapse', width: '100%' }}
  >
    <TrackColumnGroup />
    {props.children}
  </table>
));

const AllSongsTableRow = React.forwardRef<HTMLTableRowElement, any>((props, ref) => {
  const { item, context, ...rest } = props;
  const index = props['data-index'];
  return (
    <tr 
      {...rest} 
      ref={ref} 
      className={trackStyles.row} 
      aria-current={item?.id && item.id === context?.activeTrackId ? 'true' : undefined}
      onClick={() => context?.onPlay?.(index)}
      onContextMenu={(e) => { e.preventDefault(); context?.onContextMenu?.(e, item); }}
      style={{ ...rest.style, cursor: 'pointer' }}
    />
  );
});
AllSongsTableRow.displayName = 'AllSongsTableRow';


import { isSoundCloudId, getSoundCloudArtist } from '../../api/soundcloud';
import { isYandexArtistId, getYandexArtist, getYandexAlbumTracks } from '../../api/yandex';

interface ArtistViewProps {
  artistId: string;
  onSelectArtist: (id: string) => void;
  onSelectAlbum: (id: string) => void;
  onSelectPlaylist: (id: string, title: string) => void;
  onSheetBackChange: (back: (() => void) | null) => void;
}

type ViewMode = 'main' | 'all-songs' | 'discography' | 'all-videos';

export const ArtistView = React.memo<ArtistViewProps>(({ 
  artistId, 
  onSelectArtist,
  onSelectAlbum,
  onSelectPlaylist,
  onSheetBackChange
}) => {
  const queryClient = useQueryClient();
  const isDeck = useSyncExternalStore(subscribeDesktopLayout, isDeckLayout);
  const SheetBackIcon = isDeck ? ChevronDown : ArrowLeft;
  const [viewMode, setViewMode] = useState<ViewMode>('main');
  const [discoCategory, setDiscoCategory] = useState<'Album' | 'Single'>('Album');
  const [isBioExpanded, setIsBioExpanded] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [shadowColor, setShadowColor] = useState('rgba(0,0,0,0.5)');
  const [likesOnly, setLikesOnly] = useState(false);
  const [likedIds, setLikedIds] = useState<Set<string>>(() => new Set());
  const trackMenuRef = useRef<TrackContextMenuHandle>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const sheetBackRef = useRef<HTMLButtonElement>(null);
  const sheetOpener = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    let mounted = true;
    likedStore.getAllTracks().then(entries => {
      if (mounted) {
        setLikedIds(new Set(entries.map(e => e.trackId)));
      }
    });
    const handleLikeUpdate = (e: any) => {
      if (e.detail?.id && e.detail?.status === 'success') {
        const { id, likeStatus } = e.detail;
        setLikedIds(prev => {
          const next = new Set(prev);
          if (likeStatus === 'LIKE') next.add(id);
          else next.delete(id);
          return next;
        });
      }
    };
    window.addEventListener('track-like-updated', handleLikeUpdate as EventListener);
    return () => {
      mounted = false;
      window.removeEventListener('track-like-updated', handleLikeUpdate as EventListener);
    };
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent, track: YTMTrack) => {
    e.preventDefault();
    trackMenuRef.current?.open(e, track);
  }, []);

  const isSoundCloudArtist = isSoundCloudId(artistId);
  const isYandexArtist = isYandexArtistId(artistId);

  const isModalOpen = viewMode !== 'main';
  const openSheet = (mode: Exclude<ViewMode, 'main'>, opener: HTMLButtonElement) => {
    sheetOpener.current = opener;
    setViewMode(mode);
  };
  const closeModal = useCallback(() => {
    trackMenuRef.current?.close();
    setIsClosing(true);
  }, []);

  useLayoutEffect(() => {
    if (!isModalOpen) {
      sheetOpener.current?.focus({ preventScroll: true });
      sheetOpener.current = null;
      return;
    }
    sheetBackRef.current?.focus({ preventScroll: true });
    onSheetBackChange(closeModal);
    return () => onSheetBackChange(null);
  }, [isModalOpen, onSheetBackChange, closeModal]);

  useLayoutEffect(() => {
    if (!isClosing) return;
    let active = true;
    // Wait for the actual transform, including a reversal midway through entry.
    // With reduced motion there is no transition to await.
    const transitions = sheetRef.current?.getAnimations() ?? [];
    Promise.allSettled(transitions.map(transition => transition.finished)).then(() => {
      if (!active) return;
      setViewMode('main');
      setIsClosing(false);
    });
    return () => { active = false; };
  }, [isClosing]);


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
      if (isYandexArtist) {
        const yx = await getYandexArtist(artistId);
        if (!yx) return null;
        return {
          name: yx.name,
          thumbUrl: yx.thumbUrl,
          topSongs: yx.topSongs,
          allTracks: yx.allTracks,
          monthlyListeners: yx.monthlyListeners ? String(yx.monthlyListeners) : undefined,
          playlistsPreview: yx.playlists,
          yandexAlbums: yx.albums,
          related: yx.related,
          isYandex: true,
        } as any;
      }
      return getArtistDetail(artistId);
    },
    staleTime: 1000 * 60 * 10,
  });
  const channel: YTMChannelDetail | undefined = detail?.profileType === 'channel' ? detail : undefined;

  // Extract dominant color from artist image for shadow
  useEffect(() => {
    if (detail?.thumbUrl) {
      extractDominantColor(detail.thumbUrl).then(setShadowColor);
    }
  }, [detail?.thumbUrl]);

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
    enabled: !channel && !!detail?.videosId,
  });

  const channelPages = useInfiniteQuery({
    queryKey: ['channel-videos', channel?.videosId],
    enabled: viewMode === 'all-videos' && !!channel?.videosId,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      const page = await getArtistSongs(channel!.videosId!, pageParam ?? undefined, signal);
      if (page.error) throw new Error(page.error);
      return page;
    },
    getNextPageParam: page => page.continuation,
  });
  const allChannelVideos = useMemo(() => channelPages.data?.pages.flatMap(page => page.tracks)
    ?? channel?.videosPreview ?? [], [channelPages.data, channel]);

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

  const yandexAlbumsMain = useMemo(() => {
    if (!detail?.isYandex) return [];
    return (detail.yandexAlbums || []).filter((a: any) => !a.type || (a.type !== 'single' && a.type !== 'compilation'));
  }, [detail]);

  const yandexSingles = useMemo(() => {
    if (!detail?.isYandex) return [];
    return (detail.yandexAlbums || []).filter((a: any) => a.type === 'single');
  }, [detail]);

  const yandexCompilations = useMemo(() => {
    if (!detail?.isYandex) return [];
    return (detail.yandexAlbums || []).filter((a: any) => a.type === 'compilation');
  }, [detail]);

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

  // Для SC/Yandex артистов загрузка не нужна — все треки уже есть
  const isSongsInitialLoading = (detail?.isSoundCloud || detail?.isYandex) ? false : isSongsInitialLoadingYT;

  const allSongs = useMemo(() => {
    // Для SC/Yandex артистов — все треки из detail.allTracks (уже загружены целиком)
    if ((detail?.isSoundCloud || detail?.isYandex) && detail?.allTracks) {
      return detail.allTracks;
    }
    const fetchedSongs = allSongsPages?.pages.flatMap(page => page.tracks) || [];
    // Если мы только зашли в режим See All и данных еще нет, показываем topSongs из превью
    if (fetchedSongs.length === 0 && detail?.topSongs) {
      return detail.topSongs;
    }
    return fetchedSongs;
  }, [allSongsPages, detail]);

  const displayedSongs = useMemo(() => {
    if (!likesOnly) return allSongs;
    return allSongs.filter((song: YTMTrack) => song.likeStatus === 'LIKE' || (song.id && likedIds.has(song.id)));
  }, [allSongs, likesOnly, likedIds]);

  // UI State
  const [activeTrackId, setActiveTrackId] = useState<string | undefined>(player.currentTrack?.id);
  const [isPlaying, setIsPlaying] = useState<boolean>(player.isPlaying);
  const [isTableScrolled, setIsTableScrolled] = useState(false);
  const modalContentRef = useRef<HTMLDivElement>(null);

  const virtuosoContext = useMemo(() => ({
    activeTrackId,
    onPlay: (index: number) => player.playTrackList(displayedSongs, index, artistId, 'artist'),
    onContextMenu: (e: React.MouseEvent, song: YTMTrack) => handleContextMenu(e, song)
  }), [activeTrackId, displayedSongs, artistId, handleContextMenu]);

  useEffect(() => {
    return player.subscribe((event) => {
      if (event === 'tick') return;
      setActiveTrackId(player.currentTrack?.id);
      setIsPlaying(player.isPlaying);
    });
  }, []);

  // Track scroll position in modal to darken table header
  useEffect(() => {
    const el = modalContentRef.current;
    if (!el || !isModalOpen) return;
    const handleScroll = () => setIsTableScrolled(el.scrollTop > 10);
    el.addEventListener('scroll', handleScroll);
    return () => el.removeEventListener('scroll', handleScroll);
  }, [isModalOpen]);

  if (isLoading) {
    return (
      <div className={styles.container}>
        <header className={styles.header}><Skeleton width="100%" height={250} borderRadius={12} /></header>
        <section className={styles.section}>
          <div className={styles.sectionHeader}><Skeleton width={140} height={28} /></div>
          <table className={styles.trackList}>
            {isDeck && <TrackColumnGroup />}
            <tbody>{Array.from({ length: 5 }).map((_, i) => <TrackRowSkeleton key={i} index={i} />)}</tbody>
          </table>
        </section>
      </div>
    );
  }

  if (!detail) return <div className={styles.container}>Profile not found.</div>;

  const renderChannelVideos = (tracks: YTMTrack[]) => (
    <div className={styles.grid}>
      {tracks.map((video, index) => {
        const play = () => player.playTrackList(tracks, index, artistId, 'artist');
        return <MediaCard key={video.id} id={video.id} title={video.title} thumbUrl={video.thumbUrl}
          type="video" description={video.duration} isActive={activeTrackId === video.id}
          onClick={play} onPlayClick={play} onContextMenu={e => handleContextMenu(e, video)} />;
      })}
    </div>
  );

  const overview = (
    <div className={styles.container} data-artist-view inert={isModalOpen} data-sheet-covered={(isModalOpen && !isClosing) || undefined}>
      <header className={styles.header}>
        <div className={styles.bannerWrapper} style={{ '--shadow-color': shadowColor } as React.CSSProperties}>
          <LazyImage src={detail.thumbUrl} alt="" className={styles.bannerImage} />
          <div className={styles.bannerOverlay}>
              <div>
                <div className={styles.badgesRow}>
                  {channel && <span className={styles.channelLabel}>Channel</span>}
                  {detail.artistPro && <span className="pro-badge pro-badge--lg" data-tooltip="Artist PRO"><span>★</span></span>}
                  {detail.verified && <CheckCircle size={32} className={`verified-badge-lg ${styles.verifiedBadge}`} data-tooltip="Verified" />}
                </div>
                <h1 className={styles.name}>
                  {detail.name}
                  {(detail.isSoundCloud || detail.isYandex) && (
                    <span style={{ marginLeft: 10, verticalAlign: 'middle' }}>
                      <SourceBadge source={detail.isYandex ? 'yandex' : 'soundcloud'} size={24} />
                    </span>
                  )}
                </h1>
              <div className={styles.stats}>
                {detail.monthlyListeners && <div className={styles.statItem}><Headphones size={16} /><span>{formatStatValue(detail.monthlyListeners)}</span></div>}
                {detail.subscribers && <div className={styles.statItem}><Users size={16} /><span>{formatStatValue(detail.subscribers)}</span></div>}
                {detail.isSoundCloud && detail.followersCount > 0 && <div className={styles.statItem}><Users size={16} /><span>{formatStatValue(String(detail.followersCount))}</span></div>}
                {detail.isSoundCloud && detail.tracksCount > 0 && <div className={styles.statItem}><span>{detail.tracksCount} tracks</span></div>}
                {detail.views && <div className={styles.statItem}><Eye size={16} /><span>{formatStatValue(detail.views)}</span></div>}
              </div>
              {!channel && !detail.isSoundCloud && !detail.isYandex && (
                <div className={styles.headerActions}>
                  <button className={`${styles.subscribeBtn} ${detail.subscribed ? styles.subscribed : ''}`} aria-pressed={!!detail.subscribed} onClick={handleToggleSubscribe}>
                    {detail.subscribed ? <><Check size={18} /> Subscribed</> : <><Plus size={18} /> Subscribe</>}
                  </button>
                </div>
              )}
              {!!channel?.videosPreview.length && (
                <div className={styles.headerActions}>
                  <button className={styles.subscribeBtn} onClick={() => player.playTrackList(channel.videosPreview, 0, artistId, 'artist')}>
                    <Play size={18} /> Play
                  </button>
                </div>
              )}
              {detail.isYandex && (
                <div className={styles.headerActions}>
                  <button className={styles.subscribeBtn} onClick={() => player.playTrackList(detail.topSongs, 0, 'yandex-artist-' + artistId)}>
                    <Play size={18} /> Play
                  </button>
                  <button className={styles.subscribeBtn} onClick={() => { const shuffled = [...detail.topSongs].sort(() => Math.random() - 0.5); player.playTrackList(shuffled, 0, 'yandex-artist-' + artistId); }}>
                    <Shuffle size={18} /> Shuffle
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      {channel && (
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>Videos</h2>
            {channel.videosId && <button className={styles.seeAllBtn} onClick={e => openSheet('all-videos', e.currentTarget)}>
              See all <ChevronRight size={16} />
            </button>}
          </div>
          {channel.videosPreview.length ? renderChannelVideos(channel.videosPreview)
            : <p className={styles.allSongsEmptyHint}>{channel.videosId ? 'Open the full list to browse uploads.' : 'No public videos available.'}</p>}
        </section>
      )}

      {!channel && detail.topSongs?.length > 0 && (
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>Top Songs</h2>
            {(detail.seeAllSongsId || ((detail.isSoundCloud || detail.isYandex) && detail.allTracks?.length > detail.topSongs?.length)) && (
              <button className={styles.seeAllBtn} onClick={e => openSheet('all-songs', e.currentTarget)}>See all <ChevronRight size={16} /></button>
            )}
          </div>
          <table className={styles.trackList}>
            <TrackColumnGroup />
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
                  : detail.isYandex
                  ? player.playTrackList(detail.topSongs, i, 'yandex-artist-' + artistId)
                  : player.playTrackList(detail.topSongs, i, artistId, 'artist')}
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

      {/* Yandex: Альбомы */}
      {detail.isYandex && yandexAlbumsMain.length > 0 && (
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>Albums</h2>
          </div>
          <Carousel
            items={yandexAlbumsMain}
            renderItem={(item: any) => (
              <MediaCard
                key={item.albumId}
                id={item.albumId}
                title={item.title}
                thumbUrl={item.thumbUrl}
                year={item.year ? String(item.year) : undefined}
                type="album"
                onClick={() => onSelectAlbum(item.albumId)}
                onPlayClick={async () => {
                  const d = await getYandexAlbumTracks(item.albumId.replace(/^yandex:/, ''));
                  if (d?.tracks?.length) player.playTrackList(d.tracks, 0, item.albumId);
                }}
              />
            )}
          />
        </section>
      )}

      {/* Yandex: Синглы */}
      {detail.isYandex && yandexSingles.length > 0 && (
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>Singles</h2>
          </div>
          <Carousel
            items={yandexSingles}
            renderItem={(item: any) => (
              <MediaCard
                key={item.albumId}
                id={item.albumId}
                title={item.title}
                thumbUrl={item.thumbUrl}
                year={item.year ? String(item.year) : undefined}
                type="album"
                onClick={() => onSelectAlbum(item.albumId)}
                onPlayClick={async () => {
                  const d = await getYandexAlbumTracks(item.albumId.replace(/^yandex:/, ''));
                  if (d?.tracks?.length) player.playTrackList(d.tracks, 0, item.albumId);
                }}
              />
            )}
          />
        </section>
      )}

      {/* Yandex: Сборники */}
      {detail.isYandex && yandexCompilations.length > 0 && (
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>Compilations</h2>
          </div>
          <Carousel
            items={yandexCompilations}
            renderItem={(item: any) => (
              <MediaCard
                key={item.albumId}
                id={item.albumId}
                title={item.title}
                thumbUrl={item.thumbUrl}
                year={item.year ? String(item.year) : undefined}
                type="album"
                onClick={() => onSelectAlbum(item.albumId)}
                onPlayClick={async () => {
                  const d = await getYandexAlbumTracks(item.albumId.replace(/^yandex:/, ''));
                  if (d?.tracks?.length) player.playTrackList(d.tracks, 0, item.albumId);
                }}
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

      {!channel && discography.length > 0 && (
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>Discography</h2>
            <button className={styles.seeAllBtn} onClick={e => { openSheet('discography', e.currentTarget); setDiscoCategory('Album'); }}>See All <ChevronRight size={16} /></button>
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

      {!channel && videos.length > 0 && (
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
                description={artist.subscribers || undefined}
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
    </div>
  );

  return (
    <div className={styles.viewport}>
      {overview}
      <TrackContextMenu ref={trackMenuRef} onSelectArtist={onSelectArtist} onSelectAlbum={onSelectAlbum} onSelectPlaylist={onSelectPlaylist} />

      {viewMode === 'all-videos' && channel && (
        <div ref={sheetRef} data-artist-sheet={viewMode} data-closing={isClosing || undefined} className={styles.allSongsView} role="region" aria-label="All Videos">
          <button ref={sheetBackRef} className={styles.allSongsBackBtn} onClick={closeModal} aria-label="Back to channel">
            <SheetBackIcon size={22} aria-hidden="true" />
          </button>
          <header className={styles.allSongsHeader}>
            <h1 className={styles.allSongsTitle}>All Videos</h1>
            <span className={styles.allSongsArtistName}>{channel.name}</span>
          </header>
          <div className={styles.channelUploads} aria-busy={channelPages.isFetching}>
            {renderChannelVideos(allChannelVideos)}
            {channelPages.isLoading && <p role="status">Loading…</p>}
            {channelPages.isSuccess && !allChannelVideos.length && <p>No public videos available.</p>}
            {channelPages.isError && <p role="status">Could not load videos.</p>}
            {channelPages.isError && !channelPages.isFetchNextPageError
              ? <button className={styles.seeAllBtn} onClick={() => channelPages.refetch()}>Try again</button>
              : channelPages.hasNextPage && <button className={styles.seeAllBtn} disabled={channelPages.isFetchingNextPage} onClick={() => channelPages.fetchNextPage()}>
                  {channelPages.isFetchingNextPage ? 'Loading…' : 'Load more'}
                </button>}
          </div>
        </div>
      )}

      {/* All Songs Modal */}
      {viewMode === 'all-songs' && (
        <div ref={sheetRef} data-artist-sheet={viewMode} data-closing={isClosing || undefined} className={styles.allSongsView} role="region" aria-label="All Songs">
          <button ref={sheetBackRef} className={styles.allSongsBackBtn} onClick={closeModal} aria-label="Back to artist">
            <SheetBackIcon size={22} aria-hidden="true" />
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
                {isSongsInitialLoading ? 'Loading...' : `${displayedSongs.length} tracks`}
              </span>
            </div>
            <button 
              className={`${styles.likesOnlyBtn} ${likesOnly ? styles.active : ''}`}
              onClick={() => setLikesOnly(prev => !prev)}
              title={likesOnly ? "Show all tracks" : "Show only liked tracks"}
            >
              <Heart size={15} fill={likesOnly ? "currentColor" : "none"} />
              <span>Likes only</span>
            </button>
          </header>
          <div className={styles.allSongsContent} ref={modalContentRef}>
            {isSongsInitialLoading ? (
              <div className={styles.allSongsTrackList}>
                <table className={styles.trackList} style={{ tableLayout: 'fixed' }}>
                  <TrackColumnGroup />
                  <thead>
                    <tr className={`${styles.tableHeaderRow} ${isTableScrolled ? styles.scrolled : ''}`}>
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
            ) : displayedSongs.length === 0 ? (
              <div className={styles.allSongsEmpty}>
                {likesOnly ? (
                  <Heart size={64} className={styles.allSongsEmptyIcon} style={{ color: 'var(--danger)', opacity: 0.6 }} />
                ) : (
                  <Music size={64} className={styles.allSongsEmptyIcon} />
                )}
                <div className={styles.allSongsEmptyText}>
                  {likesOnly ? 'Нет понравившихся треков' : 'No songs found'}
                </div>
                <div className={styles.allSongsEmptyHint}>
                  {likesOnly ? 'У вас нет лайкнутых треков у этого исполнителя' : "This artist doesn't have any tracks yet"}
                </div>
              </div>
            ) : (
              <div className={styles.virtuosoWrapper}>
                <TableVirtuoso
                  style={{ height: '100%' }}
                  data={displayedSongs}
                  context={virtuosoContext}
                  overscan={400}
                  increaseViewportBy={500}
                  fixedItemHeight={isDeck ? 54 : 56}
                  endReached={() => { if (!likesOnly && hasNextPage && !isFetchingNextPage) fetchNextPage(); }}
                  computeItemKey={(index, track) => track.id || index}
                  fixedHeaderContent={() => (
                    <tr className={`${styles.tableHeaderRow} ${isTableScrolled ? styles.scrolled : ''}`}>
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
          <div ref={sheetRef} data-artist-sheet={viewMode} data-closing={isClosing || undefined} className={styles.allSongsView} role="region" aria-label="Discography">
            <button ref={sheetBackRef} className={styles.allSongsBackBtn} onClick={closeModal} aria-label="Back to artist">
              <SheetBackIcon size={22} aria-hidden="true" />
            </button>
            <header className={styles.discoHeader}>
              <div className={styles.viewSwitcher}>
                <button className={styles.viewTab} aria-pressed={discoCategory === 'Album'} onClick={() => setDiscoCategory('Album')}>Albums</button>
                <button className={styles.viewTab} aria-pressed={discoCategory === 'Single'} onClick={() => setDiscoCategory('Single')}>Singles & EPs</button>
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
