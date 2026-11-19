import React, { forwardRef } from 'react';
import { Skeleton } from '../atoms/Skeleton';
import styles from './TrackRow.module.css'; // Reuse table row layout styles

interface TrackRowSkeletonProps extends React.HTMLAttributes<HTMLTableRowElement> {
    index: number;
    hideAlbum?: boolean;
    albumPreview?: boolean;
}

const albumTitleWidths = ['min(74%, 16rem)', 'min(54%, 11rem)', 'min(83%, 19rem)', 'min(62%, 13rem)', 'min(70%, 15rem)'];

export const TrackRowSkeleton = forwardRef<HTMLTableRowElement, TrackRowSkeletonProps>(({ index, hideAlbum, albumPreview, className, style, ...rowProps }, ref) => {
    return (
        <tr
            {...rowProps}
            ref={ref}
            aria-hidden="true"
            className={`${styles.row} ${albumPreview ? '' : 'animate-slide-up'} ${className ?? ''}`}
            style={albumPreview ? style : { ...style, animationDelay: `${(index % 12) * 0.03}s` }}
        >
            <td className={styles.indexCell}>
                <div className={styles.indexWrapper}>
                    <Skeleton width={albumPreview ? 9 : 16} height={albumPreview ? 10 : 16} borderRadius={4} />
                </div>
            </td>
            <td className={styles.titleTd}>
                <div className={styles.titleCell}>
                    <Skeleton borderRadius={4} className={styles.thumb} />
                    <div className={styles.titleWrapper}>
                        <Skeleton width={albumPreview ? albumTitleWidths[index % albumTitleWidths.length] : '60%'} height={albumPreview ? 11 : 16} borderRadius={4} />
                        <Skeleton width={albumPreview ? 'min(42%, 6.5rem)' : '40%'} height={albumPreview ? 8 : 14} borderRadius={4} style={albumPreview ? { marginTop: 5 } : undefined} />
                    </div>
                </div>
            </td>
            <td colSpan={hideAlbum ? 1 : 2} className={styles.metaCell}>
                <div className={styles.durationWrapper}>
                    {!hideAlbum && <div style={{ flex: 1 }}><Skeleton width="60%" height={16} borderRadius={4} /></div>}
                    <Skeleton width={32} height={albumPreview ? 10 : 16} borderRadius={4} />
                </div>
            </td>
        </tr>
    );
});

TrackRowSkeleton.displayName = 'TrackRowSkeleton';
