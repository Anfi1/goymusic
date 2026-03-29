import React, { useState, useEffect } from 'react';
import { Play, Pin, Loader2 } from 'lucide-react';
import { LazyImage } from '../atoms/LazyImage';
import { Visualizer } from '../atoms/Visualizer';
import { player } from '../../api/player';
import styles from './MediaCard.module.css';

export interface MediaCardProps {
  id: string;
  title: string;
  thumbUrl: string;
  type?: string;
  display_type?: string;
  artists?: string[];
  artistIds?: string[];
  year?: string;
  description?: string;
  category?: string;
  audioPlaylistId?: string;
  playlistId?: string;
  isPinned?: boolean;
  isLoading?: boolean;
  isActive?: boolean;
  onClick: () => void;
  onPlayClick?: () => Promise<void> | void;
  onArtistClick?: (id: string) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  round?: boolean;
  variant?: 'card' | 'row';
  className?: string;
}

export const MediaCard: React.FC<MediaCardProps> = React.memo(({
  id,
  title,
  thumbUrl,
  type,
  display_type,
  artists,
  artistIds,
  year,
  description,
  category,
  audioPlaylistId,
  playlistId,
  isPinned,
  isLoading: propIsLoading,
  isActive: propIsActive,
  onClick,
  onPlayClick,
  onArtistClick,
  onContextMenu,
  round,
  variant = 'card',
  className = ''
}) => {
  const isArtist = type === 'artist' || round;
  const [isLocalLoading, setIsLocalLoading] = useState(false);
  const [isActiveState, setIsActiveState] = useState(false);

  useEffect(() => {
    if (propIsActive !== undefined) return;
    
    const checkActive = () => {
      const active = player.queueSourceId === id || player.currentTrack?.id === id;
      if (active !== isActiveState) {
        setIsActiveState(active);
      }
    };
    
    checkActive();
    
    return player.subscribe((e) => {
      if (e === 'tick') return;
      checkActive();
    });
  }, [id, propIsActive, isActiveState]);

  const isLoading = propIsLoading || isLocalLoading;
  const isActive = propIsActive !== undefined ? propIsActive : isActiveState;

  const handlePlayAction = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onPlayClick || isLoading) return;
    
    try {
      setIsLocalLoading(true);
      await onPlayClick();
    } finally {
      setIsLocalLoading(false);
    }
  };

  const renderArtists = () => {
    if (!artists || artists.length === 0) return null;

    return artists.map((name, index) => {
      const artistId = artistIds?.[index];
      const isLast = index === artists.length - 1;

      if (artistId && onArtistClick) {
        return (
          <React.Fragment key={index}>
            <span 
              className={styles.artistLink}
              onClick={(e) => {
                e.stopPropagation();
                onArtistClick(artistId);
              }}
            >
              {name}
            </span>
            {!isLast && ", "}
          </React.Fragment>
        );
      }

      return (
        <React.Fragment key={index}>
          {name}
          {!isLast && ", "}
        </React.Fragment>
      );
    });
  };

  // Combine metadata for the subtitle line
  const renderSubtitle = () => {
    const parts: React.ReactNode[] = [];
    
    const dType = display_type || category;
    if (dType && variant === 'card') {
      parts.push(<span key="type" className={styles.typeTag}>{dType}</span>);
    }

    if (artists && artists.length > 0) {
      if (parts.length > 0) parts.push(" • ");
      parts.push(<span key="artists">{renderArtists()}</span>);
    } else if (description) {
      if (parts.length > 0) parts.push(" • ");
      parts.push(description);
    }

    if (year && variant === 'card') {
      if (parts.length > 0) parts.push(" • ");
      parts.push(<span key="year">{year}</span>);
    }

    return parts.length > 0 ? parts : null;
  };

  return (
    <div 
      className={`${styles.card} ${styles[variant]} ${isActive ? styles.active : ''} ${isLoading ? styles.loading : ''} ${className}`} 
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      <div className={styles.thumbWrapper}>
        <LazyImage 
          src={thumbUrl} 
          alt={title} 
          className={`${styles.thumb} ${isArtist ? styles.round : ''}`}
          placeholder={<div className={styles.thumbPlaceholder} />}
        />
        {isPinned && (
          <div className={styles.pinnedBadge} data-tooltip="Pinned">
            <Pin size={14} fill="currentColor" />
          </div>
        )}
        
        {isActive && !isLoading && !isArtist && (
          <div className={styles.activeOverlay}>
            <Visualizer />
          </div>
        )}

        {!isArtist && onPlayClick && (
          <div 
            className={`${styles.playOverlay} ${isLoading ? styles.isLoading : ''}`} 
            onClick={handlePlayAction}
          >
            {isLoading ? (
              <Loader2 size={24} className={styles.spinner} />
            ) : (
              <Play size={variant === 'row' ? 18 : 24} fill="currentColor" />
            )}
          </div>
        )}
      </div>
      <div className={styles.info}>
        <div className={styles.title} data-tooltip={title} data-tooltip-overflow="">{title}</div>
        <div className={styles.subtitle} data-tooltip={artists && artists.length > 0 ? artists.join(', ') : undefined}>
          {renderSubtitle()}
        </div>
      </div>
    </div>
  );
});
