import React from 'react';
import { LazyImage } from '../atoms/LazyImage';
import { SourceBadge } from '../atoms/SourceBadge';
import { CheckCircle } from 'lucide-react';
import { resolveSource } from '../../api/source';
import styles from './ArtistCard.module.css';

interface ArtistCardProps {
  id: string;
  name: string;
  thumbUrl?: string;
  source?: unknown;
  artistPro?: boolean;
  verified?: boolean;
  onClick?: () => void;
}

/**
 * Molecule: ArtistCard
 * A card-based display for artists, featuring a circular thumbnail and name.
 * Adheres to the glassmorphic theme.
 */
export const ArtistCard: React.FC<ArtistCardProps> = ({ id, name, thumbUrl, source, artistPro, verified, onClick }) => {
  const isSc = resolveSource(source) === 'soundcloud';
  return (
    <div className={styles.card} onClick={onClick}>
      <div className={styles.thumbnailWrapper}>
        <LazyImage
          src={thumbUrl || ''}
          alt={name}
          className={styles.thumbnail}
          placeholder={<div className={styles.thumbnailPlaceholder} />}
        />
        {isSc && (
          <div
            style={{
              position: 'absolute', right: 2, bottom: 6,
              background: 'rgba(0,0,0,0.7)', border: '1px solid rgba(255,255,255,0.25)',
              borderRadius: '50%', padding: 3, display: 'flex', lineHeight: 0,
            }}
          >
            <SourceBadge source={source} size={14} />
          </div>
        )}
      </div>
      <div className={styles.badgesRow}>
        {artistPro && <span className="pro-badge pro-badge--absolute" data-tooltip="Artist PRO"><span>★</span></span>}
        {verified && <CheckCircle className={`verified-badge ${styles.verifiedSmall}`} data-tooltip="Verified" />}
      </div>
      <div className={styles.name}>{name}</div>
    </div>
  );
};
