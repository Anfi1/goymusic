import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Virtuoso } from 'react-virtuoso';
import { spotifyImportStreaming } from '../../api/yt';
import { YandexTrackRow, YandexTrackItem } from './YandexTrackRow';
import styles from './SpotifyImportModal.module.css';

type Stage = 'idle' | 'running' | 'done' | 'failed';

interface SpotifyImportModalProps {
    isOpen: boolean;
    onClose: () => void;
}

export const SpotifyImportModal: React.FC<SpotifyImportModalProps> = ({ isOpen, onClose }) => {
    const [token, setToken] = useState('');
    const [stage, setStage] = useState<Stage>('idle');
    const [tracks, setTracks] = useState<YandexTrackItem[]>([]);
    const [total, setTotal] = useState(0);
    const [matched, setMatched] = useState(0);
    const [notFound, setNotFound] = useState(0);
    const [error, setError] = useState('');
    const [resumeIndex, setResumeIndex] = useState(0);

    const unlistenRef = useRef<(() => void) | null>(null);
    const abortControllerRef = useRef<AbortController | null>(null);
    const processedRef = useRef(0);
    const pausedRef = useRef(false);

    useEffect(() => {
        if (!isOpen) return;
        return () => { unlistenRef.current?.(); abortControllerRef.current?.abort(); };
    }, [isOpen]);

    const renderItem = useCallback((index: number, track: YandexTrackItem) => (
        <YandexTrackRow track={track} index={index} />
    ), []);

    if (!isOpen) return null;

    const handleStart = async (startIndex: number = 0) => {
        setStage('running');
        setError('');
        processedRef.current = startIndex;
        if (startIndex === 0) {
            setTracks([]);
            setTotal(0);
            setMatched(0);
            setNotFound(0);
        }

        const controller = new AbortController();
        abortControllerRef.current = controller;

        const unlisten = (window as any).bridge.onPyEvent((msg: any) => {
            if (msg.event === 'spotify_import_total') {
                setTotal(msg.total);
            } else if (msg.event === 'spotify_track_done') {
                processedRef.current += 1;
                setTracks(prev => [...prev, {
                    title: msg.title || '',
                    artist: msg.artist || '',
                    durationMs: msg.durationMs ?? null,
                    status: msg.status,
                }]);
                if (msg.status === 'matched') setMatched(prev => prev + 1);
                else setNotFound(prev => prev + 1);
            }
        });
        unlistenRef.current = unlisten;

        try {
            await spotifyImportStreaming(token.trim(), startIndex, controller.signal);
            if (!pausedRef.current) setStage('done');
        } catch (e: unknown) {
            if (!pausedRef.current) {
                const msg = e instanceof Error ? e.message : 'Import failed';
                const count = (e as any).processedCount ?? processedRef.current;
                setError(msg);
                setResumeIndex(count);
                setStage('failed');
            }
        } finally {
            pausedRef.current = false;
            unlistenRef.current?.();
            unlistenRef.current = null;
            abortControllerRef.current = null;
        }
    };

    const handlePause = () => {
        pausedRef.current = true;
        setResumeIndex(processedRef.current);
        setError('');
        setStage('failed');
        unlistenRef.current?.();
        unlistenRef.current = null;
        abortControllerRef.current?.abort();
    };

    const handleClose = () => {
        if (stage === 'running') return;
        unlistenRef.current?.();
        unlistenRef.current = null;
        setStage('idle');
        setToken('');
        setTracks([]);
        setError('');
        setTotal(0);
        setMatched(0);
        setNotFound(0);
        setResumeIndex(0);
        onClose();
    };

    const progress = total > 0 ? Math.round((tracks.length / total) * 100) : 0;

    return createPortal(
        <div className={styles.overlay} onClick={handleClose}>
            <div className={styles.modal} onClick={e => e.stopPropagation()}>
                <h3 className={styles.title}>Import from Spotify</h3>

                {stage === 'idle' && (
                    <div className={styles.subtitle}>
                        <p style={{ margin: '0 0 10px' }}>
                            How to get your token:{' '}
                            <button
                                className={styles.guideLink}
                                onClick={() => (window as any).bridge.openExternal('https://developer.spotify.com/console/get-current-user-saved-tracks/')}
                            >
                                Open Spotify Console ↗
                            </button>
                        </p>
                        <ol className={styles.guide}>
                            <li>On the page that opens, click <strong>Authorize</strong> and log in to your Spotify account.</li>
                            <li>After authorizing, press <strong>Try it</strong> to execute the request.</li>
                            <li>Open <strong>DevTools</strong> (F12 or right-click → Inspect) and go to the <strong>Network</strong> tab.</li>
                            <li>Find any request to <code>api.spotify.com</code> in the list and click on it.</li>
                            <li>Open the <strong>Headers</strong> section and find the <strong>Authorization</strong> header.</li>
                            <li>Copy everything after <code>Bearer </code> — that is your token.</li>
                        </ol>
                        <p style={{ margin: '10px 0 0' }}>Liked songs will be matched on YouTube Music at 90% similarity.</p>
                    </div>
                )}

                {(stage === 'idle' || stage === 'failed') && (
                    <div className={styles.inputRow}>
                        <input
                            className={styles.input}
                            type="password"
                            placeholder="Spotify access token"
                            value={token}
                            onChange={e => setToken(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && stage === 'idle' && handleStart(0)}
                        />
                        <button
                            className={styles.btnPrimary}
                            onClick={() => handleStart(0)}
                            disabled={!token.trim()}
                        >
                            Import
                        </button>
                    </div>
                )}

                {(stage === 'running' || stage === 'done' || stage === 'failed') && (
                    <div className={styles.progressSection}>
                        <div className={styles.progressBar}>
                            <div
                                className={styles.progressFill}
                                style={{ width: `${stage === 'done' ? 100 : progress}%` }}
                            />
                        </div>
                        <div className={styles.progressLabel}>
                            {stage === 'done'
                                ? 'Import complete'
                                : total > 0
                                    ? `${tracks.length} / ${total}`
                                    : 'Connecting...'}
                        </div>
                        <div className={styles.counters}>
                            <span className={styles.matched}>✓ {matched} matched</span>
                            <span className={styles.notFound}>✗ {notFound} not found</span>
                        </div>
                    </div>
                )}

                {tracks.length > 0 && (
                    <div className={styles.trackList}>
                        <Virtuoso
                            style={{ height: 280 }}
                            data={tracks}
                            itemContent={renderItem}
                            followOutput="smooth"
                        />
                    </div>
                )}

                {error && <p className={styles.errorText}>{error}</p>}

                <div className={styles.actions}>
                    {stage === 'running' && (
                        <button className={styles.btnSecondary} onClick={handlePause}>
                            Pause
                        </button>
                    )}
                    {stage === 'failed' && resumeIndex > 0 && (
                        <button className={styles.btnPrimary} onClick={() => handleStart(resumeIndex)}>
                            Resume from {resumeIndex}
                        </button>
                    )}
                    <button
                        className={styles.btnSecondary}
                        onClick={handleClose}
                        disabled={stage === 'running'}
                    >
                        {stage === 'done' ? 'Close' : 'Cancel'}
                    </button>
                </div>
            </div>
        </div>,
        document.body
    );
};
