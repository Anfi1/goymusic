import React, { useEffect, useRef, useState, useCallback } from 'react';
import styles from './BottomSheet.module.css';

interface BottomSheetProps {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
}

export function BottomSheet({ isOpen, onClose, children }: BottomSheetProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [dragY, setDragY] = useState(0);
  const startY = useRef(0);
  const velocityRef = useRef(0);
  const lastY = useRef(0);
  const lastTime = useRef(0);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    startY.current = touch.clientY;
    lastY.current = touch.clientY;
    lastTime.current = Date.now();
    velocityRef.current = 0;
    setIsDragging(true);
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!isDragging) return;
    const touch = e.touches[0];
    const deltaY = touch.clientY - startY.current;
    const now = Date.now();
    const dt = now - lastTime.current;
    if (dt > 0) {
      velocityRef.current = (touch.clientY - lastY.current) / dt;
    }
    lastY.current = touch.clientY;
    lastTime.current = now;
    if (deltaY > 0) {
      setDragY(deltaY);
    }
  }, [isDragging]);

  const handleTouchEnd = useCallback(() => {
    setIsDragging(false);
    const velocity = velocityRef.current;
    if (dragY > 100 || velocity > 0.5) {
      onClose();
    }
    setDragY(0);
  }, [dragY, onClose]);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div 
      className={`${styles.sheet} ${isDragging ? styles.dragging : ''}`}
      style={{ 
        transform: `translateY(${dragY}px)`,
        transition: isDragging ? 'none' : 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)'
      }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      <div className={styles.handle} />
      <div className={styles.content}>
        {children}
      </div>
    </div>
  );
}
