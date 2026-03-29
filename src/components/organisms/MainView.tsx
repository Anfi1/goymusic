import React, { useState, useEffect, useRef, useCallback, useMemo, memo, Fragment } from 'react';
import { TableVirtuoso, VirtuosoHandle } from 'react-virtuoso';
import { useQueryClient } from '@tanstack/react-query';
import { TrackRow } from '../molecules/TrackRow';
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
import { usePlaylist, PlaylistType } from '../../hooks/usePlaylist';
import { likedManager } from '../../api/likedManager';
import { ActiveView } from '../../types';
import { useToast } from '../atoms/Toast';
import { SearchView } from './SearchView';
import { 
  Loader2, Heart, Share2, Globe, Lock, Clock, Pencil, Trash2, Pin, PinOff, ArrowDownAZ, Calendar
} from 'lucide-react';
import { openImageViewer } from '../molecules/ImageViewer';

import { IconButton } from '../atoms/IconButton';

import { InputDialog } from '../molecules/InputDialog';
import { ConfirmDialog } from '../molecules/ConfirmDialog';
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

const HEADER_HEIGHT = 320;
const STICKY_THRESHOLD = 160;
const AUTO_SCROLL_THRESHOLD = 100;
const MAX_SCROLL_SPEED = 12;

const ColumnGroup = memo(() => (
  <colgroup>
    <col style={{ width: 48 }} />
    <col style={{ width: '45%' }} />
    <col style={{ width: '35%' }} />
    <col style={{ width: 100 }} />
  </colgroup>
));

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
    {context && !context.isSearch && (
      <LargeHeader 
        metadata={context.metadata}
        tracks={context.tracks}
        totalReportedCount={context.totalReportedCount}
        showSkeletons={context.showSkeletons}
        isFetchingNextPage={context.isSyncing}
        handleHeaderAction={context.handleHeaderAction}
        isHeaderActionLoading={context.isHeaderActionLoading}
        headerRef={context.headerRef}
        playlistType={context.playlistType}
        sortMode={context.sortMode}
        setSortMode={context.setSortMode}
        isSorting={context.isSorting}
      />
    )}
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
    style={{ 
      ...props.style, 
      borderCollapse: 'collapse', 
      zIndex: 2, 
      position: 'relative',
      transform: context?.isSearch ? 'none' : `translate3d(0, ${HEADER_HEIGHT}px, 0)`,
      background: 'var(--bg-main)',
      tableLayout: 'fixed',
      willChange: 'transform'
    }}
  >
    <ColumnGroup />
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

  if (context.showSkeletons) return <TrackRowSkeleton {...rest} ref={ref} index={props['data-index']} />;
  
  const index = props['data-index'];
  const isAvailable = track?.isAvailable !== false;
  
  return (
    <tr 
      {...rest}
      ref={ref}
      className={`${trackStyles.row} ${isActive ? trackStyles.active : ''} ${!isAvailable ? trackStyles.unavailable : ''} ${context.draggedIdx === index ? styles.draggingRow : ''} ${context.dragOverIdx === index ? styles.dropTarget : ''}`} 
      onClick={isAvailable ? () => context.onPlay(index) : undefined}
      onContextMenu={(e) => { e.preventDefault(); context.onContextMenu(e, track); }}
      draggable={context.isEditable}
      onDragStart={() => context.onDragStart(index)}
      onDragOver={(e) => { 
        e.preventDefault(); 
        e.dataTransfer.dropEffect = 'move';
        context.onDragOverItem?.(index);
      }}
      onDragLeave={() => context.onDragOverItem?.(null)}
      onDragEnd={() => { 
        context.onDragStart(null); 
        context.onDragOverItem?.(null);
        context.stopAutoScroll();
      }}
      onDrop={() => context.onDrop(index)}
      style={{ ...rest.style, cursor: context.isEditable ? 'grab' : (isAvailable ? 'pointer' : 'default') }}
    />
  );
}));

const VirtuosoFooter = memo(({ context }: any) => (
  <tfoot>
    {context.isSyncing && (
      <tr>
        <td colSpan={4}>
          <div className={styles.loadMoreIndicator} style={{ padding: '2rem', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '12px' }}>
            <Loader2 className="animate-spin" size={20} />
            <span style={{ fontSize: '13px', fontWeight: 600 }}>Syncing library...</span>
          </div>
        </td>
      </tr>
    )}
  </tfoot>
));

const LargeHeader = memo(({ 
  metadata, tracks, totalReportedCount, showSkeletons, 
  isFetchingNextPage, handleHeaderAction, isHeaderActionLoading, 
  headerRef, playlistType, sortMode, setSortMode, isSorting
}: any) => {
  const { showToast } = useToast();
  
  const handleShare = useCallback(() => {
    const url = `https://music.youtube.com/browse/${metadata?.id}`;
    navigator.clipboard.writeText(url);
    showToast('Link copied to clipboard', 'success');
  }, [metadata?.id, showToast]);

  const handleZoomCover = useCallback((e: React.MouseEvent) => {
    if (!metadata?.thumbUrl) return;
    e.stopPropagation();
    openImageViewer(metadata.thumbUrl, metadata.title);
  }, [metadata]);

  const isLikedSongs = playlistType === 'liked' || metadata?.id === 'LM';
  const isAlbum = !!(metadata?.type?.match(/ALBUM|SINGLE|EP/i));
  const isPlaylist = !isAlbum && !isLikedSongs;
  const isOwned = !!metadata?.owned;

  const targetRatingId = metadata?.audioPlaylistId || metadata?.id;
  const displayCount = showSkeletons ? '...' : 
    (tracks.length >= totalReportedCount || !totalReportedCount) ? `${tracks.length} songs` : `${tracks.length} of ${totalReportedCount}`;

  const description = isLikedSongs ? 'Your private collection of favorite tracks' : metadata?.description;

  return (
    <div ref={headerRef} className={styles.header} style={{ height: HEADER_HEIGHT }}>
      <div className={styles.coverWrapper}>
        <div 
          className={`${styles.coverContainer} ${!showSkeletons ? styles.zoomable : ''}`}
          onClick={!showSkeletons ? handleZoomCover : undefined}
        >
          {showSkeletons ? (
            <Skeleton width="100%" height="100%" />
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
        {!showSkeletons && (
          <div className={styles.statsUnderCover}>
            {metadata?.year && <div className={styles.yearUnder}>{metadata.year}</div>}
            <div className={styles.trackCountUnder}>{displayCount}</div>
          </div>
        )}
      </div>

      <div className={styles.info}>
        {showSkeletons ? (
          <>
            <div style={{ marginBottom: '12px' }}><Skeleton width={120} height={14} borderRadius={4} /></div>
            <Skeleton width="80%" height={60} borderRadius={8} />
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
                  data-tooltip={isFetchingNextPage ? 'Syncing library...' : (sortMode === 'date' ? 'Sorted by Date' : 'Sorted by Album')}
                >
                  {sortMode === 'date' ? <Calendar size={14} /> : <ArrowDownAZ size={14} />}
                  <span>{sortMode === 'date' ? 'By Date' : 'By Album'}</span>
                </div>
              )}
            </div>

            <h1 className={styles.title} data-tooltip={metadata?.title} data-tooltip-overflow="">{metadata?.title}</h1>
            
            {description && (
              <div className={styles.descriptionText} data-tooltip={description} data-tooltip-overflow="">
                {description}
              </div>
            )}

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
                  {metadata.duration && (
                    <div className={styles.durationTag}>
                      <Clock size={12} />
                      {metadata.duration}
                    </div>
                  )}
                </div>

                <div className={styles.headerActions}>
                  {targetRatingId && (metadata.likeStatus === 'LIKE' || !isOwned) && (
                    <IconButton
                      icon={Heart}
                      size={42}
                      iconSize={20}
                      active={metadata.likeStatus === 'LIKE'}
                      isLoading={isHeaderActionLoading === 'like'}
                      onClick={() => handleHeaderAction('like')}
                      title={metadata.likeStatus === 'LIKE' ? 'Remove from library' : 'Save to library'}
                      color={metadata.likeStatus === 'LIKE' ? '#ff4b4b' : undefined}
                      fill={metadata.likeStatus === 'LIKE' ? '#ff4b4b' : 'none'}
                    />
                  )}
                  {!isLikedSongs && metadata.menu_tokens && (
                    <IconButton
                      icon={metadata.isPinned ? PinOff : Pin}
                      size={42}
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
                        size={42}
                        iconSize={20}
                        onClick={() => handleHeaderAction('rename')}
                        title="Rename Playlist"
                      />
                      <IconButton
                        icon={Trash2}
                        size={42}
                        iconSize={20}
                        onClick={() => handleHeaderAction('delete')}
                        title="Delete Playlist"
                        className={styles.dangerAction}
                      />
                    </>
                  )}
                  {!isLikedSongs && (
                    <IconButton icon={Share2} size={42} iconSize={20} onClick={handleShare} title="Copy Link" />
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
  isVisible, metadata, playlistTracks, totalReportedCount, isFetchingNextPage, viewLabel, viewTitle
}: any) => {
  const coverUrl = metadata?.thumbUrl || (playlistTracks[0]?.thumbUrl || '');
  
  return (
    <div className={`${styles.stickyHeaderContainer} ${isVisible ? styles.isSticky : ''}`}>
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
            <div className={styles.stickyLabel}>{viewLabel}</div>
            <div className={styles.stickyMainTitle}>
              {viewTitle}
              <span className={styles.stickyTrackCount}> • {playlistTracks.length} of {totalReportedCount}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});

const RenderTrackRow = memo(({ index, track, onSelectArtist, onSelectAlbum }: any) => (
  <TrackRow 
    index={index + 1} {...track}
    renderOnlyCells={true}
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

  const headerRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const trackMenuRef = useRef<TrackContextMenuHandle>(null);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const autoScrollRaf = useRef<number | null>(null);

  const isSearch = activeView.type === 'search';
  const playlistType: PlaylistType = useMemo(() => activeView.type === 'liked' ? 'liked' : (activeView.type === 'album' ? 'album' : 'playlist'), [activeView.type]);
  const playlistId = activeView.playlistId || activeView.albumId;

  const {
    tracks: playlistTracks, metadata: playlistMetadata, totalReportedCount,
    isLoading: isPlaylistLoading, hasNextPage, isFetchingNextPage, fetchNextPage, syncPlayerQueue,
    sortMode, setSortMode, isSorting
  } = usePlaylist(playlistType, playlistId);

  const isSyncing = (playlistType === 'liked' || playlistId === 'LM') ? (likedManager.isSyncing || isFetchingNextPage) : isFetchingNextPage;

  const isEditable = useMemo(() => 
    playlistMetadata?.owned && playlistType === 'playlist' && playlistId !== 'LM'
  , [playlistMetadata?.owned, playlistType, playlistId]);

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
  const showSkeletons = isPlaylistLoading || isInitializing;
  const displayTracks = useMemo(() => showSkeletons ? Array(20).fill({}) : playlistTracks, [showSkeletons, playlistTracks]);

  const handleContextMenu = useCallback((e: any, track: any) => trackMenuRef.current?.open(e, track), []);
  const handlePlayTrack = useCallback((idx: number) => player.playTrackList(playlistTracks, idx, playlistId || playlistType), [playlistTracks, playlistId, playlistType]);

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
    const sourceTrack = playlistTracks[sourceIdx];
    let successorTrack = sourceIdx > targetIdx ? playlistTracks[targetIdx] : playlistTracks[targetIdx + 1];
    if (!sourceTrack.setVideoId) return;
    queryClient.setQueryData(['playlist-infinite', playlistType, playlistId], (old: any) => {
      if (!old || !old.pages) return old;
      const allTracks = old.pages.flatMap((p: any) => p.tracks);
      const [moved] = allTracks.splice(sourceIdx, 1);
      allTracks.splice(targetIdx, 0, moved);
      const updatedPages = [...old.pages];
      updatedPages[0] = { ...updatedPages[0], tracks: allTracks };
      for (let i = 1; i < updatedPages.length; i++) updatedPages[i] = { ...updatedPages[i], tracks: [] };
      return { ...old, pages: updatedPages };
    });
    try {
      const success = await editPlaylist(playlistId, { moveItem: [sourceTrack.setVideoId, successorTrack ? successorTrack.setVideoId! : null] as any });
      if (success) showToast('Playlist reordered', 'success');
      else {
        showToast('Failed to move track', 'error');
        queryClient.invalidateQueries({ queryKey: ['playlist-infinite', playlistType, playlistId] });
      }
    } catch (e) {
      showToast('Error moving track', 'error');
      queryClient.invalidateQueries({ queryKey: ['playlist-infinite', playlistType, playlistId] });
    }
  }, [draggedIdx, isEditable, playlistId, playlistTracks, queryClient, playlistType, showToast, stopAutoScroll]);

  const virtuosoComponents = useMemo(() => ({
    Scroller: VirtuosoScroller,
    Header: () => <div style={{ height: HEADER_HEIGHT, pointerEvents: 'none' }} />,
    Table: VirtuosoTable,
    TableHead: VirtuosoTableHead,
    TableRow: VirtuosoTableRow,
    TableFooter: VirtuosoFooter
  }), []);

  const virtuosoContext = useMemo(() => ({
    isSearch, showSkeletons, tracks: playlistTracks, totalReportedCount, isSyncing,
    onScroll: handleScroll, onPlay: handlePlayTrack, onContextMenu: handleContextMenu,
    metadata: playlistMetadata, handleHeaderAction, isHeaderActionLoading,
    headerRef, tableRef, scrollerRef, user, playlistType, isEditable, draggedIdx, dragOverIdx,
    onDragStart: handleDragStart, onDragOverItem: handleDragOverItem, onDragOverContainer: handleDragOverContainer,
    onDrop: handleDrop, stopAutoScroll, sortMode, setSortMode, isSorting
  }), [
    isSearch, showSkeletons, playlistTracks, totalReportedCount, isSyncing,
    handleScroll, handlePlayTrack, handleContextMenu, playlistMetadata, 
    handleHeaderAction, isHeaderActionLoading, user, playlistType, isEditable, draggedIdx,
    dragOverIdx, handleDragStart, handleDragOverItem, handleDragOverContainer, handleDrop, stopAutoScroll, sortMode, setSortMode, isSorting
  ]);

  if (isSearch) return <SearchView searchQuery={activeView.searchQuery || ''} onSelectArtist={onSelectArtist} onSelectAlbum={onSelectAlbum} onSelectPlaylist={onSelectPlaylist} onSearchAgain={onSearchAgain} />;
  if (!isAuthenticated && !isInitializing) return null;

  return (
    <div className={styles.container} style={{ perspective: '1000px', isolation: 'isolate' }}>
      <StickyTitlePanel isVisible={isSticky} metadata={playlistMetadata} playlistTracks={playlistTracks} totalReportedCount={totalReportedCount} isFetchingNextPage={isSyncing} viewLabel={viewLabel} viewTitle={viewTitle} />
      <div className={styles.virtuosoWrapper}>
        <TableVirtuoso 
          key={sortMode}
          ref={virtuosoRef} 
          style={{ height: '100%' }} 
          data={displayTracks} 
          context={virtuosoContext} 
          components={virtuosoComponents} 
          overscan={400} 
          increaseViewportBy={500} 
          fixedItemHeight={56}
          endReached={() => { if (hasNextPage && !isFetchingNextPage) fetchNextPage(); }} 
          computeItemKey={(index, track) => track.id || index}
          itemContent={(index, track) => <RenderTrackRow index={index} track={track} onSelectArtist={onSelectArtist} onSelectAlbum={onSelectAlbum} />} 
        />
      </div>
      <TrackContextMenu ref={trackMenuRef} onSelectArtist={onSelectArtist} onSelectAlbum={onSelectAlbum} onSelectPlaylist={onSelectPlaylist} playlistId={playlistId || undefined} isOwnedPlaylist={!!playlistMetadata?.owned} />
      <InputDialog isOpen={isRenameOpen} title="Rename Playlist" defaultValue={playlistMetadata?.title} onConfirm={onConfirmRename} onCancel={() => setIsRenameOpen(false)} />
      <ConfirmDialog isOpen={isDeleteOpen} title="Delete Playlist" message={`Are you sure you want to delete "${playlistMetadata?.title}"? This action cannot be undone.`} confirmLabel="Delete" isDanger={true} onConfirm={onConfirmDelete} onCancel={() => setIsDeleteOpen(false)} />
    </div>
  );
});
