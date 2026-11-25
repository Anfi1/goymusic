import React from 'react';
import { Download, RefreshCw, ArrowDownCircle } from 'lucide-react';
import { shouldShowUpdateBanner, updateStore, useUpdateState } from '../../api/updateStore';
import styles from './UpdateNotification.module.css';

export const UpdateNotification: React.FC = () => {
  const snapshot = useUpdateState();

  if (!shouldShowUpdateBanner(snapshot)) return null;

  const { status, availableVersion: version, progress } = snapshot;

  const handleDownload = () => {
    void updateStore.downloadUpdate();
  };

  const handleInstall = () => {
    void updateStore.installUpdate();
  };

  const handleDismiss = () => {
    updateStore.dismissBanner();
  };

  return (
    <div className={styles.updateBar}>
      <ArrowDownCircle size={18} className={styles.icon} />
      <div className={styles.text}>
        {status === 'available' && (
          <>Доступна версия <span className={styles.version}>{version}</span></>
        )}
        {status === 'downloading' && (
          <>
            Загрузка... {progress}%
            <div className={styles.progressWrap} role="progressbar" aria-label="Загрузка обновления" aria-valuenow={progress}>
              <div className={styles.progressBar} style={{ width: `${progress}%` }} />
            </div>
          </>
        )}
        {status === 'downloaded' && (
          <>Обновление загружено — перезапустите</>
        )}
      </div>
      {status !== 'downloading' && <div className={styles.actions}>
        {status === 'available' && (
          <>
            <button className={`${styles.btn} ${styles.btnPrimary}`} aria-label="Скачать обновление" onClick={handleDownload}>
              <Download size={14} />
            </button>
            <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={handleDismiss}>
              Позже
            </button>
          </>
        )}
        {status === 'downloaded' && (
          <button className={`${styles.btn} ${styles.btnPrimary}`} aria-label="Установить обновление" onClick={handleInstall}>
            <RefreshCw size={14} />
          </button>
        )}
      </div>}
    </div>
  );
};
