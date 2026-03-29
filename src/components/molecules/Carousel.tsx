import React, { useState, useEffect, useCallback, useRef, memo } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import styles from './Carousel.module.css';

interface CarouselProps {
  items: any[];
  renderItem: (item: any, index: number) => React.ReactNode;
  className?: string; // Class for the wrapper
  containerClassName?: string; // Class for the scrollable area
  scrollBtnClassName?: string;
  itemClassName?: string;
}

export const Carousel = memo(({ 
  items, 
  renderItem, 
  className = '', 
  containerClassName = '',
  scrollBtnClassName = '',
  itemClassName = ''
}: CarouselProps) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showLeft, setShowLeft] = useState(false);
  const [showRight, setShowRight] = useState(true);
  
  // Drag-to-scroll state
  const [isDragging, setIsDragging] = useState(false);
  const startX = useRef(0);
  const scrollLeftStart = useRef(0);
  const [hasMoved, setHasMoved] = useState(false);

  const checkScroll = useCallback(() => {
    if (scrollRef.current) {
      const { scrollLeft, scrollWidth, clientWidth } = scrollRef.current;
      setShowLeft(scrollLeft > 10);
      setShowRight(scrollLeft < scrollWidth - clientWidth - 10);
    }
  }, []);

  useEffect(() => {
    checkScroll();
    const handleResize = () => checkScroll();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [checkScroll, items]);

  // Global Mouse Events for seamless dragging
  useEffect(() => {
    if (!isDragging) return;

    const onMouseMove = (e: MouseEvent) => {
      if (!scrollRef.current) return;
      const x = e.pageX - scrollRef.current.offsetLeft;
      const walk = (x - startX.current) * 1.5;
      const moveAmount = Math.abs(x - startX.current);
      
      if (moveAmount > 5) setHasMoved(true);
      
      scrollRef.current.scrollLeft = scrollLeftStart.current - walk;
      checkScroll();
    };

    const onMouseUp = () => {
      setIsDragging(false);
      document.body.classList.remove('is-dragging-carousel');
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [isDragging, checkScroll]);

  const scroll = (direction: 'left' | 'right') => {
    if (scrollRef.current) {
      const amount = scrollRef.current.clientWidth * 0.8;
      scrollRef.current.scrollBy({ left: direction === 'left' ? -amount : amount, behavior: 'smooth' });
    }
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (!scrollRef.current || e.button !== 0) return; // Only left click
    setIsDragging(true);
    setHasMoved(false);
    startX.current = e.pageX - scrollRef.current.offsetLeft;
    scrollLeftStart.current = scrollRef.current.scrollLeft;
    document.body.classList.add('is-dragging-carousel');
  };

  return (
    <div className={`${styles.scrollWrapper} ${className}`}>
      {showLeft && (
        <button 
          className={`${styles.scrollBtn} ${styles.left} ${scrollBtnClassName}`} 
          onClick={() => scroll('left')}
        >
          <ChevronLeft size={20} />
        </button>
      )}
      <div 
        className={`${styles.horizontalScroll} ${containerClassName} ${isDragging ? styles.dragging : ''}`} 
        ref={scrollRef} 
        onScroll={checkScroll}
        onMouseDown={onMouseDown}
      >
        {items.map((item, idx) => (
          <div key={idx} className={itemClassName} onClickCapture={hasMoved ? (e) => e.stopPropagation() : undefined}>
            {renderItem(item, idx)}
          </div>
        ))}
      </div>
      {showRight && (
        <button 
          className={`${styles.scrollBtn} ${styles.right} ${scrollBtnClassName}`} 
          onClick={() => scroll('right')}
        >
          <ChevronRight size={20} />
        </button>
      )}
    </div>
  );
});
