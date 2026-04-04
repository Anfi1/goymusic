import React, { useState, forwardRef, Fragment, useEffect, memo, useCallback } from 'react';
import { Play, Heart, HeartCrack, Loader2, HardDriveDownload } from 'lucide-react';
import { Visualizer } from '../atoms/Visualizer';
import { LazyImage } from '../atoms/LazyImage';
import { prefetchStreamUrl, cancelPrefetchRequest } from '../../api/stream';
import { rateSong, YTMTrack } from '../../api/yt';
import { player } from '../../api/player';
import { likedManager } from '../../api/likedManager';
import { getOverride, onOverrideChanged } from '../../api/localOverrides';
import styles from './TrackRow.module.css';

interface TrackRowProps {
  id?: string;
  index: number;
  title: string;
  artists?: string[];
  artistIds?: string[];
  album: string;
  albumId?: string;
  duration: string;
  thumbUrl?: string;
  isAvailable?: boolean;
  isActive?: boolean; 
  isPlaying?: boolean;
  likeStatus?: string;
  onClick?: () => void;
  onSelectArtist?: (id: string) => void;
  onSelectAlbum?: (id: string) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
  hideDuration?: boolean;
  className?: string;
  renderOnlyCells?: boolean;
  extraCells?: React.ReactNode[];
}

const MemoizedPlayIcon = memo(() => <Play size={14} className={styles.playIcon} fill="currentColor" />);

// Isolated Playback Indicator - only re-renders itself on player state changes
const PlaybackIndicator = memo(({ id, index, isAvailable, isActive: propIsActive, isPlaying: propIsPlaying }: { id?: string, index: number, isAvailable: boolean, isActive?: boolean, isPlaying?: boolean }) => {
  const [isActive, setIsActive] = useState(player.currentTrack?.id === id);
  const [isPlaying, setIsPlaying] = useState(player.isPlaying);

  useEffect(() => {
    // If props are provided, we don't need to subscribe here
    if (!id || propIsActive !== undefined) return;
    
    return player.subscribe((event) => {
      if (event === 'state') {
        const isMe = player.currentTrack?.id === id;
        const playerPlaying = player.isPlaying;
        
        setIsActive(prev => {
          if (prev !== isMe) return isMe;
          if (isMe) setIsPlaying(playerPlaying);
          return prev;
        });
      }
    });
  }, [id, propIsActive]);

  if (!isAvailable) return <span className={styles.indexText} data-tooltip="Unavailable">!</span>;
  
  const active = propIsActive !== undefined ? propIsActive : isActive;
  const playing = propIsPlaying !== undefined ? propIsPlaying : isPlaying;
  const showVisualizer = active && playing;

  return (
    <>
      {!showVisualizer && <span className={styles.indexText}>{index}</span>}
      <MemoizedPlayIcon />
      {showVisualizer && <div className={styles.visualizerWrapper}><Visualizer trackId={id} /></div>}
    </>
  );
});

// Isolated Like/Dislike Buttons - only re-renders itself on global like events
const LikeButton = memo(({ trackData }: { trackData: any }) => {
  const [likeStatus, setLikeStatus] = useState<string | undefined>(trackData.likeStatus);
  const [loadingAction, setLoadingAction] = useState<'like' | 'dislike' | null>(null);

  useEffect(() => { setLikeStatus(trackData.likeStatus); }, [trackData.likeStatus]);

  useEffect(() => {
    if (!trackData.id) return;
    const handleUpdate = (e: any) => {
      if (e.detail.id === trackData.id) {
        if (e.detail.status === 'success') setLikeStatus(e.detail.likeStatus);
        setLoadingAction(null);
      }
    };
    window.addEventListener('track-like-updated', handleUpdate as EventListener);
    return () => {
      window.removeEventListener('track-like-updated', handleUpdate as EventListener);
    };
  }, [trackData.id]);

  const buildTrackObj = (): YTMTrack => ({
    id: trackData.id,
    title: trackData.title,
    artists: trackData.artists || [],
    artistIds: trackData.artistIds || [],
    album: trackData.album,
    albumId: trackData.albumId,
    duration: trackData.duration,
    thumbUrl: trackData.thumbUrl || '',
    likeStatus: likeStatus as any
  });

  const handleLike = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (loadingAction || !trackData.id) return;
    setLoadingAction('like');
    window.dispatchEvent(new CustomEvent('track-like-start', { detail: { id: trackData.id } }));
    try {
      const newStatus = likeStatus === 'LIKE' ? 'INDIFFERENT' : 'LIKE';
      const success = await likedManager.toggleLike(buildTrackObj(), likeStatus || 'INDIFFERENT');
      if (success) window.dispatchEvent(new CustomEvent('track-like-updated', { detail: { id: trackData.id, status: 'success', likeStatus: newStatus } }));
      else window.dispatchEvent(new CustomEvent('track-like-updated', { detail: { id: trackData.id, status: 'error' } }));
    } catch {
      window.dispatchEvent(new CustomEvent('track-like-updated', { detail: { id: trackData.id, status: 'error' } }));
    }
  }, [trackData, likeStatus, loadingAction]);

  const handleDislike = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (loadingAction || !trackData.id) return;
    setLoadingAction('dislike');
    window.dispatchEvent(new CustomEvent('track-like-start', { detail: { id: trackData.id } }));
    try {
      const newStatus = likeStatus === 'DISLIKE' ? 'INDIFFERENT' : 'DISLIKE';
      const success = await likedManager.toggleDislike(buildTrackObj(), likeStatus || 'INDIFFERENT');
      if (success) window.dispatchEvent(new CustomEvent('track-like-updated', { detail: { id: trackData.id, status: 'success', likeStatus: newStatus } }));
      else window.dispatchEvent(new CustomEvent('track-like-updated', { detail: { id: trackData.id, status: 'error' } }));
    } catch {
      window.dispatchEvent(new CustomEvent('track-like-updated', { detail: { id: trackData.id, status: 'error' } }));
    }
  }, [trackData, likeStatus, loadingAction]);

  const isLiked = likeStatus === 'LIKE';
  const isDisliked = likeStatus === 'DISLIKE';

  return (
    <>
      <button
        className={`${styles.likeBtn} ${isLiked ? styles.isLiked : ''} ${loadingAction === 'like' ? styles.isLiking : ''}`}
        onClick={handleLike}
        disabled={!!loadingAction}
      >
        {loadingAction === 'like' ? (
          <Loader2 size={16} className={styles.spinner} />
        ) : (
          <Heart size={16} color={isLiked ? '#f38ba8' : 'var(--text-sub)'} fill={isLiked ? '#f38ba8' : 'none'} />
        )}
      </button>
      <button
        className={`${styles.likeBtn} ${isDisliked ? styles.isDisliked : ''} ${loadingAction === 'dislike' ? styles.isLiking : ''}`}
        onClick={handleDislike}
        disabled={!!loadingAction}
      >
        {loadingAction === 'dislike' ? (
          <Loader2 size={16} className={styles.spinner} />
        ) : (
          <HeartCrack size={16} color={isDisliked ? '#fab387' : 'var(--text-sub)'} />
        )}
      </button>
    </>
  );
});

const OverrideIndicator = memo(({ id }: { id?: string }) => {
  const [has, setHas] = useState(false);

  useEffect(() => {
    if (!id) { setHas(false); return; }
    let alive = true;
    const refresh = () => {
      getOverride(id).then(o => { if (alive) setHas(!!o); });
    };
    refresh();
    const unlisten = onOverrideChanged((e) => {
      if (e.detail.action === 'reset' || e.detail.videoId === id) refresh();
    });
    return () => { alive = false; unlisten(); };
  }, [id]);

  if (!id || !has) return null;
  return (
    <span data-tooltip="Has local override" style={{ display: 'flex', alignItems: 'center' }}>
      <HardDriveDownload size={14} className={styles.overrideIcon} />
    </span>
  );
});

const ThumbPlaceholder = <div className={styles.thumbPlaceholder} />;

export const TrackRow = memo(forwardRef<HTMLTableRowElement, TrackRowProps>((props, ref) => {
  const { 
    id, index, title, artists = [], artistIds = [], album, albumId, duration, thumbUrl, 
    isAvailable = true, isActive: externalIsActive, isPlaying: externalIsPlaying,
    likeStatus: initialLikeStatus,
    onClick,
    onSelectArtist,
    onSelectAlbum,
    onContextMenu,
    draggable,
    onDragStart,
    onDragOver,
    onDragEnd,
    onDrop,
    hideDuration = false,
    className,
    renderOnlyCells = false,
    extraCells = []
  } = props;

  // Still need active status for row styling, but isolated from playback state
  const [rowActive, setRowActive] = useState(player.currentTrack?.id === id);

  useEffect(() => {
    // If externalIsActive is provided, we don't need to subscribe here for row styling
    if (!id || externalIsActive !== undefined) return;
    return player.subscribe((event) => {
      if (event === 'state') {
        const isMe = player.currentTrack?.id === id;
        setRowActive(prev => (prev !== isMe ? isMe : prev));
      }
    });
  }, [id, externalIsActive]);

  const handleMouseEnter = useCallback(() => {
    if (id && isAvailable) prefetchStreamUrl(id);
  }, [id, isAvailable]);

  const handleMouseLeave = useCallback(() => {
    cancelPrefetchRequest();
  }, []);

  const handleArtistClick = useCallback((e: React.MouseEvent, aid?: string) => {
    if (aid && onSelectArtist) {
      e.stopPropagation();
      onSelectArtist(aid);
    }
  }, [onSelectArtist]);

  const handleAlbumClick = useCallback((e: React.MouseEvent) => {
    if (albumId && onSelectAlbum) {
      e.stopPropagation();
      onSelectAlbum(albumId);
    }
  }, [albumId, onSelectAlbum]);

  const isActive = externalIsActive !== undefined ? externalIsActive : (id ? rowActive : false);

  const cells = (
    <>
      <td className={styles.indexCell}>
        <div className={styles.indexWrapper}>
          <PlaybackIndicator 
            id={id} 
            index={index} 
            isAvailable={isAvailable} 
            isActive={externalIsActive}
            isPlaying={externalIsPlaying}
          />
        </div>
      </td>
      <td className={styles.titleTd}>
        <div className={styles.titleCell}>
          {thumbUrl && (
            <LazyImage
              src={thumbUrl}
              alt=""
              className={styles.thumb}
              placeholder={ThumbPlaceholder}
            />
          )}
          <div className={styles.titleWrapper}>
            <div className={styles.title} data-tooltip={title} data-tooltip-overflow="">{title}</div>
            <div className={styles.artist}>
              {artists.map((artist, i) => {
                const aid = artistIds[i];
                return (
                  <Fragment key={i}>
                    <span className={aid ? styles.link : ''} onClick={(e) => handleArtistClick(e, aid)} data-tooltip={artist} data-tooltip-overflow="">{artist}</span>
                    {i < artists.length - 1 && ', '}
                  </Fragment>
                );
              })}
            </div>
          </div>
        </div>
      </td>
      <td className={styles.album}>
        <span className={`${styles.albumText} ${albumId ? styles.link : ''}`} data-tooltip={album} data-tooltip-overflow="" onClick={handleAlbumClick}>{album}</span>
      </td>
      {extraCells}
      {!hideDuration && (
        <td className={styles.durationCell}>
          <div className={styles.durationWrapper}>
            <OverrideIndicator id={id} />
            {id && <LikeButton trackData={props} />}
            <span className={styles.durationText}>{duration}</span>
          </div>
        </td>
      )}
    </>
  );

  if (renderOnlyCells) return cells;

  return (
    <tr
      ref={ref}
      className={`${styles.row} ${isActive ? styles.active : ''} ${!isAvailable ? styles.unavailable : ''} ${className || ''}`}
      onClick={!isAvailable ? undefined : onClick}
      onContextMenu={onContextMenu}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDrop={onDrop}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {cells}
    </tr>
  );
}));

TrackRow.displayName = 'TrackRow';
