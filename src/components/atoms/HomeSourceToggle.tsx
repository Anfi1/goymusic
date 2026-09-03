import { memo } from 'react';
import { YouTubeMusicIcon } from './YouTubeMusicIcon';
import { YandexMusicIcon } from './YandexMusicIcon';
import { HomeSource } from '../../api/homeSource';
import styles from './HomeSourceToggle.module.css';

interface HomeSourceToggleProps {
  value: HomeSource;
  onChange: (value: HomeSource) => void;
}

// Двухпозиционный слайдер YouTube Music / Yandex Music -- общий вид для Home,
// New Releases и Коллекций, вместо текстовой кнопки-заглушки.
export const HomeSourceToggle = memo(({ value, onChange }: HomeSourceToggleProps) => (
  <div className={styles.toggle} role="tablist" aria-label="Источник">
    <div className={`${styles.thumb} ${value === 'yandex' ? styles.thumbRight : ''}`} />
    <button
      type="button"
      role="tab"
      aria-selected={value === 'youtube'}
      className={styles.option}
      onClick={() => onChange('youtube')}
      title="YouTube Music"
    >
      <YouTubeMusicIcon size={16} />
    </button>
    <button
      type="button"
      role="tab"
      aria-selected={value === 'yandex'}
      className={styles.option}
      onClick={() => onChange('yandex')}
      title="Yandex Music"
    >
      <YandexMusicIcon size={16} />
    </button>
  </div>
));

HomeSourceToggle.displayName = 'HomeSourceToggle';
