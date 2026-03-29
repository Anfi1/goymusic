import React, { useState, useEffect } from 'react';
import { clearTokens } from '../../api/yt';
import { player } from '../../api/player';
import { historyStore } from '../../api/history';
import { historyManager } from '../../api/historyManager';
import { likedStore } from '../../api/likedStore';
import { likedManager } from '../../api/likedManager';
import { clearAllOverrides } from '../../api/localOverrides';
import { YandexImportModal } from './YandexImportModal';
import styles from './SettingsView.module.css';
import { Trash2, ShieldCheck, FolderOpen } from 'lucide-react';

interface SettingsViewProps {
    onLogout: () => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({ onLogout }) => {
    const [yandexModalOpen, setYandexModalOpen] = useState(false);
    const [rpcEnabled, setRpcEnabled] = useState(player.rpcEnabled);
    const [normalizationEnabled, setNormalizationEnabled] = useState(player.normalizationEnabled);
    const [historyEnabled, setHistoryEnabled] = useState(historyManager.isEnabled);
    const [historyCleanup, setHistoryCleanup] = useState(historyManager.cleanupInterval);
    const [likedEnabled, setLikedEnabled] = useState(likedManager.isEnabled);
    const [songsPath, setSongsPath] = useState<string>('');
    const [pathWarning, setPathWarning] = useState(false);

    useEffect(() => {
        const unsubscribe = player.subscribe((event) => {
            if (event === 'state') {
                setRpcEnabled(player.rpcEnabled);
                setNormalizationEnabled(player.normalizationEnabled);
            }
        });
        return unsubscribe;
    }, []);

    useEffect(() => {
        (window as any).bridge.getSongsPath().then(setSongsPath);
    }, []);

    const handleChangeSongsFolder = async () => {
        const picked = await (window as any).bridge.pickSongsFolder();
        if (!picked) return;
        await (window as any).bridge.setSongsPath(picked);
        setSongsPath(picked);
        setPathWarning(true);
    };

    const clearCache = () => {
        player.reset();
        (window as any).bridge.clearCache().then(() => {
            alert('Local player cache and logs cleared.');
        });
    };

    const handleToggleRPC = () => {
        player.toggleRPC();
    };

    const handleToggleNormalization = () => {
        player.toggleNormalization();
    };

    const handleToggleHistory = () => {
        historyManager.toggleHistory();
        setHistoryEnabled(historyManager.isEnabled);
    };

    const handleCleanupChange = (interval: any) => {
        historyManager.setCleanupInterval(interval);
        setHistoryCleanup(interval);
    };

    const handleToggleLiked = () => {
        const newVal = !likedEnabled;
        likedManager.toggleEnabled(newVal);
        setLikedEnabled(newVal);
    };

    const clearLikedData = async () => {
        if (confirm('This will delete all locally mirrored liked tracks. Metadata and sorting by album for Liked Songs will be unavailable until next sync. Continue?')) {
            await likedStore.clearAllTracks();
            await likedStore.setVirtualCount(0);
            alert('Liked songs cache cleared.');
        }
    };

    const handleResetOverrides = async () => {
        const ok = confirm(
            'This will RESET all local track overrides (bindings).\n\n' +
            'Only the links will be removed (files in Songs folder are NOT deleted).\n\n' +
            'Press OK only if you understand why you need this.'
        );
        if (!ok) return;
        await clearAllOverrides();
        alert('Local overrides reset.');
    };

    return (
        <>
        <div className={styles.container}>
            <h2 className={styles.title}>Settings</h2>

            <div className={styles.section}>
                <h3 className={styles.sectionTitle}>Imports</h3>
                <div className={styles.row}>
                    <div className={styles.col}>
                        <span>Import from Yandex Music</span>
                        <span className={styles.subtitle}>Like tracks on YouTube Music that match your Yandex Music likes.</span>
                    </div>
                    <button className={styles.btnSecondary} onClick={() => setYandexModalOpen(true)}>
                        Import
                    </button>
                </div>
            </div>

            <div className={styles.section}>
                <h3 className={styles.sectionTitle}>Integrations</h3>
                <div className={styles.row}>
                    <div className={styles.col}>
                        <span>Discord Rich Presence</span>
                        <span className={styles.subtitle}>Show what you're listening to in Discord.</span>
                    </div>
                    <label className={styles.switch}>
                        <input 
                            type="checkbox" 
                            checked={rpcEnabled} 
                            onChange={handleToggleRPC} 
                        />
                        <span className={styles.slider}></span>
                    </label>
                </div>
            </div>

            <div className={styles.section}>
                <h3 className={styles.sectionTitle}>Audio</h3>
                <div className={styles.row}>
                    <div className={styles.col}>
                        <span>Loudness Normalization</span>
                        <span className={styles.subtitle}>Automatically adjust volume to YouTube's target level (-14 LUFS).</span>
                    </div>
                    <label className={styles.switch}>
                        <input 
                            type="checkbox" 
                            checked={normalizationEnabled} 
                            onChange={handleToggleNormalization} 
                        />
                        <span className={styles.slider}></span>
                    </label>
                </div>
            </div>

            <div className={styles.section}>
                <h3 className={styles.sectionTitle}>Data & Privacy</h3>
                <div className={styles.row}>
                    <div className={styles.col}>
                        <span>Mirror Liked Songs</span>
                        <span className={styles.subtitle}>
                            Store a local copy of your liked tracks. <br/>
                            <strong style={{ color: 'var(--accent)' }}>Required for "By Album" sorting and proper History tracking.</strong>
                        </span>
                    </div>
                    <label className={styles.switch}>
                        <input 
                            type="checkbox" 
                            checked={likedEnabled} 
                            onChange={handleToggleLiked} 
                        />
                        <span className={styles.slider}></span>
                    </label>
                </div>

                <div className={styles.row}>
                    <div className={styles.col}>
                        <span>Clear Liked Cache</span>
                        <span className={styles.subtitle}>Delete local mirror of Liked Songs database.</span>
                    </div>
                    <button className={styles.btnDanger} onClick={clearLikedData}>
                        <Trash2 size={14} style={{ marginRight: '6px' }} />
                        Clear
                    </button>
                </div>

                <div className={styles.divider} />

                <div className={styles.row}>
                    <div className={styles.col}>
                        <span>Enable Local History</span>
                        <span className={styles.subtitle}>Save your listening history locally using IndexedDB.</span>
                    </div>
                    <label className={styles.switch}>
                        <input 
                            type="checkbox" 
                            checked={historyEnabled} 
                            onChange={handleToggleHistory} 
                        />
                        <span className={styles.slider}></span>
                    </label>
                </div>

                <div className={`${styles.row} ${!historyEnabled ? styles.disabled : ''}`}>
                    <div className={styles.col}>
                        <span>Auto-Cleanup</span>
                        <span className={styles.subtitle}>Automatically remove old history entries.</span>
                    </div>
                    <select 
                        className={styles.select}
                        value={historyCleanup}
                        onChange={(e) => handleCleanupChange(e.target.value as any)}
                        disabled={!historyEnabled}
                    >
                        <option value="none">Keep Forever</option>
                        <option value="weekly">Older than 1 week</option>
                        <option value="monthly">Older than 1 month</option>
                        <option value="yearly">Older than 1 year</option>
                    </select>
                </div>

                <div className={styles.row}>
                    <div className={styles.col}>
                        <span>Clear All History</span>
                        <span className={styles.subtitle}>Permanently delete all tracks from local history.</span>
                    </div>
                    <button 
                        className={styles.btnDanger} 
                        onClick={async () => {
                            if (confirm('Are you sure you want to clear your local history?')) {
                                await historyStore.clearAll();
                                alert('History cleared.');
                            }
                        }}
                    >
                        <Trash2 size={16} style={{ marginRight: '8px' }} />
                        Clear
                    </button>
                </div>
            </div>

            <div className={styles.section}>
                <h3 className={styles.sectionTitle}>Local Storage</h3>
                <div className={styles.row}>
                    <div className={styles.col}>
                        <span>Songs Folder</span>
                        <span className={styles.subtitle} style={{ wordBreak: 'break-all' }}>{songsPath || '...'}</span>
                    </div>
                    <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
                        <button className={styles.btnSecondary} onClick={() => (window as any).bridge.openSongsFolder()}>
                            <FolderOpen size={14} style={{ marginRight: '6px' }} />
                            Open
                        </button>
                        <button className={styles.btnSecondary} onClick={handleChangeSongsFolder}>
                            Change
                        </button>
                    </div>
                </div>
                {pathWarning && (
                    <div className={styles.row} style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '4px' }}>
                        <span className={styles.subtitle} style={{ color: '#fab387' }}>
                            Folder changed. Files from the old folder must be moved manually, otherwise overrides will stop working.
                        </span>
                    </div>
                )}
                <div className={styles.row}>
                    <span className={styles.subtitle}>
                        If saving fails, run the app as administrator or choose a folder that doesn't require admin rights.
                    </span>
                </div>

                <div className={styles.row}>
                    <div className={styles.col}>
                        <span>Reset Local Overrides</span>
                        <span className={styles.subtitle} style={{ color: '#f87171' }}>
                            Dangerous: clears all bindings. Click only if you know why you need this.
                        </span>
                    </div>
                    <button className={styles.btnDanger} onClick={handleResetOverrides}>
                        <Trash2 size={14} style={{ marginRight: '6px' }} />
                        Reset
                    </button>
                </div>
            </div>

            <div className={styles.section}>
                <h3 className={styles.sectionTitle}>Maintenance</h3>
                <div className={styles.row}>
                    <div className={styles.col}>
                        <span>Clear App Cache</span>
                        <span className={styles.subtitle}>Frees up local queue and session state variables.</span>
                    </div>
                    <button className={styles.btnSecondary} onClick={clearCache}>Clear</button>
                </div>
                <div className={styles.row}>
                    <div className={styles.col}>
                        <span>Log out from YouTube</span>
                        <span className={styles.subtitle}>Deletes login cookies and restarts the app.</span>
                    </div>
                    <button className={styles.btnDanger} onClick={() => {
                        clearTokens();
                        onLogout();
                    }}>Logout</button>
                </div>
            </div>
        </div>
        <YandexImportModal isOpen={yandexModalOpen} onClose={() => setYandexModalOpen(false)} />
        </>
    );
};
