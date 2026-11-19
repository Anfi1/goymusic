import React, { useRef, useState, useCallback, memo, useEffect, useImperativeHandle, forwardRef } from 'react';
import styles from './ProgressBar.module.css';

interface SliderBarProps {
  label: string;
  progress?: number; // 0 to 100
  onSeek?: (pct: number) => void;
  onPreviewChange?: (pct: number | null) => void;
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

const readProgress = (el: HTMLDivElement) => parseFloat(el.style.getPropertyValue('--progress')) || 0;

export const ProgressBar = memo(forwardRef<ProgressBarRef, SliderBarProps>(({
  label,
  progress = 0,
  onSeek,
  onPreviewChange,
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
  const dragPointer = useRef<number | null>(null);
  const keyboardPreview = useRef(false);
  const previewCallback = useRef(onPreviewChange);
  React.useLayoutEffect(() => { previewCallback.current = onPreviewChange; }, [onPreviewChange]);
  const canSeek = interactive && !!onSeek;

  const setProgressInternal = useCallback((pct: number) => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const clamped = Math.min(100, Math.max(0, pct));
    // Если скачок > 3% — отключаем transition (seek через клавиатуру).
    const prev = readProgress(el);
    if (dragPointer.current === null && Math.abs(clamped - prev) > 3) {
      const mySeek = ++seekCountRef.current;
      el.setAttribute('data-seeking', '');
      setTimeout(() => {
        if (seekCountRef.current === mySeek) el.removeAttribute('data-seeking');
      }, 50);
    }
    el.style.setProperty('--progress', `${clamped}%`);
    if (canSeek) el.setAttribute('aria-valuenow', String(Math.round(clamped)));
    if (keyboardPreview.current) previewCallback.current?.(clamped);
  }, [canSeek]);

  useImperativeHandle(ref, () => ({
    setProgress(pct) {
      // A playback tick must not pull the playhead away from a captured pointer.
      if (!previewCallback.current || dragPointer.current === null) setProgressInternal(pct);
    },
    get container() { return containerRef.current; }
  }), [setProgressInternal]);

  const calculateProgress = (clientX: number, rect: DOMRect) => {
    const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
    return rect.width > 0 ? (x / rect.width) * 100 : 0;
  };

  // Sync initial or changed progress prop
  useEffect(() => {
    setProgressInternal(progress);
  }, [progress, setProgressInternal]);

  const previewPointer = (e: React.PointerEvent<HTMLDivElement>, pct: number) => {
    keyboardPreview.current = false;
    e.currentTarget.style.setProperty('--hover-progress', `${pct}%`);
    onPreviewChange?.(pct);
  };

  const previewFocus = (el: HTMLDivElement, focused: boolean) => {
    keyboardPreview.current = focused;
    onPreviewChange?.(focused ? readProgress(el) : null);
  };

  const seekToPointer = (e: React.PointerEvent<HTMLDivElement>, pct: number) => {
    if (onPreviewChange) previewPointer(e, pct);
    setProgressInternal(pct);
    onSeek?.(pct);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!canSeek || !e.isPrimary || e.button !== 0 || dragPointer.current !== null) return;
    dragPointer.current = e.pointerId;
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsDragging(true);
    seekToPointer(e, calculateProgress(e.clientX, e.currentTarget.getBoundingClientRect()));
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!canSeek || !e.isPrimary) return;
    const pct = calculateProgress(e.clientX, e.currentTarget.getBoundingClientRect());
    if (dragPointer.current === e.pointerId) seekToPointer(e, pct);
    else if (dragPointer.current === null && e.pointerType !== 'touch') previewPointer(e, pct);
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragPointer.current !== e.pointerId) return;
    if (onPreviewChange && e.type === 'pointerup') {
      const rect = e.currentTarget.getBoundingClientRect();
      const pct = calculateProgress(e.clientX, rect);
      if (pct !== readProgress(e.currentTarget)) seekToPointer(e, pct);
      const inside = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
      if (e.pointerType !== 'touch' && inside) previewPointer(e, pct);
      else onPreviewChange(null);
    } else {
      keyboardPreview.current = false;
      onPreviewChange?.(null);
    }
    dragPointer.current = null;
    setIsDragging(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!onSeek || dragPointer.current !== null || e.altKey || e.ctrlKey || e.metaKey) return;
    const current = readProgress(e.currentTarget);
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
    keyboardPreview.current = !!onPreviewChange;
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
      onPointerEnter={onPreviewChange && canSeek ? handlePointerMove : undefined}
      onPointerMove={handlePointerMove}
      onPointerLeave={onPreviewChange && canSeek ? e => {
        if (e.isPrimary && dragPointer.current === null) previewFocus(e.currentTarget, e.currentTarget.matches(':focus-visible'));
      } : undefined}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onFocus={onPreviewChange && canSeek ? e => {
        if (dragPointer.current === null) previewFocus(e.currentTarget, true);
      } : undefined}
      onBlur={onPreviewChange && canSeek ? () => {
        if (keyboardPreview.current) {
          keyboardPreview.current = false;
          onPreviewChange(null);
        }
      } : undefined}
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
