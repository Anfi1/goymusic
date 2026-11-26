import type { YTMTrack } from './yt';
import type { ScLikedEntry } from './likedStore';
import { likedStore } from './likedStore';
import { tracksStore } from './tracks';
import { registerSoundCloudTrack } from './stream';
import {
  getScTokenRefreshDelayMs,
  isScTokenExpiringSoon,
  SC_PROACTIVE_REFRESH_LEEWAY_SEC,
} from '../utils/scJwt';

export interface ScSearchEntry {
  url: string;
  title: string;
  artist: string;
  duration: number | null;
  thumbUrl: string;
  source: string;
  uploaderUrl?: string;
  scId?: string;
}

export function formatScDuration(seconds: number | null | undefined): string {
  const s = Math.max(0, Math.floor(seconds || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}

export function scEntryToTrack(entry: ScSearchEntry): YTMTrack {
  return {
    id: entry.url,
    title: entry.title || 'Unknown',
    artists: entry.artist ? [entry.artist] : [],
    // uploaderUrl делает имя SC-артиста кликабельным (ведёт на страницу SC-артиста)
    artistIds: entry.uploaderUrl ? [entry.uploaderUrl] : undefined,
    album: '',
    duration: formatScDuration(entry.duration),
    thumbUrl: entry.thumbUrl || '',
    source: 'soundcloud',
    scUrl: entry.url,
    scId: entry.scId,
    isAvailable: true,
    likeStatus: isScTrackLiked(entry.scId) ? 'LIKE' : undefined,
  };
}

// Чередуем 2 YouTube : 1 SoundCloud; остатки добавляем в конец.
export function mergeTracks(yt: YTMTrack[], sc: YTMTrack[]): YTMTrack[] {
  const out: YTMTrack[] = [];
  let i = 0, j = 0;
  while (i < yt.length || j < sc.length) {
    for (let k = 0; k < 2 && i < yt.length; k++) out.push(yt[i++]);
    if (j < sc.length) out.push(sc[j++]);
  }
  return out;
}

// Чередуем 1:1 (50/50); остатки более длинного списка добавляем в конец.
export function interleaveTracks(a: YTMTrack[], b: YTMTrack[]): YTMTrack[] {
  return interleaveMany([a, b]);
}

// Round-robin чередование произвольного числа списков (используется для 3+ источников
// в очереди: YT/SC/Yandex одновременно, вместо жёсткого 2-way interleave).
export function interleaveMany(lists: YTMTrack[][]): YTMTrack[] {
  const out: YTMTrack[] = [];
  const nonEmpty = lists.filter(l => l.length > 0);
  const maxLen = Math.max(0, ...nonEmpty.map(l => l.length));
  for (let i = 0; i < maxLen; i++) {
    for (const l of nonEmpty) if (i < l.length) out.push(l[i]);
  }
  return out;
}

// "M:SS" / "H:MM:SS" -> секунды (0 при пустом/битом значении). Без аллокаций split/map.
function durationToSeconds(d: string | undefined | null): number {
  if (!d) return 0;
  let total = 0;
  let part = 0;
  let hasDigit = false;
  for (let i = 0; i < d.length; i++) {
    const c = d.charCodeAt(i);
    if (c >= 48 && c <= 57) {
      part = part * 10 + (c - 48);
      hasDigit = true;
    } else if (c === 58) {
      if (!hasDigit) return 0;
      total = total * 60 + part;
      part = 0;
      hasDigit = false;
    } else {
      return 0;
    }
  }
  return hasDigit ? total * 60 + part : 0;
}

// --- Cross-platform dedup (YouTube <-> SoundCloud) ---

const NON_ALNUM_RE = /[^a-zа-яё0-9]/g;
const ART_MIN_LEN = 8;
const DUR_TOLERANCE_SEC = 5;

function normalizeText(raw: string): string {
  return raw ? raw.toLowerCase().replace(NON_ALNUM_RE, '') : '';
}

function artistsText(artists: string[] | undefined): string {
  if (!artists || artists.length === 0) return '';
  return artists.length === 1 ? (artists[0] || '') : artists.join(' ');
}

/** Нормализованная сигнатура трека: title + artists, нижний регистр, без пунктуации/пробелов. */
export function normalizeSignature(t: YTMTrack): string {
  const title = normalizeText(t.title || '');
  const artists = normalizeText(artistsText(t.artists));
  return title + artists;
}

interface PreparedTrackDedup {
  readonly id: string;
  readonly sig: string;
  readonly art: string;
  readonly title: string;
  readonly durSec: number;
}

function prepareTrackDedup(t: YTMTrack): PreparedTrackDedup {
  const title = normalizeText(t.title || '');
  const art = normalizeText(artistsText(t.artists));
  return {
    id: t.id || '',
    sig: title + art,
    art,
    title,
    durSec: durationToSeconds(t.duration),
  };
}

// Переиспользуемые буферы для banded Levenshtein без аллокаций на каждую пару.
let levPrev = new Int32Array(256);
let levCurr = new Int32Array(256);

function ensureLevCapacity(size: number) {
  if (levPrev.length >= size) return;
  let next = levPrev.length;
  while (next < size) next *= 2;
  levPrev = new Int32Array(next);
  levCurr = new Int32Array(next);
}

/**
 * Banded Levenshtein с ранним прерыванием: возвращает точное расстояние, если оно <= maxDist,
 * иначе maxDist + 1. Любой путь стоимостью <= maxDist лежит внутри полосы |i - j| <= maxDist.
 */
function levenshteinWithin(a: string, b: string, maxDist: number): number {
  const al = a.length;
  const bl = b.length;
  const inf = maxDist + 1;
  if (Math.abs(al - bl) > maxDist) return inf;
  if (maxDist === 0) return a === b ? 0 : 1;
  if (al === 0) return bl;
  if (bl === 0) return al;

  ensureLevCapacity(bl + 1);
  let prev = levPrev;
  let curr = levCurr;

  const initEnd = bl < maxDist ? bl : maxDist;
  for (let j = 0; j <= initEnd; j++) prev[j] = j;

  for (let i = 1; i <= al; i++) {
    const jStart = i > maxDist ? i - maxDist : 1;
    const jEnd = i + maxDist < bl ? i + maxDist : bl;
    const prevBandEnd = i - 1 + maxDist;

    curr[jStart - 1] = jStart === 1 ? i : inf;
    let rowMin = curr[jStart - 1];
    const ca = a.charCodeAt(i - 1);

    for (let j = jStart; j <= jEnd; j++) {
      const diag = prev[j - 1] + (ca === b.charCodeAt(j - 1) ? 0 : 1);
      const above = j <= prevBandEnd ? prev[j] + 1 : inf;
      const left = curr[j - 1] + 1;
      let val = diag < above ? diag : above;
      if (left < val) val = left;
      curr[j] = val;
      if (val < rowMin) rowMin = val;
    }

    if (rowMin > maxDist) return inf;
    const swap = prev;
    prev = curr;
    curr = swap;
  }

  return prev[bl];
}

function isFuzzyOrArtistDuplicate(a: PreparedTrackDedup, b: PreparedTrackDedup): boolean {
  if (a.durSec > 0 && b.durSec > 0 && Math.abs(a.durSec - b.durSec) > DUR_TOLERANCE_SEC) {
    return false;
  }

  // Этап 2: нечеткое совпадение >= 85% с отсечением по разнице длин и banded Levenshtein.
  const al = a.sig.length;
  const bl = b.sig.length;
  const maxLen = al > bl ? al : bl;
  const maxDist = Math.floor(maxLen * 0.15 + 1e-9);
  if (Math.abs(al - bl) <= maxDist) {
    const dist = levenshteinWithin(a.sig, b.sig, maxDist);
    if (dist <= maxDist && 1 - dist / maxLen >= 0.85) return true;
  }

  // Этап 3: заголовок одного трека содержит артистов другого (SC-перезаливы без названия песни).
  if (a.art.length >= ART_MIN_LEN && b.title.length >= a.art.length && b.title.includes(a.art)) return true;
  if (b.art.length >= ART_MIN_LEN && a.title.length >= b.art.length && a.title.includes(b.art)) return true;

  return false;
}

export interface TrackDedupIndex {
  has(track: YTMTrack): boolean;
  add(track: YTMTrack): void;
}

/**
 * Индекс дедупликации: O(1) проверка по id и точной сигнатуре, 5-секундные корзины длительности
 * для нечеткого сравнения. Сохраняет точную семантику isDuplicateTrack за доли миллисекунды.
 */
export function createTrackDedupIndex(tracks?: readonly YTMTrack[]): TrackDedupIndex {
  const ids = new Set<string>();
  const sigs = new Set<string>();
  const buckets = new Map<number, PreparedTrackDedup[]>();
  const unknownDur: PreparedTrackDedup[] = [];
  const allNonEmpty: PreparedTrackDedup[] = [];

  const addPrepared = (p: PreparedTrackDedup) => {
    if (p.id) ids.add(p.id);
    sigs.add(p.sig);
    if (p.sig.length === 0) return;
    allNonEmpty.push(p);
    if (p.durSec > 0) {
      const bin = Math.floor(p.durSec / DUR_TOLERANCE_SEC);
      let list = buckets.get(bin);
      if (!list) {
        list = [];
        buckets.set(bin, list);
      }
      list.push(p);
    } else {
      unknownDur.push(p);
    }
  };

  if (tracks) {
    for (let i = 0; i < tracks.length; i++) {
      addPrepared(prepareTrackDedup(tracks[i]));
    }
  }

  const checkList = (p: PreparedTrackDedup, list: PreparedTrackDedup[] | undefined): boolean => {
    if (!list) return false;
    for (let i = 0; i < list.length; i++) {
      if (isFuzzyOrArtistDuplicate(p, list[i])) return true;
    }
    return false;
  };

  return {
    add(track: YTMTrack) {
      addPrepared(prepareTrackDedup(track));
    },
    has(track: YTMTrack): boolean {
      if (track.id && ids.has(track.id)) return true;
      const p = prepareTrackDedup(track);
      if (sigs.has(p.sig)) return true;
      if (p.sig.length === 0) return false;

      if (p.durSec > 0) {
        const bin = Math.floor(p.durSec / DUR_TOLERANCE_SEC);
        if (checkList(p, buckets.get(bin))) return true;
        if (checkList(p, buckets.get(bin - 1))) return true;
        if (checkList(p, buckets.get(bin + 1))) return true;
        return checkList(p, unknownDur);
      }

      // При неизвестной длительности запроса он может совпасть с треком из любой корзины.
      return checkList(p, allNonEmpty);
    },
  };
}

const queueDedupCache = new WeakMap<readonly YTMTrack[], TrackDedupIndex>();

export function getQueueDedupIndex(tracks: readonly YTMTrack[]): TrackDedupIndex {
  let index = queueDedupCache.get(tracks);
  if (!index) {
    index = createTrackDedupIndex(tracks);
    queueDedupCache.set(tracks, index);
  }
  return index;
}

/**
 * Проверяет, являются ли два трека дубликатами (одна и та же песня на разных платформах).
 *
 * Этап 1: точное совпадение id или нормализованных сигнатур (title+artists) -> дубль.
 * Этап 2: нечеткое совпадение >= 85% + длительность +-5 сек -> дубль.
 * Этап 3: заголовок одного трека содержит артистов другого (>= 8 симв.) + длительность +-5 сек -> дубль.
 */
export function isDuplicateTrack(a: YTMTrack, b: YTMTrack): boolean {
  if (a.id && b.id && a.id === b.id) return true;
  const pa = prepareTrackDedup(a);
  const pb = prepareTrackDedup(b);
  if (pa.sig === pb.sig) return true;
  if (pa.sig.length === 0 || pb.sig.length === 0) return false;
  return isFuzzyOrArtistDuplicate(pa, pb);
}

/**
 * Выбирает лучший SC-кандидат под исходный трек по близости длительности.
 * targetSeconds<=0 (длительность неизвестна) → первый результат.
 * Иначе ближайший, но только если |Δ| ≤ toleranceSeconds, иначе null.
 */
export function pickBestScMatch(candidates: YTMTrack[], targetSeconds: number, toleranceSeconds = 15): YTMTrack | null {
  if (candidates.length === 0) return null;
  if (!targetSeconds || targetSeconds <= 0) return candidates[0];
  let best: YTMTrack | null = null;
  let bestDiff = Infinity;
  for (const c of candidates) {
    const diff = Math.abs(durationToSeconds(c.duration) - targetSeconds);
    if (diff < bestDiff) { bestDiff = diff; best = c; }
  }
  return best && bestDiff <= toleranceSeconds ? best : null;
}

export function isSoundCloudEnabled(): boolean {
  return localStorage.getItem('sc-enabled') === 'true';
}

export function setSoundCloudEnabled(value: boolean): void {
  localStorage.setItem('sc-enabled', value ? 'true' : 'false');
  // Мгновенно уведомляем подписчиков (переключатель радио в очереди и т.п.)
  window.dispatchEvent(new CustomEvent('sc-enabled-changed', { detail: { enabled: value } }));
}

// --- SoundCloud авторизация (ручной oauth_token, хранится локально) ---
const SC_TOKEN_KEY = 'sc-oauth-token';
const SC_UID_KEY = 'sc-uid';
const SC_BROWSER_PATH_KEY = 'sc-browser-path';
const SC_LIKE_MODE_KEY = 'sc-like-mode';

export type ScLikeMode = 'electron' | 'legacy';

export function getScLikeMode(): ScLikeMode {
  try {
    return localStorage.getItem(SC_LIKE_MODE_KEY) === 'legacy' ? 'legacy' : 'electron';
  } catch {
    return 'electron';
  }
}

export function setScLikeMode(mode: ScLikeMode): void {
  localStorage.setItem(SC_LIKE_MODE_KEY, mode);
}

// Путь к Chromium-браузеру для клика лайка (nodriver). Пусто = автоопределение (дефолтный браузер системы / Chrome).
export function getScBrowserPath(): string {
  return localStorage.getItem(SC_BROWSER_PATH_KEY) || '';
}

export function setScBrowserPath(path: string): void {
  if (path) localStorage.setItem(SC_BROWSER_PATH_KEY, path);
  else localStorage.removeItem(SC_BROWSER_PATH_KEY);
}

let scClientId = '';
let scAppVersion = '';
let scAuthGeneration = 0;
let scRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let lastBgRefreshFailAt = 0;
const SC_BG_REFRESH_RETRY_COOLDOWN_MS = 60_000;
const MAX_TIMEOUT_MS = 2_000_000_000;

type ScInternalRefreshResult =
  | { status: 'ok'; token: string }
  | { status: 'no_refresh_token' | 'unauthorized' | 'cancelled' | 'error' };

let scRefreshInFlight: Promise<ScInternalRefreshResult> | null = null;
const scDisconnectHooks = new Set<() => void>();

export function registerScDisconnectHook(hook: () => void): () => void {
  scDisconnectHooks.add(hook);
  return () => { scDisconnectHooks.delete(hook); };
}

export interface ScAccount { id: number; username: string; avatarUrl: string; permalinkUrl: string; }

export function getScToken(): string {
  return localStorage.getItem(SC_TOKEN_KEY) || '';
}

export function getScUid(): string {
  return localStorage.getItem(SC_UID_KEY) || '';
}

function clearScRefreshTimer(): void {
  if (scRefreshTimer !== null) {
    clearTimeout(scRefreshTimer);
    scRefreshTimer = null;
  }
}

function scheduleProactiveScRefresh(token: string): void {
  clearScRefreshTimer();
  if (typeof window === 'undefined') return;
  const bridge = (window as any).bridge;
  if (typeof bridge?.scRefresh !== 'function') return;
  const delayMs = getScTokenRefreshDelayMs(token, SC_PROACTIVE_REFRESH_LEEWAY_SEC);
  if (delayMs === null || delayMs <= 0) return;
  const scheduledGen = scAuthGeneration;
  scRefreshTimer = setTimeout(() => {
    scRefreshTimer = null;
    if (scAuthGeneration !== scheduledGen || !getScToken()) return;
    void refreshScTokenInternal(getScToken());
  }, Math.min(delayMs, MAX_TIMEOUT_MS));
}

function applyRefreshedScToken(token: string, expectedGen: number): boolean {
  if (!token || scAuthGeneration !== expectedGen || !getScToken()) return false;
  localStorage.setItem(SC_TOKEN_KEY, token);
  scheduleProactiveScRefresh(token);
  return true;
}

// Единая точка обновления oauth_token в рендерере: дедуплицирует параллельные вызовы и защищает от гонки с scDisconnect.
async function refreshScTokenInternal(
  failedToken?: string,
  opts?: { force?: boolean }
): Promise<ScInternalRefreshResult> {
  const startGen = scAuthGeneration;
  const current = getScToken();
  if (!current) return { status: 'no_refresh_token' };

  const bridge = (window as any).bridge;
  if (typeof bridge?.scRefresh !== 'function') return { status: 'no_refresh_token' };

  if (scRefreshInFlight) {
    const shared = await scRefreshInFlight;
    if (scAuthGeneration !== startGen) return { status: 'cancelled' };
    if (!(opts?.force && shared.status === 'ok' && failedToken && shared.token === failedToken)) {
      return shared;
    }
  }

  const latestCurrent = getScToken();
  if (!latestCurrent || scAuthGeneration !== startGen) return { status: 'cancelled' };
  if (failedToken && latestCurrent !== failedToken && !isScTokenExpiringSoon(latestCurrent, 30)) {
    return { status: 'ok', token: latestCurrent };
  }

  let run: Promise<ScInternalRefreshResult> | null = null;
  run = (async (): Promise<ScInternalRefreshResult> => {
    try {
      const res = await bridge.scRefresh({
        failedToken: failedToken || latestCurrent,
        clientId: scClientId || undefined,
        force: opts?.force,
      });
      if (scAuthGeneration !== startGen) {
        return { status: 'cancelled' };
      }
      if (res?.status === 'ok' && res.token) {
        applyRefreshedScToken(res.token, startGen);
        lastBgRefreshFailAt = 0;
        return { status: 'ok', token: res.token as string };
      }
      if (res?.status === 'no_refresh_token' || res?.status === 'unauthorized' || res?.status === 'cancelled') {
        lastBgRefreshFailAt = Date.now();
        return { status: res.status };
      }
      lastBgRefreshFailAt = Date.now();
      return { status: 'error' };
    } catch (e) {
      console.warn('[soundcloud] scRefresh failed', e);
      lastBgRefreshFailAt = Date.now();
      return { status: 'error' };
    } finally {
      if (scRefreshInFlight === run) {
        scRefreshInFlight = null;
      }
    }
  })();

  scRefreshInFlight = run;
  return run;
}

export async function refreshScToken(force = false): Promise<string | null> {
  const res = await refreshScTokenInternal(getScToken(), { force });
  return res.status === 'ok' ? res.token : null;
}

// Возвращает актуальный oauth_token и метаданные, была ли уже попытка проактивного обновления.
async function getValidScTokenWithMeta(): Promise<{
  token: string;
  attemptedRefresh: boolean;
  refreshStatus?: ScInternalRefreshResult['status'];
}> {
  const token = getScToken();
  if (!token) return { token: '', attemptedRefresh: false };
  if (isScTokenExpiringSoon(token, SC_PROACTIVE_REFRESH_LEEWAY_SEC)) {
    const ref = await refreshScTokenInternal(token);
    if (ref.status === 'ok') {
      return { token: ref.token, attemptedRefresh: true, refreshStatus: 'ok' };
    }
    if (ref.status === 'cancelled') {
      return { token: '', attemptedRefresh: true, refreshStatus: 'cancelled' };
    }
    return { token: getScToken(), attemptedRefresh: true, refreshStatus: ref.status };
  }
  return { token, attemptedRefresh: false };
}

// Обертка для Python SC-команд с автообновлением oauth_token при истечении JWT или 401.
async function scPyCallWithAuth(
  command: string,
  args: Record<string, unknown>,
  opts: { requireAuth?: boolean; fallbackAnonymous?: boolean } = {}
): Promise<any> {
  const startGen = scAuthGeneration;
  const initial = await getValidScTokenWithMeta();
  let token = initial.token;
  if (scAuthGeneration !== startGen) return null;
  if (opts.requireAuth && !token) return null;

  const bridge = (window as any).bridge;
  let res = await bridge.pyCall(command, { ...args, token });
  if (scAuthGeneration !== startGen) return null;

  if (token && res?.status === 'unauthorized') {
    let refStatus = initial.refreshStatus;
    if (!initial.attemptedRefresh) {
      const ref = await refreshScTokenInternal(token, { force: true });
      refStatus = ref.status;
      if (scAuthGeneration !== startGen || !getScToken()) return null;
      if (ref.status === 'ok') {
        token = ref.token;
        res = await bridge.pyCall(command, { ...args, token });
        if (scAuthGeneration !== startGen) return null;
      }
    }
    // Обновляем client_id только если токен не заведомо протухший JWT (иначе это лишний скрапинг soundcloud.com).
    if (
      res?.status === 'unauthorized' &&
      refStatus !== 'unauthorized' &&
      refStatus !== 'cancelled' &&
      !isScTokenExpiringSoon(token, 0)
    ) {
      const { cid } = await ensureScClientId(true);
      if (scAuthGeneration !== startGen || !getScToken()) return null;
      if (cid) {
        res = await bridge.pyCall(command, { ...args, token });
        if (scAuthGeneration !== startGen) return null;
      }
    }
    if (res?.status === 'unauthorized' && opts.fallbackAnonymous) {
      res = await bridge.pyCall(command, { ...args, token: '' });
    }
  }
  return res;
}

function emitScToast(message: string, type: 'error' | 'info' | 'success' = 'error'): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('app-toast', { detail: { message, type } }));
}

// client_id + app_version нужны для API-запросов лайков; берем с бэкенда и кэшируем.
export async function ensureScClientId(force = false): Promise<{ cid: string; appVersion: string }> {
  if (force) {
    scClientId = '';
    scAppVersion = '';
  } else if (scClientId && scAppVersion) {
    return { cid: scClientId, appVersion: scAppVersion };
  }
  try {
    const res = await (window as any).bridge.pyCall('sc_client_id', force ? { force: true } : {});
    if (res?.status === 'ok') { scClientId = res.clientId || ''; scAppVersion = res.appVersion || ''; }
  } catch { /* ignore */ }
  return { cid: scClientId, appVersion: scAppVersion };
}

async function ensureScUid(): Promise<string> {
  const existing = getScUid();
  if (existing) return existing;
  const startGen = scAuthGeneration;
  try {
    const res = await scPyCallWithAuth('sc_me', {}, { requireAuth: true });
    if (scAuthGeneration !== startGen || !isScAuthed()) return '';
    if (res?.status === 'ok' && res.connected && res.id !== undefined && res.id !== null) {
      const uid = String(res.id);
      if (uid) {
        localStorage.setItem(SC_UID_KEY, uid);
        return uid;
      }
    }
  } catch (e) {
    console.warn('[soundcloud] ensureScUid failed', e);
  }
  return '';
}

export type ScWebviewLoginResult =
  | { status: 'ok'; account: ScAccount }
  | { status: 'cancelled' }
  | { status: 'error' };

// Надежный вход: окно SoundCloud (логин + DataDome), забираем oauth_token и валидируем, сохраняя oauth_refresh_token в сессии.
export async function scLoginViaWebviewDetailed(): Promise<ScWebviewLoginResult> {
  try {
    const res = await (window as any).bridge.scLogin();
    if (res?.status === 'cancelled') return { status: 'cancelled' };
    if (res?.status === 'ok' && res.token) {
      const account = await scConnect(res.token, undefined, { syncSession: false });
      return account ? { status: 'ok', account } : { status: 'error' };
    }
  } catch (e) {
    console.warn('[soundcloud] scLoginViaWebview failed', e);
  }
  return { status: 'error' };
}

export async function scLoginViaWebview(): Promise<ScAccount | null> {
  const res = await scLoginViaWebviewDetailed();
  return res.status === 'ok' ? res.account : null;
}

export function isScAuthed(): boolean {
  return !!getScToken();
}

export async function scDisconnect(): Promise<void> {
  scAuthGeneration += 1;
  clearScRefreshTimer();
  scRefreshInFlight = null;
  lastBgRefreshFailAt = 0;

  // Сначала сбрасываем in-flight очередь лайков, чтобы отмененные запросы не делали откат поверх выхода.
  for (const hook of scDisconnectHooks) {
    try { hook(); } catch { /* ignore */ }
  }
  // Удаляем серверные SC-лайки, но сохраняем localOnly
  const all = await likedStore.getAllScTracks();
  const toKeep = all.filter(e => e.localOnly);
  await likedStore.clearScTracks();
  if (toKeep.length > 0) await likedStore.putScTracksBatch(toKeep);
  await likedStore.setScVirtualCount(0);

  localStorage.removeItem(SC_TOKEN_KEY);
  localStorage.removeItem(SC_UID_KEY);
  scClientId = '';
  scAppVersion = '';
  scLikedSet = new Set();
  try { await (window as any).bridge?.scLogout?.(); } catch { /* ignore */ }
}

// Проверяет токен через api-v2 /me (при просроченном oauth_token + валидном oauth_refresh_token пробует обновить).
// При успехе сохраняет токены и возвращает аккаунт.
export async function scConnect(
  token: string,
  refreshToken?: string,
  opts?: { syncSession?: boolean }
): Promise<ScAccount | null> {
  const t = (token || '').trim();
  const rt = (refreshToken || '').trim();
  const syncSession = opts?.syncSession !== false;
  if (!t) return null;

  const bridge = (window as any).bridge;
  try {
    let effectiveToken = t;
    let syncedViaRefresh = false;
    let res = await bridge.pyCall('sc_me', { token: effectiveToken });

    // Если токен не просроченный JWT и sc_me вернул 401, сначала обновляем client_id в Python, чтобы не сжечь refresh_token зря.
    if (res?.status === 'unauthorized' && !isScTokenExpiringSoon(effectiveToken, 0)) {
      const { cid } = await ensureScClientId(true);
      if (cid) {
        res = await bridge.pyCall('sc_me', { token: effectiveToken });
      }
    }

    if (
      res?.status === 'unauthorized' &&
      rt &&
      typeof bridge?.scSetTokens === 'function' &&
      typeof bridge?.scRefresh === 'function'
    ) {
      const seeded = await bridge.scSetTokens({ oauthToken: t, refreshToken: rt });
      if (seeded?.status === 'ok') {
        const ref = await bridge.scRefresh({
          failedToken: t,
          clientId: scClientId || undefined,
          force: true,
        });
        if (ref?.status === 'ok' && ref.token) {
          effectiveToken = ref.token;
          syncedViaRefresh = true;
          res = await bridge.pyCall('sc_me', { token: effectiveToken });
        }
      }
    }

    if (res?.status === 'ok' && res.connected) {
      const prevToken = getScToken();
      if (prevToken && prevToken !== effectiveToken) {
        scAuthGeneration += 1;
      }
      localStorage.setItem(SC_TOKEN_KEY, effectiveToken);
      localStorage.setItem(SC_UID_KEY, String(res.id));
      if (syncSession && !syncedViaRefresh && typeof bridge?.scSetTokens === 'function') {
        try {
          await bridge.scSetTokens({
            oauthToken: effectiveToken,
            ...(rt ? { refreshToken: rt } : {}),
          });
        } catch { /* ignore */ }
      }
      scheduleProactiveScRefresh(effectiveToken);
      loadScLikedIds();
      return { id: res.id, username: res.username || '', avatarUrl: res.avatarUrl || '', permalinkUrl: res.permalinkUrl || '' };
    }
  } catch (e) {
    console.warn('[soundcloud] scConnect failed', e);
  }
  return null;
}

// Перепроверяет уже сохраненный токен с автоматическим refresh (для отображения статуса при открытии настроек).
export async function getScAccount(): Promise<ScAccount | null> {
  if (!getScToken()) return null;
  const startGen = scAuthGeneration;
  try {
    const res = await scPyCallWithAuth('sc_me', {}, { requireAuth: true });
    if (scAuthGeneration !== startGen || !isScAuthed()) return null;
    if (res?.status === 'ok' && res.connected) {
      if (res.id !== undefined && res.id !== null) {
        localStorage.setItem(SC_UID_KEY, String(res.id));
      }
      scheduleProactiveScRefresh(getScToken());
      return { id: res.id, username: res.username || '', avatarUrl: res.avatarUrl || '', permalinkUrl: res.permalinkUrl || '' };
    }
  } catch (e) {
    console.warn('[soundcloud] getScAccount failed', e);
  }
  return null;
}

// --- Лайки на SoundCloud (только в авторизованном режиме) ---
// Множество ID лайкнутых треков - для статуса лайков в радио/поиске.
let scLikedSet = new Set<string>();
let scLocalOnlySet = new Set<string>();

export async function loadScLikedIds(): Promise<void> {
  if (!getScToken()) { scLikedSet = new Set(); return; }
  const startGen = scAuthGeneration;
  try {
    const res = await scPyCallWithAuth('sc_liked_ids', {}, { requireAuth: true });
    if (scAuthGeneration !== startGen || !isScAuthed()) return;
    if (res?.status === 'ok' && Array.isArray(res.ids)) {
      scLikedSet = new Set(res.ids);
      window.dispatchEvent(new CustomEvent('sc-likes-loaded'));
    }
  } catch (e) {
    console.warn('[soundcloud] loadScLikedIds failed', e);
  }
}

// Загружает ID локальных (offline) SC-лайков для isScTrackLiked()
export async function loadScLocalOnlyIds(): Promise<void> {
  try {
    const entries = await likedStore.getAllScTracks();
    scLocalOnlySet = new Set(entries.filter(e => e.localOnly).map(e => e.scId));
  } catch {
    scLocalOnlySet = new Set();
  }
}

// Набор хранит числовые scId лайкнутых треков.
export function isScTrackLiked(scId: string | undefined): boolean {
  return !!scId && (scLikedSet.has(scId) || scLocalOnlySet.has(scId));
}

export function getScLocalOnlyCount(): number {
  return scLocalOnlySet.size;
}

export function setScLikedInMemory(scId: string, liked: boolean): void {
  if (!scId) return;
  if (liked) scLikedSet.add(scId);
  else scLikedSet.delete(scId);
}

// Для использования из scLikedManager (разные модули)
export function addScLocalOnlyId(scId: string): void {
  scLocalOnlySet.add(scId);
}

export function removeScLocalOnlyId(scId: string): void {
  scLocalOnlySet.delete(scId);
}

// Ставит/снимает лайк на SoundCloud через Electron session.fetch() или legacy nodriver.
export async function scSetLiked(scId: string | undefined, scUrl: string | undefined, liked: boolean): Promise<boolean> {
  const startGen = scAuthGeneration;
  const tokenInfo = await getValidScTokenWithMeta();
  let token = tokenInfo.token;
  if (scAuthGeneration !== startGen || !token || !scId) return false;

  if (
    tokenInfo.attemptedRefresh &&
    tokenInfo.refreshStatus === 'unauthorized' &&
    isScTokenExpiringSoon(token, 0)
  ) {
    emitScToast('Сессия SoundCloud истекла. Войдите заново в Настройках', 'error');
    return false;
  }

  const trackUrl = (scUrl && scUrl.startsWith('https://soundcloud.com/'))
    ? scUrl
    : `https://soundcloud.com/tracks/${scId}`;

  const bridge = (window as any).bridge;
  const useLegacy = getScLikeMode() === 'legacy' || typeof bridge?.scLike !== 'function';

  if (useLegacy) {
    let profileDir: string;
    try {
      profileDir = await bridge.getScProfileDir();
    } catch {
      return false;
    }

    let appBounds: { x: number; y: number; width: number; height: number } | null = null;
    try { appBounds = await bridge.winGetBounds(); } catch { /* ignore */ }
    const res = await bridge.pyCall('sc_like_nodriver', {
      scId, url: trackUrl, liked, profileDir, oauthToken: token, appBounds,
      browserPath: getScBrowserPath() || undefined,
    });
    if (res?.status === 'ok') {
      const actualLiked = res.liked === 'liked';
      if (scAuthGeneration === startGen && isScAuthed()) {
        setScLikedInMemory(scId, actualLiked);
      }
      return actualLiked === liked;
    }
    emitScToast(
      res?.message ? `Не удалось поставить лайк SoundCloud: ${res.message}` : 'Не удалось поставить лайк SoundCloud',
      'error',
    );
    return false;
  }

  const uid = await ensureScUid();
  if (scAuthGeneration !== startGen || !isScAuthed()) return false;
  if (!uid) {
    emitScToast('Не удалось определить аккаунт SoundCloud. Войдите заново в Настройках', 'error');
    return false;
  }
  token = getScToken() || token;

  let { cid, appVersion } = await ensureScClientId(false);
  if (scAuthGeneration !== startGen || !isScAuthed()) return false;
  if (!cid) {
    emitScToast('Не удалось получить client_id SoundCloud', 'error');
    return false;
  }

  const invokeScLike = async (
    oauthToken: string,
    clientId: string,
    version: string,
    skipRefresh?: boolean
  ) => bridge.scLike({
    uid,
    scId,
    scUrl: trackUrl,
    liked,
    oauthToken,
    clientId,
    appVersion: version,
    ...(skipRefresh ? { skipRefresh: true } : {}),
  });

  let res: { status?: string; message?: string; refreshedToken?: string } | undefined;
  try {
    res = await invokeScLike(token, cid, appVersion, tokenInfo.attemptedRefresh);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : '';
    emitScToast(
      message ? `Не удалось обновить лайк SoundCloud: ${message}` : 'Не удалось обновить лайк SoundCloud',
      'error',
    );
    return false;
  }

  if (res?.refreshedToken && applyRefreshedScToken(res.refreshedToken, startGen)) {
    token = res.refreshedToken;
  }

  // При 401 один раз принудительно обновляем client_id и повторяем запрос без сброса сессии.
  if (res?.status === 'unauthorized' && scAuthGeneration === startGen && isScAuthed()) {
    const refreshed = await ensureScClientId(true);
    cid = refreshed.cid;
    appVersion = refreshed.appVersion;
    if (cid && scAuthGeneration === startGen && isScAuthed()) {
      try {
        res = await invokeScLike(token, cid, appVersion, true);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : '';
        emitScToast(
          message ? `Не удалось обновить лайк SoundCloud: ${message}` : 'Не удалось обновить лайк SoundCloud',
          'error',
        );
        return false;
      }
      if (res?.refreshedToken && applyRefreshedScToken(res.refreshedToken, startGen)) {
        token = res.refreshedToken;
      }
    }
  }

  if (res?.status === 'ok') {
    if (scAuthGeneration === startGen && isScAuthed()) {
      setScLikedInMemory(scId, liked);
    }
    return true;
  }

  if (res?.status === 'unauthorized') {
    emitScToast('Сессия SoundCloud истекла. Войдите заново в Настройках', 'error');
    return false;
  }

  if (res?.status === 'cancelled') {
    emitScToast('Проверка SoundCloud отменена', 'info');
    return false;
  }

  emitScToast(
    res?.message ? `Не удалось обновить лайк SoundCloud: ${res.message}` : 'Не удалось обновить лайк SoundCloud',
    'error',
  );
  return false;
}

// Открывает Chrome с кастомным профилем, юзер логинится в SC руками,
// забираем oauth_token (и oauth_refresh_token через CDP) и сохраняем.
export async function scEnsureProfile(): Promise<boolean> {
  try {
    const bridge = (window as any).bridge;
    const profileDir = await bridge.getScProfileDir();
    const res = await bridge.pyCall('sc_setup_profile', { profileDir, browserPath: getScBrowserPath() || undefined });
    if (res?.status === 'ok' && res.token) {
      const acc = await scConnect(res.token, res.refreshToken);
      if (acc) return true;
    }
    if (res?.message) {
      window.dispatchEvent(new CustomEvent('app-toast', {
        detail: { message: `Не удалось настроить браузер SoundCloud: ${res.message}`, type: 'error' },
      }));
    }
  } catch (e) {
    console.warn('[soundcloud] profile setup failed', e);
  }
  return false;
}

// При старте подтягиваем SC-лайки и планируем проактивное обновление JWT (если он истекающий).
// Всегда загружаем local-only лайки, даже без SC-авторизации.
// Гард по window: в node-окружении тестов localStorage отсутствует.
if (typeof window !== 'undefined') {
  const initialToken = getScToken();
  if (initialToken) {
    scheduleProactiveScRefresh(initialToken);
    loadScLikedIds();
  }
  loadScLocalOnlyIds();  // always - even without SC auth
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('focus', () => {
      const t = getScToken();
      if (!t || !isScTokenExpiringSoon(t, SC_PROACTIVE_REFRESH_LEEWAY_SEC)) return;
      if (Date.now() - lastBgRefreshFailAt < SC_BG_REFRESH_RETRY_COOLDOWN_MS) return;
      void refreshScTokenInternal(t);
    });
  }
}

export interface ScArtistDetail {
  name: string;
  thumbUrl: string;
  artistPro?: boolean;
  verified?: boolean;
  description?: string;
  followersCount?: number;
  tracksCount?: number;
  tracks: YTMTrack[];
  popular: YTMTrack[];
  albums: ScAlbumResult[];
  playlists: { url: string; title: string; thumbUrl: string; trackCount: number }[];
  related: { id: string; name: string; thumbUrl: string; subscribers?: number }[];
}

// SoundCloud-id это URL профиля/трека; используем как маркер «это SC».
export function isSoundCloudId(id: string | undefined | null): boolean {
  return !!id && id.includes('soundcloud.com');
}

export async function getSoundCloudArtist(url: string): Promise<ScArtistDetail | null> {
  if (!url) return null;
  try {
    const res = await (window as any).bridge.pyCall('get_soundcloud_artist', { url });
    if (res?.status === 'ok' && Array.isArray(res.results)) {
      const tracks = res.results.map((e: ScSearchEntry) => scEntryToTrack(e));
      tracks.forEach((t: YTMTrack) => { if (t.scUrl) registerSoundCloudTrack(t.id, t.scUrl); });
      const popular = (res.popular || []).map((e: ScSearchEntry) => scEntryToTrack(e));
      popular.forEach((t: YTMTrack) => { if (t.scUrl) registerSoundCloudTrack(t.id, t.scUrl); });
      const albums = (res.albums || []).map((a: any) => ({
        id: a.url, title: a.title || 'Unknown', thumbUrl: a.thumbUrl || '',
        artists: [a.artist || ''], source: 'soundcloud' as const,
        year: a.year || undefined,
      }));
      const playlists = (res.playlists || []).map((p: any) => ({
        url: p.url, title: p.title || 'Unknown', thumbUrl: p.thumbUrl || '', trackCount: p.trackCount || 0,
      }));
      const related = (res.related || []).map((r: any) => ({
        id: r.id, name: r.name || 'Unknown', thumbUrl: r.thumbUrl || '', subscribers: r.subscribers || 0,
      }));
      return {
        name: res.name || '',
        thumbUrl: res.thumbUrl || '',
        artistPro: res.artistPro,
        verified: res.verified,
        description: res.description || '',
        followersCount: res.followersCount || 0,
        tracksCount: res.tracksCount || 0,
        tracks,
        popular,
        albums,
        playlists,
        related,
      };
    }
  } catch (e) {
    console.warn('[soundcloud] getSoundCloudArtist failed', e);
  }
  return null;
}

export interface ScArtistResult { id: string; name: string; thumbUrl: string; source: 'soundcloud'; artistPro?: boolean; verified?: boolean; }
export interface ScAlbumResult { id: string; title: string; thumbUrl: string; artists: string[]; artistIds?: string[]; source: 'soundcloud'; year?: string; }
export interface ScAlbumDetail { title: string; thumbUrl: string; artists: string[]; artistIds?: string[]; tracks: YTMTrack[]; }

// Поиск SC-артистов и альбомов (через внутренний api-v2 на бэкенде).
export async function searchSoundCloudExtra(query: string): Promise<{ artists: ScArtistResult[]; albums: ScAlbumResult[] }> {
  if (!query.trim() || !isSoundCloudEnabled()) return { artists: [], albums: [] };
  try {
    const res = await (window as any).bridge.pyCall('search_soundcloud_extra', { query: query.trim() });
    if (res?.status === 'ok') {
      const artists: ScArtistResult[] = (res.artists || []).map((a: any) => ({
        id: a.url, name: a.name || 'Unknown', thumbUrl: a.thumbUrl || '', source: 'soundcloud', artistPro: a.artistPro, verified: a.verified,
      }));
      const albums: ScAlbumResult[] = (res.albums || []).map((a: any) => ({
        id: a.url, title: a.title || 'Unknown', thumbUrl: a.thumbUrl || '',
        artists: a.artist ? [a.artist] : [], artistIds: a.uploaderUrl ? [a.uploaderUrl] : undefined,
        source: 'soundcloud', year: a.year || undefined,
      }));
      return { artists, albums };
    }
  } catch (e) {
    console.warn('[soundcloud] searchSoundCloudExtra failed', e);
  }
  return { artists: [], albums: [] };
}

export async function getSoundCloudAlbum(url: string): Promise<ScAlbumDetail | null> {
  if (!url) return null;
  try {
    const res = await (window as any).bridge.pyCall('get_soundcloud_album', { url });
    if (res?.status === 'ok' && Array.isArray(res.results)) {
      const tracks = res.results.map((e: ScSearchEntry) => scEntryToTrack(e));
      tracks.forEach((t: YTMTrack) => { if (t.scUrl) registerSoundCloudTrack(t.id, t.scUrl); });
      return {
        title: res.title || '', thumbUrl: res.thumbUrl || '',
        artists: res.artist ? [res.artist] : [], artistIds: res.uploaderUrl ? [res.uploaderUrl] : undefined,
        tracks,
      };
    }
  } catch (e) {
    console.warn('[soundcloud] getSoundCloudAlbum failed', e);
  }
  return null;
}

export interface ScPlaylistDetail {
  title: string;
  description: string;
  thumbUrl: string;
  trackCount: number;
  tracks: YTMTrack[];
}

export async function getSoundCloudPlaylist(url: string): Promise<ScPlaylistDetail | null> {
  if (!url) return null;
  try {
    const res = await (window as any).bridge.pyCall('get_soundcloud_playlist', { url });
    if (res?.status === 'ok' && Array.isArray(res.tracks)) {
      const tracks = res.tracks.map((e: ScSearchEntry) => scEntryToTrack(e));
      tracks.forEach((t: YTMTrack) => { if (t.scUrl) registerSoundCloudTrack(t.id, t.scUrl); });
      return {
        title: res.title || '',
        description: res.description || '',
        thumbUrl: res.thumbUrl || '',
        trackCount: res.trackCount || tracks.length,
        tracks,
      };
    }
  } catch (e) {
    console.warn('[soundcloud] getSoundCloudPlaylist failed', e);
  }
  return null;
}

// SC-радио от трека (api-v2 /tracks/{id}/related; с токеном - персонализировано).
export async function getScRecommendations(opts: { scId?: string; url?: string }): Promise<YTMTrack[]> {
  if (!isSoundCloudEnabled()) return [];
  if (!opts.scId && !opts.url) return [];
  try {
    const res = await scPyCallWithAuth(
      'sc_recommendations',
      { scId: opts.scId || '', url: opts.url || '' },
      { fallbackAnonymous: true }
    );
    if (res?.status === 'ok' && Array.isArray(res.results)) {
      const tracks = res.results.map((e: ScSearchEntry) => scEntryToTrack(e));
      tracks.forEach((t: YTMTrack) => { if (t.scUrl) registerSoundCloudTrack(t.id, t.scUrl); });
      return tracks;
    }
  } catch (e) {
    console.warn('[soundcloud] getScRecommendations failed', e);
  }
  return [];
}

// Полная выгрузка лайкнутых SC-треков с временем лайка (null при ошибке/401, чтобы sync не стер зеркало).
export async function getScLikedEntries(): Promise<ScLikedEntry[] | null> {
  if (!getScToken()) return null;
  try {
    const res = await scPyCallWithAuth('sc_liked_tracks', {}, { requireAuth: true });
    if (res?.status === 'ok' && Array.isArray(res.results)) {
      const entries = res.results
        .filter((e: any) => e.scId)
        .map((e: any) => {
          const track = scEntryToTrack(e as ScSearchEntry);
          if (track.scUrl) registerSoundCloudTrack(track.id, track.scUrl);
          tracksStore.upsertTrack(track);
          return { scId: e.scId as string, trackId: track.id, likedAt: Number(e.likedAt) || 0 };
        });
      return entries;
    }
  } catch (e) {
    console.warn('[soundcloud] getScLikedEntries failed', e);
  }
  return null;
}

// Дешево: число SC-лайков + первые id, для сверки без полной загрузки (как virtualCount у YT).
export async function getScLikedMeta(): Promise<{ count: number; headIds: string[] } | null> {
  if (!getScToken()) return null;
  try {
    const res = await scPyCallWithAuth('sc_liked_meta', {}, { requireAuth: true });
    if (res?.status === 'ok') return { count: res.count || 0, headIds: res.headIds || [] };
  } catch (e) {
    console.warn('[soundcloud] getScLikedMeta failed', e);
  }
  return null;
}

export interface ScWaveStation { id: string; title: string; thumbUrl: string; }

// Курируемые жанровые станции SoundCloud (для «Моей волны»).
export async function getScWaveStations(): Promise<ScWaveStation[]> {
  if (!isSoundCloudEnabled()) return [];
  try {
    const res = await scPyCallWithAuth('sc_wave_stations', {}, { fallbackAnonymous: true });
    if (res?.status === 'ok' && Array.isArray(res.stations)) {
      return res.stations.map((s: any) => ({ id: String(s.id), title: s.title || '', thumbUrl: s.thumbUrl || '' }));
    }
  } catch (e) {
    console.warn('[soundcloud] getScWaveStations failed', e);
  }
  return [];
}

// Треки курируемой станции (плейлиста).
export async function getScStationTracks(id: string): Promise<YTMTrack[]> {
  if (!id) return [];
  try {
    const res = await scPyCallWithAuth('sc_station_tracks', { id }, { fallbackAnonymous: true });
    if (res?.status === 'ok' && Array.isArray(res.results)) {
      const tracks = res.results.map((e: ScSearchEntry) => scEntryToTrack(e));
      tracks.forEach((t: YTMTrack) => { if (t.scUrl) registerSoundCloudTrack(t.id, t.scUrl); });
      return tracks;
    }
  } catch (e) {
    console.warn('[soundcloud] getScStationTracks failed', e);
  }
  return [];
}

export async function searchSoundCloud(query: string, limit = 5): Promise<YTMTrack[]> {
  if (!query.trim() || !isSoundCloudEnabled()) return [];
  try {
    const res = await (window as any).bridge.pyCall('search_alternatives', { query: query.trim(), limit });
    if (res?.status === 'ok' && Array.isArray(res.results)) {
      const tracks = res.results.map((e: ScSearchEntry) => scEntryToTrack(e));
      tracks.forEach((t: YTMTrack) => registerSoundCloudTrack(t.id, t.scUrl!));
      return tracks;
    }
  } catch (e) {
    console.warn('[soundcloud] search failed', e);
  }
  return [];
}

export async function resolveScTrack(scUrl: string): Promise<YTMTrack | null> {
  try {
    const res = await (window as any).bridge.pyCall('resolve_sc_track', { url: scUrl });
    if (res?.status === 'ok') {
      const entry: ScSearchEntry = {
        url: scUrl,
        title: res.title || '',
        artist: res.artist || '',
        duration: res.duration || null,
        thumbUrl: res.thumbUrl || '',
        source: 'soundcloud',
        scId: res.scId || '',
        uploaderUrl: res.uploaderUrl || '',
      };
      const track = scEntryToTrack(entry);
      registerSoundCloudTrack(track.id, track.scUrl!);
      return track;
    }
  } catch (e) {
    console.warn('[soundcloud] resolveScTrack failed', e);
  }
  return null;
}
