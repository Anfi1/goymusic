import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Play, Pause, SkipBack, SkipForward, Heart, HeartCrack, Loader2, AudioLines, HardDriveDownload, Mic2, Volume2, Volume1, VolumeX, ChevronLeft, ChevronRight, ListMusic, Shuffle, Repeat, Repeat1 } from 'lucide-react';
import { player } from '../../api/player';
import { likedStore } from '../../api/likedStore';
import { historyStore } from '../../api/history';
import { likedManager } from '../../api/likedManager';
import { YTMTrack, getMixedForYou, getPlaylistTracks } from '../../api/yt';
import { TrackOverrideDialog } from './TrackOverrideDialog';
import {
  isSoundCloudEnabled, interleaveMany, isScAuthed,
  getScWaveStations, getScStationTracks,
} from '../../api/soundcloud';
import { isYandexEnabled, getYandexWaveStations, getYandexWaveTracks } from '../../api/yandex';
import { getHomeSource } from '../../api/homeSource';
import type { TrackSource } from '../../api/source';
import { LazyImage } from '../atoms/LazyImage';
import { SourceBadge } from '../atoms/SourceBadge';
import { ProgressBar, ProgressBarRef } from '../atoms/ProgressBar';
import { openImageViewer } from '../molecules/ImageViewer';
import { LyricsView } from './LyricsView';
import { QueuePanel } from './QueuePanel';
import { CuratePanel } from '../molecules/CuratePanel';
import { EmojiText } from '../atoms/EmojiText';
import { MOOD_CATEGORIES, assignCategory, groupKey, MoodCategory } from '../../utils/moodCategories';
import { blendTracks, pickMixesForMoods, moodTagCategories } from '../../utils/curatedMix';
import styles from './MyWaveView.module.css';

const WAVE_SOURCE_ID = 'my-wave';
const WAVE_ACTIVE_ID_KEY = 'goymusic-my-wave-active-id';

interface WaveStation { id: string; title: string; thumbUrl: string; kind: 'foryou' | 'sc' | 'yt' | 'curated' | 'yandex'; }
const FORYOU: WaveStation = { id: 'foryou', title: 'Для тебя', thumbUrl: '', kind: 'foryou' };
const CURATED: WaveStation = { id: 'curated', title: 'Мой подбор', thumbUrl: '', kind: 'curated' };
const WAVE_CURATED_MOODS_KEY = 'ytm-curated-moods';
const MOOD_TAG_CATS = moodTagCategories();

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
  // 'curated' не переживает рестарт (curatedTracks — только в памяти), поэтому
  // не сохраняем его как активную станцию — иначе после рестарта клик по
  // «Мой подбор» упрётся в guard «Сначала собери микс».
  if (id === CURATED.id) return;
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
  const [showInput, setShowInput] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputValueRef = useRef(player.volume.toString());
  const volumeBarRef = useRef<ProgressBarRef>(null);
  const iconContainerRef = useRef<HTMLDivElement>(null);

  const updateIcon = useCallback(() => {
    if (!iconContainerRef.current) return;
    const v = player.volume;
    const svg = v === 0
      ? '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>'
      : v < 50
      ? '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>'
      : '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>';
    iconContainerRef.current.innerHTML = svg;
  }, []);

  useEffect(() => {
    const updateVolume = () => {
      const v = player.volume;
      if (volumeBarRef.current) volumeBarRef.current.setProgress(v);
      updateIcon();
      if (!showInput && document.activeElement !== inputRef.current) {
        const s = v.toString();
        inputValueRef.current = s;
        if (inputRef.current) inputRef.current.value = s;
      }
    };
    const unsub = player.subscribe((ev) => {
      if (ev === 'state') updateVolume();
    });
    updateVolume();
    return unsub;
  }, [showInput, updateIcon]);

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
    inputValueRef.current = finalStr;
  };

  const handleInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === 'Escape') setShowInput(false);
  };

  const handleSeek = useCallback((pct: number) => {
    player.setVolume(Math.round(pct));
  }, []);

  return (
    <div
      className={styles.volumeControl}
      onWheel={(e) => player.setVolume(player.volume + (-Math.sign(e.deltaY) * 5))}
      onContextMenu={handleContextMenu}
    >
      <button className={styles.volumeBtn} onClick={() => player.toggleMute()} title="Громкость">
        <div ref={iconContainerRef} />
      </button>
      <ProgressBar
        ref={volumeBarRef}
        onSeek={handleSeek}
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
            defaultValue={inputValueRef.current}
            onChange={handleInputChange}
            onKeyDown={handleInputKeyDown}
          />
        </div>
      )}
    </div>
  );
};

// Прогресс-бар с обновлением через ref'ы — нулевое количество ре-рендеров на tick.
const WaveProgressBar = React.memo(({ onSeek }: { onSeek: (pct: number) => void }) => {
  const currentRef = useRef<HTMLSpanElement>(null);
  const durationRef = useRef<HTMLSpanElement>(null);
  const progressBarRef = useRef<ProgressBarRef>(null);

  useEffect(() => {
    const updateTime = () => {
      if (player.queueSourceId !== WAVE_SOURCE_ID) return;

      if (currentRef.current) currentRef.current.textContent = formatTime(player.currentTime);
      if (durationRef.current) durationRef.current.textContent = formatTime(player.duration);
      if (progressBarRef.current) {
        const pct = player.duration > 0 ? (player.currentTime / player.duration) * 100 : 0;
        progressBarRef.current.setProgress(pct);
      }
    };

    const unsub = player.subscribe((ev) => {
      if (ev === 'tick' || ev === 'buffer' || ev === 'state') updateTime();
    }, { tick: true, buffer: true });
    updateTime();
    return unsub;
  }, []);

  return (
    <div className={styles.waveProgress}>
      <ProgressBar
        ref={progressBarRef}
        buffered={player.buffered}
        onSeek={onSeek}
        className={styles.progressBar}
        nyanMode={true}
        isPlaying={player.isPlaying}
      />
      <div className={styles.timeRow}>
        <span ref={currentRef}>{formatTime(player.currentTime)}</span>
        <span ref={durationRef}>{formatTime(player.duration)}</span>
      </div>
    </div>
  );
});

interface MyWaveViewProps {
  onSelectArtist?: (id: string) => void;
  onSelectAlbum?: (id: string) => void;
  onSelectPlaylist?: (id: string, title: string) => void;
}

export const MyWaveView: React.FC<MyWaveViewProps> = ({ onSelectArtist, onSelectAlbum, onSelectPlaylist }) => {
  const [stations, setStations] = useState<WaveStation[]>(stationsCache || []);
  const [activeId, setActiveId] = useState<string>(getSavedActiveId());
  const [selectedFilter, setSelectedFilter] = useState<string>(
    () => (getHomeSource() === 'yandex' && isYandexEnabled()) ? 'yandex' : 'all'
  );
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(!stationsCache);
  const [error, setError] = useState<string | null>(null);
  const [likeAction, setLikeAction] = useState<'like' | 'dislike' | null>(null);
  const [showLyrics, setShowLyrics] = useState(false);
  const [showQueue, setShowQueue] = useState(false);
  const [shuffleOn, setShuffleOn] = useState(player.shuffle);
  const [repeatState, setRepeatState] = useState<'off' | 'all' | 'one'>(player.repeat);
  const [overrideTrack, setOverrideTrack] = useState<YTMTrack | null>(null);
  const [curateOpen, setCurateOpen] = useState(false);
  const [curatedMoods, setCuratedMoods] = useState<string[]>(getSavedCuratedMoods());
  const [curatedTracks, setCuratedTracks] = useState<YTMTrack[]>([]);
  const [curateBuilding, setCurateBuilding] = useState(false);
  // Снимок настроений на момент сборки — подпись станции не «плывёт» от кликов в панели.
  const [builtMoods, setBuiltMoods] = useState<string[]>([]);
  const [, force] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const wheelDrag = useRef<{ isDown: boolean; startY: number; scrollTop: number; moved: boolean }>({ isDown: false, startY: 0, scrollTop: 0, moved: false });
  const filterListRef = useRef<HTMLDivElement>(null);
  const firstItemRef = useRef<HTMLButtonElement>(null);
  const secondItemRef = useRef<HTMLButtonElement>(null);
  const suppressRecenter = useRef(false);
  const filterDrag = useRef<{ isDown: boolean; startX: number; scrollLeft: number; moved: boolean }>({ isDown: false, startX: 0, scrollLeft: 0, moved: false });
  const curateWrapRef = useRef<HTMLDivElement>(null);

  // Закрытие панели «Подобрать» по клику вне и по Escape (не во время сборки микса).
  useEffect(() => {
    if (!curateOpen) return;
    const handleClickAway = (e: MouseEvent) => {
      if (curateBuilding) return;
      if (curateWrapRef.current && !curateWrapRef.current.contains(e.target as Node)) {
        setCurateOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !curateBuilding) setCurateOpen(false);
    };
    document.addEventListener('mousedown', handleClickAway);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickAway);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [curateOpen, curateBuilding]);

  // Курируемые станции: SoundCloud (жанры) + YouTube супермиксы + Yandex (дашборд радио).
  useEffect(() => {
    if (stationsCache) return;
    Promise.all([
      getScWaveStations().catch(() => []),
      getMixedForYou().catch(() => []),
      getYandexWaveStations().catch(() => []),
    ]).then(([sc, yt, yandex]) => {
      const scSt: WaveStation[] = sc.map(s => ({ id: s.id, title: s.title, thumbUrl: s.thumbUrl, kind: 'sc' }));
      const ytSt: WaveStation[] = (yt || [])
        .filter(m => m.playlistId && m.title)
        .map(m => ({ id: m.playlistId, title: m.title, thumbUrl: m.thumbUrl, kind: 'yt' }));
      const yandexSt: WaveStation[] = yandex.map(s => ({ id: s.id, title: s.title, thumbUrl: s.thumbUrl, kind: 'yandex' }));
      const combined = [...scSt, ...ytSt, ...yandexSt];
      stationsCache = combined;
      setStations(combined);
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  // Перерисовка при смене трека / play-pause / лайке.
  useEffect(() => {
    const unsub = player.subscribe((e) => {
      if (e === 'tick') return;
      if (e === 'state') {
        setShuffleOn(player.shuffle);
        setRepeatState(player.repeat);
      }
      force(n => n + 1);
    });
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
      // «Все»: золотые (supermix) + ностальгия + открытия + SoundCloud + Yandex.
      const golden = stations.filter(st => {
        if (st.kind === 'sc' || st.kind === 'yandex') return false;
        const lower = st.title.toLowerCase();
        return /супер|super|рекоменд|новых релизов|new release|архив|replay|риплей/i.test(lower);
      });
      const sc = stations.filter(st => st.kind === 'sc');
      const yandex = stations.filter(st => st.kind === 'yandex');
      const list = [FORYOU, ...golden, ...sc, ...yandex];
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
    if (selectedFilter === 'yandex') {
      const list = stations.filter(st => st.kind === 'yandex');
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

  const allStations = useMemo<WaveStation[]>(
    () => (curatedTracks.length > 0 ? [CURATED, ...visibleStations] : visibleStations),
    [curatedTracks.length, visibleStations],
  );
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

  // Drag-to-scroll для фильтров: document-level слушатели,
  // чтобы click на чипах работал через обычный bubbling (без setPointerCapture).
  const onFilterPointerDown = useCallback((e: React.PointerEvent) => {
    const el = filterListRef.current;
    if (!el || e.button !== 0) return;
    filterDrag.current = { isDown: true, startX: e.pageX, scrollLeft: el.scrollLeft, moved: false };
    el.style.cursor = 'grabbing';
    const onMove = (ev: PointerEvent) => {
      if (!filterDrag.current.isDown) return;
      const dx = ev.pageX - filterDrag.current.startX;
      if (Math.abs(dx) > 8) filterDrag.current.moved = true;
      if (filterDrag.current.moved) {
        el.scrollLeft = filterDrag.current.scrollLeft - dx * 1.4;
      }
    };
    const onUp = () => {
      filterDrag.current.isDown = false;
      setTimeout(() => { filterDrag.current.moved = false; }, 80);
      el.style.cursor = '';
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
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
      if (d) { let s = el.scrollTop; while (s < d) s += d; while (s >= 2 * d) s -= d; el.scrollTop = s; }
      suppressRecenter.current = false;
    };
    requestAnimationFrame(step);
  }, []);

  // Drag-to-scroll для колеса станций (работает и на кнопках станций)
  const onWheelPointerDown = useCallback((e: React.PointerEvent) => {
    const el = listRef.current;
    if (!el || e.button !== 0) return;
    wheelDrag.current = { isDown: true, startY: e.pageY, scrollTop: el.scrollTop, moved: false };
    const onMove = (ev: PointerEvent) => {
      if (!wheelDrag.current.isDown) return;
      const dy = ev.pageY - wheelDrag.current.startY;
      if (Math.abs(dy) > 6) {
        wheelDrag.current.moved = true;
        el.style.cursor = 'grabbing';
        el.style.userSelect = 'none';
      }
      if (wheelDrag.current.moved) {
        el.scrollTop = wheelDrag.current.scrollTop - dy;
      }
    };
    const onUp = () => {
      wheelDrag.current.isDown = false;
      el.style.cursor = '';
      el.style.userSelect = '';
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }, []);

  // «Для тебя»: лайки (YT + SC + Yandex), при их отсутствии — недавняя история.
  const buildPersonalizedSeeds = useCallback(async (): Promise<YTMTrack[]> => {
    const scOn = isSoundCloudEnabled();
    const yandexOn = isYandexEnabled();
    const likes = await likedStore.getAllTracks();
    const hydratedLikes = await likedStore.hydrateTracks(likes);
    let ytPool = hydratedLikes.map(e => e.track).filter(t => t && t.isAvailable !== false);
    if (ytPool.length === 0) {
      const hist = await historyStore.getHistory(200);
      const hydratedHist = await historyStore.hydrateTracks(hist);
      ytPool = hydratedHist.map(h => h.track).filter(Boolean);
    }
    const scEntries = scOn ? await likedStore.getAllScTracks() : [];
    const scPool = scOn ? (await likedStore.hydrateScTracks(scEntries)).map(e => e.track) : [];
    const yandexEntries = yandexOn ? await likedStore.getAllYandexTracks() : [];
    const yandexPool = yandexOn ? (await likedStore.hydrateYandexTracks(yandexEntries)).map(e => e.track) : [];
    const ytSeeds = shuffle(ytPool).slice(0, 30);
    const scSeeds = shuffle(scPool).slice(0, 15);
    const yandexSeeds = shuffle(yandexPool).slice(0, 15);
    return (scSeeds.length || yandexSeeds.length)
      ? interleaveMany([ytSeeds, scSeeds, yandexSeeds]).slice(0, 40)
      : ytSeeds.slice(0, 40);
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
      } else if (st.kind === 'yandex') {
        seeds = (await getYandexWaveTracks(st.id)).slice(0, 50);
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
      // SC/Yandex/персональные станции — смешанный поток; YT-микс оставляем на родном радио.
      if (st.kind === 'sc' && isSoundCloudEnabled()) player.setActiveSources(['youtube', 'soundcloud']);
      else if (st.kind === 'yandex' && isYandexEnabled()) player.setActiveSources(['youtube', 'yandex']);
      else if (st.kind === 'foryou') {
        const sources: TrackSource[] = ['youtube'];
        if (isSoundCloudEnabled()) sources.push('soundcloud');
        if (isYandexEnabled()) sources.push('yandex');
        if (sources.length > 1) player.setActiveSources(sources);
      }
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
      setBuiltMoods(moodIds);
      saveCuratedMoods(moodIds);
      setCurateOpen(false);
      // Играем blended напрямую: startStation в замыкании держит устаревший
      // curatedTracks и завернул бы свежий микс на guard «собери микс».
      setActiveId(CURATED.id);
      saveActiveId(CURATED.id);
      await player.playTrackList(blended, 0, WAVE_SOURCE_ID);
    } finally {
      setCurateBuilding(false);
    }
  }, [stations]);

  const activeStation = allStations.find(s => s.id === activeId) || FORYOU;
  const waveActive = player.queueSourceId === WAVE_SOURCE_ID;

  // При переключении фильтра на платформенную вкладку (SC/Yandex) поднимаем в актив
  // её реальную станцию вместо общей "Для тебя" -- но не перебиваем реально играющую волну.
  useEffect(() => {
    if (waveActive) return;
    const kind: WaveStation['kind'] | null =
      selectedFilter === 'yandex' ? 'yandex' : (selectedFilter === 'soundcloud' || selectedFilter === 'genre') ? 'sc' : null;
    if (!kind) return;
    const current = stations.find(s => s.id === activeId);
    if (current?.kind === kind) return;
    const first = stations.find(s => s.kind === kind);
    if (first) { setActiveId(first.id); saveActiveId(first.id); }
  }, [selectedFilter, stations, activeId, waveActive]);

  const track = waveActive ? player.currentTrack : null;
  const isPlaying = waveActive && player.isPlaying;
  const likeStatus = track?.likeStatus;
  const isSc = track?.source === 'soundcloud';
  const noDislike = isSc || track?.source === 'yandex';

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
      const ok = await likedManager.toggleLike(track, likeStatus || 'INDIFFERENT');
      if (ok === false && track.source === 'soundcloud' && !isScAuthed()) {
        window.dispatchEvent(new CustomEvent('app-toast', {
          detail: { message: 'Для лайков SoundCloud войдите в настройках', type: 'info' }
        }));
      }
    } finally {
      setLikeAction(null);
    }
  }, [track, likeStatus, likeAction]);

  const onDislike = useCallback(async () => {
    if (!track || noDislike || likeAction) return;
    setLikeAction('dislike');
    try {
      await likedManager.toggleDislike(track, likeStatus || 'INDIFFERENT');
    } finally {
      setLikeAction(null);
    }
  }, [track, likeStatus, noDislike, likeAction]);

  const onShuffle = useCallback(() => {
    player.toggleShuffle();
  }, []);

  const onRepeat = useCallback(() => {
    player.toggleRepeat();
  }, []);

  const renderStation = (st: WaveStation, key: string, ref?: React.Ref<HTMLButtonElement>) => {
    const isActive = activeId === st.id;
    const playingHere = isActive && isPlaying;
    return (
      <button
        key={key}
        ref={ref}
        data-station-id={st.id}
        className={`${styles.station} ${isActive ? styles.stationActive : ''}`}
        onClick={(e) => { if (!wheelDrag.current.moved) startStation(st, e.currentTarget); }}
        disabled={loadingId !== null}
      >
        <span className={styles.stationThumb}>
          {st.kind === 'foryou' || st.kind === 'curated'
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
          <span className={styles.stationKind}>{
            st.kind === 'curated'
              ? `Подбор: ${builtMoods.map(id => MOOD_TAG_CATS.find(c => c.id === id)?.label).filter(Boolean).join(', ')}`
              : st.kind === 'foryou' ? 'Персональная'
              : st.kind === 'sc' ? 'SoundCloud'
              : st.kind === 'yandex' ? 'Yandex Music'
              : 'YouTube Mix'
          }</span>
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

      <div className={`${styles.filterStrip} ${curateOpen ? styles.filterStripOpen : ''}`}>
        <div className={styles.filterScrollArea}>
          {canScrollLeft && (
            <button className={styles.filterArrow} onClick={() => scrollFilters(-1)} aria-label="Назад" type="button">
              <ChevronLeft size={16} />
            </button>
          )}
          <div
            className={`${styles.filterList} ${canScrollLeft ? styles.fadeLeft : ''} ${canScrollRight ? styles.fadeRight : ''}`}
            ref={filterListRef}
            onPointerDown={onFilterPointerDown}
            onScroll={checkFilterScroll}
          >
            {MOOD_CATEGORIES.map(cat => (
              <button
                key={cat.id}
                className={`${styles.filterPill} ${selectedFilter === cat.id ? styles.filterPillActive : ''}`}
                style={{ '--mood-color': cat.color } as React.CSSProperties}
                onClick={() => { if (!filterDrag.current.moved) setSelectedFilter(cat.id); }}
                title={cat.label}
              >
                <EmojiText emoji={cat.emoji} className={styles.filterEmoji} />
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
        <div className={styles.curateWrap} ref={curateWrapRef}>
          <button
            type="button"
            className={`${styles.curateChip} ${curateOpen ? styles.curateChipOn : ''}`}
            onClick={() => setCurateOpen(v => !v)}
            title="Собрать свой микс по настроениям"
            aria-expanded={curateOpen}
            aria-haspopup="dialog"
          >
            + Подобрать
          </button>
          {curateOpen && (
            <CuratePanel
              selected={curatedMoods}
              onToggle={(id) => setCuratedMoods(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])}
              onBuild={() => buildCuratedMix(curatedMoods)}
              building={curateBuilding}
              onClose={() => setCurateOpen(false)}
            />
          )}
        </div>
      </div>

      <aside className={`${styles.sidebar} ${panelOpen ? styles.sidebarHidden : ''}`}>
        <div
          className={styles.wheel}
          ref={listRef}
          onScroll={handleScroll}
          onPointerDown={onWheelPointerDown}
        >
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
                <div className={styles.progressTop}>
                  {shuffleOn && (
                    <span className={styles.progressChip}>
                      <Shuffle size={11} />
                      <span>SHUF</span>
                    </span>
                  )}
                  {repeatState !== 'off' && (
                    <span className={`${styles.progressChip} ${styles.progressChipRepeat}`}>
                      {repeatState === 'one' ? <Repeat1 size={11} /> : <Repeat size={11} />}
                      <span>{repeatState === 'one' ? 'ONE' : 'ALL'}</span>
                    </span>
                  )}
                </div>
                <WaveProgressBar onSeek={handleSeek} />
              </div>

              <div className={styles.controls}>
                {/* Shuffle */}
                <button
                  className={`${styles.ctrl} ${shuffleOn ? styles.ctrlActiveGood : ''}`}
                  onClick={onShuffle}
                  title={shuffleOn ? 'Перемешивание включено' : 'Перемешать'}
                >
                  <Shuffle size={18} />
                </button>
                {/* Prev */}
                <button className={styles.ctrl} onClick={() => player.prev()} title="Назад">
                  <SkipBack size={20} fill="currentColor" />
                </button>
                {/* Play */}
                <button className={styles.ctrlMain} onClick={onPrimary} title={isPlaying ? 'Пауза' : 'Играть'}>
                  {loadingId ? <Loader2 className={styles.spin} size={28} />
                    : isPlaying ? <Pause size={28} fill="currentColor" />
                    : <Play size={28} fill="currentColor" />}
                </button>
                {/* Next */}
                <button className={styles.ctrl} onClick={() => player.next()} title="Вперёд">
                  <SkipForward size={20} fill="currentColor" />
                </button>
                {/* Like */}
                <button
                  className={`${styles.ctrl} ${likeStatus === 'LIKE' ? styles.ctrlActiveGood : ''}`}
                  onClick={onLike}
                  disabled={likeAction !== null}
                  title="Нравится"
                >
                  {likeAction === 'like' ? <Loader2 size={18} className={styles.spin} /> : <Heart size={18} fill={likeStatus === 'LIKE' ? 'currentColor' : 'none'} />}
                </button>
                {/* Repeat */}
                <button
                  className={`${styles.ctrl} ${repeatState !== 'off' ? styles.ctrlActiveGood : ''}`}
                  onClick={onRepeat}
                  title={repeatState === 'off' ? 'Повтор выключен' : repeatState === 'all' ? 'Повтор всех' : 'Повтор одного'}
                >
                  {repeatState === 'all' ? <Repeat size={18} /> : repeatState === 'one' ? <Repeat1 size={18} /> : <Repeat size={18} strokeWidth={2.5} />}
                </button>
              </div>

              <div className={styles.secondaryControls}>
                {/* Dislike */}
                <button
                  className={`${styles.ctrl} ${likeStatus === 'DISLIKE' && !noDislike ? styles.ctrlActiveBad : ''}`}
                  onClick={onDislike}
                  disabled={noDislike || likeAction !== null}
                  title={noDislike ? `${isSc ? 'SoundCloud' : 'Yandex Music'} не поддерживает дизлайк` : 'Не нравится'}
                >
                  {likeAction === 'dislike' ? <Loader2 size={18} className={styles.spin} /> : <HeartCrack size={18} color={likeStatus === 'DISLIKE' && !noDislike ? '#fab387' : noDislike ? 'rgba(255,255,255,0.25)' : undefined} />}
                </button>
                {/* Queue */}
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
                {/* Lyrics */}
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
                {/* Download */}
                <button
                  className={styles.ctrl}
                  onClick={() => track && setOverrideTrack(track)}
                  title="Скачать / заменить источник"
                >
                  <HardDriveDownload size={18} />
                </button>
                <div className={styles.volDivider} />
                <WaveVolumeControl />
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
          <LyricsView isVisible={showLyrics} waveMode={true} />
        </div>
      </aside>

      <aside className={`${styles.queuePanel} ${showQueue ? styles.queuePanelVisible : ''}`}>
        <div className={styles.queuePanelInner}>
          <QueuePanel
            isVisible={showQueue}
            waveMode={true}
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
