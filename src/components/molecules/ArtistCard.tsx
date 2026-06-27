import React from 'react';
import { LazyImage } from '../atoms/LazyImage';
import { SourceBadge } from '../atoms/SourceBadge';
import { resolveSource } from '../../api/source';
import styles from './ArtistCard.module.css';

interface ArtistCardProps {
  id: string;
  name: string;
  thumbUrl?: string;
  source?: unknown;
  onClick?: () => void;
}

/**
 * Molecule: ArtistCard
 * A card-based display for artists, featuring a circular thumbnail and name.
 * Adheres to the glassmorphic theme.
 */
export const ArtistCard: React.FC<ArtistCardProps> = ({ id, name, thumbUrl, source, onClick }) => {
  const isSc = resolveSource(source) === 'soundcloud';
  return (
    <div className={styles.card} onClick={onClick}>
      <div style={{ position: 'relative', display: 'inline-block' }}>
        <div className={styles.thumbnailWrapper}>
          <LazyImage
            src={thumbUrl || ''}
            alt={name}
            className={styles.thumbnail}
            placeholder={<div className={styles.thumbnailPlaceholder} />}
          />
        </div>
        {/* Бейдж вне overflow:hidden-обёртки, чтобы круг его не обрезал */}
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
      <div className={styles.name}>{name}</div>
    </div>
  );
};
