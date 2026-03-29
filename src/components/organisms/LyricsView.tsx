import React, { useState, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { player } from '../../api/player';
import { getLyrics } from '../../api/yt';
import { useQueue } from '../../hooks/useQueue';
import { Music, AlertCircle, Loader2, AlignLeft, Timer, RefreshCw } from 'lucide-react';
import styles from './LyricsView.module.css';

interface LyricLine {
  time: number;
  text: string;
}

type ViewMode = 'synced' | 'static';

const parseLRC = (lrc: string): LyricLine[] => {
  const lines = lrc.split('\n');
  const result: LyricLine[] = [];
  const timeRegex = /\[(\d{2}):(\d{2})\.(\d{2,3})\]/;

  lines.forEach(line => {
    const match = timeRegex.exec(line);
    if (match) {
      const minutes = parseInt(match[1]);
      const seconds = parseInt(match[2]);
      const ms = parseInt(match[3]);
      const time = minutes * 60 + seconds + (ms > 99 ? ms / 1000 : ms / 100);
      const text = line.replace(timeRegex, '').trim();
      if (text) result.push({ time, text });
    }
  });

  return result.sort((a, b) => a.time - b.time);
};

interface LyricsViewProps {
  isVisible?: boolean;
}

export const LyricsView: React.FC<LyricsViewProps> = ({ isVisible = true }) => {
  // Use useQueue to make nowPlaying reactive
  const { nowPlaying: track } = useQueue();
  const currentTrackId = track?.id;

  const containerRef = useRef<HTMLDivElement>(null);
  const scrollTimeout = useRef<any>(null);

  const [viewMode, setViewMode] = useState<ViewMode>('synced');
  const [activeIndex, setActiveIndex] = useState(-1);
  const [userIsScrolling, setUserIsScrolling] = useState(false);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['lyrics', currentTrackId],
    queryFn: async () => {
      if (!track) return null;
      const artist = track.artists?.[0] || 'Unknown';
      const title = track.title;
      const durParts = track.duration.split(':').map(Number);
      const duration = durParts.length === 2 ? durParts[0] * 60 + durParts[1] : undefined;
      
      const res = await getLyrics(artist, title, duration);
      
      if (!res) return { notFound: true };

      const synced = res.syncedLyrics ? parseLRC(res.syncedLyrics) : [];
      return {
        synced,
        plain: res.plainLyrics || null,
        hasSynced: synced.length > 0,
        notFound: false
      };
    },
    enabled: !!currentTrackId && isVisible,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000
  });

  // Reset scroll and state when track ID changes
  useEffect(() => {
    setActiveIndex(-1);
    setUserIsScrolling(false);
    if (containerRef.current) {
      containerRef.current.scrollTop = 0;
    }
  }, [currentTrackId]);

  // Sync view mode when data arrives
  useEffect(() => {
    if (data && !data.notFound) {
      setViewMode(data.hasSynced ? 'synced' : 'static');
    }
  }, [data]);

  // Synchronization with player time
  useEffect(() => {
    const unsubscribe = player.subscribe(() => {
      if (data?.hasSynced && viewMode === 'synced') {
        const currentTime = player.currentTime;
        const lyrics = data.synced;
        let index = -1;
        for (let i = 0; i < lyrics.length; i++) {
          if (lyrics[i].time <= currentTime) {
            index = i;
          } else {
            break;
          }
        }
        if (index !== activeIndex) {
          setActiveIndex(index);
        }
      }
    }, { tick: true }); // Enable ticks using new options object
    return unsubscribe;
  }, [data, viewMode, activeIndex]);

  // Centering logic
  useEffect(() => {
    if (viewMode === 'synced' && activeIndex !== -1 && !userIsScrolling && containerRef.current) {
      const container = containerRef.current;
      const lines = container.querySelectorAll(`.${styles.line}`);
      const activeElement = lines[activeIndex] as HTMLElement;
      
      if (activeElement) {
        const targetScroll = activeElement.offsetTop - (container.offsetHeight * 0.35);
        container.scrollTo({
          top: targetScroll,
          behavior: 'smooth'
        });
      }
    }
  }, [activeIndex, userIsScrolling, viewMode, data?.synced?.length]);

  const handleScroll = () => {
    if (viewMode !== 'synced') return;
    setUserIsScrolling(true);
    if (scrollTimeout.current) clearTimeout(scrollTimeout.current);
    scrollTimeout.current = setTimeout(() => {
      setUserIsScrolling(false);
    }, 3000);
  };

  if (!currentTrackId) {
    return (
      <div className={styles.empty}>
        <Music size={48} strokeWidth={1.5} opacity={0.2} />
        <p>No track playing</p>
      </div>
    );
  }

  if (isLoading && isVisible) {
    return (
      <div className={styles.empty}>
        <Loader2 className={styles.loaderIcon} size={32} />
        <p>Searching for lyrics...</p>
      </div>
    );
  }

  if (isError || data?.notFound) {
    return (
      <div className={styles.empty}>
        <AlertCircle size={32} opacity={0.3} />
        <p>Lyrics not found for this track</p>
        <button className={styles.retryBtn} onClick={() => refetch()}>
          <RefreshCw size={14} />
          Retry
        </button>
      </div>
    );
  }

  const hasBothModes = (data?.synced?.length ?? 0) > 0 && !!data?.plain;

  return (
    <div className={styles.wrapper}>
      {hasBothModes && (
        <div className={styles.viewControls}>
          <button 
            className={`${styles.modeBtn} ${viewMode === 'synced' ? styles.active : ''}`}
            onClick={() => setViewMode('synced')}
          >
            <Timer size={14} />
            <span>Synced</span>
          </button>
          <button 
            className={`${styles.modeBtn} ${viewMode === 'static' ? styles.active : ''}`}
            onClick={() => setViewMode('static')}
          >
            <AlignLeft size={14} />
            <span>Static</span>
          </button>
        </div>
      )}

      <div
        className={`${styles.container} ${viewMode === 'static' ? styles.staticMode : ''}`}
        ref={containerRef}
        onScroll={handleScroll}
      >
        {viewMode === 'synced' && data?.hasSynced ? (
          data.synced.map((line, i) => (
            <div
              key={i}
              className={`${styles.line} ${i === activeIndex ? styles.active : ''}`}
              onClick={() => player.seek(line.time)}
            >
              {line.text}
            </div>
          ))
        ) : (
          <div className={styles.plainLyrics}>
            {(data?.plain || '').split('\n').map((line, i) => (
              <div key={i} className={styles.plainLine}>{line}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
