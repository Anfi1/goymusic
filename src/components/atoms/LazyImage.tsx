import React, { useState, useEffect, useRef, memo } from 'react';
import { imageQueue } from '../../utils/imageQueue';
import { CoverPlaceholder } from './CoverPlaceholder';
import styles from './LazyImage.module.css';

interface LazyImageProps extends React.ImgHTMLAttributes<HTMLImageElement> {
  placeholder?: React.ReactNode;
  maxRetries?: number;
  fallback?: React.ReactNode;
}

export function shouldRequestLazyImageLoad(state: {
  isIntersecting: boolean;
  isAllowedToLoad: boolean;
  isLoaded: boolean;
  hasSrc: boolean;
  isRetrying: boolean;
  showErrorState: boolean;
  showFallback: boolean;
}): boolean {
  return (
    state.isIntersecting &&
    !state.isAllowedToLoad &&
    !state.isLoaded &&
    state.hasSrc &&
    !state.isRetrying &&
    !state.showErrorState &&
    !state.showFallback
  );
}

export const LazyImage: React.FC<LazyImageProps> = memo(({
  src,
  alt,
  className,
  placeholder,
  maxRetries = 3,
  fallback,
  ...props
}) => {
  const normalizedSrc = typeof src === 'string' ? src.trim() : '';
  const hasSrc = normalizedSrc.length > 0;

  const [isIntersecting, setIntersecting] = useState(false);
  const [isAllowedToLoad, setIsAllowedToLoad] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [errorCount, setErrorCount] = useState(0);
  const [currentSrc, setCurrentSrc] = useState(normalizedSrc);
  const [showErrorState, setShowErrorState] = useState(false);
  const [showFallback, setShowFallback] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelRequestRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    setCurrentSrc(normalizedSrc);
    setErrorCount(0);
    setIsLoaded(false);
    setIsAllowedToLoad(false);
    setIsRetrying(false);
    setShowErrorState(false);
    setShowFallback(false);

    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
    if (cancelRequestRef.current) {
      cancelRequestRef.current();
      cancelRequestRef.current = null;
    }
  }, [normalizedSrc]);

  useEffect(() => {
    if (showErrorState) {
      const timeout = setTimeout(() => setShowFallback(true), 300);
      return () => clearTimeout(timeout);
    }
  }, [showErrorState]);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIntersecting(true);
          observer.disconnect();
        }
      },
      { rootMargin: '400px' }
    );

    if (containerRef.current) {
      observer.observe(containerRef.current);
    }

    return () => {
      observer.disconnect();
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }
      if (cancelRequestRef.current) cancelRequestRef.current();
    };
  }, []);

  const requestLoad = () => {
    if (!normalizedSrc) return;
    if (cancelRequestRef.current) cancelRequestRef.current();

    cancelRequestRef.current = imageQueue.enqueue(normalizedSrc, () => {
      setIsAllowedToLoad(true);
      cancelRequestRef.current = null;
    });
  };

  useEffect(() => {
    if (
      shouldRequestLazyImageLoad({
        isIntersecting,
        isAllowedToLoad,
        isLoaded,
        hasSrc,
        isRetrying,
        showErrorState,
        showFallback,
      })
    ) {
      requestLoad();
    }
  }, [isIntersecting, isAllowedToLoad, isLoaded, hasSrc, isRetrying, showErrorState, showFallback, normalizedSrc]);

  const handleError = () => {
    if (!hasSrc) return;
    if (errorCount < maxRetries) {
      const delay = (errorCount + 1) * 3000;
      if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
      // Помечаем ожидание ретрая, чтобы эффект не ставил запрос в очередь до конца задержки.
      setIsAllowedToLoad(false);
      setIsRetrying(true);

      retryTimeoutRef.current = setTimeout(() => {
        retryTimeoutRef.current = null;
        setErrorCount(prev => prev + 1);
        setIsRetrying(false);
      }, delay);
    } else {
      setIsRetrying(false);
      setShowErrorState(true);
    }
  };

  const defaultPlaceholder = <div className={styles.shimmer} />;
  // Пустой src сразу показывает заглушку, не залипая в шиммере ожидания загрузки.
  const shouldShowFallback = !hasSrc || showFallback;

  return (
    <div
      ref={containerRef}
      className={className ? `${styles.container} ${className}` : styles.container}
    >
      {shouldShowFallback ? (
        fallback ?? <CoverPlaceholder />
      ) : showErrorState ? (
        placeholder ?? defaultPlaceholder
      ) : (
        <>
          {!isLoaded && (placeholder ?? defaultPlaceholder)}
          {isAllowedToLoad ? (
            <img
              src={currentSrc}
              alt={alt}
              onLoad={() => setIsLoaded(true)}
              onError={handleError}
              className={isLoaded ? `${styles.image} ${styles.imageLoaded}` : styles.image}
              {...props}
            />
          ) : null}
        </>
      )}
    </div>
  );
});

LazyImage.displayName = 'LazyImage';
