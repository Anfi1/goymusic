import React, { forwardRef } from 'react';
import { Skeleton } from '../atoms/Skeleton';
import styles from './TrackRow.module.css'; // Reuse table row layout styles

interface TrackRowSkeletonProps {
    index: number;
}

export const TrackRowSkeleton = forwardRef<HTMLTableRowElement, TrackRowSkeletonProps>(({ index }, ref) => {
    return (
        <tr
            ref={ref}
            className={`${styles.row} animate-slide-up`}
            style={{ animationDelay: `${index * 0.03}s` }}
        >
            <td className={styles.indexCell}>
                <div className={styles.indexWrapper}>
                    <Skeleton width={16} height={16} borderRadius={4} />
                </div>
            </td>
            <td className={styles.titleTd}>
                <div className={styles.titleCell}>
                    <Skeleton width={40} height={40} borderRadius={4} className={styles.thumb} />
                    <div className={styles.titleWrapper}>
                        <Skeleton width="60%" height={16} borderRadius={4} />
                        <Skeleton width="40%" height={14} borderRadius={4} />
                    </div>
                </div>
            </td>
            <td className={styles.album}>
                <Skeleton width="80%" height={16} borderRadius={4} />
            </td>
            <td className="text-right" style={{ paddingRight: 24 }}>
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <Skeleton width={32} height={16} borderRadius={4} />
                </div>
            </td>
        </tr>
    );
});

TrackRowSkeleton.displayName = 'TrackRowSkeleton';
