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
  artists?: string[];
  artistIds?: string[];
  duration: number;
  thumbUrl: string;
  source: string;
  album?: string;
  albumId?: string | null;
  url?: string;
  // Бэкенд отдаёт ISO-строку ("2026-09-03T03:54:58+00:00"); number -- на случай старых данных.
  likedAt?: string | number;
  // Гейн из Track.normalization (см. python: yandex_track_dict) -- уже готовая
  // нормализация от Яндекса, если есть; null/undefined -> фронт замерит сам через ffmpeg.
  loudness?: number | null;
  // Признак популярного трека (молния, как в Яндекс.Музыке).
  best?: boolean;
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
    artists: entry.artists?.length ? entry.artists : (entry.artist ? [entry.artist] : []),
    artistIds: entry.artistIds?.length ? entry.artistIds.map(id => yandexArtistId(id)) : (entry.artistId ? [yandexArtistId(entry.artistId)] : undefined),
    album: entry.album || '',
    albumId: entry.albumId ? yandexAlbumRouteId(entry.albumId) : undefined,
    duration: formatYandexDuration(entry.duration),
    thumbUrl: entry.thumbUrl || '',
    source: 'yandex',
    yandexId: entry.yandexId,
    yandexAlbumId: entry.albumId || undefined,
    isAvailable: true,
    likeStatus: isYandexTrackLiked(entry.yandexId) ? 'LIKE' : undefined,
    best: entry.best === true ? true : undefined,
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
      const tracks: YTMTrack[] = [];
      const entries: YandexLikedEntry[] = res.results.map((e: YandexSearchEntry) => {
        const track = yandexEntryToTrack(e);
        tracks.push(track);
        // likedAt приходит ISO-строкой ("2026-09-03T03:54:58+00:00"), а не числом:
        // через Number() весь список получал 0 и терял сортировку по дате лайка.
        const at = typeof e.likedAt === 'number' ? e.likedAt : Date.parse(e.likedAt || '');
        return { yandexId: e.yandexId, trackId: track.id, likedAt: Number.isFinite(at) ? at : 0 };
      });
      // Батчем и с await: раньше это были сотни независимых транзакций без ожидания,
      // и hydrateYandexTracks успевал прочитать пустой tracksStore -- лайки Яндекса
      // отфильтровывались подчистую и вкладка лайков оказывалась пустой.
      await tracksStore.upsertTracksBatch(tracks);
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
  // likedAt тянем на сам трек: вкладка лайков сливает YouTube и Яндекс в один
  // список и сортирует по дате лайка, иначе яндексовые уезжают в самый конец.
  return hydrated.map(h => ({ ...h.track, likedAt: h.likedAt }));
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
// queue -- yandexId последнего проигранного трека станции: rotor отдаёт по 5 треков и
// продолжает поток от него. batches склеивает несколько порций за один вызов.
export async function getYandexWaveTracks(
  station: string = 'user:onyourwave',
  queue?: string,
  batches?: number,
): Promise<YTMTrack[]> {
  if (!isYandexEnabled()) return [];
  try {
    const res = await (window as any).bridge.pyCall('yandex_wave_tracks', { station, queue, batches });
    if (res?.status === 'ok' && Array.isArray(res.results)) {
      if (res.batchId) waveBatchIds.set(station, res.batchId);
      return res.results.map((e: YandexSearchEntry) => yandexEntryToTrack(e));
    }
  } catch (e) {
    console.warn('[yandex] getYandexWaveTracks failed', e);
  }
  return [];
}

// batch-id последней выданной порции станции. Яндекс ждёт его в feedback'е, а таскать
// его через плеер и MyWaveView ради одной активной станции незачем.
const waveBatchIds = new Map<string, string>();

export type YandexRotorEvent = 'radioStarted' | 'trackStarted' | 'trackFinished' | 'skip';

// Обратная связь станции. Яндекс двигает цепочку треков только по ней: без feedback'а
// следующий rotor_station_tracks возвращает почти ту же порцию, а волна не учится.
export async function yandexRotorFeedback(
  station: string,
  type: YandexRotorEvent,
  yandexId?: string,
  played?: number,
): Promise<void> {
  if (!isYandexEnabled() || !station) return;
  try {
    await (window as any).bridge.pyCall('yandex_rotor_feedback', {
      station,
      type,
      yandexId,
      played: played !== undefined ? Math.max(0, Math.round(played)) : undefined,
      batchId: waveBatchIds.get(station),
    });
  } catch (e) {
    console.warn('[yandex] rotor feedback failed', type, e);
  }
}

// /play-audio -- история прослушиваний и счётчики на стороне Яндекса.
export async function yandexPlayAudio(opts: {
  yandexId: string;
  albumId?: string;
  playlistId?: string;
  duration: number;
  played: number;
  endPosition: number;
}): Promise<void> {
  if (!isYandexEnabled() || !opts.yandexId) return;
  try {
    await (window as any).bridge.pyCall('yandex_play_audio', {
      yandexId: opts.yandexId,
      albumId: opts.albumId || '',
      playlistId: opts.playlistId,
      duration: Math.max(0, Math.round(opts.duration)),
      played: Math.max(0, Math.round(opts.played)),
      endPosition: Math.max(0, Math.round(opts.endPosition)),
    });
  } catch (e) {
    console.warn('[yandex] play-audio failed', e);
  }
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
  artists?: string[];
  artistIds?: string[];
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
  // SINGLE / EP / COMPILATION / ALBUM -- как метит сам Яндекс, а не всегда "альбом".
  albumType?: string;
  thumbUrl: string;
  artist?: string;
  artistId?: string;
  artists?: string[];
  artistIds?: string[];
  year?: number;
  liked?: boolean;
  tracks: YTMTrack[];
}

export async function getYandexAlbumTracks(albumId: string): Promise<YandexAlbumDetail | null> {
  if (!albumId) return null;
  try {
    const res = await (window as any).bridge.pyCall('yandex_album_tracks', { albumId });
    if (res?.status === 'ok' && Array.isArray(res.results)) {
      const tracks = res.results.map((e: YandexSearchEntry) => yandexEntryToTrack(e));
      return {
        title: res.title || '',
        albumType: res.albumType || 'ALBUM',
        thumbUrl: res.thumbUrl || '',
        artist: res.artist || undefined,
        artistId: res.artistId ? yandexArtistId(res.artistId) : undefined,
        artists: res.artists || undefined,
        artistIds: res.artistIds?.map((id: string) => yandexArtistId(id)) || undefined,
        year: res.year ?? undefined,
        liked: res.liked === true,
        tracks,
      };
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

// Лайкнутые альбомы и артисты Яндекса -- вкладки Albums/Artists в Collection, чтобы
// в режиме Яндекса библиотека была своей целиком, а не только плейлистами.
export interface YandexLibraryAlbum {
  id: string;
  title: string;
  thumbUrl: string;
  artist: string;
  artistIds: string[];
  year?: number;
  trackCount?: number;
}

export interface YandexLibraryArtist {
  id: string;
  name: string;
  thumbUrl: string;
}

export async function getYandexLikedAlbums(): Promise<YandexLibraryAlbum[]> {
  if (!isYandexEnabled()) return [];
  try {
    const res = await (window as any).bridge.pyCall('yandex_liked_albums', {});
    if (res?.status === 'ok' && Array.isArray(res.results)) {
      return res.results.map((a: any) => ({
        id: yandexAlbumRouteId(a.albumId),
        title: a.title || '',
        thumbUrl: a.thumbUrl || '',
        artist: a.artist || '',
        artistIds: (a.artistIds || []).map((id: string) => yandexArtistId(id)),
        year: a.year ?? undefined,
        trackCount: a.trackCount ?? undefined,
      }));
    }
  } catch (e) {
    console.warn('[yandex] getYandexLikedAlbums failed', e);
  }
  return [];
}

export async function getYandexLikedArtists(): Promise<YandexLibraryArtist[]> {
  if (!isYandexEnabled()) return [];
  try {
    const res = await (window as any).bridge.pyCall('yandex_liked_artists', {});
    if (res?.status === 'ok' && Array.isArray(res.results)) {
      return res.results.map((a: any) => ({
        id: yandexArtistId(a.artistId),
        name: a.name || '',
        thumbUrl: a.thumbUrl || '',
      }));
    }
  } catch (e) {
    console.warn('[yandex] getYandexLikedArtists failed', e);
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

export interface YandexArtistAlbum {
  albumId: string;
  title: string;
  thumbUrl: string;
  year?: number;
  type?: string | null;
}

export interface YandexArtistRelated {
  id: string;
  name: string;
  thumbUrl: string;
}

export interface YandexArtistDetail {
  name: string;
  thumbUrl: string;
  topSongs: YTMTrack[];
  allTracks: YTMTrack[];
  monthlyListeners?: number;
  playlists: YandexPlaylistResult[];
  albums: YandexArtistAlbum[];
  related: YandexArtistRelated[];
}

// artistId — префиксованный (yandex:12345, см. yandexArtistId/isYandexArtistId).
export async function getYandexArtist(artistId: string): Promise<YandexArtistDetail | null> {
  const rawId = artistId.replace(/^yandex:/, '');
  if (!rawId) return null;
  try {
    const res = await (window as any).bridge.pyCall('yandex_artist', { artistId: rawId });
    if (res?.status === 'ok') {
      const topSongs = (res.tracks || []).map((e: YandexSearchEntry) => yandexEntryToTrack(e));
      const allTracks = (res.allTracks || []).map((e: YandexSearchEntry) => yandexEntryToTrack(e));
      const playlists: YandexPlaylistResult[] = (res.playlists || []).map((p: any) => ({
        id: yandexPlaylistRouteId(p.ownerId || '', p.id),
        title: p.title || '',
        thumbUrl: p.thumbUrl || '',
        trackCount: p.trackCount,
      }));
      const albums: YandexArtistAlbum[] = (res.albums || []).map((a: any) => ({
        albumId: yandexAlbumRouteId(a.albumId),
        title: a.title || '',
        thumbUrl: a.thumbUrl || '',
        year: a.year ?? undefined,
        type: a.type ?? null,
      }));
      const related: YandexArtistRelated[] = (res.related || []).map((r: any) => ({
        id: yandexArtistId(r.id),
        name: r.name || '',
        thumbUrl: r.thumbUrl || '',
      }));
      return {
        name: res.name || '',
        thumbUrl: res.thumbUrl || '',
        topSongs,
        allTracks,
        monthlyListeners: res.monthlyListeners ?? undefined,
        playlists,
        albums,
        related,
      };
    }
  } catch (e) {
    console.warn('[yandex] getYandexArtist failed', e);
  }
  return null;
}

export interface YandexHomeGenre { id: string; title: string; thumbUrl: string; }

export async function getYandexHomeGenres(): Promise<YandexHomeGenre[]> {
  if (!isYandexEnabled()) return [];
  try {
    const res = await (window as any).bridge.pyCall('yandex_home_genres', {});
    if (res?.status === 'ok' && Array.isArray(res.results)) {
      return res.results.map((g: any) => ({ id: g.id, title: g.title || '', thumbUrl: g.thumbUrl || '' }));
    }
  } catch (e) {
    console.warn('[yandex] getYandexHomeGenres failed', e);
  }
  return [];
}

export interface YandexGenreStation { id: string; title: string; thumbUrl: string; }

export async function getYandexGenreStations(genreId: string): Promise<YandexGenreStation[]> {
  if (!isYandexEnabled()) return [];
  try {
    const res = await (window as any).bridge.pyCall('yandex_genre_stations', { genre: genreId });
    if (res?.status === 'ok' && Array.isArray(res.results)) {
      return res.results.map((s: any) => ({ id: s.id, title: s.title || '', thumbUrl: s.thumbUrl || '' }));
    }
  } catch (e) {
    console.warn('[yandex] getYandexGenreStations failed', e);
  }
  return [];
}

export async function getYandexNewPlaylists(): Promise<YandexPlaylistResult[]> {
  if (!isYandexEnabled()) return [];
  try {
    const res = await (window as any).bridge.pyCall('yandex_new_playlists', {});
    if (res?.status === 'ok' && Array.isArray(res.results)) {
      return res.results.map((r: any) => ({
        id: yandexPlaylistRouteId(r.ownerId || '', r.id),
        title: r.title || '',
        thumbUrl: r.thumbUrl || '',
        trackCount: r.trackCount,
      }));
    }
  } catch (e) {
    console.warn('[yandex] getYandexNewPlaylists failed', e);
  }
  return [];
}

export async function yandexSetAlbumLiked(albumId: string, liked: boolean): Promise<boolean> {
  try {
    const res = await (window as any).bridge.pyCall('yandex_album_like', { albumId: albumId.replace(/^yandex:/, ''), liked });
    if (res?.status === 'ok') return true;
    window.dispatchEvent(new CustomEvent('app-toast', {
      detail: { message: res?.message ? `Не удалось поставить лайк альбому Yandex Music: ${res.message}` : 'Не удалось поставить лайк альбому Yandex Music', type: 'error' },
    }));
  } catch (e) {
    console.warn('[yandex] yandexSetAlbumLiked failed', e);
  }
  return false;
}
