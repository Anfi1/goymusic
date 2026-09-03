import type { YTMTrack } from './yt';
import type { YandexLikedEntry } from './likedStore';
import { likedStore } from './likedStore';
import { tracksStore } from './tracks';
import { registerYandexTrack } from './stream';

export interface YandexSearchEntry {
  yandexId: string;
  title: string;
  artist: string;
  artistId?: string | null;
  duration: number;
  thumbUrl: string;
  source: string;
  albumId?: string | null;
  url?: string;
  likedAt?: number;
}

// Yandex-артисты идентифицируются числовым id, который сам по себе не отличим
// от YT channelId/SC url -- префиксуем так же, как yandex-трек id.
export function yandexArtistId(rawId: string | number): string {
  return `yandex:${rawId}`;
}

export function isYandexArtistId(id: string | undefined | null): boolean {
  return !!id && id.startsWith('yandex:');
}

export function yandexEntryToTrack(entry: YandexSearchEntry): YTMTrack {
  return {
    id: `yandex:${entry.yandexId}`,
    title: entry.title || 'Unknown',
    artists: entry.artist ? [entry.artist] : [],
    artistIds: entry.artistId ? [yandexArtistId(entry.artistId)] : undefined,
    album: '',
    albumId: entry.albumId || undefined,
    duration: formatYandexDuration(entry.duration),
    thumbUrl: entry.thumbUrl || '',
    source: 'yandex',
    yandexId: entry.yandexId,
    yandexAlbumId: entry.albumId || undefined,
    isAvailable: true,
    likeStatus: isYandexTrackLiked(entry.yandexId) ? 'LIKE' : undefined,
  };
}

export function formatYandexDuration(seconds: number | null | undefined): string {
  const s = Math.max(0, Math.floor(seconds || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}

export function isYandexEnabled(): boolean {
  return localStorage.getItem('yandex-enabled') === 'true';
}

export function setYandexEnabled(value: boolean): void {
  localStorage.setItem('yandex-enabled', value ? 'true' : 'false');
  window.dispatchEvent(new CustomEvent('yandex-enabled-changed', { detail: { enabled: value } }));
}

// --- OAuth Device Flow ---
// Токен хранится на бэкенде (yandex.json, как oauth.json/browser.json для YT) --
// в отличие от SC здесь не нужен per-call токен из localStorage.

export interface YandexDeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresIn: number;
  interval: number;
}

export async function yandexAuthStart(): Promise<YandexDeviceCode | null> {
  try {
    const res = await (window as any).bridge.pyCall('yandex_auth_start', {});
    if (res?.status === 'ok') {
      return {
        deviceCode: res.deviceCode,
        userCode: res.userCode,
        verificationUrl: res.verificationUrl,
        expiresIn: res.expiresIn,
        interval: res.interval,
      };
    }
  } catch (e) {
    console.warn('[yandex] yandexAuthStart failed', e);
  }
  return null;
}

export type YandexAuthPollResult = { status: 'ok'; login: string } | { status: 'pending' } | { status: 'error'; message: string };

export async function yandexAuthPoll(deviceCode: string): Promise<YandexAuthPollResult> {
  try {
    const res = await (window as any).bridge.pyCall('yandex_auth_poll', { deviceCode });
    if (res?.status === 'ok') {
      loadYandexLikedIds();
      return { status: 'ok', login: res.login || '' };
    }
    if (res?.status === 'pending') return { status: 'pending' };
    return { status: 'error', message: res?.message || 'Unknown error' };
  } catch (e: any) {
    return { status: 'error', message: e?.message || String(e) };
  }
}

export async function yandexAuthStatus(): Promise<{ connected: boolean; login?: string }> {
  try {
    const res = await (window as any).bridge.pyCall('yandex_auth_status', {});
    if (res?.status === 'ok') return { connected: !!res.connected, login: res.login || '' };
  } catch (e) {
    console.warn('[yandex] yandexAuthStatus failed', e);
  }
  return { connected: false };
}

export async function yandexLogout(): Promise<void> {
  try {
    await (window as any).bridge.pyCall('yandex_logout', {});
  } catch (e) {
    console.warn('[yandex] yandexLogout failed', e);
  }
  await likedStore.replaceYandexTracks([]);
  yandexLikedSet = new Set();
}

// --- Лайки (полностью серверные -- токен уже на бэкенде, offline-очередь как у SC не нужна) ---
let yandexLikedSet = new Set<string>();

export async function loadYandexLikedIds(): Promise<void> {
  try {
    const res = await (window as any).bridge.pyCall('yandex_liked_tracks', {});
    if (res?.status === 'ok' && Array.isArray(res.results)) {
      yandexLikedSet = new Set(res.results.map((e: YandexSearchEntry) => e.yandexId));
      window.dispatchEvent(new CustomEvent('yandex-likes-loaded'));
    }
  } catch (e) {
    console.warn('[yandex] loadYandexLikedIds failed', e);
  }
}

export function isYandexTrackLiked(yandexId: string | undefined): boolean {
  return !!yandexId && yandexLikedSet.has(yandexId);
}

export async function yandexSetLiked(yandexId: string | undefined, liked: boolean): Promise<boolean> {
  if (!yandexId) return false;
  try {
    const res = await (window as any).bridge.pyCall('yandex_set_liked', { yandexId, liked });
    if (res?.status === 'ok') {
      if (liked) yandexLikedSet.add(yandexId); else yandexLikedSet.delete(yandexId);
      return true;
    }
    window.dispatchEvent(new CustomEvent('app-toast', {
      detail: { message: res?.message ? `Не удалось поставить лайк Yandex Music: ${res.message}` : 'Не удалось поставить лайк Yandex Music', type: 'error' },
    }));
  } catch (e) {
    console.warn('[yandex] yandexSetLiked failed', e);
  }
  return false;
}

// Полная выгрузка лайкнутых Yandex-треков с бэкенда + запись в локальный кэш
// (likedStore.yandex_liked) -- чтобы Liked Songs могла показать их сразу
// при следующем открытии, не дожидаясь сети.
export async function syncYandexLikedTracks(): Promise<YandexLikedEntry[]> {
  try {
    const res = await (window as any).bridge.pyCall('yandex_liked_tracks', {});
    if (res?.status === 'ok' && Array.isArray(res.results)) {
      yandexLikedSet = new Set(res.results.map((e: YandexSearchEntry) => e.yandexId));
      const entries: YandexLikedEntry[] = res.results.map((e: YandexSearchEntry) => {
        const track = yandexEntryToTrack(e);
        registerYandexTrack(track.id, e.yandexId);
        tracksStore.upsertTrack(track);
        return { yandexId: e.yandexId, trackId: track.id, likedAt: Number(e.likedAt) || 0 };
      });
      await likedStore.replaceYandexTracks(entries);
      return entries;
    }
  } catch (e) {
    console.warn('[yandex] syncYandexLikedTracks failed', e);
  }
  return [];
}

// Быстрое чтение уже закэшированных лайков (без сетевого запроса) — для мгновенного
// отображения при открытии Liked Songs, пока syncYandexLikedTracks идёт в фоне.
export async function getCachedYandexLikedTracks(): Promise<YTMTrack[]> {
  const entries = await likedStore.getAllYandexTracks();
  const hydrated = await likedStore.hydrateYandexTracks(entries);
  return hydrated.map(h => h.track);
}

// При старте подтягиваем статус лайков, если интеграция включена (чтобы иконка лайка была верной сразу).
if (typeof window !== 'undefined' && isYandexEnabled()) {
  loadYandexLikedIds();
}

// --- "Моя волна" / радио / поиск / новинки ---

export async function getYandexWaveTracks(): Promise<YTMTrack[]> {
  if (!isYandexEnabled()) return [];
  try {
    const res = await (window as any).bridge.pyCall('yandex_wave_tracks', {});
    if (res?.status === 'ok' && Array.isArray(res.results)) {
      const tracks = res.results.map((e: YandexSearchEntry) => yandexEntryToTrack(e));
      tracks.forEach((t: YTMTrack) => { if (t.yandexId) registerYandexTrack(t.id, t.yandexId); });
      return tracks;
    }
  } catch (e) {
    console.warn('[yandex] getYandexWaveTracks failed', e);
  }
  return [];
}

export async function getYandexRecommendations(yandexId: string | undefined): Promise<YTMTrack[]> {
  if (!isYandexEnabled() || !yandexId) return [];
  try {
    const res = await (window as any).bridge.pyCall('yandex_recommendations', { yandexId });
    if (res?.status === 'ok' && Array.isArray(res.results)) {
      const tracks = res.results.map((e: YandexSearchEntry) => yandexEntryToTrack(e));
      tracks.forEach((t: YTMTrack) => { if (t.yandexId) registerYandexTrack(t.id, t.yandexId); });
      return tracks;
    }
  } catch (e) {
    console.warn('[yandex] getYandexRecommendations failed', e);
  }
  return [];
}

export async function searchYandex(query: string, limit = 25): Promise<YTMTrack[]> {
  if (!query.trim() || !isYandexEnabled()) return [];
  try {
    const res = await (window as any).bridge.pyCall('yandex_search', { query: query.trim() });
    if (res?.status === 'ok' && Array.isArray(res.results)) {
      const tracks = res.results.slice(0, limit).map((e: YandexSearchEntry) => yandexEntryToTrack(e));
      tracks.forEach((t: YTMTrack) => { if (t.yandexId) registerYandexTrack(t.id, t.yandexId); });
      return tracks;
    }
  } catch (e) {
    console.warn('[yandex] searchYandex failed', e);
  }
  return [];
}

export interface YandexAlbumResult {
  albumId: string;
  title: string;
  artist: string;
  thumbUrl: string;
  year?: number;
  trackCount?: number;
}

export async function getYandexNewReleases(): Promise<YandexAlbumResult[]> {
  if (!isYandexEnabled()) return [];
  try {
    const res = await (window as any).bridge.pyCall('yandex_new_releases', {});
    if (res?.status === 'ok' && Array.isArray(res.results)) return res.results;
  } catch (e) {
    console.warn('[yandex] getYandexNewReleases failed', e);
  }
  return [];
}

export interface YandexAlbumDetail {
  title: string;
  thumbUrl: string;
  tracks: YTMTrack[];
}

export async function getYandexAlbumTracks(albumId: string): Promise<YandexAlbumDetail | null> {
  if (!albumId) return null;
  try {
    const res = await (window as any).bridge.pyCall('yandex_album_tracks', { albumId });
    if (res?.status === 'ok' && Array.isArray(res.results)) {
      const tracks = res.results.map((e: YandexSearchEntry) => yandexEntryToTrack(e));
      tracks.forEach((t: YTMTrack) => { if (t.yandexId) registerYandexTrack(t.id, t.yandexId); });
      return { title: res.title || '', thumbUrl: res.thumbUrl || '', tracks };
    }
  } catch (e) {
    console.warn('[yandex] getYandexAlbumTracks failed', e);
  }
  return null;
}

export interface YandexArtistDetail {
  name: string;
  thumbUrl: string;
  topSongs: YTMTrack[];
}

// artistId — префиксованный (yandex:12345, см. yandexArtistId/isYandexArtistId).
export async function getYandexArtist(artistId: string): Promise<YandexArtistDetail | null> {
  const rawId = artistId.replace(/^yandex:/, '');
  if (!rawId) return null;
  try {
    const res = await (window as any).bridge.pyCall('yandex_artist', { artistId: rawId });
    if (res?.status === 'ok') {
      const tracks = (res.tracks || []).map((e: YandexSearchEntry) => yandexEntryToTrack(e));
      tracks.forEach((t: YTMTrack) => { if (t.yandexId) registerYandexTrack(t.id, t.yandexId); });
      return { name: res.name || '', thumbUrl: res.thumbUrl || '', topSongs: tracks };
    }
  } catch (e) {
    console.warn('[yandex] getYandexArtist failed', e);
  }
  return null;
}
