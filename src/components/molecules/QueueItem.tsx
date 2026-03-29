import { likedManager } from '../../api/likedManager';
import React, { useState, useEffect, useCallback, memo } from 'react';
import { Play, Pause, Heart, Loader2, HardDriveDownload } from 'lucide-react';
import { Visualizer } from '../atoms/Visualizer';
import { YTMTrack } from '../../api/yt';
import { player } from '../../api/player';
import { getOverride, onOverrideChanged } from '../../api/localOverrides';
import styles from './QueueItem.module.css';

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
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent, index?: number) => void;
  onDragEnd?: (e: React.DragEvent, index?: number) => void;
  className?: string;
  trackData?: any;
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

const LikeButton = memo(({ id, initialLikeStatus, trackData }: { id: string, initialLikeStatus?: string, trackData?: any }) => {
  const [likeStatus, setLikeStatus] = useState(initialLikeStatus);
  const [isLiking, setIsLiking] = useState(false);

  useEffect(() => { setLikeStatus(initialLikeStatus); }, [initialLikeStatus]);

  useEffect(() => {
    const handleGlobalLikeUpdated = (e: any) => {
      if (e.detail.id === id && e.detail.status === 'success') {
        setLikeStatus(e.detail.likeStatus);
        setIsLiking(false);
      }
      if (e.detail.id === id && e.detail.status === 'error') {
        setIsLiking(false);
      }
    };
    const handleGlobalLikeStart = (e: any) => {
      if (e.detail.id === id) setIsLiking(true);
    };

    window.addEventListener('track-like-updated', handleGlobalLikeUpdated as EventListener);
    window.addEventListener('track-like-start', handleGlobalLikeStart as EventListener);

    return () => {
      window.removeEventListener('track-like-updated', handleGlobalLikeUpdated as EventListener);
      window.removeEventListener('track-like-start', handleGlobalLikeStart as EventListener);
    };
  }, [id]);

  const handleLike = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isLiking) return;
    setIsLiking(true);
    try {
      // Пытаемся собрать полный объект трека для менеджера
      const trackObj: YTMTrack = trackData || { id, title: '', artists: [], likeStatus };
      const success = await likedManager.toggleLike(trackObj, likeStatus || 'INDIFFERENT');
      // Событие track-like-updated диспатчится самим менеджером (likedManager)
      // поэтому здесь мы ничего не делаем, useEffect обновит стейт
    } catch {
      setIsLiking(false);
    }
  }, [id, likeStatus, isLiking, trackData]);

  const isLiked = likeStatus === 'LIKE';

  return (
    <button 
      className={`${styles.likeBtn} ${isLiked ? styles.isLiked : ''} ${isLiking ? styles.isLiking : ''}`} 
      onClick={handleLike} 
      disabled={isLiking}
      data-tooltip={isLiked ? "Unlike" : "Like"}
    >
      {isLiking ? <Loader2 size={14} className={styles.spinner} /> : <Heart size={14} color={isLiked ? '#f38ba8' : 'var(--text-sub)'} fill={isLiked ? '#f38ba8' : 'none'} />}
    </button>
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
  trackData
}) => {

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

  return (
    <div
      className={`${styles.item} ${isActive ? styles.active : ''} ${className || ''}`}
      onClick={handleItemClick}
      onContextMenu={handleContext}
      draggable={draggable}
      onDragStart={handleDragStartInternal}
    >
      <div className={styles.coverWrapper}>
        {thumbUrl ? <img src={thumbUrl} alt="" className={styles.cover} /> : <div className={styles.cover} />}
        <PlaybackOverlay id={id} isActive={isActive} />
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
        <LikeButton id={id} initialLikeStatus={initialLikeStatus} trackData={trackData} />
        {duration && <div className={styles.duration}>{duration}</div>}
      </div>
    </div>
  );
});

QueueItem.displayName = 'QueueItem';
