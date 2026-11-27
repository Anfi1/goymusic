import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { useQuery, useInfiniteQuery } from '@tanstack/react-query';
import { player } from '../../api/player';
import { getLyrics, getComments } from '../../api/yt';
import { Music, AlertCircle, Loader2, AlignLeft, Timer, RefreshCw, MessageSquare, Heart, Maximize2, Minimize2 } from 'lucide-react';
import styles from './LyricsView.module.css';

export function scrollContainerToTop(el: Pick<HTMLDivElement, 'scrollTop'> & { scrollTo?: HTMLDivElement['scrollTo'] } | null): void {
  if (!el) return;
  if (typeof el.scrollTo === 'function') {
    el.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  }
  el.scrollTop = 0;
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

// Подписка только на currentTrack: изменения очереди/рекомендаций не перерендеривают текст.
function useCurrentTrack() {
  const [track, setTrack] = useState(() => player.currentTrack);
  useEffect(() => {
    setTrack(prev => (prev === player.currentTrack ? prev : player.currentTrack));
    return player.subscribe((ev) => {
      if (ev === 'state') {
        setTrack(prev => (prev === player.currentTrack ? prev : player.currentTrack));
      }
    });
  }, []);
  return track;
}

interface LyricLine {
  time: number;
  text: string;
}

type ViewMode = 'synced' | 'static' | 'comments';

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
  waveMode?: boolean;
  onExpandToWave?: () => void;
  onCollapseFromWave?: () => void;
}

export const LyricsView: React.FC<LyricsViewProps> = ({
  isVisible = true,
  waveMode = false,
  onExpandToWave,
  onCollapseFromWave,
}) => {
  const track = useCurrentTrack();
  const currentTrackId = track?.id;

  const containerRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<(HTMLDivElement | null)[]>([]);
  const activeIndexRef = useRef(-1);
  const scrollTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [viewMode, setViewMode] = useState<ViewMode>('synced');
  const [activeIndex, setActiveIndex] = useState(-1);
  const [userIsScrolling, setUserIsScrolling] = useState(false);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['lyrics', currentTrackId],
    queryFn: async ({ signal }) => {
      if (!track) return null;
      const artist = track.artists?.[0] || '';
      const title = track.title;
      const durParts = track.duration.split(':').map(Number);
      const duration = durParts.length === 2 ? durParts[0] * 60 + durParts[1] : undefined;

      // videoId нужен для текстов самого YT Music: у SC/Yandex-треков id чужой.
      // Для яндексового трека бэкенд сначала спросит сам Яндекс: он ищет по id трека
      // и отдает готовый LRC, где текстовый поиск по "артист - название" промахивается.
      const isForeign = track.source === 'soundcloud' || track.source === 'yandex';
      const videoId = isForeign ? undefined : track.id;
      const res = await getLyrics(artist, title, duration, videoId, track.yandexId, signal);

      if (!res) return { notFound: true, instrumental: false };

      const synced = res.syncedLyrics ? parseLRC(res.syncedLyrics) : [];
      return {
        synced,
        plain: res.plainLyrics || null,
        hasSynced: synced.length > 0,
        instrumental: !!res.instrumental,
        notFound: false
      };
    },
    enabled: !!currentTrackId && isVisible,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000
  });

  const syncedLines = data?.hasSynced ? data.synced : null;
  // Подрезаем массив ref'ов под текущие строки на рендере, а не обнуляем в useEffect после commit.
  lineRefs.current.length = syncedLines ? syncedLines.length : 0;

  // Сбрасываем состояние и пользовательский таймер скролла при смене трека
  useEffect(() => {
    if (scrollTimeout.current) {
      clearTimeout(scrollTimeout.current);
      scrollTimeout.current = null;
    }
    activeIndexRef.current = -1;
    setActiveIndex(-1);
    setUserIsScrolling(false);
  }, [currentTrackId]);

  useEffect(() => {
    return () => {
      if (scrollTimeout.current) clearTimeout(scrollTimeout.current);
    };
  }, []);

  // Sync view mode when data arrives; открытые комментарии при смене трека не сбиваем
  useEffect(() => {
    if (data && !data.notFound) {
      setViewMode(m => m === 'comments' ? m : data.hasSynced ? 'synced' : 'static');
    }
  }, [data]);

  // Гарантируем мгновенный подъем вверх при смене трека/режима/появлении панели,
  // даже если синхронизация еще не дошла до первой строки (activeIndex === -1).
  useLayoutEffect(() => {
    if (!isVisible || !containerRef.current) return;
    if (viewMode === 'static' || activeIndexRef.current === -1) {
      scrollContainerToTop(containerRef.current);
    }
  }, [isVisible, currentTrackId, viewMode, data]);

  // Synchronization with player time
  useEffect(() => {
    if (!isVisible || !syncedLines || viewMode !== 'synced') return;

    const syncActiveLine = () => {
      const currentTime = player.currentTime;
      let index = -1;
      for (let i = 0; i < syncedLines.length; i++) {
        if (syncedLines[i].time <= currentTime) {
          index = i;
        } else {
          break;
        }
      }
      if (index !== activeIndexRef.current) {
        activeIndexRef.current = index;
        setActiveIndex(index);
      }
    };

    syncActiveLine();
    return player.subscribe(syncActiveLine, { tick: true });
  }, [isVisible, syncedLines, viewMode]);

  // Centering logic
  useEffect(() => {
    if (!isVisible || viewMode !== 'synced' || userIsScrolling || !containerRef.current) {
      return;
    }
    const container = containerRef.current;
    // Перемотка в начало трека (или старт нового до первой строки LRC) должна сразу вернуть скролл наверх.
    if (activeIndex === -1) {
      scrollContainerToTop(container);
      return;
    }
    const activeElement = lineRefs.current[activeIndex];

    if (activeElement) {
      const targetScroll = Math.max(0, activeElement.offsetTop - (container.offsetHeight * 0.35));
      container.scrollTo({
        top: targetScroll,
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      });
    }
  }, [isVisible, activeIndex, userIsScrolling, viewMode, syncedLines]);

  // Ловим именно жест пользователя. Раньше висел onScroll, но его же дёргает наша
  // собственная плавная прокрутка и сброс scrollTop при смене трека: автоскролл замирал
  // на 3 секунды, а потом одним рывком догонял уехавшую строку.
  const handleUserScroll = () => {
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

  const renderLyrics = () => {
    if (isLoading && isVisible) {
      return (
        <div className={styles.empty}>
          <Loader2 className={styles.loaderIcon} size={32} />
          <p>Searching for lyrics...</p>
        </div>
      );
    }

    // Источник знает трек и говорит, что вокала в нём нет — это ответ, а не осечка поиска.
    if (data?.instrumental) {
      return (
        <div className={styles.empty}>
          <Music size={32} opacity={0.3} />
          <p>This track is instrumental</p>
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

    return (
      <div
        key={`${currentTrackId}-${viewMode}`}
        className={`${styles.container} ${viewMode === 'static' ? styles.staticMode : ''}`}
        ref={containerRef}
        onWheel={handleUserScroll}
        onTouchMove={handleUserScroll}
      >
        {viewMode === 'synced' && data?.hasSynced ? (
          data.synced.map((line, i) => (
            <div
              key={i}
              ref={(el) => { lineRefs.current[i] = el; }}
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
    );
  };

  const hasSynced = (data?.synced?.length ?? 0) > 0;
  const hasPlain = !!data?.plain;
  // В «Моей волне» показываем верхние контролы при наличии обоих режимов текста или кнопки возврата.
  const showControls = !waveMode || (hasSynced && hasPlain) || !!onCollapseFromWave;

  const chip = (mode: ViewMode, icon: React.ReactNode, label: string, active = viewMode === mode) => (
    <button className={`${styles.modeBtn} ${active ? styles.active : ''}`} onClick={() => setViewMode(mode)}>
      {icon}
      <span>{label}</span>
    </button>
  );

  return (
    <div className={`${styles.wrapper} ${waveMode ? styles.waveMode : ''}`}>
      {showControls && (
        <div className={styles.viewControls}>
          {hasSynced && chip('synced', <Timer size={14} />, 'Synced')}
          {hasPlain && chip('static', <AlignLeft size={14} />, 'Static')}
          {/* Текста нет или он еще грузится: без этого чипа из комментариев не вернуться */}
          {!hasSynced && !hasPlain && !waveMode && chip('static', <Music size={14} />, 'Lyrics', viewMode !== 'comments')}
          {!waveMode && chip('comments', <MessageSquare size={14} />, 'Comments')}
          {!waveMode && onExpandToWave && (
            <button
              type="button"
              className={`${styles.modeBtn} ${styles.iconBtn}`}
              onClick={onExpandToWave}
              title="Открыть большие тексты в Моей волне"
              aria-label="Открыть большие тексты в Моей волне"
            >
              <Maximize2 size={14} />
            </button>
          )}
          {waveMode && onCollapseFromWave && (
            <button
              type="button"
              className={`${styles.modeBtn} ${styles.iconBtn}`}
              onClick={onCollapseFromWave}
              title="Свернуть"
              aria-label="Свернуть"
            >
              <Minimize2 size={14} />
            </button>
          )}
        </div>
      )}
      {viewMode === 'comments' ? <CommentsContent isVisible={isVisible} /> : renderLyrics()}
    </div>
  );
};

// 1:02:33 или 20:21; "12:29pm" не таймкод: после цифр идёт буква
const TIMESTAMP = /\b(?:(\d{1,2}):)?(\d{1,2}):([0-5]\d)\b/g;

// Таймкоды в тексте кликабельны: в часовых миксах так ищут нужный трек
const WithTimestamps: React.FC<{ text: string }> = ({ text }) => {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(TIMESTAMP)) {
    const sec = Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    if (player.duration && sec > player.duration) continue;
    parts.push(text.slice(last, m.index));
    parts.push(<button key={m.index} className={styles.timestamp} onClick={() => player.seek(sec)}>{m[0]}</button>);
    last = m.index! + m[0].length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
};

const formatSec = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

const CommentsContent: React.FC<{ isVisible: boolean }> = ({ isVisible }) => {
  const track = useCurrentTrack();
  const [descOpen, setDescOpen] = useState(false);
  const supported = !!track && track.source !== 'yandex';

  const { data, isError, refetch, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery({
    queryKey: ['comments', track?.id],
    queryFn: ({ pageParam }) => getComments(track!, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.continuation,
    enabled: supported && isVisible,
    staleTime: 10 * 60 * 1000,
  });

  useEffect(() => setDescOpen(false), [track?.id]);

  if (!supported) {
    return <div className={styles.empty}><MessageSquare size={32} opacity={0.3} /><p>Comments are not available for Yandex tracks</p></div>;
  }
  if (isError && !data) {
    return (
      <div className={styles.empty}>
        <AlertCircle size={32} opacity={0.3} />
        <p>Could not load comments</p>
        <button className={styles.retryBtn} onClick={() => refetch()}><RefreshCw size={14} />Retry</button>
      </div>
    );
  }
  if (!data) {
    return <div className={styles.empty}><Loader2 className={styles.loaderIcon} size={32} /><p>Loading comments...</p></div>;
  }

  const description = data.pages[0].description;
  const longDescription = description.length > 300 || description.split('\n').length > 5;
  const comments = data.pages.flatMap(p => p.comments);

  // Лента без кнопки: следующая страница подгружается, когда до низа остаётся немного
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (hasNextPage && !isFetchingNextPage && el.scrollHeight - el.scrollTop - el.clientHeight < 400) fetchNextPage();
  };

  return (
    <div key={track?.id || 'none'} className={styles.comments} onScroll={handleScroll}>
      {description && (
        <div className={styles.description}>
          <div className={`${styles.descriptionText} ${longDescription && !descOpen ? styles.descriptionClamped : ''}`}>
            <WithTimestamps text={description} />
          </div>
          {longDescription && (
            <button className={styles.descriptionToggle} onClick={() => setDescOpen(o => !o)}>
              {descOpen ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>
      )}
      {comments.length === 0 && <p className={styles.noComments}>No comments</p>}
      {comments.map((c, i) => (
        <div key={i} className={styles.comment}>
          <div className={styles.commentMeta}>
            <span className={styles.commentAuthor}>{c.author}</span>
            <span>{c.published}</span>
            {c.timestamp != null && (
              <button className={styles.timestamp} onClick={() => player.seek(c.timestamp!)}>{formatSec(c.timestamp)}</button>
            )}
          </div>
          <div className={styles.commentText}><WithTimestamps text={c.text} /></div>
          {c.likes && <div className={styles.commentLikes}><Heart size={11} />{c.likes}</div>}
        </div>
      ))}
      {isFetchingNextPage && <Loader2 className={`${styles.loaderIcon} ${styles.moreLoader}`} size={20} />}
    </div>
  );
};
