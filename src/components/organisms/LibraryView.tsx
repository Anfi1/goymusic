import React, { useState, useCallback, useMemo, memo, useRef, useEffect } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { getLibrary, LibraryTab, LibraryOrder, getAlbum, getPlaylistTracks, shuffleLibrarySongs, YTMTrack } from '../../api/yt';
import { player } from '../../api/player';
import { MediaCard } from '../molecules/MediaCard';
import { MediaCardSkeleton } from '../molecules/MediaCardSkeleton';
import { TrackRow } from '../molecules/TrackRow';
import { TrackRowSkeleton } from '../molecules/TrackRowSkeleton';
import { Library, Disc, Mic2, Heart, Users, ChevronDown, Shuffle, Check, X, Play } from 'lucide-react';
import { getHomeSource } from '../../api/homeSource';
import { isYandexEnabled, getYandexPlaylists, getYandexPlaylistTracks } from '../../api/yandex';
import styles from './LibraryView.module.css';

interface LibraryViewProps {
  onSelectArtist: (id: string) => void;
  onSelectAlbum: (id: string) => void;
  onSelectPlaylist: (id: string, title: string) => void;
}

const TABS: Array<{ id: LibraryTab; label: string; icon: React.ComponentType<{ size?: number; className?: string }> }> = [
  { id: 'playlists', label: 'Playlists', icon: Library },
  { id: 'albums', label: 'Albums', icon: Disc },
  { id: 'artists', label: 'Artists', icon: Mic2 },
  { id: 'songs', label: 'Songs', icon: Heart },
  { id: 'subscriptions', label: 'Subscriptions', icon: Users },
];

const ORDER_LABELS: Record<LibraryOrder, string> = {
  recently_added: 'Recently Added',
  a_to_z: 'A to Z',
  z_to_a: 'Z to A',
  most_songs: 'Most Songs',
};

// Module-level persistent state across view navigation
let savedTab: LibraryTab = 'playlists';
let savedOrder: LibraryOrder = 'recently_added';

export const LibraryView: React.FC<LibraryViewProps> = memo(({
  onSelectArtist,
  onSelectAlbum,
  onSelectPlaylist,
}) => {
  const [activeTab, setActiveTab] = useState<LibraryTab>(savedTab);
  const [order, setOrder] = useState<LibraryOrder>(savedOrder);
  const [fetchLimit, setFetchLimit] = useState<number>(30);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);

  // Artist Liked Songs Modal State & Pagination
  const [artistModalData, setArtistModalData] = useState<{ id: string; artistId?: string; title: string; thumbUrl?: string; subText?: string } | null>(null);
  const [modalTracks, setModalTracks] = useState<YTMTrack[]>([]);
  const [modalContinuation, setModalContinuation] = useState<string | null>(null);
  const [isModalLoading, setIsModalLoading] = useState<boolean>(false);
  const [isModalFetchingMore, setIsModalFetchingMore] = useState<boolean>(false);

  const observerRef = useRef<IntersectionObserver | null>(null);
  const modalObserverRef = useRef<IntersectionObserver | null>(null);
  const dropdownRef = useRef<HTMLDivElement | null>(null);

  const handleTabChange = useCallback((tab: LibraryTab) => {
    setActiveTab(tab);
    savedTab = tab;
    setFetchLimit(30);
    if (tab === 'songs' || (order === 'most_songs' && tab !== 'artists')) {
      setOrder('recently_added');
      savedOrder = 'recently_added';
    }
  }, [order]);

  const handleOrderChange = useCallback((newOrder: LibraryOrder) => {
    setOrder(newOrder);
    savedOrder = newOrder;
    setFetchLimit(30);
    setIsDropdownOpen(false);
  }, []);

  // Fetch initial tracks when Modal opens
  useEffect(() => {
    if (!artistModalData?.id) {
      setModalTracks([]);
      setModalContinuation(null);
      return;
    }
    let isSubscribed = true;
    setIsModalLoading(true);
    getPlaylistTracks(artistModalData.id).then(res => {
      if (isSubscribed) {
        setModalTracks(res.tracks || []);
        setModalContinuation(res.continuation || null);
        setIsModalLoading(false);
      }
    }).catch(() => {
      if (isSubscribed) setIsModalLoading(false);
    });
    return () => { isSubscribed = false; };
  }, [artistModalData?.id]);

  // Load more modal tracks on scroll sentinel
  const handleLoadMoreModalTracks = useCallback(async () => {
    if (!artistModalData?.id || !modalContinuation || isModalFetchingMore) return;
    setIsModalFetchingMore(true);
    try {
      const res = await getPlaylistTracks(artistModalData.id, undefined, modalContinuation);
      if (res.tracks?.length) {
        setModalTracks(prev => [...prev, ...res.tracks]);
      }
      setModalContinuation(res.continuation || null);
    } catch (e) {
      console.error("Modal continuation fetch failed", e);
    } finally {
      setIsModalFetchingMore(false);
    }
  }, [artistModalData?.id, modalContinuation, isModalFetchingMore]);

  const modalSentinelRef = useCallback((node: HTMLDivElement | null) => {
    if (isModalLoading || isModalFetchingMore || !modalContinuation) return;
    if (modalObserverRef.current) modalObserverRef.current.disconnect();
    modalObserverRef.current = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && modalContinuation) {
        handleLoadMoreModalTracks();
      }
    });
    if (node) modalObserverRef.current.observe(node);
  }, [isModalLoading, isModalFetchingMore, modalContinuation, handleLoadMoreModalTracks]);

  // Close dropdown or modal on outside click / Escape key
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsDropdownOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsDropdownOpen(false);
        setArtistModalData(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  const containerRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const [homeSource, setHomeSourceState] = useState(getHomeSource());
  useEffect(() => {
    const onChange = (e: Event) => setHomeSourceState((e as CustomEvent).detail.source);
    window.addEventListener('home-source-changed', onChange);
    return () => window.removeEventListener('home-source-changed', onChange);
  }, []);
  const yandexPlaylistsMode = activeTab === 'playlists' && homeSource === 'yandex' && isYandexEnabled();

  const { data: rawItems = [], isLoading, isFetching } = useQuery({
    queryKey: ['library', activeTab, order, fetchLimit],
    queryFn: () => getLibrary(activeTab, fetchLimit, activeTab === 'playlists' ? undefined : order),
    placeholderData: (previousData, previousQuery) => {
      if (previousQuery?.queryKey?.[1] === activeTab) {
        return previousData;
      }
      return undefined;
    },
    staleTime: 5 * 60 * 1000,
    enabled: !yandexPlaylistsMode,
  });

  const { data: yandexPlaylists = [], isLoading: isYandexPlaylistsLoading } = useQuery({
    queryKey: ['yandex-playlists'],
    queryFn: getYandexPlaylists,
    staleTime: 5 * 60 * 1000,
    enabled: yandexPlaylistsMode,
  });

  const playYandexPlaylist = useCallback(async (kind: string) => {
    const detail = await getYandexPlaylistTracks(kind);
    if (detail?.tracks?.length) await player.playTrackList(detail.tracks, 0, `yandex-playlist-${kind}`, 'playlist');
  }, []);

  // IntersectionObserver — exact same prefetching pattern as HomeView
  useEffect(() => {
    if (!sentinelRef.current || !containerRef.current || isLoading || isFetching) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        if (rawItems.length >= fetchLimit) {
          setFetchLimit(prev => prev + 30);
        }
      },
      { root: containerRef.current, rootMargin: '0px 0px 700px 0px' }
    );
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [isLoading, isFetching, rawItems.length, fetchLimit]);

  // Client-side sorting for songs / artists if needed
  const items = useMemo(() => {
    if (!rawItems || rawItems.length === 0) return [];

    if (activeTab === 'artists' && order === 'most_songs') {
      const copy = [...rawItems];
      copy.sort((a, b) => {
        const parseVal = (str?: string) => {
          if (!str) return 0;
          const match = str.match(/\d+(\.\d+)?/);
          if (!match) return 0;
          let val = parseFloat(match[0]) || 0;
          if (str.includes('K') || str.includes('тыс')) val *= 1000;
          if (str.includes('M') || str.includes('млн')) val *= 1000000;
          return val;
        };
        return parseVal(b.description || b.subscribers) - parseVal(a.description || a.subscribers);
      });
      return copy;
    }

    if (activeTab === 'songs' && order !== 'recently_added') {
      const copy = [...rawItems];
      if (order === 'a_to_z') {
        copy.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
      } else if (order === 'z_to_a') {
        copy.sort((a, b) => (b.title || '').localeCompare(a.title || ''));
      }
      return copy;
    }
    return rawItems;
  }, [rawItems, activeTab, order]);

  const handleItemClick = useCallback((item: any) => {
    const type = item.type?.toLowerCase();
    if (activeTab === 'artists' || type === 'artist' || item.playlistId || (item.id && typeof item.id === 'string' && item.id.startsWith('MPLA'))) {
      setArtistModalData({
        id: item.playlistId || item.id,
        artistId: item.artistId || item.id,
        title: item.title,
        thumbUrl: item.thumbUrl,
        subText: item.description || item.subscribers,
      });
      return;
    }
    if (type === 'album') {
      onSelectAlbum(item.id || item.browseId);
    } else if (type === 'playlist') {
      onSelectPlaylist(item.id || item.playlistId, item.title);
    } else if (type === 'song' && item.albumId) {
      onSelectAlbum(item.albumId);
    }
  }, [activeTab, onSelectAlbum, onSelectPlaylist]);

  const handlePlayClick = useCallback(async (item: any) => {
    const type = item.type?.toLowerCase();
    if (type === 'song' && item.videoId) {
      await player.playSingle({
        id: item.videoId,
        title: item.title,
        artists: item.artists,
        artistIds: item.artistIds,
        thumbUrl: item.thumbUrl,
        album: item.album || '',
        duration: item.duration || '',
        likeStatus: item.likeStatus || 'INDIFFERENT',
      } as any);
    } else if (type === 'album') {
      const albumId = item.id || item.browseId;
      const albumData = await getAlbum(albumId);
      if (albumData?.tracks?.length) {
        await player.playTrackList(albumData.tracks, 0, albumId, 'album', albumData.audioPlaylistId);
      }
    } else if (type === 'playlist' || item.playlistId) {
      const playlistId = item.playlistId || item.id;
      const result = await getPlaylistTracks(playlistId);
      if (result.tracks?.length) {
        await player.playTrackList(result.tracks, 0, playlistId, 'playlist');
      }
    }
  }, []);

  const handleTrackRowPlay = useCallback(async (trackIndex: number) => {
    if (items && items.length > 0) {
      await player.playTrackList(items, trackIndex, 'library-songs', 'playlist');
    }
  }, [items]);

  const handleShuffleAll = useCallback(async () => {
    const serverTracks = await shuffleLibrarySongs();
    if (serverTracks && serverTracks.length > 0) {
      await player.playTrackList(serverTracks, 0, 'MLCT', 'playlist', 'MLCT');
    } else if (items && items.length > 0) {
      const shuffled = [...items].sort(() => Math.random() - 0.5);
      await player.playTrackList(shuffled, 0, 'MLCT', 'playlist', 'MLCT');
    }
  }, [items]);

  const handleModalPlayAll = useCallback(async () => {
    if (modalTracks.length > 0 && artistModalData) {
      await player.playTrackList(modalTracks, 0, artistModalData.id, 'playlist');
    }
  }, [modalTracks, artistModalData]);

  const handleModalShuffle = useCallback(async () => {
    if (modalTracks.length > 0 && artistModalData) {
      const shuffled = [...modalTracks].sort(() => Math.random() - 0.5);
      await player.playTrackList(shuffled, 0, artistModalData.id, 'playlist');
    }
  }, [modalTracks, artistModalData]);

  const showInitialSkeleton = yandexPlaylistsMode
    ? (isYandexPlaylistsLoading && yandexPlaylists.length === 0)
    : (isLoading && rawItems.length === 0);
  const displayItems = yandexPlaylistsMode ? yandexPlaylists : items;

  const availableOrders: LibraryOrder[] = activeTab === 'artists'
    ? ['recently_added', 'a_to_z', 'z_to_a', 'most_songs']
    : ['recently_added', 'a_to_z', 'z_to_a'];

  return (
    <div className={styles.container} ref={containerRef}>
      <div className={styles.headerRow}>
        <div className={styles.titleWrapper}>
          <Library size={28} className={styles.icon} />
          <h1>Library</h1>
        </div>

        <div className={styles.rightControls}>
          {activeTab === 'songs' && items.length > 0 && (
            <button
              className={styles.shuffleBtn}
              onClick={handleShuffleAll}
              title="Shuffle All (Official YouTube MLCT Supermix)"
            >
              <Shuffle size={15} />
              <span className={styles.btnText}>Shuffle All</span>
            </button>
          )}

          {/* Custom Glass Dropdown */}
          <div className={styles.dropdownWrapper} ref={dropdownRef}>
            <button
              className={`${styles.dropdownTrigger} ${isDropdownOpen ? styles.dropdownTriggerActive : ''}`}
              onClick={() => setIsDropdownOpen(!isDropdownOpen)}
            >
              <span>{ORDER_LABELS[order] || 'Sort'}</span>
              <ChevronDown size={14} className={`${styles.chevronIcon} ${isDropdownOpen ? styles.chevronOpen : ''}`} />
            </button>

            {isDropdownOpen && (
              <div className={styles.dropdownMenu}>
                {availableOrders.map((ordKey) => {
                  const isSelected = order === ordKey;
                  return (
                    <button
                      key={ordKey}
                      className={`${styles.dropdownOption} ${isSelected ? styles.dropdownOptionActive : ''}`}
                      onClick={() => handleOrderChange(ordKey)}
                    >
                      <span>{ORDER_LABELS[ordKey]}</span>
                      {isSelected && <Check size={14} className={styles.checkIcon} />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className={styles.tabsRow}>
        <div className={styles.tabs}>
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                className={`${styles.tabBtn} ${isActive ? styles.activeTab : ''}`}
                onClick={() => handleTabChange(tab.id)}
                title={tab.label}
              >
                <Icon size={16} />
                <span className={styles.tabText}>{tab.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {showInitialSkeleton ? (
        activeTab === 'songs' ? (
          <table className={styles.trackList}>
            <tbody>
              {Array.from({ length: 12 }).map((_, i) => (
                <TrackRowSkeleton key={i} index={i} />
              ))}
            </tbody>
          </table>
        ) : (
          <div className={styles.grid}>
            {Array.from({ length: 12 }).map((_, i) => (
              <MediaCardSkeleton key={i} />
            ))}
          </div>
        )
      ) : displayItems.length === 0 ? (
        <div className={styles.emptyState}>
          <Library size={48} className={styles.emptyIcon} />
          <div className={styles.emptyText}>Library is empty</div>
          <div className={styles.emptySubtext}>Your saved items will appear here</div>
        </div>
      ) : activeTab === 'songs' ? (
        <>
          <table className={styles.trackList}>
            <tbody>
              {items.map((track: YTMTrack, index: number) => (
                <TrackRow
                  key={track.id || (track as any).videoId || index}
                  index={index + 1}
                  {...track}
                  likeStatus={track.likeStatus}
                  onClick={() => handleTrackRowPlay(index)}
                  onSelectArtist={onSelectArtist}
                  onSelectAlbum={onSelectAlbum}
                />
              ))}
            </tbody>
          </table>
          <div ref={sentinelRef} style={{ height: 1 }} />
          {isFetching && (
            <table className={styles.trackList} style={{ marginTop: 8 }}>
              <tbody>
                {Array.from({ length: 4 }).map((_, i) => (
                  <TrackRowSkeleton key={`bottom-skel-${i}`} index={i} />
                ))}
              </tbody>
            </table>
          )}
        </>
      ) : (
        <>
          <div className={styles.grid}>
            {yandexPlaylistsMode
              ? yandexPlaylists.map((pl) => (
                <MediaCard
                  key={pl.id}
                  id={pl.id}
                  title={pl.title}
                  thumbUrl={pl.thumbUrl}
                  type="playlist"
                  description={pl.trackCount ? `${pl.trackCount} tracks` : undefined}
                  onClick={() => playYandexPlaylist(pl.id)}
                  onPlayClick={() => playYandexPlaylist(pl.id)}
                />
              ))
              : items.map((item: any) => (
                <MediaCard
                  key={item.id}
                  {...item}
                  description={item.description || item.subscribers || item.count ? `${item.count ? item.count + ' tracks' : (item.description || item.subscribers)}` : undefined}
                  onClick={() => handleItemClick(item)}
                  onPlayClick={() => handlePlayClick(item)}
                  onArtistClick={onSelectArtist}
                />
              ))}
          </div>
          <div ref={sentinelRef} style={{ height: 1 }} />
          {!yandexPlaylistsMode && isFetching && (
            <div className={styles.grid} style={{ marginTop: 12 }}>
              {Array.from({ length: 4 }).map((_, i) => (
                <MediaCardSkeleton key={`bottom-card-skel-${i}`} />
              ))}
            </div>
          )}
        </>
      )}

      {/* Artist Liked Songs Modal Overlay */}
      {artistModalData && (
        <div className={styles.modalOverlay} onClick={() => setArtistModalData(null)}>
          <div className={styles.modalContainer} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <div className={styles.modalArtistInfo}>
                {artistModalData.thumbUrl && (
                  <img src={artistModalData.thumbUrl} className={styles.modalAvatar} alt="" />
                )}
                <div className={styles.modalTitles}>
                  <h2
                    className={styles.modalArtistTitle}
                    onClick={() => {
                      if (artistModalData.artistId) {
                        const aId = artistModalData.artistId;
                        setArtistModalData(null);
                        onSelectArtist(aId);
                      }
                    }}
                    title="Go to Artist page"
                  >
                    {artistModalData.title}
                  </h2>
                  {artistModalData.subText && (
                    <div className={styles.modalSubtitle}>
                      {artistModalData.subText}
                    </div>
                  )}
                </div>
              </div>

              <div className={styles.modalActions}>
                {modalTracks.length > 0 && (
                  <>
                    <button
                      className={styles.shuffleBtn}
                      onClick={handleModalPlayAll}
                    >
                      <Play size={16} fill="currentColor" />
                      <span>Play All</span>
                    </button>
                    <button
                      className={styles.shuffleBtn}
                      onClick={handleModalShuffle}
                    >
                      <Shuffle size={16} />
                      <span>Shuffle</span>
                    </button>
                  </>
                )}
                <button
                  className={styles.modalCloseBtn}
                  onClick={() => setArtistModalData(null)}
                  title="Close (Esc)"
                >
                  <X size={18} />
                </button>
              </div>
            </div>

            <div className={styles.modalBody}>
              {isModalLoading ? (
                <table className={styles.modalTable}>
                  <tbody>
                    {Array.from({ length: 8 }).map((_, i) => (
                      <TrackRowSkeleton key={i} index={i} />
                    ))}
                  </tbody>
                </table>
              ) : modalTracks.length === 0 ? (
                <div className={styles.emptyState}>
                  <div className={styles.emptyText}>No tracks found for this artist</div>
                </div>
              ) : (
                <>
                  <table className={styles.modalTable}>
                    <tbody>
                      {modalTracks.map((track: YTMTrack, idx: number) => (
                        <TrackRow
                          key={track.id || idx}
                          index={idx + 1}
                          {...track}
                          onClick={() => player.playTrackList(modalTracks, idx, artistModalData.id, 'playlist')}
                          onSelectArtist={onSelectArtist}
                          onSelectAlbum={onSelectAlbum}
                        />
                      ))}
                      {isModalFetchingMore && (
                        Array.from({ length: 4 }).map((_, i) => (
                          <TrackRowSkeleton key={`modal-skel-${i}`} index={i} />
                        ))
                      )}
                    </tbody>
                  </table>
                  {modalContinuation && (
                    <div ref={modalSentinelRef} style={{ height: 20, margin: '1rem 0' }} />
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
