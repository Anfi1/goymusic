import React, { useEffect, useState, useCallback } from 'react';
import { ArrowLeft, Disc } from 'lucide-react';
import { MediaCard } from '../molecules/MediaCard';
import { MediaCardSkeleton } from '../molecules/MediaCardSkeleton';
import { getYandexGenreStations, getYandexWaveTracks, YandexGenreStation } from '../../api/yandex';
import { player } from '../../api/player';
import styles from './YandexGenreView.module.css';

interface YandexGenreViewProps {
  genreId: string;
  genreTitle?: string;
  onBack?: () => void;
}

export const YandexGenreView: React.FC<YandexGenreViewProps> = ({ genreId, genreTitle, onBack }) => {
  const [stations, setStations] = useState<YandexGenreStation[] | null>(null);

  useEffect(() => {
    let alive = true;
    setStations(null);
    getYandexGenreStations(genreId).then(s => { if (alive) setStations(s); });
    return () => { alive = false; };
  }, [genreId]);

  const playStation = useCallback(async (id: string) => {
    const tracks = await getYandexWaveTracks(id);
    if (tracks.length) player.playTrackList(tracks, 0, id);
  }, []);

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        {onBack && (
          <button className={styles.backBtn} onClick={onBack}>
            <ArrowLeft size={20} />
          </button>
        )}
        <Disc size={24} className={styles.icon} />
        <h1>{genreTitle || 'Genre'}</h1>
      </div>

      {stations === null ? (
        <div className={styles.grid}>
          {Array.from({ length: 8 }).map((_, i) => <MediaCardSkeleton key={i} />)}
        </div>
      ) : stations.length === 0 ? (
        <div className={styles.emptyState}>
          <div className={styles.emptyText}>Станции не найдены</div>
        </div>
      ) : (
        <div className={styles.grid}>
          {stations.map((s) => (
            <MediaCard
              key={s.id}
              id={s.id}
              title={s.title}
              thumbUrl={s.thumbUrl}
              type="playlist"
              onClick={() => playStation(s.id)}
              onPlayClick={() => playStation(s.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
};
