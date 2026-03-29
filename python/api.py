import sys
import os
import io

# Force using local fork - MUST BE AT THE VERY TOP
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(BASE_DIR, 'python', 'fork'))

import json
import threading
import concurrent.futures
import time
import random
import traceback
import yt_dlp
import requests
import re
import html as html_lib

from ytmusicapi import YTMusic, OAuthCredentials
from pytubefix import YouTube
from ytmusicapi.navigation import nav, SINGLE_COLUMN_TAB, SECTION_LIST, TITLE_TEXT, CAROUSEL_TITLE, TITLE, NAVIGATION_BROWSE_ID, RUN_TEXT

# Force UTF-8 for communication to handle Russian text on Windows
sys.stdin = io.TextIOWrapper(sys.stdin.buffer, encoding='utf-8')
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

# Paths
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OAUTH_FILE = os.path.join(BASE_DIR, 'oauth.json')
BROWSER_FILE = os.path.join(BASE_DIR, 'browser.json')

# Credentials (not used if using browser.json)
CLIENT_ID = None
CLIENT_SECRET = None

# Region Settings for Relevance
HL = 'ru'
GL = 'BY'

# Global state
_auth_data = None
_auth_type = None # 'browser' or 'oauth'
ytm_lock = threading.Lock()
stdout_lock = threading.Lock()

# Кеш данных аккаунта и блокировка для предотвращения двойных запросов
_ACCOUNT_CACHE = None
_account_lock = threading.Lock()

def fetch_account_info():
    global _ACCOUNT_CACHE, OWNER_ID
    with _account_lock:
        if _ACCOUNT_CACHE:
            return _ACCOUNT_CACHE
        
        try:
            api = get_api()
            # Наш форк возвращает channelId, accountName, accountPhotoUrl, channelHandle
            info = api.get_account_info()
            _ACCOUNT_CACHE = info
            
            # Сразу обновляем глобальный OWNER_ID, если он пришел
            if info.get('channelId'):
                OWNER_ID = info['channelId']
                
            return info
        except Exception as e:
            print(f"Error fetching account info: {e}", file=sys.stderr)
            return {}

# Task management
active_tasks = {} # callId -> threading.Event
tasks_lock = threading.Lock()
thread_local = threading.local()

def try_load_auth(force=False):
    global _auth_data, _auth_type
    with ytm_lock:
        if _auth_data and not force: return True
        
        if os.path.exists(BROWSER_FILE):
            try:
                with open(BROWSER_FILE, 'r') as f:
                    _auth_data = json.load(f)
                _auth_type = 'browser'
                print("Auth loaded: browser.json", file=sys.stderr)
                return True
            except Exception as e:
                print(f"Failed to load browser.json: {e}", file=sys.stderr)

        if os.path.exists(OAUTH_FILE):
            try:
                with open(OAUTH_FILE, 'r') as f:
                    _auth_data = json.load(f)
                _auth_type = 'oauth'
                print("Auth loaded: oauth.json", file=sys.stderr)
                return True
            except Exception as e:
                print(f"Failed to load oauth.json: {e}", file=sys.stderr)
        
        _auth_data = None
        _auth_type = None
        return False

def get_api():
    """Create a fresh YTMusic instance for the current task. 
    This avoids blocking other threads with ytm_lock during long requests."""
    if not _auth_data:
        try_load_auth()
    
    if not _auth_data:
        return YTMusic(language=HL, location=GL)
    
    if _auth_type == 'browser':
        return YTMusic(auth=_auth_data, language=HL, location=GL)
    else:
        token_dict = {k: v for k, v in _auth_data.items() if k not in ['client_id', 'client_secret']}
        if CLIENT_ID:
            creds = OAuthCredentials(client_id=CLIENT_ID, client_secret=CLIENT_SECRET)
            return YTMusic(auth=token_dict, oauth_credentials=creds, language=HL, location=GL)
        return YTMusic(auth=token_dict, language=HL, location=GL)

def safe_print(data):
    call_id = data.get('callId')
    if call_id:
        with tasks_lock:
            # Check if this task was cancelled
            if call_id in active_tasks and active_tasks[call_id].is_set():
                print(f"Discarding result for cancelled task {call_id}", file=sys.stderr)
                return

    with stdout_lock:
        print(json.dumps(data))
        sys.stdout.flush()

def is_cancelled():
    call_id = getattr(thread_local, 'call_id', None)
    if not call_id: return False
    with tasks_lock:
        cancelled = call_id in active_tasks and active_tasks[call_id].is_set()
        if cancelled:
            print(f"Cancellation detected for task {call_id}", file=sys.stderr)
        return cancelled

# Monkey-patch YTMusic._send_request to support cancellation
_original_send_request = YTMusic._send_request
def _patched_send_request(self, endpoint, body, additionalParams=""):
    if is_cancelled():
        raise Exception("Cancelled by client")
    return _original_send_request(self, endpoint, body, additionalParams)

YTMusic._send_request = _patched_send_request

def extract_loudness(obj):
    """Deep search for loudnessDb in a dictionary or list."""
    if isinstance(obj, str):
        try: obj = json.loads(obj)
        except: return None
        
    if isinstance(obj, dict):
        if 'loudnessDb' in obj:
            return obj['loudnessDb']
        for v in obj.values():
            res = extract_loudness(v)
            if res is not None: return res
    elif isinstance(obj, list):
        for item in obj:
            res = extract_loudness(item)
            if res is not None: return res
    return None

def track_to_dict(t, album_name=None, album_id=None, thumb_url=None, audio_playlist_id=None):
    try:
        vid = t.get('videoId') or t.get('id')
        if not vid:
            return None
        
        artists_data = t.get('artists', [])
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
            'setVideoId': t.get('setVideoId') # Essential for playlist modifications
        }
    except Exception as e:
        print(f"Error in track_to_dict: {e}", file=sys.stderr)
        return None

def artist_to_dict(a):
    try:
        name = a.get('artist') or a.get('name') or a.get('title')
        if not name and a.get('artists'):
            name = a['artists'][0].get('name')
        
        return {
            'id': a.get('browseId') or a.get('id'),
            'name': name,
            'thumbUrl': a.get('thumbnails')[-1].get('url') if a.get('thumbnails') else '',
            'views': a.get('subscribers') or a.get('views')
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

# Глобальный кеш ID владельца для проверки владения плейлистами
OWNER_ID = None

def get_owner_id():
    global OWNER_ID
    if OWNER_ID:
        return OWNER_ID
    
    # fetch_account_info автоматически обновит OWNER_ID если channelId там есть
    account = fetch_account_info()
    return OWNER_ID

def playlist_to_dict(p, skip_owner_check=False):
    try:
        p_id = p.get('playlistId') or p.get('id') or p.get('browseId')
        if not p_id:
            return None

        # Обработка автора
        author_data = p.get('author')
        author = None
        artist_names = []
        artist_ids = []

        if isinstance(author_data, list):
            author = [{'name': a.get('name'), 'id': a.get('id') or a.get('browseId')} for a in author_data]
            artist_names = [a.get('name') for a in author_data]
            artist_ids = [a.get('id') or a.get('browseId') for a in author_data]
        elif isinstance(author_data, dict):
            author = {'name': author_data.get('name'), 'id': author_data.get('id') or author_data.get('browseId')}
            artist_names = [author_data.get('name')]
            artist_ids = [author_data.get('id') or author_data.get('browseId')]
        elif isinstance(author_data, str):
            author = {'name': author_data, 'id': None}
            artist_names = [author_data]

        res_thumb = ''
        thumbs = p.get('thumbnails')
        if thumbs:
            res_thumb = thumbs[-1].get('url')

        # Определение владения и возможности добавления
        is_owned = p.get('owned', False)
        can_add = True

        # Специальные случаи
        if p_id == 'LM':
            is_owned = True
            can_add = False # В "Понравившиеся" добавляем через Like, а не через плейлист
        elif p_id.startswith('LRYR'):
            is_owned = False
            can_add = False # Рекапы нельзя редактировать

        if not skip_owner_check and not is_owned:
            # Проверяем по ID автора (использует кеш после первого вызова)
            my_id = get_owner_id()
            if my_id:
                if isinstance(author, list):
                    is_owned = any(a.get('id') == my_id for a in author)
                elif isinstance(author, dict):
                    is_owned = author.get('id') == my_id
            # Фолбек по имени — только если кеш уже есть (не делаем новый HTTP запрос)
            if not is_owned and _ACCOUNT_CACHE:
                my_name = _ACCOUNT_CACHE.get('accountName')
                if my_name:
                    if isinstance(author, list):
                        is_owned = any(a.get('name') == my_name for a in author)
                    elif isinstance(author, dict):
                        is_owned = author.get('name') == my_name

        return {
            'id': p_id,
            'title': p.get('title'),
            'author': author,
            'artists': artist_names,
            'artistIds': artist_ids,
            'itemCount': p.get('count') or p.get('itemCount'),
            'thumbUrl': res_thumb,
            'owned': is_owned,
            'can_add': can_add and is_owned, # Можно добавлять только в свои и не-системные
            'menu_tokens': p.get('menu_tokens'),
            'isPinned': p.get('isPinned', False),
            'description': p.get('description')
        }
    except Exception:
        return None

def fetch_genius_lyrics(artist, title):
    try:
        # 1. Search for the song
        search_url = "https://genius.com/api/search/multi"
        params = {"q": f"{artist} {title}"}
        headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"}
        
        r = requests.get(search_url, params=params, headers=headers, timeout=5)
        if r.status_code != 200: return None
        
        sections = r.json().get("response", {}).get("sections", [])
        song_url = None
        for section in sections:
            if section.get("type") in ["top_hit", "song"]:
                hits = section.get("hits", [])
                if hits:
                    song_url = hits[0].get("result", {}).get("url")
                    break
        
        if not song_url: return None

        # 2. Fetch the page and extract ALL containers
        r = requests.get(song_url, headers=headers, timeout=5)
        if r.status_code != 200: return None
        html_text = r.text
        
        # We find all starts of lyrics containers
        marker = 'data-lyrics-container="true"'
        parts = []
        
        for match in re.finditer(marker, html_text):
            # For each match, find the matching closing </div>
            # We start from the '<div' just before the marker
            start_search = html_text.rfind('<div', 0, match.start())
            if start_search == -1: continue
            
            # Simple balancing
            pos = start_search + 4
            depth = 1
            while depth > 0:
                next_open = html_text.find('<div', pos)
                next_close = html_text.find('</div>', pos)
                
                if next_close == -1: break # Should not happen
                
                if next_open != -1 and next_open < next_close:
                    depth += 1
                    pos = next_open + 4
                else:
                    depth -= 1
                    pos = next_close + 6
            
            # Extract content and remove the outer div
            container = html_text[start_search:pos]
            content = re.sub(r'^<div[^>]*>', '', container)
            content = re.sub(r'</div>$', '', content)
            parts.append(content)
            
        if not parts:
            # Last resort fallback for old Genius layout
            parts = re.findall(r'<div class="lyrics">(.*?)</div>', html_text, re.DOTALL)
            
        if not parts: return None
        
        # 3. Join, clean and unescape
        full_lyrics = "\n".join(parts)
        full_lyrics = re.sub(r'<br\s*/?>', '\n', full_lyrics)
        full_lyrics = re.sub(r'<.*?>', '', full_lyrics)
        
        return {"plainLyrics": html_lib.unescape(full_lyrics).strip(), "syncedLyrics": None}
    except:
        return None

def clean_duration(duration):
    if not duration: return duration
    # Replace Russian "больше X часов" with "> Xчасов"
    duration = re.sub(r'больше\s+(\d+)\s+часов', r'> \1часов', duration)
    # Replace English "X+ hours" with "> Xhours"
    duration = re.sub(r'(\d+)\+\s+hours', r'> \1hours', duration)
    return duration

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
            items.append({'id': b_id, 'type': 'artist', 'display_type': 'Artist', 'title': item.get('title') or item.get('name'), 'thumbUrl': item['thumbnails'][-1]['url'] if item.get('thumbnails') else '', 'menu_tokens': item.get('menu_tokens'), 'isPinned': item.get('isPinned'), 'description': item.get('description')})
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

    category = 'mixed'
    if len(content_types) == 1:
        category = list(content_types)[0]
    elif 'artist' in content_types and len(content_types) <= 2:
        category = 'artist'

    return {'title': section.get('title'), 'category': category, 'contents': items}


def handle_request(request):
    global _auth_data, _auth_type
    command = request.get('command')
    call_id = request.get('callId')
    
    # Handle cancellation immediately
    if command == 'cancel':
        with tasks_lock:
            if call_id in active_tasks:
                print(f"Setting cancel flag for task {call_id}", file=sys.stderr)
                active_tasks[call_id].set()
        return

    # Register task and set context
    if call_id:
        thread_local.call_id = call_id
        with tasks_lock:
            active_tasks[call_id] = threading.Event()

    try:
        if command == 'ping':
            safe_print({'status': 'ok', 'data': 'pong', 'callId': call_id})
        elif command == 'check_auth':
            try_load_auth()
            safe_print({'status': 'ok', 'authenticated': _auth_data is not None, 'callId': call_id})
        
        elif command == 'load_auth':
            success = try_load_auth(force=True)
            safe_print({'status': 'ok', 'authenticated': success, 'callId': call_id})
        
        elif command == 'get_playlists':
            api = get_api()
            playlists = api.get_library_playlists(limit=100)
            formatted = []
            for p in playlists:
                d = playlist_to_dict(p)
                if d:
                    formatted.append(d)
            safe_print({'status': 'ok', 'playlists': formatted, 'callId': call_id})

        elif command == 'get_liked_songs':
            api = get_api()
            limit = request.get('limit')
            liked = api.get_liked_songs(limit=limit)
            tracks = [track_to_dict(t) for t in liked.get('tracks', []) if track_to_dict(t)]
            safe_print({
                'status': 'ok', 
                'id': 'LM',
                'audioPlaylistId': 'LM',
                'tracks': tracks, 
                'trackCount': liked.get('trackCount', len(tracks)),
                'continuation': liked.get('continuation'),
                'owned': True,
                'privacy': 'PRIVATE',
                'callId': call_id
            })

        elif command == 'get_continuation':
            token = request.get('token')
            api = get_api()
            
            # YouTube Music continuation request
            response = api._send_request("browse", {"continuation": token})
            
            # Extract items and next token
            from ytmusicapi.continuations import get_continuation_token, CONTINUATION_ITEMS
            from ytmusicapi.parsers.playlists import parse_playlist_items
            
            continuation_items = nav(response, CONTINUATION_ITEMS, True)
            if not continuation_items:
                safe_print({'status': 'ok', 'tracks': [], 'continuation': None, 'callId': call_id})
                return

            tracks = [track_to_dict(t) for t in parse_playlist_items(continuation_items) if track_to_dict(t)]
            next_token = get_continuation_token(continuation_items)
            
            safe_print({
                'status': 'ok', 
                'tracks': tracks, 
                'continuation': next_token, 
                'callId': call_id
            })

        elif command == 'get_playlist_tracks':
            playlist_id = request.get('playlistId')
            limit = request.get('limit')
            api = get_api()
            
            try:
                if playlist_id and (playlist_id.startswith('RD') or playlist_id.startswith('VLRD')):
                    pid = playlist_id[2:] if playlist_id.startswith('VL') else playlist_id
                    data = api.get_watch_playlist(playlistId=pid, limit=limit or 50)
                    tracks = [track_to_dict(t) for t in data.get('tracks', []) if track_to_dict(t)]
                    safe_print({
                        'status': 'ok', 
                        'tracks': tracks, 
                        'trackCount': len(tracks),
                        'callId': call_id
                    })
                else:
                    playlist = api.get_playlist(playlist_id, limit=limit)
                    tracks = [track_to_dict(t) for t in playlist.get('tracks', []) if track_to_dict(t)]
                    
                    author_data = playlist.get('author')
                    author = None
                    if isinstance(author_data, dict):
                        author = {
                            'name': author_data.get('name'),
                            'id': author_data.get('id') or author_data.get('browseId')
                        }
                    elif isinstance(author_data, str):
                        author = {'name': author_data, 'id': None}

                    safe_print({
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
                        'trackCount': playlist.get('trackCount', len(tracks)),
                        'audioPlaylistId': playlist.get('audioPlaylistId'),
                        'likeStatus': playlist.get('likeStatus'),
                        'menu_tokens': playlist.get('menu_tokens'),
                        'isPinned': playlist.get('isPinned'),
                        'continuation': playlist.get('continuation'),
                        'callId': call_id
                    })
            except Exception as e:
                try:
                    pid = playlist_id[2:] if playlist_id.startswith('VL') else playlist_id
                    data = api.get_watch_playlist(playlistId=pid, limit=limit or 50)
                    tracks = [track_to_dict(t) for t in data.get('tracks', []) if track_to_dict(t)]
                    if tracks:
                        safe_print({'status': 'ok', 'tracks': tracks, 'trackCount': len(tracks), 'callId': call_id})
                        return
                except: pass
                
                print(f"Error fetching playlist {playlist_id}: {e}", file=sys.stderr)
                safe_print({'status': 'error', 'message': str(e), 'callId': call_id})

        elif command == 'get_search_suggestions':
            api = get_api()
            query = request.get('query')
            suggestions = api.get_search_suggestions(query)
            safe_print({'status': 'ok', 'suggestions': suggestions, 'callId': call_id})

        elif command == 'search':
            api = get_api()
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
                        top_result = playlist_to_dict(item, skip_owner_check=True)
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
                    p = playlist_to_dict(item, skip_owner_check=True)
                    if p and len(playlists) < 5:
                        playlists.append(p)
            safe_print({'status': 'ok', 'results': {
                'top': top_result, 'correction': correction,
                'tracks': tracks, 'artists': artists, 'albums': albums, 'playlists': playlists
            }, 'callId': call_id})

        elif command == 'search_more':
            api = get_api()
            query = request.get('query')
            offset = request.get('offset', 0)
            search_filter = request.get('filter', 'songs')
            limit = request.get('limit', 20)
            results = api.search(query, filter=search_filter, limit=offset + limit)
            more_results = results[offset:] if len(results) > offset else []
            
            if search_filter == 'artists': items = [artist_to_dict(a) for a in more_results if artist_to_dict(a)]
            elif search_filter == 'albums': items = [album_to_dict(a) for a in more_results if album_to_dict(a)]
            elif search_filter == 'playlists': items = [playlist_to_dict(p) for p in more_results if playlist_to_dict(p)]
            else: items = [track_to_dict(s) for s in more_results if track_to_dict(s)]
            
            safe_print({'status': 'ok', 'items': items, 'callId': call_id})

        elif command == 'get_artist':
            api = get_api()
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
            
            # Парсим ежемесячных слушателей
            monthly_listeners = None
            if 'слушателей' in description_text:
                try: monthly_listeners = description_text.split('слушателей')[0].split('·')[-1].strip()
                except: pass
            elif 'monthly listeners' in description_text:
                try: monthly_listeners = description_text.split('monthly listeners')[0].split('·')[-1].strip()
                except: pass

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

            safe_print({
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
                'callId': call_id
            })

        elif command == 'subscribe_artist':
            api = get_api()
            # YouTube требует channelId, который отличается от browseId артиста
            res = api.subscribe_artists([request.get('channelId')])
            safe_print({'status': 'ok', 'result': res, 'callId': call_id})

        elif command == 'unsubscribe_artist':
            api = get_api()
            res = api.unsubscribe_artists([request.get('channelId')])
            safe_print({'status': 'ok', 'result': res, 'callId': call_id})

        elif command == 'get_user_info':
            account = fetch_account_info()
            name = (account.get('accountName') or account.get('name') or account.get('userName') or "Account")
            thumb = account.get('accountPhotoUrl')
            if not thumb and account.get('thumbnails'):
                if isinstance(account['thumbnails'], list) and len(account['thumbnails']) > 0:
                    thumb = account['thumbnails'][-1].get('url')
                elif isinstance(account['thumbnails'], dict):
                    thumb = account['thumbnails'].get('url')
            safe_print({'status': 'ok', 'name': name, 'thumbUrl': thumb or '', 'callId': call_id})

        elif command == 'get_artist_songs':
            browse_id = request.get('browseId')
            params = request.get('params')
            continuation = request.get('continuation')
            api = get_api()

            if browse_id.startswith('VL') or browse_id.startswith('PL'):
                if continuation:
                    response = api._send_request("browse", {"continuation": continuation})
                    from ytmusicapi.continuations import get_continuation_token, CONTINUATION_ITEMS
                    from ytmusicapi.parsers.playlists import parse_playlist_items

                    continuation_items = nav(response, CONTINUATION_ITEMS, True)
                    if not continuation_items:
                        safe_print({'status': 'ok', 'tracks': [], 'continuation': None, 'callId': call_id})
                        return

                    tracks = [track_to_dict(t) for t in parse_playlist_items(continuation_items) if track_to_dict(t)]
                    next_token = get_continuation_token(continuation_items)

                    safe_print({
                        'status': 'ok', 
                        'tracks': tracks, 
                        'continuation': next_token, 
                        'callId': call_id
                    })
                else:
                    playlist = api.get_playlist(browse_id, limit=50) 
                    tracks = [track_to_dict(t) for t in playlist.get('tracks', []) if track_to_dict(t)]
                    safe_print({
                        'status': 'ok', 
                        'tracks': tracks, 
                        'continuation': playlist.get('continuation'), 
                        'callId': call_id
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
                safe_print({'status': 'ok', 'tracks': items, 'continuation': None, 'callId': call_id})
        elif command == 'get_home':
            api = get_api()
            home_data = api.get_home(limit=request.get('limit', 10))
            formatted = [s for s in (_build_formatted_section(sec) for sec in home_data) if s]
            safe_print({'status': 'ok', 'data': formatted, 'callId': call_id})

        elif command == 'get_home_sections':
            api = get_api()
            try:
                continuation = request.get('continuation')
                if continuation:
                    response = api._send_request('browse', {
                        'browseId': 'FEmusic_home',
                        'continuation': continuation,
                    })
                    section_list = response.get('continuationContents', {}).get('sectionListContinuation', {})
                else:
                    response = api._send_request('browse', {'browseId': 'FEmusic_home'})
                    section_list = nav(response, SINGLE_COLUMN_TAB + ['sectionListRenderer'])

                from ytmusicapi.parsers.browsing import parse_mixed_content
                sections_raw = section_list.get('contents', [])
                conts = section_list.get('continuations', [])
                next_continuation = None
                if conts:
                    next_continuation = (conts[0].get('nextContinuationData', {}).get('continuation')
                                         or conts[0].get('reloadContinuationData', {}).get('continuation'))

                parsed = parse_mixed_content(sections_raw)
                formatted = [s for s in (_build_formatted_section(sec) for sec in parsed) if s]
                safe_print({'status': 'ok', 'sections': formatted, 'continuation': next_continuation, 'callId': call_id})
            except Exception as e:
                safe_print({'status': 'error', 'message': str(e), 'callId': call_id})

        elif command == 'get_explore_releases':
            api = get_api()
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
                        
                        if b_id:
                            if b_id.startswith('MPRE'): res_type = 'album'
                            elif b_id.startswith('UC'): res_type = 'artist'
                            else: res_type = 'playlist'
                        elif v_id:
                            res_type = 'song'
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
                
                safe_print({'status': 'ok', 'sections': formatted_sections, 'callId': call_id})
            except Exception as e:
                safe_print({'status': 'error', 'message': str(e), 'callId': call_id})

        elif command == 'get_mixed_for_you':
            api = get_api()
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
                safe_print({'status': 'ok', 'mixes': mixes, 'callId': call_id})
            except Exception as e:
                safe_print({'status': 'error', 'message': str(e), 'callId': call_id})

        elif command == 'get_track_info':
            api = get_api()
            info = api.get_song(request.get('videoId'))
            safe_print({'status': 'ok', 'info': info, 'callId': call_id})

        elif command == 'add_history_item':
            api = get_api()
            video_id = request.get('videoId')
            try:
                # Согласно инструкции пользователя: 
                # song = yt_auth.get_song(videoId)
                # response = yt_auth.add_history_item(song)
                song = api.get_song(video_id)
                response = api.add_history_item(song)
                
                if response.status_code == 204:
                    print(f"YT history sent for {video_id}", file=sys.stderr)
                    safe_print({'status': 'ok', 'code': 204, 'callId': call_id})
                else:
                    print(f"Failed to send YT history for {video_id}: {response.status_code}", file=sys.stderr)
                    safe_print({'status': 'error', 'code': response.status_code, 'callId': call_id})
            except Exception as e:
                print(f"Error adding history item for {video_id}: {e}", file=sys.stderr)
                safe_print({'status': 'error', 'message': str(e), 'callId': call_id})

        elif command == 'get_queue_recommendations':
            api = get_api()
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
                watch_data = api.get_watch_playlist(
                    videoId=video_id, 
                    playlistId=target_playlist_id, 
                    limit=100, 
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

                safe_print({
                    'status': 'ok', 
                    'tracks': all_tracks, 
                    'relatedId': watch_data.get('related'),
                    'callId': call_id
                })
            except Exception as e:
                print(f"[ERROR] Recommendations failed: {e}", file=sys.stderr)
                safe_print({'status': 'error', 'message': str(e), 'callId': call_id})

        elif command == 'get_song_related':
            api = get_api()
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
                
                safe_print({'status': 'ok', 'sections': formatted_sections, 'callId': call_id})
            except Exception as e:
                safe_print({'status': 'error', 'message': str(e), 'callId': call_id})

        elif command == 'get_lyrics':
            artist = request.get('artist')
            title = request.get('title')
            duration = request.get('duration')
            
            # 1. Try LRCLIB (Priority: Synced Lyrics)
            params = {'artist_name': artist, 'track_name': title}
            if duration: params['duration'] = int(duration)
            
            try:
                response = requests.get('https://lrclib.net/api/get', params=params, timeout=5)
                if response.status_code == 200:
                    data = response.json()
                    safe_print({
                        'status': 'ok',
                        'plainLyrics': data.get('plainLyrics'),
                        'syncedLyrics': data.get('syncedLyrics'),
                        'source': 'lrclib',
                        'callId': call_id
                    })
                    return
            except: pass

            # 2. Fallback to Genius
            genius = fetch_genius_lyrics(artist, title)
            if genius:
                safe_print({
                    'status': 'ok',
                    'plainLyrics': genius['plainLyrics'],
                    'syncedLyrics': None,
                    'source': 'genius',
                    'callId': call_id
                })
                return

            safe_print({'status': 'error', 'message': 'Lyrics not found', 'callId': call_id})

        elif command == 'logout':
            if os.path.exists(OAUTH_FILE): os.remove(OAUTH_FILE)
            if os.path.exists(BROWSER_FILE): os.remove(BROWSER_FILE)
            _auth_data = None
            _auth_type = None
            safe_print({'status': 'ok', 'message': 'Logged out', 'callId': call_id})
        
        elif command == 'rate_song':
            api = get_api()
            res = api.rate_song(request.get('videoId'), request.get('status'))
            safe_print({'status': 'ok', 'result': res, 'callId': call_id})

        elif command == 'rate_playlist':
            api = get_api()
            res = api.rate_playlist(request.get('playlistId'), request.get('status'))
            safe_print({'status': 'ok', 'result': res, 'callId': call_id})

        elif command == 'create_playlist':
            api = get_api()
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
            safe_print({'status': 'ok', 'playlistId': res, 'callId': call_id})

        elif command == 'delete_playlist':
            api = get_api()
            res = api.delete_playlist(request.get('playlistId'))
            safe_print({'status': 'ok', 'result': res, 'callId': call_id})

        elif command == 'edit_playlist':
            api = get_api()
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
            safe_print({'status': 'ok', 'result': res, 'callId': call_id})

        elif command == 'add_playlist_items':
            api = get_api()
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
            safe_print({'status': 'ok', 'result': res, 'callId': call_id})

        elif command == 'remove_playlist_items':
            api = get_api()
            res = api.remove_playlist_items(
                playlistId=request.get('playlistId'),
                videos=request.get('videos') # List of {videoId, setVideoId}
            )
            safe_print({'status': 'ok', 'result': res, 'callId': call_id})

        elif command == 'send_feedback':
            api = get_api()
            res = api._send_request('feedback', {'feedbackTokens': [request.get('token')]})
            safe_print({'status': 'ok', 'success': True, 'result': res, 'callId': call_id})

        elif command == 'get_album':
            api = get_api()
            album_id = request.get('albumId')
            
            # Base info from library (now includes likeStatus, pinning tokens, etc.)
            album = api.get_album(album_id)
            res_album_id = album.get('browseId') or album_id
            album_thumb = album['thumbnails'][-1]['url'] if album.get('thumbnails') else ''
            artists_data = album.get('artists', [])
            tracks = [track_to_dict(t, album_name=album.get('title'), album_id=res_album_id, thumb_url=album_thumb) for t in album.get('tracks', []) if track_to_dict(t)]
            
            safe_print({
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
                'callId': call_id
            })

        elif command == 'get_stream_url':
            start_time = time.time()
            video_id = request.get('videoId')
            url = f"https://www.youtube.com/watch?v={video_id}"
            
            stream_url = None
            loudness = 0.0
            method = "None"
            
            # 1. ПРИОРИТЕТ: pytubefix (0.3с)
            try:
                # Use a very short timeout for pytubefix
                tube = YouTube(url, use_oauth=False, allow_oauth_cache=True)
                stream_url = tube.streams.get_audio_only().url
                
                # Извлекаем громкость (Content Loudness)
                raw_loudness = extract_loudness(tube.vid_info)
                if raw_loudness is None:
                    raw_loudness = extract_loudness(tube.streaming_data)
                
                if raw_loudness is not None:
                    loudness = float(raw_loudness)
                
                method = "pytubefix"
            except Exception as e:
                print(f"[debug] pytubefix failed for {video_id}: {e}", file=sys.stderr)

            # 2. ФОЛБЕК: yt-dlp (Надежность)
            if not stream_url:
                try:
                    # Silence the cookie warning by providing a no-op logger
                    class MyLogger:
                        def debug(self, msg): pass
                        def warning(self, msg): 
                            if "Passing cookies as a header" not in msg:
                                print(f"YT-DLP Warning: {msg}", file=sys.stderr)
                        def error(self, msg): print(f"YT-DLP Error: {msg}", file=sys.stderr)

                    ydl_opts = {
                        'format': 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best',
                        'quiet': True, 'no_warnings': True, 'nocheckcertificate': True,
                        'logger': MyLogger(),
                        'js_runtimes': {'node': {}}, 'remote_components': ['ejs:github'],
                        'youtube_include_dash_manifest': False, 'cachedir': False,
                        'extractor_args': {'youtube': {'player_client': ['web', 'mweb'], 'skip': ['hls']}},
                    }
                    # Если есть куки, добавляем их
                    if _auth_type == 'browser' and _auth_data:
                        headers = {}
                        cookie = _auth_data.get('Cookie')
                        if cookie: headers['Cookie'] = cookie
                        ua = _auth_data.get('User-Agent')
                        if ua: ydl_opts['user_agent'] = ua
                        if headers: ydl_opts['http_headers'] = headers

                    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                        info = ydl.extract_info(url, download=False)
                        stream_url = info['url']
                        method = "yt-dlp"
                except Exception as e:
                    print(f"[error] Both methods failed for {video_id}: {e}", file=sys.stderr)

            total_time = time.time() - start_time
            print(f"[perf] get_stream_url ({method}) for {video_id}: {total_time:.3f}s (loudness: {loudness})", file=sys.stderr)
            
            if stream_url:
                safe_print({'status': 'ok', 'url': stream_url, 'loudness': loudness, 'callId': call_id})
            else:
                safe_print({'status': 'error', 'message': 'Failed to obtain stream URL', 'callId': call_id})

        elif command == 'search_alternatives':
            query = request.get('query', '')
            try:
                ydl_opts = {
                    'quiet': True,
                    'no_warnings': True,
                    'extract_flat': True,
                    'default_search': f'scsearch5:{query}',
                }
                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    info = ydl.extract_info(f'scsearch5:{query}', download=False)
                results = []
                for entry in (info.get('entries') or []):
                    if not entry:
                        continue
                    thumbs = entry.get('thumbnails') or []
                    thumb_url = thumbs[-1].get('url', '') if thumbs else ''
                    results.append({
                        'url': entry.get('url') or entry.get('webpage_url', ''),
                        'title': entry.get('title', ''),
                        'artist': entry.get('uploader') or entry.get('artist', ''),
                        'duration': entry.get('duration'),
                        'thumbUrl': thumb_url,
                        'source': 'soundcloud',
                    })
                safe_print({'status': 'ok', 'results': results, 'callId': call_id})
            except Exception as e:
                print(f"[error] search_alternatives: {e}", file=sys.stderr)
                safe_print({'status': 'error', 'message': str(e), 'callId': call_id})

        elif command == 'get_preview_url':
            url = request.get('url', '')
            try:
                # Prefer direct HTTP streams — avoid HLS/DASH which browser <audio> can't play
                ydl_opts = {
                    'format': (
                        'bestaudio[protocol=https][ext!=m3u8]'
                        '/bestaudio[protocol=http][ext!=m3u8]'
                        '/bestaudio[protocol^=http]'
                        '/bestaudio'
                    ),
                    'quiet': True,
                    'no_warnings': True,
                    'user_agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                }
                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    info = ydl.extract_info(url, download=False)

                # info['url'] is set when a single format is resolved
                stream_url = info.get('url', '')
                protocol = info.get('protocol', '')
                ext = info.get('ext', '')

                # Fallback: scan formats list for a playable HTTP stream
                if not stream_url or 'm3u8' in stream_url or protocol in ('m3u8', 'm3u8_native'):
                    formats = info.get('formats') or []
                    for fmt in reversed(formats):
                        p = fmt.get('protocol', '')
                        u = fmt.get('url', '')
                        if u and p in ('https', 'http') and 'm3u8' not in u:
                            stream_url = u
                            protocol = p
                            ext = fmt.get('ext', '')
                            break

                # Critical Fix: yt-dlp sometimes omits '?' before CloudFront Policy params in SoundCloud
                if stream_url and 'Policy=' in stream_url and '?' not in stream_url:
                    stream_url = stream_url.replace('Policy=', '?Policy=')

                print(f"[debug] get_preview_url: url={url[:60]} proto={protocol} ext={ext} stream={stream_url[:120] if stream_url else 'NONE'}", file=sys.stderr)

                if not stream_url:
                    safe_print({'status': 'error', 'message': 'No playable HTTP stream found (track may be HLS-only)', 'callId': call_id})
                    return

                thumbs = info.get('thumbnails') or []
                thumb_url = thumbs[-1].get('url', '') if thumbs else ''
                safe_print({
                    'status': 'ok',
                    'streamUrl': stream_url,
                    'title': info.get('title', ''),
                    'artist': info.get('uploader') or info.get('artist', ''),
                    'duration': info.get('duration'),
                    'thumbUrl': thumb_url,
                    'callId': call_id,
                })
            except Exception as e:
                print(f"[error] get_preview_url: {e}", file=sys.stderr)
                safe_print({'status': 'error', 'message': str(e), 'callId': call_id})

        elif command == 'download_track':
            url = request.get('url', '')
            video_id = request.get('videoId', '')
            songs_path = request.get('songsPath', '')
            os.makedirs(songs_path, exist_ok=True)
            
            def progress_hook(d):
                if d['status'] == 'downloading':
                    p = d.get('_percent_str', '0%').replace('\x1b[0;32m', '').replace('\x1b[0m', '').strip()
                    speed = d.get('_speed_str', 'unknown speed')
                    eta = d.get('_eta_str', 'unknown ETA')
                    safe_print({
                        'event': 'download_progress', 
                        'callId': call_id, 
                        'status': f"Downloading: {p} ({speed}, ETA: {eta})",
                        'progress': p
                    })
                elif d['status'] == 'finished':
                    safe_print({
                        'event': 'download_progress', 
                        'callId': call_id, 
                        'status': "Download complete, analyzing loudness...",
                        'progress': '100%'
                    })

            try:
                suffix = str(int(time.time() * 1000))  # numeric-ish id to avoid collisions
                output_template = os.path.join(songs_path, f'{video_id}_{suffix}.%(ext)s')
                ydl_opts = {
                    'format': 'bestaudio/best',
                    'quiet': True,
                    'no_warnings': True,
                    'noprogress': True, # Crucial: prevent yt-dlp from polluting stdout
                    'outtmpl': output_template,
                    'noplaylist': True,
                    'progress_hooks': [progress_hook],
                }
                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    info = ydl.extract_info(url, download=True)
                    ext = info.get('ext') or 'webm'
                
                filename = f'{video_id}_{suffix}.{ext}'
                filepath = os.path.join(songs_path, filename)

                # Resolve actual file (yt-dlp may rename extension)
                if not os.path.exists(filepath):
                    for f in os.listdir(songs_path):
                        if f.startswith(video_id + '_' + suffix + '.'):
                            filename = f
                            filepath = os.path.join(songs_path, f)
                            break

                # Loudness analysis via ffmpeg
                gain_db = 0.0
                if os.path.exists(filepath):
                    try:
                        import subprocess
                        # Give Windows a moment to release file handles / flush metadata.
                        # Also wait for file size to stabilize (best-effort).
                        try:
                            last_size = -1
                            stable_ticks = 0
                            for _ in range(10):  # up to ~1s
                                try:
                                    size = os.path.getsize(filepath)
                                except:
                                    size = -1
                                if size == last_size and size > 0:
                                    stable_ticks += 1
                                else:
                                    stable_ticks = 0
                                last_size = size
                                if stable_ticks >= 2:
                                    break
                                time.sleep(0.1)
                        except:
                            pass

                        safe_print({
                            'event': 'download_progress',
                            'callId': call_id,
                            'status': "Analyzing loudness (quick pass)...",
                            'progress': '100%'
                        })
                        # Use subprocess.PIPE to avoid deadlocks on Windows and hide stdout
                        ffmpeg_proc = subprocess.run(
                            [
                                'ffmpeg',
                                '-hide_banner',
                                '-nostats',
                                # Speed up input probing to reduce "hang before processing"
                                '-probesize', '32k',
                                '-analyzeduration', '0',
                                '-vn', '-sn', '-dn',
                                # Analyze a short slice to avoid stalls on some codecs.
                                # `-ss` before `-i` is a fast seek (when supported by demuxer).
                                '-ss', '30',
                                '-t', '12',
                                '-i', filepath,
                                '-af', 'loudnorm=print_format=json',
                                '-f', 'null', '-'
                            ],
                            stdout=subprocess.DEVNULL,
                            stderr=subprocess.PIPE,
                            text=True,
                            timeout=20,
                            encoding='utf-8',
                            errors='ignore'
                        )
                        stderr_text = ffmpeg_proc.stderr
                        json_start = stderr_text.rfind('{')
                        json_end = stderr_text.rfind('}') + 1
                        if json_start != -1 and json_end > json_start:
                            loudnorm_data = json.loads(stderr_text[json_start:json_end])
                            input_i = float(loudnorm_data.get('input_i', -14.0))
                            # Player normalization expects a "loudness-like" dB value, where
                            # negative values increase gain and positive values reduce gain:
                            # gain = 10^(-loudness/20).
                            #
                            # If `input_i` is below -14 LUFS (e.g. -20), we want a negative
                            # value to boost (+6dB). If it's above (e.g. -10), we want a
                            # positive value to attenuate (-4dB).
                            gain_db = input_i + 14.0
                    except Exception as e:
                        print(f"[warn] ffmpeg loudnorm failed: {e}", file=sys.stderr)

                        # Fast fallback: volumedetect (usually much quicker than loudnorm).
                        try:
                            safe_print({
                                'event': 'download_progress',
                                'callId': call_id,
                                'status': "Analyzing loudness (fallback)...",
                                'progress': '100%'
                            })
                            vd_proc = subprocess.run(
                                [
                                    'ffmpeg',
                                    '-hide_banner',
                                    '-nostats',
                                    '-vn', '-sn', '-dn',
                                    '-ss', '30',
                                    '-t', '20',
                                    '-i', filepath,
                                    '-af', 'volumedetect',
                                    '-f', 'null', '-'
                                ],
                                stdout=subprocess.DEVNULL,
                                stderr=subprocess.PIPE,
                                text=True,
                                timeout=15,
                                encoding='utf-8',
                                errors='ignore'
                            )
                            m = re.search(r"mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB", vd_proc.stderr)
                            if m:
                                mean_db = float(m.group(1))
                                gain_db = mean_db + 14.0
                        except Exception as e2:
                            print(f"[warn] ffmpeg volumedetect failed: {e2}", file=sys.stderr)
                
                safe_print({'status': 'ok', 'filename': filename, 'gainDb': gain_db, 'callId': call_id})
            except Exception as e:
                print(f"[error] download_track: {e}", file=sys.stderr)
                safe_print({'status': 'error', 'message': str(e), 'callId': call_id})

        elif command == 'download_direct':
            stream_url = request.get('streamUrl', '')
            video_id = request.get('videoId', '')
            songs_path = request.get('songsPath', '')
            os.makedirs(songs_path, exist_ok=True)
            try:
                suffix = str(int(time.time() * 1000))  # numeric-ish id to avoid collisions
                headers = {
                    'Referer': 'https://music.youtube.com/',
                    'Origin': 'https://music.youtube.com',
                }
                with requests.get(stream_url, stream=True, headers=headers, timeout=30) as r:
                    r.raise_for_status()
                    content_type = r.headers.get('Content-Type', '')
                    total = r.headers.get('Content-Length')
                    total_bytes = int(total) if total and total.isdigit() else None
                    ext = 'webm'
                    if 'mp4' in content_type or 'aac' in content_type:
                        ext = 'm4a'
                    elif 'ogg' in content_type:
                        ext = 'ogg'
                    elif 'mpeg' in content_type or 'mp3' in content_type:
                        ext = 'mp3'
                    filename = f'{video_id}_{suffix}.{ext}'
                    filepath = os.path.join(songs_path, filename)
                    with open(filepath, 'wb') as f:
                        downloaded = 0
                        last_emit = 0.0
                        for chunk in r.iter_content(chunk_size=65536):
                            if is_cancelled():
                                raise Exception("Cancelled by client")
                            if not chunk:
                                continue
                            f.write(chunk)
                            downloaded += len(chunk)
                            now = time.time()
                            if now - last_emit >= 0.25:
                                last_emit = now
                                pct = None
                                if total_bytes and total_bytes > 0:
                                    pct = max(0.0, min(100.0, (downloaded / total_bytes) * 100.0))
                                status = f"Downloading: {downloaded / (1024 * 1024):.1f} MB"
                                if total_bytes:
                                    status += f" / {total_bytes / (1024 * 1024):.1f} MB"
                                if pct is not None:
                                    status = f"Downloading: {pct:.1f}% ({status})"
                                safe_print({
                                    'event': 'download_progress',
                                    'callId': call_id,
                                    'status': status,
                                    'downloadedBytes': downloaded,
                                    'totalBytes': total_bytes,
                                    'progress': f"{pct:.1f}%" if pct is not None else None,
                                })
                safe_print({'status': 'ok', 'filename': filename, 'callId': call_id})
            except Exception as e:
                print(f"[error] download_direct: {e}", file=sys.stderr)
                safe_print({'status': 'error', 'message': str(e), 'callId': call_id})

        elif command == 'check_file':
            filename = request.get('filename', '')
            songs_path = request.get('songsPath', '')
            filepath = os.path.join(songs_path, filename)
            safe_print({'status': 'ok', 'exists': os.path.exists(filepath), 'callId': call_id})

        elif command == 'analyze_file':
            filename = request.get('filename', '')
            songs_path = request.get('songsPath', '')
            filepath = os.path.join(songs_path, filename)
            gain_db = 0.0

            if os.path.exists(filepath):
                try:
                    import subprocess
                    try:
                        last_size = -1
                        stable_ticks = 0
                        for _ in range(10):
                            try:
                                size = os.path.getsize(filepath)
                            except:
                                size = -1
                            if size == last_size and size > 0:
                                stable_ticks += 1
                            else:
                                stable_ticks = 0
                            last_size = size
                            if stable_ticks >= 2:
                                break
                            time.sleep(0.1)
                    except:
                        pass

                    # Use subprocess.PIPE to avoid deadlocks on Windows
                    ffmpeg_proc = subprocess.run(
                        [
                            'ffmpeg',
                            '-hide_banner',
                            '-nostats',
                            '-probesize', '32k',
                            '-analyzeduration', '0',
                            '-vn', '-sn', '-dn',
                            '-ss', '30',
                            '-t', '12',
                            '-i', filepath,
                            '-af', 'loudnorm=print_format=json',
                            '-f', 'null', '-'
                        ],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.PIPE,
                        text=True,
                        timeout=20,
                        encoding='utf-8',
                        errors='ignore'
                    )
                    stderr_text = ffmpeg_proc.stderr
                    json_start = stderr_text.rfind('{')
                    json_end = stderr_text.rfind('}') + 1
                    if json_start != -1 and json_end > json_start:
                        loudnorm_data = json.loads(stderr_text[json_start:json_end])
                        input_i = float(loudnorm_data.get('input_i', -14.0))
                        gain_db = input_i + 14.0
                except Exception as e:
                    print(f"[warn] ffmpeg loudnorm failed: {e}", file=sys.stderr)

                    # Fast fallback: volumedetect
                    try:
                        vd_proc = subprocess.run(
                            [
                                'ffmpeg',
                                '-hide_banner',
                                '-nostats',
                                '-vn', '-sn', '-dn',
                                '-ss', '30',
                                '-t', '20',
                                '-i', filepath,
                                '-af', 'volumedetect',
                                '-f', 'null', '-'
                            ],
                            stdout=subprocess.DEVNULL,
                            stderr=subprocess.PIPE,
                            text=True,
                            timeout=15,
                            encoding='utf-8',
                            errors='ignore'
                        )
                        m = re.search(r"mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB", vd_proc.stderr)
                        if m:
                            mean_db = float(m.group(1))
                            gain_db = mean_db + 14.0
                    except Exception as e2:
                        print(f"[warn] ffmpeg volumedetect failed: {e2}", file=sys.stderr)

            safe_print({'status': 'ok', 'gainDb': gain_db, 'callId': call_id})

        elif command == 'yandex_import_streaming':
            from difflib import SequenceMatcher
            from yandex_music import Client

            def _norm(s):
                return re.sub(r'[^\w\s]', '', (s or '').lower()).strip()

            def _sim(a, b):
                return SequenceMatcher(None, _norm(a), _norm(b)).ratio()

            token = request.get('token', '')
            start_index = int(request.get('startIndex', 0))
            ytm_api = get_api()
            matched = 0
            not_found = 0
            processed = start_index

            client = Client(token).init()
            tracks_list = client.users_likes_tracks()
            total = len(tracks_list)

            safe_print({'event': 'yandex_import_total', 'callId': call_id, 'total': total})

            try:
                for i, short in enumerate(tracks_list[start_index:], start=start_index):
                    title = ''
                    artist = ''
                    dur = None
                    status = 'error'

                    try:
                        t = short.fetch_track()
                        if t and t.title:
                            title = t.title
                            artist = t.artists[0].name if t.artists else ''
                            dur = getattr(t, 'duration_ms', None)
                            query = f"{artist} - {title}" if artist else title

                            results = ytm_api.search(query, filter='songs')
                            candidates = results if isinstance(results, list) else []
                            video_id = None

                            for candidate in candidates:
                                c_title = candidate.get('title', '')
                                c_artists = candidate.get('artists', [])
                                c_artist = c_artists[0].get('name', '') if c_artists else ''
                                c_vid = candidate.get('videoId')
                                if not c_vid:
                                    continue
                                if _sim(title, c_title) >= 0.9 and _sim(artist, c_artist) >= 0.9:
                                    video_id = c_vid
                                    break

                            if video_id:
                                ytm_api.rate_song(video_id, 'LIKE')
                                matched += 1
                                status = 'matched'
                            else:
                                not_found += 1
                                status = 'not_found'
                        else:
                            not_found += 1
                            status = 'not_found'
                    except Exception as e:
                        print(f"[yandex_import] Error at index {i}: {e}", file=sys.stderr)
                        not_found += 1
                        status = 'error'

                    processed = i + 1
                    safe_print({
                        'event': 'yandex_track_done',
                        'callId': call_id,
                        'index': i,
                        'total': total,
                        'title': title,
                        'artist': artist,
                        'durationMs': dur,
                        'status': status,
                    })
                    if is_cancelled():
                        break
                    time.sleep(random.uniform(0.05, 0.15))

                if not is_cancelled():
                    safe_print({'status': 'ok', 'matched': matched, 'notFound': not_found, 'callId': call_id})
            except Exception as e:
                print(f"[yandex_import] Fatal error at index {processed}: {e}", file=sys.stderr)
                safe_print({'status': 'error', 'message': str(e), 'processedCount': processed, 'callId': call_id})

        else:
            safe_print({'status': 'error', 'message': f'Unknown command: {command}', 'callId': call_id})
            
    except Exception as e:
        if not is_cancelled():
            traceback.print_exc()
            safe_print({'status': 'error', 'message': str(e), 'callId': call_id})
    finally:
        if call_id:
            with tasks_lock:
                if call_id in active_tasks:
                    del active_tasks[call_id]

def main():
    print(f"Python API starting... PID: {os.getpid()}", file=sys.stderr)
    print(f"Python Version: {sys.version}", file=sys.stderr)
    print(f"Base Dir: {BASE_DIR}", file=sys.stderr)
    print("NOTE: yt-dlp 'Passing cookies as a header' warning is SILENCED in get_stream_url logic.", file=sys.stderr)
    
    # Verify critical dependencies
    deps = ['ytmusicapi', 'yt_dlp', 'requests']
    missing = []
    for dep in deps:
        try:
            __import__(dep.replace('-', '_'))
        except ImportError:
            missing.append(dep)
    
    if missing:
        error_msg = f"Missing critical dependencies: {', '.join(missing)}"
        print(error_msg, file=sys.stderr)
        # We don't exit here to let the main loop report errors via JSON if possible
    
    try_load_auth()
    for line in sys.stdin:
        try:
            if not line.strip(): continue
            request = json.loads(line)
            threading.Thread(target=handle_request, args=(request,), daemon=True).start()
        except: traceback.print_exc()

if __name__ == "__main__":
    main()
