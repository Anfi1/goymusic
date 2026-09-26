import React, { forwardRef } from 'react';
import { Skeleton } from '../atoms/Skeleton';
import styles from './TrackRow.module.css'; // Reuse table row layout styles

interface TrackRowSkeletonProps {
    index: number;
    hideAlbum?: boolean;
}

export const TrackRowSkeleton = forwardRef<HTMLTableRowElement, TrackRowSkeletonProps>(({ index, hideAlbum }, ref) => {
    return (
        <tr
            ref={ref}
            className={`${styles.row} animate-slide-up`}
            style={{ animationDelay: `${(index % 12) * 0.03}s` }}
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
            <td colSpan={hideAlbum ? 1 : 2} className={styles.metaCell}>
                <div className={styles.durationWrapper}>
                    {!hideAlbum && <div style={{ flex: 1 }}><Skeleton width="60%" height={16} borderRadius={4} /></div>}
                    <Skeleton width={32} height={16} borderRadius={4} />
                </div>
            </td>
        </tr>
    );
});

TrackRowSkeleton.displayName = 'TrackRowSkeleton';
