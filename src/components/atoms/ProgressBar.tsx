import React, { useRef, useState, useCallback, memo, useEffect, useImperativeHandle, forwardRef } from 'react';
import styles from './ProgressBar.module.css';

interface SliderBarProps {
  progress?: number; // 0 to 100
  onSeek?: (pct: number) => void;
  buffered?: { start: number; end: number }[];
  className?: string;
  showThumb?: boolean;
  interactive?: boolean;
  nyanMode?: boolean;
  isPlaying?: boolean;
}

export interface ProgressBarRef {
  setProgress: (pct: number) => void;
  container: HTMLDivElement | null;
}

export const ProgressBar = memo(forwardRef<ProgressBarRef, SliderBarProps>(({
  progress = 0,
  onSeek,
  buffered = [],
  className = '',
  showThumb = false,
  interactive = true,
  nyanMode = false,
  isPlaying = true
}, ref) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const setProgressInternal = useCallback((pct: number) => {
    if (containerRef.current) {
      const clamped = Math.min(100, Math.max(0, pct));
      containerRef.current.style.setProperty('--progress', `${clamped}%`);
    }
  }, []);

  useImperativeHandle(ref, () => ({
    setProgress: setProgressInternal,
    get container() { return containerRef.current; }
  }), [setProgressInternal]);

  const calculateProgress = useCallback((e: React.MouseEvent | MouseEvent | React.TouchEvent | TouchEvent) => {
    if (!containerRef.current) return 0;
    const rect = containerRef.current.getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0].clientX : (e as MouseEvent).clientX;
    const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
    return (x / rect.width) * 100;
  }, []);

  // Sync initial or changed progress prop
  useEffect(() => {
    setProgressInternal(progress);
  }, [progress, setProgressInternal]);

  const handleMouseDown = (e: React.MouseEvent | React.TouchEvent) => {
    if (!interactive || !onSeek) return;
    
    if ('button' in e && e.button !== 0) return;

    setIsDragging(true);
    const pct = calculateProgress(e);
    onSeek(pct);

    const handleMouseMove = (moveEvent: MouseEvent | TouchEvent) => {
      const movePct = calculateProgress(moveEvent);
      setProgressInternal(movePct);
      onSeek(movePct);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('touchmove', handleMouseMove);
      document.removeEventListener('touchend', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('touchmove', handleMouseMove, { passive: false });
    document.addEventListener('touchend', handleMouseUp);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!interactive || !containerRef.current) return;
    const pct = calculateProgress(e);
    containerRef.current.style.setProperty('--hover-progress', `${pct}%`);
  };

  return (
    <div
      ref={containerRef}
      className={`${styles.container} ${interactive ? styles.interactive : ''} ${isDragging ? styles.dragging : ''} ${className}`}
      onMouseDown={handleMouseDown}
      onTouchStart={handleMouseDown}
      onMouseMove={handleMouseMove}
    >
      <div className={styles.progressWrapper}>
        {buffered.map((range, i) => (
          <div
            key={i}
            className={styles.buffered}
            style={{
              left: `${range.start}%`,
              width: `${Math.max(0, range.end - range.start)}%`
            }}
          />
        ))}

        {interactive && <div className={styles.hoverFill} />}
        <div className={`${styles.fill} ${nyanMode ? styles.nyanFill : ''}`} />
      </div>

      {(showThumb || nyanMode) && interactive && (
        <div className={styles.thumbWrapper}>
          <div className={`${styles.thumb} ${nyanMode ? styles.nyanThumb : ''} ${!isPlaying ? styles.paused : ''}`} />
        </div>
      )}
    </div>
  );
}));

ProgressBar.displayName = 'ProgressBar';
