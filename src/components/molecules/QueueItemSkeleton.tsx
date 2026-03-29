import React from 'react';
import { Skeleton } from '../atoms/Skeleton';
import styles from './QueueItem.module.css';

/**
 * <summary>
 * Скелетон для элемента очереди воспроизведения.
 * </summary>
 */
export const QueueItemSkeleton: React.FC = () => {
  return (
    <div className={styles.item} style={{ pointerEvents: 'none' }}>
      <div className={styles.coverWrapper}>
        <Skeleton width="100%" height="100%" borderRadius={4} />
      </div>
      <div className={styles.info}>
        <div style={{ marginBottom: '6px' }}>
          <Skeleton width="80%" height={14} borderRadius={4} />
        </div>
        <Skeleton width="50%" height={12} borderRadius={4} />
      </div>
    </div>
  );
};
