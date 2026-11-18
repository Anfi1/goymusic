import React from 'react';
import { LucideIcon } from 'lucide-react';
import { Icon } from '../atoms/Icon';
import styles from './NavLink.module.css';

interface NavLinkProps {
  icon?: LucideIcon;
  label: string;
  active?: boolean;
  onClick?: () => void;
  tooltip?: string;
  hidden?: boolean;
}

/**
 * Molecule: NavLink
 * A navigation item for the sidebar with an icon and label.
 */
export const NavLink: React.FC<NavLinkProps> = React.memo(({
  icon,
  label,
  active = false,
  onClick,
  tooltip,
  hidden
}) => {
  if (hidden) return null;
  return (
    <button
      type="button"
      className={`${styles.container} ${active ? styles.active : ''}`}
      aria-label={label || tooltip}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
      data-tooltip={tooltip || undefined}
    >
      {icon && <Icon icon={icon} size={18} className={styles.icon} />}
      <span className={styles.label}>{label}</span>
    </button>
  );
});
