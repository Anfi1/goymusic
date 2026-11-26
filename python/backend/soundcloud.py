"""Read-only SoundCloud catalog, library and station commands."""
import concurrent.futures
import re
import sys

import requests


class ScUnauthorizedError(Exception):
    """api-v2 вернул 401 на запрос с oauth_token."""


def _sc_pick_thumb(url):
    """Берём картинку покрупнее: SoundCloud отдаёт -large (100px), меняем на -t500x500."""
    if not url:
        return ''
    return url.replace('-large.', '-t500x500.')


def _sc_pick_track_thumb(item, fallback_user=None):
    """Обложка трека/альбома/плейлиста SC с фолбэком на аватар автора (игнорируя default_avatar)."""
    if not isinstance(item, dict):
        return ''
    item_user = item.get('user')
    candidates = (
        item.get('artwork_url'),
        item_user.get('avatar_url') if isinstance(item_user, dict) else None,
        fallback_user.get('avatar_url') if isinstance(fallback_user, dict) else None,
    )
    url = next((c for c in candidates if isinstance(c, str) and c.strip()), '')
    if not url or 'default_avatar' in url:
        return ''
    return _sc_pick_thumb(url)

def _sc_iso_to_ms(value):
    """ISO-время лайка SoundCloud ('2026-06-27T14:09:54Z') → epoch ms. 0 при ошибке."""
    if not value:
        return 0
    try:
        import datetime
        dt = datetime.datetime.strptime(value, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=datetime.timezone.utc)
        return int(dt.timestamp() * 1000)
    except Exception:
        return 0

def _sc_extract_track_id(url):
    """Числовой id трека из URL вида .../tracks/2342 или soundcloud:tracks:2342 (вкл. url-encoded)."""
    if not url:
        return None
    u = url.replace('%3A', ':').replace('%2F', '/')
    m = re.search(r'tracks[:/](\d+)', u)
    return m.group(1) if m else None


class SoundCloudCommands:
    def __init__(self, get, headers, client_id):
        self.get = get
        self.headers = headers
        self.client_id = client_id

    def get_soundcloud_artist(self, request, ctx):
        # Треки SoundCloud-исполнителя через api-v2: /resolve(profile) -> /users/{id}/tracks.
        # Быстрее yt-dlp, правильный аватар (avatar_url), больше треков, есть scId.
        url = request.get('url', '')
        try:
            user = self.get('/resolve', {'url': url})
            uid = (user or {}).get('id')
            results = []
            popular = []
            albums = []
            playlists = []
            related = []
            if uid:
                username = (user or {}).get('username', '')
                permalink_url = (user or {}).get('permalink_url', '') or url

                def fetch_all_tracks():
                    """Загружает все треки с пагинацией."""
                    all_tracks = []
                    next_url = f'https://api-v2.soundcloud.com/users/{uid}/tracks?limit=50'
                    seen_ids = set()
                    for _ in range(10):  # Макс 10 страниц (500 треков)
                        data = self.get(next_url.replace('https://api-v2.soundcloud.com', ''), {})
                        if not data:
                            break
                        for t in ((data or {}).get('collection') or []):
                            if not t or not t.get('permalink_url'):
                                continue
                            tid = t.get('id')
                            if tid in seen_ids:
                                continue
                            seen_ids.add(tid)
                            tuser = t.get('user') or {}
                            all_tracks.append({
                                'url': t.get('permalink_url', ''),
                                'title': t.get('title', ''),
                                'artist': tuser.get('username', '') or username,
                                'duration': int((t.get('duration') or 0) / 1000),
                                'thumbUrl': _sc_pick_track_thumb(t, user),
                                'source': 'soundcloud',
                                'scId': str(tid or ''),
                                'uploaderUrl': permalink_url,
                                'plays': t.get('playback_count', 0),
                                'likes': t.get('likes_count', 0),
                            })
                        next_href = (data or {}).get('next_href')
                        if not next_href:
                            break
                        next_url = next_href.replace('https://api-v2.soundcloud.com', '')
                    return all_tracks

                def fetch_albums():
                    """Загружает альбомы."""
                    alb_data = self.get(f'/users/{uid}/albums', {'limit': 20})
                    album_list = []
                    for a in ((alb_data or {}).get('collection') or []):
                        if not a or not a.get('permalink_url'):
                            continue
                        created = a.get('created_at', '')
                        year = created[:4] if created and len(created) >= 4 else ''
                        album_list.append({
                            'url': a.get('permalink_url', ''),
                            'title': a.get('title', ''),
                            'artist': username,
                            'thumbUrl': _sc_pick_track_thumb(a, user),
                            'trackCount': a.get('track_count', 0),
                            'year': year,
                        })
                    return album_list

                def fetch_playlists():
                    """Загружает плейлисты."""
                    pl_data = self.get(f'/users/{uid}/playlists', {'limit': 20})
                    playlist_list = []
                    for p in ((pl_data or {}).get('collection') or []):
                        if not p or not p.get('permalink_url'):
                            continue
                        playlist_list.append({
                            'url': p.get('permalink_url', ''),
                            'title': p.get('title', ''),
                            'artist': username,
                            'thumbUrl': _sc_pick_track_thumb(p, user),
                            'trackCount': p.get('track_count', 0),
                        })
                    return playlist_list

                def fetch_related():
                    """Загружает похожих артистов (followings)."""
                    try:
                        follow_data = self.get(f'/users/{uid}/followings', {'limit': 10})
                        related_list = []
                        for u in ((follow_data or {}).get('collection') or []):
                            if not u or not u.get('permalink_url'):
                                continue
                            related_list.append({
                                'id': u.get('permalink_url', ''),
                                'name': u.get('username', ''),
                                'thumbUrl': _sc_pick_thumb(u.get('avatar_url') or ''),
                                'subscribers': u.get('followers_count', 0),
                            })
                        return related_list
                    except:
                        return []

                # Параллельная загрузка всех данных
                with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
                    future_tracks = executor.submit(fetch_all_tracks)
                    future_albums = executor.submit(fetch_albums)
                    future_playlists = executor.submit(fetch_playlists)
                    future_related = executor.submit(fetch_related)

                    results = future_tracks.result()
                    albums = future_albums.result()
                    playlists = future_playlists.result()
                    related = future_related.result()

                # Сортируем по просмотрам для популярных
                results.sort(key=lambda x: x.get('plays', 0), reverse=True)
                # Берём топ-10 как популярные
                popular = results[:10]
            verified = bool((user or {}).get('verified'))
            ctx.emit({
                'status': 'ok',
                'name': (user or {}).get('username', ''),
                'thumbUrl': _sc_pick_thumb((user or {}).get('avatar_url') or ''),
                'artistPro': verified,
                'verified': verified,
                'description': (user or {}).get('description', ''),
                'followersCount': (user or {}).get('followers_count', 0),
                'tracksCount': (user or {}).get('track_count', 0),
                'results': results,
                'popular': popular,
                'albums': albums,
                'playlists': playlists,
                'related': related,
            })
        except Exception as e:
            print(f"[error] get_soundcloud_artist: {e}", file=sys.stderr)
            ctx.emit({'status': 'error', 'message': str(e)})

    def search_soundcloud_extra(self, request, ctx):
        # Поиск SC-артистов и альбомов через внутренний api-v2 (scsearch yt-dlp умеет только треки).
        query = request.get('query', '')
        try:
            artists, albums = [], []
            if query.strip():
                users = self.get('/search/users', {'q': query, 'limit': 8})
                for u in ((users or {}).get('collection') or []):
                    if not u.get('permalink_url'):
                        continue
                    artists.append({
                        'url': u.get('permalink_url', ''),
                        'name': u.get('username', ''),
                        'thumbUrl': _sc_pick_thumb(u.get('avatar_url') or ''),
                        'source': 'soundcloud',
                        'artistPro': bool(u.get('verified')),
                        'verified': bool(u.get('verified')),
                    })
                alb = self.get('/search/albums', {'q': query, 'limit': 8})
                for a in ((alb or {}).get('collection') or []):
                    if not a.get('permalink_url'):
                        continue
                    user = a.get('user') or {}
                    albums.append({
                        'url': a.get('permalink_url', ''),
                        'title': a.get('title', ''),
                        'thumbUrl': _sc_pick_track_thumb(a),
                        'artist': user.get('username', ''),
                        'uploaderUrl': user.get('permalink_url', ''),
                        'source': 'soundcloud',
                    })
            ctx.emit({'status': 'ok', 'artists': artists, 'albums': albums})
        except Exception as e:
            print(f"[error] search_soundcloud_extra: {e}", file=sys.stderr)
            ctx.emit({'status': 'error', 'message': str(e)})

    def sc_me(self, request, ctx):
        # Проверка oauth_token и данные SC-аккаунта (для статуса подключения).
        token = request.get('token', '')
        try:
            me = self.get('/me', {}, oauth_token=token) if token else None
            if me and me.get('id'):
                ctx.emit({
                    'status': 'ok', 'connected': True,
                    'id': me.get('id'),
                    'username': me.get('username', ''),
                    'avatarUrl': _sc_pick_thumb(me.get('avatar_url') or ''),
                    'permalinkUrl': me.get('permalink_url', ''),
                })
            else:
                ctx.emit({'status': 'ok', 'connected': False})
        except ScUnauthorizedError:
            ctx.emit({'status': 'unauthorized', 'connected': False, 'message': 'HTTP 401'})
        except Exception as e:
            print(f"[error] sc_me: {e}", file=sys.stderr)
            ctx.emit({'status': 'error', 'message': str(e)})

    def sc_liked_ids(self, request, ctx):
        # ID лайкнутых треков пользователя (для статуса лайков в радио/поиске).
        token = request.get('token', '')
        if not token:
            ctx.emit({'status': 'ok', 'ids': []})
            return
        try:
            me = self.get('/me', {}, oauth_token=token)
            uid = (me or {}).get('id')
            if not uid:
                ctx.emit({'status': 'error', 'message': 'Failed to load SoundCloud account'})
                return
            ids = []
            next_url = f'https://api-v2.soundcloud.com/users/{uid}/track_likes'
            next_params = {'limit': 200, 'linked_partitioning': 1, 'client_id': self.client_id()}
            for page_idx in range(5):  # до ~1000 лайков
                r = requests.get(next_url, params=next_params, headers=self.headers(token), timeout=12)
                if r.status_code == 401:
                    raise ScUnauthorizedError('HTTP 401')
                if not r.ok:
                    if page_idx == 0:
                        ctx.emit({'status': 'error', 'message': f'HTTP {r.status_code}'})
                        return
                    break
                data = r.json()
                for item in (data.get('collection') or []):
                    tr = item.get('track') or {}
                    if tr.get('id') is not None:
                        ids.append(str(tr['id']))
                nxt = data.get('next_href')
                if not nxt:
                    break
                next_url = nxt  # next_href уже содержит client_id и параметры
                next_params = {}
            ctx.emit({'status': 'ok', 'ids': ids})
        except ScUnauthorizedError:
            ctx.emit({'status': 'unauthorized', 'message': 'HTTP 401'})
        except Exception as e:
            print(f"[error] sc_liked_ids: {e}", file=sys.stderr)
            ctx.emit({'status': 'error', 'message': str(e)})

    def sc_liked_tracks(self, request, ctx):
        # Полные объекты лайкнутых треков (для вкладки лайков).
        token = request.get('token', '')
        if not token:
            ctx.emit({'status': 'ok', 'results': []})
            return
        try:
            me = self.get('/me', {}, oauth_token=token)
            uid = (me or {}).get('id')
            if not uid:
                ctx.emit({'status': 'error', 'message': 'Failed to load SoundCloud account'})
                return
            results = []
            next_url = f'https://api-v2.soundcloud.com/users/{uid}/track_likes'
            next_params = {'limit': 200, 'linked_partitioning': 1, 'client_id': self.client_id()}
            for _ in range(5):  # до ~1000 лайков
                r = requests.get(next_url, params=next_params, headers=self.headers(token), timeout=12)
                if r.status_code == 401:
                    raise ScUnauthorizedError('HTTP 401')
                if not r.ok:
                    # Не отдаем обрезанный список как ok, чтобы sync не стер локальное зеркало лайков.
                    ctx.emit({'status': 'error', 'message': f'HTTP {r.status_code}'})
                    return
                data = r.json()
                for item in (data.get('collection') or []):
                    t = item.get('track') or {}
                    if not t.get('permalink_url'):
                        continue
                    user = t.get('user') or {}
                    results.append({
                        'url': t.get('permalink_url', ''),
                        'title': t.get('title', ''),
                        'artist': user.get('username', ''),
                        'duration': int((t.get('duration') or 0) / 1000),
                        'thumbUrl': _sc_pick_track_thumb(t),
                        'source': 'soundcloud',
                        'scId': str(t.get('id') or ''),
                        'uploaderUrl': user.get('permalink_url', ''),
                        'likedAt': _sc_iso_to_ms(item.get('created_at')),
                    })
                nxt = data.get('next_href')
                if not nxt:
                    break
                next_url = nxt  # next_href уже содержит client_id
                next_params = {}
            ctx.emit({'status': 'ok', 'results': results})
        except ScUnauthorizedError:
            ctx.emit({'status': 'unauthorized', 'message': 'HTTP 401'})
        except Exception as e:
            print(f"[error] sc_liked_tracks: {e}", file=sys.stderr)
            ctx.emit({'status': 'error', 'message': str(e)})

    def sc_liked_meta(self, request, ctx):
        # Дешево: общее число SC-лайков + первые id (для сверки без полной загрузки).
        token = request.get('token', '')
        if not token:
            ctx.emit({'status': 'error', 'message': 'Missing SoundCloud token'})
            return
        try:
            me = self.get('/me', {}, oauth_token=token)
            uid = (me or {}).get('id')
            if not uid:
                ctx.emit({'status': 'error', 'message': 'Failed to load SoundCloud account'})
                return
            count = int((me or {}).get('likes_count') or 0)
            data = self.get(f'/users/{uid}/track_likes', {'limit': 15}, oauth_token=token)
            if data is None:
                ctx.emit({'status': 'error', 'message': 'Failed to load SoundCloud likes head'})
                return
            head_ids = []
            for item in (data.get('collection') or []):
                t = item.get('track') or {}
                if t.get('id') is not None:
                    head_ids.append(str(t['id']))
            ctx.emit({'status': 'ok', 'count': count, 'headIds': head_ids})
        except ScUnauthorizedError:
            ctx.emit({'status': 'unauthorized', 'message': 'HTTP 401'})
        except Exception as e:
            print(f"[error] sc_liked_meta: {e}", file=sys.stderr)
            ctx.emit({'status': 'error', 'message': str(e)})

    def sc_wave_stations(self, request, ctx):
        # Курируемые станции SoundCloud (жанровые подборки из mixed-selections).
        # С токеном - региональные/персональные подборки как в залогиненном вебе.
        token = request.get('token', '')
        try:
            data = self.get('/mixed-selections', {'limit': 6}, oauth_token=token or None)
            stations = []
            seen = set()
            for sel in ((data or {}).get('collection') or []):
                urn = sel.get('urn') or ''
                # Только «Trending by genre» - там подборки лучше, чем editorial/charts.
                if 'trending-by-genre' not in urn:
                    continue
                for pl in ((sel.get('items') or {}).get('collection') or []):
                    title = pl.get('title') or ''
                    pid = pl.get('id')
                    art = pl.get('artwork_url')
                    # Только плейлисты (у них есть track_count и обложка), пропускаем артистов.
                    if not title or pid is None or pl.get('track_count') is None or not art:
                        continue
                    if pid in seen:
                        continue
                    seen.add(pid)
                    stations.append({
                        'id': str(pid),
                        'title': title,
                        'thumbUrl': _sc_pick_thumb(art),
                    })
            ctx.emit({'status': 'ok', 'stations': stations})
        except ScUnauthorizedError:
            ctx.emit({'status': 'unauthorized', 'message': 'HTTP 401'})
        except Exception as e:
            print(f"[error] sc_wave_stations: {e}", file=sys.stderr)
            ctx.emit({'status': 'error', 'message': str(e)})

    def sc_station_tracks(self, request, ctx):
        # Треки станции (плейлиста) через api-v2: /playlists/{id} -> ids -> /tracks?ids (быстро).
        sid = request.get('id', '')
        token = request.get('token', '')
        try:
            results = []
            if sid:
                pl = self.get(f'/playlists/{sid}', {'representation': 'full'}, oauth_token=token or None)
                ids = [str(t.get('id')) for t in ((pl or {}).get('tracks') or []) if t.get('id')][:50]
                full = self.get('/tracks', {'ids': ','.join(ids)}, oauth_token=token or None) if ids else []
                # /tracks?ids отдает в произвольном порядке - восстанавливаем порядок плейлиста.
                by_id = {str(t.get('id')): t for t in (full or []) if t and t.get('id') is not None}
                for tid in ids:
                    t = by_id.get(tid)
                    if not t or not t.get('permalink_url'):
                        continue
                    user = t.get('user') or {}
                    results.append({
                        'url': t.get('permalink_url', ''),
                        'title': t.get('title', ''),
                        'artist': user.get('username', ''),
                        'duration': int((t.get('duration') or 0) / 1000),
                        'thumbUrl': _sc_pick_track_thumb(t),
                        'source': 'soundcloud',
                        'scId': str(t.get('id') or ''),
                        'uploaderUrl': user.get('permalink_url', ''),
                    })
            ctx.emit({'status': 'ok', 'results': results})
        except ScUnauthorizedError:
            ctx.emit({'status': 'unauthorized', 'message': 'HTTP 401'})
        except Exception as e:
            print(f"[error] sc_station_tracks: {e}", file=sys.stderr)
            ctx.emit({'status': 'error', 'message': str(e)})

    def sc_recommendations(self, request, ctx):
        # SC-радио от трека: api-v2 /tracks/{id}/related (с oauth_token - персонализировано).
        token = request.get('token', '')
        sc_id = request.get('scId', '')
        track_url = request.get('url', '')
        try:
            tid = sc_id or _sc_extract_track_id(track_url)
            if not tid and track_url:
                resolved = self.get('/resolve', {'url': track_url}, oauth_token=token or None)
                tid = (resolved or {}).get('id')
            results = []
            if tid:
                data = self.get(f'/tracks/{tid}/related', {'limit': 25}, oauth_token=token or None)
                for t in ((data or {}).get('collection') or []):
                    if not t or not t.get('permalink_url'):
                        continue
                    user = t.get('user') or {}
                    results.append({
                        'url': t.get('permalink_url', ''),
                        'title': t.get('title', ''),
                        'artist': user.get('username', ''),
                        'duration': int((t.get('duration') or 0) / 1000),  # api-v2 отдает мс
                        'thumbUrl': _sc_pick_track_thumb(t),
                        'source': 'soundcloud',
                        'scId': str(t.get('id') or ''),
                        'uploaderUrl': user.get('permalink_url', ''),
                    })
            ctx.emit({'status': 'ok', 'results': results})
        except ScUnauthorizedError:
            ctx.emit({'status': 'unauthorized', 'message': 'HTTP 401'})
        except Exception as e:
            print(f"[error] sc_recommendations: {e}", file=sys.stderr)
            ctx.emit({'status': 'error', 'message': str(e)})

    def get_soundcloud_playlist(self, request, ctx):
        # SoundCloud плейлист: api-v2 /playlists/{id} или /resolve(url)
        url = request.get('url', '')
        try:
            # Resolve playlist URL to get ID
            resolved = self.get('/resolve', {'url': url})
            if not resolved:
                ctx.emit({'status': 'error', 'message': 'Playlist not found'})
            else:
                playlist_id = resolved.get('id')
                # Fetch full playlist with tracks
                data = self.get(f'/playlists/{playlist_id}', {'representation': 'full'})
                tracks = []
                for t in (data or {}).get('tracks') or []:
                    if not t or not t.get('permalink_url'):
                        continue
                    tuser = t.get('user') or {}
                    tracks.append({
                        'url': t.get('permalink_url', ''),
                        'title': t.get('title', ''),
                        'artist': tuser.get('username', ''),
                        'duration': int((t.get('duration') or 0) / 1000),
                        'thumbUrl': _sc_pick_track_thumb(t),
                        'source': 'soundcloud',
                        'scId': str(t.get('id') or ''),
                        'uploaderUrl': tuser.get('permalink_url', ''),
                        'plays': t.get('playback_count', 0),
                        'likes': t.get('likes_count', 0),
                    })
                ctx.emit({
                    'status': 'ok',
                    'title': (data or {}).get('title', ''),
                    'description': (data or {}).get('description', ''),
                    'thumbUrl': _sc_pick_track_thumb(data or {}, resolved.get('user') if isinstance(resolved, dict) else None),
                    'trackCount': len(tracks),
                    'tracks': tracks,
                })
        except Exception as e:
            print(f"[error] get_soundcloud_playlist: {e}", file=sys.stderr)
            ctx.emit({'status': 'error', 'message': str(e)})

    def resolve_sc_track(self, request, ctx):
        url = request.get('url', '')
        try:
            data = self.get('/resolve', {'url': url})
            if not data or data.get('kind') != 'track':
                ctx.emit({'status': 'error', 'message': 'Not a SC track'})
                return
            user = data.get('user') or {}
            ctx.emit({
                'status': 'ok',
                'title': data.get('title', ''),
                'artist': user.get('username', ''),
                'duration': int((data.get('duration') or 0) / 1000),
                'thumbUrl': _sc_pick_track_thumb(data),
                'scId': str(data.get('id') or ''),
                'uploaderUrl': user.get('permalink_url', ''),
            })
        except Exception as e:
            print(f"[error] resolve_sc_track: {e}", file=sys.stderr)
            ctx.emit({'status': 'error', 'message': str(e)})
