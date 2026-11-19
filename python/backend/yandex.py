"""Yandex Music catalog, library, radio and playback commands."""
import sys
import time

import requests


def yandex_track_dict(t):
    """Трек yandex_music.Track -> тот же плоский формат, что и SC-треки (sc_* команды),
    только source='yandex' и yandexId вместо scId."""
    artists = getattr(t, 'artists', None) or []
    albums = getattr(t, 'albums', None) or []
    album = albums[0] if albums else None
    album_id = album.id if album else None
    artist_id = artists[0].id if artists else None
    cover_uri = getattr(t, 'cover_uri', None) or getattr(t, 'og_image', None)
    # У треков из радио/волны (rotor) cover_uri трека часто пустой -- в отличие от
    # полного tracks()-ответа (поиск/лайки/плейлисты), где он почти всегда есть.
    # Обложка альбома (albums[0]) заполнена гораздо надёжнее -- используем как фолбэк.
    if not cover_uri and album:
        cover_uri = getattr(album, 'cover_uri', None) or getattr(album, 'og_image', None)
    thumb = ('https://' + cover_uri.replace('%%', '400x400')) if cover_uri else ''
    # Громкость Яндекс отдаёт в поле r128 (EBU R 128): i -- интегрированная громкость
    # в LUFS, tp -- true peak. Это ровно та же пара, что считает ffmpeg loudnorm, так что
    # формула совпадает с measure_loudness_full (цель -14 LUFS, при усилении не даём
    # пикам вылезти выше -1 dBTP). Поле normalization, на которое смотрели раньше, у
    # живого API всегда пустое -- из-за этого каждый трек уезжал на фоновый ffmpeg-замер
    # и нормализация наезжала с задержкой. r128 приходит на всех эндпоинтах (трек,
    # альбом, поиск, лайки, волна), поэтому фолбэк на замер остаётся лишь страховкой.
    r128 = getattr(t, 'r128', None)
    loudness = None
    if r128 is not None and getattr(r128, 'i', None) is not None:
        loudness = r128.i + 14.0
        tp = getattr(r128, 'tp', None)
        if loudness < 0 and tp is not None:
            loudness = max(loudness, tp + 1.0)
    return {
        'yandexId': str(t.id),
        'title': t.title or '',
        'artist': artists[0].name if artists else '',
        'artistId': str(artist_id) if artist_id else None,
        'duration': int((getattr(t, 'duration_ms', 0) or 0) / 1000),
        'thumbUrl': thumb,
        'source': 'yandex',
        'album': album.title if album and album.title else '',
        'albumId': str(album_id) if album_id else None,
        'url': (f'https://music.yandex.ru/album/{album_id}/track/{t.id}' if album_id else ''),
        'loudness': loudness,
        'best': bool(getattr(t, 'best', False)),
        'artists': [a.name for a in artists],
        'artistIds': [str(a.id) for a in artists],
    }


def yandex_liked_tracks(request, ctx):
    try:
        client = ctx.get_yandex_client()
        if not client:
            ctx.emit({'status': 'error', 'message': 'not authenticated'})
        else:
            likes = client.users_likes_tracks()
            shorts = likes.tracks if likes else []
            ids = [str(s.id) for s in shorts]
            full = []
            for i in range(0, len(ids), 500):
                full.extend((client.tracks(ids[i:i + 500]) if ids[i:i + 500] else []) or [])
            by_id = {str(t.id): t for t in full if t}
            results = []
            for s in shorts:
                t = by_id.get(str(s.id))
                if not t:
                    continue
                d = yandex_track_dict(t)
                d['likedAt'] = s.timestamp
                results.append(d)
            ctx.emit({'status': 'ok', 'results': results})
    except Exception as e:
        print(f"[error] yandex_liked_tracks: {e}", file=sys.stderr)
        ctx.emit({'status': 'error', 'message': str(e)})


def yandex_set_liked(request, ctx):
    track_id = request.get('yandexId', '')
    liked = request.get('liked', True)
    try:
        client = ctx.get_yandex_client()
        if not client:
            ctx.emit({'status': 'error', 'message': 'not authenticated'})
        else:
            if liked:
                client.users_likes_tracks_add(track_id)
            else:
                client.users_likes_tracks_remove(track_id)
            ctx.emit({'status': 'ok', 'liked': liked})
    except Exception as e:
        print(f"[error] yandex_set_liked: {e}", file=sys.stderr)
        ctx.emit({'status': 'error', 'message': str(e)})


def yandex_liked_albums(request, ctx):
    try:
        client = ctx.get_yandex_client()
        if not client:
            ctx.emit({'status': 'error', 'message': 'not authenticated'})
        else:
            results = []
            for item in (client.users_likes_albums() or []):
                a = getattr(item, 'album', None)
                if not a:
                    continue
                artists = getattr(a, 'artists', None) or []
                cover_uri = getattr(a, 'cover_uri', None) or getattr(a, 'og_image', None)
                results.append({
                    'albumId': str(a.id),
                    'title': a.title or '',
                    'thumbUrl': ('https://' + cover_uri.replace('%%', '400x400')) if cover_uri else '',
                    'artist': artists[0].name if artists else '',
                    'artists': [x.name for x in artists],
                    'artistIds': [str(x.id) for x in artists],
                    'year': getattr(a, 'year', None),
                    'trackCount': getattr(a, 'track_count', None),
                })
            ctx.emit({'status': 'ok', 'results': results})
    except Exception as e:
        print(f"[error] yandex_liked_albums: {e}", file=sys.stderr)
        ctx.emit({'status': 'error', 'message': str(e)})


def yandex_liked_artists(request, ctx):
    try:
        client = ctx.get_yandex_client()
        if not client:
            ctx.emit({'status': 'error', 'message': 'not authenticated'})
        else:
            results = []
            for item in (client.users_likes_artists() or []):
                ar = getattr(item, 'artist', None)
                if not ar:
                    continue
                thumb = ''
                try:
                    if getattr(ar, 'cover', None):
                        thumb = ar.cover.get_url(size='400x400')
                except Exception:
                    pass
                results.append({
                    'artistId': str(ar.id),
                    'name': ar.name or '',
                    'thumbUrl': thumb,
                })
            ctx.emit({'status': 'ok', 'results': results})
    except Exception as e:
        print(f"[error] yandex_liked_artists: {e}", file=sys.stderr)
        ctx.emit({'status': 'error', 'message': str(e)})


def yandex_wave_stations(request, ctx):
    # Персональный дашборд станций (как на странице радио в Яндекс.Музыке) --
    # "Моя волна" + жанровые/настроенческие станции, а не одна фиксированная.
    try:
        client = ctx.get_yandex_client()
        if not client:
            ctx.emit({'status': 'error', 'message': 'not authenticated'})
        else:
            dash = client.rotor_stations_dashboard()
            stations = []
            seen = set()
            for item in ((dash.stations if dash else []) or []):
                st = item.station
                if not st or not st.id:
                    continue
                sid = f'{st.id.type}:{st.id.tag}'
                if sid in seen:
                    continue
                seen.add(sid)
                # full_image_url -- широкие цветные карточки станций (как на сайте
                # Яндекс.Музыки), приоритетный источник обложки; icon.get_url() -- фолбэк,
                # маленькая иконка, когда full_image_url не заполнен.
                fu = st.full_image_url
                thumb = ('https://' + fu.replace('%%', '400x400')) if fu else ''
                if not thumb:
                    try:
                        if st.icon:
                            thumb = st.icon.get_url('400x400')
                    except Exception:
                        pass
                stations.append({
                    'id': sid,
                    'title': item.custom_name or st.name or sid,
                    'thumbUrl': thumb,
                })
            ctx.emit({'status': 'ok', 'stations': stations})
    except Exception as e:
        print(f"[error] yandex_wave_stations: {e}", file=sys.stderr)
        ctx.emit({'status': 'error', 'message': str(e)})


def yandex_wave_tracks(request, ctx):
    # Треки конкретной станции (id вида "user:onyourwave", "genre:rock" и т.п.
    # -- см. yandex_wave_stations) через rotor API.
    station = request.get('station') or 'user:onyourwave'
    # rotor отдаёт ровно 5 треков за запрос; следующая порция берётся с queue=<id
    # последнего трека>, поэтому batches>1 склеивает несколько порций (соседние
    # порции частично пересекаются -- дедуплицируем по id).
    queue_from = request.get('queue') or None
    try:
        batches = max(1, min(int(request.get('batches') or 1), 5))
    except (TypeError, ValueError):
        batches = 1
    try:
        client = ctx.get_yandex_client()
        if not client:
            ctx.emit({'status': 'error', 'message': 'not authenticated'})
        else:
            results = []
            seen = set()
            cursor = queue_from
            batch_id = None
            for _ in range(batches):
                res = client.rotor_station_tracks(station, queue=cursor) if cursor else client.rotor_station_tracks(station)
                seq = (res.sequence if res else None) or []
                if not seq:
                    break
                added = 0
                last_id = None
                for item in seq:
                    t = item.track
                    if not t:
                        continue
                    last_id = str(t.id)
                    if last_id in seen:
                        continue
                    seen.add(last_id)
                    results.append(yandex_track_dict(t))
                    added += 1
                if added == 0 or not last_id:
                    break
                cursor = last_id
                if batch_id is None:
                    batch_id = getattr(res, 'batch_id', None)
            ctx.emit({'status': 'ok', 'results': results, 'batchId': batch_id})
    except Exception as e:
        print(f"[error] yandex_wave_tracks: {e}", file=sys.stderr)
        ctx.emit({'status': 'error', 'message': str(e)})


def yandex_recommendations(request, ctx):
    # Радио от трека -- похожие треки (аналог sc_recommendations).
    track_id = request.get('yandexId', '')
    try:
        client = ctx.get_yandex_client()
        if not client:
            ctx.emit({'status': 'error', 'message': 'not authenticated'})
        else:
            sim = client.tracks_similar(track_id)
            results = [yandex_track_dict(t) for t in ((sim.similar_tracks if sim else []) or [])]
            ctx.emit({'status': 'ok', 'results': results})
    except Exception as e:
        print(f"[error] yandex_recommendations: {e}", file=sys.stderr)
        ctx.emit({'status': 'error', 'message': str(e)})


def yandex_new_releases(request, ctx):
    try:
        client = ctx.get_yandex_client()
        if not client:
            ctx.emit({'status': 'error', 'message': 'not authenticated'})
        else:
            landing = client.new_releases()
            album_ids = ((landing.new_releases if landing else []) or [])[:30]
            albums = client.albums(album_ids) if album_ids else []
            results = []
            for a in albums:
                if not a:
                    continue
                artists = getattr(a, 'artists', None) or []
                cover_uri = getattr(a, 'cover_uri', None) or getattr(a, 'og_image', None)
                thumb = ('https://' + cover_uri.replace('%%', '400x400')) if cover_uri else ''
                results.append({
                    'albumId': str(a.id),
                    'title': a.title or '',
                    'artist': artists[0].name if artists else '',
                    'artists': [ar.name for ar in artists],
                    'artistIds': [str(ar.id) for ar in artists],
                    'thumbUrl': thumb,
                    'year': getattr(a, 'year', None),
                    'trackCount': getattr(a, 'track_count', None),
                })
            ctx.emit({'status': 'ok', 'results': results})
    except Exception as e:
        print(f"[error] yandex_new_releases: {e}", file=sys.stderr)
        ctx.emit({'status': 'error', 'message': str(e)})


def yandex_home_genres(request, ctx):
    try:
        client = ctx.get_yandex_client()
        if not client:
            ctx.emit({'status': 'error', 'message': 'not authenticated'})
        else:
            allowed = {
                'pop', 'allrock', 'indie', 'metal', 'alternative', 'dance', 'electronics',
                'rap', 'rnb', 'jazz', 'blues', 'reggae', 'ska', 'punk', 'folk', 'estrada',
                'shanson', 'country', 'soundtrack', 'relax', 'children', 'classicalmusic',
                'naturesounds', 'bard',
            }
            genres = client.genres() or []
            results = []
            for g in genres:
                if g.id not in allowed:
                    continue
                images = getattr(g, 'images', None)
                raw = (getattr(images, '_300x300', None) or getattr(images, '_208x208', None)) if images else None
                if not raw:
                    # у части метажанров (allrock и т.п.) images: null -- берём обложку первого поджанра
                    for sub in (getattr(g, 'sub_genres', None) or []):
                        sub_images = getattr(sub, 'images', None)
                        raw = (getattr(sub_images, '_300x300', None) or getattr(sub_images, '_208x208', None)) if sub_images else None
                        if raw:
                            break
                thumb = raw.replace('http://', 'https://') if raw else ''
                results.append({'id': g.id, 'title': g.title or '', 'thumbUrl': thumb})
            ctx.emit({'status': 'ok', 'results': results})
    except Exception as e:
        print(f"[error] yandex_home_genres: {e}", file=sys.stderr)
        ctx.emit({'status': 'error', 'message': str(e)})


def yandex_genre_stations(request, ctx):
    genre = request.get('genre', '')
    try:
        client = ctx.get_yandex_client()
        if not client:
            ctx.emit({'status': 'error', 'message': 'not authenticated'})
        else:
            tag_map = {
                'pop': ['pop'], 'allrock': ['rock'], 'indie': ['indie'], 'metal': ['metal'],
                'alternative': ['alternative'], 'dance': ['dance', 'house', 'techno', 'disco', 'club'],
                'electronics': ['electron', 'dubstep', 'ambient', 'idm', 'dnb'],
                'rap': ['rap', 'hiphop', 'grime'], 'rnb': ['rnb', 'soul', 'funk'], 'jazz': ['jazz'],
                'blues': ['blues'], 'reggae': ['reggae'], 'ska': ['ska'], 'punk': ['punk'],
                'folk': ['folk'], 'estrada': ['estrada'], 'shanson': ['shanson', 'chanson'],
                'country': ['country'],
                'soundtrack': ['film', 'soundtrack', 'musical', 'cinema', 'movie'],
                'relax': ['relax', 'lounge', 'meditation', 'sleep', 'calm', 'chill'],
                'children': ['kids', 'lullaby', 'child'],
                'classicalmusic': ['classic', 'neoclass', 'orchestra', 'symphony', 'piano'],
                'naturesounds': ['nature', 'rain', 'sea', 'ocean', 'forest'],
                'bard': ['bard'],
            }
            needles = tag_map.get(genre, [])
            results = []
            if needles:
                stations = client.rotor_stations_list(language='ru') or []
                for item in stations:
                    st = item.station
                    if not st or not st.id or st.id.type != 'genre':
                        continue
                    tag = (st.id.tag or '').lower()
                    if not any(n in tag for n in needles):
                        continue
                    fu = st.full_image_url
                    thumb = ('https://' + fu.replace('%%', '400x400')) if fu else ''
                    if not thumb:
                        try:
                            if st.icon:
                                thumb = st.icon.get_url('400x400')
                        except Exception:
                            pass
                    results.append({'id': f'genre:{st.id.tag}', 'title': st.name or st.id.tag, 'thumbUrl': thumb})
                    if len(results) >= 50:
                        break
            ctx.emit({'status': 'ok', 'results': results})
    except Exception as e:
        print(f"[error] yandex_genre_stations: {e}", file=sys.stderr)
        ctx.emit({'status': 'error', 'message': str(e)})


def yandex_new_playlists(request, ctx):
    results = []
    try:
        client = ctx.get_yandex_client()
        if client:
            landing_list = client.new_playlists()
            pids = (getattr(landing_list, 'new_playlists', None) or [])
            ids_str = [f'{p.uid}:{p.kind}' for p in pids if p.uid and p.kind]
            pls_list = client.playlists(ids_str) if ids_str else None
            playlists = (getattr(pls_list, 'playlists', None) or [])
            for pl in playlists:
                thumb = ''
                try:
                    if pl.cover:
                        thumb = pl.cover.get_url(size='400x400')
                except Exception:
                    pass
                if not thumb and pl.og_image:
                    thumb = 'https://' + pl.og_image.replace('%%', '400x400')
                results.append({
                    'id': str(pl.kind),
                    'ownerId': str(pl.uid) if pl.uid else '',
                    'title': pl.title or '',
                    'thumbUrl': thumb,
                    'trackCount': pl.track_count,
                })
    except Exception as e:
        print(f"[error] yandex_new_playlists: {e}", file=sys.stderr)
    ctx.emit({'status': 'ok', 'results': results})


def yandex_album_tracks(request, ctx):
    album_id = request.get('albumId', '')
    try:
        client = ctx.get_yandex_client()
        if not client:
            ctx.emit({'status': 'error', 'message': 'not authenticated'})
        else:
            album = client.albums_with_tracks(album_id)
            results = []
            if album and album.volumes:
                for vol in album.volumes:
                    for t in vol:
                        results.append(yandex_track_dict(t))
            cover_uri = getattr(album, 'cover_uri', None) if album else None
            thumb = ('https://' + cover_uri.replace('%%', '400x400')) if cover_uri else ''
            album_artists = (getattr(album, 'artists', None) if album else None) or []
            liked = False
            try:
                likes = client.users_likes_albums(album_ids=[int(album_id)])
                liked = any(str(getattr(li.album, 'id', '')) == str(album_id) for li in (likes or []) if li.album)
            except Exception:
                liked = False
            # Тип релиза как у самого Яндекса: single с одним треком -- сингл,
            # single с несколькими -- EP. Раньше в шапке всегда стояло ALBUM.
            raw_type = (getattr(album, 'type', None) or '').lower() if album else ''
            if raw_type == 'single':
                album_type = 'SINGLE' if len(results) <= 1 else 'EP'
            elif raw_type == 'compilation':
                album_type = 'COMPILATION'
            else:
                album_type = 'ALBUM'
            ctx.emit({
                'status': 'ok',
                'title': (album.title if album else ''),
                'albumType': album_type,
                'artist': album_artists[0].name if album_artists else '',
                'artists': [a.name for a in album_artists],
                'artistIds': [str(a.id) for a in album_artists],
                'artistId': str(album_artists[0].id) if album_artists else '',
                'thumbUrl': thumb,
                'year': getattr(album, 'year', None) if album else None,
                'liked': liked,
                'results': results,
            })
    except Exception as e:
        print(f"[error] yandex_album_tracks: {e}", file=sys.stderr)
        ctx.emit({'status': 'error', 'message': str(e)})


def yandex_album_like(request, ctx):
    album_id = request.get('albumId', '')
    liked = bool(request.get('liked'))
    try:
        client = ctx.get_yandex_client()
        if not client:
            ctx.emit({'status': 'error', 'message': 'not authenticated'})
        else:
            if liked:
                client.users_likes_albums_add([int(album_id)])
            else:
                client.users_likes_albums_remove([int(album_id)])
            ctx.emit({'status': 'ok', 'liked': liked})
    except Exception as e:
        print(f"[error] yandex_album_like: {e}", file=sys.stderr)
        ctx.emit({'status': 'error', 'message': str(e)})


def yandex_play_audio(request, ctx):
    # /play-audio -- то, чем клиенты Яндекса отчитываются о прослушивании:
    # пополняет историю, счётчики прослушиваний и влияет на рекомендации.
    try:
        client = ctx.get_yandex_client()
        if not client:
            ctx.emit({'status': 'error', 'message': 'not authenticated'})
        else:
            ok = client.play_audio(
                track_id=request.get('yandexId', ''),
                from_=request.get('from') or 'desktop_win',
                album_id=request.get('albumId') or '',
                playlist_id=request.get('playlistId') or None,
                play_id=request.get('playId') or None,
                track_length_seconds=int(request.get('duration') or 0),
                total_played_seconds=int(request.get('played') or 0),
                end_position_seconds=int(request.get('endPosition') or 0),
            )
            ctx.emit({'status': 'ok', 'ok': bool(ok)})
    except Exception as e:
        print(f"[error] yandex_play_audio: {e}", file=sys.stderr)
        ctx.emit({'status': 'error', 'message': str(e)})


def yandex_rotor_feedback(request, ctx):
    # Обратная связь станции (radioStarted/trackStarted/trackFinished/skip).
    # Без неё rotor не двигает цепочку: следующий запрос треков возвращает
    # почти ту же пятёрку, а «Моя волна» не подстраивается под слушателя.
    try:
        client = ctx.get_yandex_client()
        if not client:
            ctx.emit({'status': 'error', 'message': 'not authenticated'})
        else:
            # client.rotor_station_feedback() шлёт form-data, а эндпоинт принимает
            # только JSON и на форму отвечает 400 "condition is not met" -- поэтому
            # запрос собираем руками поверх токена клиента.
            played = request.get('played')
            station = request.get('station', '')
            body = {
                'type': request.get('type', ''),
                'timestamp': time.time(),
                'from': request.get('from') or 'desktop_win',
            }
            if request.get('yandexId'):
                body['trackId'] = str(request.get('yandexId'))
            if played is not None:
                body['totalPlayedSeconds'] = float(played)
            params = {}
            if request.get('batchId'):
                params['batch-id'] = request.get('batchId')
            resp = requests.post(
                f'https://api.music.yandex.net/rotor/station/{station}/feedback',
                headers={
                    'Authorization': f'OAuth {client.token}',
                    'X-Yandex-Music-Client': 'YandexMusicAndroid/24023621',
                },
                params=params,
                json=body,
                timeout=10,
            )
            ok = resp.status_code == 200
            if not ok:
                print(f"[yandex] rotor feedback {body.get('type')} -> {resp.status_code} {resp.text[:200]}", file=sys.stderr)
            ctx.emit({'status': 'ok', 'ok': ok})
    except Exception as e:
        print(f"[error] yandex_rotor_feedback: {e}", file=sys.stderr)
        ctx.emit({'status': 'error', 'message': str(e)})


def yandex_stream_url(request, ctx):
    # Прямая ссылка живёт ~1 минуту с момента получения -- не кэшировать надолго.
    track_id = request.get('yandexId', '')
    try:
        client = ctx.get_yandex_client()
        if not client:
            ctx.emit({'status': 'error', 'message': 'not authenticated'})
        else:
            infos = client.tracks_download_info(track_id, get_direct_links=True)
            if not infos:
                ctx.emit({'status': 'error', 'message': 'no download info'})
            else:
                best = sorted(infos, key=lambda i: (i.codec != 'mp3', -i.bitrate_in_kbps))[0]
                link = best.direct_link or best.get_direct_link()
                # Прямая ссылка живёт ~60с с момента получения -- отдаём короткий
                # запас, чтобы фронт не полагался на общий getExpirationFromUrl().
                ctx.emit({
                    'status': 'ok',
                    'url': link,
                    'expires': int(time.time()) + 45,
                    'bitrate': best.bitrate_in_kbps,
                    'codec': best.codec,
                })
    except Exception as e:
        print(f"[error] yandex_stream_url: {e}", file=sys.stderr)
        ctx.emit({'status': 'error', 'message': str(e)})


def yandex_artist(request, ctx):
    artist_id = request.get('artistId', '')
    try:
        client = ctx.get_yandex_client()
        if not client:
            ctx.emit({'status': 'error', 'message': 'not authenticated'})
        else:
            # brief-info -- один запрос вместо artists()+artists_tracks(): даёт ещё
            # stats.last_month_listeners (прослушивания), playlists (плейлисты с артистом),
            # albums (дискография) и similar_artists (похожие) -- то же, что видно на сайте.
            info = client.artists_brief_info(artist_id)
            artist = info.artist if info else None
            pop_tracks = (info.popular_tracks if info else []) or []
            # Превью -- top-5, как у YT/SC; полный список для "See all" -- отдельным
            # запросом (у brief-info popular_tracks урезан и не годится под модалку).
            top_tracks = [yandex_track_dict(t) for t in pop_tracks[:5]]
            all_page = client.artists_tracks(artist_id, page_size=50)
            all_tracks = [yandex_track_dict(t) for t in ((all_page.tracks if all_page else []) or [])]
            if not all_tracks:
                all_tracks = top_tracks
            cover = getattr(artist, 'cover', None) if artist else None
            thumb = ''
            try:
                if cover:
                    thumb = cover.get_url(size='400x400')
            except Exception:
                pass
            artist_og = getattr(artist, 'og_image', None) if artist else None
            if not thumb and artist_og:
                thumb = ('https://' + artist_og.replace('%%', '400x400'))
            playlists = []
            for pl in ((info.playlists if info else []) or []):
                pl_cover = getattr(pl, 'cover', None)
                pl_thumb = ''
                try:
                    if pl_cover:
                        pl_thumb = pl_cover.get_url(size='400x400')
                except Exception:
                    pass
                owner = getattr(pl, 'owner', None)
                owner_id = getattr(pl, 'uid', None) or (getattr(owner, 'uid', None) if owner else None)
                pl_og = getattr(pl, 'og_image', None)
                if not pl_thumb and pl_og:
                    pl_thumb = ('https://' + pl_og.replace('%%', '400x400'))
                playlists.append({
                    'id': str(pl.kind),
                    'ownerId': str(owner_id) if owner_id is not None else '',
                    'title': pl.title or '',
                    'thumbUrl': pl_thumb,
                    'trackCount': pl.track_count,
                })
            albums = []
            direct_albums = []
            try:
                da = client.artists_direct_albums(artist_id)
                direct_albums = (da.albums if da else []) or []
            except Exception:
                direct_albums = []
            album_src = direct_albums if direct_albums else ((info.albums if info else []) or [])
            for al in album_src[:30]:
                al_cover_uri = getattr(al, 'cover_uri', None) or getattr(al, 'og_image', None)
                al_thumb = ('https://' + al_cover_uri.replace('%%', '400x400')) if al_cover_uri else ''
                albums.append({
                    'albumId': str(al.id),
                    'title': al.title or '',
                    'thumbUrl': al_thumb,
                    'year': getattr(al, 'year', None),
                    'type': getattr(al, 'type', None),
                })
            related = []
            for sa in ((info.similar_artists if info else []) or []):
                sa_cover = getattr(sa, 'cover', None)
                sa_thumb = ''
                try:
                    if sa_cover:
                        sa_thumb = sa_cover.get_url(size='400x400')
                except Exception:
                    pass
                sa_og = getattr(sa, 'og_image', None)
                if not sa_thumb and sa_og:
                    sa_thumb = ('https://' + sa_og.replace('%%', '400x400'))
                related.append({
                    'id': str(sa.id),
                    'name': sa.name or '',
                    'thumbUrl': sa_thumb,
                })
            stats = getattr(info, 'stats', None) if info else None
            ctx.emit({
                'status': 'ok',
                'name': artist.name if artist else '',
                'thumbUrl': thumb,
                'tracks': top_tracks,
                'allTracks': all_tracks,
                'monthlyListeners': stats.last_month_listeners if stats else None,
                'playlists': playlists,
                'albums': albums,
                'related': related,
            })
    except Exception as e:
        print(f"[error] yandex_artist: {e}", file=sys.stderr)
        ctx.emit({'status': 'error', 'message': str(e)})


def yandex_playlists(request, ctx):
    # Собственные плейлисты пользователя (для "Коллекций" в режиме Yandex).
    try:
        client = ctx.get_yandex_client()
        if not client:
            ctx.emit({'status': 'error', 'message': 'not authenticated'})
        else:
            playlists = client.users_playlists_list() or []
            results = []
            for pl in playlists:
                thumb = ''
                try:
                    if pl.cover:
                        thumb = pl.cover.get_url(size='400x400')
                except Exception:
                    pass
                results.append({
                    'id': str(pl.kind),
                    'title': pl.title or '',
                    'thumbUrl': thumb,
                    'trackCount': pl.track_count,
                })
            ctx.emit({'status': 'ok', 'results': results})
    except Exception as e:
        print(f"[error] yandex_playlists: {e}", file=sys.stderr)
        ctx.emit({'status': 'error', 'message': str(e)})


def yandex_playlist_tracks(request, ctx):
    kind = request.get('kind', '')
    owner_id = request.get('ownerId') or None
    try:
        client = ctx.get_yandex_client()
        if not client:
            ctx.emit({'status': 'error', 'message': 'not authenticated'})
        else:
            pl = client.users_playlists(kind, user_id=owner_id)
            if isinstance(pl, list):
                pl = pl[0] if pl else None
            results = []
            if pl:
                shorts = pl.fetch_tracks() or []
                ids = [str(s.id) for s in shorts]
                full = client.tracks(ids) if ids else []
                by_id = {str(t.id): t for t in full if t}
                for s in shorts:
                    t = by_id.get(str(s.id))
                    if t:
                        results.append(yandex_track_dict(t))
            ctx.emit({
                'status': 'ok',
                'title': (pl.title if pl else ''),
                'results': results,
            })
    except Exception as e:
        print(f"[error] yandex_playlist_tracks: {e}", file=sys.stderr)
        ctx.emit({'status': 'error', 'message': str(e)})


def yandex_search(request, ctx):
    # Поиск треков в Yandex Music (для гибрид-подмешивания от YT/SC-сида).
    query = request.get('query', '')
    try:
        client = ctx.get_yandex_client()
        if not client:
            ctx.emit({'status': 'error', 'message': 'not authenticated'})
        else:
            res = client.search(query, type_='track')
            tracks = (res.tracks.results if res and res.tracks else []) or []
            results = [yandex_track_dict(t) for t in tracks[:25]]
            ctx.emit({'status': 'ok', 'results': results})
    except Exception as e:
        print(f"[error] yandex_search: {e}", file=sys.stderr)
        ctx.emit({'status': 'error', 'message': str(e)})
