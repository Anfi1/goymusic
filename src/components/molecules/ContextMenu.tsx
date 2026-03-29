import React, { useEffect, useRef, useState, useLayoutEffect, memo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { LucideIcon, ChevronRight, Loader2 } from 'lucide-react';
import styles from './ContextMenu.module.css';

export interface ContextMenuItem {
  /** Текст пункта меню */
  label: string;
  /** Иконка (LucideIcon) */
  icon?: LucideIcon;
  /** Обработчик нажатия (может быть асинхронным) */
  onClick?: () => void | Promise<void>;
  /** Флаг "опасного" действия (удаление и т.д.) */
  isDanger?: boolean;
  /** Подменю */
  children?: ContextMenuItem[];
  /** Флаг состояния загрузки (скелетон) */
  isSkeleton?: boolean;
  /** Внутренний флаг выполнения действия */
  isLoading?: boolean;
}

interface ContextMenuProps {
  /** Координата X появления меню */
  x: number;
  /** Координата Y появления меню */
  y: number;
  /** Список пунктов меню */
  items: ContextMenuItem[];
  /** Обработчик закрытия меню */
  onClose: () => void;
}

const EMPTY_STYLES: React.CSSProperties = {};

/**
 * <summary>
 * Компонент одного пункта меню для мемоизации.
 * </summary>
 */
const MenuItem = memo(({
  item,
  index,
  isActive,
  isLeaving,
  isLoading,
  onMouseEnter,
  onMouseLeave,
  onClick,
  subMenuStyles
}: {
  item: ContextMenuItem;
  index: number;
  isActive: boolean;
  isLeaving: boolean;
  isLoading: boolean;
  onMouseEnter: (i: number, el: HTMLDivElement | null) => void;
  onMouseLeave: () => void;
  onClick: (e: React.MouseEvent, item: ContextMenuItem, index: number) => void;
  subMenuStyles?: React.CSSProperties;
}) => {
  const itemRef = useRef<HTMLDivElement>(null);
  
  if (item.isSkeleton) {
    return (
      <div className={`${styles.item} ${styles.skeleton}`} style={{ padding: '10px 12px' }}>
        <div className={styles.skeletonBar} />
      </div>
    );
  }

  const Icon = item.icon;

  return (
    <div
      ref={itemRef}
      className={`${styles.item} ${item.isDanger ? styles.danger : ''} ${item.children ? styles.hasChildren : ''} ${isActive ? styles.active : ''} ${isLoading ? styles.loading : ''}`}
      onMouseEnter={() => onMouseEnter(index, itemRef.current)}
      onMouseLeave={onMouseLeave}
      onClick={(e) => onClick(e, item, index)}
    >
      <div className={styles.icon}>
        {isLoading ? (
          <Loader2 size={16} className={styles.spinner} />
        ) : Icon ? (
          <Icon size={16} />
        ) : null}
      </div>
      <span className={styles.label}>{item.label}</span>
      {item.children && !isLoading && <ChevronRight size={14} className={styles.chevron} />}

      {item.children && (isActive || isLeaving) && !isLoading && (
        <div className={`${styles.subMenu} ${isLeaving ? styles.leaving : ''}`} style={subMenuStyles || EMPTY_STYLES}>
          <MenuList items={item.children} onClose={onMouseLeave} /> 
        </div>
      )}
    </div>
  );
});

MenuItem.displayName = 'MenuItem';

/**
 * <summary>
 * Вложенный компонент для отрисовки элементов меню и подменю.
 * </summary>
 */
const MenuList: React.FC<{ items: ContextMenuItem[]; onClose: () => void }> = memo(({ items, onClose }) => {
  const [activeSubMenu, setActiveSubMenu] = useState<number | null>(null);
  const [leavingSubMenu, setLeavingSubMenu] = useState<number | null>(null);
  const [loadingIndex, setLoadingIndex] = useState<number | null>(null);

  // Refs so callbacks don't need these values as deps
  const activeSubMenuRef = useRef<number | null>(null);
  const loadingIndexRef = useRef<number | null>(null);

  const subMenuTimeoutRef = useRef<any>(null);
  const leaveTimeoutRef = useRef<any>(null);
  const switchTimeoutRef = useRef<any>(null);

  const [subMenuStyles, setSubMenuStyles] = useState<React.CSSProperties>(EMPTY_STYLES);

  const handleMouseEnter = useCallback((i: number, el: HTMLDivElement | null) => {
    if (subMenuTimeoutRef.current) clearTimeout(subMenuTimeoutRef.current);
    if (leaveTimeoutRef.current) clearTimeout(leaveTimeoutRef.current);
    if (switchTimeoutRef.current) clearTimeout(switchTimeoutRef.current);

    const performSwitch = () => {
      setLeavingSubMenu(null);
      activeSubMenuRef.current = i;
      setActiveSubMenu(i);

      const item = items[i];
      if (item?.children && el) {
        const rect = el.getBoundingClientRect();
        const spaceRight = window.innerWidth - rect.right;
        const spaceBottom = window.innerHeight - rect.top;
        const newStyles: React.CSSProperties = {};
        if (spaceRight < 200) { newStyles.left = 'auto'; newStyles.right = '100%'; newStyles.paddingRight = '4px'; }
        else { newStyles.left = '100%'; newStyles.right = 'auto'; newStyles.paddingLeft = '4px'; }
        if (spaceBottom < 300) { newStyles.top = 'auto'; newStyles.bottom = '-6px'; }
        else { newStyles.top = '-6px'; newStyles.bottom = 'auto'; }
        setSubMenuStyles(newStyles);
      }
    };

    // Задержка при переключении между пунктами (triangle problem)
    if (activeSubMenuRef.current !== null && activeSubMenuRef.current !== i) {
      switchTimeoutRef.current = setTimeout(performSwitch, 200);
    } else {
      performSwitch();
    }
  }, [items]); // activeSubMenu removed — use ref instead

  const handleMouseLeave = useCallback(() => {
    if (switchTimeoutRef.current) clearTimeout(switchTimeoutRef.current);
    subMenuTimeoutRef.current = setTimeout(() => {
      setLeavingSubMenu(activeSubMenuRef.current);
      activeSubMenuRef.current = null;
      setActiveSubMenu(null);
      leaveTimeoutRef.current = setTimeout(() => {
        setLeavingSubMenu(null);
        setSubMenuStyles(EMPTY_STYLES);
      }, 500);
    }, 150);
  }, []); // stable — no deps

  const handleItemClick = useCallback(async (e: React.MouseEvent, item: ContextMenuItem, index: number) => {
    if (item.children || item.isSkeleton || loadingIndexRef.current !== null) {
      e.stopPropagation();
      return;
    }
    e.stopPropagation();
    if (item.onClick) {
      const result = item.onClick();
      if (result instanceof Promise) {
        loadingIndexRef.current = index;
        setLoadingIndex(index);
        try { await result; } finally {
          loadingIndexRef.current = null;
          setLoadingIndex(null);
          onClose();
        }
      } else {
        onClose();
      }
    } else {
      onClose();
    }
  }, [onClose]); // loadingIndex removed — use ref instead

  return (
    <>
      {items.map((item, i) => (
        <MenuItem
          key={item.isSkeleton ? `skeleton-${i}` : `${item.label}-${i}`}
          item={item}
          index={i}
          isActive={activeSubMenu === i}
          isLeaving={leavingSubMenu === i}
          isLoading={loadingIndex === i}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          onClick={handleItemClick}
          subMenuStyles={(activeSubMenu === i || leavingSubMenu === i) ? subMenuStyles : undefined}
        />
      ))}
    </>
  );
});

MenuList.displayName = 'MenuList';

/**
 * <summary>
 * Компонент контекстного меню.
 * </summary>
 */
export const ContextMenu: React.FC<ContextMenuProps> = ({ x, y, items, onClose }) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    if (menuRef.current) {
      const menuRect = menuRef.current.getBoundingClientRect();
      let newX = x;
      let newY = y;

      if (x + menuRect.width > window.innerWidth) {
        newX = x - menuRect.width;
      }

      if (y + menuRect.height > window.innerHeight) {
        newY = window.innerHeight - menuRect.height - 10;
      }

      setPos({ x: Math.max(10, newX), y: Math.max(10, newY) });
    }
  }, [x, y]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return createPortal(
    <>
      <div className={styles.overlay} onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div 
        ref={menuRef}
        className={styles.menu}
        style={{ top: pos.y, left: pos.x }}
      >
        <MenuList items={items} onClose={onClose} />
      </div>
    </>,
    document.body
  );
};
