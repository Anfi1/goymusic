import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Play, Pause, SkipBack, SkipForward, Heart, HeartCrack, Loader2, AudioLines } from 'lucide-react';
import { player } from '../../api/player';
import { likedStore } from '../../api/likedStore';
import { historyStore } from '../../api/history';
import { likedManager } from '../../api/likedManager';
import { YTMTrack, getMixedForYou, getPlaylistTracks } from '../../api/yt';
import {
  isSoundCloudEnabled, interleaveTracks,
  getScWaveStations, getScStationTracks,
} from '../../api/soundcloud';
import { LazyImage } from '../atoms/LazyImage';
import { SourceBadge } from '../atoms/SourceBadge';
import styles from './MyWaveView.module.css';

const WAVE_SOURCE_ID = 'my-wave';

interface WaveStation { id: string; title: string; thumbUrl: string; kind: 'foryou' | 'sc' | 'yt'; }
const FORYOU: WaveStation = { id: 'foryou', title: 'Для тебя', thumbUrl: '', kind: 'foryou' };

// Кэш станций между заходами в раздел (мало меняются).
let stationsCache: WaveStation[] | null = null;

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const MyWaveView: React.FC = () => {
  const [stations, setStations] = useState<WaveStation[]>(stationsCache || []);
  const [activeId, setActiveId] = useState('foryou');
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, force] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const firstItemRef = useRef<HTMLButtonElement>(null);
  const secondItemRef = useRef<HTMLButtonElement>(null);
  const suppressRecenter = useRef(false);

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
    }).catch(() => {});
  }, []);

  // Перерисовка при смене трека / play-pause / лайке.
  useEffect(() => {
    const unsub = player.subscribe((e) => { if (e !== 'tick') force(n => n + 1); });
    const onLike = () => force(n => n + 1);
    window.addEventListener('track-like-updated', onLike);
    return () => { unsub(); window.removeEventListener('track-like-updated', onLike); };
  }, []);

  const allStations = [FORYOU, ...stations];
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
    const id = requestAnimationFrame(() => { const d = loopDistance(); if (d) el.scrollTop = d; });
    return () => cancelAnimationFrame(id);
  }, [stations.length]);

  const handleScroll = useCallback(() => {
    const el = listRef.current;
    if (!el || !looping || suppressRecenter.current) return;
    const d = loopDistance();
    if (!d) return;
    if (el.scrollTop < d * 0.5) el.scrollTop += d;
    else if (el.scrollTop >= d * 1.5) el.scrollTop -= d;
  }, [looping]);

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
    if (btn) centerStation(btn);
    setLoadingId(st.id);
    setError(null);
    try {
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
  }, [buildPersonalizedSeeds, centerStation]);

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

  const onLike = useCallback(() => {
    if (track) likedManager.toggleLike(track, likeStatus || 'INDIFFERENT');
  }, [track, likeStatus]);

  const onDislike = useCallback(() => {
    if (track && !isSc) likedManager.toggleDislike(track, likeStatus || 'INDIFFERENT');
  }, [track, likeStatus, isSc]);

  const renderStation = (st: WaveStation, key: string, ref?: React.Ref<HTMLButtonElement>) => {
    const isActive = activeId === st.id;
    const playingHere = isActive && isPlaying;
    return (
      <button
        key={key}
        ref={ref}
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

  return (
    <div className={styles.container}>
      {/* Иммерсивный фон во всю ширину — список и плеер живут поверх него без границы. */}
      <div
        className={styles.bg}
        style={track?.thumbUrl ? { backgroundImage: `url(${track.thumbUrl})` } : undefined}
      />
      <div className={styles.bgOverlay} />

      <aside className={styles.sidebar}>
        <div className={styles.wheel} ref={listRef} onScroll={handleScroll}>
          {looped.map((st, i) => renderStation(
            st,
            `${st.id}-${i}`,
            i === 0 ? firstItemRef : i === allStations.length ? secondItemRef : undefined,
          ))}
          {stations.length === 0 && (
            <p className={styles.listHint}>Включи SoundCloud в настройках — добавятся жанровые станции.</p>
          )}
        </div>
      </aside>

      <main className={styles.stage}>
        <div className={styles.stageInner}>
          <div className={styles.stationBadge}>{activeStation.title}</div>

          {track ? (
            <>
              <div className={styles.artWrap}>
                <LazyImage src={track.thumbUrl} alt={track.title} className={styles.art} />
                <span className={styles.artBadge}><SourceBadge source={track.source} /></span>
              </div>

              <div className={styles.trackMeta}>
                <h1 className={styles.trackTitle}>{track.title}</h1>
                <p className={styles.trackArtist}>{track.artists?.join(', ')}</p>
              </div>

              <div className={styles.controls}>
                <button
                  className={`${styles.ctrl} ${likeStatus === 'DISLIKE' ? styles.ctrlActiveBad : ''}`}
                  onClick={onDislike}
                  disabled={isSc}
                  title={isSc ? 'SoundCloud не поддерживает дизлайк' : 'Не нравится'}
                >
                  <HeartCrack size={20} />
                </button>
                <button className={styles.ctrl} onClick={() => player.prev()} title="Назад">
                  <SkipBack size={22} fill="currentColor" />
                </button>
                <button className={styles.ctrlMain} onClick={onPrimary} title={isPlaying ? 'Пауза' : 'Играть'}>
                  {loadingId ? <Loader2 className={styles.spin} size={28} />
                    : isPlaying ? <Pause size={28} fill="currentColor" />
                    : <Play size={28} fill="currentColor" />}
                </button>
                <button className={styles.ctrl} onClick={() => player.next()} title="Вперёд">
                  <SkipForward size={22} fill="currentColor" />
                </button>
                <button
                  className={`${styles.ctrl} ${likeStatus === 'LIKE' ? styles.ctrlActiveGood : ''}`}
                  onClick={onLike}
                  title="Нравится"
                >
                  <Heart size={20} fill={likeStatus === 'LIKE' ? 'currentColor' : 'none'} />
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
    </div>
  );
};
