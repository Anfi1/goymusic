import React, { useEffect, useState, useCallback } from 'react';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { TrackRow } from '../molecules/TrackRow';
import { player } from '../../api/player';
import { getYandexLikedEntries } from '../../api/yandex';
import { likedStore } from '../../api/likedStore';
import { YTMTrack } from '../../api/yt';
import styles from './MainView.module.css';

interface YandexLikesViewProps {
  onBack: () => void;
}

// Отдельный экран лайков Yandex Music (параллельно основному YT «Liked Songs»,
// т.к. это разные библиотеки на разных серверах — общего списка тут быть не может).
export const YandexLikesView: React.FC<YandexLikesViewProps> = ({ onBack }) => {
  const [tracks, setTracks] = useState<YTMTrack[] | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const entries = await getYandexLikedEntries();
      const sorted = [...entries].sort((a, b) => b.likedAt - a.likedAt);
      const hydrated = await likedStore.hydrateYandexTracks(sorted);
      if (alive) setTracks(hydrated.map(h => h.track));
    })();
    return () => { alive = false; };
  }, []);

  const handlePlay = useCallback((idx: number) => {
    if (!tracks) return;
    player.playTrackList(tracks, idx, 'yandex-likes');
  }, [tracks]);

  return (
    <div className={styles.container} style={{ padding: '24px 32px', overflowY: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <button
          onClick={onBack}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 8, border: 'none', cursor: 'pointer', background: 'rgba(255,255,255,0.08)', color: 'var(--text-main, #cdd6f4)', fontSize: 13 }}
        >
          <ArrowLeft size={16} /> Liked Songs
        </button>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Yandex Music — Likes</h2>
      </div>

      {tracks === null ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: 0.7, padding: 24 }}>
          <Loader2 size={18} className="animate-spin" /> Loading...
        </div>
      ) : tracks.length === 0 ? (
        <div style={{ opacity: 0.6, padding: 24 }}>No liked tracks on Yandex Music yet.</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <tbody>
            {tracks.map((t, idx) => (
              <TrackRow
                key={t.id}
                index={idx}
                id={t.id}
                title={t.title}
                artists={t.artists}
                artistIds={t.artistIds}
                album={t.album}
                albumId={t.albumId}
                duration={t.duration}
                thumbUrl={t.thumbUrl}
                likeStatus={t.likeStatus}
                source={t.source}
                yandexId={t.yandexId}
                yandexAlbumId={t.yandexAlbumId}
                onClick={() => handlePlay(idx)}
                hideDuration={false}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};
