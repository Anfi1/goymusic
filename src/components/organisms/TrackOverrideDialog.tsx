import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, Link, HardDriveDownload, FolderOpen, Trash2, X, Loader2, Save } from 'lucide-react';
import { YTMTrack } from '../../api/yt';
import { player } from '../../api/player';
import { streamCache } from '../../api/cache';
import { getOverride, setOverride, deleteOverride, LocalOverride } from '../../api/localOverrides';
import { createCallId } from '../../api/callId';
import { MiniPreviewPlayer } from '../molecules/MiniPreviewPlayer';
import styles from './TrackOverrideDialog.module.css';

interface Props {
  track: YTMTrack;
  isOpen: boolean;
  onClose: () => void;
}

type DialogState =
  | 'loading'
  | 'existing'
  | 'idle'
  | 'saving-current'
  | 'searching'
  | 'results'
  | 'previewing'
  | 'downloading'
  | 'done';

type TabId = 'current' | 'soundcloud' | 'url';

interface SearchResult {
  url: string;
  title: string;
  artist: string;
  duration: number | null;
  thumbUrl: string;
  source: string;
}

interface PreviewInfo {
  streamUrl: string;
  title: string;
  artist: string;
  duration: number | null;
  thumbUrl: string;
  sourceUrl: string;
  sourceType: LocalOverride['sourceType'];
}

export const TrackOverrideDialog: React.FC<Props> = ({ track, isOpen, onClose }) => {
  const [dialogState, setDialogState] = useState<DialogState>('loading');
  const [existingOverride, setExistingOverride] = useState<LocalOverride | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>('soundcloud');
  const [searchQuery, setSearchQuery] = useState('');
  const [urlInput, setUrlInput] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [selectedResult, setSelectedResult] = useState<SearchResult | null>(null);
  const [previewInfo, setPreviewInfo] = useState<PreviewInfo | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [statusText, setStatusText] = useState('');
  const [activeCallId, setActiveCallId] = useState<string | null>(null);
  const isCurrentTrack = player.currentTrack?.id === track.id;
  const didAutoSearchRef = useRef(false);

  const gainText = useMemo(() => {
    if (!existingOverride) return '';
    const shown = -(existingOverride.gainDb || 0);
    if (shown === 0) return '';
    const sign = shown > 0 ? '+' : '';
    return `${sign}${shown.toFixed(1)} dB`;
  }, [existingOverride]);

  // Listen for progress events from the backend
  useEffect(() => {
    if (!activeCallId) return;

    const unlisten = window.bridge.onPyEvent((msg: any) => {
      if (msg.event === 'download_progress' && msg.callId === activeCallId) {
        if (msg.status) setStatusText(msg.status);
      }
    });

    return () => {
      if (unlisten) unlisten();
    };
  }, [activeCallId]);

  const determineInitialTab = useCallback((): TabId => {
    return isCurrentTrack ? 'current' : 'soundcloud';
  }, [isCurrentTrack]);

  useEffect(() => {
    if (!isOpen) return;
    setErrorMsg('');
    setSearchResults([]);
    setSelectedResult(null);
    setPreviewInfo(null);
    didAutoSearchRef.current = false;

    getOverride(track.id).then((override) => {
      if (override) {
        setExistingOverride(override);
        setDialogState('existing');
      } else {
        setExistingOverride(null);
        const defaultTab = determineInitialTab();
        setActiveTab(defaultTab);
        const artistStr = track.artists?.join(', ') || '';
        setSearchQuery(`${artistStr} - ${track.title}`);
        setDialogState('idle');
      }
    });
  }, [isOpen, track.id]);

  // Auto-search when opening SoundCloud tab with a default query
  useEffect(() => {
    if (!isOpen) return;
    if (existingOverride) return;
    if (activeTab !== 'soundcloud') return;
    if (dialogState !== 'idle') return;
    if (!searchQuery.trim()) return;
    if (didAutoSearchRef.current) return;
    didAutoSearchRef.current = true;
    handleSearch();
  }, [isOpen, existingOverride, activeTab, dialogState, searchQuery]);

  const handleSaveCurrentStream = async () => {
    const cached = await streamCache.get(track.id);
    if (!cached) {
      setErrorMsg('Stream unavailable — no cached URL found.');
      return;
    }
    const callId = createCallId();
    setActiveCallId(callId);
    setDialogState('saving-current');
    setStatusText('Saving stream...');
    try {
      const songsPath = await (window as any).bridge.getSongsPath();
      const res = await (window as any).bridge.pyCall('download_direct', {
        streamUrl: cached.url,
        videoId: track.id,
        songsPath,
        callId,
      });
      if (res.status !== 'ok') throw new Error(res.message || 'Error');
      const override: LocalOverride = {
        videoId: track.id,
        filename: res.filename,
        sourceUrl: cached.url,
        sourceType: 'youtube',
        gainDb: cached.loudness ?? 0,
        addedAt: Date.now(),
      };
      await setOverride(override);
      setExistingOverride(override);
      setDialogState('done');
      setTimeout(onClose, 1200);
    } catch (e: any) {
      setErrorMsg(e.message || 'Save failed');
      setDialogState('idle');
    }
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setDialogState('searching');
    setErrorMsg('');
    setSearchResults([]);
    setPreviewInfo(null);
    setSelectedResult(null);
    try {
      const res = await (window as any).bridge.pyCall('search_alternatives', { query: searchQuery.trim() });
      if (res.status !== 'ok') throw new Error(res.message);
      if (!res.results?.length) {
        setErrorMsg('Nothing found. Try pasting a link manually.');
        setDialogState('idle');
        return;
      }
      setSearchResults(res.results);
      setDialogState('results');
    } catch (e: any) {
      setErrorMsg(e.message || 'Search failed');
      setDialogState('idle');
    }
  };

  const handleFindUrl = async () => {
    if (!urlInput.trim()) return;
    setErrorMsg('');
    setPreviewInfo(null);
    setSelectedResult(null);
    setStatusText('Fetching stream URL...');
    setDialogState('searching');
    try {
      const res = await (window as any).bridge.pyCall('get_preview_url', { url: urlInput.trim() });
      if (res.status !== 'ok') throw new Error(res.message);
      const sourceType = detectSourceType(urlInput.trim());
      setPreviewInfo({
        streamUrl: res.streamUrl,
        title: res.title,
        artist: res.artist,
        duration: res.duration,
        thumbUrl: res.thumbUrl,
        sourceUrl: urlInput.trim(),
        sourceType,
      });
      setDialogState('previewing');
    } catch (e: any) {
      setErrorMsg(e.message || 'Failed to get stream URL');
      setDialogState('idle');
    }
  };

  const handlePreviewResult = async (result: SearchResult) => {
    setErrorMsg('');
    setSelectedResult(result);
    setStatusText('Fetching stream URL...');
    setDialogState('searching');
    try {
      console.log('[override] get_preview_url for:', result.url);
      const res = await (window as any).bridge.pyCall('get_preview_url', { url: result.url });
      console.log('[override] get_preview_url result:', res);
      if (res.status !== 'ok') throw new Error(res.message);
      const sourceType = detectSourceType(result.url);
      setPreviewInfo({
        streamUrl: res.streamUrl,
        title: res.title || result.title,
        artist: res.artist || result.artist,
        duration: res.duration || result.duration,
        thumbUrl: res.thumbUrl || result.thumbUrl,
        sourceUrl: result.url,
        sourceType,
      });
      setDialogState('previewing');
    } catch (e: any) {
      setErrorMsg(e.message || 'Preview failed');
      setSelectedResult(null);
      setDialogState('results');
    }
  };

  const handleDownload = async () => {
    if (!previewInfo) return;
    const callId = createCallId();
    setActiveCallId(callId);
    setDialogState('downloading');
    setStatusText('Downloading and analyzing...');
    setErrorMsg('');
    try {
      const songsPath = await (window as any).bridge.getSongsPath();
      const res = await (window as any).bridge.pyCall('download_track', {
        url: previewInfo.sourceUrl,
        videoId: track.id,
        songsPath,
        callId
      });
      if (res.status !== 'ok') throw new Error(res.message || 'Download failed');
      const override: LocalOverride = {
        videoId: track.id,
        filename: res.filename,
        sourceUrl: previewInfo.sourceUrl,
        sourceType: previewInfo.sourceType,
        gainDb: res.gainDb ?? 0,
        addedAt: Date.now(),
      };
      await setOverride(override);
      setExistingOverride(override);
      setDialogState('done');
      setTimeout(onClose, 1200);
    } catch (e: any) {
      setErrorMsg(e.message || 'Download failed');
      setDialogState('previewing');
    }
  };

  const handleDeleteOverride = async () => {
    if (!existingOverride) return;
    try {
      await (window as any).bridge.deleteSongFile(existingOverride.filename);
    } catch {
      // ignore file deletion errors; still remove mapping
    }
    await deleteOverride(track.id);
    onClose();
  };

  const handleImportLocalFile = async () => {
    setErrorMsg('');
    setStatusText('Importing local file...');
    setDialogState('downloading');
    try {
      const res = await (window as any).bridge.importSongFile();
      if (!res || res.status === 'cancelled') {
        setDialogState('idle');
        return;
      }
      if (res.status !== 'ok') throw new Error(res.message || 'Import failed');

      // Analyze the imported file to get loudness gain
      setStatusText('Analyzing loudness...');
      const songsPath = await (window as any).bridge.getSongsPath();
      const analyzeRes = await (window as any).bridge.pyCall('analyze_file', {
        filename: res.filename,
        songsPath,
      });
      const gainDb = analyzeRes.status === 'ok' ? (analyzeRes.gainDb ?? 0) : 0;

      const override: LocalOverride = {
        videoId: track.id,
        filename: res.filename,
        sourceUrl: res.sourcePath || res.filename,
        sourceType: 'local',
        gainDb,
        addedAt: Date.now(),
      };
      await setOverride(override);
      setExistingOverride(override);
      setDialogState('done');
      setTimeout(onClose, 1200);
    } catch (e: any) {
      setErrorMsg(e.message || 'Import failed');
      setDialogState('idle');
    }
  };

  const handleOpenFolder = () => {
    if (!existingOverride) return;
    (window as any).bridge.openSongsFolder(existingOverride.filename);
  };

  if (!isOpen) return null;

  return createPortal(
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <div className={styles.trackInfo}>
            {track.thumbUrl && <img src={track.thumbUrl} alt="" className={styles.thumb} />}
            <div>
              <div className={styles.trackTitle}>{track.title}</div>
              <div className={styles.trackArtist}>{track.artists?.join(', ')}</div>
            </div>
          </div>
          <button className={styles.closeBtn} onClick={onClose}><X size={18} /></button>
        </div>

        <div className={styles.body}>
          {dialogState === 'loading' && (
            <div className={styles.centered}><Loader2 size={24} className={styles.spinner} /></div>
          )}

          {dialogState === 'existing' && existingOverride && (
            <div className={styles.existingView}>
              <div className={styles.existingInfo}>
                <HardDriveDownload size={20} className={styles.existingIcon} />
                <div>
                  <div className={styles.existingFilename}>{existingOverride.filename}</div>
                  <div className={styles.existingMeta}>
                    {new Date(existingOverride.addedAt).toLocaleDateString('en-US')}
                    {' · '}{existingOverride.sourceType}
                    {gainText && ` · ${gainText}`}
                  </div>
                </div>
              </div>
              <div className={styles.existingActions}>
                <button className={styles.secondaryBtn} onClick={handleOpenFolder}>
                  <FolderOpen size={16} /> Open Folder
                </button>
                <button className={`${styles.secondaryBtn} ${styles.dangerBtn}`} onClick={handleDeleteOverride}>
                  <Trash2 size={16} /> Remove Override
                </button>
              </div>
            </div>
          )}

          {(dialogState === 'idle' || dialogState === 'results' || dialogState === 'previewing') && (
            <>
              <div className={styles.tabs}>
                {isCurrentTrack && (
                  <button
                    className={`${styles.tab} ${activeTab === 'current' ? styles.tabActive : ''}`}
                    onClick={() => { setActiveTab('current'); setErrorMsg(''); }}
                  >
                    Current Stream
                  </button>
                )}
                <button
                  className={`${styles.tab} ${activeTab === 'soundcloud' ? styles.tabActive : ''}`}
                  onClick={() => { setActiveTab('soundcloud'); setErrorMsg(''); }}
                >
                  Search SoundCloud
                </button>
                <button
                  className={`${styles.tab} ${activeTab === 'url' ? styles.tabActive : ''}`}
                  onClick={() => { setActiveTab('url'); setErrorMsg(''); }}
                >
                  Paste URL
                </button>
              </div>

              {activeTab === 'current' && (
                <div className={styles.tabContent}>
                  <p className={styles.hintText}>Save the current YouTube Music stream as a local file.</p>
                  <button className={styles.primaryBtn} onClick={handleSaveCurrentStream}>
                    <Save size={16} /> Save Stream
                  </button>
                </div>
              )}

              {activeTab === 'soundcloud' && (
                <div className={styles.tabContent}>
                  <div className={styles.searchRow}>
                    <input
                      className={styles.input}
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                      placeholder="Artist - Title"
                    />
                    <button className={styles.primaryBtn} onClick={handleSearch}>
                      <Search size={16} />
                    </button>
                  </div>
                  {dialogState === 'results' && (
                    <div className={styles.resultsList}>
                      {searchResults.map((r, i) => (
                        <div
                          key={i}
                          className={`${styles.resultRow} ${selectedResult === r ? styles.resultSelected : ''}`}
                        >
                          {r.thumbUrl && <img src={r.thumbUrl} alt="" className={styles.resultThumb} />}
                          <div className={styles.resultMeta}>
                            <div className={styles.resultTitle}>{r.title}</div>
                            <div className={styles.resultArtist}>{r.artist}{r.duration ? ` · ${formatDuration(r.duration)}` : ''}</div>
                          </div>
                          <button
                            className={styles.previewBtn}
                            onClick={() => handlePreviewResult(r)}
                          >
                            Preview
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  {dialogState === 'previewing' && previewInfo && (
                    <>
                      <div className={styles.selectedInfo}>
                        <span className={styles.selectedLabel}>Selected:</span> {previewInfo.title} — {previewInfo.artist}
                      </div>
                      <MiniPreviewPlayer
                        streamUrl={previewInfo.streamUrl}
                        onClose={() => { setPreviewInfo(null); setSelectedResult(null); setDialogState('results'); }}
                      />
                    </>
                  )}
                </div>
              )}

              {activeTab === 'url' && (
                <div className={styles.tabContent}>
                  <div className={styles.searchRow}>
                    <input
                      className={styles.input}
                      value={urlInput}
                      onChange={(e) => setUrlInput(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleFindUrl()}
                      placeholder="https://soundcloud.com/... or youtube.com/..."
                    />
                    <button className={styles.primaryBtn} onClick={handleFindUrl}>
                      <Link size={16} />
                    </button>
                    <button className={styles.secondaryBtn} onClick={handleImportLocalFile} title="Choose local file">
                      <FolderOpen size={16} />
                    </button>
                  </div>
                  {dialogState === 'previewing' && previewInfo && (
                    <>
                      <div className={styles.selectedInfo}>
                        <span className={styles.selectedLabel}>Found:</span> {previewInfo.title} — {previewInfo.artist}
                      </div>
                      <MiniPreviewPlayer
                        streamUrl={previewInfo.streamUrl}
                        onClose={() => { setPreviewInfo(null); setDialogState('idle'); }}
                      />
                    </>
                  )}
                </div>
              )}

              {errorMsg && <div className={styles.error}>{errorMsg}</div>}

              {previewInfo && (
                <button className={styles.downloadBtn} onClick={handleDownload}>
                  <HardDriveDownload size={16} /> Save as Local
                </button>
              )}
            </>
          )}

          {(dialogState === 'saving-current' || dialogState === 'searching' || dialogState === 'downloading') && (
            <div className={styles.centered}>
              <Loader2 size={24} className={styles.spinner} />
              <span className={styles.statusText}>{statusText}</span>
            </div>
          )}

          {dialogState === 'done' && (
            <div className={styles.centered}>
              <div className={styles.doneText}>Done!</div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};

function detectSourceType(url: string): LocalOverride['sourceType'] {
  if (url.includes('soundcloud.com')) return 'soundcloud';
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
  return 'direct';
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
