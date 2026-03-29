import React, { useState, useEffect } from 'react';
import { player } from '../../api/player';
import styles from './Visualizer.module.css';

interface VisualizerProps {
    trackId?: string; // Optional: if provided, only play if this track is the one playing
}

export const Visualizer: React.FC<VisualizerProps> = ({ trackId }) => {
    const isCurrentTrack = !trackId || player.currentTrack?.id === trackId;
    const [isPlaying, setIsPlaying] = useState(player.isPlaying && isCurrentTrack);

    useEffect(() => {
        const update = (event: any) => {
            if (event === 'tick') return;
            const nowPlaying = player.isPlaying && (!trackId || player.currentTrack?.id === trackId);
            if (nowPlaying !== isPlaying) {
                setIsPlaying(nowPlaying);
            }
        };

        return player.subscribe(update);
    }, [trackId, isPlaying]);

    return (
        <div className={`${styles.visualizer} ${isPlaying ? styles.playing : ''}`}>
            <span className={styles.bar}></span>
            <span className={styles.bar}></span>
            <span className={styles.bar}></span>
        </div>
    );
};
