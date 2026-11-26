import React, { memo } from 'react';
import { Music2 } from 'lucide-react';
import styles from './CoverPlaceholder.module.css';

export interface CoverPlaceholderProps {
  className?: string;
  iconSize?: number;
}

export const CoverPlaceholder: React.FC<CoverPlaceholderProps> = memo(({ className, iconSize }) => (
  <div
    className={className ? `${styles.placeholder} ${className}` : styles.placeholder}
    aria-hidden="true"
    data-cover-placeholder=""
  >
    <Music2
      size={iconSize}
      strokeWidth={1.75}
      className={iconSize === undefined ? styles.proportionalIcon : styles.icon}
    />
  </div>
));

CoverPlaceholder.displayName = 'CoverPlaceholder';
