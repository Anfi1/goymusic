"""Home sections, new releases, mixes and queue recommendations."""
import base64
import random
import re
import sys
from urllib.parse import unquote

from ytmusicapi.navigation import MRLIR, NAVIGATION_BROWSE_ID, PLAY_BUTTON, SECTION_LIST, SINGLE_COLUMN_TAB, TITLE, TITLE_TEXT, nav
from ytmusicapi.parsers.browsing import parse_mixed_content

from .formatting import _extract_pro_badge, track_to_dict


def _home_role(row):
    shelf = row.get('musicCarouselShelfRenderer', {})
    header = nav(shelf, ['header', 'musicCarouselShelfBasicHeaderRenderer'], True) or {}
    more = nav(header, ['moreContentButton', 'buttonRenderer', 'navigationEndpoint'], True) or {}
    listen_again_id = 'FEmusic_listen_again'
    if (nav(header, TITLE + NAVIGATION_BROWSE_ID, True) == listen_again_id
            or nav(more, ['browseEndpoint', 'browseId'], True) == listen_again_id):
        return 'listen-again'

    # WEB_REMIX Quick picks: Play all seeds a mix with these exact videos, and
    # each row starts its own song radio. Neither a Play all button nor a
    # radio menu item by itself identifies this shelf. shelfId is per response.
    watch = more.get('watchEndpoint') or {}
    params = watch.get('params')
    rows = shelf.get('contents', [])
    if not isinstance(params, str) or len(rows) < 2:
        return None
    try:
        payload = base64.urlsafe_b64decode(unquote(params) + '===')
    except ValueError:
        return None
    # The repeated length-delimited field 5 holds 11-byte video IDs.
    seeds = re.findall(rb'\x2a\x0b([a-zA-Z0-9_-]{11})', payload)
    if len(seeds) != len(rows) or seeds[0].decode() != watch.get('videoId'):
        return None
    for seed, item in zip(seeds, rows):
        video_id = seed.decode()
        play = nav(item, [MRLIR, *PLAY_BUTTON, 'playNavigationEndpoint', 'watchEndpoint'], True) or {}
        if play.get('videoId') != video_id or play.get('playlistId') != 'RDAMVM' + video_id:
            return None
    return 'quick-picks'


def _build_formatted_section(section):
    """Format a raw ytmusicapi home section into the frontend dict format. Returns None if empty."""
    items = []
    content_types = set()
    for item in section.get('contents', []):
        if not item:
            continue
        b_id = item.get('browseId')
        p_id = item.get('playlistId')
        v_id = item.get('videoId')
        res_type = item.get('type') or item.get('resultType')
        m_album_id = item.get('albumId')
        m_playlist_id = item.get('playlistId')

        if v_id:
            detected_type = 'song'
        elif b_id:
            if b_id.startswith(('UC', 'Fv')):
                detected_type = 'artist'
            elif b_id.startswith(('PL', 'VL')):
                detected_type = 'playlist'
            else:
                detected_type = 'album'
        elif p_id:
            detected_type = 'playlist'
        else:
            detected_type = res_type or 'unknown'

        nav_type = detected_type.lower() if detected_type else 'unknown'
        if nav_type in ['ep', 'single', 'album']:
            nav_type = 'album'
        content_types.add(nav_type)

        if nav_type in ['song', 'video']:
            d = track_to_dict(item, album_id=m_album_id)
            if d:
                d.update({'type': nav_type, 'display_type': res_type or 'Song', 'menu_tokens': item.get('menu_tokens'), 'isPinned': item.get('isPinned'), 'description': item.get('description')})
                if m_album_id: d['albumId'] = m_album_id
                if m_playlist_id: d['playlistId'] = m_playlist_id
                items.append(d)
        elif nav_type == 'artist':
            is_pro = bool(_extract_pro_badge(item.get('badges')))
            items.append({'id': b_id, 'type': 'artist', 'display_type': 'Artist', 'title': item.get('title') or item.get('name'), 'thumbUrl': item['thumbnails'][-1]['url'] if item.get('thumbnails') else '', 'menu_tokens': item.get('menu_tokens'), 'isPinned': item.get('isPinned'), 'description': item.get('description'), 'artistPro': is_pro})
        elif nav_type == 'album':
            al = item.get('artists', [])
            audio_pid = item.get('audioPlaylistId') or item.get('playlistId')
            if audio_pid and not audio_pid.startswith('OLAK'):
                audio_pid = None
            items.append({'id': b_id or p_id, 'type': 'album', 'display_type': res_type or 'Album', 'title': item.get('title'), 'artists': [a.get('name') for a in al], 'artistIds': [a.get('id') for a in al], 'thumbUrl': item['thumbnails'][-1]['url'] if item.get('thumbnails') else '', 'year': item.get('year'), 'audioPlaylistId': audio_pid, 'playlistId': item.get('playlistId'), 'menu_tokens': item.get('menu_tokens'), 'isPinned': item.get('isPinned'), 'description': item.get('description')})
        elif nav_type == 'playlist':
            al = item.get('artists', [])
            items.append({'id': p_id or b_id, 'type': 'playlist', 'display_type': 'Playlist', 'title': item.get('title'), 'artists': [a.get('name') for a in al], 'artistIds': [a.get('id') or a.get('browseId') for a in al], 'thumbUrl': item['thumbnails'][-1]['url'] if item.get('thumbnails') else '', 'description': item.get('description'), 'menu_tokens': item.get('menu_tokens'), 'isPinned': item.get('isPinned'), 'playlistId': p_id or b_id})

    if not items:
        return None

    item_types = set(i.get('type') for i in items if i.get('type'))

    category = 'mixed'
    if len(item_types) == 1:
        category = list(item_types)[0]
    elif item_types.issubset({'song', 'video'}):
        category = 'song'
    elif 'artist' in item_types and len(item_types) <= 2:
        category = 'artist'

    return {'title': section.get('title'), 'category': category, 'contents': items}


def get_home(request, ctx):
    api = ctx.get_api()
    home_data = api.get_home(limit=request.get('limit', 10))
    formatted = [s for s in (_build_formatted_section(sec) for sec in home_data) if s]
    ctx.emit({'status': 'ok', 'data': formatted})


def get_home_sections(request, ctx):
    api = ctx.get_api()
    try:
        continuation = request.get('continuation')
        if continuation:
            params = f"&ctoken={continuation}&continuation={continuation}"
            response = api._send_request('browse', {'browseId': 'FEmusic_home'}, params)
            section_list = response.get('continuationContents', {}).get('sectionListContinuation', {})
        else:
            response = api._send_request('browse', {'browseId': 'FEmusic_home'})
            section_list = nav(response, SINGLE_COLUMN_TAB + ['sectionListRenderer'])

        # Parse each row with its own metadata: parse_mixed_content skips
        # unrecognized renderers, so zipping two lists would shift the roles.
        sections_raw = section_list.get('contents', [])
        conts = section_list.get('continuations', [])
        next_continuation = None
        if conts:
            next_continuation = (conts[0].get('nextContinuationData', {}).get('continuation')
                                 or conts[0].get('reloadContinuationData', {}).get('continuation'))

        formatted = []
        for row in sections_raw:
            for section in parse_mixed_content([row]):
                if card := _build_formatted_section(section):
                    if role := _home_role(row):
                        card['homeRole'] = role
                    formatted.append(card)
        ctx.emit({'status': 'ok', 'sections': formatted, 'continuation': next_continuation})
    except Exception as e:
        ctx.emit({'status': 'error', 'message': str(e)})


def get_explore_releases(request, ctx):
    api = ctx.get_api()
    try:
        response = api._send_request("browse", {"browseId": "FEmusic_new_releases"})
        sections = nav(response, SINGLE_COLUMN_TAB + SECTION_LIST)

        formatted_sections = []
        for section in sections:
            grid = section.get('gridRenderer') or section.get('musicCarouselShelfRenderer')
            if not grid: continue

            title = nav(grid, ['header', 'gridHeaderRenderer', 'title', 'runs', 0, 'text'], True) or \
                    nav(grid, ['title', 'runs', 0, 'text'], True) or "New Releases"

            items = grid.get('items', []) or grid.get('contents', [])
            formatted_items = []

            for item in items:
                data = item.get('musicTwoRowItemRenderer') or item.get('musicResponsiveListItemRenderer')
                if not data: continue

                b_id = nav(data, ['navigationEndpoint', 'browseEndpoint', 'browseId'], True)
                v_id = nav(data, ['navigationEndpoint', 'watchEndpoint', 'videoId'], True)
                p_id = nav(data, ['navigationEndpoint', 'watchEndpoint', 'playlistId'], True)

                # Structured artists from subtitle
                subtitle_runs = data.get('subtitle', {}).get('runs', [])
                artist_names = []
                artist_ids = []

                for run in subtitle_runs:
                    rid = nav(run, ['navigationEndpoint', 'browseEndpoint', 'browseId'], True)
                    text = run.get('text', '')
                    if rid and (rid.startswith('UC') or rid.startswith('Fv')):
                        artist_names.append(text)
                        artist_ids.append(rid)

                # Better Type Detection
                res_type = 'unknown'
                display_type = 'Album'

                # Try to get type from first subtitle run if it's not an artist
                if subtitle_runs and not nav(subtitle_runs[0], ['navigationEndpoint'], True):
                    display_type = subtitle_runs[0].get('text', 'Album')

                if v_id:
                    res_type = 'song'
                    display_type = subtitle_runs[0].get('text', 'Video') if subtitle_runs and not nav(subtitle_runs[0], ['navigationEndpoint'], True) else 'Song'
                elif b_id:
                    if b_id.startswith('MPRE'): res_type = 'album'
                    elif b_id.startswith(('UC', 'Fv')): res_type = 'artist'
                    else: res_type = 'playlist'
                elif p_id:
                    res_type = 'playlist'

                ititle = nav(data, TITLE_TEXT) or nav(data, ['title', 'runs', 0, 'text'], True)

                res_thumb = ''
                thumbs = nav(data, ['thumbnailRenderer', 'musicThumbnailRenderer', 'thumbnail', 'thumbnails'], True) or \
                         nav(data, ['thumbnail', 'thumbnails'], True)
                if thumbs: res_thumb = thumbs[-1]['url']

                formatted_items.append({
                    'id': b_id or v_id or p_id,
                    'type': res_type,
                    'display_type': display_type,
                    'title': ititle,
                    'artists': artist_names,
                    'artistIds': artist_ids,
                    'thumbUrl': res_thumb,
                    'videoId': v_id,
                    'playlistId': p_id or (b_id if res_type == 'playlist' or res_type == 'album' else None),
                    'browseId': b_id,
                    'description': "".join([r['text'] for r in subtitle_runs]) if not artist_names else None
                })

            if formatted_items:
                formatted_sections.append({
                    'title': title,
                    'items': formatted_items
                })

        ctx.emit({'status': 'ok', 'sections': formatted_sections})
    except Exception as e:
        ctx.emit({'status': 'error', 'message': str(e)})


def get_mixed_for_you(request, ctx):
    api = ctx.get_api()
    try:
        response = api._send_request('browse', {'browseId': 'FEmusic_mixed_for_you'})
        section_list = nav(response, SINGLE_COLUMN_TAB + ['sectionListRenderer'])
        grid = section_list.get('contents', [{}])[0].get('gridRenderer', {})
        mixes = []
        for item in grid.get('items', []):
            if 'musicTwoRowItemRenderer' not in item:
                continue
            idata = item['musicTwoRowItemRenderer']
            title_runs = idata.get('title', {}).get('runs', [])
            title = title_runs[0].get('text', '') if title_runs else ''
            nav_ep = idata.get('navigationEndpoint', {})
            raw_id = (nav_ep.get('browseEndpoint', {}).get('browseId')
                      or nav_ep.get('watchPlaylistEndpoint', {}).get('playlistId', ''))
            playlist_id = raw_id[2:] if raw_id.startswith('VL') else raw_id
            thumbs = nav(idata, ['thumbnailRenderer', 'musicThumbnailRenderer', 'thumbnail', 'thumbnails'], True) or []
            thumb_url = thumbs[-1]['url'] if thumbs else ''
            # Исключаем "Понравившаяся музыка" (liked songs, playlistId=LM)
            if playlist_id == 'LM':
                continue
            if title and playlist_id:
                mixes.append({'title': title, 'playlistId': playlist_id, 'thumbUrl': thumb_url})
        ctx.emit({'status': 'ok', 'mixes': mixes})
    except Exception as e:
        ctx.emit({'status': 'error', 'message': str(e)})


def get_queue_recommendations(request, ctx):
    api = ctx.get_api()
    video_id = request.get('videoId')
    playlist_id = request.get('recommendationPlaylistId')

    # Определяем лучший ID для радио
    target_playlist_id = None

    if playlist_id:
        if playlist_id.startswith(('OLAK', 'PL', 'RD', 'VL')):
            # Для любых плейлистов и альбомов используем RDAMPL префикс
            target_playlist_id = 'RDAMPL' + playlist_id
        elif not playlist_id.startswith('MPREb'):
            target_playlist_id = playlist_id

    # Если плейлиста нет, делаем радио по видео
    if not target_playlist_id and video_id:
        target_playlist_id = 'RDAMVM' + video_id

    try:
        print(f"[DEBUG] Fetching recommendations using playlistId: {target_playlist_id}", file=sys.stderr)
        # Радио по одному треку: первый ответ отдаёт ~50 позиций, limit=100 гнал
        # ещё две continuation-страницы (+1.3с) ради хвоста, до которого очередь
        # не доигрывает. Сидинг альбома/плейлиста хвост использует — там 100.
        limit = 100 if playlist_id else 50
        watch_data = api.get_watch_playlist(
            videoId=video_id,
            playlistId=target_playlist_id,
            limit=limit,
            radio=True
        )

        raw_tracks = watch_data.get('tracks', [])
        if not raw_tracks:
            # Фолбек, если специфичный ID не сработал
            watch_data = api.get_watch_playlist(videoId=video_id, limit=50, radio=True)
            raw_tracks = watch_data.get('tracks', [])

        all_tracks = [track_to_dict(t) for t in raw_tracks if track_to_dict(t)]

        # Перемешиваем ВЕСЬ список.
        # Фронтенд сам отфильтрует треки, которые уже есть в очереди,
        # поэтому мы просто гарантируем случайный порядок рекомендаций.
        if len(all_tracks) > 1:
            random.shuffle(all_tracks)

        ctx.emit({
            'status': 'ok',
            'tracks': all_tracks,
            'relatedId': watch_data.get('related'),
        })
    except Exception as e:
        print(f"[ERROR] Recommendations failed: {e}", file=sys.stderr)
        ctx.emit({'status': 'error', 'message': str(e)})


def get_song_related(request, ctx):
    api = ctx.get_api()
    browse_id = request.get('browseId')
    try:
        related_data = api.get_song_related(browse_id)
        # Парсим секции (артисты, альбомы и т.д.)
        formatted_sections = []
        for section in related_data:
            title = section.get('title')
            contents = []
            for item in section.get('contents', []):
                # Определяем тип контента
                b_id = item.get('browseId')
                v_id = item.get('videoId')
                if v_id:
                    d = track_to_dict(item)
                    if d: d['type'] = 'song'; contents.append(d)
                elif b_id:
                    if b_id.startswith('UC'):
                        contents.append({'id': b_id, 'type': 'artist', 'title': item.get('title') or item.get('name'), 'thumbUrl': item['thumbnails'][-1]['url'] if item.get('thumbnails') else ''})
                    else:
                        contents.append({'id': b_id, 'type': 'album', 'title': item.get('title'), 'thumbUrl': item['thumbnails'][-1]['url'] if item.get('thumbnails') else ''})

            if contents:
                formatted_sections.append({'title': title, 'contents': contents})

        ctx.emit({'status': 'ok', 'sections': formatted_sections})
    except Exception as e:
        ctx.emit({'status': 'error', 'message': str(e)})
