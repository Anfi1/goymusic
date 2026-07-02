import React from 'react';
import { Loader2, Check } from 'lucide-react';
import { moodTagCategories } from '../../utils/curatedMix';
import styles from './CuratePanel.module.css';

interface CuratePanelProps {
  selected: string[];
  onToggle: (id: string) => void;
  onBuild: () => void;
  building: boolean;
  onClose: () => void;
}

export const CuratePanel: React.FC<CuratePanelProps> = ({ selected, onToggle, onBuild, building, onClose }) => {
  const cats = moodTagCategories();
  return (
    <div className={styles.panel} role="dialog" aria-label="Подбор настроений">
      <div className={styles.list}>
        {cats.map(cat => {
          const on = selected.includes(cat.id);
          return (
            <button
              key={cat.id}
              type="button"
              className={`${styles.row} ${on ? styles.rowOn : ''}`}
              style={{ '--mood-color': cat.color } as React.CSSProperties}
              onClick={() => onToggle(cat.id)}
              aria-pressed={on}
            >
              <span className={styles.check}>{on && <Check size={13} />}</span>
              <span className={styles.emoji}>{cat.emoji}</span>
              <span className={styles.label}>{cat.label}</span>
            </button>
          );
        })}
      </div>
      <div className={styles.footer}>
        <button type="button" className={styles.cancel} onClick={onClose} disabled={building}>Отмена</button>
        <button
          type="button"
          className={styles.build}
          onClick={onBuild}
          disabled={selected.length === 0 || building}
        >
          {building ? <Loader2 size={15} className={styles.spin} /> : `Собрать микс${selected.length ? ` (${selected.length})` : ''}`}
        </button>
      </div>
    </div>
  );
};
