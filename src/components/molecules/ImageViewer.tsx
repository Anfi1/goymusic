import React, { useState, useEffect, useCallback } from 'react';
import styles from './ImageViewer.module.css';

export let globalOpenImageViewer: (url: string, title: string) => void = () => {};

export const ImageViewer: React.FC = () => {
  const [imgData, setImgData] = useState<{ url: string, title: string } | null>(null);
  const [isVisible, setIsVisible] = useState(false);

  const open = useCallback((url: string, title: string) => {
    setImgData({ url, title });
    setIsVisible(true);
  }, []);

  useEffect(() => {
    globalOpenImageViewer = open;
    
    const handleOpen = (e: any) => {
      const data = e.detail || (e as any).data;
      if (data?.url) open(data.url, data.title);
    };

    window.addEventListener('open-image-viewer' as any, handleOpen);
    return () => window.removeEventListener('open-image-viewer' as any, handleOpen);
  }, [open]);

  const close = useCallback(() => {
    setIsVisible(false);
    setTimeout(() => setImgData(null), 300);
  }, []);

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [close]);

  if (!imgData) return null;

  // YT Music URL high-res transformation
  const highResUrl = imgData.url.replace(/=w\d+-h\d+.*$/, '=w1200-h1200-l100-rj');

  return (
    <div 
      className={`${styles.overlay} ${isVisible ? styles.visible : ''}`} 
      onClick={close} // Click ANYWHERE to close
    >
      <div className={styles.content}>
        <img 
          src={highResUrl} 
          alt={imgData.title} 
          className={styles.image} 
          onLoad={(e) => (e.currentTarget as HTMLImageElement).classList.add(styles.loaded)}
          onError={(e) => {
            const img = e.currentTarget as HTMLImageElement;
            if (img.src !== imgData.url) img.src = imgData.url;
          }}
        />
      </div>
    </div>
  );
};

export const openImageViewer = (url: string, title: string) => {
  if (globalOpenImageViewer) {
    globalOpenImageViewer(url, title);
  }
  
  const event = new CustomEvent('open-image-viewer', { 
    detail: { url, title }
  });
  window.dispatchEvent(event);
};
