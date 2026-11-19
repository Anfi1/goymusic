import React from 'react';
import { Skeleton } from '../atoms/Skeleton';
import styles from './MediaCard.module.css';

interface MediaCardSkeletonProps {
  variant?: 'card' | 'row';
  className?: string;
}

export const MediaCardSkeleton: React.FC<MediaCardSkeletonProps> = ({ variant = 'card', className = '' }) => (
  <div aria-hidden="true" className={`${styles.card} ${variant === 'row' ? styles.row : ''} ${styles.skeleton} ${className}`}>
    <div className={styles.thumbWrapper}>
      <Skeleton width="100%" height="100%" borderRadius="inherit" />
    </div>
    <div className={styles.info}>
      <div className={styles.title}><Skeleton width="76%" height=".65em" /></div>
      <div className={styles.subtitle}><Skeleton width="50%" height=".65em" /></div>
    </div>
  </div>
);
