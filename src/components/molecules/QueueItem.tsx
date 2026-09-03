import { likedManager } from '../../api/likedManager';
import React, { useState, useEffect, useCallback, memo } from 'react';
import { Play, Pause, Heart, HeartCrack, Loader2, HardDriveDownload, Music2 } from 'lucide-react';
import { Visualizer } from '../atoms/Visualizer';
import { YTMTrack } from '../../api/yt';
import { player } from '../../api/player';
import { getOverride, onOverrideChanged } from '../../api/localOverrides';
import { requestPrefetch, cancelPrefetchRequest } from '../../api/stream';
import styles from './QueueItem.module.css';
import { SourceBadge } from '../atoms/SourceBadge';
import { resolveSource } from '../../api/source';

interface QueueItemProps {
  id: string;
  index?: number;
  title: string;
  artists?: string[];
  artistIds?: string[];
  thumbUrl?: string;
  duration?: string;
  likeStatus?: string;
  isActive?: boolean;
  onClick?: (index?: number) => void;
  onContextMenu?: (e: React.MouseEvent, track: any, index?: number) => void;
  onSelectArtist?: (id: string) => void;
  onSelectAlbum?: (id: string) => void;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent, index?: number) => void;
  onDragEnd?: (e: React.DragEvent, index?: number) => void;
  className?: string;
  trackData?: any;
  hideDislike?: boolean;
  source?: unknown;
}

const PlaybackOverlay = memo(({ id, isActive }: { id: string, isActive: boolean }) => {
  const [isPlaying, setIsPlaying] = useState(player.isPlaying && player.currentTrack?.id === id);

  useEffect(() => {
    return player.subscribe((event) => {
      if (event === 'state') {
        setIsPlaying(player.isPlaying && player.currentTrack?.id === id);
      }
    });
  }, [id]);

  return (
    <>
      <div className={styles.playOverlay}>
        {isActive && isPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
      </div>
      {isActive && <div className={styles.playingOverlay}><Visualizer trackId={id} /></div>}
    </>
  );
});

const LikeButton = memo(({ id, initialLikeStatus, trackData, hideDislike }: { id: string, initialLikeStatus?: string, trackData?: any, hideDislike?: boolean }) => {
  const [likeStatus, setLikeStatus] = useState(initialLikeStatus);
  const [loadingAction, setLoadingAction] = useState<'like' | 'dislike' | null>(null);

  useEffect(() => { setLikeStatus(initialLikeStatus); }, [initialLikeStatus]);

  useEffect(() => {
    const handleGlobalLikeUpdated = (e: any) => {
      if (e.detail.id === id) {
        if (e.detail.status === 'success') setLikeStatus(e.detail.likeStatus);
        setLoadingAction(null);
      }
    };
    window.addEventListener('track-like-updated', handleGlobalLikeUpdated as EventListener);
    return () => {
      window.removeEventListener('track-like-updated', handleGlobalLikeUpdated as EventListener);
    };
  }, [id]);

  const getTrackObj = (): YTMTrack => trackData || { id, title: '', artists: [], likeStatus };

  const handleLike = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (loadingAction) return;
    setLoadingAction('like');
    try {
      await likedManager.toggleLike(getTrackObj(), likeStatus || 'INDIFFERENT');
    } catch {
      setLoadingAction(null);
    }
  }, [id, likeStatus, loadingAction, trackData]);

  const handleDislike = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (loadingAction) return;
    setLoadingAction('dislike');
    try {
      await likedManager.toggleDislike(getTrackObj(), likeStatus || 'INDIFFERENT');
    } catch {
      setLoadingAction(null);
    }
  }, [id, likeStatus, loadingAction, trackData]);

  const isLiked = likeStatus === 'LIKE';
  const isDisliked = likeStatus === 'DISLIKE';

  return (
    <>
      <button
        className={`${styles.likeBtn} ${isLiked ? styles.isLiked : ''} ${loadingAction === 'like' ? styles.isLiking : ''}`}
        onClick={handleLike}
        disabled={!!loadingAction}
        data-tooltip={isLiked ? 'Unlike' : 'Like'}
      >
        {loadingAction === 'like' ? <Loader2 size={14} className={styles.spinner} /> : <Heart size={14} color={isLiked ? '#f38ba8' : 'var(--text-sub)'} fill={isLiked ? '#f38ba8' : 'none'} />}
      </button>
      {!hideDislike && <button
        className={`${styles.likeBtn} ${isDisliked ? styles.isDisliked : ''} ${loadingAction === 'dislike' ? styles.isLiking : ''}`}
        onClick={handleDislike}
        disabled={!!loadingAction}
        data-tooltip={isDisliked ? 'Remove dislike' : 'Dislike'}
      >
        {loadingAction === 'dislike' ? <Loader2 size={14} className={styles.spinner} /> : <HeartCrack size={14} color={isDisliked ? '#fab387' : 'var(--text-sub)'} />}
      </button>}
    </>
  );
});

const OverrideIndicator = memo(({ id }: { id: string }) => {
  const [has, setHas] = useState(false);
  useEffect(() => {
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
  if (!has) return null;
  return <HardDriveDownload size={12} className={styles.overrideIcon} />;
});

export const QueueItem: React.FC<QueueItemProps> = memo(({
  id,
  index,
  title,
  artists = [],
  artistIds = [],
  thumbUrl,
  duration,
  likeStatus: initialLikeStatus,
  isActive = false,
  onClick,
  onContextMenu,
  onSelectArtist,
  draggable,
  onDragStart,
  className,
  trackData,
  hideDislike,
  source
}) => {
  const [imgError, setImgError] = useState(false);

  const handleItemClick = useCallback(() => {
    if (isActive) player.togglePlay();
    else onClick?.(index);
  }, [isActive, onClick, index]);

  const handleContext = useCallback((e: React.MouseEvent) => {
    onContextMenu?.(e, trackData, index);
  }, [onContextMenu, trackData, index]);

  const handleDragStartInternal = useCallback((e: React.DragEvent) => {
    onDragStart?.(e, index);
  }, [onDragStart, index]);

  const handleMouseEnter = useCallback(() => {
    if (id && !isActive) requestPrefetch(id);
  }, [id, isActive]);

  const handleMouseLeave = useCallback(() => {
    cancelPrefetchRequest();
  }, []);

  return (
    <div
      className={`${styles.item} ${isActive ? styles.active : ''} ${className || ''}`}
      onClick={handleItemClick}
      onContextMenu={handleContext}
      draggable={draggable}
      onDragStart={handleDragStartInternal}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div className={styles.coverWrapper} style={{ position: 'relative' }}>
        {thumbUrl && !imgError ? (
          <img src={thumbUrl} alt="" className={styles.cover} onError={() => setImgError(true)} />
        ) : (
          <div className={styles.cover} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.2)' }}>
            {!thumbUrl ? null : <Music2 size={18} />}
          </div>
        )}
        <PlaybackOverlay id={id} isActive={isActive} />
        {(resolveSource(source) === 'soundcloud' || resolveSource(source) === 'yandex') && (
          <div style={{ position: 'absolute', right: 2, bottom: 2, background: 'rgba(0,0,0,0.55)', borderRadius: 4, padding: '1px 2px', display: 'flex', lineHeight: 0 }}>
            <SourceBadge source={source} size={12} />
          </div>
        )}
      </div>
      
      <div className={styles.info}>
        <div className={styles.title} data-tooltip={title} data-tooltip-overflow="">{title}</div>
        <div className={styles.artist} data-tooltip={artists.join(', ')} data-tooltip-overflow="">
          {artists.map((name, i) => {
            const aid = artistIds[i];
            return (
              <React.Fragment key={i}>
                <span
                  className={aid && onSelectArtist ? styles.link : ''}
                  onClick={aid && onSelectArtist ? (e) => { e.stopPropagation(); onSelectArtist(aid); } : undefined}
                >{name}</span>
                {i < artists.length - 1 && ', '}
              </React.Fragment>
            );
          })}
        </div>
      </div>

      <div className={styles.rightSection}>
        <OverrideIndicator id={id} />
        <div className={styles.likeBtnGroup}><LikeButton id={id} initialLikeStatus={initialLikeStatus} trackData={trackData} hideDislike={hideDislike || resolveSource(source) === 'soundcloud' || resolveSource(source) === 'yandex'} /></div>
        {duration && <div className={styles.duration}>{duration}</div>}
      </div>
    </div>
  );
});

QueueItem.displayName = 'QueueItem';
