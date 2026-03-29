import React from 'react';
import { LucideIcon, Loader2 } from 'lucide-react';
import styles from './IconButton.module.css';

export interface IconButtonProps {
  icon: LucideIcon;
  onClick?: (e: React.MouseEvent) => void;
  size?: number;
  iconSize?: number;
  active?: boolean;
  variant?: 'ghost' | 'solid' | 'outline';
  className?: string;
  disabled?: boolean;
  isLoading?: boolean;
  title?: string;
  color?: string;
  fill?: string;
}

export const IconButton: React.FC<IconButtonProps> = React.memo(({
  icon: Icon,
  onClick,
  size = 40,
  iconSize = 20,
  active = false,
  variant = 'ghost',
  className = '',
  disabled = false,
  isLoading = false,
  title,
  color,
  fill
}) => {
  return (
    <button
      className={`${styles.button} ${styles[variant]} ${active ? styles.active : ''} ${isLoading ? styles.loading : ''} ${className}`}
      onClick={isLoading ? undefined : onClick}
      style={{ width: size, height: size }}
      disabled={disabled || isLoading}
      data-tooltip={isLoading ? 'Loading...' : title}
    >
      <div className={styles.content}>
        <div className={styles.iconWrapper}>
          <Icon size={iconSize} color={color} fill={fill || 'none'} />
        </div>
        <div className={styles.loaderWrapper}>
          <Loader2 size={iconSize} className={styles.spinner} />
        </div>
      </div>
    </button>
  );
});
