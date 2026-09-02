import React, { useState, useEffect, useRef, useMemo, useCallback, memo } from 'react';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import { player } from '../../api/player';
import { useQueue } from '../../hooks/useQueue';
import { QueueItem } from '../molecules/QueueItem';
import { QueueItemSkeleton } from '../molecules/QueueItemSkeleton';
import { RotateCw } from 'lucide-react';
import styles from './QueuePanel.module.css';
import { TrackContextMenu, TrackContextMenuHandle } from './TrackContextMenu';
import { YTMTrack } from '../../api/yt';
import { TrackSource } from '../../api/source';
import { isSoundCloudEnabled } from '../../api/soundcloud';
import { isYandexEnabled } from '../../api/yandex';

interface QueuePanelProps {
  onSelectAlbum: (id: string) => void;
  onSelectPlaylist?: (id: string, title: string) => void;
  onSelectArtist?: (id: string) => void;
  isVisible?: boolean;
  waveMode?: boolean;
}

const SOURCE_LABELS: Record<TrackSource, string> = {
  youtube: 'YT',
  soundcloud: 'SC',
  yandex: 'Я',
};

// Переключатель источников автодозагрузки очереди -- мульти-select: каждый источник
// включается/выключается независимо, смешивание (бывший «Гибрид») теперь неявное
// (>1 активного источника). YT/SC/Yandex видны только если соответствующая интеграция включена.
const RadioModeSwitcher = memo(() => {
  const [active, setActive] = useState(player.radioSources);
  const [scEnabled, setScEnabled] = useState(isSoundCloudEnabled());
  const [yandexEnabled, setYandexEnabled] = useState(isYandexEnabled());
  useEffect(() => {
    const unsub = player.subscribe((ev) => {
      if (ev !== 'state') return;
      setActive(prev => {
        const cur = player.radioSources;
        return (cur.length === prev.length && cur.every(s => prev.includes(s))) ? prev : cur;
      });
    });
    const onScChange = (e: Event) => setScEnabled((e as CustomEvent).detail.enabled);
    const onYandexChange = (e: Event) => setYandexEnabled((e as CustomEvent).detail.enabled);
    window.addEventListener('sc-enabled-changed', onScChange);
    window.addEventListener('yandex-enabled-changed', onYandexChange);
    return () => {
      unsub();
      window.removeEventListener('sc-enabled-changed', onScChange);
      window.removeEventListener('yandex-enabled-changed', onYandexChange);
    };
  }, []);

  const visibleSources: TrackSource[] = ['youtube', ...(scEnabled ? ['soundcloud' as const] : []), ...(yandexEnabled ? ['yandex' as const] : [])];
  if (visibleSources.length <= 1) return null;

  return (
    <div className={styles.radioSwitcher} data-tooltip="Источники радио">
      {visibleSources.map((key) => {
        const isActive = active.includes(key);
        return (
          <button
            key={key}
            className={`${styles.radioSegment} ${isActive ? styles.radioSegmentActive : ''}`}
            onClick={() => player.toggleRadioSource(key, !isActive)}
            aria-pressed={isActive}
          >
            {SOURCE_LABELS[key]}
          </button>
        );
      })}
    </div>
  );
});

const SuggestedSection = memo(({
  tracks,
  isLoading,
  onPlay,
  onContextMenu,
  onRefresh,
  onSelectArtist
}: {
  tracks: YTMTrack[],
  isLoading: boolean,
  onPlay: (index?: number) => void,
  onContextMenu: (e: React.MouseEvent, track: any, index?: number) => void,
  onRefresh: () => void,
  onSelectArtist?: (id: string) => void
}) => {
  if (!isLoading && tracks.length === 0) return <div style={{ height: '2rem' }} />;
  
  return (
    <div className={styles.section} style={{ paddingBottom: '2rem' }}>
      <div className={styles.sectionHeader}>
        <span>Suggested</span>
        <button className={`${styles.refreshBtn} ${isLoading ? styles.spinning : ''}`} onClick={onRefresh} disabled={isLoading} data-tooltip="Refresh Recommendations">
          <RotateCw size={14} />
        </button>
      </div>
      {isLoading && tracks.length === 0 ? (
        Array.from({ length: 5 }).map((_, i) => <QueueItemSkeleton key={`skeleton-${i}`} />)
      ) : (
        <>
          {tracks.map((track, i) => (
            <QueueItem
              key={`${track.id}-suggested-${i}`}
              id={track.id}
              index={i}
              title={track.title}
              artists={track.artists}
              artistIds={track.artistIds}
              thumbUrl={track.thumbUrl}
              duration={track.duration}
              likeStatus={track.likeStatus}
              source={track.source}
              isActive={false}
              onClick={onPlay}
              onContextMenu={onContextMenu}
              onSelectArtist={onSelectArtist}
              trackData={track}
            />
          ))}
          {isLoading && <QueueItemSkeleton />}
        </>
      )}
    </div>
  );
});

// SURGICAL COMPONENT: Handles header logic and drag-drop events to keep QueuePanel stable
const MemoizedQueueItem = memo(({
  index, track, currentIndex, fullQueueLength,
  onPlay, onContextMenu, onDragStart, onDragEnd, onDragOver, onDrop,
  draggedIndex, dragOverIndex, onSelectArtist
}: any) => {
  const isActive = index === currentIndex;
  let header = null;
  if (index === 0 && currentIndex > 0) header = "Previous";
  else if (isActive) header = "Now Playing";
  else if (index === currentIndex + 1 && index < fullQueueLength) header = "Up Next";

  let dragCls = '';
  if (draggedIndex === index) dragCls = styles.dragging;
  else if (dragOverIndex === index && draggedIndex !== null) {
    dragCls = draggedIndex > index ? styles.dragOverUp : styles.dragOverDown;
  }

  return (
    <div 
      onDragOver={(e) => onDragOver(e, index)} 
      onDrop={(e) => onDrop(e, index)} 
      className={styles.queueItemWrapper}
    >
      {header && <div className={styles.sectionHeader}>{header}</div>}
      <QueueItem
        id={track.id}
        index={index}
        title={track.title}
        artists={track.artists}
        artistIds={track.artistIds}
        thumbUrl={track.thumbUrl}
        duration={track.duration}
        likeStatus={track.likeStatus}
        source={track.source}
        isActive={isActive}
        onClick={onPlay}
        onContextMenu={onContextMenu}
        onSelectArtist={onSelectArtist}
        draggable={true}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        className={dragCls}
        trackData={track}
      />
    </div>
  );
});

export const QueuePanel: React.FC<QueuePanelProps> = memo(({ 
  onSelectAlbum, 
  onSelectPlaylist, 
  onSelectArtist,
  isVisible,
  waveMode
}) => {
  const { 
    recommendations,
    isRecommendationsLoading,
    currentIndex, 
    playFromQueue, 
    removeFromQueue,
    moveInQueue
  } = useQueue();
  
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const trackMenuRef = useRef<TrackContextMenuHandle>(null);
  const lastScrolledIndexRef = useRef<number>(-1);

  const [fullQueue, setFullQueue] = useState([...player.queue]);
  const lastQueueRef = useRef(player.queue);

  useEffect(() => {
    const update = (event: any) => {
      if (event === 'tick') return;
      if (player.queue !== lastQueueRef.current) {
        lastQueueRef.current = player.queue;
        setFullQueue([...player.queue]);
      }
    };
    return player.subscribe(update);
  }, []);

  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const handleDragStart = useCallback((e: React.DragEvent, index?: number) => {
    if (index === undefined) return;
    e.dataTransfer.effectAllowed = 'move';
    setDraggedIndex(index);
    const img = new Image();
    img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    e.dataTransfer.setDragImage(img, 0, 0);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (draggedIndex === null) return;
    e.dataTransfer.dropEffect = 'move';
    if (dragOverIndex !== index) setDragOverIndex(index);
  }, [draggedIndex, dragOverIndex]);

  const handleDrop = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (draggedIndex !== null && draggedIndex !== index) moveInQueue(draggedIndex, index);
    setDraggedIndex(null);
    setDragOverIndex(null);
  }, [draggedIndex, moveInQueue]);

  const handleDragEnd = useCallback(() => {
    setDraggedIndex(null); 
    setDragOverIndex(null); 
  }, []);

  useEffect(() => {
    // Scroll if index changed and panel is visible
    if (currentIndex >= 0 && virtuosoRef.current && isVisible !== false && lastScrolledIndexRef.current !== currentIndex) {
      lastScrolledIndexRef.current = currentIndex;
      
      // Slightly shorter delay to ensure queue expansion and layout shifts are finished
      const timer = setTimeout(() => {
        if (virtuosoRef.current) {
          virtuosoRef.current.scrollToIndex({
            index: currentIndex,
            align: 'center',
            behavior: 'smooth'
          });
        }
      },150);
      
      return () => clearTimeout(timer);
    }
  }, [currentIndex, isVisible, fullQueue.length]);

  const handleContextMenu = useCallback((e: React.MouseEvent, track: any, index?: number) => {
    e.preventDefault();
    const type = index !== undefined ? 'queue' : 'suggested';
    trackMenuRef.current?.open(e, track, { type, index });
  }, []);

  // Read recommendations through a ref so onSuggestedPlay stays stable
  const recsRef = useRef(recommendations);
  recsRef.current = recommendations;

  const onSuggestedPlay = useCallback((index?: number) => {
    const recs = recsRef.current;
    if (index !== undefined && recs[index]) {
      player.addRecommendationsAndPlay(recs[index]);
    }
  }, []);

  const handleRefreshRecs = useCallback(() => { player.refreshRecommendations(); }, []);

  const components = useMemo(() => ({
    Footer: () => (
      <SuggestedSection
        tracks={recommendations}
        isLoading={isRecommendationsLoading}
        onPlay={onSuggestedPlay}
        onContextMenu={handleContextMenu}
        onRefresh={handleRefreshRecs}
        onSelectArtist={onSelectArtist}
      />
    )
  }), [recommendations, isRecommendationsLoading, onSuggestedPlay, handleContextMenu, handleRefreshRecs, onSelectArtist]);

  // Keep refs for callbacks so renderItem stays stable between renders
  const playFromQueueRef = useRef(playFromQueue);
  const ctxMenuRef = useRef(handleContextMenu);
  const dragStartRef = useRef(handleDragStart);
  const dragEndRef = useRef(handleDragEnd);
  const dragOverRef = useRef(handleDragOver);
  const dropRef = useRef(handleDrop);
  const onArtistRef = useRef(onSelectArtist);
  playFromQueueRef.current = playFromQueue;
  ctxMenuRef.current = handleContextMenu;
  dragStartRef.current = handleDragStart;
  dragEndRef.current = handleDragEnd;
  dragOverRef.current = handleDragOver;
  dropRef.current = handleDrop;
  onArtistRef.current = onSelectArtist;

  const renderItem = useCallback((index: number, track: any) => {
    return (
      <MemoizedQueueItem 
        index={index}
        track={track}
        currentIndex={currentIndex}
        fullQueueLength={fullQueue.length}
        onPlay={playFromQueueRef.current}
        onContextMenu={ctxMenuRef.current}
        onDragStart={dragStartRef.current}
        onDragEnd={dragEndRef.current}
        onDragOver={dragOverRef.current}
        onDrop={dropRef.current}
        draggedIndex={draggedIndex}
        dragOverIndex={dragOverIndex}
        onSelectArtist={onArtistRef.current}
      />
    );
  }, [currentIndex, fullQueue.length, draggedIndex, dragOverIndex]);

  return (
    <aside className={`${styles.panel} ${waveMode ? styles.waveMode : ''}`}>
      <header className={styles.header}>
        <h4>Queue</h4>
        <RadioModeSwitcher />
      </header>
      <div className={styles.list}>
        <Virtuoso
          ref={virtuosoRef}
          style={{ height: '100%', background: waveMode ? 'transparent' : undefined }}
          data={fullQueue}
          itemContent={renderItem}
          components={components}
          increaseViewportBy={300}
          overscan={200}
        />
      </div>
      <TrackContextMenu
        ref={trackMenuRef}
        onSelectArtist={onSelectArtist}
        onSelectAlbum={onSelectAlbum}
        onSelectPlaylist={onSelectPlaylist}
        onRemoveFromQueue={removeFromQueue}
        onPlayFromQueue={playFromQueue}
      />
    </aside>
  );
});
