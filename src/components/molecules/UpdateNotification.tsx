import React, { useState, useEffect } from 'react';
import { Download, RefreshCw, ArrowDownCircle } from 'lucide-react';
import styles from './UpdateNotification.module.css';

type UpdateState = 'idle' | 'available' | 'downloading' | 'downloaded';

interface UpdateInfo {
  version: string;
}

interface ProgressInfo {
  percent: number;
  speed: number;
  transferred: number;
  total: number;
}

export const UpdateNotification: React.FC = () => {
  const [state, setState] = useState<UpdateState>('idle');
  const [version, setVersion] = useState('');
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const bridge = (window as any).bridge;
    if (!bridge) return;

    const unsubAvailable = bridge.onUpdateAvailable?.((info: UpdateInfo) => {
      setVersion(info.version);
      setState('available');
    });

    const unsubProgress = bridge.onUpdateProgress?.((p: ProgressInfo) => {
      setProgress(Math.round(p.percent));
    });

    const unsubDownloaded = bridge.onUpdateDownloaded?.(() => {
      setState('downloaded');
    });

    return () => {
      unsubAvailable?.();
      unsubProgress?.();
      unsubDownloaded?.();
    };
  }, []);

  if (state === 'idle') return null;

  const handleDownload = () => {
    setState('downloading');
    setProgress(0);
    (window as any).bridge?.downloadUpdate?.();
  };

  const handleInstall = () => {
    (window as any).bridge?.installUpdate?.();
  };

  const handleDismiss = () => {
    setState('idle');
  };

  return (
    <div className={styles.updateBar}>
      <ArrowDownCircle size={18} className={styles.icon} />
      <div className={styles.text}>
        {state === 'available' && (
          <>Доступна версия <span className={styles.version}>{version}</span></>
        )}
        {state === 'downloading' && (
          <>
            Загрузка... {progress}%
            <div className={styles.progressWrap}>
              <div className={styles.progressBar} style={{ width: `${progress}%` }} />
            </div>
          </>
        )}
        {state === 'downloaded' && (
          <>Обновление загружено — перезапустите</>
        )}
      </div>
      <div className={styles.actions}>
        {state === 'available' && (
          <>
            <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={handleDownload}>
              <Download size={14} />
            </button>
            <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={handleDismiss}>
              Позже
            </button>
          </>
        )}
        {state === 'downloading' && (
          <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>{progress}%</span>
        )}
        {state === 'downloaded' && (
          <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={handleInstall}>
            <RefreshCw size={14} />
          </button>
        )}
      </div>
    </div>
  );
};
