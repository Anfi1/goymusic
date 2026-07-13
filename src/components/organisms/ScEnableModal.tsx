import React from 'react';
import { createPortal } from 'react-dom';
import styles from './ScEnableModal.module.css';

interface ScEnableModalProps {
    isOpen: boolean;
    onClose: (enable: boolean) => void;
}

export const ScEnableModal: React.FC<ScEnableModalProps> = ({ isOpen, onClose }) => {
    if (!isOpen) return null;

    return createPortal(
        <div className={styles.overlay} onClick={() => onClose(false)}>
            <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
                <h3 className={styles.title}>SoundCloud — Mirror Liked Songs</h3>
                <p className={styles.subtitle}>
                    A local mirror of your liked tracks is required for SoundCloud
                    integration to work correctly. It enables like status display
                    in radio, search and recommendations, and sorts Liked Songs by album.
                    All data stays on your device.
                </p>
                <div className={styles.actions}>
                    <button
                        className={styles.btnSecondary}
                        onClick={() => onClose(false)}
                    >Cancel</button>
                    <button
                        className={styles.btnPrimary}
                        onClick={() => onClose(true)}
                    >Enable</button>
                </div>
            </div>
        </div>,
        document.body
    );
};
