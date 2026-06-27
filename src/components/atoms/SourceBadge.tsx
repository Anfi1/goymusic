import { memo } from 'react';
import { Cloud } from 'lucide-react';
import { resolveSource } from '../../api/source';
import styles from './SourceBadge.module.css';

interface SourceBadgeProps {
  source?: unknown;
  size?: number;
}

// Помечаем только SoundCloud; YouTube не помечаем — меньше визуального шума.
export const SourceBadge = memo(({ source, size = 14 }: SourceBadgeProps) => {
  if (resolveSource(source) !== 'soundcloud') return null;
  return (
    <span className={styles.badge} data-tooltip="SoundCloud">
      <Cloud size={size} color="#ff5500" />
    </span>
  );
});

SourceBadge.displayName = 'SourceBadge';
