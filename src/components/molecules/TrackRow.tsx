import React, { useState, forwardRef, Fragment, useEffect, memo, useCallback } from 'react';
import { Play, Pause, Heart, HeartCrack, Loader2, HardDriveDownload, Zap, Headphones } from 'lucide-react';
import { Visualizer } from '../atoms/Visualizer';
import { LazyImage } from '../atoms/LazyImage';
import { requestPrefetch, cancelPrefetchRequest } from '../../api/stream';
import { YTMTrack } from '../../api/yt';
import { player } from '../../api/player';
import { likedManager } from '../../api/likedManager';
import { getOverride, onOverrideChanged } from '../../api/localOverrides';
import styles from './TrackRow.module.css';
import { SourceBadge } from '../atoms/SourceBadge';
import { resolveSource } from '../../api/source';
import { formatStatValue } from '../../utils/formatStatValue';

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
  hideDislike?: boolean;
  hideAlbum?: boolean;
  className?: string;
  renderOnlyCells?: boolean;
  extraCells?: React.ReactNode[];
  source?: unknown;
  yandexId?: string;
  yandexAlbumId?: string;
  best?: boolean;
  tier?: 'hot' | 'top';
  views?: string;
}

const MemoizedPlayIcon = memo(() => <Play size={14} className={styles.playIcon} fill="currentColor" />);
// Клик по играющей строке ставит паузу, значит и иконка при наведении должна быть паузой.
const MemoizedPauseIcon = memo(() => <Pause size={14} className={styles.playIcon} fill="currentColor" />);

// Isolated Playback Indicator - only re-renders itself on player state changes
const PlaybackIndicator = memo(({ id, index, isAvailable, isActive: propIsActive, isPlaying: propIsPlaying }: { id?: string, index: number, isAvailable: boolean, isActive?: boolean, isPlaying?: boolean }) => {
  const [isActive, setIsActive] = useState(player.currentTrack?.id === id);
  const [isPlaying, setIsPlaying] = useState(player.isPlaying);

  useEffect(() => {
    // If props are provided, we don't need to subscribe here
    if (!id || propIsActive !== undefined) return;
    
    return player.subscribe((event) => {
      if (event !== 'state') return;
      const isMe = player.currentTrack?.id === id;
      // Раньше isPlaying обновлялся побочным эффектом внутри апдейтера isActive и
      // пропускался ровно в тот момент, когда строка становилась активной -- из-за
      // этого состояние воспроизведения у строки залипало.
      setIsActive(prev => (prev !== isMe ? isMe : prev));
      setIsPlaying(prev => {
        const next = isMe && player.isPlaying;
        return prev !== next ? next : prev;
      });
    });
  }, [id, propIsActive]);

  if (!isAvailable) return <span className={styles.indexText} data-tooltip="Unavailable">!</span>;
  
  const active = propIsActive !== undefined ? propIsActive : isActive;
  const playing = propIsPlaying !== undefined ? propIsPlaying : isPlaying;
  const showVisualizer = active && playing;

  return (
    <>
      {!showVisualizer && <span className={styles.indexText}>{index}</span>}
      {showVisualizer ? <MemoizedPauseIcon /> : <MemoizedPlayIcon />}
      {showVisualizer && <div className={styles.visualizerWrapper}><Visualizer trackId={id} /></div>}
    </>
  );
});

// Isolated Like/Dislike Buttons - only re-renders itself on global like events
const LikeButton = memo(({ trackData, hideDislike }: { trackData: any, hideDislike?: boolean }) => {
  const [likeStatus, setLikeStatus] = useState<string | undefined>(trackData.likeStatus);
  const [loadingAction, setLoadingAction] = useState<'like' | 'dislike' | null>(null);

  useEffect(() => { setLikeStatus(trackData.likeStatus); }, [trackData.id, trackData.likeStatus]);

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
    likeStatus: likeStatus as any,
    source: (trackData as any).source,
    scUrl: (trackData as any).scUrl,
    scId: (trackData as any).scId,
    yandexId: (trackData as any).yandexId,
    yandexAlbumId: (trackData as any).yandexAlbumId,
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
      {!hideDislike && <button
        className={`${styles.likeBtn} ${isDisliked ? styles.isDisliked : ''} ${loadingAction === 'dislike' ? styles.isLiking : ''}`}
        onClick={handleDislike}
        disabled={!!loadingAction}
      >
        {loadingAction === 'dislike' ? (
          <Loader2 size={16} className={styles.spinner} />
        ) : (
          <HeartCrack size={16} color={isDisliked ? '#fab387' : 'var(--text-sub)'} />
        )}
      </button>}
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

// Общая раскладка таблиц треков: название забирает всё свободное место.
// Внутри альбома колонка альбома не нужна -- её место тоже уходит названию.
export const TrackColumnGroup = memo(({ hideAlbum }: { hideAlbum?: boolean }) => (
  <colgroup>
    <col style={{ width: 40 }} />
    <col />
    {!hideAlbum && <col style={{ width: '25%' }} />}
    <col style={{ width: 112 }} />
  </colgroup>
));

export const TrackRow = memo(forwardRef<HTMLTableRowElement, TrackRowProps>((props, ref) => {
  const { 
    id, index, title, artists = [], artistIds = [], album, albumId, duration, thumbUrl,
    isAvailable = true, isActive: externalIsActive, isPlaying: externalIsPlaying,
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
    hideDislike = false,
    hideAlbum = false,
    className,
    renderOnlyCells = false,
    extraCells = [],
    source,
    best,
    tier,
    views
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
    if (id && isAvailable) requestPrefetch(id);
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

  // Клик по уже играющей/активной строке — пауза/резюм вместо перезапуска трека.
  const handleRowClick = useCallback(() => {
    if (isActive) player.togglePlay();
    else onClick?.();
  }, [isActive, onClick]);

  const albumText = !hideAlbum && (
    <span className={`${styles.albumText} ${albumId ? styles.link : ''}`} data-tooltip={album} data-tooltip-overflow="" onClick={handleAlbumClick}>{album}</span>
  );

  const durationContent = (
    <>
      <OverrideIndicator id={id} />
      {id && <div className={styles.likeBtnGroup}><LikeButton trackData={props} hideDislike={hideDislike || resolveSource(source) === 'soundcloud' || resolveSource(source) === 'yandex'} /></div>}
      {best && (
        <Zap
          size={14}
          className={`${styles.bestBadge} ${tier ? styles[tier] : ''}`}
          fill={tier ? 'currentColor' : 'none'}
          data-tooltip={tier === 'top' ? 'Top hit' : tier === 'hot' ? 'Hit' : 'Popular'}
        />
      )}
      <span className={styles.durationText}>{duration}</span>
    </>
  );

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
            <div style={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}>
              <LazyImage
                src={thumbUrl}
                alt=""
                className={styles.thumb}
                placeholder={ThumbPlaceholder}
              />
              {(resolveSource(source) === 'soundcloud' || resolveSource(source) === 'yandex') && (
                <div style={{ position: 'absolute', right: 2, bottom: 2, background: 'rgba(0,0,0,0.55)', borderRadius: 4, padding: '1px 2px', display: 'flex', lineHeight: 0 }}>
                  <SourceBadge source={source} size={12} />
                </div>
              )}
            </div>
          )}
          <div className={styles.titleWrapper}>
            <div className={styles.titleLine}>
              <div className={styles.title} data-tooltip={title} data-tooltip-overflow="">{title}</div>
            </div>
            <div className={styles.subLine}>
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
              {views && (
                <span className={styles.plays} data-tooltip="Plays">
                  <Headphones size={11} />
                  {formatStatValue(views)}
                </span>
              )}
            </div>
          </div>
        </div>
      </td>
      {extraCells.length > 0 ? (
        <>
          <td className={styles.album}>{albumText}</td>
          {extraCells}
          {!hideDuration && (
            <td className={styles.durationCell}>
              <div className={styles.durationWrapper}>{durationContent}</div>
            </td>
          )}
        </>
      ) : (
        // альбом и время в одной ячейке: название альбома доходит до кнопок лайка
        // и занимает их место, пока они скрыты
        <td colSpan={hideAlbum ? 1 : 2} className={styles.metaCell}>
          <div className={styles.durationWrapper}>
            {albumText}
            {!hideDuration && durationContent}
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
      onClick={!isAvailable ? undefined : handleRowClick}
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
