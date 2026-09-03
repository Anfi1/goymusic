import { memo } from 'react';
import { Cloud } from 'lucide-react';
import { resolveSource } from '../../api/source';
import { YandexMusicIcon } from './YandexMusicIcon';
import styles from './SourceBadge.module.css';

interface SourceBadgeProps {
  source?: unknown;
  size?: number;
}

// Помечаем только SoundCloud и Yandex; YouTube не помечаем — меньше визуального шума.
export const SourceBadge = memo(({ source, size = 14 }: SourceBadgeProps) => {
  const resolved = resolveSource(source);
  if (resolved === 'soundcloud') {
    return (
      <span className={styles.badge} data-tooltip="SoundCloud">
        <Cloud size={size} color="#ff5500" />
      </span>
    );
  }
  if (resolved === 'yandex') {
    return (
      <span className={styles.badge} data-tooltip="Yandex Music">
        <YandexMusicIcon size={size} />
      </span>
    );
  }
  return null;
});

SourceBadge.displayName = 'SourceBadge';
