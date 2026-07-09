import React, { useState, useEffect, useCallback } from 'react';
import { Copy } from 'lucide-react';
import { ContextMenu, ContextMenuItem } from './ContextMenu';
import styles from './ImageViewer.module.css';

export let globalOpenImageViewer: (url: string, title: string) => void = () => {};

export const ImageViewer: React.FC = () => {
  const [imgData, setImgData] = useState<{ url: string, title: string } | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [ctxPos, setCtxPos] = useState<{ x: number; y: number } | null>(null);

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
    setCtxPos(null);
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

  const highResUrl = imgData.url.replace(/=w\d+-h\d+.*$/, '=w1200-h1200-l100-rj');

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxPos({ x: e.clientX, y: e.clientY });
  };

  const handleCopyImage = async () => {
    const img = document.querySelector(`.${styles.image}`) as HTMLImageElement | null;
    if (img) {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d')!.drawImage(img, 0, 0);
      canvas.toBlob(async (blob) => {
        if (blob) {
          await navigator.clipboard.write([
            new ClipboardItem({ 'image/png': blob })
          ]);
        }
      }, 'image/png');
    }
    setCtxPos(null);
  };

  const ctxItems: ContextMenuItem[] = [
    { label: 'Copy Image', icon: Copy, onClick: handleCopyImage }
  ];

  return (
    <div
      className={`${styles.overlay} ${isVisible ? styles.visible : ''}`}
      onClick={close}
    >
      <div className={styles.content}>
        <img
          src={highResUrl}
          alt={imgData.title}
          className={styles.image}
          onContextMenu={handleContextMenu}
          onLoad={(e) => (e.currentTarget as HTMLImageElement).classList.add(styles.loaded)}
          onError={(e) => {
            const img = e.currentTarget as HTMLImageElement;
            if (img.src !== imgData.url) img.src = imgData.url;
          }}
          onClick={e => e.stopPropagation()}
        />
      </div>

      {ctxPos && (
        <ContextMenu
          x={ctxPos.x}
          y={ctxPos.y}
          items={ctxItems}
          onClose={() => setCtxPos(null)}
        />
      )}
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
