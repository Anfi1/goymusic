import { httpRequest, md5 } from './http';

// JS-порт yandex_* команд из python/api.py. Контракт ответов совпадает один в один,
// поэтому ../src/api/yandex.ts работает поверх этого без единой правки.

const API = 'https://api.music.yandex.net';
const OAUTH = 'https://oauth.yandex.ru';
const CLIENT_ID = '23cabbbdc6cd418abb4b39c32c41195d';
const CLIENT_SECRET = '53bc75238f0c4d08a118e51fe9203300';
const TOKEN_KEY = 'yandex-oauth-token';
const UID_KEY = 'yandex-account-uid';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `OAuth ${getToken() || ''}`,
    'X-Yandex-Music-Client': 'YandexMusicAndroid/24023621',
    Accept: 'application/json',
  };
}

async function api<T = any>(path: string, opts: { method?: 'GET' | 'POST'; params?: Record<string, string>; data?: any; json?: any } = {}): Promise<T> {
  const headers = authHeaders();
  if (opts.json !== undefined) headers['Content-Type'] = 'application/json';
  else if (opts.data !== undefined) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  const res = await httpRequest<any>({
    url: API + path,
    method: opts.method || 'GET',
    headers,
    params: opts.params,
    data: opts.json !== undefined ? opts.json : opts.data,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`yandex ${res.status}: ${JSON.stringify(res.data).slice(0, 160)}`);
  }
  return (res.data?.result ?? res.data) as T;
}

const cover = (uri: string | undefined | null, size = '400x400') =>
  uri ? 'https://' + uri.replace('%%', size) : '';

// Порт yandex_track_dict: те же поля, включая best (молния) и loudness из r128.
export function trackDict(t: any): any {
  const artists = t?.artists || [];
  const albums = t?.albums || [];
  const album = albums[0];
  const albumId = album?.id ?? null;
  const coverUri = t?.coverUri || t?.ogImage || album?.coverUri || album?.ogImage;

  // Громкость Яндекс отдаёт в r128 (EBU R 128): i -- интегрированная в LUFS, tp -- true
  // peak. Формула та же, что в measure_loudness_full: цель -14 LUFS, при усилении не
  // даём пикам вылезти выше -1 dBTP.
  let loudness: number | null = null;
  const r128 = t?.r128;
  if (r128 && typeof r128.i === 'number') {
    loudness = r128.i + 14;
    if (loudness < 0 && typeof r128.tp === 'number') loudness = Math.max(loudness, r128.tp + 1);
  }

  return {
    yandexId: String(t.id),
    title: t.title || '',
    artist: artists[0]?.name || '',
    artistId: artists[0]?.id != null ? String(artists[0].id) : null,
    artists: artists.map((a: any) => a.name),
    artistIds: artists.map((a: any) => String(a.id)),
    duration: Math.floor((t.durationMs || 0) / 1000),
    thumbUrl: cover(coverUri),
    source: 'yandex',
    album: album?.title || '',
    albumId: albumId != null ? String(albumId) : null,
    url: albumId ? `https://music.yandex.ru/album/${albumId}/track/${t.id}` : '',
    loudness,
    best: t?.best === true,
  };
}

// Текст трека Яндекс отдаёт только по подписанному запросу: HMAC-SHA256 от
// "<trackId><unix-время>" на фиксированном ключе, base64. Ключ -- тот же, что у
// официальных клиентов (yandex_music/utils/sign_request.py).
async function lyricsSign(trackId: string): Promise<{ timestamp: number; sign: string }> {
  const timestamp = Math.floor(Date.now() / 1000);
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode('p93jhgh689SBReK6ghtw62'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const raw = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${trackId}${timestamp}`)));
  let bin = '';
  for (const b of raw) bin += String.fromCharCode(b);
  return { timestamp, sign: btoa(bin) };
}

async function accountUid(): Promise<string> {
  const cached = localStorage.getItem(UID_KEY);
  if (cached) return cached;
  const st = await api<any>('/account/status');
  const uid = String(st?.account?.uid ?? '');
  if (uid) localStorage.setItem(UID_KEY, uid);
  return uid;
}

// --- команды ---

export const commands: Record<string, (args: any) => Promise<any>> = {
  async yandex_auth_start() {
    const res = await httpRequest<any>({
      url: `${OAUTH}/device/code`,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: { client_id: CLIENT_ID, device_id: 'goymusic-mobile', device_name: 'GoyMusic Mobile' },
    });
    const d = res.data || {};
    return {
      status: 'ok',
      deviceCode: d.device_code,
      userCode: d.user_code,
      verificationUrl: d.verification_url,
      expiresIn: d.expires_in,
      interval: d.interval,
    };
  },

  async yandex_auth_poll({ deviceCode }: any) {
    const res = await httpRequest<any>({
      url: `${OAUTH}/token`,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: { grant_type: 'device_code', code: deviceCode, client_id: CLIENT_ID, client_secret: CLIENT_SECRET },
    });
    const d = res.data || {};
    if (d.access_token) {
      setToken(d.access_token);
      localStorage.removeItem(UID_KEY);
      let login = '';
      try {
        const st = await api<any>('/account/status');
        login = st?.account?.displayName || st?.account?.login || '';
      } catch { /* имя не критично */ }
      return { status: 'ok', login };
    }
    if (d.error === 'authorization_pending') return { status: 'pending' };
    return { status: 'error', message: d.error_description || d.error || 'auth failed' };
  },

  async yandex_auth_status() {
    if (!getToken()) return { status: 'ok', connected: false };
    try {
      const st = await api<any>('/account/status');
      return { status: 'ok', connected: true, login: st?.account?.displayName || st?.account?.login || '' };
    } catch {
      return { status: 'ok', connected: false };
    }
  },

  async yandex_logout() {
    setToken(null);
    localStorage.removeItem(UID_KEY);
    return { status: 'ok' };
  },

  async yandex_search({ query }: any) {
    const r = await api<any>('/search', { params: { text: query, type: 'track', page: '0', nocorrect: 'false' } });
    const results = (r?.tracks?.results || []).map(trackDict);
    return { status: 'ok', results };
  },

  async yandex_liked_tracks() {
    const uid = await accountUid();
    const liked = await api<any>(`/users/${uid}/likes/tracks`);
    const items = liked?.library?.tracks || [];
    const likedAt = new Map<string, string>();
    const ids = items.map((i: any) => {
      const id = String(i.id);
      if (i.timestamp) likedAt.set(id, i.timestamp);
      return i.albumId ? `${id}:${i.albumId}` : id;
    });
    // /tracks принимает пачками -- шлём по 300, иначе упираемся в лимит длины запроса.
    const results: any[] = [];
    for (let i = 0; i < ids.length; i += 300) {
      const chunk = ids.slice(i, i + 300);
      const tracks = await api<any[]>('/tracks', { method: 'POST', data: { 'track-ids': chunk.join(',') } });
      for (const t of tracks || []) {
        if (!t) continue;
        const d = trackDict(t);
        d.likedAt = likedAt.get(String(t.id)) || null;
        results.push(d);
      }
    }
    return { status: 'ok', results };
  },

  async yandex_set_liked({ yandexId, liked }: any) {
    const uid = await accountUid();
    const action = liked ? 'add-multiple' : 'remove';
    await api(`/users/${uid}/likes/tracks/${action}`, { method: 'POST', data: { 'track-ids': String(yandexId) } });
    return { status: 'ok', liked };
  },

  async yandex_wave_stations() {
    const dash = await api<any>('/rotor/stations/dashboard');
    const seen = new Set<string>();
    const stations: any[] = [];
    for (const item of dash?.stations || []) {
      const st = item.station;
      if (!st?.id) continue;
      const sid = `${st.id.type}:${st.id.tag}`;
      if (seen.has(sid)) continue;
      seen.add(sid);
      stations.push({
        id: sid,
        title: item.customName || st.name || sid,
        thumbUrl: cover(st.fullImageUrl) || cover(st.icon?.imageUrl),
      });
    }
    return { status: 'ok', stations };
  },

  async yandex_wave_tracks({ station, queue, batches }: any) {
    const st = station || 'user:onyourwave';
    const count = Math.max(1, Math.min(Number(batches) || 1, 5));
    const results: any[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined = queue || undefined;
    let batchId: string | null = null;
    for (let n = 0; n < count; n++) {
      const params: Record<string, string> = { settings2: 'true' };
      if (cursor) params.queue = cursor;
      const r = await api<any>(`/rotor/station/${st}/tracks`, { params });
      const seq = r?.sequence || [];
      if (!seq.length) break;
      if (batchId === null) batchId = r?.batchId ?? null;
      let added = 0;
      let last: string | null = null;
      for (const item of seq) {
        const t = item.track;
        if (!t) continue;
        last = String(t.id);
        if (seen.has(last)) continue;
        seen.add(last);
        results.push(trackDict(t));
        added++;
      }
      if (!added || !last) break;
      cursor = last;
    }
    return { status: 'ok', results, batchId };
  },

  async yandex_rotor_feedback({ station, type, yandexId, played, batchId }: any) {
    // Эндпоинт принимает ТОЛЬКО JSON: на form-data отвечает 400 "condition is not met".
    const body: any = { type, timestamp: Date.now() / 1000, from: 'desktop_win' };
    if (yandexId) body.trackId = String(yandexId);
    if (played != null) body.totalPlayedSeconds = Number(played);
    try {
      await api(`/rotor/station/${station}/feedback`, {
        method: 'POST',
        params: batchId ? { 'batch-id': batchId } : undefined,
        json: body,
      });
      return { status: 'ok', ok: true };
    } catch (e: any) {
      return { status: 'ok', ok: false, message: String(e?.message || e) };
    }
  },

  async yandex_play_audio({ yandexId, albumId, playlistId, duration, played, endPosition }: any) {
    const uid = await accountUid();
    const now = new Date().toISOString();
    try {
      await api('/play-audio', {
        method: 'POST',
        data: {
          'track-id': String(yandexId),
          'from-cache': 'False',
          from: 'desktop_win',
          'play-id': '',
          uid,
          timestamp: now,
          'track-length-seconds': String(Math.round(duration || 0)),
          'total-played-seconds': String(Math.round(played || 0)),
          'end-position-seconds': String(Math.round(endPosition || 0)),
          'album-id': String(albumId || ''),
          'playlist-id': playlistId || '',
          'client-now': now,
        },
      });
      return { status: 'ok', ok: true };
    } catch {
      return { status: 'ok', ok: false };
    }
  },

  async yandex_recommendations({ yandexId }: any) {
    const r = await api<any>(`/tracks/${yandexId}/similar`);
    return { status: 'ok', results: (r?.similarTracks || []).map(trackDict) };
  },

  async yandex_new_releases() {
    const landing = await api<any>('/landing3/new-releases');
    const ids = (landing?.newReleases || []).slice(0, 30).map(String);
    if (!ids.length) return { status: 'ok', results: [] };
    const albums = await api<any[]>('/albums', { method: 'POST', data: { 'album-ids': ids.join(',') } });
    const results = (albums || []).filter(Boolean).map((a: any) => ({
      albumId: String(a.id),
      title: a.title || '',
      thumbUrl: cover(a.coverUri || a.ogImage),
      artist: a.artists?.[0]?.name || '',
      artists: (a.artists || []).map((x: any) => x.name),
      artistIds: (a.artists || []).map((x: any) => String(x.id)),
      year: a.year ?? null,
    }));
    return { status: 'ok', results };
  },

  async yandex_album_tracks({ albumId }: any) {
    const a = await api<any>('/albums/' + albumId + '/with-tracks');
    const results: any[] = [];
    for (const vol of a?.volumes || []) for (const t of vol) results.push(trackDict(t));
    const artists = a?.artists || [];
    const raw = (a?.type || '').toLowerCase();
    const albumType = raw === 'single' ? (results.length <= 1 ? 'SINGLE' : 'EP')
      : raw === 'compilation' ? 'COMPILATION' : 'ALBUM';
    let liked = false;
    try {
      const uid = await accountUid();
      const likes = await api<any[]>(`/users/${uid}/likes/albums`);
      liked = (likes || []).some((l: any) => String(l?.album?.id ?? l?.id) === String(albumId));
    } catch { /* лайк не критичен */ }
    return {
      status: 'ok',
      title: a?.title || '',
      albumType,
      artist: artists[0]?.name || '',
      artists: artists.map((x: any) => x.name),
      artistIds: artists.map((x: any) => String(x.id)),
      artistId: artists[0]?.id != null ? String(artists[0].id) : '',
      thumbUrl: cover(a?.coverUri || a?.ogImage),
      year: a?.year ?? null,
      liked,
      results,
    };
  },

  async yandex_album_like({ albumId, liked }: any) {
    const uid = await accountUid();
    const action = liked ? 'add-multiple' : 'remove';
    await api(`/users/${uid}/likes/albums/${action}`, { method: 'POST', data: { 'album-ids': String(albumId) } });
    return { status: 'ok', liked };
  },

  async yandex_playlists() {
    const uid = await accountUid();
    const lists = await api<any[]>(`/users/${uid}/playlists/list`);
    const results = (lists || []).map((pl: any) => ({
      id: String(pl.kind),
      title: pl.title || '',
      thumbUrl: cover(pl.cover?.uri) || cover(pl.ogImage),
      trackCount: pl.trackCount ?? null,
    }));
    return { status: 'ok', results };
  },

  async yandex_playlist_tracks({ kind, ownerId }: any) {
    const uid = ownerId || (await accountUid());
    const pl = await api<any>(`/users/${uid}/playlists/${kind}`);
    const results = (pl?.tracks || []).map((x: any) => trackDict(x.track || x)).filter((t: any) => t.yandexId);
    return { status: 'ok', title: pl?.title || '', results };
  },

  async yandex_new_playlists() {
    try {
      const landing = await api<any>('/landing3', { params: { blocks: 'new-playlists' } });
      const block = (landing?.blocks || []).find((b: any) => b.type === 'new-playlists');
      const results = (block?.entities || []).map((e: any) => {
        const d = e.data || e;
        return {
          id: String(d.kind),
          ownerId: d.owner?.uid != null ? String(d.owner.uid) : '',
          title: d.title || '',
          thumbUrl: cover(d.cover?.uri) || cover(d.ogImage),
          trackCount: d.trackCount ?? null,
        };
      }).filter((p: any) => p.id && p.id !== 'undefined');
      return { status: 'ok', results };
    } catch {
      return { status: 'ok', results: [] };
    }
  },

  async yandex_liked_albums() {
    const uid = await accountUid();
    // rich=True -- иначе приходит укороченная форма без названия и обложки.
    const likes = await api<any[]>(`/users/${uid}/likes/albums`, { params: { rich: 'True' } });
    const results = (likes || []).map((l: any) => l.album || l).filter(Boolean).map((a: any) => ({
      albumId: String(a.id),
      title: a.title || '',
      thumbUrl: cover(a.coverUri || a.ogImage),
      artist: a.artists?.[0]?.name || '',
      artists: (a.artists || []).map((x: any) => x.name),
      artistIds: (a.artists || []).map((x: any) => String(x.id)),
      year: a.year ?? null,
      trackCount: a.trackCount ?? null,
    }));
    return { status: 'ok', results };
  },

  async yandex_liked_artists() {
    const uid = await accountUid();
    const likes = await api<any[]>(`/users/${uid}/likes/artists`);
    const results = (likes || []).map((l: any) => l.artist || l).filter(Boolean).map((a: any) => ({
      artistId: String(a.id),
      name: a.name || '',
      thumbUrl: cover(a.cover?.uri),
    }));
    return { status: 'ok', results };
  },

  async yandex_artist({ artistId }: any) {
    const info = await api<any>(`/artists/${artistId}/brief-info`);
    const artist = info?.artist;
    const pop = info?.popularTracks || [];
    const topTracks = pop.slice(0, 5).map(trackDict);
    let allTracks = topTracks;
    try {
      const page = await api<any>(`/artists/${artistId}/tracks`, { params: { page: '0', 'page-size': '50' } });
      const list = (page?.tracks || []).map(trackDict);
      if (list.length) allTracks = list;
    } catch { /* остаётся превью */ }

    const playlists = (info?.playlists || []).map((pl: any) => ({
      id: String(pl.kind),
      ownerId: pl.owner?.uid != null ? String(pl.owner.uid) : '',
      title: pl.title || '',
      thumbUrl: cover(pl.cover?.uri),
      trackCount: pl.trackCount ?? null,
    }));
    const albums = (info?.albums || []).map((al: any) => ({
      albumId: String(al.id),
      title: al.title || '',
      thumbUrl: cover(al.coverUri || al.ogImage),
      year: al.year ?? null,
      type: al.type ?? null,
    }));
    const related = (info?.similarArtists || []).map((sa: any) => ({
      id: String(sa.id),
      name: sa.name || '',
      thumbUrl: cover(sa.cover?.uri),
    }));

    return {
      status: 'ok',
      name: artist?.name || '',
      thumbUrl: cover(artist?.cover?.uri),
      tracks: topTracks,
      allTracks,
      monthlyListeners: info?.stats?.lastMonthListeners ?? null,
      playlists,
      albums,
      related,
    };
  },

  async yandex_home_genres() {
    const allowed = new Set(['pop', 'allrock', 'indie', 'metal', 'alternative', 'dance', 'electronics',
      'rap', 'rnb', 'jazz', 'blues', 'reggae', 'ska', 'punk', 'folk', 'estrada', 'shanson', 'country',
      'soundtrack', 'relax', 'children', 'classicalmusic', 'naturesounds', 'bard']);
    const genres = await api<any[]>('/genres');
    const pickImage = (g: any): string => {
      const im = g?.images || {};
      const raw = im['300x300'] || im['208x208'];
      if (raw) return String(raw).replace('http://', 'https://');
      // У части метажанров (allrock) images: null -- берём обложку первого поджанра.
      for (const sub of g?.subGenres || []) {
        const s = sub?.images || {};
        const r = s['300x300'] || s['208x208'];
        if (r) return String(r).replace('http://', 'https://');
      }
      return '';
    };
    const results = (genres || []).filter((g: any) => allowed.has(g.id)).map((g: any) => ({
      id: g.id,
      title: g.title || '',
      thumbUrl: pickImage(g),
    }));
    return { status: 'ok', results };
  },

  async yandex_genre_stations({ genre }: any) {
    const tagMap: Record<string, string[]> = {
      pop: ['pop'], allrock: ['rock'], indie: ['indie'], metal: ['metal'], alternative: ['alternative'],
      dance: ['dance', 'house', 'techno', 'disco', 'club'],
      electronics: ['electron', 'dubstep', 'ambient', 'idm', 'dnb'],
      rap: ['rap', 'hiphop', 'grime'], rnb: ['rnb', 'soul', 'funk'], jazz: ['jazz'], blues: ['blues'],
      reggae: ['reggae'], ska: ['ska'], punk: ['punk'], folk: ['folk'], estrada: ['estrada'],
      shanson: ['shanson', 'chanson'], country: ['country'],
      soundtrack: ['film', 'soundtrack', 'musical', 'cinema', 'movie'],
      relax: ['relax', 'lounge', 'meditation', 'sleep', 'calm', 'chill'],
      children: ['kids', 'lullaby', 'child'],
      classicalmusic: ['classic', 'neoclass', 'orchestra', 'symphony', 'piano'],
      naturesounds: ['nature', 'rain', 'sea', 'ocean', 'forest'], bard: ['bard'],
    };
    const needles = tagMap[genre] || [];
    if (!needles.length) return { status: 'ok', results: [] };
    const list = await api<any[]>('/rotor/stations/list', { params: { lang: 'ru' } });
    const results: any[] = [];
    for (const item of list || []) {
      const st = item.station;
      if (st?.id?.type !== 'genre') continue;
      const tag = String(st.id.tag || '').toLowerCase();
      if (!needles.some(n => tag.includes(n))) continue;
      results.push({
        id: `genre:${st.id.tag}`,
        title: st.name || st.id.tag,
        thumbUrl: cover(st.fullImageUrl) || cover(st.icon?.imageUrl),
      });
      if (results.length >= 50) break;
    }
    return { status: 'ok', results };
  },

  async yandex_stream_url({ yandexId }: any) {
    const infos = await api<any[]>(`/tracks/${yandexId}/download-info`);
    const sorted = (infos || []).slice().sort((a, b) =>
      (a.codec !== 'mp3' ? 1 : 0) - (b.codec !== 'mp3' ? 1 : 0) || (b.bitrateInKbps || 0) - (a.bitrateInKbps || 0));
    const best = sorted[0];
    if (!best?.downloadInfoUrl) return { status: 'error', message: 'no download info' };
    const res = await httpRequest<any>({ url: best.downloadInfoUrl + '&format=json', headers: authHeaders() });
    const d = res.data || {};
    // Подпись ссылки: md5(соль + path без первого слэша + s) -- схема самих клиентов Яндекса.
    const sign = md5('XGRlBW9FXlekgbPrRHuSiA' + String(d.path).slice(1) + d.s);
    const url = `https://${d.host}/get-mp3/${sign}/${d.ts}${d.path}`;
    return {
      status: 'ok',
      url,
      expires: Math.floor(Date.now() / 1000) + 45,
      bitrate: best.bitrateInKbps,
      codec: best.codec,
    };
  },

  async get_lyrics({ yandexId, artist, title }: any) {
    if (yandexId) {
      try {
        const sig = await lyricsSign(String(yandexId));
        const info = await api<any>(`/tracks/${yandexId}/lyrics`, {
          params: { format: 'LRC', timeStamp: String(sig.timestamp), sign: sig.sign },
        });
        if (info?.downloadUrl) {
          const res = await httpRequest<any>({ url: info.downloadUrl });
          const lrc = typeof res.data === 'string' ? res.data.trim() : '';
          if (lrc) {
            const plain = lrc.split('\n').map(l => l.replace(/^\[\d+:\d+(?:\.\d+)?\]\s*/, '').trim()).join('\n').trim();
            return { status: 'ok', plainLyrics: plain || null, syncedLyrics: lrc, source: 'yandex' };
          }
        }
      } catch { /* падаем на lrclib */ }
    }
    // Фолбэк для не-яндексовых треков: LRCLIB (публичный, CORS-дружелюбный).
    try {
      const res = await httpRequest<any>({
        url: 'https://lrclib.net/api/get',
        params: { artist_name: artist || '', track_name: title || '' },
      });
      const d = res.data || {};
      if (d.syncedLyrics || d.plainLyrics) {
        return { status: 'ok', plainLyrics: d.plainLyrics || null, syncedLyrics: d.syncedLyrics || null, source: 'lrclib' };
      }
      if (d.instrumental) return { status: 'ok', instrumental: true, source: 'lrclib' };
    } catch { /* текста нет */ }
    return { status: 'error', message: 'not found' };
  },
};
