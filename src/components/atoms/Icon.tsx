import React from 'react';
import { LucideIcon } from 'lucide-react';
import styles from './Icon.module.css';

interface IconProps {
  icon: LucideIcon;
  size?: number;
  className?: string;
  color?: string;
}

/**
 * Atom: Icon
 * A wrapper for Lucide icons to ensure consistent sizing and styling.
 */
export const Icon: React.FC<IconProps> = ({ 
  icon: LucideIcon, 
  size = 18, 
  className,
  color = 'currentColor' 
}) => {
  return (
    <LucideIcon 
      size={size} 
      className={`${styles.icon} ${className || ''}`} 
      stroke={color}
    />
  );
};
