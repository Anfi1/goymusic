import React from 'react';
import { LazyImage } from '../atoms/LazyImage';
import styles from './ArtistCard.module.css';

interface ArtistCardProps {
  id: string;
  name: string;
  thumbUrl?: string;
  onClick?: () => void;
}

/**
 * Molecule: ArtistCard
 * A card-based display for artists, featuring a circular thumbnail and name.
 * Adheres to the glassmorphic theme.
 */
export const ArtistCard: React.FC<ArtistCardProps> = ({ id, name, thumbUrl, onClick }) => {
  return (
    <div className={styles.card} onClick={onClick}>
      <div className={styles.thumbnailWrapper}>
        <LazyImage 
          src={thumbUrl || ''} 
          alt={name} 
          className={styles.thumbnail}
          placeholder={<div className={styles.thumbnailPlaceholder} />}
        />
      </div>
      <div className={styles.name}>{name}</div>
    </div>
  );
};
