import { memo } from 'react';

interface YouTubeMusicIconProps {
  size?: number;
  className?: string;
  color?: string;
}

// Официальная иконка YouTube Music (кольцо + play-треугольник), брендовый красный по умолчанию.
export const YouTubeMusicIcon = memo(({ size = 16, className, color = '#FF0000' }: YouTubeMusicIconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={color} className={className} aria-hidden="true">
    <path d="M12 0C5.376 0 0 5.376 0 12s5.376 12 12 12 12-5.376 12-12S18.624 0 12 0zm0 19.104c-3.924 0-7.104-3.18-7.104-7.104S8.076 4.896 12 4.896s7.104 3.18 7.104 7.104-3.18 7.104-7.104 7.104zm0-13.332c-3.432 0-6.228 2.796-6.228 6.228S8.568 18.228 12 18.228s6.228-2.796 6.228-6.228S15.432 5.772 12 5.772zM9.684 15.54V8.46L15.816 12l-6.132 3.54z" />
  </svg>
));

YouTubeMusicIcon.displayName = 'YouTubeMusicIcon';
