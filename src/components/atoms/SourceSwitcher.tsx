import { memo, ReactElement } from 'react';
import { Cloud } from 'lucide-react';
import { TrackSource } from '../../api/source';
import { YandexMusicIcon } from './YandexMusicIcon';
import { YouTubeMusicIcon } from './YouTubeMusicIcon';
import styles from './SourceSwitcher.module.css';

const ICONS: Record<TrackSource, (size: number) => ReactElement> = {
  youtube: (size) => <YouTubeMusicIcon size={size} />,
  soundcloud: (size) => <Cloud size={size} color="#ff5500" />,
  yandex: (size) => <YandexMusicIcon size={size} />,
};

const TITLES: Record<TrackSource, string> = {
  youtube: 'YouTube Music',
  soundcloud: 'SoundCloud',
  yandex: 'Yandex Music',
};

interface SourceSwitcherProps {
  sources: TrackSource[];
  active: TrackSource[];
  onToggle: (source: TrackSource, next: boolean) => void;
  size?: number;
  tooltip?: string;
}

// Общий мульти-select источников иконками: очередь переключает им источники радио,
// вкладка лайков -- какие источники вообще показывать в списке.
export const SourceSwitcher = memo(({ sources, active, onToggle, size = 15, tooltip }: SourceSwitcherProps) => {
  if (sources.length <= 1) return null;
  return (
    <div className={styles.switcher} data-tooltip={tooltip}>
      {sources.map((key) => {
        const isActive = active.includes(key);
        return (
          <button
            key={key}
            className={`${styles.segment} ${isActive ? styles.segmentActive : ''}`}
            onClick={() => onToggle(key, !isActive)}
            aria-pressed={isActive}
            aria-label={TITLES[key]}
            data-tooltip={TITLES[key]}
          >
            {ICONS[key](size)}
          </button>
        );
      })}
    </div>
  );
});
