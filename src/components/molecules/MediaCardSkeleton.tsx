import React from 'react';
import { Skeleton } from '../atoms/Skeleton';
import styles from './MediaCard.module.css';

interface MediaCardSkeletonProps {
  variant?: 'card' | 'row';
  className?: string;
}

export const MediaCardSkeleton: React.FC<MediaCardSkeletonProps> = ({ 
  variant = 'card', 
  className = '' 
}) => {
  if (variant === 'row') {
    return (
      <div className={`${styles.card} ${styles.row} ${className}`} style={{ cursor: 'default' }}>
        <div className={styles.thumbWrapper} style={{ width: 48, height: 48, marginBottom: 0 }}>
          <Skeleton width="100%" height="100%" borderRadius={8} />
        </div>
        <div className={styles.info} style={{ flex: 1 }}>
          <Skeleton width="70%" height={14} borderRadius={4} />
          <div style={{ marginTop: 6 }}>
            <Skeleton width="40%" height={12} borderRadius={4} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`${styles.card} ${styles.card} ${className}`} style={{ cursor: 'default' }}>
      <div className={styles.thumbWrapper}>
        <Skeleton width="100%" height="100%" style={{ aspectRatio: '1 / 1' }} borderRadius={8} />
      </div>
      <div className={styles.info}>
        <Skeleton width="90%" height={16} borderRadius={4} />
        <div style={{ marginTop: 8 }}>
          <Skeleton width="60%" height={14} borderRadius={4} />
        </div>
      </div>
    </div>
  );
};
