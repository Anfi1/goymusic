"""Search, artists, albums and tracks from the YouTube Music catalog."""
from ytmusicapi.navigation import (
    CAROUSEL_TITLE, NAVIGATION_BROWSE_ID, SECTION_LIST, SINGLE_COLUMN_TAB, TITLE, TITLE_TEXT, nav,
)

from .account import playlist_to_dict
from .formatting import _extract_badge_label, album_to_dict, artist_to_dict, clean_duration, track_to_dict


def get_search_suggestions(request, ctx):
    api = ctx.get_api()
    query = request.get('query')
    suggestions = api.get_search_suggestions(query)
    ctx.emit({'status': 'ok', 'suggestions': suggestions})


def search(request, ctx):
    api = ctx.get_api()
    query = request.get('query')
    raw = api.search(query, limit=40)
    correction = None
    if isinstance(raw, dict):
        correction = raw.get('correction')
        raw = raw.get('results', [])
    top_result = None
    tracks, artists, albums, playlists = [], [], [], []
    for item in raw:
        cat = item.get('category', '')
        rt = item.get('resultType', '')
        if cat == 'Top result':
            b_id = item.get('browseId') or ''
            if rt == 'album' and item.get('videoId'):
                rt = 'song'
            elif rt == 'album' and b_id.startswith('UC'):
                rt = 'artist'
            if rt in ['song', 'video']:
                top_result = track_to_dict(item)
            elif rt == 'artist':
                top_result = artist_to_dict(item)
            elif rt == 'album':
                top_result = album_to_dict(item)
            elif rt == 'playlist':
                top_result = playlist_to_dict(ctx.get_api, item, skip_owner_check=True)
            if top_result:
                top_result['resultType'] = rt
        elif rt in ['song', 'video']:
            t = track_to_dict(item)
            if t and len(tracks) < 12:
                tracks.append(t)
        elif rt == 'artist':
            a = artist_to_dict(item)
            if a and len(artists) < 8:
                artists.append(a)
        elif rt == 'album':
            a = album_to_dict(item)
            if a and len(albums) < 8:
                albums.append(a)
        elif rt == 'playlist':
            p = playlist_to_dict(ctx.get_api, item, skip_owner_check=True)
            if p and len(playlists) < 5:
                playlists.append(p)

    # Cross-reference: fill missing album names from tracks/albums that have both albumId and name
    album_name_map = {}
    for t in tracks:
        aid = t.get('albumId')
        aname = t.get('album', '')
        if aid and aname:
            album_name_map[aid] = aname
    if top_result and top_result.get('albumId') and top_result.get('album'):
        album_name_map[top_result['albumId']] = top_result['album']
    for a in albums:
        aid = a.get('id', '')
        aname = a.get('title', '')
        if aid and aname:
            album_name_map[aid] = aname
    for t in tracks:
        if t.get('albumId') and not t.get('album'):
            t['album'] = album_name_map.get(t['albumId'], '')
    if top_result and top_result.get('albumId') and not top_result.get('album'):
        top_result['album'] = album_name_map.get(top_result['albumId'], '')
    ctx.emit({'status': 'ok', 'results': {
        'top': top_result, 'correction': correction,
        'tracks': tracks, 'artists': artists, 'albums': albums, 'playlists': playlists
    }})


def search_more(request, ctx):
    api = ctx.get_api()
    query = request.get('query')
    offset = request.get('offset', 0)
    search_filter = request.get('filter', 'songs')
    limit = request.get('limit', 20)
    results = api.search(query, filter=search_filter, limit=offset + limit)
    more_results = results[offset:] if len(results) > offset else []

    if search_filter == 'artists': items = [artist_to_dict(a) for a in more_results if artist_to_dict(a)]
    elif search_filter == 'albums': items = [album_to_dict(a) for a in more_results if album_to_dict(a)]
    elif search_filter == 'playlists': items = [playlist_to_dict(ctx.get_api, p) for p in more_results if playlist_to_dict(ctx.get_api, p)]
    else: items = [track_to_dict(s) for s in more_results if track_to_dict(s)]

    ctx.emit({'status': 'ok', 'items': items})


def get_artist(request, ctx):
    api = ctx.get_api()
    artist_id = request.get('artistId')

    # 1. Делаем сырой запрос для ручного парсинга
    body = {"browseId": artist_id}
    raw_response = api._send_request("browse", body)

    # 2. Используем либу для базы
    info = api.get_artist(artist_id)

    # Статистика и статус
    description_text = info.get('description') or ''
    subscribed = info.get('subscribed', False)
    subscribers = info.get('subscribers')
    views = info.get('views')

    # Извлекаем verified из raw_response badges
    raw_verified = False
    try:
        header = nav(raw_response, ['header', 'musicHeaderRenderer'])
        badges = header.get('badges', []) if header else []
        raw_verified = bool(_extract_badge_label(badges, 'VERIFIED'))
    except Exception:
        pass

    monthly_listeners = info.get('monthlyListeners')

    def process_media_item(item, category):
        try:
            if not item: return None
            item_id = item.get('browseId') or item.get('videoId') or item.get('playlistId') or item.get('id')
            if not item_id: return None

            # Извлекаем thumbUrl: либо готовый, либо из списка thumbnails
            res_thumb = item.get('thumbUrl', '')
            if not res_thumb and item.get('thumbnails'):
                res_thumb = item['thumbnails'][-1]['url']

            return {
                'id': item_id,
                'title': item.get('title') or item.get('name'),
                'name': item.get('name') or item.get('title'),
                'year': item.get('year') or item.get('type') or '',
                'category': category,
                'thumbUrl': res_thumb,
                'videoId': item.get('videoId'),
                'playlistId': item.get('playlistId')
            }
        except: return None

    # Базовые секции от либы
    albums_section = info.get('albums') or {}
    singles_section = info.get('singles') or {}
    videos_section = info.get('videos') or {}
    playlists_section = info.get('playlists') or {}
    songs_section = info.get('songs') or {}
    related_section = info.get('related') or {}

    # РУЧНОЙ ПАРСИНГ (Fallback)
    try:
        sections = nav(raw_response, SINGLE_COLUMN_TAB + SECTION_LIST)
        for section in sections:
            shelf = section.get('musicCarouselShelfRenderer') or section.get('musicShelfRenderer')
            if not shelf: continue

            header_text = nav(shelf, CAROUSEL_TITLE + ['text'], True) or nav(shelf, ['title', 'runs', 0, 'text'], True)
            if not header_text: continue

            header_text = header_text.lower()

            is_video = any(x in header_text for x in ['видео', 'video'])
            is_related = any(x in header_text for x in ['похож', 'related', 'fans also like'])
            is_playlist = any(x in header_text for x in ['плейлист', 'playlist'])

            if is_video or is_related or is_playlist:
                contents = shelf.get('contents', [])
                results = []
                for c in contents:
                    # YouTube использует TwoRowItemRenderer для каруселей!
                    data = c.get('musicTwoRowItemRenderer') or c.get('musicTwoColumnItemRenderer') or c.get('musicResponsiveListItemRenderer')
                    if not data: continue

                    item_id = nav(data, ['navigationEndpoint', 'browseEndpoint', 'browseId'], True) or \
                              nav(data, ['navigationEndpoint', 'watchEndpoint', 'videoId'], True) or \
                              nav(data, ['navigationEndpoint', 'watchEndpoint', 'playlistId'], True)

                    if not item_id: continue

                    item_title = nav(data, TITLE_TEXT, True) or nav(data, ['title', 'runs', 0, 'text'], True)
                    item_thumb = nav(data, ['thumbnailRenderer', 'musicThumbnailRenderer', 'thumbnail', 'thumbnails', -1, 'url'], True) or \
                                 nav(data, ['thumbnail', 'thumbnails', -1, 'url'], True)

                    results.append({
                        'id': item_id,
                        'title': item_title,
                        'name': item_title,
                        'thumbUrl': item_thumb,
                        'videoId': nav(data, ['navigationEndpoint', 'watchEndpoint', 'videoId'], True),
                        'playlistId': nav(data, ['navigationEndpoint', 'watchEndpoint', 'playlistId'], True),
                        'subscribers': nav(data, ['subtitle', 'runs', 0, 'text'], True) if is_related else None
                    })

                if results:
                    if is_video:
                        videos_section['results'] = results
                        videos_section['browseId'] = nav(shelf, TITLE + NAVIGATION_BROWSE_ID, True)
                    elif is_related:
                        related_section['results'] = results
                    elif is_playlist:
                        playlists_section['results'] = results
                        playlists_section['browseId'] = nav(shelf, TITLE + NAVIGATION_BROWSE_ID, True)
    except: pass

    # Собираем превью
    albums_preview = [process_media_item(item, 'Album') for item in albums_section.get('results', []) if process_media_item(item, 'Album')]
    singles_preview = [process_media_item(item, 'Single') for item in singles_section.get('results', []) if process_media_item(item, 'Single')]
    videos_preview = [process_media_item(item, 'Video') for item in videos_section.get('results', []) if process_media_item(item, 'Video')]
    playlists_preview = [process_media_item(item, 'Playlist') for item in playlists_section.get('results', []) if process_media_item(item, 'Playlist')]

    related = []
    for r in related_section.get('results', []):
        item_id = r.get('browseId') or r.get('id')
        if item_id:
            related.append({
                'id': item_id,
                'name': r.get('title') or r.get('name'),
                'thumbUrl': r.get('thumbUrl') or (r['thumbnails'][-1]['url'] if r.get('thumbnails') else ''),
                'subscribers': r.get('subscribers')
            })

    top_songs = [track_to_dict(s) for s in songs_section.get('results', []) if track_to_dict(s)]

    ctx.emit({
        'status': 'ok',
        'name': info.get('name'),
        'description': description_text,
        'thumbUrl': info['thumbnails'][-1]['url'] if info.get('thumbnails') else '',
        'channelId': info.get('channelId'),
        'subscribed': subscribed,
        'subscribers': subscribers,
        'monthlyListeners': monthly_listeners,
        'views': views,
        'topSongs': top_songs,
        'artistPro': False,
        'verified': raw_verified,
        'albumsPreview': albums_preview,
        'albumsId': albums_section.get('browseId'),
        'albumsParams': albums_section.get('params'),

        'singlesPreview': singles_preview,
        'singlesId': singles_section.get('browseId'),
        'singlesParams': singles_section.get('params'),

        'videosPreview': videos_preview,
        'videosId': videos_section.get('browseId'),

        'playlistsPreview': playlists_preview,
        'playlistsId': playlists_section.get('browseId'),

        'related': related,
        'seeAllSongsId': songs_section.get('browseId'),
        'seeAllSongsParams': songs_section.get('params'),
    })


def get_artist_songs(request, ctx):
    browse_id = request.get('browseId')
    params = request.get('params')
    continuation = request.get('continuation')
    api = ctx.get_api()

    if browse_id.startswith('VL') or browse_id.startswith('PL'):
        if continuation:
            response = api._send_request("browse", {"continuation": continuation})
            from ytmusicapi.continuations import get_continuation_token, CONTINUATION_ITEMS
            from ytmusicapi.parsers.playlists import parse_playlist_items

            continuation_items = nav(response, CONTINUATION_ITEMS, True)
            if not continuation_items:
                ctx.emit({'status': 'ok', 'tracks': [], 'continuation': None})
                return

            tracks = [track_to_dict(t) for t in parse_playlist_items(continuation_items) if track_to_dict(t)]
            next_token = get_continuation_token(continuation_items)

            ctx.emit({
                'status': 'ok',
                'tracks': tracks,
                'continuation': next_token,
            })
        else:
            playlist = api.get_playlist(browse_id, limit=50)
            tracks = [track_to_dict(t) for t in playlist.get('tracks', []) if track_to_dict(t)]
            ctx.emit({
                'status': 'ok',
                'tracks': tracks,
                'continuation': playlist.get('continuation'),
            })
    else:
        results = api.get_artist_albums(browse_id, params)
        items = []
        for item in results:
            if item.get('videoId'):
                d = track_to_dict(item)
            else:
                d = album_to_dict(item)
            if d: items.append(d)
        ctx.emit({'status': 'ok', 'tracks': items, 'continuation': None})


def get_track_info(request, ctx):
    api = ctx.get_api()
    info = api.get_song(request.get('videoId'))
    ctx.emit({'status': 'ok', 'info': info})


def get_album(request, ctx):
    api = ctx.get_api()
    album_id = request.get('albumId')

    # Base info from library (now includes likeStatus, pinning tokens, etc.)
    album = api.get_album(album_id)
    res_album_id = album.get('browseId') or album_id
    album_thumb = album['thumbnails'][-1]['url'] if album.get('thumbnails') else ''
    artists_data = album.get('artists', [])
    tracks = [track_to_dict(t, album_name=album.get('title'), album_id=res_album_id, thumb_url=album_thumb) for t in album.get('tracks', []) if track_to_dict(t)]

    ctx.emit({
        'status': 'ok',
        'id': res_album_id,
        'title': album.get('title'),
        'type': album.get('type'),
        'thumbUrl': album_thumb,
        'artists': [a.get('name') for a in artists_data],
        'artistIds': [a.get('id') for a in artists_data],
        'year': album.get('year'),
        'duration': clean_duration(album.get('duration')),
        'trackCount': album.get('trackCount', len(tracks)),
        'audioPlaylistId': album.get('audioPlaylistId'),
        'likeStatus': album.get('likeStatus'),
        'menu_tokens': album.get('menu_tokens'),
        'isPinned': album.get('isPinned'),
        'owned': album.get('owned', False),
        'tracks': tracks,
    })
