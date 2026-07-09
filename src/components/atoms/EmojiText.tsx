import React, { useEffect, useRef } from 'react';
import twemoji from 'twemoji';

interface EmojiTextProps {
  emoji: string;
  className?: string;
  style?: React.CSSProperties;
}

export const EmojiText: React.FC<EmojiTextProps> = ({ emoji, className, style }) => {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    ref.current.textContent = emoji;
    twemoji.parse(ref.current, { folder: 'svg', ext: '.svg' });
  }, [emoji]);

  return <span ref={ref} className={className} style={style} />;
};
