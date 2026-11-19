import React, { useRef, useState, useCallback, memo, useEffect, useImperativeHandle, forwardRef } from 'react';
import styles from './ProgressBar.module.css';

interface SliderBarProps {
  label: string;
  progress?: number; // 0 to 100
  onSeek?: (pct: number) => void;
  buffered?: { start: number; end: number }[];
  className?: string;
  showThumb?: boolean;
  largeTarget?: boolean;
  interactive?: boolean;
  nyanMode?: boolean;
  isPlaying?: boolean;
}

export interface ProgressBarRef {
  setProgress: (pct: number) => void;
  container: HTMLDivElement | null;
}

export const ProgressBar = memo(forwardRef<ProgressBarRef, SliderBarProps>(({
  label,
  progress = 0,
  onSeek,
  buffered = [],
  className = '',
  showThumb = false,
  largeTarget = false,
  interactive = true,
  nyanMode = false,
  isPlaying = true
}, ref) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const seekCountRef = useRef(0);
  const canSeek = interactive && !!onSeek;

  const setProgressInternal = useCallback((pct: number) => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const clamped = Math.min(100, Math.max(0, pct));
    // Если скачок > 3% — отключаем transition (seek через клавиатуру).
    const prev = parseFloat(el.style.getPropertyValue('--progress')) || 0;
    if (Math.abs(clamped - prev) > 3) {
      const mySeek = ++seekCountRef.current;
      el.setAttribute('data-seeking', '');
      setTimeout(() => {
        if (seekCountRef.current === mySeek) el.removeAttribute('data-seeking');
      }, 50);
    }
    el.style.setProperty('--progress', `${clamped}%`);
    if (canSeek) el.setAttribute('aria-valuenow', String(Math.round(clamped)));
  }, [canSeek]);

  useImperativeHandle(ref, () => ({
    setProgress: setProgressInternal,
    get container() { return containerRef.current; }
  }), [setProgressInternal]);

  const calculateProgress = (clientX: number) => {
    if (!containerRef.current) return 0;
    const rect = containerRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
    return rect.width > 0 ? (x / rect.width) * 100 : 0;
  };

  // Sync initial or changed progress prop
  useEffect(() => {
    setProgressInternal(progress);
  }, [progress, setProgressInternal]);

  const seekToPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    const pct = calculateProgress(e.clientX);
    setProgressInternal(pct);
    onSeek?.(pct);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!canSeek || !e.isPrimary || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsDragging(true);
    seekToPointer(e);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!canSeek || !e.isPrimary) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) seekToPointer(e);
    else e.currentTarget.style.setProperty('--hover-progress', `${calculateProgress(e.clientX)}%`);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!onSeek || e.altKey || e.ctrlKey || e.metaKey) return;
    const current = parseFloat(e.currentTarget.style.getPropertyValue('--progress')) || 0;
    let next: number;
    switch (e.key) {
      case 'ArrowLeft': case 'ArrowDown': next = current - 1; break;
      case 'ArrowRight': case 'ArrowUp': next = current + 1; break;
      case 'Home': next = 0; break;
      case 'End': next = 100; break;
      default: return;
    }
    e.preventDefault();
    e.stopPropagation();
    next = Math.min(100, Math.max(0, next));
    setProgressInternal(next);
    onSeek(next);
  };

  return (
    <div
      ref={containerRef}
      role={canSeek ? 'slider' : undefined}
      aria-label={canSeek ? label : undefined}
      aria-valuenow={canSeek ? Math.round(progress) : undefined}
      tabIndex={canSeek ? 0 : undefined}
      onKeyDown={canSeek ? handleKeyDown : undefined}
      className={`${styles.container} ${interactive ? styles.interactive : ''} ${isDragging ? styles.dragging : ''} ${largeTarget ? styles.largeTarget : ''} ${className}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onLostPointerCapture={() => setIsDragging(false)}
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
        <div className={nyanMode ? styles.nyanViewport : undefined} aria-hidden="true">
          <div className={styles.thumbWrapper}>
            <div className={`${styles.thumb} ${nyanMode ? styles.nyanThumb : ''} ${!isPlaying ? styles.paused : ''}`} />
          </div>
        </div>
      )}
    </div>
  );
}));

ProgressBar.displayName = 'ProgressBar';
