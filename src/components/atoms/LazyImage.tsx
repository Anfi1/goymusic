import React, { useState, useEffect, useRef, memo } from 'react';
import { imageQueue } from '../../utils/imageQueue';

interface LazyImageProps extends React.ImgHTMLAttributes<HTMLImageElement> {
  placeholder?: React.ReactNode;
  maxRetries?: number;
}

export const LazyImage: React.FC<LazyImageProps> = memo(({ 
  src, 
  alt, 
  className, 
  placeholder, 
  maxRetries = 3,
  ...props 
}) => {
  const [isIntersecting, setIntersecting] = useState(false);
  const [isAllowedToLoad, setIsAllowedToLoad] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);
  const [errorCount, setErrorCount] = useState(0);
  const [currentSrc, setCurrentSrc] = useState(src);
  const containerRef = useRef<HTMLDivElement>(null);
  const retryTimeoutRef = useRef<any>(null);
  const cancelRequestRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    setCurrentSrc(src);
    setErrorCount(0);
    setIsLoaded(false);
    setIsAllowedToLoad(false);
    
    if (cancelRequestRef.current) {
      cancelRequestRef.current();
      cancelRequestRef.current = null;
    }
  }, [src]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIntersecting(true);
          observer.disconnect();
        }
      },
      { rootMargin: '400px' } // Slightly more aggressive pre-loading
    );

    if (containerRef.current) {
      observer.observe(containerRef.current);
    }

    return () => {
      observer.disconnect();
      if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
      if (cancelRequestRef.current) cancelRequestRef.current();
    };
  }, []);

  const requestLoad = () => {
    if (cancelRequestRef.current) cancelRequestRef.current();
    
    cancelRequestRef.current = imageQueue.enqueue(src || '', () => {
      setIsAllowedToLoad(true);
      cancelRequestRef.current = null;
    });
  };

  useEffect(() => {
    if (isIntersecting && !isAllowedToLoad && !isLoaded && src) {
      requestLoad();
    }
  }, [isIntersecting, isAllowedToLoad, isLoaded, src]);

  const handleError = () => {
    if (errorCount < maxRetries) {
      const delay = (errorCount + 1) * 3000;
      setIsAllowedToLoad(false); // Reset allowed state to re-queue
      
      retryTimeoutRef.current = setTimeout(() => {
        setErrorCount(prev => prev + 1);
        // We try the original URL again (it might have been a transient 429)
        requestLoad();
      }, delay);
    }
  };

  const defaultPlaceholder = (
    <div style={{
      position: 'absolute',
      inset: 0,
      background: 'rgba(255,255,255,0.06)',
      animation: 'lazyImageShimmer 1.5s ease-in-out infinite',
    }} />
  );

  return (
    <div ref={containerRef} className={className} style={{ position: 'relative', overflow: 'hidden' }}>
      {!isLoaded && (placeholder ?? defaultPlaceholder)}
      {isAllowedToLoad ? (
        <img
          src={currentSrc}
          alt={alt}
          onLoad={() => setIsLoaded(true)}
          onError={handleError}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            opacity: isLoaded ? 1 : 0,
            transition: 'opacity 0.3s ease-in-out',
            display: 'block'
          }}
          {...props}
        />
      ) : null}
    </div>
  );
});
