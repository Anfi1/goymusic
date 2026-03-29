import React, { memo } from 'react';
import { Check, X, AlertCircle } from 'lucide-react';
import styles from './YandexTrackRow.module.css';

export interface YandexTrackItem {
    title: string;
    artist: string;
    durationMs: number | null;
    status: 'matched' | 'not_found' | 'error';
}

function formatDuration(ms: number | null): string {
    if (!ms) return '';
    const secs = Math.round(ms / 1000);
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
}

function StatusIcon({ status }: { status: YandexTrackItem['status'] }) {
    if (status === 'matched') return <Check size={13} className={styles.matched} />;
    if (status === 'not_found') return <X size={13} className={styles.notFound} />;
    return <AlertCircle size={13} className={styles.error} />;
}

export const YandexTrackRow: React.FC<{ track: YandexTrackItem; index: number }> = memo(({ track, index }) => (
    <div className={styles.row}>
        <span className={styles.index}>{index + 1}</span>
        <div className={styles.info}>
            <span className={styles.title}>{track.title || '—'}</span>
            <span className={styles.artist}>{track.artist}</span>
        </div>
        <span className={styles.duration}>{formatDuration(track.durationMs)}</span>
        <StatusIcon status={track.status} />
    </div>
));
