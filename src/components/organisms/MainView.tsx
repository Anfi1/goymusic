import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, memo, Fragment } from 'react';
import { TableVirtuoso, VirtuosoHandle } from 'react-virtuoso';
import { useQueryClient } from '@tanstack/react-query';
import { TrackRow, TrackColumnGroup } from '../molecules/TrackRow';
import { TrackRowSkeleton } from '../molecules/TrackRowSkeleton';
import { Skeleton } from '../atoms/Skeleton';
import { LazyImage } from '../atoms/LazyImage';
import { 
  sendFeedback,
  ratePlaylist,
  editPlaylist,
  deletePlaylist,
  YTMTrack, 
  YTMUser
} from '../../api/yt';
import { player } from '../../api/player';
import { requestPrefetch, cancelPrefetchRequest } from '../../api/stream';
import { getAlbumLink } from '../../api/trackLink';
import { playlistQueryKey, usePlaylist, PlaylistType } from '../../hooks/usePlaylist';
import { likedSyncLabel } from '../../api/likedManager';
import { likedStore } from '../../api/likedStore';
import { LOCAL_PLAYLIST_ID } from '../../api/localOverrides';
import { ActiveView } from '../../types';
import { useToast } from '../atoms/Toast';
import { SearchView } from './SearchView';
import { getCachedYandexLikedTracks, syncYandexLikedTracks, isYandexAlbumRouteId, isYandexPlaylistRouteId, yandexSetAlbumLiked, isYandexEnabled } from '../../api/yandex';
import { isSoundCloudEnabled } from '../../api/soundcloud';
import { TrackSource, resolveSource } from '../../api/source';
import { SourceSwitcher } from '../atoms/SourceSwitcher';
import {
  Loader2, Heart, Share2, Globe, Lock, Clock, Pencil, Trash2, Pin, PinOff, ArrowDownAZ, Calendar
} from 'lucide-react';

import { openImageViewer } from '../molecules/ImageViewer';

import { IconButton } from '../atoms/IconButton';

import { InputDialog } from '../molecules/InputDialog';
import { ConfirmDialog } from '../molecules/ConfirmDialog';
import { isDeckLayout, subscribeDesktopLayout } from '../../utils/desktopLayout';
import styles from './MainView.module.css';
import trackStyles from '../molecules/TrackRow.module.css';
import { TrackContextMenu, TrackContextMenuHandle } from './TrackContextMenu';

interface MainViewProps {
  activeView: ActiveView;
  isAuthenticated: boolean;
  isInitializing?: boolean;
  user: YTMUser | null;
  onSearch: (query: string) => void;
  onSearchAgain: (query: string) => void;
  onSelectArtist: (id: string) => void;
  onSelectAlbum: (id: string) => void;
  onSelectPlaylist: (id: string, title: string) => void;
  onSelectHome: () => void;
  onBack?: () => void;
  canGoBack?: boolean;
}

const LIKED_SOURCES_KEY = 'ytm-liked-sources';
const HEADER_HEIGHT = 320;
const STICKY_THRESHOLD = 160;
const AUTO_SCROLL_THRESHOLD = 100;
const MAX_SCROLL_SPEED = 12;

// Count-only preview: use the real table without inventing playable tracks.
const ALBUM_PREVIEW_ROWS = 6;
const DECK_COLLECTION_TRACK_HEIGHT = 50;

const VirtuosoScroller = React.forwardRef<HTMLDivElement, any>(({ children, context, ...props }, ref) => (
  <div 
    {...props} 
    ref={(node) => {
      if (typeof ref === 'function') ref(node);
      else if (ref) (ref as any).current = node;
      if (context?.scrollerRef) (context.scrollerRef as any).current = node;
    }} 
    onScroll={(e) => {
      context?.onScroll(e);
      props.onScroll?.(e);
    }}
    onDragOver={context?.onDragOverContainer}
    style={{ ...props.style, height: '100%', overflowY: 'auto', position: 'relative' }}
  >
    {context && !context.isSearch && <LargeHeader {...context} />}
    {children}
  </div>
));

const VirtuosoTable = React.forwardRef<HTMLTableElement, any>(({ context, ...props }, ref) => (
  <table 
    {...props} 
    ref={(node) => {
      if (typeof ref === 'function') ref(node);
      else if (ref) (ref as any).current = node;
      if (context?.tableRef) (context.tableRef as any).current = node;
    }}
    className={styles.trackList} 
    data-testid={context?.isDeck && context.playlistType === 'album' && context.showSkeletons ? 'album-skeleton-tracks' : undefined}
    style={{ 
      ...props.style, 
      borderCollapse: context?.isDeck ? 'separate' : 'collapse',
      zIndex: 2, 
      position: 'relative',
      transform: context?.isDeck || context?.isSearch ? undefined : `translate3d(0, ${HEADER_HEIGHT}px, 0)`,
      tableLayout: 'fixed',
      willChange: context?.isDeck ? undefined : 'transform'
    }}
  >
    <TrackColumnGroup hideAlbum={context?.playlistType === 'album'} />
    {props.children}
  </table>
));

const VirtuosoTableHead = memo(() => (
  <thead>
    <tr className={styles.tableHeader}>
      <th style={{ textAlign: 'left' }}>#</th>
      <th style={{ textAlign: 'left' }}>Title</th>
      <th style={{ textAlign: 'left' }}>Album</th>
      <th style={{ textAlign: 'right' }}>Time</th>
    </tr>
  </thead>
));

const VirtuosoTableRow = memo(React.forwardRef<HTMLTableRowElement, any>((props, ref) => {
  const { item: track, context, ...rest } = props;
  
  const [isActive, setIsActive] = useState(player.currentTrack?.id === track?.id);

  useEffect(() => {
    if (!track?.id) return;
    return player.subscribe((event) => {
      if (event === 'state') {
        const isMe = player.currentTrack?.id === track?.id;
        setIsActive(prev => prev !== isMe ? isMe : prev);
      }
    });
  }, [track?.id]);

  const index = props['data-index'];
  const isAvailable = track?.isAvailable !== false;

  const handleMouseEnter = useCallback(() => {
    if (track?.id && isAvailable && !isActive) requestPrefetch(track.id);
  }, [track?.id, isAvailable, isActive]);

  const handleMouseLeave = useCallback(() => {
    cancelPrefetchRequest();
  }, []);

  if (context.showSkeletons) return (
    <TrackRowSkeleton {...rest} ref={ref} index={index} hideAlbum={context.playlistType === 'album'}
      albumPreview={context.isDeck && context.playlistType === 'album'} />
  );
  
  return (
    <tr
      {...rest}
      ref={ref}
      className={`${trackStyles.row} ${isActive ? trackStyles.active : ''} ${!isAvailable ? trackStyles.unavailable : ''} ${context.draggedIdx === index ? styles.draggingRow : ''} ${context.dragOverIdx === index ? styles.dropTarget : ''}`}
      onClick={isAvailable ? () => (isActive ? player.togglePlay() : context.onPlay(index)) : undefined}
      onContextMenu={(e) => { e.preventDefault(); context.onContextMenu(e, track); }}
      draggable={context.isEditable}
      onDragStart={e => {
        if (!context.isEditable || !track?.setVideoId) { e.preventDefault(); return; }
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', track.setVideoId);
        context.onDragStart(index);
      }}
      onDragOver={(e) => {
        if (context.draggedIdx === null) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        context.onDragOverItem?.(index);
      }}
      onDragEnter={e => {
        if (context.draggedIdx !== null) e.preventDefault();
      }}
      onDragEnd={() => {
        context.onDragStart(null);
        context.onDragOverItem?.(null);
        context.stopAutoScroll();
      }}
      onDrop={e => {
        e.preventDefault();
        context.onDrop(index);
      }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      style={{ ...rest.style, cursor: context.isEditable ? 'grab' : (isAvailable ? 'pointer' : 'default') }}
    />
  );
}));

const VirtuosoFooter = memo(({ context }: any) => (
  <tfoot>
    {context.isFetchingNextPage && (
      <tr>
        <td colSpan={4}>
          <div className={styles.loadMoreIndicator} style={{ padding: '2rem', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '12px' }}>
            <Loader2 className="animate-spin" size={20} />
            <span style={{ fontSize: '13px', fontWeight: 600 }}>Loading more tracks…</span>
          </div>
        </td>
      </tr>
    )}
  </tfoot>
));

// Длинное название уменьшаем, пока не влезет в отведённые строки (line-clamp).
const MIN_TITLE_PX = 18;
function useFitTitle(ref: React.RefObject<HTMLElement | null>, text?: string) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      el.style.fontSize = '';
      let size = parseFloat(getComputedStyle(el).fontSize);
      // ширина тоже: одно длинное слово line-clamp не переносит, а режет многоточием
      while ((el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1) && size > MIN_TITLE_PX) {
        size = Math.max(MIN_TITLE_PX, size - 2);
        el.style.fontSize = size + 'px';
      }
    };
    fit();
    // ширина заголовка меняется и после первого кадра (догружается шапка, шрифт),
    // поэтому следим за ней самой; высоту не слушаем -- её меняет сама подгонка
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fit();
    });
    ro.observe(el);
    document.fonts?.ready.then(fit);
    return () => ro.disconnect();
  }, [ref, text]);
}

const LargeHeader = memo(({
  metadata, tracks, totalReportedCount, showSkeletons,
  isSyncing: isFetchingNextPage, isSticky, likedCountLabel, handleHeaderAction, isHeaderActionLoading, isDeck,
  headerRef, playlistType, sortMode, setSortMode, isSorting,
  isLikedSongsView, likedSources, activeLikedSources, onToggleLikedSource
}: any) => {
  const { showToast } = useToast();
  const titleRef = useRef<HTMLHeadingElement>(null);
  useFitTitle(titleRef, metadata?.title);
  
  const handleShare = useCallback(() => {
    const id = metadata?.id ?? '';
    const url = isYandexAlbumRouteId(id)
      ? `https://music.yandex.ru/album/${id.replace(/^yandex:/, '')}`
      : isYandexPlaylistRouteId(id)
      ? `https://music.yandex.ru/users/${id.split(':')[1] || ''}/playlists/${id.split(':')[2]}`
      : getAlbumLink(id);
    navigator.clipboard.writeText(url);
    showToast('Link copied to clipboard', 'success');
  }, [metadata?.id, showToast]);

  const handleZoomCover = useCallback((e: React.MouseEvent) => {
    if (!metadata?.thumbUrl) return;
    e.stopPropagation();
    openImageViewer(metadata.thumbUrl, metadata.title);
  }, [metadata]);

  const isLikedSongs = playlistType === 'liked' || metadata?.id === 'LM';
  const isAlbum = !!(metadata?.type?.match(/ALBUM|SINGLE|EP|COMPILATION/i));
  const isPlaylist = !isAlbum && !isLikedSongs;
  const isOwned = !!metadata?.owned;

  const isLocal = metadata?.id === LOCAL_PLAYLIST_ID;
  const targetRatingId = isLocal ? undefined : metadata?.audioPlaylistId || metadata?.id;
  const isYandexMeta = isYandexAlbumRouteId(metadata?.id) || isYandexPlaylistRouteId(metadata?.id);
  const displayCount = showSkeletons ? '...' : likedCountLabel ?? (
    tracks.length >= totalReportedCount || !totalReportedCount ? `${tracks.length} songs` : `${tracks.length} of ${totalReportedCount}`);

  const description = isLikedSongs ? 'Your private collection of favorite tracks' : metadata?.description;
  const actionSize = isDeck ? 32 : 42;
  const isDeckAlbum = isDeck && playlistType === 'album';
  const [previewHeight, setPreviewHeight] = useState<number>();
  useLayoutEffect(() => {
    const header = headerRef.current;
    if (!isDeckAlbum || !showSkeletons || !header) return;
    // Preserve the outgoing border box, including resizes while the query is pending.
    setPreviewHeight(header.getBoundingClientRect().height);
    const observer = new ResizeObserver(([entry]) => setPreviewHeight(entry.borderBoxSize[0].blockSize));
    observer.observe(header, { box: 'border-box' });
    return () => observer.disconnect();
  }, [isDeckAlbum, showSkeletons, headerRef]);
  const stats = (
    <div className={styles.statsUnderCover}>
      {showSkeletons ? (
        <>
          <Skeleton width={40} height={isDeckAlbum ? 14 : 12} borderRadius={4} />
          <Skeleton width={60} height={isDeckAlbum ? 14 : 12} borderRadius={4} />
        </>
      ) : (
        <>
          {metadata?.year && <div className={styles.yearUnder}>{metadata.year}</div>}
          <div className={styles.trackCountUnder} style={isLikedSongsView && isSticky ? { visibility: 'hidden' } : undefined}>{displayCount}</div>
        </>
      )}
    </div>
  );

  return (
    <div ref={headerRef}
      className={isDeckAlbum && previewHeight !== undefined ? `${styles.header} ${styles.measuredAlbumHeader}` : styles.header}
      style={isDeckAlbum && previewHeight !== undefined ? { '--album-preview-height': `${previewHeight}px` } as React.CSSProperties : undefined}
      aria-hidden={showSkeletons || undefined}>
      <div className={styles.coverWrapper}>
        <div 
          className={`${styles.coverContainer} ${!showSkeletons ? styles.zoomable : ''}`}
          data-testid={isDeckAlbum && showSkeletons ? 'album-skeleton-cover' : undefined}
          onClick={!showSkeletons ? handleZoomCover : undefined}
        >
          {showSkeletons ? (
            <Skeleton width="100%" height="100%" className={isDeckAlbum ? styles.albumLoadingCover : undefined} />
          ) : (
            <>
              <LazyImage 
                src={metadata?.thumbUrl} 
                alt={metadata?.title} 
                className={styles.cover} 
                placeholder={<Skeleton width="100%" height="100%" />}
              />
              {isFetchingNextPage && (
                <div className={styles.syncOverlay}>
                  <div className={styles.syncCircle} />
                </div>
              )}
            </>
          )}
        </div>
        {!isDeck && stats}
      </div>

      <div className={styles.info} data-testid={isDeckAlbum && showSkeletons ? 'album-skeleton-metadata' : undefined} style={showSkeletons && !isDeckAlbum ? { justifyContent: 'flex-start', paddingTop: '10px' } : undefined}>
        {showSkeletons ? (
          <>
            <div className={styles.label}><Skeleton width={80} height={isDeckAlbum ? 14 : 12} borderRadius={4} /></div>
            <Skeleton width={isDeckAlbum ? 'min(85%, 26rem)' : '85%'} height={isDeckAlbum ? 'calc(var(--fs-collection-title) * var(--album-title-leading))' : 52} borderRadius={8} style={isDeckAlbum ? undefined : { marginTop: '4px' }} />
            <div className={styles.headerMeta} style={{ animation: 'none' }}>
              <div className={styles.metaTextInfo}>
                <Skeleton width={isDeckAlbum ? 'min(72%, 9rem)' : 140} height={isDeckAlbum ? 16 : 14} borderRadius={4} />
                {!isDeckAlbum && <Skeleton width={50} height={14} borderRadius={4} />}
                {isDeck && stats}
              </div>
              <div className={styles.headerActions}>
                <Skeleton width={actionSize} height={actionSize} borderRadius="50%" />
                <Skeleton width={actionSize} height={actionSize} borderRadius="50%" />
              </div>
            </div>
          </>
        ) : (
          <>
            <div className={styles.label} style={{ display: 'flex', alignItems: 'center', gap: '6px', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                {(isLikedSongs || (isPlaylist && metadata?.privacy === 'PRIVATE')) ? <Lock size={12} /> : (isPlaylist && (metadata?.privacy === 'PUBLIC' || metadata?.privacy === 'UNLISTED')) ? <Globe size={12} /> : null}
                {isLikedSongs ? 'PRIVATE' : metadata?.type}
              </div>

              {isLikedSongs && (
                <div 
                  className={`${styles.sortToggle} ${(isFetchingNextPage || isSorting) ? styles.sortToggleDisabled : ''}`} 
                  onClick={(e) => {
                    if (isFetchingNextPage || isSorting) return;
                    e.stopPropagation();
                    setSortMode(sortMode === 'date' ? 'album' : 'date');
                  }}
                  data-tooltip={isFetchingNextPage ? 'Sorting unavailable while loading' : (sortMode === 'date' ? 'Sorted by Date' : 'Sorted by Album')}
                >
                  {sortMode === 'date' ? <Calendar size={14} /> : <ArrowDownAZ size={14} />}
                  <span>{sortMode === 'date' ? 'By Date' : 'By Album'}</span>
                </div>
              )}
            </div>

            <h1 ref={titleRef} className={styles.title} data-tooltip={metadata?.title}>{metadata?.title}</h1>
            
            {description && (
              <div className={styles.descriptionText} data-tooltip={description} data-tooltip-overflow="">
                {description}
              </div>
            )}
            {isDeck && !metadata && stats}

            {metadata && (
            <div className={styles.headerMeta}>
                <div className={styles.metaTextInfo}>
                  {!isLikedSongs && (
                    <div className={styles.artistLinks}>
                      {metadata.author ? (
                        <span 
                          className={metadata.author.id ? styles.headerLink : ''}
                          onClick={() => metadata.author.id && handleHeaderAction('artist', metadata.author.id)}
                        >
                          {metadata.author.name || metadata.author}
                        </span>
                      ) : metadata.artists?.map((name: string, i: number) => (
                        <Fragment key={i}>
                          <span 
                            className={metadata.artistIds?.[i] ? styles.headerLink : ''}
                            onClick={() => metadata.artistIds?.[i] && handleHeaderAction('artist', metadata.artistIds[i])}
                          >
                            {name}
                          </span>
                          {i < metadata.artists.length - 1 && ', '}
                        </Fragment>
                      ))}
                    </div>
                  )}
                  {isDeck && stats}
                  {metadata.duration && (
                    <div className={styles.durationTag}>
                      <Clock size={12} />
                      {metadata.duration}
                    </div>
                  )}
                </div>

                <div className={styles.headerActions}>
                  {targetRatingId && (isYandexMeta ? true : (metadata.likeStatus === 'LIKE' || !isOwned)) && (
                    <IconButton
                      icon={Heart}
                      size={actionSize}
                      iconSize={20}
                      active={metadata.likeStatus === 'LIKE'}
                      isLoading={isHeaderActionLoading === 'like'}
                      onClick={() => handleHeaderAction('like')}
                      title={metadata.likeStatus === 'LIKE' ? 'Remove from library' : 'Save to library'}
                      color={metadata.likeStatus === 'LIKE' ? 'var(--danger)' : undefined}
                      fill={metadata.likeStatus === 'LIKE' ? 'var(--danger)' : 'none'}
                    />
                  )}
                  {!isLikedSongs && metadata.menu_tokens && (
                    <IconButton
                      icon={metadata.isPinned ? PinOff : Pin}
                      size={actionSize}
                      iconSize={20}
                      active={metadata.isPinned}
                      isLoading={isHeaderActionLoading === 'pin'}
                      onClick={() => handleHeaderAction('pin')}
                      title={metadata.isPinned ? 'Unpin from Home' : 'Pin to Home'}
                      color={metadata.isPinned ? 'var(--accent)' : undefined}
                    />
                  )}
                  {isOwned && isPlaylist && !isLikedSongs && (
                    <>
                      <IconButton
                        icon={Pencil}
                        size={actionSize}
                        iconSize={20}
                        onClick={() => handleHeaderAction('rename')}
                        title="Rename Playlist"
                      />
                      <IconButton
                        icon={Trash2}
                        size={actionSize}
                        iconSize={20}
                        onClick={() => handleHeaderAction('delete')}
                        title="Delete Playlist"
                        className={styles.dangerAction}
                      />
                    </>
                  )}
                  {!isLikedSongs && !isLocal && (
                    <IconButton icon={Share2} size={actionSize} iconSize={20} onClick={handleShare} title="Copy Link" />
                  )}
                  {isLikedSongsView && (
                    <SourceSwitcher
                      sources={likedSources}
                      active={activeLikedSources}
                      onToggle={onToggleLikedSource}
                      tooltip="Показывать источники"
                    />
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
});

const StickyTitlePanel = memo(({ 
  isVisible, isDeckAlbum, metadata, playlistTracks, totalReportedCount, likedCountLabel, isFetchingNextPage, viewLabel, viewTitle
}: any) => {
  const coverUrl = metadata?.thumbUrl || (playlistTracks[0]?.thumbUrl || '');
  const albumArtist = isDeckAlbum && (metadata?.artists?.join(', ') || metadata?.author?.name);
  const albumSongCount = Math.max(playlistTracks.length, totalReportedCount);
  const albumFacts = [
    metadata?.type, metadata?.year, `${albumSongCount} ${albumSongCount === 1 ? 'song' : 'songs'}`, metadata?.duration,
  ];
  
  return (
    <div aria-hidden={!isVisible} className={`${styles.stickyHeaderContainer} ${isVisible ? styles.isSticky : ''}`}>
      <div className={`${styles.stickyTitleRow} ${isVisible ? styles.visible : ''}`}>
        <div className={styles.stickyTitleContent}>
          <div className={styles.stickyThumbWrapper}>
            <LazyImage src={coverUrl} className={styles.stickyThumb} />
            {isFetchingNextPage && (
              <div className={styles.stickySyncOverlay}>
                <div className={styles.stickySyncCircle} />
              </div>
            )}
          </div>
          <div className={styles.stickyTextInfo}>
            {!isDeckAlbum && <div className={styles.stickyLabel}>{viewLabel}</div>}
            <div className={styles.stickyMainTitle} data-tooltip={viewTitle} data-tooltip-overflow="">
              {viewTitle}
              {!isDeckAlbum && isVisible && <span className={styles.stickyTrackCount}> • {likedCountLabel ?? `${playlistTracks.length} of ${totalReportedCount}`}</span>}
            </div>
            {isDeckAlbum && <div className={styles.stickyAlbumMeta}>
              {albumArtist && <span className={styles.stickyAlbumArtist} data-tooltip={albumArtist} data-tooltip-overflow="">{albumArtist}</span>}
              {albumFacts.map((fact, index) => fact && <span key={index}>{fact}</span>)}
            </div>}
          </div>
        </div>
      </div>
    </div>
  );
});

const RenderTrackRow = memo(({ index, track, hideAlbum, onSelectArtist, onSelectAlbum }: any) => (
  <TrackRow 
    index={index + 1} {...track}
    renderOnlyCells={true} hideAlbum={hideAlbum}
    onSelectArtist={onSelectArtist} onSelectAlbum={onSelectAlbum}
  />
));

export const MainView = memo<MainViewProps>(({ 
  activeView, isAuthenticated, isInitializing, user, onSearch, onSearchAgain, onSelectArtist, onSelectAlbum, onSelectPlaylist, onSelectHome, onBack
}) => {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  
  const [isSticky, setIsSticky] = useState(false);
  const [isHeaderActionLoading, setIsHeaderActionLoading] = useState<'like' | 'pin' | 'rename' | 'delete' | null>(null);
  const [isRenameOpen, setIsRenameOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [draggedIdx, setDraggedIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [movingTrack, setMovingTrack] = useState(false);
  const [yandexLikedTracks, setYandexLikedTracks] = useState<YTMTrack[]>([]);
  // Даты лайков YouTube-треков: в самом списке их нет, они лежат в likedStore.
  const [ytLikedAt, setYtLikedAt] = useState<Map<string, number>>(new Map());
  // Интеграции могут включаться/выключаться на ходу -- следим за событиями, иначе
  // список лайков не перестроится до перезахода на вкладку.
  const [scEnabled, setScEnabled] = useState(isSoundCloudEnabled());
  const [yandexEnabled, setYandexEnabled] = useState(isYandexEnabled());
  useEffect(() => {
    const onSc = (e: Event) => setScEnabled((e as CustomEvent).detail.enabled);
    const onYandex = (e: Event) => setYandexEnabled((e as CustomEvent).detail.enabled);
    window.addEventListener('sc-enabled-changed', onSc);
    window.addEventListener('yandex-enabled-changed', onYandex);
    return () => {
      window.removeEventListener('sc-enabled-changed', onSc);
      window.removeEventListener('yandex-enabled-changed', onYandex);
    };
  }, []);

  // Какие источники показывать во вкладке лайков (список смешанный: YT + SC + Yandex).
  const [activeLikedSources, setActiveLikedSources] = useState<TrackSource[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(LIKED_SOURCES_KEY) || 'null');
      if (Array.isArray(saved) && saved.length > 0) return saved;
    } catch { /* повреждённое значение -- показываем всё */ }
    return ['youtube', 'soundcloud', 'yandex'];
  });

  const headerRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const trackMenuRef = useRef<TrackContextMenuHandle>(null);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const isDeck = React.useSyncExternalStore(subscribeDesktopLayout, isDeckLayout);
  const [deckScroller, setDeckScroller] = useState<HTMLDivElement | null>(null);
  const attachDeckScroller = useCallback((node: HTMLDivElement | null) => {
    scrollerRef.current = node;
    setDeckScroller(node);
  }, []);
  const autoScrollRaf = useRef<number | null>(null);

  const isSearch = activeView.type === 'search';
  const playlistType: PlaylistType = useMemo(() => activeView.type === 'liked' ? 'liked' : (activeView.type === 'album' ? 'album' : 'playlist'), [activeView.type]);
  const isDeckAlbum = isDeck && playlistType === 'album';
  const playlistId = activeView.playlistId || activeView.albumId;

  const {
    tracks: playlistTracks, metadata: playlistMetadata, totalReportedCount,
    isLoading: isPlaylistLoading, hasNextPage, isFetchingNextPage, fetchNextPage, syncPlayerQueue,
    sortMode, setSortMode, isSorting, likedProgress, isMirroring
  } = usePlaylist(playlistType, playlistId);

  const isLikedSongsView = playlistType === 'liked' || playlistId === 'LM';
  const isSyncing = isMirroring || isFetchingNextPage;
  const mirrorLabel = likedProgress && likedSyncLabel(likedProgress);

  // Yandex-лайки подмешиваются прямо в общий список Liked Songs (не отдельная страница) --
  // сперва кэш (мгновенно), затем свежие данные с сервера в фоне. Без проверки isYandexEnabled()
  // -- как было в старой отдельной вкладке лайков: если аккаунт не подключён, yandex_liked_tracks
  // просто ответит not authenticated, а лишний гейт на фронте однажды уже стоил того, что лайки
  // молча не подтягивались даже у подключённых пользователей.
  useEffect(() => {
    if (!isLikedSongsView) { setYandexLikedTracks([]); return; }
    let alive = true;
    likedStore.getLikedAtMap().then(m => { if (alive) setYtLikedAt(m); }).catch(() => {});
    getCachedYandexLikedTracks().then(cached => { if (alive && cached.length > 0) setYandexLikedTracks(cached); });
    syncYandexLikedTracks().then(async () => {
      if (!alive) return;
      const fresh = await getCachedYandexLikedTracks();
      if (alive) setYandexLikedTracks(fresh);
    });
    return () => { alive = false; };
  }, [isLikedSongsView]);

  const handleToggleLikedSource = useCallback((source: TrackSource, next: boolean) => {
    setActiveLikedSources(prev => {
      const updated = next ? [...new Set([...prev, source])] : prev.filter(s => s !== source);
      // Пустой фильтр показал бы пустой список -- последний источник не гасим. Считаем
      // по доступным: выключенная интеграция в выборе не участвует, даже если её id
      // остался в сохранённом значении.
      const available = new Set<TrackSource>(['youtube',
        ...(isSoundCloudEnabled() ? ['soundcloud' as const] : []),
        ...(isYandexEnabled() ? ['yandex' as const] : [])]);
      const safe = updated.some(s => available.has(s)) ? updated : prev;
      localStorage.setItem(LIKED_SOURCES_KEY, JSON.stringify(safe));
      return safe;
    });
  }, []);

  const isEditable = !!playlistMetadata?.owned && playlistType === 'playlist' && playlistId !== 'LM' && !movingTrack;

  // Observe the in-flow header, not the recycled rows. The sticky title follows
  // the real cover/title height even when fonts, metadata or panel widths change.
  useEffect(() => {
    const header = headerRef.current;
    if (!deckScroller || !header) return;
    const threshold = playlistType === 'album' ? 0.25 : 0;
    const observer = new IntersectionObserver(([entry]) => {
      setIsSticky(entry.boundingClientRect.top < (entry.rootBounds?.top ?? 0)
        && (!entry.isIntersecting || entry.intersectionRatio < threshold));
    }, { root: deckScroller, threshold });
    observer.observe(header);
    return () => observer.disconnect();
  }, [deckScroller, playlistType]);

  // The outer wrapper is Virtuoso's custom scroll parent in Deck. Keep its
  // header in flow for measurement; only the painted cover and copy move.
  useLayoutEffect(() => {
    const header = headerRef.current;
    if (!isDeckAlbum || !deckScroller || !header) return;
    let lastTop = -1;
    const update = () => {
      const top = Math.min(260, Math.max(0, deckScroller.scrollTop));
      if (top !== lastTop) {
        lastTop = top;
        header.style.setProperty('--album-scroll', String(top));
      }
    };
    update();
    deckScroller.addEventListener('scroll', update, { passive: true });
    return () => deckScroller.removeEventListener('scroll', update);
  }, [isDeckAlbum, deckScroller]);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const top = e.currentTarget.scrollTop;
    const thresholdReached = top > STICKY_THRESHOLD;
    if (isSticky !== thresholdReached) setIsSticky(thresholdReached);
    
    if (headerRef.current) {
      const translateY = top * 0.5;
      const opacity = Math.max(0, 1 - (top / 260));
      const blur = Math.min(10, (top / 40));
      headerRef.current.style.transform = `translate3d(0, ${translateY}px, 0)`;
      headerRef.current.style.opacity = opacity.toString();
      headerRef.current.style.filter = `blur(${blur}px)`;
      headerRef.current.style.pointerEvents = top > 100 ? 'none' : 'auto';
    }

    if (tableRef.current && !isSearch) {
      const tableTranslateY = Math.max(0, HEADER_HEIGHT - top);
      tableRef.current.style.transform = `translate3d(0, ${tableTranslateY}px, 0)`;
    }
  }, [isSticky, isSearch]);

  const handleHeaderAction = useCallback(async (type: string, payload?: any) => {
    if (type === 'artist' && payload) onSelectArtist(payload);
    else if (type === 'like') {
      if (isYandexPlaylistRouteId(playlistMetadata?.id)) return;
      if (playlistMetadata && isYandexAlbumRouteId(playlistMetadata.id)) {
        if (isHeaderActionLoading) return;
        setIsHeaderActionLoading('like');
        const rawId = (playlistMetadata.id || '').replace(/^yandex:/, '');
        const newStatus = playlistMetadata.likeStatus === 'LIKE' ? 'INDIFFERENT' : 'LIKE';
        const ok = await yandexSetAlbumLiked(rawId, newStatus === 'LIKE');
        if (ok) {
          queryClient.setQueryData(['playlist-infinite', playlistType, playlistId], (old: any) => {
            if (!old) return old;
            const updatedPages = [...old.pages];
            updatedPages[0] = { ...updatedPages[0], metadata: { ...updatedPages[0].metadata, likeStatus: newStatus } };
            return { ...old, pages: updatedPages };
          });
          showToast(newStatus === 'LIKE' ? 'Added to library' : 'Removed from library', 'success');
        }
        setIsHeaderActionLoading(null);
        return;
      }
      const targetId = playlistMetadata?.audioPlaylistId || playlistMetadata?.id;
      if (!targetId || isHeaderActionLoading) return;
      setIsHeaderActionLoading('like');
      const newStatus = playlistMetadata.likeStatus === 'LIKE' ? 'INDIFFERENT' : 'LIKE';
      const success = await ratePlaylist(targetId, newStatus);
      if (success) {
        queryClient.setQueryData(['playlist-infinite', playlistType, playlistId], (old: any) => {
          if (!old) return old;
          const updatedPages = [...old.pages];
          updatedPages[0] = { ...updatedPages[0], metadata: { ...updatedPages[0].metadata, likeStatus: newStatus } };
          return { ...old, pages: updatedPages };
        });
        showToast(newStatus === 'LIKE' ? 'Added to library' : 'Removed from library', 'success');
      }
      setIsHeaderActionLoading(null);
    } else if (type === 'pin' && playlistMetadata?.menu_tokens) {
      if (isHeaderActionLoading) return;
      setIsHeaderActionLoading('pin');
      const isPinned = playlistMetadata.isPinned;
      const token = isPinned ? playlistMetadata.menu_tokens.unpin : playlistMetadata.menu_tokens.pin;
      if (token) {
        const success = await sendFeedback(token);
        if (success) {
          queryClient.setQueryData(['playlist-infinite', playlistType, playlistId], (old: any) => {
            if (!old) return old;
            const updatedPages = [...old.pages];
            updatedPages[0] = { ...updatedPages[0], metadata: { ...updatedPages[0].metadata, isPinned: !isPinned } };
            return { ...old, pages: updatedPages };
          });
          showToast(!isPinned ? 'Pinned to Home' : 'Unpinned from Home', 'success');
          queryClient.invalidateQueries({ queryKey: ['home'] });
        }
      }
      setIsHeaderActionLoading(null);
    } else if (type === 'rename') setIsRenameOpen(true);
    else if (type === 'delete') setIsDeleteOpen(true);
  }, [playlistMetadata, isHeaderActionLoading, onSelectArtist, playlistType, playlistId, queryClient, showToast]);

  const onConfirmRename = useCallback(async (newTitle: string) => {
    setIsRenameOpen(false);
    if (playlistMetadata?.id && newTitle && newTitle !== playlistMetadata.title) {
      setIsHeaderActionLoading('rename');
      const success = await editPlaylist(playlistMetadata.id, { title: newTitle });
      if (success) {
        showToast('Playlist renamed', 'success');
        queryClient.invalidateQueries({ queryKey: ['library-playlists'] });
        queryClient.setQueryData(['playlist-infinite', playlistType, playlistId], (old: any) => {
          if (!old) return old;
          const updatedPages = [...old.pages];
          updatedPages[0] = { ...updatedPages[0], metadata: { ...updatedPages[0].metadata, title: newTitle } };
          return { ...old, pages: updatedPages };
        });
      } else showToast('Failed to rename playlist', 'error');
      setIsHeaderActionLoading(null);
    }
  }, [playlistMetadata, playlistType, playlistId, queryClient, showToast]);

  const onConfirmDelete = useCallback(async () => {
    setIsDeleteOpen(false);
    if (playlistMetadata?.id) {
      setIsHeaderActionLoading('delete');
      const success = await deletePlaylist(playlistMetadata.id);
      if (success) {
        showToast('Playlist deleted', 'success');
        queryClient.invalidateQueries({ queryKey: ['library-playlists'] });
        onSelectHome();
      } else showToast('Failed to delete playlist', 'error');
      setIsHeaderActionLoading(null);
    }
  }, [playlistMetadata, queryClient, showToast, onSelectHome]);

  const viewTitle = playlistMetadata?.title || 'Loading...';
  const viewLabel = playlistMetadata?.type || 'PLAYLIST';
  // Query loading is initial-fetch only; keep cached albums visible during refresh or app initialization.
  const showSkeletons = isDeckAlbum ? isPlaylistLoading : isPlaylistLoading || isInitializing;
  const isAlbumLoading = isDeckAlbum && showSkeletons;
  const mergedLikedTracks = useMemo(() => {
    if (showSkeletons && !isDeckAlbum) return Array(20).fill({});
    if (!isLikedSongsView || yandexLikedTracks.length === 0) return playlistTracks;
    // Оба списка уже отсортированы по дате лайка (свежие сверху), поэтому сливаем их
    // слиянием, а не склейкой -- иначе весь Яндекс оказывался в хвосте под YouTube.
    // У YT-треков даты в этом списке нет: держим их порядок, подставляя дату
    // ближайшего датированного соседа сверху.
    const merged: YTMTrack[] = [];
    let i = 0, j = 0;
    let ytDate = ytLikedAt.get(playlistTracks[0]?.id) ?? Number.MAX_SAFE_INTEGER;
    while (i < playlistTracks.length && j < yandexLikedTracks.length) {
      ytDate = ytLikedAt.get(playlistTracks[i].id) ?? ytDate;
      if (ytDate >= (yandexLikedTracks[j].likedAt ?? 0)) merged.push(playlistTracks[i++]);
      else merged.push(yandexLikedTracks[j++]);
    }
    return [...merged, ...playlistTracks.slice(i), ...yandexLikedTracks.slice(j)];
  }, [showSkeletons, isDeckAlbum, playlistTracks, isLikedSongsView, yandexLikedTracks, ytLikedAt]);

  // Доступные источники: выключенная интеграция не должна ни показывать свою кнопку,
  // ни оставлять свои треки в списке (в кэше лайков они остаются и после отключения).
  const likedSources = useMemo<TrackSource[]>(
    () => ['youtube', ...(scEnabled ? ['soundcloud' as const] : []), ...(yandexEnabled ? ['yandex' as const] : [])],
    [scEnabled, yandexEnabled],
  );

  // Фильтруем всегда по пересечению выбранного с доступным: раньше стояла отсечка
  // "выбрано >= доступно -> не фильтровать", и при выключенном SoundCloud сохранённый
  // выбор из трёх источников перекрывал два доступных -- фильтр не срабатывал вовсе.
  const effectiveLikedSources = useMemo(
    () => likedSources.filter(s => activeLikedSources.includes(s)),
    [likedSources, activeLikedSources],
  );

  const displayTracks = useMemo(() => {
    if (!isLikedSongsView || showSkeletons) return mergedLikedTracks;
    return mergedLikedTracks.filter((t: YTMTrack) => effectiveLikedSources.includes(resolveSource(t.source)));
  }, [mergedLikedTracks, isLikedSongsView, showSkeletons, effectiveLikedSources]);
  // Source filters and cached tracks describe the table, not the YouTube import.
  const likedCountLabel = isLikedSongsView ? mirrorLabel ?? `${displayTracks.length} songs` : null;

  const handleContextMenu = useCallback((e: any, track: any) => trackMenuRef.current?.open(e, track), []);
  const handlePlayTrack = useCallback((idx: number) => player.playTrackList(displayTracks, idx, playlistId || playlistType), [displayTracks, playlistId, playlistType]);

  const stopAutoScroll = useCallback(() => {
    if (autoScrollRaf.current !== null) {
      cancelAnimationFrame(autoScrollRaf.current);
      autoScrollRaf.current = null;
    }
  }, []);

  const handleDragStart = useCallback((idx: number) => {
    if (!isEditable) return;
    setDraggedIdx(idx);
  }, [isEditable]);

  const handleDragOverContainer = useCallback((e: React.DragEvent) => {
    if (draggedIdx === null || !scrollerRef.current) return;
    e.preventDefault();
    const rect = scrollerRef.current.getBoundingClientRect();
    const mouseY = e.clientY - rect.top;
    let scrollVelocity = 0;
    if (mouseY < AUTO_SCROLL_THRESHOLD) scrollVelocity = -MAX_SCROLL_SPEED * (1 - mouseY / AUTO_SCROLL_THRESHOLD);
    else if (mouseY > rect.height - AUTO_SCROLL_THRESHOLD) scrollVelocity = MAX_SCROLL_SPEED * (1 - (rect.height - mouseY) / AUTO_SCROLL_THRESHOLD);
    stopAutoScroll();
    if (scrollVelocity !== 0) {
      const performScroll = () => {
        if (scrollerRef.current) {
          scrollerRef.current.scrollTop += scrollVelocity;
          autoScrollRaf.current = requestAnimationFrame(performScroll);
        }
      };
      autoScrollRaf.current = requestAnimationFrame(performScroll);
    }
  }, [draggedIdx, stopAutoScroll]);

  const handleDragOverItem = useCallback((idx: number) => {
    if (draggedIdx === null || draggedIdx === idx) return;
    setDragOverIdx(idx);
  }, [draggedIdx]);

  const handleDrop = useCallback(async (targetIdx: number) => {
    stopAutoScroll();
    if (draggedIdx === null || draggedIdx === targetIdx || !isEditable || !playlistId) {
      setDraggedIdx(null);
      setDragOverIdx(null);
      return;
    }
    const sourceIdx = draggedIdx;
    setDraggedIdx(null);
    setDragOverIdx(null);
    const source = playlistTracks[sourceIdx]?.setVideoId;
    const target = playlistTracks[targetIdx];
    if (!source || !target?.setVideoId) {
      showToast('Playlist entry unavailable', 'error');
      return;
    }
    setMovingTrack(true);
    try {
      let successor = sourceIdx > targetIdx ? target : playlistTracks[targetIdx + 1];
      if (!successor && hasNextPage) {
        // The last loaded entry is not necessarily the end of the playlist.
        const next = await fetchNextPage({ cancelRefetch: false });
        const entries: YTMTrack[] = next.data?.pages.flatMap(page => page.tracks) ?? [];
        const position = entries.findIndex(entry => entry.setVideoId === target.setVideoId);
        if (position === -1 || !entries[position + 1]) {
          showToast('Load more playlist tracks before moving here', 'error');
          return;
        }
        successor = entries[position + 1];
      }
      if ((successor && !successor.setVideoId) || (!successor && totalReportedCount > playlistTracks.length)) {
        showToast('Playlist entry unavailable', 'error');
        return;
      }
      const success = await editPlaylist(playlistId, {
        moveItem: successor?.setVideoId ? [source, successor.setVideoId] : source
      });
      if (!success) throw new Error('Playlist edit rejected');
      // Keep the server's page boundaries and never publish a rejected move.
      await queryClient.invalidateQueries({ queryKey: playlistQueryKey(playlistType, playlistId), exact: true });
      showToast('Playlist reordered', 'success');
    } catch {
      showToast('Failed to move track', 'error');
    } finally {
      setMovingTrack(false);
    }
  }, [draggedIdx, isEditable, playlistId, playlistTracks, hasNextPage, fetchNextPage, totalReportedCount, queryClient, playlistType, showToast, stopAutoScroll]);

  const virtuosoComponents = useMemo(() => ({
    Scroller: isDeck ? undefined : VirtuosoScroller,
    Header: () => <div style={{ height: HEADER_HEIGHT, pointerEvents: 'none' }} />,
    Table: VirtuosoTable,
    TableHead: VirtuosoTableHead,
    TableRow: VirtuosoTableRow,
    TableFooter: VirtuosoFooter
  }), [isDeck]);

  const virtuosoContext = useMemo(() => ({
    isDeck, isSearch, showSkeletons, tracks: displayTracks, totalReportedCount, isSyncing, isFetchingNextPage, isSticky, likedCountLabel,
    onScroll: handleScroll, onPlay: handlePlayTrack, onContextMenu: handleContextMenu,
    metadata: playlistMetadata, handleHeaderAction, isHeaderActionLoading,
    headerRef, tableRef, scrollerRef, user, playlistType, isEditable, draggedIdx, dragOverIdx,
    onDragStart: handleDragStart, onDragOverItem: handleDragOverItem, onDragOverContainer: handleDragOverContainer,
    onDrop: handleDrop, stopAutoScroll, sortMode, setSortMode, isSorting,
    isLikedSongsView, likedSources, activeLikedSources: effectiveLikedSources, onToggleLikedSource: handleToggleLikedSource
  }), [
    isDeck, isSearch, showSkeletons, displayTracks, totalReportedCount, isSyncing, isFetchingNextPage, isSticky, likedCountLabel,
    handleScroll, handlePlayTrack, handleContextMenu, playlistMetadata,
    handleHeaderAction, isHeaderActionLoading, user, playlistType, isEditable, draggedIdx,
    dragOverIdx, handleDragStart, handleDragOverItem, handleDragOverContainer, handleDrop, stopAutoScroll, sortMode, setSortMode, isSorting,
    isLikedSongsView, likedSources, effectiveLikedSources, handleToggleLikedSource
  ]);

  if (isSearch) return <SearchView searchQuery={activeView.searchQuery || ''} onSelectArtist={onSelectArtist} onSelectAlbum={onSelectAlbum} onSelectPlaylist={onSelectPlaylist} onSearchAgain={onSearchAgain} />;
  if (!isAuthenticated && !isInitializing) return null;

  return (
    <div
      className={isDeckAlbum ? `${styles.container} ${styles.deckAlbum}` : styles.container}
      style={isDeck ? {
        '--virtual-track-height': `${DECK_COLLECTION_TRACK_HEIGHT}px`,
        '--album-art': isDeckAlbum && playlistMetadata?.thumbUrl ? `url(${JSON.stringify(playlistMetadata.thumbUrl)})` : undefined,
      } as React.CSSProperties : undefined}
    >
      <StickyTitlePanel isVisible={isSticky} isDeckAlbum={isDeckAlbum} metadata={playlistMetadata} playlistTracks={playlistTracks} totalReportedCount={totalReportedCount} likedCountLabel={likedCountLabel} isFetchingNextPage={isSyncing} viewLabel={viewLabel} viewTitle={viewTitle} />
      <div
        className={isDeck ? `${styles.virtuosoWrapper} deck-scroll` : styles.virtuosoWrapper}
        data-collection-scroll={isDeck ? playlistType : undefined}
        data-testid={isAlbumLoading ? 'album-skeleton' : undefined}
        aria-busy={isDeckAlbum ? !!showSkeletons : undefined}
        role={isAlbumLoading ? 'status' : undefined}
        aria-label={isAlbumLoading ? 'Loading album' : undefined}
        ref={isDeck ? attachDeckScroller : undefined}
        onDragOver={isDeck ? handleDragOverContainer : undefined}
      >
        {isDeck && <LargeHeader {...virtuosoContext} />}
        {(!isDeck || deckScroller) && <TableVirtuoso
          key={sortMode}
          ref={virtuosoRef} 
          customScrollParent={isDeck ? deckScroller ?? undefined : undefined}
          className={isDeckAlbum ? styles.albumTrackSurface : undefined}
          style={isDeck ? undefined : { height: '100%' }}
          data={isAlbumLoading ? undefined : displayTracks}
          totalCount={isAlbumLoading ? ALBUM_PREVIEW_ROWS : displayTracks.length}
          initialItemCount={isAlbumLoading ? ALBUM_PREVIEW_ROWS : 0}
          context={virtuosoContext} 
          components={virtuosoComponents} 
          overscan={400} 
          increaseViewportBy={500} 
          fixedItemHeight={isDeck ? DECK_COLLECTION_TRACK_HEIGHT : 56}
          endReached={() => { if (hasNextPage && !isFetchingNextPage) fetchNextPage(); }} 
          computeItemKey={(index, track) => track?.setVideoId || track?.id || index}
          itemContent={(index, track) => track && <RenderTrackRow index={index} track={track} hideAlbum={playlistType === 'album'} onSelectArtist={onSelectArtist} onSelectAlbum={onSelectAlbum} />}
        />}
      </div>
      <TrackContextMenu ref={trackMenuRef} onSelectArtist={onSelectArtist} onSelectAlbum={onSelectAlbum} onSelectPlaylist={onSelectPlaylist} playlistId={playlistId || undefined} isOwnedPlaylist={!!playlistMetadata?.owned} />
      <InputDialog isOpen={isRenameOpen} title="Rename Playlist" defaultValue={playlistMetadata?.title} onConfirm={onConfirmRename} onCancel={() => setIsRenameOpen(false)} />
      <ConfirmDialog isOpen={isDeleteOpen} title="Delete Playlist" message={`Are you sure you want to delete "${playlistMetadata?.title}"? This action cannot be undone.`} confirmLabel="Delete" isDanger={true} onConfirm={onConfirmDelete} onCancel={() => setIsDeleteOpen(false)} />
    </div>
  );
});
