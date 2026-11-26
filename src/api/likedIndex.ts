import { useSyncExternalStore } from 'react';
import type { YTMTrack } from './yt';
import { likedStore } from './likedStore';
import { likedManager } from './likedManager';
import { scLikedManager } from './scLikedManager';
import { isScTrackLiked } from './soundcloud';
import { isYandexTrackLiked } from './yandex';

export type TrackLikeStatus = YTMTrack['likeStatus'];

export interface TrackLikeLookup {
  /** ID треков из локальных сторов лайков (YT videoId, SC URL, yandex:<id>). */
  likedTrackIds: ReadonlySet<string>;
  /** Числовые scId из sc_liked (на случай расхождения URL трека). */
  likedScIds?: ReadonlySet<string>;
  /** Числовые yandexId из yandex_liked. */
  likedYandexIds?: ReadonlySet<string>;
  /** Живые переопределения из событий track-like-updated (имеют высший приоритет). */
  overrides?: ReadonlyMap<string, TrackLikeStatus> | Readonly<Record<string, TrackLikeStatus>>;
  /** In-memory проверка SC-лайка (loadScLikedIds / scLocalOnlySet). */
  isScLiked?: (scId: string | undefined) => boolean;
  /** In-memory проверка Yandex-лайка (loadYandexLikedIds). */
  isYandexLiked?: (yandexId: string | undefined) => boolean;
  /** Признак завершения первичного чтения IDB-сторов. */
  loaded?: boolean;
  /** Монотонный счетчик версий снимка. */
  version?: number;
}

export interface ResolveTrackLikeOptions {
  /**
   * Для исторических треков из tracksStore: после загрузки сторов сбрасывает устаревший
   * кэшированный 'LIKE' в 'INDIFFERENT', если трека нет в локальных/in-memory лайках.
   */
  demoteStaleLike?: boolean;
}

function readOverride(
  overrides: TrackLikeLookup['overrides'],
  id: string,
): { found: true; value: TrackLikeStatus } | { found: false } {
  if (!overrides) return { found: false };
  if (overrides instanceof Map) {
    if (overrides.has(id)) return { found: true, value: overrides.get(id) };
    return { found: false };
  }
  const record = overrides as Readonly<Record<string, TrackLikeStatus>>;
  if (Object.prototype.hasOwnProperty.call(record, id)) {
    return { found: true, value: record[id] };
  }
  return { found: false };
}

export function resolveTrackLikeStatus(
  track: Pick<YTMTrack, 'id' | 'likeTargetId' | 'likeStatus' | 'source' | 'scId' | 'yandexId'>,
  lookup: TrackLikeLookup,
  options?: ResolveTrackLikeOptions,
): TrackLikeStatus {
  // 1. Живое событие track-like-updated для самого track.id имеет высший приоритет.
  if (track.id) {
    const override = readOverride(lookup.overrides, track.id);
    if (override.found) return override.value;
  }

  // 2. Прямое совпадение по track.id или платформенным идентификаторам (SC / Yandex).
  const yandexId = track.yandexId || (track.id?.startsWith('yandex:') ? track.id.slice(7) : undefined);

  const isInLikedStore =
    (!!track.id && lookup.likedTrackIds.has(track.id)) ||
    (!!track.scId && (!!lookup.likedScIds?.has(track.scId) || !!lookup.isScLiked?.(track.scId))) ||
    (!!yandexId && (!!lookup.likedYandexIds?.has(yandexId) || !!lookup.isYandexLiked?.(yandexId)));

  if (isInLikedStore) {
    return 'LIKE';
  }

  // 3-4. Проверяем likeTargetId только после track.id, чтобы повторный лайк playable id
  // не перебивался старым INDIFFERENT-оверрайдом от снятого counterpart videoId.
  if (track.likeTargetId && track.likeTargetId !== track.id) {
    const targetOverride = readOverride(lookup.overrides, track.likeTargetId);
    if (targetOverride.found) return targetOverride.value;
    if (lookup.likedTrackIds.has(track.likeTargetId)) return 'LIKE';
  }

  if (options?.demoteStaleLike && lookup.loaded && track.likeStatus === 'LIKE') {
    return 'INDIFFERENT';
  }

  return track.likeStatus;
}

export function hydrateTrackLikeStatus<T extends YTMTrack>(
  track: T,
  lookup: TrackLikeLookup,
  options?: ResolveTrackLikeOptions,
): T {
  const nextLikeStatus = resolveTrackLikeStatus(track, lookup, options);
  if (nextLikeStatus === track.likeStatus) return track;
  return { ...track, likeStatus: nextLikeStatus };
}

export function hydrateTracksLikeStatus<T extends YTMTrack>(
  tracks: readonly T[],
  lookup: TrackLikeLookup,
  options?: ResolveTrackLikeOptions,
): T[] {
  let changed = false;
  const resolved = tracks.map(track => {
    const next = hydrateTrackLikeStatus(track, lookup, options);
    if (next !== track) changed = true;
    return next;
  });
  return changed ? resolved : (tracks as T[]);
}

// --- Singleton reactive store ---

let started = false;
let ytLoaded = false;
let scLoaded = false;
let yandexLoaded = false;
let loaded = false;
let seq = 0;
let version = 0;
let resetGeneration = 0;
let flushScheduled = false;
let reloadScheduled = false;
let reloadInFlight: Promise<void> | null = null;
let reloadAgain = false;

let ytTrackIds = new Set<string>();
let ytTargetIds = new Set<string>();
let scTrackIds = new Set<string>();
let syncedScTrackIds = new Set<string>();
let scIds = new Set<string>();
let scTrackIdToScId = new Map<string, string>();
let yandexTrackIds = new Set<string>();
let yandexIds = new Set<string>();

// Мутабельный Map для O(1) вставки при массовых событиях (например, ~1500 событий broadcastYandexLikes).
const liveOverrides = new Map<string, { status: TrackLikeStatus; seq: number }>();

const listeners = new Set<() => void>();
let unsubYt: (() => void) | null = null;
let unsubSc: (() => void) | null = null;
let likeUpdateListener: ((e: Event) => void) | null = null;
let externalLikesListener: (() => void) | null = null;
let listenedWindow: (typeof window) | null = null;

function buildSnapshot(): TrackLikeLookup {
  const likedTrackIds = new Set<string>();
  for (const id of ytTrackIds) likedTrackIds.add(id);
  for (const id of scTrackIds) likedTrackIds.add(id);
  for (const id of yandexTrackIds) likedTrackIds.add(id);

  const overrides = new Map<string, TrackLikeStatus>();
  for (const [id, entry] of liveOverrides) {
    overrides.set(id, entry.status);
  }

  return {
    likedTrackIds,
    likedScIds: new Set(scIds),
    likedYandexIds: new Set(yandexIds),
    overrides,
    isScLiked: isScTrackLiked,
    isYandexLiked: isYandexTrackLiked,
    loaded,
    version: ++version,
  };
}

let snapshot: TrackLikeLookup = buildSnapshot();

function emitSnapshot(): void {
  snapshot = buildSnapshot();
  for (const listener of listeners) {
    listener();
  }
}

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  const gen = resetGeneration;
  queueMicrotask(() => {
    flushScheduled = false;
    if (gen !== resetGeneration) return;
    emitSnapshot();
  });
}

function scheduleReload(): void {
  if (reloadScheduled) return;
  reloadScheduled = true;
  const gen = resetGeneration;
  queueMicrotask(() => {
    reloadScheduled = false;
    if (gen !== resetGeneration) return;
    void reloadLikedIndex();
  });
}

export async function reloadLikedIndex(): Promise<void> {
  if (reloadInFlight) {
    reloadAgain = true;
    return reloadInFlight;
  }

  const gen = resetGeneration;
  const run = async () => {
    do {
      reloadAgain = false;
      // Фиксируем seq до чтения IDB: клики пользователя во время асинхронного чтения получат seq > startSeq и сохранятся.
      const startSeq = ++seq;
      const [ytRes, scRes, yandexRes] = await Promise.allSettled([
        typeof likedStore?.getAllTracks === 'function' ? likedStore.getAllTracks() : Promise.resolve([]),
        typeof likedStore?.getAllScTracks === 'function' ? likedStore.getAllScTracks() : Promise.resolve([]),
        typeof likedStore?.getAllYandexTracks === 'function' ? likedStore.getAllYandexTracks() : Promise.resolve([]),
      ]);

      if (gen !== resetGeneration) return;

      const ytOk = ytRes.status === 'fulfilled';
      if (ytOk) {
        const nextYt = new Set<string>();
        const nextYtTargets = new Set<string>();
        for (const e of ytRes.value) {
          if (e?.trackId) nextYt.add(e.trackId);
          const targets = e?.likeTargetIds?.length ? e.likeTargetIds : (e?.trackId ? [e.trackId] : []);
          for (const tid of targets) {
            if (tid) {
              nextYt.add(tid);
              nextYtTargets.add(tid);
            }
          }
        }
        ytTrackIds = nextYt;
        ytTargetIds = nextYtTargets;
        ytLoaded = true;
      }

      const scOk = scRes.status === 'fulfilled';
      if (scOk) {
        const nextScTrack = new Set<string>();
        const nextSyncedScTrack = new Set<string>();
        const nextScIds = new Set<string>();
        const nextScTrackToScId = new Map<string, string>();
        for (const e of scRes.value) {
          if (e?.trackId) {
            nextScTrack.add(e.trackId);
            if (!e.localOnly) nextSyncedScTrack.add(e.trackId);
            if (e.scId) nextScTrackToScId.set(e.trackId, e.scId);
          }
          if (e?.scId) nextScIds.add(e.scId);
        }
        scTrackIds = nextScTrack;
        syncedScTrackIds = nextSyncedScTrack;
        scIds = nextScIds;
        scTrackIdToScId = nextScTrackToScId;
        scLoaded = true;
      }

      const yandexOk = yandexRes.status === 'fulfilled';
      if (yandexOk) {
        const nextYandexTrack = new Set<string>();
        const nextYandexIds = new Set<string>();
        for (const e of yandexRes.value) {
          if (e?.trackId) nextYandexTrack.add(e.trackId);
          if (e?.yandexId) nextYandexIds.add(e.yandexId);
        }
        yandexTrackIds = nextYandexTrack;
        yandexIds = nextYandexIds;
        yandexLoaded = true;
      }

      loaded = ytLoaded && scLoaded && yandexLoaded;

      for (const [id, entry] of liveOverrides) {
        if (entry.seq >= startSeq) continue;

        const isYandex = id.startsWith('yandex:');
        const rawYandexId = isYandex ? id.slice(7) : '';
        const isSc = !isYandex && id.includes('soundcloud.com');
        const scId = isSc ? scTrackIdToScId.get(id) : undefined;

        if (entry.status === 'LIKE') {
          // Снимаем LIKE-переопределение только когда оно подтверждено прочитанным IDB-стором
          // или in-memory набором (в т.ч. массовый broadcastYandexLikes), чтобы не терять
          // неподтвержденный SC localOnly-лайк и не стирать лайки при сбое чтения IDB.
          const confirmed = isYandex
            ? (yandexOk && (yandexTrackIds.has(id) || yandexIds.has(rawYandexId))) || isYandexTrackLiked(rawYandexId)
            : isSc
              ? (scOk && scTrackIds.has(id)) || (scId !== undefined && isScTrackLiked(scId))
              : ytOk && ytTrackIds.has(id);
          if (confirmed) {
            liveOverrides.delete(id);
          }
        } else {
          // Снимаем устаревший INDIFFERENT/DISLIKE, если свежий синк снова вернул трек в лайки
          // (например, повторный лайк с телефона/веба). Для SC дополнительно проверяем isScTrackLiked
          // и syncedScTrackIds, чтобы не перебить in-flight локальный unlike до коммита removeLocal.
          const reLikedRemotely = isYandex
            ? yandexOk && (yandexTrackIds.has(id) || yandexIds.has(rawYandexId)) && isYandexTrackLiked(rawYandexId)
            : isSc
              ? scOk && syncedScTrackIds.has(id) && scId !== undefined && isScTrackLiked(scId)
              : ytOk && (entry.status === 'DISLIKE' ? ytTargetIds.has(id) : ytTrackIds.has(id));
          if (reLikedRemotely) {
            liveOverrides.delete(id);
          }
        }
      }

      emitSnapshot();
    } while (reloadAgain && gen === resetGeneration);
  };

  reloadInFlight = run().finally(() => {
    if (gen === resetGeneration) {
      reloadInFlight = null;
    }
  });
  return reloadInFlight;
}

function ensureStarted(): void {
  if (started) return;
  started = true;

  if (typeof likedManager?.subscribe === 'function') {
    unsubYt = likedManager.subscribe(() => scheduleReload());
  }
  if (typeof scLikedManager?.subscribe === 'function') {
    unsubSc = scLikedManager.subscribe(() => scheduleReload());
  }

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    listenedWindow = window;
    likeUpdateListener = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.id || detail.status !== 'success') return;
      const nextStatus = detail.likeStatus as TrackLikeStatus;
      const prev = liveOverrides.get(detail.id);
      if (prev && prev.status === nextStatus) {
        prev.seq = ++seq;
        return;
      }
      liveOverrides.set(detail.id, { status: nextStatus, seq: ++seq });
      scheduleFlush();
    };
    externalLikesListener = () => {
      // Откладываем reload в микротаск, чтобы синхронный burst broadcastYandexLikes успел записаться до startSeq.
      scheduleReload();
    };
    window.addEventListener('track-like-updated', likeUpdateListener);
    window.addEventListener('sc-likes-loaded', externalLikesListener);
    window.addEventListener('yandex-likes-loaded', externalLikesListener);
  }

  void reloadLikedIndex();
}

export const likedIndex = {
  subscribe(listener: () => void): () => void {
    ensureStarted();
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getSnapshot(): TrackLikeLookup {
    return snapshot;
  },
};

const noopSubscribe = () => () => {};
const EMPTY_LOOKUP: TrackLikeLookup = Object.freeze({
  likedTrackIds: new Set<string>(),
});
const getEmptyLookup = () => EMPTY_LOOKUP;

export function useLikedLookup(enabled = true): TrackLikeLookup {
  return useSyncExternalStore(
    enabled ? likedIndex.subscribe : noopSubscribe,
    enabled ? likedIndex.getSnapshot : getEmptyLookup,
    enabled ? likedIndex.getSnapshot : getEmptyLookup,
  );
}

export function resetLikedIndexForTests(): void {
  resetGeneration++;
  started = false;
  ytLoaded = false;
  scLoaded = false;
  yandexLoaded = false;
  loaded = false;
  seq = 0;
  flushScheduled = false;
  reloadScheduled = false;
  reloadInFlight = null;
  reloadAgain = false;

  if (unsubYt) { unsubYt(); unsubYt = null; }
  if (unsubSc) { unsubSc(); unsubSc = null; }
  if (listenedWindow) {
    if (likeUpdateListener) listenedWindow.removeEventListener('track-like-updated', likeUpdateListener);
    if (externalLikesListener) {
      listenedWindow.removeEventListener('sc-likes-loaded', externalLikesListener);
      listenedWindow.removeEventListener('yandex-likes-loaded', externalLikesListener);
    }
  }
  listenedWindow = null;
  likeUpdateListener = null;
  externalLikesListener = null;

  listeners.clear();
  ytTrackIds = new Set();
  ytTargetIds = new Set();
  scTrackIds = new Set();
  syncedScTrackIds = new Set();
  scIds = new Set();
  scTrackIdToScId = new Map();
  yandexTrackIds = new Set();
  yandexIds = new Set();
  liveOverrides.clear();
  snapshot = buildSnapshot();
}
