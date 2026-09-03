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
  // Гейн из Track.normalization (см. python: yandex_track_dict) -- уже готовая
  // нормализация от Яндекса, если есть; null/undefined -> фронт замерит сам через ffmpeg.
  loudness?: number | null;
}

// Yandex-артисты идентифицируются числовым id, который сам по себе не отличим
// от YT channelId/SC url -- префиксуем так же, как yandex-трек id.
export function yandexArtistId(rawId: string | number): string {
  return `yandex:${rawId}`;
}

export function isYandexArtistId(id: string | undefined | null): boolean {
  return !!id && id.startsWith('yandex:');
}

// Аналогично артистам: raw album/playlist id от Яндекса неотличим от чужого
// (числовой, как у SC), поэтому под навигацию (onSelectAlbum/onSelectPlaylist)
// кладём префиксованный id, а не сырой.
export function yandexAlbumRouteId(rawId: string | number): string {
  return `yandex:${rawId}`;
}

export function isYandexAlbumRouteId(id: string | undefined | null): boolean {
  return !!id && id.startsWith('yandex:');
}

// Плейлист Яндекса адресуется парой (kind, ownerId) -- ownerId нужен, когда
// плейлист не свой (например с карточки артиста), иначе users_playlists()
// на бэкенде ищет его у текущего залогиненного пользователя и не находит.
export function yandexPlaylistRouteId(ownerId: string | number, kind: string | number): string {
  return `yandex:${ownerId}:${kind}`;
}

export function isYandexPlaylistRouteId(id: string | undefined | null): boolean {
  return !!id && id.startsWith('yandex:') && id.split(':').length === 3;
}

export function yandexEntryToTrack(entry: YandexSearchEntry): YTMTrack {
  // Регистрируем сразу здесь -- единая точка регистрации вместо разброса
  // registerYandexTrack(...) по каждому вызывающему коду (легко забыть в новом месте).
  registerYandexTrack(`yandex:${entry.yandexId}`, entry.yandexId, entry.loudness ?? undefined);
  return {
    id: `yandex:${entry.yandexId}`,
    title: entry.title || 'Unknown',
    artists: entry.artist ? [entry.artist] : [],
    artistIds: entry.artistId ? [yandexArtistId(entry.artistId)] : undefined,
    album: '',
    albumId: entry.albumId ? yandexAlbumRouteId(entry.albumId) : undefined,
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

// Треки, уже построенные до того как лайки подгрузились (поиск/волна/артист,
// в любом месте кроме Liked Songs), никак не подписаны на пересчёт -- шлём
// им точечно track-like-updated (тот же ивент, что на ручной лайк), чтобы
// сердечко в уже отрисованных строках стало актуальным без перезахода.
function broadcastYandexLikes(ids: Iterable<string>): void {
  for (const id of ids) {
    window.dispatchEvent(new CustomEvent('track-like-updated', {
      detail: { id: `yandex:${id}`, status: 'success', likeStatus: 'LIKE' },
    }));
  }
}

export async function loadYandexLikedIds(): Promise<void> {
  try {
    const res = await (window as any).bridge.pyCall('yandex_liked_tracks', {});
    if (res?.status === 'ok' && Array.isArray(res.results)) {
      yandexLikedSet = new Set(res.results.map((e: YandexSearchEntry) => e.yandexId));
      window.dispatchEvent(new CustomEvent('yandex-likes-loaded'));
      broadcastYandexLikes(yandexLikedSet);
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
      broadcastYandexLikes(yandexLikedSet);
      const entries: YandexLikedEntry[] = res.results.map((e: YandexSearchEntry) => {
        const track = yandexEntryToTrack(e);
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

export interface YandexWaveStation { id: string; title: string; thumbUrl: string; }

// Персональный дашборд станций (как на странице радио в Яндекс.Музыке) --
// "Моя волна" + жанровые/настроенческие станции, а не одна фиксированная.
export async function getYandexWaveStations(): Promise<YandexWaveStation[]> {
  if (!isYandexEnabled()) return [];
  try {
    const res = await (window as any).bridge.pyCall('yandex_wave_stations', {});
    if (res?.status === 'ok' && Array.isArray(res.stations)) {
      return res.stations.map((s: any) => ({ id: s.id, title: s.title || '', thumbUrl: s.thumbUrl || '' }));
    }
  } catch (e) {
    console.warn('[yandex] getYandexWaveStations failed', e);
  }
  return [];
}

// station — id вида "user:onyourwave" / "genre:rock" (см. getYandexWaveStations).
export async function getYandexWaveTracks(station: string = 'user:onyourwave'): Promise<YTMTrack[]> {
  if (!isYandexEnabled()) return [];
  try {
    const res = await (window as any).bridge.pyCall('yandex_wave_tracks', { station });
    if (res?.status === 'ok' && Array.isArray(res.results)) {
      return res.results.map((e: YandexSearchEntry) => yandexEntryToTrack(e));
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
      return res.results.map((e: YandexSearchEntry) => yandexEntryToTrack(e));
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
      return res.results.slice(0, limit).map((e: YandexSearchEntry) => yandexEntryToTrack(e));
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
      return { title: res.title || '', thumbUrl: res.thumbUrl || '', tracks };
    }
  } catch (e) {
    console.warn('[yandex] getYandexAlbumTracks failed', e);
  }
  return null;
}

export interface YandexPlaylistResult {
  id: string;
  title: string;
  thumbUrl: string;
  trackCount?: number;
  ownerId?: string;
}

// Собственные плейлисты пользователя (для "Коллекций" в режиме Yandex).
export async function getYandexPlaylists(): Promise<YandexPlaylistResult[]> {
  if (!isYandexEnabled()) return [];
  try {
    const res = await (window as any).bridge.pyCall('yandex_playlists', {});
    if (res?.status === 'ok' && Array.isArray(res.results)) return res.results;
  } catch (e) {
    console.warn('[yandex] getYandexPlaylists failed', e);
  }
  return [];
}

export interface YandexPlaylistDetail {
  title: string;
  tracks: YTMTrack[];
}

export async function getYandexPlaylistTracks(kind: string, ownerId?: string): Promise<YandexPlaylistDetail | null> {
  if (!kind) return null;
  try {
    const res = await (window as any).bridge.pyCall('yandex_playlist_tracks', { kind, ownerId });
    if (res?.status === 'ok' && Array.isArray(res.results)) {
      const tracks = res.results.map((e: YandexSearchEntry) => yandexEntryToTrack(e));
      return { title: res.title || '', tracks };
    }
  } catch (e) {
    console.warn('[yandex] getYandexPlaylistTracks failed', e);
  }
  return null;
}

export interface YandexArtistDetail {
  name: string;
  thumbUrl: string;
  topSongs: YTMTrack[];
  monthlyListeners?: number;
  playlists: YandexPlaylistResult[];
}

// artistId — префиксованный (yandex:12345, см. yandexArtistId/isYandexArtistId).
export async function getYandexArtist(artistId: string): Promise<YandexArtistDetail | null> {
  const rawId = artistId.replace(/^yandex:/, '');
  if (!rawId) return null;
  try {
    const res = await (window as any).bridge.pyCall('yandex_artist', { artistId: rawId });
    if (res?.status === 'ok') {
      const tracks = (res.tracks || []).map((e: YandexSearchEntry) => yandexEntryToTrack(e));
      const playlists: YandexPlaylistResult[] = (res.playlists || []).map((p: any) => ({
        id: yandexPlaylistRouteId(p.ownerId || '', p.id),
        title: p.title || '',
        thumbUrl: p.thumbUrl || '',
        trackCount: p.trackCount,
      }));
      return {
        name: res.name || '',
        thumbUrl: res.thumbUrl || '',
        topSongs: tracks,
        monthlyListeners: res.monthlyListeners ?? undefined,
        playlists,
      };
    }
  } catch (e) {
    console.warn('[yandex] getYandexArtist failed', e);
  }
  return null;
}
