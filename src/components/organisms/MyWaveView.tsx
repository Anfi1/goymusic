import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Play, Pause, SkipBack, SkipForward, Heart, HeartCrack, Loader2, AudioLines, HardDriveDownload, Mic2, Volume2, Volume1, VolumeX, ChevronLeft, ChevronRight, ListMusic } from 'lucide-react';
import { player } from '../../api/player';
import { likedStore } from '../../api/likedStore';
import { historyStore } from '../../api/history';
import { likedManager } from '../../api/likedManager';
import { YTMTrack, getMixedForYou, getPlaylistTracks } from '../../api/yt';
import { TrackOverrideDialog } from './TrackOverrideDialog';
import {
  isSoundCloudEnabled, interleaveTracks,
  getScWaveStations, getScStationTracks,
} from '../../api/soundcloud';
import { LazyImage } from '../atoms/LazyImage';
import { SourceBadge } from '../atoms/SourceBadge';
import { ProgressBar } from '../atoms/ProgressBar';
import { openImageViewer } from '../molecules/ImageViewer';
import { LyricsView } from './LyricsView';
import { QueuePanel } from './QueuePanel';
import { MOOD_CATEGORIES, assignCategory, groupKey, MoodCategory } from '../../utils/moodCategories';
import { blendTracks, pickMixesForMoods, moodTagCategories } from '../../utils/curatedMix';
import styles from './MyWaveView.module.css';

const WAVE_SOURCE_ID = 'my-wave';
const WAVE_ACTIVE_ID_KEY = 'goymusic-my-wave-active-id';

interface WaveStation { id: string; title: string; thumbUrl: string; kind: 'foryou' | 'sc' | 'yt' | 'curated'; }
const FORYOU: WaveStation = { id: 'foryou', title: 'Для тебя', thumbUrl: '', kind: 'foryou' };
const CURATED: WaveStation = { id: 'curated', title: 'Мой подбор', thumbUrl: '', kind: 'curated' };
const WAVE_CURATED_MOODS_KEY = 'ytm-curated-moods';

function getSavedCuratedMoods(): string[] {
  try {
    const raw = localStorage.getItem(WAVE_CURATED_MOODS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}
function saveCuratedMoods(ids: string[]) {
  try { localStorage.setItem(WAVE_CURATED_MOODS_KEY, JSON.stringify(ids)); } catch {}
}

// Кэш станций между заходами в раздел (мало меняются).
let stationsCache: WaveStation[] | null = null;

function getSavedActiveId(): string {
  try {
    return localStorage.getItem(WAVE_ACTIVE_ID_KEY) || 'foryou';
  } catch {
    return 'foryou';
  }
}

function saveActiveId(id: string) {
  try {
    localStorage.setItem(WAVE_ACTIVE_ID_KEY, id);
  } catch {}
}

function formatTime(sec: number): string {
  if (!sec || isNaN(sec) || !isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const WaveVolumeControl: React.FC = () => {
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
    const valStr = e.target.value.replace(/\D/g, '');
    let val = parseInt(valStr, 10);
    let finalStr = valStr;
    if (!isNaN(val)) {
      if (val > 100) { val = 100; finalStr = '100'; }
      player.setVolume(val);
    }
    setInputValue(finalStr);
  };

  const handleInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === 'Escape') setShowInput(false);
  };

  const handleSeek = useCallback((pct: number) => {
    player.setVolume(Math.round(pct));
  }, []);

  const VolumeIcon = volume === 0 ? VolumeX : volume < 50 ? Volume1 : Volume2;

  return (
    <div
      className={styles.volumeControl}
      onWheel={(e) => player.setVolume(player.volume + (-Math.sign(e.deltaY) * 5))}
      onContextMenu={handleContextMenu}
    >
      <button className={styles.volumeBtn} onClick={() => player.toggleMute()} title="Громкость">
        <VolumeIcon size={18} />
      </button>
      <ProgressBar
        progress={volume}
        onSeek={handleSeek}
        showThumb={true}
        className={styles.volumeBar}
      />
      {showInput && (
        <div className={styles.volumeInputPopover}>
          <div className={styles.volumeLabel}>Громкость %</div>
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
};

interface MyWaveViewProps {
  onSelectArtist?: (id: string) => void;
  onSelectAlbum?: (id: string) => void;
  onSelectPlaylist?: (id: string, title: string) => void;
}

export const MyWaveView: React.FC<MyWaveViewProps> = ({ onSelectArtist, onSelectAlbum, onSelectPlaylist }) => {
  const [stations, setStations] = useState<WaveStation[]>(stationsCache || []);
  const [activeId, setActiveId] = useState<string>(getSavedActiveId());
  const [selectedFilter, setSelectedFilter] = useState<string>('all');
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(!stationsCache);
  const [error, setError] = useState<string | null>(null);
  const [likeAction, setLikeAction] = useState<'like' | 'dislike' | null>(null);
  const [showLyrics, setShowLyrics] = useState(false);
  const [showQueue, setShowQueue] = useState(false);
  const [progress, setProgress] = useState({ current: 0, duration: 0, pct: 0 });
  const [overrideTrack, setOverrideTrack] = useState<YTMTrack | null>(null);
  const [curateOpen, setCurateOpen] = useState(false);
  const [curatedMoods, setCuratedMoods] = useState<string[]>(getSavedCuratedMoods());
  const [curatedTracks, setCuratedTracks] = useState<YTMTrack[]>([]);
  const [curateBuilding, setCurateBuilding] = useState(false);
  const [, force] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const filterListRef = useRef<HTMLDivElement>(null);
  const firstItemRef = useRef<HTMLButtonElement>(null);
  const secondItemRef = useRef<HTMLButtonElement>(null);
  const suppressRecenter = useRef(false);
  const filterDrag = useRef<{ isDown: boolean; startX: number; scrollLeft: number }>({ isDown: false, startX: 0, scrollLeft: 0 });

  // Курируемые станции: SoundCloud (жанры) + YouTube супермиксы.
  useEffect(() => {
    if (stationsCache) return;
    Promise.all([
      getScWaveStations().catch(() => []),
      getMixedForYou().catch(() => []),
    ]).then(([sc, yt]) => {
      const scSt: WaveStation[] = sc.map(s => ({ id: s.id, title: s.title, thumbUrl: s.thumbUrl, kind: 'sc' }));
      const ytSt: WaveStation[] = (yt || [])
        .filter(m => m.playlistId && m.title)
        .map(m => ({ id: m.playlistId, title: m.title, thumbUrl: m.thumbUrl, kind: 'yt' }));
      const combined = [...scSt, ...ytSt];
      stationsCache = combined;
      setStations(combined);
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  // Перерисовка при смене трека / play-pause / лайке + обновление прогресса.
  useEffect(() => {
    const unsub = player.subscribe((e) => {
      if (e === 'tick') {
        const current = player.currentTime;
        const duration = player.duration;
        setProgress({ current, duration, pct: duration > 0 ? (current / duration) * 100 : 0 });
        return;
      }
      force(n => n + 1);
    }, { tick: true });
    const onLikeUpdated = () => force(n => n + 1);
    const currentId = player.currentTrack?.id;
    const onLikeStart = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.id === currentId) {
        // Не устанавливаем здесь loading, это делаем в обработчике клика;
        // здесь только гарантируем сброс при глобальных событиях.
      }
    };
    const onLikeDone = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.id === currentId) setLikeAction(null);
      force(n => n + 1);
    };
    window.addEventListener('track-like-updated', onLikeUpdated);
    window.addEventListener('track-like-start', onLikeStart);
    window.addEventListener('track-like-updated', onLikeDone);
    return () => {
      unsub();
      window.removeEventListener('track-like-updated', onLikeUpdated);
      window.removeEventListener('track-like-start', onLikeStart);
      window.removeEventListener('track-like-updated', onLikeDone);
    };
  }, []);

  const visibleStations = useMemo<WaveStation[]>(() => {
    const activeStation = stations.find(s => s.id === activeId);
    if (selectedFilter === 'all') {
      // «Все»: золотые (supermix) + ностальгия + открытия + SoundCloud.
      const golden = stations.filter(st => {
        if (st.kind === 'sc') return false;
        const lower = st.title.toLowerCase();
        return /супер|super|рекоменд|новых релизов|new release|архив|replay|риплей/i.test(lower);
      });
      const sc = stations.filter(st => st.kind === 'sc');
      const list = [FORYOU, ...golden, ...sc];
      const unique = new Map(list.map(s => [s.id, s]));
      return activeStation && !unique.has(activeStation.id)
        ? [FORYOU, activeStation, ...Array.from(unique.values()).filter(s => s.id !== activeStation.id)]
        : Array.from(unique.values());
    }
    if (selectedFilter === 'soundcloud' || selectedFilter === 'genre') {
      const list = stations.filter(st => st.kind === 'sc');
      const unique = new Map([FORYOU, ...list].map(s => [s.id, s]));
      return activeStation && !unique.has(activeStation.id)
        ? [FORYOU, activeStation, ...Array.from(unique.values()).filter(s => s.id !== activeStation.id)]
        : Array.from(unique.values());
    }
    const cat = MOOD_CATEGORIES.find(c => c.id === selectedFilter);
    const list = stations.filter(st => {
      if (st.kind !== 'yt') return false;
      const assigned = assignCategory(groupKey(st.title));
      return assigned?.id === selectedFilter;
    });
    const unique = new Map([FORYOU, ...list].map(s => [s.id, s]));
    return activeStation && !unique.has(activeStation.id)
      ? [FORYOU, activeStation, ...Array.from(unique.values()).filter(s => s.id !== activeStation.id)]
      : Array.from(unique.values());
  }, [stations, activeId, selectedFilter]);

  const allStations = visibleStations;
  const looping = allStations.length > 2;
  const looped = looping ? [...allStations, ...allStations, ...allStations] : allStations;

  // Точное расстояние одного «оборота» = разница позиций одной и той же станции в копиях
  // 0 и 1 (учитывает паддинги/гэпы, поэтому переустановка скролла бесшовна).
  const loopDistance = () => {
    const a = firstItemRef.current, b = secondItemRef.current;
    return a && b ? b.offsetTop - a.offsetTop : 0;
  };

  // Стартуем со средней копии.
  useEffect(() => {
    const el = listRef.current;
    if (!el || !looping) return;
    const id = requestAnimationFrame(() => {
      const d = loopDistance();
      if (!d) return;
      el.scrollTop = d;
      // После первоначальной установки пытаемся центрировать сохранённую активную станцию.
      if (activeId !== 'foryou') {
        const idx = allStations.findIndex(s => s.id === activeId);
        if (idx >= 0) {
          const btns = el.querySelectorAll('[data-station-id]');
          const target = Array.from(btns).find((b) => b.getAttribute('data-station-id') === activeId) as HTMLElement | undefined;
          if (target) centerStation(target);
        }
      }
    });
    return () => cancelAnimationFrame(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stations.length, looping]);

  const handleScroll = useCallback(() => {
    const el = listRef.current;
    if (!el || !looping || suppressRecenter.current) return;
    const d = loopDistance();
    if (!d) return;
    if (el.scrollTop < d * 0.5) el.scrollTop += d;
    else if (el.scrollTop >= d * 1.5) el.scrollTop -= d;
  }, [looping]);

  // Drag-to-scroll для фильтров через Pointer Events + setPointerCapture:
  // захват работает даже если курсор выходит за границы окна.
  const onFilterPointerDown = useCallback((e: React.PointerEvent) => {
    const el = filterListRef.current;
    if (!el || e.button !== 0) return;
    el.setPointerCapture(e.pointerId);
    filterDrag.current = { isDown: true, startX: e.pageX - el.offsetLeft, scrollLeft: el.scrollLeft };
    el.style.cursor = 'grabbing';
  }, []);
  const onFilterPointerMove = useCallback((e: React.PointerEvent) => {
    const el = filterListRef.current;
    if (!el || !filterDrag.current.isDown) return;
    e.preventDefault();
    const x = e.pageX - el.offsetLeft;
    const walk = (x - filterDrag.current.startX) * 1.4;
    el.scrollLeft = filterDrag.current.scrollLeft - walk;
  }, []);
  const endFilterDrag = useCallback(() => {
    filterDrag.current.isDown = false;
    if (filterListRef.current) filterListRef.current.style.cursor = 'grab';
  }, []);

  const checkFilterScroll = useCallback(() => {
    const el = filterListRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 1);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  useEffect(() => {
    checkFilterScroll();
    window.addEventListener('resize', checkFilterScroll);
    return () => window.removeEventListener('resize', checkFilterScroll);
  }, [checkFilterScroll]);

  const scrollFilters = useCallback((dir: -1 | 1) => {
    const el = filterListRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth * 0.55, behavior: 'smooth' });
  }, []);

  // Плавно центрируем выбранную станцию в колесе (своя анимация — надёжнее scrollTo smooth).
  const centerStation = useCallback((btn: HTMLElement) => {
    const el = listRef.current;
    if (!el) return;
    const d = loopDistance();
    const maxTop = el.scrollHeight - el.clientHeight;
    const target = Math.max(0, Math.min(maxTop, btn.offsetTop + btn.offsetHeight / 2 - el.clientHeight / 2));
    const start = el.scrollTop;
    const dist = target - start;
    suppressRecenter.current = true;
    if (Math.abs(dist) < 1) { suppressRecenter.current = false; return; }
    const dur = 360;
    const t0 = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / dur);
      el.scrollTop = start + dist * (1 - Math.pow(1 - p, 3));
      if (p < 1) { requestAnimationFrame(step); return; }
      // Невидимо возвращаем в среднюю копию (±d показывает идентичный контент).
      if (d) { let s = el.scrollTop; while (s < d) s += d; while (s >= 2 * d) s -= d; el.scrollTop = s; }
      suppressRecenter.current = false;
    };
    requestAnimationFrame(step);
  }, []);

  // «Для тебя»: лайки (YT + SC), при их отсутствии — недавняя история.
  const buildPersonalizedSeeds = useCallback(async (): Promise<YTMTrack[]> => {
    const scOn = isSoundCloudEnabled();
    const likes = await likedStore.getAllTracks();
    let ytPool = likes.map(e => e.track).filter(t => t && t.isAvailable !== false);
    if (ytPool.length === 0) {
      const hist = await historyStore.getHistory(200);
      ytPool = hist.map(h => h.track).filter(Boolean);
    }
    const scPool = scOn ? (await likedStore.getAllScTracks()).map(e => e.track) : [];
    const ytSeeds = shuffle(ytPool).slice(0, 30);
    const scSeeds = shuffle(scPool).slice(0, 15);
    return scSeeds.length ? interleaveTracks(ytSeeds, scSeeds).slice(0, 40) : ytSeeds.slice(0, 40);
  }, []);

  const startStation = useCallback(async (st: WaveStation, btn?: HTMLElement) => {
    setActiveId(st.id);
    saveActiveId(st.id);
    if (btn) centerStation(btn);
    setLoadingId(st.id);
    setError(null);
    try {
      if (st.kind === 'curated') {
        if (curatedTracks.length === 0) { setError('Сначала собери микс в «Подобрать».'); return; }
        await player.playTrackList(curatedTracks, 0, WAVE_SOURCE_ID);
        return;
      }
      let seeds: YTMTrack[] = [];
      let recId: string | null = null;
      if (st.kind === 'foryou') {
        seeds = await buildPersonalizedSeeds();
      } else if (st.kind === 'sc') {
        // Порядок плейлиста сохраняем (как на сайте SoundCloud), без перемешивания.
        seeds = (await getScStationTracks(st.id)).slice(0, 50);
      } else {
        const res = await getPlaylistTracks(st.id, 60);
        seeds = res.tracks || [];
        recId = st.id; // RD-плейлист сам бесконечно достраивает радио
      }

      if (seeds.length === 0) {
        setError(st.kind === 'foryou'
          ? 'Лайкни пару треков или послушай музыку — и волна заведётся под тебя.'
          : 'Не удалось загрузить станцию, попробуй другую.');
        return;
      }
      if (!player.autoplay) player.toggleAutoplay();
      // SC/персональные станции — гибридный поток; YT-микс оставляем на родном радио.
      if (st.kind !== 'yt' && isSoundCloudEnabled()) player.setRadioMode('hybrid');
      await player.playTrackList(seeds, 0, WAVE_SOURCE_ID, undefined, recId);
    } catch (e) {
      console.error('[my-wave] start failed', e);
      setError('Не удалось запустить волну, попробуй ещё раз.');
    } finally {
      setLoadingId(null);
    }
  }, [buildPersonalizedSeeds, centerStation, curatedTracks]);

  // Собираем кастомный микс: миксы выбранных настроений -> треки -> round-robin.
  const buildCuratedMix = useCallback(async (moodIds: string[]) => {
    if (moodIds.length === 0) return;
    setCurateBuilding(true);
    setError(null);
    try {
      const groups = pickMixesForMoods(moodIds, stations);
      const chosen: WaveStation[] = [];
      for (const id of moodIds) chosen.push(...(groups[id] || []).slice(0, 2)); // 1–2 микса на настроение
      if (chosen.length === 0) { setError('Нет миксов под эти настроения.'); return; }

      const settled = await Promise.allSettled(chosen.map(m => getPlaylistTracks(m.id, 30)));
      const lists: YTMTrack[][] = settled
        .map(r => (r.status === 'fulfilled' ? (r.value.tracks || []) : []))
        .map(shuffle)                       // лёгкая вариативность между сборками
        .filter(l => l.length > 0);
      const blended = blendTracks(lists, 60);
      if (blended.length === 0) { setError('Не удалось собрать микс, попробуй другие настроения.'); return; }

      setCuratedTracks(blended);
      saveCuratedMoods(moodIds);
      setCurateOpen(false);
      await startStation(CURATED);
    } finally {
      setCurateBuilding(false);
    }
  }, [stations, startStation]);

  const activeStation = allStations.find(s => s.id === activeId) || FORYOU;
  const waveActive = player.queueSourceId === WAVE_SOURCE_ID;
  const track = waveActive ? player.currentTrack : null;
  const isPlaying = waveActive && player.isPlaying;
  const likeStatus = track?.likeStatus;
  const isSc = track?.source === 'soundcloud';

  const onPrimary = useCallback(() => {
    if (waveActive) player.togglePlay();
    else startStation(activeStation);
  }, [waveActive, activeStation, startStation]);

  const handleSeek = useCallback((pct: number) => {
    if (player.duration) player.seek((pct / 100) * player.duration);
  }, []);

  const handleArtClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (track?.thumbUrl) openImageViewer(track.thumbUrl, track.title);
  }, [track?.thumbUrl, track?.title]);

  const handleArtistClick = useCallback((e: React.MouseEvent, id?: string) => {
    e.stopPropagation();
    if (id) onSelectArtist?.(id);
  }, [onSelectArtist]);

  const onLike = useCallback(async () => {
    if (!track || likeAction) return;
    setLikeAction('like');
    try {
      await likedManager.toggleLike(track, likeStatus || 'INDIFFERENT');
    } finally {
      setLikeAction(null);
    }
  }, [track, likeStatus, likeAction]);

  const onDislike = useCallback(async () => {
    if (!track || isSc || likeAction) return;
    setLikeAction('dislike');
    try {
      await likedManager.toggleDislike(track, likeStatus || 'INDIFFERENT');
    } finally {
      setLikeAction(null);
    }
  }, [track, likeStatus, isSc, likeAction]);

  const renderStation = (st: WaveStation, key: string, ref?: React.Ref<HTMLButtonElement>) => {
    const isActive = activeId === st.id;
    const playingHere = isActive && isPlaying;
    return (
      <button
        key={key}
        ref={ref}
        data-station-id={st.id}
        className={`${styles.station} ${isActive ? styles.stationActive : ''}`}
        onClick={(e) => startStation(st, e.currentTarget)}
        disabled={loadingId !== null}
      >
        <span className={styles.stationThumb}>
          {st.kind === 'foryou'
            ? <span className={styles.forYouIcon}><AudioLines size={20} /></span>
            : <LazyImage src={st.thumbUrl} alt={st.title} className={styles.stationThumbImg} />}
          {loadingId === st.id
            ? <span className={styles.thumbOverlay}><Loader2 size={18} className={styles.spin} /></span>
            : playingHere && (
              <span className={styles.thumbOverlay}>
                <span className={styles.eq}><i /><i /><i /></span>
              </span>
            )}
        </span>
        <span className={styles.stationText}>
          <span className={styles.stationLabel}>{st.title}</span>
          <span className={styles.stationKind}>{st.kind === 'foryou' ? 'Персональная' : st.kind === 'sc' ? 'SoundCloud' : 'YouTube Mix'}</span>
        </span>
      </button>
    );
  };

  const panelOpen = showLyrics || showQueue;

  return (
    <div className={`${styles.container} ${panelOpen ? styles.lyricsMode : ''}`}>
      {/* Иммерсивный фон во всю ширину — список и плеер живут поверх него без границы. */}
      <div
        className={styles.bg}
        style={track?.thumbUrl ? { backgroundImage: `url(${track.thumbUrl})` } : undefined}
      />
      <div className={styles.bgOverlay} />

      <aside className={`${styles.sidebar} ${panelOpen ? styles.sidebarHidden : ''}`}>
        <div className={styles.filterStrip}>
          {canScrollLeft && (
            <button className={styles.filterArrow} onClick={() => scrollFilters(-1)} aria-label="Назад" type="button">
              <ChevronLeft size={16} />
            </button>
          )}
          <div
            className={`${styles.filterList} ${canScrollLeft ? styles.fadeLeft : ''} ${canScrollRight ? styles.fadeRight : ''}`}
            ref={filterListRef}
            onPointerDown={onFilterPointerDown}
            onPointerMove={onFilterPointerMove}
            onPointerUp={endFilterDrag}
            onPointerLeave={endFilterDrag}
            onScroll={checkFilterScroll}
          >
            {MOOD_CATEGORIES.map(cat => (
              <button
                key={cat.id}
                className={`${styles.filterPill} ${selectedFilter === cat.id ? styles.filterPillActive : ''}`}
                style={{ '--mood-color': cat.color } as React.CSSProperties}
                onClick={() => setSelectedFilter(cat.id)}
                title={cat.label}
              >
                <span className={styles.filterEmoji}>{cat.emoji}</span>
                <span className={styles.filterLabel}>{cat.label}</span>
              </button>
            ))}
          </div>
          {canScrollRight && (
            <button className={`${styles.filterArrow} ${styles.filterArrowRight}`} onClick={() => scrollFilters(1)} aria-label="Вперёд" type="button">
              <ChevronRight size={16} />
            </button>
          )}
        </div>
        <div className={styles.wheel} ref={listRef} onScroll={handleScroll}>
          {loading && stations.length === 0 ? (
            Array.from({ length: 6 }).map((_, i) => (
              <div key={`skel-${i}`} className={styles.skeletonStation} aria-hidden="true">
                <span className={styles.skelThumb} />
                <span className={styles.skelText}>
                  <span className={styles.skelLine} style={{ width: '68%' }} />
                  <span className={`${styles.skelLine} ${styles.skelLineShort}`} />
                </span>
              </div>
            ))
          ) : (
            <>
              {looped.map((st, i) => renderStation(
                st,
                `${st.id}-${i}`,
                i === 0 ? firstItemRef : i === allStations.length ? secondItemRef : undefined,
              ))}
              {stations.length === 0 && (
                <p className={styles.listHint}>Включи SoundCloud в настройках — добавятся жанровые станции.</p>
              )}
            </>
          )}
        </div>
      </aside>

      <main className={`${styles.stage} ${panelOpen ? styles.stageLyrics : ''}`}>
        <div className={styles.stageInner}>
          <div className={styles.stationBadge}>{activeStation.title}</div>

          {track ? (
            <>
              <div className={`${styles.artWrap} ${styles.artClickable}`} onClick={handleArtClick}>
                <LazyImage src={track.thumbUrl} alt={track.title} className={styles.art} />
                <span className={styles.artBadge}><SourceBadge source={track.source} /></span>
              </div>

              <div className={styles.trackMeta}>
                <h1 className={styles.trackTitle}>{track.title}</h1>
                <p className={styles.trackArtist}>
                  {track.artists?.map((artist: string, i: number) => {
                    const id = track.artistIds?.[i];
                    return (
                      <React.Fragment key={i}>
                        <span
                          className={id ? styles.artistLink : ''}
                          onClick={(e) => handleArtistClick(e, id)}
                        >{artist}</span>
                        {i < (track.artists?.length || 0) - 1 ? ', ' : ''}
                      </React.Fragment>
                    );
                  })}
                </p>
              </div>

              <div className={styles.waveProgress}>
                <ProgressBar
                  progress={progress.pct}
                  buffered={player.buffered}
                  onSeek={handleSeek}
                  className={styles.progressBar}
                  nyanMode={true}
                  isPlaying={isPlaying}
                />
                <div className={styles.timeRow}>
                  <span>{formatTime(progress.current)}</span>
                  <span>{formatTime(progress.duration)}</span>
                </div>
              </div>

              <div className={styles.controls}>
                <button
                  className={`${styles.ctrl} ${styles.ctrlExtra} ${likeStatus === 'DISLIKE' ? styles.ctrlActiveBad : ''}`}
                  onClick={onDislike}
                  disabled={isSc || likeAction !== null}
                  title={isSc ? 'SoundCloud не поддерживает дизлайк' : 'Не нравится'}
                >
                  {likeAction === 'dislike' ? <Loader2 size={18} className={styles.spin} /> : <HeartCrack size={20} />}
                </button>
                <button className={`${styles.ctrl} ${styles.ctrlExtra}`} onClick={() => player.prev()} title="Назад">
                  <SkipBack size={22} fill="currentColor" />
                </button>
                <button className={styles.ctrlMain} onClick={onPrimary} title={isPlaying ? 'Пауза' : 'Играть'}>
                  {loadingId ? <Loader2 className={styles.spin} size={28} />
                    : isPlaying ? <Pause size={28} fill="currentColor" />
                    : <Play size={28} fill="currentColor" />}
                </button>
                <button className={`${styles.ctrl} ${styles.ctrlExtra}`} onClick={() => player.next()} title="Вперёд">
                  <SkipForward size={22} fill="currentColor" />
                </button>
                <button
                  className={`${styles.ctrl} ${styles.ctrlExtra} ${likeStatus === 'LIKE' ? styles.ctrlActiveGood : ''}`}
                  onClick={onLike}
                  disabled={likeAction !== null}
                  title="Нравится"
                >
                  {likeAction === 'like' ? <Loader2 size={18} className={styles.spin} /> : <Heart size={20} fill={likeStatus === 'LIKE' ? 'currentColor' : 'none'} />}
                </button>
              </div>

              <div className={styles.secondaryControls}>
                <WaveVolumeControl />
                <button
                  className={`${styles.ctrl} ${showQueue ? styles.ctrlActiveGood : ''}`}
                  onClick={() => {
                    setShowQueue(v => !v);
                    setShowLyrics(false);
                  }}
                  title={showQueue ? 'Скрыть очередь' : 'Очередь воспроизведения'}
                >
                  <ListMusic size={18} />
                </button>
                <button
                  className={`${styles.ctrl} ${showLyrics ? styles.ctrlActiveGood : ''}`}
                  onClick={() => {
                    setShowLyrics(v => !v);
                    setShowQueue(false);
                  }}
                  title={showLyrics ? 'Скрыть текст' : 'Текст песни'}
                >
                  <Mic2 size={18} />
                </button>
                <button
                  className={styles.ctrl}
                  onClick={() => track && setOverrideTrack(track)}
                  title="Скачать / заменить источник"
                >
                  <HardDriveDownload size={18} />
                </button>
              </div>
            </>
          ) : (
            <div className={styles.empty}>
              <button className={styles.startBtn} onClick={() => startStation(activeStation)} disabled={loadingId !== null}>
                {loadingId ? <Loader2 className={styles.spin} size={30} /> : <Play size={30} fill="currentColor" />}
              </button>
              <p className={styles.emptyHint}>
                {error || 'Выбери станцию слева — и поехали. Бесконечный поток под твой вкус.'}
              </p>
            </div>
          )}
        </div>
      </main>

      <aside className={`${styles.lyricsPanel} ${showLyrics ? styles.lyricsPanelVisible : ''}`}>
        <div className={styles.lyricsPanelInner}>
          <LyricsView isVisible={showLyrics} />
        </div>
      </aside>

      <aside className={`${styles.queuePanel} ${showQueue ? styles.queuePanelVisible : ''}`}>
        <div className={styles.queuePanelInner}>
          <QueuePanel
            isVisible={showQueue}
            onSelectAlbum={onSelectAlbum || (() => {})}
            onSelectPlaylist={onSelectPlaylist || (() => {})}
            onSelectArtist={onSelectArtist || (() => {})}
          />
        </div>
      </aside>

      {overrideTrack && (
        <TrackOverrideDialog
          track={overrideTrack}
          isOpen={!!overrideTrack}
          onClose={() => setOverrideTrack(null)}
        />
      )}
    </div>
  );
};
