import { useState, useEffect, useCallback, useRef } from 'react';
import { player } from '../api/player';
import { YTMTrack } from '../api/yt';

interface QueueState {
  nowPlaying: YTMTrack | null;
  previous: YTMTrack[];
  upcoming: YTMTrack[];
  recommendations: YTMTrack[];
  isRecommendationsLoading: boolean;
  currentIndex: number;
}

/**
 * <summary>
 * Хук для работы с очередью воспроизведения.
 * Оптимизирован: НЕ реагирует на play/pause (isPlaying), чтобы избежать массовых ререндеров.
 * </summary>
 */
export const useQueue = () => {
  const getPrevious = () => {
    if (player.queueIndex <= 0) return [];
    return player.queue.slice(0, player.queueIndex);
  };

  const [state, setState] = useState<QueueState>({
    nowPlaying: player.currentTrack,
    previous: getPrevious(),
    upcoming: player.getUpcoming(),
    recommendations: player.recommendations,
    isRecommendationsLoading: player.isRecommendationsLoading,
    currentIndex: player.queueIndex
  });

  const lastStateRef = useRef(state);
  const lastQueueRef = useRef(player.queue);

  useEffect(() => {
    const update = (event: any) => {
      if (event === 'tick') return;

      // SURGICAL CHECK: Only update if structural data changed
      // We IGNORE isPlaying changes here to save CPU
      const hasChanged =
        player.currentTrack?.id !== lastStateRef.current.nowPlaying?.id ||
        player.queueIndex !== lastStateRef.current.currentIndex ||
        player.queue !== lastQueueRef.current ||
        player.recommendations !== lastStateRef.current.recommendations ||
        player.isRecommendationsLoading !== lastStateRef.current.isRecommendationsLoading;

      if (hasChanged) {
        const newState = {
          nowPlaying: player.currentTrack,
          previous: getPrevious(),
          upcoming: player.getUpcoming(),
          recommendations: player.recommendations,
          isRecommendationsLoading: player.isRecommendationsLoading,
          currentIndex: player.queueIndex
        };
        lastStateRef.current = newState;
        lastQueueRef.current = player.queue;
        setState(newState);
      }
    };

    return player.subscribe(update);
  }, []);

  const playFromQueue = useCallback((index: number) => {
    player.playFromQueue(index);
  }, []);

  const removeFromQueue = useCallback((index: number) => {
    player.removeFromQueue(index);
  }, []);

  const moveInQueue = useCallback((fromIndex: number, toIndex: number) => {
    player.moveInQueue(fromIndex, toIndex);
  }, []);

  return {
    ...state,
    playFromQueue,
    removeFromQueue,
    moveInQueue
  };
};
