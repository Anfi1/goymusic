"""Library, likes, subscriptions, playlist browsing and playlist edits."""
import sys

from ytmusicapi.navigation import SINGLE_COLUMN_TAB, nav
from ytmusicapi.parsers.playlists import parse_liked_continuation

from .account import fetch_account_info, playlist_to_dict
from .formatting import clean_duration, parse_watch_video_renderer, track_to_dict

SECTION_LIST_ITEM = ['sectionListRenderer', 'contents', 0]


def get_playlists(request, ctx):
    api = ctx.get_api()
    playlists = api.get_library_playlists(limit=100)
    formatted = []
    for p in playlists:
        d = playlist_to_dict(ctx.get_api, p)
        if d:
            formatted.append(d)
    ctx.emit({'status': 'ok', 'playlists': formatted})


def _liked_tracks(playlist):
    tracks = [track_to_dict(t) for t in playlist['tracks']]
    if any(t is None for t in tracks):
        raise ValueError('Could not format a Liked Songs track')
    return tracks


def get_liked_songs(request, ctx):
    api = ctx.get_api()
    limit = request.get('limit')
    liked = api.get_liked_songs(limit=limit)
    tracks = _liked_tracks(liked)
    ctx.emit({
        'status': 'ok',
        'id': 'LM',
        'audioPlaylistId': 'LM',
        'tracks': tracks,
        'trackCount': liked.get('trackCount', len(tracks)),
        'unavailableCount': liked['unavailableCount'],
        'continuation': liked.get('continuation'),
        'owned': True,
        'privacy': 'PRIVATE',
    })


def get_continuation(request, ctx):
    token = request.get('token')
    api = ctx.get_api()

    liked = request.get('liked') is True
    if liked and (not isinstance(token, str) or not token.strip()):
        raise ValueError('Missing Liked Songs continuation token')
    # YouTube Music continuation request
    response = api._send_request("browse", {"continuation": token})
    if liked:
        page = parse_liked_continuation(response)
        page['tracks'] = _liked_tracks(page)
        ctx.emit({'status': 'ok', **page})
        return

    # Extract items and next token
    from ytmusicapi.continuations import get_continuation_token, CONTINUATION_ITEMS
    from ytmusicapi.parsers.playlists import parse_playlist_items

    continuation_items = nav(response, CONTINUATION_ITEMS, True)
    if not continuation_items:
        ctx.emit({'status': 'ok', 'tracks': [], 'continuation': None})
        return

    parsed = parse_playlist_items(continuation_items)
    tracks = [row for t in parsed if (row := track_to_dict(t))]
    next_token = get_continuation_token(continuation_items)

    ctx.emit({
        'status': 'ok',
        'tracks': tracks,
        'unavailableCount': sum('musicResponsiveListItemRenderer' in row for row in continuation_items)
                            - sum(bool(track.get('videoId')) for track in parsed),
        'continuation': next_token,
    })


def get_playlist_tracks(request, ctx):
    playlist_id = request.get('playlistId')
    limit = request.get('limit')
    api = ctx.get_api()

    try:
        if playlist_id and (playlist_id.startswith('RD') or playlist_id.startswith('VLRD')):
            pid = playlist_id[2:] if playlist_id.startswith('VL') else playlist_id
            data = api.get_watch_playlist(playlistId=pid, limit=limit or 50)
            tracks = [track_to_dict(t) for t in data.get('tracks', []) if track_to_dict(t)]
            ctx.emit({
                'status': 'ok',
                'tracks': tracks,
                'trackCount': len(tracks),
            })
        elif playlist_id and playlist_id.startswith('MPLA'):
            continuation = request.get('continuation')
            from ytmusicapi.parsers.playlists import parse_playlist_items
            if continuation:
                params = f"&ctoken={continuation}&continuation={continuation}"
                response = api._send_request('browse', {'browseId': playlist_id}, params)
                cont_contents = nav(response, ['continuationContents', 'musicShelfContinuation'], True) or {}
                raw_tracks = cont_contents.get('contents', [])
                conts = cont_contents.get('continuations', [])
                next_c = conts[0].get('nextContinuationData', {}).get('continuation') if conts else None
                tracks = [track_to_dict(t) for t in parse_playlist_items(raw_tracks) if track_to_dict(t)]
                ctx.emit({
                    'status': 'ok',
                    'tracks': tracks,
                    'continuation': next_c,
                })
            else:
                response = api._send_request('browse', {'browseId': playlist_id})
                shelf = nav(response, [*SINGLE_COLUMN_TAB, *SECTION_LIST_ITEM, 'musicShelfRenderer'], True) or {}
                contents = shelf.get('contents', [])
                conts = shelf.get('continuations', [])
                next_c = conts[0].get('nextContinuationData', {}).get('continuation') if conts else None
                tracks = [track_to_dict(t) for t in parse_playlist_items(contents) if track_to_dict(t)]
                header_title = nav(response, ['header', 'musicHeaderRenderer', 'title', 'runs', 0, 'text'], True) or "Liked Tracks"
                ctx.emit({
                    'status': 'ok',
                    'tracks': tracks,
                    'title': header_title,
                    'trackCount': len(tracks),
                    'continuation': next_c,
                })
        else:
            # The local fork returns one browse shelf + its cursor for limit=None.
            # LM must never use a playback queue as the account's list of likes.
            is_liked = playlist_id in ('LM', 'VLLM')
            playlist = api.get_liked_songs(limit=None) if is_liked else api.get_playlist(playlist_id, limit=limit)
            tracks = _liked_tracks(playlist) if is_liked else [row for t in playlist['tracks'] if (row := track_to_dict(t))]

            author_data = playlist.get('author')
            author = None
            if isinstance(author_data, dict):
                author = {
                    'name': author_data.get('name'),
                    'id': author_data.get('id') or author_data.get('browseId')
                }
            elif isinstance(author_data, str):
                author = {'name': author_data, 'id': None}

            ctx.emit({
                'status': 'ok',
                'tracks': tracks,
                'title': playlist.get('title'),
                'description': playlist.get('description'),
                'author': author,
                'owned': playlist.get('owned', False),
                'privacy': playlist.get('privacy'),
                'year': playlist.get('year'),
                'duration': clean_duration(playlist.get('duration')),
                'duration_seconds': playlist.get('duration_seconds'),
                'thumbUrl': playlist.get('thumbnails')[-1].get('url') if playlist.get('thumbnails') else '',
                'trackCount': playlist.get('trackCount') if is_liked else playlist.get('trackCount', len(tracks)),
                'unavailableCount': playlist.get('unavailableCount', 0),
                'audioPlaylistId': playlist.get('audioPlaylistId'),
                'likeStatus': playlist.get('likeStatus'),
                'menu_tokens': playlist.get('menu_tokens'),
                'isPinned': playlist.get('isPinned'),
                'continuation': playlist.get('continuation'),
            })
    except Exception as e:
        if playlist_id in ('LM', 'VLLM'):
            raise
        try:
            pid = playlist_id[2:] if playlist_id.startswith('VL') else playlist_id
            data = api.get_watch_playlist(playlistId=pid, limit=limit or 50)
            tracks = [track_to_dict(t) for t in data.get('tracks', []) if track_to_dict(t)]
            if tracks:
                ctx.emit({'status': 'ok', 'tracks': tracks, 'trackCount': len(tracks)})
                return
        except: pass

        print(f"Error fetching playlist {playlist_id}: {e}", file=sys.stderr)
        ctx.emit({'status': 'error', 'message': str(e)})


def get_library(request, ctx):
    api = ctx.get_api()
    try:
        tab = request.get('tab', 'playlists')
        limit = request.get('limit', 25)
        order = request.get('order')

        items = []
        if tab == 'playlists':
            raw_items = api.get_library_playlists(limit=limit)
            for item in raw_items:
                p_id = item.get('playlistId') or item.get('browseId')
                al = item.get('artists', [])
                items.append({
                    'id': p_id,
                    'playlistId': p_id,
                    'type': 'playlist',
                    'title': item.get('title'),
                    'artists': [a.get('name') for a in al] if isinstance(al, list) else [],
                    'thumbUrl': item['thumbnails'][-1]['url'] if item.get('thumbnails') else '',
                    'count': item.get('count'),
                    'description': item.get('description'),
                })
        elif tab == 'albums':
            raw_items = api.get_library_albums(limit=limit, order=order)
            for item in raw_items:
                b_id = item.get('browseId')
                al = item.get('artists', [])
                items.append({
                    'id': b_id or item.get('playlistId'),
                    'browseId': b_id,
                    'type': 'album',
                    'title': item.get('title'),
                    'artists': [a.get('name') for a in al] if isinstance(al, list) else [],
                    'artistIds': [a.get('id') for a in al] if isinstance(al, list) else [],
                    'thumbUrl': item['thumbnails'][-1]['url'] if item.get('thumbnails') else '',
                    'year': item.get('year'),
                    'audioPlaylistId': item.get('playlistId'),
                })
        elif tab == 'artists':
            raw_items = api.get_library_artists(limit=limit, order=order if order != 'most_songs' else None)
            for item in raw_items:
                b_id = item.get('browseId') or item.get('id') or ''
                channel_id = b_id[4:] if b_id.startswith('MPLAUC') else (b_id[4:] if b_id.startswith('MPLA') else b_id)
                sub_text = str(item.get('subscribers') or '').strip()
                sub_text = sub_text.replace('треков', 'tracks').replace('трека', 'tracks').replace('трек', 'track')
                if sub_text.isdigit():
                    sub_text = f"{sub_text} {'track' if sub_text == '1' else 'tracks'}"
                items.append({
                    'id': b_id if b_id.startswith('MPLA') else channel_id,
                    'playlistId': b_id if b_id.startswith('MPLA') else None,
                    'artistId': channel_id,
                    'type': 'playlist' if b_id.startswith('MPLA') else 'artist',
                    'title': item.get('artist') or item.get('title') or item.get('name'),
                    'description': sub_text,
                    'subscribers': sub_text,
                    'thumbUrl': item['thumbnails'][-1]['url'] if item.get('thumbnails') else '',
                })
        elif tab == 'subscriptions':
            raw_items = api.get_library_subscriptions(limit=limit)
            for item in raw_items:
                b_id = item.get('browseId') or item.get('id') or ''
                channel_id = b_id[4:] if b_id.startswith('MPLAUC') else (b_id[4:] if b_id.startswith('MPLA') else b_id)
                sub_text = (item.get('subscribers') or '').replace('треков', 'tracks').replace('трека', 'tracks').replace('трек', 'track')
                items.append({
                    'id': channel_id,
                    'type': 'artist',
                    'title': item.get('artist') or item.get('title') or item.get('name'),
                    'description': sub_text,
                    'subscribers': sub_text,
                    'thumbUrl': item['thumbnails'][-1]['url'] if item.get('thumbnails') else '',
                })
        elif tab == 'songs':
            raw_items = api.get_library_songs(limit=limit, order=order)
            tracks_raw = raw_items.get('tracks', []) if isinstance(raw_items, dict) else (raw_items or [])
            for track in tracks_raw:
                v_id = track.get('videoId') or track.get('id')
                if v_id:
                    al = track.get('artists', [])
                    items.append({
                        'id': v_id,
                        'videoId': v_id,
                        'type': 'song',
                        'title': track.get('title'),
                        'artists': [a.get('name') if isinstance(a, dict) else str(a) for a in al] if isinstance(al, list) else [],
                        'artistIds': [a.get('id') for a in al if isinstance(a, dict) and a.get('id')] if isinstance(al, list) else [],
                        'thumbUrl': track['thumbnails'][-1]['url'] if track.get('thumbnails') else '',
                        'duration': track.get('duration'),
                        'album': track.get('album', {}).get('name') if isinstance(track.get('album'), dict) else '',
                        'albumId': track.get('album', {}).get('id') if isinstance(track.get('album'), dict) else None,
                        'likeStatus': track.get('likeStatus') or 'INDIFFERENT',
                    })

        ctx.emit({'status': 'ok', 'tab': tab, 'items': items})
    except Exception as e:
        ctx.emit({'status': 'error', 'message': str(e)})


def shuffle_library_songs(request, ctx):
    api = ctx.get_api()
    try:
        body = {
            'playlistId': 'MLCT',
            'params': 'wAEB8gECKAE=',
            'isAudioOnly': True,
            'tunerSettingValue': 'AUTOMIX_SETTING_NORMAL',
            'enablePersistentPlaylistPanel': True
        }
        response = api._send_request('next', body)
        def find_all_video_renderers(obj):
            items = []
            if isinstance(obj, dict):
                if 'playlistPanelVideoRenderer' in obj:
                    items.append(obj['playlistPanelVideoRenderer'])
                for v in obj.values():
                    items.extend(find_all_video_renderers(v))
            elif isinstance(obj, list):
                for el in obj:
                    items.extend(find_all_video_renderers(el))
            return items
        raw_renderers = find_all_video_renderers(response)
        tracks = [parse_watch_video_renderer(r) for r in raw_renderers if parse_watch_video_renderer(r)]
        ctx.emit({'status': 'ok', 'tracks': tracks, 'audioPlaylistId': 'MLCT'})
    except Exception as e:
        ctx.emit({'status': 'error', 'message': str(e)})


def subscribe_artist(request, ctx):
    api = ctx.get_api()
    # YouTube требует channelId, который отличается от browseId артиста
    res = api.subscribe_artists([request.get('channelId')])
    ctx.emit({'status': 'ok', 'result': res})


def unsubscribe_artist(request, ctx):
    api = ctx.get_api()
    res = api.unsubscribe_artists([request.get('channelId')])
    ctx.emit({'status': 'ok', 'result': res})


def get_user_info(request, ctx):
    account = fetch_account_info(ctx.get_api)
    name = (account.get('accountName') or account.get('name') or account.get('userName') or "Account")
    thumb = account.get('accountPhotoUrl')
    if not thumb and account.get('thumbnails'):
        if isinstance(account['thumbnails'], list) and len(account['thumbnails']) > 0:
            thumb = account['thumbnails'][-1].get('url')
        elif isinstance(account['thumbnails'], dict):
            thumb = account['thumbnails'].get('url')
    ctx.emit({'status': 'ok', 'name': name, 'thumbUrl': thumb or ''})


def rate_song(request, ctx):
    api = ctx.get_api()
    res = api.rate_song(request.get('videoId'), request.get('status'))
    ctx.emit({'status': 'ok', 'result': res})


def rate_playlist(request, ctx):
    api = ctx.get_api()
    res = api.rate_playlist(request.get('playlistId'), request.get('status'))
    ctx.emit({'status': 'ok', 'result': res})


def create_playlist(request, ctx):
    api = ctx.get_api()
    # Создаем приватный плейлист по умолчанию
    res = api.create_playlist(
        title=request.get('title'),
        description='',
        privacy_status='PRIVATE',
        video_ids=request.get('videoIds')
    )
    # Если создание успешно, устанавливаем флаг добавления в начало (addToTop)
    if isinstance(res, str):
        api.edit_playlist(res, addToTop=True)
    ctx.emit({'status': 'ok', 'playlistId': res})


def delete_playlist(request, ctx):
    api = ctx.get_api()
    res = api.delete_playlist(request.get('playlistId'))
    ctx.emit({'status': 'ok', 'result': res})


def edit_playlist(request, ctx):
    api = ctx.get_api()
    move_item = request.get('moveItem')
    if isinstance(move_item, list):
        move_item = tuple(move_item)

    res = api.edit_playlist(
        playlistId=request.get('playlistId'),
        title=request.get('title'),
        description=request.get('description'),
        privacyStatus=request.get('privacyStatus'),
        moveItem=move_item, # (setVideoId, beforeSetVideoId)
        addToTop=request.get('addToTop')
    )
    ctx.emit({'status': 'ok', 'result': res})


def add_playlist_items(request, ctx):
    api = ctx.get_api()
    playlist_id = request.get('playlistId')
    # Перед добавлением убеждаемся, что плейлист настроен на добавление в начало
    try:
        api.edit_playlist(playlist_id, addToTop=True)
    except: pass

    res = api.add_playlist_items(
        playlistId=playlist_id,
        videoIds=request.get('videoIds'),
        duplicates=request.get('duplicates', False)
    )
    ctx.emit({'status': 'ok', 'result': res})


def remove_playlist_items(request, ctx):
    api = ctx.get_api()
    res = api.remove_playlist_items(
        playlistId=request.get('playlistId'),
        videos=request.get('videos') # List of {videoId, setVideoId}
    )
    ctx.emit({'status': 'ok', 'result': res})


def send_feedback(request, ctx):
    api = ctx.get_api()
    res = api._send_request('feedback', {'feedbackTokens': [request.get('token')]})
    ctx.emit({'status': 'ok', 'success': True, 'result': res})
