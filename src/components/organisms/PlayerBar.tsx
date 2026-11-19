import React, { useState, useEffect, useCallback, Fragment, memo, useMemo, useRef, useSyncExternalStore } from 'react';
import {
  Shuffle, SkipBack, Pause, Play, SkipForward, Repeat, Repeat1,
  ListMusic, Mic2, Volume2, Volume1, VolumeX, Heart, HeartCrack, HardDriveDownload, AlertCircle,
  Infinity as InfinityIcon, Music2
} from 'lucide-react';
import { IconButton } from '../atoms/IconButton';
import { SourceBadge } from '../atoms/SourceBadge';
import { ProgressBar, ProgressBarRef } from '../atoms/ProgressBar';
import { player } from '../../api/player';
import { openImageViewer } from '../molecules/ImageViewer';
import { getOverride, onOverrideChanged } from '../../api/localOverrides';
import { TrackOverrideDialog } from './TrackOverrideDialog';
import { TrackContextMenu, TrackContextMenuHandle } from './TrackContextMenu';
import { YTMTrack } from '../../api/yt';
import { isDeckLayout, subscribeDesktopLayout } from '../../utils/desktopLayout';
import styles from './PlayerBar.module.css';

interface PlayerBarProps {
  activeRightPanel?: 'none' | 'queue' | 'lyrics';
  onToggleRightPanel?: (panel: 'queue' | 'lyrics') => void;
  onSelectArtist?: (id: string) => void;
  onSelectAlbum?: (id: string) => void;
  onSelectPlaylist?: (id: string, title: string) => void;
  className?: string;
}

function formatTime(sec: number): string {
  if (!sec || isNaN(sec) || !isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// 1. SURGICAL SUB-COMPONENTS for Controls - Removed individual buttons for consolidation

// Общая логика лайка/дизлайка текущего трека (подписка + рейтинг).
function useLikeControls() {
  const [track, setTrack] = useState(player.currentTrack);
  useEffect(() => {
    return player.subscribe((ev) => {
      if (ev === 'tick') return;
      setTrack(prev => {
        const curr = player.currentTrack;
        if (prev?.id === curr?.id && prev?.likeStatus === curr?.likeStatus) return prev;
        return curr ? { ...curr } : null;
      });
    });
  }, []);

  const trackId = track?.id;
  const [likeStatus, setLikeStatus] = useState(track?.likeStatus);
  const [loadingAction, setLoadingAction] = useState<'like' | 'dislike' | null>(null);

  useEffect(() => {
    setLikeStatus(track?.likeStatus);
    setLoadingAction(null);
  }, [trackId, track?.likeStatus]);

  useEffect(() => {
    const handleGlobalLikeUpdated = (e: CustomEvent) => {
      if (e.detail.id === trackId) {
        if (e.detail.status === 'success') setLikeStatus(e.detail.likeStatus);
        setLoadingAction(null);
      }
    };
    window.addEventListener('track-like-updated', handleGlobalLikeUpdated as EventListener);
    return () => {
      window.removeEventListener('track-like-updated', handleGlobalLikeUpdated as EventListener);
    };
  }, [trackId]);

  const rate = async (target: 'LIKE' | 'DISLIKE', e: React.MouseEvent) => {
    e.stopPropagation();
    if (loadingAction || !trackId) return;
    setLoadingAction(target === 'LIKE' ? 'like' : 'dislike');
    window.dispatchEvent(new CustomEvent('track-like-start', { detail: { id: trackId } }));
    try {
      const newStatus = likeStatus === target ? 'INDIFFERENT' : target;
      await player.rateCurrentTrack(newStatus);
    } catch {
      window.dispatchEvent(new CustomEvent('track-like-updated', { detail: { id: trackId, status: 'error' } }));
    }
  };

  return { trackId, likeStatus, loadingAction, rate, source: track?.source };
}

const DislikeButton = memo(() => {
  const { trackId, likeStatus, loadingAction, rate, source } = useLikeControls();
  if (!trackId) return null;
  // У SoundCloud нет дизлайка — кнопку оставляем, но блокируем.
  const isSc = source === 'soundcloud';
  const isDisliked = likeStatus === 'DISLIKE';
  return (
    <IconButton
      icon={HeartCrack}
      size={32}
      iconSize={18}
      active={isDisliked}
      isLoading={loadingAction === 'dislike'}
      disabled={isSc}
      title={isSc ? 'SoundCloud не поддерживает дизлайк' : isDisliked ? 'Remove dislike' : 'Dislike'}
      className={styles.likeButton}
      onClick={(e: React.MouseEvent) => { if (!isSc) rate('DISLIKE', e); }}
      color={isDisliked ? 'var(--warning)' : undefined}
    />
  );
});

const LikeButton = memo(() => {
  const { trackId, likeStatus, loadingAction, rate } = useLikeControls();
  if (!trackId) return null;
  return (
    <IconButton
      icon={Heart}
      size={32}
      iconSize={18}
      active={likeStatus === 'LIKE'}
      isLoading={loadingAction === 'like'}
      title={likeStatus === 'LIKE' ? 'Unlike' : 'Like'}
      className={styles.likeButton}
      onClick={(e: React.MouseEvent) => rate('LIKE', e)}
      color={likeStatus === 'LIKE' ? 'var(--danger)' : undefined}
      fill={likeStatus === 'LIKE' ? 'var(--danger)' : 'none'}
    />
  );
});

const AutoplayButton = memo(() => {
  const [active, setActive] = useState(player.autoplay);
  useEffect(() => {
    return player.subscribe((event) => {
      if (event === 'state') setActive(player.autoplay);
    });
  }, []);
  return (
    <IconButton
      icon={InfinityIcon}
      size={28}
      iconSize={15}
      active={active}
      title="Autoplay"
      onClick={() => player.toggleAutoplay()}
    />
  );
});

type TrackInfoProps = Pick<PlayerBarProps, 'onSelectArtist' | 'onSelectAlbum' | 'onSelectPlaylist'> & {
  onOpenOverride: (track: YTMTrack) => void;
};

const TrackInfo = memo(({ onSelectArtist, onSelectAlbum, onSelectPlaylist, onOpenOverride }: TrackInfoProps) => {
  const menuRef = useRef<TrackContextMenuHandle>(null);
  const [track, setTrack] = useState(player.currentTrack);
  const [isLoading, setIsLoading] = useState(player.isStreamLoading);
  const [failedThumb, setFailedThumb] = useState<string>();

  useEffect(() => {
    return player.subscribe((ev) => {
      if (ev === 'tick') return;

      setTrack(player.currentTrack);

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

  const openMenu = (e: React.MouseEvent) => {
    if (!track?.id || player.currentTrack?.id !== track.id) return;
    e.preventDefault();
    e.stopPropagation();
    menuRef.current?.open(e, player.currentTrack, { type: 'now-playing' });
  };

  const openKeyboardMenu = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return;
    if (!track?.id || player.currentTrack?.id !== track.id) return;
    e.preventDefault();
    e.stopPropagation();
    const { left, top } = e.currentTarget.getBoundingClientRect();
    menuRef.current?.open({ clientX: left, clientY: top }, player.currentTrack, { type: 'now-playing', keyboard: true });
  };

  return (
    <>
    <div
      className={`${styles.nowPlaying} ${(track?.albumId || player.queueSourceId) ? styles.clickable : ''} ${isLoading ? styles.loading : ''}`}
      role="group"
      aria-label="Now playing"
      aria-haspopup={track?.id ? 'menu' : undefined}
      aria-keyshortcuts={track?.id ? 'Shift+F10' : undefined}
      tabIndex={track?.id ? 0 : undefined}
      onClick={handleSourceClick}
      onContextMenu={openMenu}
      onKeyDown={openKeyboardMenu}
    >
      <div className={styles.artWrapper} onClick={handleArtClick}>
        {track?.thumbUrl && track.thumbUrl !== failedThumb ? (
          <img src={track.thumbUrl} alt="" className={styles.albumArt} onError={() => setFailedThumb(track.thumbUrl)} />
        ) : (
          <div className={styles.albumArtEmpty}>
            {!track?.thumbUrl ? null : <Music2 size={22} />}
          </div>
        )}
        {track?.source === 'soundcloud' && (
          <span style={{ position: 'absolute', right: 2, bottom: 2, background: 'rgba(0,0,0,0.55)', borderRadius: 4, padding: '1px 2px', display: 'flex', lineHeight: 0 }}>
            <SourceBadge source={track.source} size={12} />
          </span>
        )}
        {isLoading && <div className={styles.spinner} />}
      </div>
      <div className={styles.trackInfo}>
        <div className={styles.title} data-tooltip={track?.title ?? undefined} data-tooltip-overflow="">{track?.title || 'No track selected'}</div>
        <div className={styles.artist} data-tooltip={track?.artists?.join(', ')} data-tooltip-overflow="">
          {track?.artists?.map((artist: string, i: number) => {
            const id = track.artistIds?.[i];
            return (
              <Fragment key={i}>
                <span className={id ? styles.link : ''} onClick={(e) => { if (id) { e.stopPropagation(); onSelectArtist?.(id); } }}>{artist}</span>
                {i < (track.artists?.length || 0) - 1 && ', '}
              </Fragment>
            );
          })}
        </div>
      </div>
      {track?.id && (
        <div className={styles.trackActions} onClick={(e) => e.stopPropagation()}>
          <OverrideButton onOpen={onOpenOverride} />
        </div>
      )}
    </div>
    {track?.id && (
      <TrackContextMenu
        key={`${track.source ?? ''}:${track.id}`}
        ref={menuRef}
        onSelectArtist={onSelectArtist}
        onSelectAlbum={onSelectAlbum}
        onSelectPlaylist={onSelectPlaylist}
      />
    )}
    </>
  );
});

const TimeProgress = memo(({ deck = false }: { deck?: boolean }) => {
  const currentRef = useRef<HTMLSpanElement>(null);
  const durationRef = useRef<HTMLSpanElement>(null);
  const clockRef = useRef<HTMLSpanElement>(null);
  const previewRef = useRef<number | null>(null);
  const progressBarRef = useRef<ProgressBarRef>(null);
  const lastUpdateRef = useRef<number>(0);
  const lastDisplayedTimeRef = useRef<number>(0);

  const updateElapsed = useCallback(() => {
    const preview = previewRef.current;
    const text = formatTime(preview === null ? player.currentTime : player.duration * preview / 100);
    if (currentRef.current && currentRef.current.textContent !== text) currentRef.current.textContent = text;
  }, []);

  const handlePreview = useCallback((pct: number | null) => {
    previewRef.current = pct;
    const clock = clockRef.current;
    if (clock) {
      clock.toggleAttribute('data-previewing', pct !== null);
      if (pct !== null) clock.style.setProperty('--seek-preview-x', `${pct}vw`);
    }
    updateElapsed();
  }, [updateElapsed]);

  useEffect(() => {
    const updateTime = (force = false) => {
      const now = Date.now();
      // Если currentTime прыгнул > 3с — это seek, пропускаем throttle
      const seekJump = Math.abs(player.currentTime - lastDisplayedTimeRef.current) > 3;
      if (!force && !seekJump && now - lastUpdateRef.current < 400) return;
      lastUpdateRef.current = now;
      lastDisplayedTimeRef.current = player.currentTime;

      updateElapsed();
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
  }, [updateElapsed]);

  const handleSeek = useCallback((pct: number) => {
    if (player.duration) {
      player.seek((pct / 100) * player.duration);
    }
  }, []);

  const [loop, setLoop] = useState(player.loop);
  useEffect(() => player.subscribe((ev) => { if (ev === 'state') setLoop(player.loop); }), []);

  // Конец отрезка держим чуть раньше конца трека, иначе 'ended' уведёт на следующий
  const maxB = () => player.duration - 0.3;

  const toggleLoop = (e: React.MouseEvent) => {
    e.preventDefault();
    if (player.loop) return player.setLoop(null);
    if (!player.duration) return;
    const b = Math.min(player.currentTime + 10, maxB());
    player.setLoop({ a: Math.max(0, b - 10), b });
  };

  const moveMarker = (e: React.PointerEvent<HTMLDivElement>, which: 'a' | 'b') => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const rect = progressBarRef.current?.container?.getBoundingClientRect();
    const cur = player.loop;
    if (!cur || !rect?.width) return;
    const t = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) * player.duration;
    const next = which === 'a'
      ? { a: Math.min(t, cur.b - 0.5), b: cur.b }
      : { a: cur.a, b: Math.min(maxB(), Math.max(t, cur.a + 0.5)) };
    player.setLoop(next);
    setLoop(next);
  };

  const captureMarker = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.isPrimary || e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const pct = (t: number) => `${player.duration ? (t / player.duration) * 100 : 0}%`;
  const elapsed = <span ref={currentRef} className={styles.time}>{formatTime(player.currentTime)}</span>;
  const duration = <span ref={durationRef} className={styles.time}>{formatTime(player.duration)}</span>;

  return (
    <div className={styles.progress} onContextMenu={toggleLoop}>
      {deck ? (
        <span className={styles.clock} ref={clockRef} data-playback-time="">{elapsed} / {duration}</span>
      ) : elapsed}
      <div className={styles.progressBar}>
        <ProgressBar
          ref={progressBarRef}
          buffered={player.buffered}
          label="Playback position"
          onSeek={handleSeek}
          onPreviewChange={deck ? handlePreview : undefined}
          largeTarget
          nyanMode={true}
          isPlaying={player.isPlaying}
        />
        {loop && (
          <div className={styles.loop}>
            <div className={styles.loopRange} style={{ left: pct(loop.a), width: pct(loop.b - loop.a) }} />
            <div className={styles.loopMarker} style={{ left: pct(loop.a) }} onPointerDown={captureMarker} onPointerMove={e => moveMarker(e, 'a')} data-tooltip={formatTime(loop.a)} />
            <div className={styles.loopMarker} style={{ left: pct(loop.b) }} onPointerDown={captureMarker} onPointerMove={e => moveMarker(e, 'b')} data-tooltip={formatTime(loop.b)} />
          </div>
        )}
      </div>
      {!deck && duration}
    </div>
  );
});

const subscribeVolume = (onChange: () => void) => player.subscribe(onChange);
const getVolume = () => player.volume;

const VolumeControl = memo(() => {
  const volume = useSyncExternalStore(subscribeVolume, getVolume);
  const [showInput, setShowInput] = useState(false);
  // Until the first edit, the field follows the same live value as the slider.
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const sliderRef = useRef<ProgressBarRef>(null);

  useEffect(() => {
    if (showInput && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [showInput]);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setDraft(null);
    setShowInput(true);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const digits = e.target.value.replace(/\D/g, '');
    const next = Number(digits) > 100 ? '100' : digits;
    setDraft(next);
    if (next !== '') player.setVolume(Number(next));
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' && e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    // Reapply even when Enter didn't generate a change event (e.g. after a wheel adjustment).
    if (e.key === 'Enter' && e.currentTarget.value !== '') {
      player.setVolume(Number(e.currentTarget.value));
    }
    setShowInput(false);
    sliderRef.current?.container?.focus();
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
      <IconButton icon={VolumeIcon} size={34} iconSize={20} title={volume === 0 ? 'Unmute' : 'Mute'} onClick={() => player.toggleMute()} />
      <ProgressBar 
        ref={sliderRef}
        progress={volume} 
        label="Volume"
        onSeek={handleVolumeSeek} 
        showThumb={true} 
        largeTarget
        className={styles.volumeBar} 
      />

      {showInput && (
        <div className={styles.volumeInputPopover}>
          <div className={styles.volumeLabel}>Volume %</div>
          <input
            ref={inputRef}
            type="text"
            inputMode="numeric"
            aria-label="Volume percent"
            className={styles.volumeInput}
            value={draft ?? String(volume)}
            onChange={handleInputChange}
            onKeyDown={handleInputKeyDown}
            onBlur={() => setShowInput(false)}
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
        size={28}
        title="Lyrics"
        iconSize={15}
        active={activeRightPanel === 'lyrics'}
        onClick={() => onToggleRightPanel?.('lyrics')}
      />
      <IconButton
        icon={ListMusic}
        size={28}
        title="Queue"
        iconSize={15}
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
  return <IconButton icon={Shuffle} size={32} iconSize={16} active={active} title="Shuffle" onClick={() => player.toggleShuffle()} />;
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
      <IconButton icon={isPlaying ? Pause : Play} size={44} iconSize={20} variant="solid" className={styles.playKey} title={isPlaying ? 'Pause' : 'Play'} onClick={() => player.togglePlay()} />
      {hasError && (
        <span style={{ position: 'absolute', bottom: -12, display: 'flex', alignItems: 'center', gap: 2, fontSize: 9, color: 'var(--danger)', whiteSpace: 'nowrap', pointerEvents: 'none' }}>
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
      <IconButton icon={RepeatIcon} size={32} iconSize={16} active={repeat !== 'off'} title={`Repeat: ${repeat}`} onClick={() => player.toggleRepeat()} />
      {errorSkipCount > 0 && (
        <span style={{ position: 'absolute', bottom: -8, right: -2, fontSize: 9, color: 'var(--danger)', lineHeight: 1, pointerEvents: 'none' }}>
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
      title="Local track override"
      color={hasOverride ? 'var(--accent)' : undefined}
      onClick={() => onOpen(track)}
    />
  );
});

const PlayerControls = memo(() => {
  return (
    <div className={styles.buttons}>
      <DislikeButton />
      <ShuffleButton />
      <IconButton icon={SkipBack} size={32} iconSize={20} title="Previous track" onClick={() => player.prev()} />
      <PlayPauseButton />
      <IconButton icon={SkipForward} size={32} iconSize={20} title="Next track" onClick={() => player.next()} />
      <RepeatButton />
      <LikeButton />
    </div>
  );
});

export const PlayerBar: React.FC<PlayerBarProps> = memo(({
  activeRightPanel = 'none',
  onToggleRightPanel,
  onSelectArtist,
  onSelectAlbum,
  onSelectPlaylist,
  className
}) => {
  const [overrideTrack, setOverrideTrack] = useState<YTMTrack | null>(null);
  const deck = useSyncExternalStore(subscribeDesktopLayout, isDeckLayout);

  const infoSection = useMemo(() => (
    <TrackInfo
      onSelectArtist={onSelectArtist}
      onSelectAlbum={onSelectAlbum}
      onSelectPlaylist={onSelectPlaylist}
      onOpenOverride={setOverrideTrack}
    />
  ), [onSelectArtist, onSelectAlbum, onSelectPlaylist]);

  return (
    <footer aria-label="Player" className={`${styles.container} ${className || ''}`}>
      {infoSection}
      <div className={styles.controls}>
        {!deck && <TimeProgress />}
        <PlayerControls />
      </div>
      <div className={styles.extra}>
        <AutoplayButton />
        <PanelButtons activeRightPanel={activeRightPanel} onToggleRightPanel={onToggleRightPanel} />
        {deck && <TimeProgress deck />}
        <div className={styles.volumeSlot}>
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
    </footer>
  );
});

