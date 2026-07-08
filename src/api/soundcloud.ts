import type { YTMTrack } from './yt';
import type { ScLikedEntry } from './likedStore';
import { likedStore } from './likedStore';
import { registerSoundCloudTrack } from './stream';

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
  const out: YTMTrack[] = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (i < a.length) out.push(a[i]);
    if (i < b.length) out.push(b[i]);
  }
  return out;
}

// "M:SS" / "H:MM:SS" → секунды (0 при пустом/битом значении).
function durationToSeconds(d: string | undefined | null): number {
  if (!d) return 0;
  const parts = d.split(':').map(p => parseInt(p, 10));
  if (parts.some(isNaN)) return 0;
  return parts.reduce((acc, v) => acc * 60 + v, 0);
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

let scClientId = '';
let scAppVersion = '';

export interface ScAccount { id: number; username: string; avatarUrl: string; permalinkUrl: string; }

export function getScToken(): string {
  return localStorage.getItem(SC_TOKEN_KEY) || '';
}

export function getScUid(): string {
  return localStorage.getItem(SC_UID_KEY) || '';
}

// client_id + app_version нужны для webview-лайка; берём с бэкенда и кэшируем.
async function ensureScClientId(): Promise<{ cid: string; appVersion: string }> {
  if (scClientId && scAppVersion) return { cid: scClientId, appVersion: scAppVersion };
  try {
    const res = await (window as any).bridge.pyCall('sc_client_id', {});
    if (res?.status === 'ok') { scClientId = res.clientId || ''; scAppVersion = res.appVersion || ''; }
  } catch { /* ignore */ }
  return { cid: scClientId, appVersion: scAppVersion };
}

// Надёжный вход: окно SoundCloud (логин + DataDome), забираем oauth_token и валидируем.
export async function scLoginViaWebview(): Promise<ScAccount | null> {
  try {
    const res = await (window as any).bridge.scLogin();
    if (res?.status === 'ok' && res.token) {
      return scConnect(res.token);
    }
  } catch (e) {
    console.warn('[soundcloud] scLoginViaWebview failed', e);
  }
  return null;
}

export function isScAuthed(): boolean {
  return !!getScToken();
}

export async function scDisconnect(): Promise<void> {
  // Удаляем серверные SC-лайки, но сохраняем localOnly
  const all = await likedStore.getAllScTracks();
  const toKeep = all.filter(e => e.localOnly);
  await likedStore.clearScTracks();
  if (toKeep.length > 0) await likedStore.putScTracksBatch(toKeep);
  await likedStore.setScVirtualCount(0);

  localStorage.removeItem(SC_TOKEN_KEY);
  localStorage.removeItem(SC_UID_KEY);
  scLikedSet = new Set();
  try { (window as any).bridge?.scLogout?.(); } catch { /* ignore */ }
}

// Проверяет токен через api-v2 /me. При успехе сохраняет его и возвращает аккаунт.
export async function scConnect(token: string): Promise<ScAccount | null> {
  const t = (token || '').trim();
  if (!t) return null;
  try {
    const res = await (window as any).bridge.pyCall('sc_me', { token: t });
    if (res?.status === 'ok' && res.connected) {
      localStorage.setItem(SC_TOKEN_KEY, t);
      localStorage.setItem(SC_UID_KEY, String(res.id));
      loadScLikedIds();
      return { id: res.id, username: res.username || '', avatarUrl: res.avatarUrl || '', permalinkUrl: res.permalinkUrl || '' };
    }
  } catch (e) {
    console.warn('[soundcloud] scConnect failed', e);
  }
  return null;
}

// Перепроверяет уже сохранённый токен (для отображения статуса при открытии настроек).
export async function getScAccount(): Promise<ScAccount | null> {
  const t = getScToken();
  if (!t) return null;
  return scConnect(t);
}

// --- Лайки на SoundCloud (только в авторизованном режиме) ---
// Множество permalink-URL'ов лайкнутых треков — для статуса лайков в радио/поиске.
let scLikedSet = new Set<string>();
let scLocalOnlySet = new Set<string>();

export async function loadScLikedIds(): Promise<void> {
  const t = getScToken();
  if (!t) { scLikedSet = new Set(); return; }
  try {
    const res = await (window as any).bridge.pyCall('sc_liked_ids', { token: t });
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

// Для использования из scLikedManager (разные модули)
export function addScLocalOnlyId(scId: string): void {
  scLocalOnlySet.add(scId);
}

export function removeScLocalOnlyId(scId: string): void {
  scLocalOnlySet.delete(scId);
}

// Ставит/снимает лайк на SoundCloud через кастомный профиль Chrome + CDP.
// Если профиль ещё не настроен — пробует настроить (открыть Chrome для логина) и ретраит.
export async function scSetLiked(scId: string | undefined, scUrl: string | undefined, liked: boolean): Promise<boolean> {
  const token = getScToken();
  if (!token || !scId) return false;

  const trackUrl = (scUrl && scUrl.startsWith('https://soundcloud.com/'))
    ? scUrl
    : `https://soundcloud.com/tracks/${scId}`;

  const bridge = (window as any).bridge;
  let profileDir: string;
  try {
    profileDir = await bridge.getScProfileDir();
  } catch {
    return false;
  }

  const doLike = async (): Promise<boolean> => {
    const res = await bridge.pyCall('sc_like_nodriver', {
      scId, url: trackUrl, liked, profileDir, oauthToken: token,
    });
    if (res?.status === 'ok') {
      const actualLiked = res.liked === 'liked';
      if (actualLiked) scLikedSet.add(scId); else scLikedSet.delete(scId);
      return true;
    }
    return false;
  };

  return doLike();
}

// Открывает Chrome с кастомным профилем, юзер логинится в SC руками,
// забираем oauth_token и сохраняем.
export async function scEnsureProfile(): Promise<boolean> {
  try {
    const bridge = (window as any).bridge;
    const profileDir = await bridge.getScProfileDir();
    const res = await bridge.pyCall('sc_setup_profile', { profileDir });
    if (res?.status === 'ok' && res.token) {
      const acc = await scConnect(res.token);
      if (acc) return true;
    }
  } catch (e) {
    console.warn('[soundcloud] profile setup failed', e);
  }
  return false;
}

// При старте подтягиваем SC-лайки, если есть токен (чтобы статус был в радио/поиске).
// Всегда загружаем local-only лайки, даже без SC-авторизации.
// Гард по window: в node-окружении тестов localStorage отсутствует.
if (typeof window !== 'undefined') {
  if (getScToken()) loadScLikedIds();
  loadScLocalOnlyIds();  // always — even without SC auth
}

export interface ScArtistDetail {
  name: string;
  thumbUrl: string;
  artistPro?: boolean;
  verified?: boolean;
  tracks: YTMTrack[];
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
      return { name: res.name || '', thumbUrl: res.thumbUrl || '', artistPro: res.artistPro, verified: res.verified, tracks };
    }
  } catch (e) {
    console.warn('[soundcloud] getSoundCloudArtist failed', e);
  }
  return null;
}

export interface ScArtistResult { id: string; name: string; thumbUrl: string; source: 'soundcloud'; artistPro?: boolean; verified?: boolean; }
export interface ScAlbumResult { id: string; title: string; thumbUrl: string; artists: string[]; artistIds?: string[]; source: 'soundcloud'; }
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
        source: 'soundcloud',
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

// SC-радио от трека (api-v2 /tracks/{id}/related; с токеном — персонализировано).
export async function getScRecommendations(opts: { scId?: string; url?: string }): Promise<YTMTrack[]> {
  if (!isSoundCloudEnabled()) return [];
  if (!opts.scId && !opts.url) return [];
  try {
    const res = await (window as any).bridge.pyCall('sc_recommendations', { token: getScToken(), scId: opts.scId || '', url: opts.url || '' });
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

// Полная выгрузка лайкнутых SC-треков с временем лайка (для локального стора/вкладки лайков).
export async function getScLikedEntries(): Promise<ScLikedEntry[]> {
  const token = getScToken();
  if (!token) return [];
  try {
    const res = await (window as any).bridge.pyCall('sc_liked_tracks', { token });
    if (res?.status === 'ok' && Array.isArray(res.results)) {
      return res.results
        .filter((e: any) => e.scId)
        .map((e: any) => {
          const track = scEntryToTrack(e as ScSearchEntry);
          if (track.scUrl) registerSoundCloudTrack(track.id, track.scUrl);
          return { scId: e.scId as string, track, likedAt: Number(e.likedAt) || 0 };
        });
    }
  } catch (e) {
    console.warn('[soundcloud] getScLikedEntries failed', e);
  }
  return [];
}

// Дёшево: число SC-лайков + первые id, для сверки без полной загрузки (как virtualCount у YT).
export async function getScLikedMeta(): Promise<{ count: number; headIds: string[] } | null> {
  const token = getScToken();
  if (!token) return null;
  try {
    const res = await (window as any).bridge.pyCall('sc_liked_meta', { token });
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
    const res = await (window as any).bridge.pyCall('sc_wave_stations', { token: getScToken() });
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
    const res = await (window as any).bridge.pyCall('sc_station_tracks', { id, token: getScToken() });
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
