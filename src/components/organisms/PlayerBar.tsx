import React, { useState, useEffect, useCallback, Fragment, memo, useMemo, useRef } from 'react';
import {
  Shuffle, SkipBack, Pause, Play, SkipForward, Repeat, Repeat1,
  ListMusic, Mic2, Volume2, Volume1, VolumeX, Heart, HardDriveDownload, AlertCircle
} from 'lucide-react';
import { IconButton } from '../atoms/IconButton';
import { ProgressBar, ProgressBarRef } from '../atoms/ProgressBar';
import { player } from '../../api/player';
import { openImageViewer } from '../molecules/ImageViewer';
import { getOverride, onOverrideChanged } from '../../api/localOverrides';
import { TrackOverrideDialog } from './TrackOverrideDialog';
import { YTMTrack } from '../../api/yt';
import styles from './PlayerBar.module.css';

interface PlayerBarProps {
  activeRightPanel?: 'none' | 'queue' | 'lyrics';
  onToggleRightPanel?: (panel: 'queue' | 'lyrics') => void;
  onSelectArtist?: (id: string) => void;
  onSelectAlbum?: (id: string) => void;
  className?: string;
}

function formatTime(sec: number): string {
  if (!sec || isNaN(sec) || !isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// 1. SURGICAL SUB-COMPONENTS for Controls - Removed individual buttons for consolidation

const LikeButton = memo(({ trackId, initialLikeStatus }: { trackId: string, initialLikeStatus?: string }) => {
  const [likeStatus, setLikeStatus] = useState(initialLikeStatus);
  const [isLiking, setIsLiking] = useState(false);

  useEffect(() => {
    setLikeStatus(initialLikeStatus);
  }, [initialLikeStatus]);

  useEffect(() => {
    const handleGlobalLikeStart = (e: CustomEvent) => {
      if (e.detail.id === trackId) setIsLiking(true);
    };
    const handleGlobalLikeUpdated = (e: CustomEvent) => {
      if (e.detail.id === trackId) {
        if (e.detail.status === 'success') setLikeStatus(e.detail.likeStatus);
        setIsLiking(false);
      }
    };
    window.addEventListener('track-like-start', handleGlobalLikeStart as EventListener);
    window.addEventListener('track-like-updated', handleGlobalLikeUpdated as EventListener);
    return () => {
      window.removeEventListener('track-like-start', handleGlobalLikeStart as EventListener);
      window.removeEventListener('track-like-updated', handleGlobalLikeUpdated as EventListener);
    };
  }, [trackId]);

  const handleLike = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isLiking) return;
    window.dispatchEvent(new CustomEvent('track-like-start', { detail: { id: trackId } }));
    try {
      const newStatus = likeStatus === 'LIKE' ? 'INDIFFERENT' : 'LIKE';
      await player.rateCurrentTrack(newStatus);
      window.dispatchEvent(new CustomEvent('track-like-updated', { detail: { id: trackId, status: 'success', likeStatus: newStatus } }));
    } catch {
      window.dispatchEvent(new CustomEvent('track-like-updated', { detail: { id: trackId, status: 'error' } }));
    }
  };

  return (
    <IconButton
      icon={Heart}
      size={32}
      iconSize={18}
      active={likeStatus === 'LIKE'}
      isLoading={isLiking}
      className={styles.likeButton}
      onClick={handleLike}
      color={likeStatus === 'LIKE' ? '#f38ba8' : undefined}
      fill={likeStatus === 'LIKE' ? '#f38ba8' : 'none'}
    />
  );
});

const TrackInfo = memo(({ onSelectArtist, onSelectAlbum, onOpenOverride }: { onSelectArtist?: (id: string) => void, onSelectAlbum?: (id: string) => void, onOpenOverride: (track: YTMTrack) => void }) => {
  const [track, setTrack] = useState(player.currentTrack);
  const [isLoading, setIsLoading] = useState(player.isStreamLoading);

  useEffect(() => {
    return player.subscribe((ev) => {
      if (ev === 'tick') return;

      setTrack(prev => {
        if (prev?.id === player.currentTrack?.id) return prev;
        return player.currentTrack ? { ...player.currentTrack } : null;
      });

      setIsLoading(prev => {
        if (prev === player.isStreamLoading) return prev;
        return player.isStreamLoading;
      });
    });
  }, []);

  const handleSourceClick = () => {
    if (track?.albumId && onSelectAlbum) {
      onSelectAlbum(track.albumId);
    } else if (player.queueSourceId) {
      if (player.queueSourceType === 'album' && onSelectAlbum) onSelectAlbum(player.queueSourceId);
      else if (player.queueSourceType === 'artist' && onSelectArtist) onSelectArtist(player.queueSourceId);
      else if (player.queueSourceType === 'playlist' && track?.albumId && onSelectAlbum) onSelectAlbum(track.albumId);
    }
  };

  const handleArtClick = (e: React.MouseEvent) => {
    if (track?.thumbUrl) {
      e.stopPropagation();
      openImageViewer(track.thumbUrl, track.title);
    }
  };

  return (
    <div className={`${styles.nowPlaying} ${(track?.albumId || player.queueSourceId) ? styles.clickable : ''} ${isLoading ? styles.loading : ''}`} onClick={handleSourceClick}>
      <div className={styles.artWrapper} onClick={handleArtClick}>
        {track?.thumbUrl ? <img src={track.thumbUrl} alt="" className={styles.albumArt} /> : <div className={styles.albumArtEmpty} />}
        {isLoading && <div className={styles.spinner} />}
      </div>
      <div className={styles.trackInfo}>
        <div className={styles.title} data-tooltip={track?.title ?? undefined} data-tooltip-overflow="">{track?.title || 'No track selected'}</div>
        <div className={styles.artist}>
          {track?.artists?.map((artist: string, i: number) => {
            const id = track.artistIds?.[i];
            return (
              <Fragment key={i}>
                <span className={id ? styles.link : ''} onClick={(e) => { if (id) { e.stopPropagation(); onSelectArtist?.(id); } }} data-tooltip={artist} data-tooltip-overflow="">{artist}</span>
                {i < (track.artists?.length || 0) - 1 && ', '}
              </Fragment>
            );
          })}
        </div>
      </div>
      {track?.id && (
        <div className={styles.trackActions} onClick={(e) => e.stopPropagation()}>
          <LikeButton trackId={track.id} initialLikeStatus={track.likeStatus} />
          <OverrideButton onOpen={onOpenOverride} />
        </div>
      )}
    </div>
  );
});

const TimeProgress = memo(() => {
  const currentRef = useRef<HTMLSpanElement>(null);
  const durationRef = useRef<HTMLSpanElement>(null);
  const progressBarRef = useRef<ProgressBarRef>(null);
  const lastUpdateRef = useRef<number>(0);

  useEffect(() => {
    const updateTime = (force = false) => {
      const now = Date.now();
      // Throttle updates to ~400ms to reliably catch 500ms ticks from player
      if (!force && now - lastUpdateRef.current < 400) return;
      lastUpdateRef.current = now;

      if (currentRef.current) currentRef.current.textContent = formatTime(player.currentTime);
      if (durationRef.current) durationRef.current.textContent = formatTime(player.duration);
      
      if (progressBarRef.current) {
        const pct = player.duration > 0 ? (player.currentTime / player.duration) * 100 : 0;
        progressBarRef.current.setProgress(pct);
      }
    };

    const unsub = player.subscribe((ev) => {
      if (ev === 'tick' || ev === 'buffer') updateTime();
      else if (ev === 'state') updateTime(true); // Force update on state changes
    }, { tick: true, buffer: true });

    updateTime(true);
    return unsub;
  }, []);

  const handleSeek = useCallback((pct: number) => {
    if (player.duration) {
      player.seek((pct / 100) * player.duration);
    }
  }, []);

  return (
    <div className={styles.progress}>
      <span ref={currentRef} className={styles.time}>{formatTime(player.currentTime)}</span>
      <ProgressBar
        ref={progressBarRef}
        buffered={player.buffered}
        onSeek={handleSeek}
        className={styles.progressBar}
        nyanMode={true}
        isPlaying={player.isPlaying}
      />
      <span ref={durationRef} className={styles.time}>{formatTime(player.duration)}</span>
    </div>
  );
});

const VolumeControl = memo(() => {
  const [volume, setVolume] = useState(player.volume);
  const [showInput, setShowInput] = useState(false);
  const [inputValue, setInputValue] = useState(player.volume.toString());
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return player.subscribe((ev) => { 
      if (ev === 'state') {
        setVolume(player.volume);
        if (!showInput) setInputValue(player.volume.toString());
      }
    });
  }, [showInput]);

  useEffect(() => {
    if (showInput && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [showInput]);

  useEffect(() => {
    if (!showInput) return;
    const handleClickAway = (e: MouseEvent) => {
      if (inputRef.current && !inputRef.current.contains(e.target as Node)) {
        setShowInput(false);
      }
    };
    document.addEventListener('mousedown', handleClickAway);
    return () => document.removeEventListener('mousedown', handleClickAway);
  }, [showInput]);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setShowInput(true);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    // Only allow numbers
    const valStr = e.target.value.replace(/\D/g, '');

    let val = parseInt(valStr, 10);
    let finalStr = valStr;

    if (!isNaN(val)) {
      if (val > 100) {
        val = 100;
        finalStr = '100';
      }
      player.setVolume(val);
    }

    setInputValue(finalStr);
  };

  const handleInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === 'Escape') {
      setShowInput(false);
    }
  };

  const handleVolumeSeek = useCallback((pct: number) => {
    player.setVolume(Math.round(pct));
  }, []);

  const VolumeIcon = volume === 0 ? VolumeX : volume < 50 ? Volume1 : Volume2;

  return (
    <div className={styles.volume} 
         onWheel={(e) => player.setVolume(player.volume + (-Math.sign(e.deltaY) * 5))}
         onContextMenu={handleContextMenu}
    >
      <IconButton icon={VolumeIcon} size={28} iconSize={16} onClick={() => player.toggleMute()} />
      <ProgressBar 
        progress={volume} 
        onSeek={handleVolumeSeek} 
        showThumb={true} 
        className={styles.volumeBar} 
      />

      {showInput && (
        <div className={styles.volumeInputPopover}>
          <div className={styles.volumeLabel}>Volume %</div>
          <input
            ref={inputRef}
            type="text"
            className={styles.volumeInput}
            value={inputValue}
            onChange={handleInputChange}
            onKeyDown={handleInputKeyDown}
          />
        </div>
      )}
    </div>
  );
});

const PanelButtons = memo(({ activeRightPanel, onToggleRightPanel }: { activeRightPanel: string, onToggleRightPanel?: (panel: 'queue' | 'lyrics') => void }) => {
  return (
    <div style={{ display: 'flex', gap: '0.2rem' }}>
      <IconButton 
        icon={Mic2} 
        size={32} 
        iconSize={18} 
        active={activeRightPanel === 'lyrics'} 
        onClick={() => onToggleRightPanel?.('lyrics')} 
      />
      <IconButton 
        icon={ListMusic} 
        size={32} 
        iconSize={18} 
        active={activeRightPanel === 'queue'} 
        onClick={() => onToggleRightPanel?.('queue')} 
      />
    </div>
  );
});

// 1. SURGICAL SUB-COMPONENTS for Controls - Optimized independent subscribers
const ShuffleButton = memo(() => {
  const [active, setActive] = useState(player.shuffle);
  useEffect(() => {
    return player.subscribe((ev) => { 
      if (ev === 'state' && player.shuffle !== active) {
        setActive(player.shuffle); 
      }
    });
  }, [active]);
  return <IconButton icon={Shuffle} size={32} iconSize={16} active={active} onClick={() => player.toggleShuffle()} />;
});

const PlayPauseButton = memo(() => {
  const [isPlaying, setIsPlaying] = useState(player.isPlaying);
  const [hasError, setHasError] = useState(player.hasStreamError);
  useEffect(() => {
    return player.subscribe((ev) => {
      if (ev !== 'state') return;
      if (player.isPlaying !== isPlaying) setIsPlaying(player.isPlaying);
      if (player.hasStreamError !== hasError) setHasError(player.hasStreamError);
    });
  }, [isPlaying, hasError]);
  return (
    <div style={{ position: 'relative', display: 'inline-flex', flexDirection: 'column', alignItems: 'center' }}>
      <IconButton icon={isPlaying ? Pause : Play} size={44} iconSize={20} variant="solid" onClick={() => player.togglePlay()} />
      {hasError && (
        <span style={{ position: 'absolute', bottom: -12, display: 'flex', alignItems: 'center', gap: 2, fontSize: 9, color: 'var(--color-error, #f38ba8)', whiteSpace: 'nowrap', pointerEvents: 'none' }}>
          <AlertCircle size={8} />
          ошибка воспроизведения
        </span>
      )}
    </div>
  );
});

const RepeatButton = memo(() => {
  const [repeat, setRepeat] = useState(player.repeat);
  const [errorSkipCount, setErrorSkipCount] = useState(player.errorSkipCount);
  useEffect(() => {
    return player.subscribe((ev) => {
      if (ev !== 'state') return;
      if (player.repeat !== repeat) setRepeat(player.repeat);
      if (player.errorSkipCount !== errorSkipCount) setErrorSkipCount(player.errorSkipCount);
    });
  }, [repeat, errorSkipCount]);
  const RepeatIcon = repeat === 'one' ? Repeat1 : Repeat;
  return (
    <div style={{ position: 'relative', display: 'inline-flex' }}>
      <IconButton icon={RepeatIcon} size={32} iconSize={16} active={repeat !== 'off'} onClick={() => player.toggleRepeat()} />
      {errorSkipCount > 0 && (
        <span style={{ position: 'absolute', bottom: -8, right: -2, fontSize: 9, color: 'var(--color-error, #f38ba8)', lineHeight: 1, pointerEvents: 'none' }}>
          -{errorSkipCount}
        </span>
      )}
    </div>
  );
});

const OverrideButton = memo(({ onOpen }: { onOpen: (track: YTMTrack) => void }) => {
  const [track, setTrack] = useState(player.currentTrack);
  const [hasOverride, setHasOverride] = useState(false);

  useEffect(() => {
    return player.subscribe((ev) => {
      if (ev === 'state') {
        setTrack(prev => {
          if (prev?.id === player.currentTrack?.id) return prev;
          return player.currentTrack ? { ...player.currentTrack } : null;
        });
      }
    });
  }, []);

  useEffect(() => {
    if (!track?.id) { setHasOverride(false); return; }
    let alive = true;
    const refresh = () => {
      getOverride(track.id).then(o => { if (alive) setHasOverride(!!o); });
    };
    refresh();
    const unlisten = onOverrideChanged((e) => {
      if (e.detail.action === 'reset' || e.detail.videoId === track.id) refresh();
    });
    return () => { alive = false; unlisten(); };
  }, [track?.id]);

  if (!track) return null;

  return (
    <IconButton
      icon={HardDriveDownload}
      size={32}
      iconSize={16}
      active={hasOverride}
      color={hasOverride ? '#89b4fa' : undefined}
      onClick={() => onOpen(track)}
    />
  );
});

const PlayerControls = memo(() => {
  return (
    <div className={styles.buttons}>
      <ShuffleButton />
      <IconButton icon={SkipBack} size={32} iconSize={20} onClick={() => player.prev()} />
      <PlayPauseButton />
      <IconButton icon={SkipForward} size={32} iconSize={20} onClick={() => player.next()} />
      <RepeatButton />
    </div>
  );
});

// MAIN COMPONENT - Now a 100% static shell
export const PlayerBar: React.FC<PlayerBarProps> = memo(({
  activeRightPanel = 'none',
  onToggleRightPanel,
  onSelectArtist,
  onSelectAlbum,
  className
}) => {
  const [overrideTrack, setOverrideTrack] = useState<YTMTrack | null>(null);

  const infoSection = useMemo(() => (
    <TrackInfo
      onSelectArtist={onSelectArtist}
      onSelectAlbum={onSelectAlbum}
      onOpenOverride={setOverrideTrack}
    />
  ), [onSelectArtist, onSelectAlbum]);

  const controlSection = useMemo(() => (
    <div className={styles.controls}>
      <TimeProgress />
      <PlayerControls />
    </div>
  ), []);

  return (
    <div className={`${styles.container} ${className || ''}`}>
      {infoSection}
      {controlSection}
      <div className={styles.extra} style={{ gap: '0.2rem' }}>
        <PanelButtons activeRightPanel={activeRightPanel} onToggleRightPanel={onToggleRightPanel} />
        <div style={{ marginLeft: '1rem' }}>
          <VolumeControl />
        </div>
      </div>
      {overrideTrack && (
        <TrackOverrideDialog
          track={overrideTrack}
          isOpen={!!overrideTrack}
          onClose={() => setOverrideTrack(null)}
        />
      )}
    </div>
  );
});

