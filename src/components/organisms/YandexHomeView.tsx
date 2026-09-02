import React, { useEffect, useState, useCallback } from 'react';
import { player } from '../../api/player';
import { MediaCard } from '../molecules/MediaCard';
import { MediaCardSkeleton } from '../molecules/MediaCardSkeleton';
import { getYandexWaveTracks, getYandexNewReleases, getYandexAlbumTracks, YandexAlbumResult } from '../../api/yandex';
import styles from './HomeView.module.css';

// Лёгкая «Главная» на данных Yandex Music: волна + новинки. Отдельный компонент,
// а не ветка внутри HomeView — чтобы не путать его инфинит-скролл/пагинацию YT-ленты.
export const YandexHomeView: React.FC = () => {
  const [waveTracks, setWaveTracks] = useState<any[] | null>(null);
  const [releases, setReleases] = useState<YandexAlbumResult[] | null>(null);

  useEffect(() => {
    let alive = true;
    getYandexWaveTracks().then(t => { if (alive) setWaveTracks(t); });
    getYandexNewReleases().then(r => { if (alive) setReleases(r); });
    return () => { alive = false; };
  }, []);

  const playWave = useCallback(() => {
    if (waveTracks && waveTracks.length > 0) player.playTrackList(waveTracks, 0, 'yandex-wave');
  }, [waveTracks]);

  const playAlbum = useCallback(async (albumId: string) => {
    const detail = await getYandexAlbumTracks(albumId);
    if (detail?.tracks?.length) player.playTrackList(detail.tracks, 0, albumId, 'album');
  }, []);

  return (
    <div className={styles.container}>
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <div className={styles.sectionTitleWrapper}>
            <span style={{ marginLeft: 12, fontWeight: 700, fontSize: 20 }}>Яндекс: Моя волна</span>
          </div>
        </div>
        {waveTracks === null ? (
          <div className={styles.horizontalScroll}>
            {Array.from({ length: 6 }).map((_, i) => <MediaCardSkeleton key={i} className={styles.card} />)}
          </div>
        ) : waveTracks.length === 0 ? (
          <div style={{ padding: '8px 12px', opacity: 0.6 }}>Не удалось загрузить волну.</div>
        ) : (
          <div className={styles.horizontalScroll}>
            {waveTracks.slice(0, 20).map((t) => (
              <MediaCard
                key={t.id}
                id={t.id}
                title={t.title}
                thumbUrl={t.thumbUrl}
                artists={t.artists}
                type="song"
                className={styles.card}
                onClick={playWave}
                onPlayClick={playWave}
              />
            ))}
          </div>
        )}
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <div className={styles.sectionTitleWrapper}>
            <span style={{ marginLeft: 12, fontWeight: 700, fontSize: 20 }}>Яндекс: Новинки</span>
          </div>
        </div>
        {releases === null ? (
          <div className={styles.horizontalScroll}>
            {Array.from({ length: 6 }).map((_, i) => <MediaCardSkeleton key={i} className={styles.card} />)}
          </div>
        ) : releases.length === 0 ? (
          <div style={{ padding: '8px 12px', opacity: 0.6 }}>Не удалось загрузить новинки.</div>
        ) : (
          <div className={styles.horizontalScroll}>
            {releases.map((a) => (
              <MediaCard
                key={a.albumId}
                id={a.albumId}
                title={a.title}
                thumbUrl={a.thumbUrl}
                artists={a.artist ? [a.artist] : []}
                year={a.year ? String(a.year) : undefined}
                type="album"
                className={styles.card}
                onClick={() => playAlbum(a.albumId)}
                onPlayClick={() => playAlbum(a.albumId)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
};
