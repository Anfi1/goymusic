"""Convert YTMusic browse and watch renderers to the public track/card shapes."""
import re
import sys

from ytmusicapi.navigation import nav


def parse_watch_video_renderer(item):
    v_id = item.get('videoId')
    if not v_id: return None
    title = nav(item, ['title', 'runs', 0, 'text'], True) or ''
    byline_runs = nav(item, ['longBylineText', 'runs'], True) or []
    artists = []
    artist_ids = []
    album = ''
    album_id = None
    for run in byline_runs:
        text = run.get('text', '')
        b_id = nav(run, ['navigationEndpoint', 'browseEndpoint', 'browseId'], True)
        p_type = nav(run, ['navigationEndpoint', 'browseEndpoint', 'browseEndpointContextSupportedConfigs', 'browseEndpointContextMusicConfig', 'pageType'], True)
        if p_type == 'MUSIC_PAGE_TYPE_ARTIST':
            artists.append(text)
            artist_ids.append(b_id)
        elif p_type == 'MUSIC_PAGE_TYPE_ALBUM':
            album = text
            album_id = b_id

    thumbs = nav(item, ['thumbnail', 'thumbnails'], True) or []
    thumb_url = thumbs[-1].get('url') if thumbs else ''
    duration = nav(item, ['lengthText', 'runs', 0, 'text'], True) or ''
    like_status = nav(item, ['menu', 'menuRenderer', 'topLevelButtons', 0, 'likeButtonRenderer', 'likeStatus'], True) or 'LIKE'

    return {
        'id': v_id,
        'videoId': v_id,
        'type': 'song',
        'title': title,
        'artists': artists,
        'artistIds': artist_ids,
        'album': album,
        'albumId': album_id,
        'thumbUrl': thumb_url,
        'duration': duration,
        'likeStatus': like_status
    }


def _extract_pro_badge(badges):
    """Extract PRO badge info from YouTube Music badges array."""
    if not badges:
        return None
    try:
        for badge in badges:
            if badge.get('badge_type') == 'VERIFIED_ARTIST':
                return 'pro'
    except Exception:
        pass
    return None

def _extract_badge_label(badges, label):
    """Extract a badge label from badges array."""
    if not badges:
        return None
    try:
        for badge in badges:
            badge_label = badge.get('text', {}) if isinstance(badge, dict) else {}
            if isinstance(badge_label, dict) and badge_label.get('text') == label:
                return True
    except Exception:
        pass
    return None


def track_to_dict(t, album_name=None, album_id=None, thumb_url=None, audio_playlist_id=None):
    try:
        vid = t.get('videoId') or t.get('id')
        if not vid:
            return None
        
        artists_data = t.get('artists') or []
        artist_names = [a.get('name', 'Unknown') for a in artists_data]
        artist_ids = [a.get('id') or a.get('browseId') for a in artists_data]

        t_album = t.get('album')
        t_album_name = ''
        t_album_id = None
        t_audio_playlist_id = audio_playlist_id or t.get('audioPlaylistId')
        
        if isinstance(t_album, dict):
            t_album_name = t_album.get('name', '')
            t_album_id = t_album.get('id') or t_album.get('browseId')
            if not t_audio_playlist_id:
                t_audio_playlist_id = t_album.get('audioPlaylistId')
        elif isinstance(t_album, str):
            t_album_name = t_album

        res_album_name = album_name or t_album_name
        res_album_id = album_id or t_album_id
        
        if not res_album_id:
            nav_ep = t.get('navigationEndpoint', {})
            if nav_ep.get('browseEndpoint', {}).get('browseId', '').startswith('MPREb'):
                res_album_id = nav_ep['browseEndpoint']['browseId']

        res_playlist_id = t.get('playlistId')

        res_thumb = ''
        thumbs = t.get('thumbnails') or t.get('thumbnail')
        if thumbs:
            res_thumb = thumbs[-1].get('url')
        elif thumb_url:
            res_thumb = thumb_url
        elif isinstance(t_album, dict) and t_album.get('thumbnails'):
            res_thumb = t_album['thumbnails'][-1].get('url')

        return {
            'id': vid,
            'title': t.get('title'),
            'artists': artist_names,
            'artistIds': artist_ids,
            'album': res_album_name,
            'albumId': res_album_id,
            'playlistId': res_playlist_id,
            'audioPlaylistId': t_audio_playlist_id,
            'params': t.get('params'),
            'duration': t.get('duration') or t.get('length') or '',
            'thumbUrl': res_thumb,
            'views': t.get('views'),
            'isAvailable': t.get('isAvailable', True),
            'likeStatus': t.get('likeStatus'),
            'menu_tokens': t.get('menu_tokens'),
            'isPinned': t.get('isPinned') or t.get('pinnedToListenAgain', False),
            'description': t.get('description'),
            'setVideoId': t.get('setVideoId'), # Essential for playlist modifications
            'source': t.get('source', 'youtube'),
        }
    except Exception as e:
        print(f"Error in track_to_dict: {e}", file=sys.stderr)
        return None

def artist_to_dict(a):
    try:
        name = a.get('artist') or a.get('name') or a.get('title')
        if not name and a.get('artists'):
            name = a['artists'][0].get('name')

        is_pro = bool(_extract_pro_badge(a.get('badges')))

        return {
            'id': a.get('browseId') or a.get('id'),
            'name': name,
            'thumbUrl': a.get('thumbnails')[-1].get('url') if a.get('thumbnails') else '',
            'views': a.get('subscribers') or a.get('views'),
            'artistPro': is_pro
        }
    except Exception:
        return None

def album_to_dict(a):
    try:
        # ВАЖНО: Для YouTube Music альбом ОБЯЗАН иметь ID, начинающийся на MPRE.
        bid = a.get('browseId') or a.get('playlistId')
        if not bid or not bid.startswith('MPRE'):
            return None

        artists_data = a.get('artists', [])
        artist_names = [art.get('name', 'Unknown') for art in artists_data]
        artist_ids = [art.get('id') or art.get('browseId') for art in artists_data]
        
        # Preserve specific type (Album, EP, Single) if available
        res_type = a.get('type') or a.get('resultType') or 'Album'

        return {
            'id': bid,
            'title': a.get('title') or a.get('name'),
            'type': res_type,
            'display_type': res_type,
            'artists': artist_names,
            'artistIds': artist_ids,
            'year': a.get('year'),
            'thumbUrl': a.get('thumbnails')[-1].get('url') if a.get('thumbnails') else '',
            'isExplicit': a.get('isExplicit', False),
            'menu_tokens': a.get('menu_tokens'),
            'isPinned': a.get('isPinned', False),
            'description': a.get('description')
        }
    except Exception:
        return None


def clean_duration(duration):
    if not duration: return duration
    # Replace Russian "больше X часов" with "> Xчасов"
    duration = re.sub(r'больше\s+(\d+)\s+часов', r'> \1часов', duration)
    # Replace English "X+ hours" with "> Xhours"
    duration = re.sub(r'(\d+)\+\s+hours', r'> \1hours', duration)
    return duration
