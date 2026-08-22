import sys
import os
import io

# Force using local fork - MUST BE AT THE VERY TOP
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(BASE_DIR, 'python', 'fork'))

import copy
import json
import logging
import threading
import concurrent.futures
import time
import random
import traceback
import yt_dlp
import requests
import re
import html as html_lib
from urllib.parse import urlparse, urlunparse

from ytmusicapi import YTMusic, OAuthCredentials
from ytmusicapi.navigation import nav, SINGLE_COLUMN_TAB, SECTION_LIST, TITLE_TEXT, CAROUSEL_TITLE, TITLE, NAVIGATION_BROWSE_ID, RUN_TEXT
from ytmusicapi.mixins._utils import get_datestamp
from pytubefix import YouTube, extract as ptf_extract
from pytubefix.botGuard import bot_guard as _ptf_bot_guard
from pytubefix.cipher import Cipher as _PtfCipher
from pytubefix.innertube import InnerTube as _PtfInnerTube
from pytubefix.sig_nsig.node_runner import NodeRunner as _PtfNodeRunner
SECTION_LIST_ITEM = ['sectionListRenderer', 'contents', 0]

# Force UTF-8 for communication to handle Russian text on Windows
sys.stdin = io.TextIOWrapper(sys.stdin.buffer, encoding='utf-8')
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

# Paths
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
USER_DATA_DIR = os.environ.get('GOYMUSIC_USER_DATA', BASE_DIR)
OAUTH_FILE = os.path.join(USER_DATA_DIR, 'oauth.json')
BROWSER_FILE = os.path.join(USER_DATA_DIR, 'browser.json')

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

# dataSyncId аккаунта для GVS PO Token (см. _fetch_stream_meta) — стабилен на весь сеанс,
# достаём один раз из первого успешного player-ответа и переиспользуем.
_yt_data_sync_id = None

# PO Token, добытый Electron'ом из настоящего скрытого браузерного окна (см.
# команду 'set_po_token') — открывает web_music-клиенту адаптивные (opus/aac)
# форматы вместо legacy itag18. Не вечен, Electron периодически перевыпускает.
_yt_po_token = None

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

# --- SoundCloud internal api-v2 client_id (для поиска артистов/альбомов) ---
_SC_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
# app_version шлёт веб-клиент SoundCloud вместе с write-запросами (лайк). Может устаревать.
_SC_APP_VERSION = '1782399945'  # fallback; реальная версия тянется живьём из versions.json
_sc_client_id = None
_sc_app_version = None

def get_sc_client_id(force=False):
    """Достаёт client_id из публичных JS-ассетов soundcloud.com (как делает их веб-плеер). Кэшируется."""
    global _sc_client_id
    if _sc_client_id and not force:
        return _sc_client_id
    try:
        r = requests.get('https://soundcloud.com/', timeout=10, headers={'User-Agent': _SC_UA})
        scripts = re.findall(r'<script[^>]+src="(https://a-v2\.sndcdn\.com/assets/[^"]+\.js)"', r.text)
        for src in reversed(scripts):
            try:
                js = requests.get(src, timeout=10, headers={'User-Agent': _SC_UA}).text
                m = re.search(r'client_id\s*[:=]\s*"([a-zA-Z0-9]{20,})"', js)
                if m:
                    _sc_client_id = m.group(1)
                    print(f"[soundcloud] resolved client_id", file=sys.stderr)
                    return _sc_client_id
            except Exception:
                continue
    except Exception as e:
        print(f"[soundcloud] client_id resolve failed: {e}", file=sys.stderr)
    return _sc_client_id

def get_sc_app_version():
    """Живая версия веб-приложения SoundCloud (как делает их плеер). Кэшируется, есть фолбэк."""
    global _sc_app_version
    if _sc_app_version:
        return _sc_app_version
    try:
        j = requests.get('https://soundcloud.com/versions.json', timeout=8).json()
        v = str((j or {}).get('app') or '')
        if v:
            _sc_app_version = v
            print(f"[soundcloud] app_version {v}", file=sys.stderr)
    except Exception as e:
        print(f"[soundcloud] app_version fetch failed: {e}", file=sys.stderr)
    return _sc_app_version or _SC_APP_VERSION

def _sc_headers(oauth_token=None):
    h = {'User-Agent': _SC_UA}
    if oauth_token:
        h['Authorization'] = f'OAuth {oauth_token}'
    return h

def _sc_api_get(path, params, oauth_token=None, retry_on_401=True):
    """GET к api-v2.soundcloud.com; oauth_token → авторизованный запрос."""
    cid = get_sc_client_id()
    if not cid:
        return None
    p = dict(params or {})
    p['client_id'] = cid
    r = requests.get(f'https://api-v2.soundcloud.com{path}', params=p, timeout=12, headers=_sc_headers(oauth_token))
    # client_id протух — обновляем (только для публичных запросов; на 401 с токеном это не поможет)
    if r.status_code == 401 and retry_on_401 and not oauth_token:
        get_sc_client_id(force=True)
        return _sc_api_get(path, params, retry_on_401=False)
    if r.ok:
        return r.json()
    return None

def _sc_pick_thumb(url):
    """Берём картинку покрупнее: SoundCloud отдаёт -large (100px), меняем на -t500x500."""
    if not url:
        return ''
    return url.replace('-large.', '-t500x500.')

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
            if b_id: artist_ids.append(b_id)
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

# Monkey-patch YTMusic._send_request to support cancellation
_original_send_request = YTMusic._send_request
def _patched_send_request(self, endpoint, body, additionalParams=""):
    if is_cancelled():
        raise Exception("Cancelled by client")
    return _original_send_request(self, endpoint, body, additionalParams)

YTMusic._send_request = _patched_send_request

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

def sanitize(s):
    result = "".join(['-' if c in r'<>:"/\|?* ' else c for c in str(s)]).strip('-')
    while '..' in result:
        result = result.replace('..', '-')
    return result or 'Unknown'

def _deep_find(obj, key):
    """Первое значение key в произвольно вложенном ответе плеера."""
    if isinstance(obj, str):
        try: obj = json.loads(obj)
        except Exception: return None

    if isinstance(obj, dict):
        if key in obj:
            return obj[key]
        for v in obj.values():
            res = _deep_find(v, key)
            if res is not None: return res
    elif isinstance(obj, list):
        for item in obj:
            res = _deep_find(item, key)
            if res is not None: return res
    return None


# Шкала loudnessDb у YouTube целится в -7 LUFS, а не в -14. Замер на 6 треках
# (python/test_loudness.py): после гейна 10^(-loudnessDb/20) все шесть приезжают в
# -7.03..-7.09, разброс 0.02 дБ. Наш SoundCloud-путь целится в -14, отсюда и было
# расхождение источников на 7 дБ, и клиппинг на громких мастерингах (пики до +5.98 dBTP).
# Поле perceptualLoudnessDb (= loudnessDb - 7) для этого НЕ подходит: оно смещает в
# другую сторону, к ~0 LUFS.
_YT_TARGET_OFFSET = 7.0

def extract_loudness(obj):
    """Поправка громкости до -14 LUFS в шкале плеера (gain = 10^(-loudness/20))."""
    v = _deep_find(obj, 'loudnessDb')
    return None if v is None else v + _YT_TARGET_OFFSET

_ffmpeg_exe_path = None

def get_ffmpeg_exe():
    """Путь к ffmpeg: сначала статический бинарник из imageio-ffmpeg (не требует
    системной установки), иначе 'ffmpeg' из PATH как запасной вариант."""
    global _ffmpeg_exe_path
    if _ffmpeg_exe_path is None:
        try:
            import imageio_ffmpeg
            _ffmpeg_exe_path = imageio_ffmpeg.get_ffmpeg_exe()
        except Exception as e:
            print(f"[warn] imageio-ffmpeg unavailable, falling back to PATH ffmpeg: {e}", file=sys.stderr)
            _ffmpeg_exe_path = 'ffmpeg'
    return _ffmpeg_exe_path

def _ffmpeg_loudnorm(stream_url, ss=None, t=None, timeout=20):
    """Разбор loudnorm=print_format=json для среза стрима. None при провале."""
    import subprocess
    cmd = [get_ffmpeg_exe(), '-hide_banner', '-nostats', '-probesize', '64k', '-analyzeduration', '0']
    if ss is not None: cmd += ['-ss', str(int(ss))]
    cmd += ['-i', stream_url]
    if t is not None: cmd += ['-t', str(int(t))]
    cmd += ['-vn', '-sn', '-dn', '-af', 'loudnorm=print_format=json', '-f', 'null', '-']
    r = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                       text=True, timeout=timeout, encoding='utf-8', errors='ignore')
    st = r.stderr or ''
    j0, j1 = st.rfind('{'), st.rfind('}') + 1
    if j0 != -1 and j1 > j0:
        return json.loads(st[j0:j1])
    return None

def _ffmpeg_loudnorm_i(stream_url, ss=None, t=None):
    """input_i (интегрированная громкость, LUFS) для среза стрима. None при провале."""
    d = _ffmpeg_loudnorm(stream_url, ss=ss, t=t)
    return None if d is None else float(d.get('input_i', -14.0))

def measure_loudness_full(stream_url):
    """Поправка до -14 LUFS для стрима без готовых метаданных (SoundCloud и YT-треки,
    у которых YouTube не отдал громкость). Меряем ТРЕК ЦЕЛИКОМ: раньше брали 3 окна по
    10с ради скорости, но замер показал промах до 2.56 дБ, а с уходом замера в фон
    экономить время больше незачем.

    Возвращает (loudness, true_peak) или (None, None)."""
    d = _ffmpeg_loudnorm(stream_url, timeout=300)
    if not d:
        return None, None
    try:
        i = float(d['input_i'])
        tp = float(d['input_tp'])
    except (KeyError, TypeError, ValueError):
        return None, None
    if i <= -70:  # тишина / -inf
        return None, None

    loudness = i + 14.0
    # При усилении (loudness < 0) не даём пикам вылезти выше -1 dBTP: пик после гейна
    # равен tp - loudness, значит loudness не должен опускаться ниже tp + 1.
    if loudness < 0:
        loudness = max(loudness, tp + 1.0)
    return loudness, tp

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
            'likeStatus': t.get('likeStatus') or ('LIKE' if t.get('inLibrary') else None),
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

def _clean_genius_lyrics(text):
    """Убираем из текста Genius служебные вставки (Contributors, Voices, Embed и локализованные заголовки)."""
    # Genius склеивает шапку песни в одну строку без переносов:
    #   "5 ContributorsНазвание Lyrics[Текст песни «...»]" — построчный фильтр её не ловит.
    text = re.sub(r'^\s*\d*\s*Contributors?[^\n]*?\bLyrics\b', '', text, count=1, flags=re.IGNORECASE)
    # Локализованный маркер перевода в начале (не трогаем [Интро:], [Куплет:] и т.п.).
    text = re.sub(r'^\s*\[[^\]]*(?:Текст\s+песни|Lyrics\s+(?:for|of))[^\]]*\]', '', text, count=1, flags=re.IGNORECASE)
    # Хвостовой "…NNEmbed".
    text = re.sub(r'\d*Embed\s*$', '', text)
    # Разбиваем на строки, фильтруем мусор, собираем обратно.
    lines = text.split('\n')
    cleaned = []
    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        # Пропускаем явный мусор Genius
        if re.match(r'^\d+\s*Contributor(s)?$', stripped, re.IGNORECASE):
            continue
        if re.match(r'^Contributor(s)?$', stripped, re.IGNORECASE):
            continue
        if re.match(r'^Voices$', stripped, re.IGNORECASE):
            continue
        if re.match(r'^Translations?$', stripped, re.IGNORECASE):
            continue
        if re.match(r'^Lyrics$', stripped, re.IGNORECASE):
            continue
        if re.match(r'^Embed$', stripped, re.IGNORECASE):
            continue
        if re.match(r'^You might also like$', stripped, re.IGNORECASE):
            continue
        # Локализованные заголовки типа [Текс песни "..."] / [Текст песни "..."] / [Lyrics for "..."]
        if re.match(r'^(\[)?\s*(Текс|Текст)\s+песни\s+["\u201c\u201e].*["\u201d\u201f]\s*\]?$', stripped, re.IGNORECASE):
            continue
        if re.match(r'^(\[)?\s*Lyrics\s+(for|of)\s+["\u201c\u201e].*["\u201d\u201f]\s*\]?$', stripped, re.IGNORECASE):
            continue
        cleaned.append(line)
    # Убираем хвостовой "Embed", если остался на последней строке
    if cleaned and re.match(r'^Embed\s*$', cleaned[-1].strip(), re.IGNORECASE):
        cleaned.pop()
    return '\n'.join(cleaned).strip()


def _clean_artist(artist):
    """Убираем мусорные значения артиста, чтобы не отравлять поиск лириксов."""
    if not artist:
        return ''
    a = str(artist).strip()
    if a.lower() in ('unknown', 'various artists', 'va', 'topic'):
        return ''
    a = re.sub(r'\s*-\s*topic\s*$', '', a, flags=re.IGNORECASE)
    return a.strip()


def _normalize_lyric_title(title):
    """Нормализуем название: убираем (feat…), (Official Video), [Explicit], prod. и т.п."""
    if not title:
        return ''
    t = str(title)
    t = re.sub(r'\s*[\(\[][^\)\]]*(feat\.?|ft\.?|official|lyric|audio|video|visualizer|prod\.?|remaster|explicit|clean|slowed|sped\s*up)[^\)\]]*[\)\]]', '', t, flags=re.IGNORECASE)
    t = re.sub(r'\s*(feat\.?|ft\.?)\s+.*$', '', t, flags=re.IGNORECASE)
    t = re.sub(r'\s*-\s*(topic|official.*|lyric.*|audio|video)\s*$', '', t, flags=re.IGNORECASE)
    t = re.sub(r'\s{2,}', ' ', t).strip(' -–—')
    return t or str(title).strip()


def _pick_lrclib(candidates, title, artist, duration):
    """Лучший результат из LRCLIB /api/search (нечёткий, терпим к неточному artist)."""
    from difflib import SequenceMatcher
    if not candidates:
        return None
    def score(c):
        s = SequenceMatcher(None, (c.get('trackName') or '').lower(), (title or '').lower()).ratio() * 2
        if artist:
            s += SequenceMatcher(None, (c.get('artistName') or '').lower(), artist.lower()).ratio()
        if duration and c.get('duration'):
            try:
                if abs(float(c['duration']) - float(duration)) <= 3:
                    s += 1
            except (TypeError, ValueError):
                pass
        if c.get('syncedLyrics'):
            s += 0.5
        return s
    best = max(candidates, key=score)
    # Отсекаем совсем непохожие (защита от мусора при поиске только по названию).
    if SequenceMatcher(None, (best.get('trackName') or '').lower(), (title or '').lower()).ratio() < 0.5:
        return None
    return best


def fetch_genius_lyrics(artist, title):
    try:
        # 1. Ищем URL именно ПЕСНИ (не страницы артиста), пробуя несколько запросов.
        headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"}

        # Сопоставляем найденную песню с нашим названием: фаззи-похожесть (работает и
        # для кириллицы) ИЛИ общий латинский токен (транслит/латиница в скобках, "Wannablood").
        from difflib import SequenceMatcher
        def _norm_t(s):
            return re.sub(r'[^0-9a-zа-яёÀ-ɏ]+', ' ', (s or '').lower()).strip()
        def _matches(cand):
            c, o = _norm_t(cand), _norm_t(title)
            if not c or not o:
                return False
            if SequenceMatcher(None, c, o).ratio() >= 0.55:
                return True
            ctok = set(re.findall(r'[0-9a-z]{4,}', c))
            otok = set(re.findall(r'[0-9a-z]{4,}', o))
            return bool(ctok & otok)

        def _song_url(query):
            query = (query or '').strip()
            if not query:
                return None
            try:
                r = requests.get("https://genius.com/api/search/multi",
                                 params={"q": query}, headers=headers, timeout=5)
                if r.status_code != 200:
                    return None
                for section in r.json().get("response", {}).get("sections", []):
                    if section.get("type") not in ("top_hit", "song"):
                        continue
                    for hit in section.get("hits", []):
                        res = hit.get("result", {})
                        u = res.get("url", "")
                        # Только песня (не артист) И только если название совпадает с нашим —
                        # так находим верный трек, даже если он не первый в выдаче.
                        if res.get("_type") != "song" or "/artists/" in u:
                            continue
                        if _matches(res.get("title") or res.get("full_title") or ""):
                            return u
            except:
                pass
            return None

        # Несколько запросов: у не-английских треков полезно искать и по латинскому
        # названию в скобках ("Кровопийца (Wannablood)" → "Wannablood").
        a = (artist or '').strip()
        queries = []
        if a:
            queries.append(f"{a} {title}")
        m = re.search(r'\(([^)]+)\)', title or '')
        if m:
            paren = m.group(1).strip()
            base = re.sub(r'\([^)]*\)', '', title or '').strip()
            if a and paren:
                queries.append(f"{a} {paren}")
            if a and base:
                queries.append(f"{a} {base}")
            if paren:
                queries.append(paren)
        queries.append(title or '')

        song_url = None
        seen_q = set()
        for q in queries:
            q = (q or '').strip()
            if not q or q in seen_q:
                continue
            seen_q.add(q)
            song_url = _song_url(q)
            if song_url:
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
            # Предварительно отсеиваем контейнеры, в которых только мусор
            plain_preview = re.sub(r'<.*?>', '', content).strip()
            if plain_preview and not re.match(r'^(\d+\s*Contributor(s)?|Contributor(s)?|Voices|Translations?|Lyrics|Embed)$', plain_preview, re.IGNORECASE):
                parts.append(content)
            
        if not parts:
            # Last resort fallback for old Genius layout
            parts = re.findall(r'<div class="lyrics">(.*?)</div>', html_text, re.DOTALL)
            
        if not parts: return None
        
        # 3. Join, clean and unescape
        full_lyrics = "\n".join(parts)
        full_lyrics = re.sub(r'<br\s*/?>', '\n', full_lyrics)
        full_lyrics = re.sub(r'<.*?>', '', full_lyrics)
        full_lyrics = _clean_genius_lyrics(html_lib.unescape(full_lyrics))
        
        if not full_lyrics: return None
        return {"plainLyrics": full_lyrics, "syncedLyrics": None}
    except:
        return None


def fetch_lyrics_ovh(artist, title):
    """Простой фолбек-источник lyrics.ovh."""
    try:
        url = f"https://api.lyrics.ovh/v1/{requests.utils.quote(artist)}/{requests.utils.quote(title)}"
        r = requests.get(url, timeout=6)
        if r.status_code != 200: return None
        data = r.json()
        lyrics = data.get('lyrics')
        if not lyrics: return None
        return {"plainLyrics": lyrics.strip(), "syncedLyrics": None}
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


# ─── nodriver helpers (SoundCloud лайки) ──────────────────────────────────
# Запускаем Chrome с кастомным профилем, сворачиваем окно (юзер не видит),
# инжектим сохранённый oauth_token, кликаем лайк.

_CHROMIUM_EXE_NAMES = ('chrome.exe', 'msedge.exe', 'brave.exe', 'vivaldi.exe', 'opera.exe')

def _sc_default_browser_path() -> str | None:
    """Путь к браузеру по умолчанию из реестра Windows, если он Chromium-based. Не требует прав администратора (ключи в HKCU/HKCR)."""
    if sys.platform != 'win32':
        return None
    try:
        import winreg
        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r'Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice'
        ) as key:
            prog_id = winreg.QueryValueEx(key, 'ProgId')[0]
        with winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, f'{prog_id}\\shell\\open\\command') as key:
            command = winreg.QueryValueEx(key, '')[0]
        # command обычно вида: "C:\Path\To\browser.exe" -- %1
        exe_path = command.split('" ')[0].strip('"').strip()
        if os.path.basename(exe_path).lower() in _CHROMIUM_EXE_NAMES and os.path.exists(exe_path):
            return exe_path
    except Exception:
        pass
    return None

def _common_chromium_paths() -> list[str]:
    candidates = []
    for env_var in ('PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA', 'PROGRAMW6432'):
        base = os.environ.get(env_var)
        if not base:
            continue
        candidates += [
            os.path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            os.path.join(base, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
        ]
    return candidates

def _resolve_sc_browser_path(override: str | None = None) -> str:
    """Определяет путь к Chromium-браузеру для nodriver: юзер-override -> дефолтный браузер системы -> Chrome (nodriver) -> Edge/Brave по типовым путям."""
    if override and os.path.exists(override) and os.access(override, os.X_OK):
        return override

    default_path = _sc_default_browser_path()
    if default_path:
        return default_path

    try:
        from nodriver.core.config import find_chrome_executable
        return find_chrome_executable()
    except Exception:
        pass

    for candidate in _common_chromium_paths():
        if os.path.exists(candidate) and os.access(candidate, os.X_OK):
            return candidate

    raise RuntimeError(
        'Не найден Chrome, Edge или Brave. Укажите путь к браузеру в Настройках → SoundCloud.'
    )

def _sc_nodriver_like(profile_dir: str, url: str, oauth_token: str | None = None, liked: bool = True, app_bounds: dict | None = None, browser_path: str | None = None) -> str:
    """Возвращает 'liked' | 'unliked' | 'error'. Всегда закрывает браузер."""
    import asyncio
    import random as _rnd
    import nodriver as uc

    browser_executable_path = _resolve_sc_browser_path(browser_path)

    async def _do():
        browser = await uc.start(
            user_data_dir=profile_dir,
            headless=False,
            browser_executable_path=browser_executable_path,
            browser_args=['--window-size=700,900', '--mute-audio', '--window-position=-1000,-1000'],
        )
        try:
            print(f"[nodriver] opening: {url}", file=sys.stderr)
            tab = await browser.get(url)
            await asyncio.sleep(_rnd.uniform(0.5, 2.0))

            if oauth_token:
                await tab.evaluate(
                    f'document.cookie = "oauth_token={oauth_token}; '
                    f'domain=.soundcloud.com; path=/; max-age=31536000; secure;"'
                )
                await asyncio.sleep(0.5)

            # Wait for document.readyState == complete
            for _ in range(15):
                try:
                    ready = await tab.evaluate("document.readyState === 'complete'")
                    if ready:
                        break
                except Exception:
                    pass
                await asyncio.sleep(1)

            JS_FIND_LIKE_BTN = '''
            const findLikeBtn = () => {
                const trackHeaders = document.querySelectorAll('section[aria-label="Track header"], [aria-label="Track header"], .fullHero, .listenEngagement');
                for (const trackHeader of trackHeaders) {
                    const btns = Array.from(trackHeader.querySelectorAll('button, [role="button"]'));
                    for (const btn of btns) {
                        const r = btn.getBoundingClientRect();
                        if (r.width === 0 || r.height === 0) continue;
                        const pTitle = (btn.parentElement ? btn.parentElement.getAttribute('title') : '') || '';
                        const pLabel = (btn.parentElement ? btn.parentElement.getAttribute('aria-label') : '') || '';
                        const label = (btn.getAttribute('aria-label') || btn.getAttribute('title') || pTitle || pLabel || '').trim().toLowerCase();
                        if (label === 'like' || label === 'unlike' || label.startsWith('like') || label.startsWith('unlike')) {
                            return btn;
                        }
                    }
                }

                const allBtns = Array.from(document.querySelectorAll('button, [role="button"]'));
                for (const btn of allBtns) {
                    if (btn.closest('ul') || btn.closest('li') || btn.closest('[aria-label="Comments"]') || btn.closest('.playControls') || btn.closest('footer') || btn.closest('form')) continue;
                    const r = btn.getBoundingClientRect();
                    if (r.width === 0 || r.height === 0) continue;
                    const pTitle = (btn.parentElement ? btn.parentElement.getAttribute('title') : '') || '';
                    const pLabel = (btn.parentElement ? btn.parentElement.getAttribute('aria-label') : '') || '';
                    const label = (btn.getAttribute('aria-label') || btn.getAttribute('title') || pTitle || pLabel || '').trim().toLowerCase();
                    if (label === 'like' || label === 'unlike' || label.startsWith('like') || label.startsWith('unlike')) {
                        return btn;
                    }
                    const svgPath = btn.querySelector('svg path');
                    if (svgPath) {
                        const d = svgPath.getAttribute('d') || '';
                        if (d.startsWith('M21.25') || d.includes('9.9375')) {
                            return btn;
                        }
                    }
                }

                const fallbackBtns = Array.from(document.querySelectorAll('.listenEngagement button.sc-button-like, button.sc-button-like'));
                for (const btn of fallbackBtns) {
                    const r = btn.getBoundingClientRect();
                    if (r.width > 0 && r.height > 0 && !btn.closest('ul') && !btn.closest('li')) return btn;
                }
                return null;
            };
            '''

            JS_FIND_PLAY_BTN = '''
            const findPlayBtn = () => {
                const trackHeaders = document.querySelectorAll('section[aria-label="Track header"], [aria-label="Track header"], .fullHero, .listenEngagement');
                for (const trackHeader of trackHeaders) {
                    const btns = Array.from(trackHeader.querySelectorAll('button, [role="button"]'));
                    for (const btn of btns) {
                        const r = btn.getBoundingClientRect();
                        if (r.width === 0 || r.height === 0) continue;
                        const pLabel = (btn.parentElement ? btn.parentElement.getAttribute('aria-label') : '') || '';
                        const pTitle = (btn.parentElement ? btn.parentElement.getAttribute('title') : '') || '';
                        const label = (btn.getAttribute('aria-label') || btn.getAttribute('title') || pLabel || pTitle || '').trim().toLowerCase();
                        if (label === 'play' || label === 'play track' || label.startsWith('play')) {
                            return btn;
                        }
                    }
                }
                const allBtns = Array.from(document.querySelectorAll('button, [role="button"]'));
                for (const btn of allBtns) {
                    if (btn.closest('ul') || btn.closest('li') || btn.closest('[aria-label="Comments"]') || btn.closest('.playControls') || btn.closest('footer') || btn.closest('form')) continue;
                    const r = btn.getBoundingClientRect();
                    if (r.width === 0 || r.height === 0) continue;
                    const pLabel = (btn.parentElement ? btn.parentElement.getAttribute('aria-label') : '') || '';
                    const pTitle = (btn.parentElement ? btn.parentElement.getAttribute('title') : '') || '';
                    const label = (btn.getAttribute('aria-label') || btn.getAttribute('title') || pLabel || pTitle || '').trim().toLowerCase();
                    if (label === 'play' || label === 'play track' || label.startsWith('play')) {
                        return btn;
                    }
                }
                const fallbackBtns = Array.from(document.querySelectorAll('.playButton.sc-button-play, .sc-button-play'));
                for (const btn of fallbackBtns) {
                    const r = btn.getBoundingClientRect();
                    if (r.width > 0 && r.height > 0) return btn;
                }
                return null;
            };
            '''

            def _check():
                return tab.evaluate('''(() => {''' + JS_FIND_LIKE_BTN + '''
                    const b = findLikeBtn();
                    if (!b) return 'no_button';
                    const pTitle = (b.parentElement ? b.parentElement.getAttribute('title') : '') || '';
                    const pLabel = (b.parentElement ? b.parentElement.getAttribute('aria-label') : '') || '';
                    const label = (b.getAttribute('aria-label') || b.getAttribute('title') || pTitle || pLabel || '').trim().toLowerCase();
                    
                    if (label === 'unlike' || label.startsWith('unlike') || label.includes('remove from likes') || label.includes('dislike')) {
                        return 'liked';
                    }
                    if (label === 'like' || label.startsWith('like')) {
                        return 'unliked';
                    }

                    const svgPath = b.querySelector('svg path');
                    if (svgPath) {
                        const fill = (svgPath.getAttribute('fill') || '').toLowerCase();
                        if (fill === 'none') return 'unliked';
                        if (fill && fill !== 'none') return 'liked';
                    }

                    const pressed = b.getAttribute('aria-pressed') === 'true' || b.getAttribute('aria-checked') === 'true';
                    if (pressed) return 'liked';

                    const span = b.querySelector('span');
                    const txt = (span ? span.textContent.trim().toLowerCase() : b.textContent.trim().toLowerCase());
                    if (txt === 'liked') return 'liked';
                    if (txt === 'like') return 'unliked';

                    const className = (b.className || '').toString();
                    if (className.includes('sc-button-selected') || className.includes('Mui-selected')) return 'liked';

                    return 'unknown';
                })()''')

            cur = 'no_button'
            for retry in range(15):
                cur = await _check()
                if cur in ('liked', 'unliked'):
                    break
                await asyncio.sleep(0.5)

            want = 'liked' if liked else 'unliked'
            print(f"[nodriver] cur={cur} want={want}", file=sys.stderr)

            if cur == want:
                return want
            if cur not in ('liked', 'unliked'):
                return 'error'

            async def _cdp_click_like():
                coords_raw = await tab.evaluate('''(() => {''' + JS_FIND_LIKE_BTN + '''
                    const b = findLikeBtn();
                    if (!b) return null;
                    b.scrollIntoView({behavior: 'instant', block: 'center'});
                    try { b.click(); } catch(e){}
                    const r = b.getBoundingClientRect();
                    return {x: r.x + r.width/2, y: r.y + r.height/2};
                })()''')
                x = y = None
                if isinstance(coords_raw, dict):
                    x = coords_raw.get('x')
                    y = coords_raw.get('y')
                elif isinstance(coords_raw, list):
                    for v in coords_raw:
                        if isinstance(v, (list, tuple)) and len(v) >= 2:
                            key, val = v[0], v[1]
                            if key == 'x': x = val.get('value') if isinstance(val, dict) else val
                            elif key == 'y': y = val.get('value') if isinstance(val, dict) else val
                if x is None or y is None:
                    return False
                await tab.send(uc.cdp.input_.dispatch_mouse_event(
                    type_='mousePressed', x=x, y=y,
                    button=uc.cdp.input_.MouseButton('left'), click_count=1))
                await tab.send(uc.cdp.input_.dispatch_mouse_event(
                    type_='mouseReleased', x=x, y=y,
                    button=uc.cdp.input_.MouseButton('left'), click_count=1))
                print(f"[nodriver] CDP click like button at ({x:.0f}, {y:.0f})", file=sys.stderr)
                return True

            async def _cdp_click_play():
                coords_raw = await tab.evaluate('''(() => {''' + JS_FIND_PLAY_BTN + '''
                    const b = findPlayBtn();
                    if (!b) return null;
                    b.scrollIntoView({behavior: 'instant', block: 'center'});
                    try { b.click(); } catch(e){}
                    const r = b.getBoundingClientRect();
                    return {x: r.x + r.width/2, y: r.y + r.height/2};
                })()''')
                x = y = None
                if isinstance(coords_raw, dict):
                    x = coords_raw.get('x')
                    y = coords_raw.get('y')
                elif isinstance(coords_raw, list):
                    for v in coords_raw:
                        if isinstance(v, (list, tuple)) and len(v) >= 2:
                            key, val = v[0], v[1]
                            if key == 'x': x = val.get('value') if isinstance(val, dict) else val
                            elif key == 'y': y = val.get('value') if isinstance(val, dict) else val
                if x is None or y is None:
                    return False
                await tab.send(uc.cdp.input_.dispatch_mouse_event(
                    type_='mousePressed', x=x, y=y,
                    button=uc.cdp.input_.MouseButton('left'), click_count=1))
                await tab.send(uc.cdp.input_.dispatch_mouse_event(
                    type_='mouseReleased', x=x, y=y,
                    button=uc.cdp.input_.MouseButton('left'), click_count=1))
                print(f"[nodriver] CDP click play button at ({x:.0f}, {y:.0f})", file=sys.stderr)
                return True

            async def _cdp_click(selector):
                coords_raw = await tab.evaluate('''(() => {
                    const b = document.querySelector('%s');
                    if (!b) return null;
                    b.scrollIntoView({behavior: 'instant', block: 'center'});
                    const r = b.getBoundingClientRect();
                    return {x: r.x + r.width/2, y: r.y + r.height/2};
                })()''' % selector)
                x = y = None
                if isinstance(coords_raw, dict):
                    x = coords_raw.get('x')
                    y = coords_raw.get('y')
                elif isinstance(coords_raw, list):
                    for v in coords_raw:
                        if isinstance(v, (list, tuple)) and len(v) >= 2:
                            key, val = v[0], v[1]
                            if key == 'x': x = val.get('value') if isinstance(val, dict) else val
                            elif key == 'y': y = val.get('value') if isinstance(val, dict) else val
                if x is None or y is None:
                    return False
                await tab.send(uc.cdp.input_.dispatch_mouse_event(
                    type_='mousePressed', x=x, y=y,
                    button=uc.cdp.input_.MouseButton('left'), click_count=1))
                await tab.send(uc.cdp.input_.dispatch_mouse_event(
                    type_='mouseReleased', x=x, y=y,
                    button=uc.cdp.input_.MouseButton('left'), click_count=1))
                print(f"[nodriver] CDP click at ({x:.0f}, {y:.0f}) — {selector}", file=sys.stderr)
                return True

            async def _cdp_move(x, y):
                await tab.send(uc.cdp.input_.dispatch_mouse_event(
                    type_='mouseMoved', x=x, y=y,
                    button=uc.cdp.input_.MouseButton('none')))

            async def _get_element_center(selector):
                coords = await tab.evaluate('''(() => {
                    const b = document.querySelector('%s');
                    if (!b) return null;
                    const r = b.getBoundingClientRect();
                    return {x: r.x + r.width/2, y: r.y + r.height/2};
                })()''' % selector)
                if isinstance(coords, dict):
                    return coords.get('x'), coords.get('y')
                return None, None

            # ─── капча ──────────────────────────────────────────────

            async def _check_captcha():
                return await tab.evaluate('''(() => {
                    const html = document.documentElement.innerHTML;
                    const ddMatch = html.match(/var dd\\s*=\\s*\\{[\\s\\S]*?\\}/);
                    if (ddMatch && (ddMatch[0].includes("'rt': 'c'") || ddMatch[0].includes('"rt": "c"')))
                        return true;
                    if (document.querySelector('iframe[src*="captcha-delivery.com"]'))
                        return true;
                    if (document.querySelector('#captcha, .captcha-container, #dd-captcha'))
                        return true;
                    return false;
                })()''')

            async def _show_browser():
                try:
                    window_id, _ = await tab.send(uc.cdp.browser.get_window_for_target())
                    if app_bounds:
                        bx = app_bounds.get('x', 100)
                        by = app_bounds.get('y', 100)
                        bw = app_bounds.get('width', 700)
                        left = max(0, bx + bw // 2 - 350)
                        top = max(0, by - 50)
                    else:
                        left, top = 100, 100
                    bounds = uc.cdp.browser.Bounds(left=left, top=top, width=700, height=900,
                                                   window_state=uc.cdp.browser.WindowState.NORMAL)
                    await tab.send(uc.cdp.browser.set_window_bounds(window_id, bounds))
                except Exception as e:
                    print(f"[nodriver] failed to show window: {e}", file=sys.stderr)

            async def _hide_browser():
                try:
                    window_id, _ = await tab.send(uc.cdp.browser.get_window_for_target())
                    bounds = uc.cdp.browser.Bounds(left=-1000, top=-1000)
                    await tab.send(uc.cdp.browser.set_window_bounds(window_id, bounds))
                except Exception:
                    pass

            async def _wait_captcha(timeout=120):
                await _show_browser()
                print("[nodriver] CAPTCHA — solve it in the browser window", file=sys.stderr)
                for _ in range(timeout):
                    await asyncio.sleep(1)
                    if not await _check_captcha():
                        print("[nodriver] captcha solved", file=sys.stderr)
                        await asyncio.sleep(2)
                        return True
                print("[nodriver] captcha timeout", file=sys.stderr)
                await _hide_browser()
                return False

            # ─── пул минидействий ──────────────────────────────────

            async def _scroll():
                dy = _rnd.randint(180, 350)
                await tab.send(uc.cdp.input_.dispatch_mouse_event(
                    type_='mouseWheel', x=350, y=400, delta_x=0, delta_y=dy))
                await asyncio.sleep(_rnd.uniform(0.6, 1.2))
                await tab.send(uc.cdp.input_.dispatch_mouse_event(
                    type_='mouseWheel', x=350, y=400, delta_x=0, delta_y=-int(dy * _rnd.uniform(0.6, 0.9))))

            async def _mouse_move():
                rx, ry = _rnd.randint(80, 650), _rnd.randint(80, 650)
                await _cdp_move(rx, ry)

            async def _hover_like():
                coords_raw = await tab.evaluate('''(() => {''' + JS_FIND_LIKE_BTN + '''
                    const b = findLikeBtn();
                    if (!b) return null;
                    const r = b.getBoundingClientRect();
                    return {x: r.x + r.width/2, y: r.y + r.height/2};
                })()''')
                if isinstance(coords_raw, dict):
                    cx, cy = coords_raw.get('x'), coords_raw.get('y')
                    if cx is not None and cy is not None:
                        await _cdp_move(cx + _rnd.randint(-20, 20), cy + _rnd.randint(-20, 20))

            async def _hover_play():
                coords_raw = await tab.evaluate('''(() => {''' + JS_FIND_PLAY_BTN + '''
                    const b = findPlayBtn();
                    if (!b) return null;
                    const r = b.getBoundingClientRect();
                    return {x: r.x + r.width/2, y: r.y + r.height/2};
                })()''')
                if isinstance(coords_raw, dict):
                    cx, cy = coords_raw.get('x'), coords_raw.get('y')
                    if cx is not None and cy is not None:
                        await _cdp_move(cx + _rnd.randint(-15, 15), cy + _rnd.randint(-15, 15))

            async def _seek_forward():
                coords_raw = await tab.evaluate('''(() => {
                    const bar = document.querySelector('.playbackTimeline__progressWrapper, [role="progressbar"], .playbackTimeline');
                    if (bar) {
                        const r = bar.getBoundingClientRect();
                        if (r.width > 0) {
                            const ratio = Math.random() * 0.4 + 0.3;
                            const cx = r.x + r.width * ratio;
                            const cy = r.y + r.height / 2;
                            try {
                                const evt = new MouseEvent('click', {
                                    bubbles: true, cancelable: true,
                                    clientX: cx, clientY: cy
                                });
                                bar.dispatchEvent(evt);
                            } catch(e){}
                            return {x: cx, y: cy};
                        }
                    }
                    const audio = document.querySelector('audio');
                    if (audio && audio.duration && !isNaN(audio.duration)) {
                        const jump = Math.floor(Math.random() * 25) + 15;
                        audio.currentTime = Math.min(audio.duration - 5, audio.currentTime + jump);
                    }
                    return null;
                })()''')
                if isinstance(coords_raw, dict):
                    cx, cy = coords_raw.get('x'), coords_raw.get('y')
                    if cx is not None and cy is not None:
                        await _cdp_move(cx, cy)
                        await tab.send(uc.cdp.input_.dispatch_mouse_event(
                            type_='mousePressed', x=cx, y=cy,
                            button=uc.cdp.input_.MouseButton('left'), click_count=1))
                        await tab.send(uc.cdp.input_.dispatch_mouse_event(
                            type_='mouseReleased', x=cx, y=cy,
                            button=uc.cdp.input_.MouseButton('left'), click_count=1))
                        print(f"[nodriver] CDP click progress bar at ({cx:.0f}, {cy:.0f})", file=sys.stderr)

            async def _pause_wait():
                await asyncio.sleep(_rnd.uniform(0.5, 2.0))

            async def _overshoot():
                tx, ty = _rnd.randint(200, 500), _rnd.randint(200, 500)
                await _cdp_move(tx + _rnd.randint(30, 80), ty + _rnd.randint(-40, 40))
                await asyncio.sleep(_rnd.uniform(0.1, 0.3))
                await _cdp_move(tx, ty)

            # ─── логика: play + actions или только actions ──────────

            pre_play_pool = [_scroll, _mouse_move,
                             _hover_like, _pause_wait, _overshoot]
            post_play_pool = [_scroll, _mouse_move,
                              _hover_like, _seek_forward, _pause_wait, _overshoot]

            if _rnd.random() < 0.9:
                play_ok = await _cdp_click_play()
                if play_ok:
                    await asyncio.sleep(_rnd.uniform(2.0, 4.0))
                chosen = _rnd.sample(post_play_pool, 3)
            else:
                chosen = _rnd.sample(pre_play_pool, 3)

            for action in chosen:
                print(f"[nodriver] action: {action.__name__}", file=sys.stderr)
                await action()
                await asyncio.sleep(_rnd.uniform(0.5, 1.5))

            # лайк/анлайк — с проверкой координат
            like_ok = await _cdp_click_like()
            if not like_ok:
                print("[nodriver] like button not found, retrying after scroll", file=sys.stderr)
                await tab.evaluate('window.scrollTo(0, document.body.scrollHeight / 3)')
                await asyncio.sleep(1)
                like_ok = await _cdp_click_like()

            await asyncio.sleep(_rnd.uniform(1.5, 2.5))

            # Проверяем переключился ли статус, если нет — резервный прямой b.click()
            after_check = await _check()
            print(f"[nodriver] check status: {after_check}", file=sys.stderr)
            if after_check != want:
                print("[nodriver] status not changed, trigger fallback direct b.click()", file=sys.stderr)
                await tab.evaluate('''(() => {''' + JS_FIND_LIKE_BTN + '''
                    const b = findLikeBtn();
                    if (b) { try { b.click(); } catch(e){} }
                })()''')
                await asyncio.sleep(2.0)

            # проверяем капчу после лайка
            if await _check_captcha():
                if await _wait_captcha():
                    # повторяем лайк — капча могла сбросить действие
                    await _cdp_click_like()
                    await asyncio.sleep(_rnd.uniform(2.0, 3.0))
                else:
                    return 'error'

            after = await _check()
            print(f"[nodriver] final status: {after}", file=sys.stderr)
            await _hide_browser()
            return after if after in ('liked', 'unliked') else 'error'
        finally:
            try:
                browser.stop()
                pass
            except Exception:
                pass
    return asyncio.run(_do())


def _sc_nodriver_login(profile_dir: str, browser_path: str | None = None) -> str | None:
    import asyncio
    import nodriver as uc

    browser_executable_path = _resolve_sc_browser_path(browser_path)

    async def _do():
        browser = await uc.start(
            user_data_dir=profile_dir,
            headless=False,
            browser_executable_path=browser_executable_path,
            browser_args=['--mute-audio'],
        )
        try:
            tab = await browser.get('https://soundcloud.com')
            for _ in range(10):
                try:
                    cs = await tab.evaluate('document.cookie')
                    if cs and 'oauth_token' in cs:
                        for part in cs.split(';'):
                            part = part.strip()
                            if part.startswith('oauth_token='):
                                tok = part.split('=', 1)[1]
                                print("[nodriver] got oauth_token", file=sys.stderr)
                                return tok
                except:
                    break
                await asyncio.sleep(1)
            return None
        finally:
            try: browser.stop()
            except: pass
    return asyncio.run(_do())


def _yt_dlp_js_runtime_opts() -> dict:
    """yt-dlp никогда не определяет JS-рантайм сам -- его нужно явно включить через
    'js_runtimes', иначе решение nsig/JS-challenge для YouTube не запускается вообще,
    даже если Node реально установлен. Предпочитаем забандленный Node (не зависит от
    того, стоит ли у юзера Node.js), иначе -- 'node' из системного PATH."""
    try:
        import nodejs_wheel.executable as _njs
        node_path = os.path.join(_njs.ROOT_DIR, 'node.exe' if os.name == 'nt' else 'node')
        if os.path.exists(node_path):
            return {'js_runtimes': {'node': {'path': node_path}}}
    except Exception:
        pass
    return {'js_runtimes': {'node': {}}}


_yt_cookiefile_path = None
_yt_cookiefile_cookie = None


def _youtube_cookiefile(cookie_header: str):
    """Конвертирует Cookie-заголовок из browser.json в Netscape cookie-файл для yt-dlp.
    yt-dlp считает передачу cookies HTTP-заголовком небезопасной (могут утечь на сторонние
    домены при редиректах) и требует --cookies file вместо этого."""
    global _yt_cookiefile_path, _yt_cookiefile_cookie
    if not cookie_header:
        return None
    if _yt_cookiefile_path and _yt_cookiefile_cookie == cookie_header and os.path.exists(_yt_cookiefile_path):
        return _yt_cookiefile_path
    expiry = int(time.time()) + 365 * 24 * 3600
    lines = ["# Netscape HTTP Cookie File"]
    for part in cookie_header.split(';'):
        name, sep, value = part.strip().partition('=')
        name = name.strip()
        if not sep or not name:
            continue
        lines.append(f".youtube.com\tTRUE\t/\tTRUE\t{expiry}\t{name}\t{value.strip()}")
    path = os.path.join(USER_DATA_DIR, 'yt_cookies.txt')
    try:
        with open(path, 'w', encoding='utf-8') as f:
            f.write('\n'.join(lines) + '\n')
    except Exception as e:
        print(f"[warn] failed to write yt cookiefile: {e}", file=sys.stderr)
        return None
    _yt_cookiefile_path = path
    _yt_cookiefile_cookie = cookie_header
    return path


_ptf_state = None  # (visitor_data, js, js_url, signature_timestamp, warmed_at)
_ptf_pot_cache = {}  # video_id -> (po_token, minted_at)
_ptf_pot_lock = threading.Lock()
_ptf_state_lock = threading.Lock()
_PTF_TOKEN_FILE = os.path.join(USER_DATA_DIR, 'ptf_pot.json')
_ptf_cipher = None  # (js_url, Cipher) -- живой, вместе со своими node-процессами
_ptf_node_close = _PtfNodeRunner.close

# pytubefix ругается на каждый вызов, что use_po_token/po_token_verifier устарели.
# Замены у них пока нет, а лог засоряется на каждый трек.
logging.getLogger('pytubefix').setLevel(logging.ERROR)


def _cipher_for(js, js_url):
    """Cipher.__init__ спавнит ДВА node-процесса и грузит в каждый 2MB base.js, а
    extract.apply_signature в finally их убивает -- на каждый трек. По замеру 2026-08-22
    это ~0.9с из ~1.2с резолва: не вычисление подписи, а холодный старт node. base.js между
    треками один и тот же, поэтому держим ровно одну пару процессов живой -- с ней
    расшифровка занимает 0.00-0.01с.

    Апстрим закрывает их не зря: при новой паре на каждый вызов утечка дескрипторов
    накапливается. У нас пара одна и меняется только при ротации base.js, где старую мы
    закрываем сами."""
    global _ptf_cipher
    if _ptf_cipher and _ptf_cipher[0] == js_url:
        return _ptf_cipher[1]
    if _ptf_cipher:
        old = _ptf_cipher[1]
        for runner in (old.runner_sig, old.runner_nsig):
            try:
                _ptf_node_close(runner)
            except Exception:
                pass
    _ptf_cipher = (js_url, _PtfCipher(js=js, js_url=js_url))
    return _ptf_cipher[1]


ptf_extract.Cipher = lambda js, js_url: _cipher_for(js, js_url)
_PtfNodeRunner.close = lambda self: None


def _pytubefix_state(video_id):
    """Сессионное состояние: visitor_data, base.js, signatureTimestamp. От трека не зависит,
    стоит ~1.5с и платится один раз на процесс."""
    global _ptf_state
    with _ptf_state_lock:
        if _ptf_state and time.time() - _ptf_state[4] < 3 * 3600:
            return _ptf_state[:4]
        yt = YouTube(f'https://www.youtube.com/watch?v={video_id}', client='WEB_MUSIC')
        _ptf_state = (yt.visitor_data, yt.js, yt.js_url, yt.signature_timestamp, time.time())
        return _ptf_state[:4]


def _pytubefix_pot(video_id):
    """PO-токен минтится НА КАЖДЫЙ video_id -- переиспользовать его между треками нельзя.

    Проверено в самом приложении (не в тестах -- они этого не ловят):
      * identifier=video_id  -> играет ровно тот ролик, для которого намолот, остальные
        падают в MEDIA_ELEMENT_ERROR Format error;
      * identifier=visitor_data -> не играет ни один.
    То есть googlevideo сверяет pot с video_id. Цена -- ~0.5с на трек (spawn node +
    botGuard VM), и она неустранима: без валидного pot ссылка выдаётся, но не
    воспроизводится. Кэш по video_id нужен для повторного резолва того же трека
    (prefetch, перезаход, сброс кэша ссылок в renderer)."""
    visitor_data = _pytubefix_state(video_id)[0]
    with _ptf_pot_lock:
        hit = _ptf_pot_cache.get(video_id)
        if hit and time.time() - hit[1] < 3 * 3600:
            return visitor_data, hit[0]
    po_token = _ptf_bot_guard.generate_po_token(video_id=video_id)
    with _ptf_pot_lock:
        if len(_ptf_pot_cache) > 256:
            # ponytail: примитивная эвикция вместо LRU -- список на 256 треков живёт минуты,
            # завести OrderedDict, если попаданий станет заметно меньше
            _ptf_pot_cache.clear()
        _ptf_pot_cache[video_id] = (po_token, time.time())
    return visitor_data, po_token


def _invalidate_pytubefix_state():
    """base.js ротируется примерно раз в сутки, PO-токен живёт часами -- после этого
    прогретое состояние врёт. Сбрасываем, следующий трек прогреется заново."""
    global _ptf_state
    with _ptf_state_lock:
        _ptf_state = None
    with _ptf_pot_lock:
        _ptf_pot_cache.clear()


def _resolve_fast(video_id):
    """Самый быстрый путь: один innertube player-запрос + локальная расшифровка на
    прогретом node. Замеры 2026-08-22: сам player-запрос ~0.3с, расшифровка 0.00-0.01с на
    прогретом node, botGuard ~0.5с -- итого ~0.8с против ~1.9с у pytubefix и ~4с у
    tv+cookies. Формат лучший из всех -- opus itag251 (145-168kbps) против itag140
    (m4a 128k) у pytubefix и itag18 (склейка с видео, 96k) у tv.

    Возвращает (url, loudness) или (None, None) на любой осечке -- дальше отработает
    обычная гонка. Громкость берём из этого же ответа: отдельный запрос за ней не нужен."""
    try:
        visitor_data, js, js_url, sig_ts = _pytubefix_state(video_id)
        _, po_token = _pytubefix_pot(video_id)

        it = _PtfInnerTube('WEB_MUSIC')
        # innertube_context у pytubefix -- ОБЩИЙ изменяемый словарь из _default_clients,
        # а не копия. Гонка потом мутирует его из нескольких потоков, поэтому работаем со своей.
        it.innertube_context = copy.deepcopy(it.innertube_context)
        # без signatureTimestamp часть треков приходит с playabilityStatus=UNPLAYABLE
        it.innertube_context.update(sig_ts)
        it.insert_po_token(visitor_data=visitor_data, po_token=po_token)
        resp = it.player(video_id)

        manifest = ptf_extract.apply_descrambler(resp['streamingData'])
        ptf_extract.apply_po_token(manifest, resp, po_token)
        audio = [f for f in manifest if str(f.get('mimeType', '')).startswith('audio/')]
        if not audio:
            return None, None
        best = [max(audio, key=lambda f: f.get('bitrate', 0))]
        ptf_extract.apply_signature(best, resp, js, js_url)
        return best[0].get('url'), extract_loudness(resp)
    except Exception as e:
        _invalidate_pytubefix_state()
        print(f"[debug] fast-path failed for {video_id}: {e}", file=sys.stderr)
        return None, None


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
                        safe_print({
                            'status': 'ok',
                            'tracks': tracks,
                            'continuation': next_c,
                            'callId': call_id
                        })
                    else:
                        response = api._send_request('browse', {'browseId': playlist_id})
                        shelf = nav(response, [*SINGLE_COLUMN_TAB, *SECTION_LIST_ITEM, 'musicShelfRenderer'], True) or {}
                        contents = shelf.get('contents', [])
                        conts = shelf.get('continuations', [])
                        next_c = conts[0].get('nextContinuationData', {}).get('continuation') if conts else None
                        tracks = [track_to_dict(t) for t in parse_playlist_items(contents) if track_to_dict(t)]
                        header_title = nav(response, ['header', 'musicHeaderRenderer', 'title', 'runs', 0, 'text'], True) or "Liked Tracks"
                        safe_print({
                            'status': 'ok',
                            'tracks': tracks,
                            'title': header_title,
                            'trackCount': len(tracks),
                            'continuation': next_c,
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
            
            # Извлекаем verified из raw_response badges
            raw_verified = False
            try:
                header = nav(raw_response, ['header', 'musicHeaderRenderer'])
                badges = header.get('badges', []) if header else []
                raw_verified = bool(_extract_badge_label(badges, 'VERIFIED'))
            except Exception:
                pass
            
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
                    params = f"&ctoken={continuation}&continuation={continuation}"
                    response = api._send_request('browse', {'browseId': 'FEmusic_home'}, params)
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

        elif command == 'get_library':
            api = get_api()
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

                safe_print({'status': 'ok', 'tab': tab, 'items': items, 'callId': call_id})
            except Exception as e:
                safe_print({'status': 'error', 'message': str(e), 'callId': call_id})

        elif command == 'shuffle_library_songs':
            api = get_api()
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
                safe_print({'status': 'ok', 'tracks': tracks, 'audioPlaylistId': 'MLCT', 'callId': call_id})
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
            artist = _clean_artist(request.get('artist'))
            title = _normalize_lyric_title(request.get('title'))
            duration = request.get('duration')
            video_id = request.get('videoId')

            def _lrclib_exact():
                if not (artist and title):
                    return None
                try:
                    params = {'artist_name': artist, 'track_name': title}
                    if duration: params['duration'] = int(duration)
                    r = requests.get('https://lrclib.net/api/get', params=params, timeout=5)
                    if r.status_code == 200:
                        d = r.json()
                        if d.get('plainLyrics') or d.get('syncedLyrics'):
                            return {'plainLyrics': d.get('plainLyrics'), 'syncedLyrics': d.get('syncedLyrics'), 'source': 'lrclib'}
                        # У трека без вокала lrclib отдаёт instrumental: true и пустые поля.
                        # Это не "не нашли", а "текста нет" -- в UI это разные экраны.
                        if d.get('instrumental'):
                            return {'instrumental': True, 'source': 'lrclib'}
                except: pass
                return None

            def _lrclib_search():
                if not title:
                    return None
                try:
                    q = f"{artist} {title}".strip() if artist else title
                    sr = requests.get('https://lrclib.net/api/search', params={'q': q}, timeout=5)
                    if sr.status_code == 200:
                        best = _pick_lrclib(sr.json() or [], title, artist, duration)
                        if best and (best.get('plainLyrics') or best.get('syncedLyrics')):
                            return {'plainLyrics': best.get('plainLyrics'), 'syncedLyrics': best.get('syncedLyrics'), 'source': 'lrclib'}
                except: pass
                return None

            def _netease():
                if not title:
                    return None
                try:
                    import syncedlyrics
                    q = f"{artist} {title}".strip() if artist else title
                    lrc = syncedlyrics.search(q, providers=["NetEase"], synced_only=False)
                    if lrc:
                        lines = lrc.strip().split('\n')
                        synced_lines = [l for l in lines if l.startswith('[') and ':' in l and ']' in l]
                        plain_lines = [l.split(']', 1)[1].strip() for l in lines if l.startswith('[') and ']' in l and l.split(']', 1)[1].strip()]
                        has_synced = len(synced_lines) > 2
                        return {
                            'plainLyrics': '\n'.join(plain_lines) if plain_lines else None,
                            'syncedLyrics': lrc if has_synced else None,
                            'source': 'netease'
                        }
                except: pass
                return None

            def _ytmusic():
                """Тексты самого YT Music (Musixmatch) -- часто с таймкодами там, где lrclib пуст.
                browseId лежит в watch-плейлисте трека, отдельный поиск не нужен."""
                if not video_id:
                    return None
                try:
                    yt = get_api()
                    browse_id = (yt.get_watch_playlist(videoId=video_id, limit=1) or {}).get('lyrics')
                    if not browse_id:
                        return None
                    ly = yt.get_lyrics(browse_id, timestamps=True)
                    if not ly:
                        return None
                    if not ly.get('hasTimestamps'):
                        text = (ly.get('lyrics') or '').strip()
                        return {'plainLyrics': text, 'syncedLyrics': None, 'source': 'ytmusic'} if text else None
                    lines = ly.get('lyrics') or []
                    plain = [l.text for l in lines if l.text.strip() and l.text.strip() != '♪']
                    if not plain:
                        return {'instrumental': True, 'source': 'ytmusic'}
                    lrc = '\n'.join(
                        f'[{l.start_time // 60000:02d}:{l.start_time // 1000 % 60:02d}.{l.start_time % 1000 // 10:02d}]{l.text}'
                        for l in lines)
                    return {'plainLyrics': '\n'.join(plain), 'syncedLyrics': lrc, 'source': 'ytmusic'}
                except: pass
                return None

            # LRCLIB (точный + поиск), NetEase и YT Music -- параллельно.
            # Как только один вернул synced -- берём его и отменяем остальные.
            result = None
            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                futures = {
                    pool.submit(_lrclib_exact): 'lrclib_exact',
                    pool.submit(_lrclib_search): 'lrclib_search',
                    pool.submit(_netease): 'netease',
                    pool.submit(_ytmusic): 'ytmusic',
                }
                for future in concurrent.futures.as_completed(futures, timeout=15):
                    try:
                        r = future.result(timeout=0)
                    except: continue
                    if not r: continue
                    # Приоритет: synced > plain > instrumental
                    if r.get('syncedLyrics'):
                        result = r
                        for f in futures: f.cancel()
                        break
                    if result is None or (result.get('instrumental') and r.get('plainLyrics')):
                        result = r

            if result and not result.get('instrumental'):
                safe_print({'status': 'ok', **result, 'callId': call_id})
                return

            # Фолбэк: Genius (plain only).
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

            # Фолбэк: lyrics.ovh (plain only).
            if artist:
                ovh = fetch_lyrics_ovh(artist, title)
                if ovh:
                    safe_print({
                        'status': 'ok',
                        'plainLyrics': ovh['plainLyrics'],
                        'syncedLyrics': None,
                        'source': 'lyrics.ovh',
                        'callId': call_id
                    })
                    return

            # Текста нет не потому что не нашли, а потому что его нет.
            if result and result.get('instrumental'):
                safe_print({'status': 'ok', 'instrumental': True, 'plainLyrics': None,
                            'syncedLyrics': None, 'source': result.get('source'), 'callId': call_id})
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

        elif command == 'set_po_token':
            global _yt_po_token, _yt_data_sync_id
            token = request.get('token')
            dsid = request.get('dataSyncId')
            if token:
                _yt_po_token = token
                print(f"[po_token] cached new token ({len(token)} chars)", file=sys.stderr)
            if dsid:
                _yt_data_sync_id = dsid
                print(f"[po_token] cached dataSyncId from real browser session", file=sys.stderr)
            else:
                print(f"[po_token] WARNING: no dataSyncId from mint - web_music formats may 403 on real fetch", file=sys.stderr)
            safe_print({'status': 'ok', 'callId': call_id})

        elif command == 'get_stream_url':
            start_time = time.time()
            video_id = request.get('videoId')
            url = f"https://www.youtube.com/watch?v={video_id}"
            
            stream_url = None
            loudness = None  # None = не знаем; 0.0 = трек ровно на цели. Раньше это было одно и то же
            watchtime_url = None
            method = "None"

            # pytubefix и yt-dlp запускаются ПАРАЛЛЕЛЬНО (гонка), а не по очереди:
            # pytubefix быстрый (~0.3с), когда работает, но стабильно ловит
            # бот-детект на непопулярном контенте (проверено эмпирически — не связано
            # с PO Token, сама форма запроса подозрительна для Google). yt-dlp медленнее
            # (~2-2.5с), но надёжнее на таком контенте. Гонка даёт лучшее из двух: если
            # pytubefix успел первым - используем его и не ждём yt-dlp; если он упал -
            # время не потеряно, yt-dlp уже параллельно резолвился с самого начала.
            # 'mweb' не используется в player_client: он всегда требует GVS PO Token,
            # которого у нас нет, и просто съедает время на клиент, чьи форматы всё
            # равно потом отбрасываются. player_skip=webpage,configs — не тянем HTML
            # страницы и конфиги, только сам API-запрос форматов (~2x быстрее по замерам).

            # loudnessDb и watchtimeUrl достаём через player-эндпоинт параллельно с yt-dlp —
            # это отдельный лёгкий запрос metadata, не упирается в GVS PO Token (тот нужен
            # только для самих URL закачки), так что не тормозит резолв. Используем сырой
            # _send_request вместо get_song(), т.к. get_song() обрезает ответ и выкидывает
            # responseContext, откуда мы заодно достаём account dataSyncId (см. ниже) —
            # без него yt-dlp на авторизованной сессии не может даже попытаться получить
            # GVS PO Token и просто пишет warning на каждый трек.
            def _fetch_meta():
                try:
                    api = get_api()
                    params = {
                        'playbackContext': {'contentPlaybackContext': {'signatureTimestamp': get_datestamp() - 1}},
                        'video_id': video_id,
                    }
                    song = api._send_request('player', params)
                    wt = nav(song, ['playbackTracking', 'videostatsWatchtimeUrl', 'baseUrl'], True)
                    dsid = nav(song, ['responseContext', 'mainAppWebResponseContext', 'datasyncId'], True)
                    if dsid:
                        global _yt_data_sync_id
                        _yt_data_sync_id = dsid
                    return extract_loudness(song), wt
                except Exception as e:
                    print(f"[warn] player meta fetch failed for {video_id}: {e}", file=sys.stderr)
                    return None, None

            meta_pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)
            meta_future = meta_pool.submit(_fetch_meta)

            def _try_pytubefix():
                # WEB_MUSIC, а не ANDROID_VR. Замер 2026-08-22 (python/test_pytube.py, реальный
                # домашний IP): ANDROID_VR ловит бот-детект на 100% треков за 0.3с, то есть в
                # гонке был гарантированным балластом. WEB_MUSIC отдаёт itag140 (чистое аудио
                # m4a 128kbps) за ~1.9с БЕЗ КУК -- вдвое быстрее tv+cookies, и без склейки с
                # видеодорожкой, как в itag18 у tv.
                #
                # Почему у pytubefix web-клиенты живы, а у yt-dlp то же семейство даёт ноль
                # форматов: pytubefix сам минтит PO-токен через botGuard (PR #209/#408), yt-dlp
                # так не умеет. Расшифровки подписи здесь нет вообще (nsig=0.00с по замеру) --
                # URL приходят уже подписанными, медленный jsinterp не задействован.
                #
                # Известный дефект: ~8% вызовов падают в RegexMatchError
                # (get_throttling_function_name) на свежем base.js, который YouTube раздаёт по
                # A/B, и стоят ~5с. Терпимо только потому, что это racer -- остальные бегут
                # параллельно. Единственным путём этот клиент делать нельзя.
                try:
                    pot = _pytubefix_pot(video_id)
                    tube = YouTube(url, client='WEB_MUSIC', use_po_token=True,
                                   po_token_verifier=lambda: pot, token_file=_PTF_TOKEN_FILE)
                    stream = tube.streams.get_audio_only()
                    return stream.url if stream else None
                except Exception as e:
                    print(f"[debug] pytubefix failed for {video_id}: {e}", file=sys.stderr)
                    return None

            def _try_yt_dlp_web():
                # web, а не android_vr. Замер 2026-08-22 с домашнего IP: клиент ANDROID_VR
                # ловит бот-детект на 100% треков, так что этот racer был гарантированным
                # балластом и лишним флагнутым запросом на каждый трек.
                #
                # Голый web тоже мёртв, но по другой причине: у него GVS_PO_TOKEN_POLICY
                # required=True (yt_dlp/extractor/youtube/_base.py), без токена -- ноль
                # форматов. Прежний вывод «yt-dlp хардкодит SABR для web» был неточен: в
                # _video.py это лишь диагностическое сообщение о поведении YouTube.
                #
                # Токен у нас есть -- тот же, что мы минтим botGuard'ом для pytubefix, он
                # привязан к visitor_data, а не к video_id (проверено переиспользованием на
                # трёх треках). Прокидываем пару в yt-dlp и получаем рабочий web.
                #
                # Смысл держать его рядом с pytubefix-racer'ом на том же клиенте: pytubefix
                # в ~8% вызовов давится свежим base.js (RegexMatchError), парсер yt-dlp
                # заметно устойчивее и закрывает именно этот отказ.
                #
                # Куки не передаются сознательно: с ними content binding токена
                # переключается на datasync_id, и наш visitor_data-токен станет невалиден.
                try:
                    visitor_data, po_token = _pytubefix_pot(video_id)

                    class MyLogger:
                        def debug(self, msg): pass
                        def warning(self, msg): pass
                        def error(self, msg): pass

                    ydl_opts = {
                        'format': 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best',
                        'quiet': True, 'no_warnings': True, 'nocheckcertificate': True,
                        'logger': MyLogger(),
                        'youtube_include_dash_manifest': False, 'cachedir': False,
                        'extractor_args': {'youtube': {
                            'player_client': ['web'], 'skip': ['hls', 'dash'],
                            'visitor_data': [visitor_data],
                            'po_token': ['web.gvs+' + po_token],
                        }},
                        'extractor_timeout': 15, 'socket_timeout': 15,
                        **_yt_dlp_js_runtime_opts(),
                    }
                    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                        info = ydl.extract_info(url, download=False)
                        return info['url']
                except Exception as e:
                    print(f"[debug] yt-dlp(web) failed for {video_id}: {e}", file=sys.stderr)
                    return None

            def _try_yt_dlp_cookies():
                # Единственный авторизованный путь - и, вопреки первоначальным ожиданиям,
                # основной рабочий: cookie-less клиенты (visionos/android_vr/pytubefix)
                # ловят бот-детект почти на всём реальном контенте, а этот проходит.
                # Отдаёт progressive itag18 с c=TVHTML5, ~4с.
                #
                # ВАЖНО: здесь НЕ ставится player_skip=webpage. С ним tv возвращает
                # "Requested format is not available" (0 форматов) - ему нужен ytcfg
                # авторизованной сессии со страницы. Именно из-за player_skip в ранних
                # замерах казалось, что tv мёртв, как и всё семейство web.
                if not (_auth_type == 'browser' and _auth_data):
                    return None
                cookie = _auth_data.get('Cookie')
                if not cookie:
                    return None
                cookiefile = _youtube_cookiefile(cookie)
                if not cookiefile:
                    return None
                try:
                    class MyLogger:
                        def debug(self, msg): pass
                        def warning(self, msg): pass
                        def error(self, msg): pass

                    yt_args = {
                        'player_client': ['tv', 'web', 'mweb'],
                        'skip': ['dash'],
                    }
                    if _yt_data_sync_id:
                        yt_args['data_sync_id'] = [_yt_data_sync_id]
                    if _yt_po_token:
                        yt_args['po_token'] = ['web.gvs+' + _yt_po_token]

                    ydl_opts = {
                        'format': 'bestaudio/best',
                        'quiet': True, 'no_warnings': True, 'nocheckcertificate': True,
                        'logger': MyLogger(),
                        'youtube_include_dash_manifest': False, 'cachedir': False,
                        'cookiefile': cookiefile,
                        'extractor_args': {'youtube': yt_args},
                        'extractor_timeout': 20, 'socket_timeout': 20,
                        **_yt_dlp_js_runtime_opts(),
                    }
                    ua = _auth_data.get('User-Agent')
                    if ua:
                        ydl_opts['user_agent'] = ua

                    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                        info = ydl.extract_info(url, download=False)
                        return info['url']
                except Exception as e:
                    print(f"[debug] yt-dlp(cookies/age-gate) failed for {video_id}: {e}", file=sys.stderr)
                    return None

            def _try_yt_dlp_visionos():
                # VISIONOS - единственный клиент, отдающий настоящие adaptive-форматы
                # (opus/251) вообще без GVS PO Token и без JS-плеера: у него
                # REQUIRE_JS_PLAYER=False и GvsPoTokenPolicy(required=False) по всем
                # протоколам, и он не входит в захардкоженный SABR-форс (там только
                # web/web_safari). Появился в yt-dlp начиная с nightly - отсюда пин
                # версии в requirements.txt. Минус: заметно медленнее (~5с против ~1.5с
                # у android_vr), поэтому в гонке ему даётся фора, а не голая скорость.
                # Оговорка апстрима: "made for kids" видео этому клиенту недоступны -
                # на них он вернёт None и выиграют остальные.
                try:
                    class MyLogger:
                        def debug(self, msg): pass
                        def warning(self, msg): pass
                        def error(self, msg): pass

                    ydl_opts = {
                        'format': 'bestaudio[ext=webm]/bestaudio/best',
                        'quiet': True, 'no_warnings': True, 'nocheckcertificate': True,
                        'logger': MyLogger(),
                        'youtube_include_dash_manifest': False, 'cachedir': False,
                        'extractor_args': {'youtube': {
                            'player_client': ['visionos'], 'skip': ['hls', 'dash'],
                            'player_skip': ['webpage', 'configs'],
                        }},
                        'extractor_timeout': 15, 'socket_timeout': 15,
                        **_yt_dlp_js_runtime_opts(),
                    }
                    # КУКИ СЮДА НЕ ПЕРЕДАЮТСЯ СОЗНАТЕЛЬНО. У visionos SUPPORTS_COOKIES=False,
                    # и при наличии кук yt-dlp молча выкидывает клиент целиком
                    # ("Skipping client visionos since it does not support cookies"),
                    # после чего падает с "Failed to extract any player response".
                    # Проверено: с куками 0/4 треков, без кук тот же трек - 1.4с и opus 251.
                    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                        info = ydl.extract_info(url, download=False)
                        return info['url']
                except Exception as e:
                    print(f"[debug] yt-dlp(visionos) failed for {video_id}: {e}", file=sys.stderr)
                    return None

            if not stream_url:
                # Быстрый путь идёт ПЕРЕД гонкой, а не в ней: он выигрывает почти всегда
                # (~0.3с), и запускать ради этого ещё четыре запроса значит зря светить IP
                # флагнутыми клиентами. Осечка стоит 0.3с, после неё отрабатывает гонка.
                stream_url, fast_loudness = _resolve_fast(video_id)
                if stream_url:
                    method = 'fast'
                    if fast_loudness is not None:
                        loudness = fast_loudness

            if not stream_url:
                # Три racer'а из четырёх ходят БЕЗ КУК, и это необходимость, а не упущение:
                # у visionos SUPPORTS_COOKIES=False (с куками yt-dlp выбрасывает клиент), а у
                # pytubefix/web куки переключили бы content binding PO-токена на datasync_id,
                # и наш visitor_data-токен стал бы невалиден.
                #
                # tv+cookies бежит В ГОНКЕ, а не после неё. Долго был единственным рабочим
                # путём, теперь -- самый медленный (~4с) и худший по формату (itag18 = склейка
                # видео+аудио 96k). Оставлен как страховка на age-restricted.
                #
                # Гонка приоритетная, а не «кто первый»: форматы у racer'ов разные, и брать
                # первого попавшегося значит систематически терять качество. Порядок по
                # качеству: visionos (opus 251) > pytubefix/web (itag140, чистое аудио m4a
                # 128k, ~1.9-2.3с) > tv+cookies (itag18). pytubefix и web ходят на одном и том
                # же клиенте разными библиотеками намеренно -- pytubefix быстрее стартует, но
                # в ~8% случаев давится свежим base.js, yt-dlp устойчивее.
                PRIORITY = ['visionos', 'pytubefix', 'web', 'tv+cookies']
                racer_fns = {
                    'visionos': _try_yt_dlp_visionos,
                    'pytubefix': _try_pytubefix,
                    'web': _try_yt_dlp_web,
                    'tv+cookies': _try_yt_dlp_cookies,
                }

                stream_pool = concurrent.futures.ThreadPoolExecutor(max_workers=len(racer_fns))
                racers = {stream_pool.submit(fn): name for name, fn in racer_fns.items()}
                pending = set(racers.keys())
                results = {}
                while pending:
                    done, pending = concurrent.futures.wait(
                        pending, return_when=concurrent.futures.FIRST_COMPLETED)
                    for fut in done:
                        try:
                            results[racers[fut]] = fut.result()
                        except Exception:
                            results[racers[fut]] = None
                    best_name = PRIORITY[0]
                    if results.get(best_name):
                        break  # лучший вариант готов, остальных ждать незачем
                    if best_name in results and any(results.get(n) for n in PRIORITY):
                        break  # лучший отпал, запасной уже есть

                for name in PRIORITY:
                    if results.get(name):
                        stream_url = results[name]
                        method = name
                        break

                # Проигравший (если ещё бежит) доигрывает в фоне и результат просто
                # отбрасывается - поток демонический (main() стартует его так же),
                # ждать его незачем.
                stream_pool.shutdown(wait=False)

            try:
                ld, wt = meta_future.result(timeout=10)
                if loudness is None and ld is not None:
                    loudness = ld  # запасной вариант: быстрый путь не отработал
                watchtime_url = wt
            except Exception as e:
                print(f"[warn] meta fetch timeout for {video_id}: {e}", file=sys.stderr)
            finally:
                meta_pool.shutdown(wait=False)

            total_time = time.time() - start_time
            print(f"[perf] get_stream_url ({method}) for {video_id}: {total_time:.3f}s (loudness: {loudness})", file=sys.stderr)

            if stream_url:
                safe_print({'status': 'ok', 'url': stream_url, 'loudness': loudness,
                            'watchtimeUrl': watchtime_url, 'callId': call_id})
            else:
                safe_print({'status': 'error', 'message': 'Failed to obtain stream URL', 'callId': call_id})

        elif command == 'measure_loudness':
            # Фоновый замер для стримов без метаданных громкости (SoundCloud и редкие
            # YT-треки, где YouTube не отдал perceptualLoudnessDb). Каждый запрос и так
            # обрабатывается в своём потоке, воспроизведение не ждёт.
            t0 = time.time()
            loud, tp = measure_loudness_full(request.get('url'))
            print(f"[perf] measure_loudness: {time.time() - t0:.1f}s (loudness: {loud}, tp: {tp})", file=sys.stderr)
            if loud is None:
                safe_print({'status': 'error', 'message': 'loudnorm failed', 'callId': call_id})
            else:
                safe_print({'status': 'ok', 'loudness': loud, 'truePeak': tp, 'callId': call_id})

        elif command == 'send_watchtime':
            wt_url = request.get('watchtimeUrl')
            if not wt_url:
                safe_print({'status': 'error', 'message': 'No watchtimeUrl', 'callId': call_id})
            else:
                rt = request.get('rt', 0)
                params = {
                    'fmt': 0, 'fs': 0, 'euri': '', 'ver': 2,
                    'cbr': 'Chrome', 'cbrver': '134.0.0.0',
                    'c': 'WEB_REMIX', 'cver': '1.20260324.11.00',
                    'cplayer': 'UNIPLAYER', 'cos': 'Windows', 'cosver': '10.0',
                    'cplatform': 'DESKTOP', 'hl': 'en_US',
                    'afmt': 140, 'muted': 0, 'vis': 10, 'volume': 100,
                    'cpn': request.get('cpn'),
                    'cmt': request.get('cmt'),
                    'st': request.get('st'),
                    'et': request.get('et'),
                    'state': request.get('state', 'playing'),
                    'len': request.get('len'),
                    'rt': rt,
                    'rtn': round(rt + 40, 3),
                    'rti': rt,
                    'lact': request.get('lact', 0),
                }
                params = {k: v for k, v in params.items() if v is not None}
                r = requests.get(wt_url, params=params, timeout=10)
                print(f"[watchtime] {request.get('state')} cmt={request.get('cmt')} -> {r.status_code}", file=sys.stderr)
                safe_print({'status': 'ok', 'httpStatus': r.status_code, 'callId': call_id})

        elif command == 'search_alternatives':
            query = request.get('query', '')
            limit = max(1, min(int(request.get('limit', 5) or 5), 40))
            try:
                ydl_opts = {
                    'quiet': True,
                    'no_warnings': True,
                    'extract_flat': True,
                    'default_search': f'scsearch{limit}:{query}',
                }
                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    info = ydl.extract_info(f'scsearch{limit}:{query}', download=False)
                results = []
                for entry in (info.get('entries') or []):
                    if not entry:
                        continue
                    thumbs = entry.get('thumbnails') or []
                    thumb_url = thumbs[-1].get('url', '') if thumbs else ''
                    raw_url = entry.get('url') or entry.get('webpage_url', '')
                    # yt-dlp иногда отдаёт api.soundcloud.com/tracks/... — ре‐золвим в permalink_url
                    sc_id = str(entry.get('id') or '')
                    if 'soundcloud.com/tracks/' in raw_url and not raw_url.startswith('https://soundcloud.com/'):
                        tid = _sc_extract_track_id(raw_url) or _sc_extract_track_id(sc_id)
                        if tid:
                            resolved = _sc_api_get(f'/tracks/{tid}', {}, {})
                            if resolved and resolved.get('permalink_url'):
                                raw_url = resolved['permalink_url']
                                sc_id = str(resolved.get('id') or tid)
                    results.append({
                        'url': raw_url,
                        'title': entry.get('title', ''),
                        'artist': entry.get('uploader') or entry.get('artist', ''),
                        'duration': entry.get('duration'),
                        'thumbUrl': thumb_url,
                        'source': 'soundcloud',
                        'scId': sc_id,
                        'uploaderUrl': entry.get('uploader_url') or entry.get('channel_url') or '',
                    })
                safe_print({'status': 'ok', 'results': results, 'callId': call_id})
            except Exception as e:
                print(f"[error] search_alternatives: {e}", file=sys.stderr)
                safe_print({'status': 'error', 'message': str(e), 'callId': call_id})

        elif command == 'get_soundcloud_artist':
            # Треки SoundCloud-исполнителя через api-v2: /resolve(profile) -> /users/{id}/tracks.
            # Быстрее yt-dlp, правильный аватар (avatar_url), больше треков, есть scId.
            url = request.get('url', '')
            try:
                user = _sc_api_get('/resolve', {'url': url})
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
                            data = _sc_api_get(next_url.replace('https://api-v2.soundcloud.com', ''), {})
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
                                    'thumbUrl': _sc_pick_thumb(t.get('artwork_url') or ''),
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
                        alb_data = _sc_api_get(f'/users/{uid}/albums', {'limit': 20})
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
                                'thumbUrl': _sc_pick_thumb(a.get('artwork_url') or ''),
                                'trackCount': a.get('track_count', 0),
                                'year': year,
                            })
                        return album_list

                    def fetch_playlists():
                        """Загружает плейлисты."""
                        pl_data = _sc_api_get(f'/users/{uid}/playlists', {'limit': 20})
                        playlist_list = []
                        for p in ((pl_data or {}).get('collection') or []):
                            if not p or not p.get('permalink_url'):
                                continue
                            playlist_list.append({
                                'url': p.get('permalink_url', ''),
                                'title': p.get('title', ''),
                                'artist': username,
                                'thumbUrl': _sc_pick_thumb(p.get('artwork_url') or ''),
                                'trackCount': p.get('track_count', 0),
                            })
                        return playlist_list

                    def fetch_related():
                        """Загружает похожих артистов (followings)."""
                        try:
                            follow_data = _sc_api_get(f'/users/{uid}/followings', {'limit': 10})
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
                safe_print({
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
                    'callId': call_id,
                })
            except Exception as e:
                print(f"[error] get_soundcloud_artist: {e}", file=sys.stderr)
                safe_print({'status': 'error', 'message': str(e), 'callId': call_id})

        elif command == 'search_soundcloud_extra':
            # Поиск SC-артистов и альбомов через внутренний api-v2 (scsearch yt-dlp умеет только треки).
            query = request.get('query', '')
            try:
                artists, albums = [], []
                if query.strip():
                    users = _sc_api_get('/search/users', {'q': query, 'limit': 8})
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
                    alb = _sc_api_get('/search/albums', {'q': query, 'limit': 8})
                    for a in ((alb or {}).get('collection') or []):
                        if not a.get('permalink_url'):
                            continue
                        user = a.get('user') or {}
                        albums.append({
                            'url': a.get('permalink_url', ''),
                            'title': a.get('title', ''),
                            'thumbUrl': _sc_pick_thumb(a.get('artwork_url') or ''),
                            'artist': user.get('username', ''),
                            'uploaderUrl': user.get('permalink_url', ''),
                            'source': 'soundcloud',
                        })
                safe_print({'status': 'ok', 'artists': artists, 'albums': albums, 'callId': call_id})
            except Exception as e:
                print(f"[error] search_soundcloud_extra: {e}", file=sys.stderr)
                safe_print({'status': 'error', 'message': str(e), 'callId': call_id})

        elif command == 'get_soundcloud_album':
            # Треки SC-альбома/плейлиста по URL (yt-dlp понимает permalink альбома).
            url = request.get('url', '')
            try:
                ydl_opts = {
                    'quiet': True,
                    'no_warnings': True,
                    'playlistend': 50,
                }
                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    info = ydl.extract_info(url, download=False)
                results = []
                for entry in (info.get('entries') or []):
                    if not entry:
                        continue
                    thumbs = entry.get('thumbnails') or []
                    thumb_url = thumbs[-1].get('url', '') if thumbs else (entry.get('thumbnail') or '')
                    results.append({
                        'url': entry.get('webpage_url') or entry.get('url', ''),
                        'title': entry.get('title', ''),
                        'artist': entry.get('uploader') or info.get('uploader') or '',
                        'duration': entry.get('duration'),
                        'thumbUrl': thumb_url,
                        'source': 'soundcloud',
                        'scId': str(entry.get('id') or ''),
                        'uploaderUrl': entry.get('uploader_url') or info.get('uploader_url') or '',
                    })
                info_thumbs = info.get('thumbnails') or []
                album_thumb = info_thumbs[-1].get('url', '') if info_thumbs else (results[0]['thumbUrl'] if results else '')
                safe_print({
                    'status': 'ok',
                    'title': info.get('title', ''),
                    'artist': info.get('uploader', ''),
                    'uploaderUrl': info.get('uploader_url', ''),
                    'thumbUrl': album_thumb,
                    'results': results,
                    'callId': call_id,
                })
            except Exception as e:
                print(f"[error] get_soundcloud_album: {e}", file=sys.stderr)
                safe_print({'status': 'error', 'message': str(e), 'callId': call_id})

        elif command == 'sc_client_id':
            # client_id для webview-лайка на стороне renderer.
            try:
                safe_print({'status': 'ok', 'clientId': get_sc_client_id() or '', 'appVersion': get_sc_app_version(), 'callId': call_id})
            except Exception as e:
                safe_print({'status': 'error', 'message': str(e), 'callId': call_id})

        elif command == 'sc_me':
            # Проверка oauth_token и данные SC-аккаунта (для статуса подключения).
            token = request.get('token', '')
            try:
                me = _sc_api_get('/me', {}, oauth_token=token) if token else None
                if me and me.get('id'):
                    safe_print({
                        'status': 'ok', 'connected': True,
                        'id': me.get('id'),
                        'username': me.get('username', ''),
                        'avatarUrl': _sc_pick_thumb(me.get('avatar_url') or ''),
                        'permalinkUrl': me.get('permalink_url', ''),
                        'callId': call_id,
                    })
                else:
                    safe_print({'status': 'ok', 'connected': False, 'callId': call_id})
            except Exception as e:
                print(f"[error] sc_me: {e}", file=sys.stderr)
                safe_print({'status': 'error', 'message': str(e), 'callId': call_id})

        elif command == 'sc_like_nodriver':
            sc_id = request.get('scId', '')
            url = request.get('url', '')
            tid = _sc_extract_track_id(sc_id) or _sc_extract_track_id(url)
            if tid and (not url or not url.startswith('https://soundcloud.com/')):
                resolved = (_sc_api_get(f'/tracks/{tid}', {}, {}) or {}).get('permalink_url') if tid else ''
                if resolved: url = resolved
            if not url:
                safe_print({'status': 'error', 'message': 'Could not resolve track URL', 'callId': call_id})
            else:
                liked = request.get('liked', True)
                profile_dir = request.get('profileDir', '')
                oauth_token = request.get('oauthToken') or None
                app_bounds = request.get('appBounds') or None
                browser_path = request.get('browserPath') or None
                try:
                    result = _sc_nodriver_like(profile_dir, url, oauth_token, liked, app_bounds, browser_path)
                    safe_print({'status': 'ok' if result != 'error' else 'error',
                                'liked': result, 'callId': call_id})
                except Exception as e:
                    print(f"[error] sc_like_nodriver: {e}", file=sys.stderr)
                    safe_print({'status': 'error', 'message': str(e),
                                'callId': call_id})

        elif command == 'sc_setup_profile':
            profile_dir = request.get('profileDir', '')
            browser_path = request.get('browserPath') or None
            try:
                token = _sc_nodriver_login(profile_dir, browser_path)
                if token:
                    safe_print({'status': 'ok', 'token': token, 'callId': call_id})
                else:
                    safe_print({'status': 'error', 'message': 'Login cancelled or failed',
                                'callId': call_id})
            except Exception as e:
                print(f"[error] sc_setup_profile: {e}", file=sys.stderr)
                safe_print({'status': 'error', 'message': str(e),
                            'callId': call_id})

        elif command == 'sc_liked_ids':
            # Permalink-URL'ы лайкнутых треков пользователя (для статуса лайков в радио/поиске).
            token = request.get('token', '')
            try:
                me = _sc_api_get('/me', {}, oauth_token=token) if token else None
                uid = (me or {}).get('id')
                ids = []
                if uid:
                    next_url = f'https://api-v2.soundcloud.com/users/{uid}/track_likes'
                    next_params = {'limit': 200, 'linked_partitioning': 1, 'client_id': get_sc_client_id()}
                    for _ in range(5):  # до ~1000 лайков
                        r = requests.get(next_url, params=next_params, headers=_sc_headers(token), timeout=12)
                        if not r.ok:
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
                safe_print({'status': 'ok', 'ids': ids, 'callId': call_id})
            except Exception as e:
                print(f"[error] sc_liked_ids: {e}", file=sys.stderr)
                safe_print({'status': 'error', 'message': str(e), 'callId': call_id})

        elif command == 'sc_liked_tracks':
            # Полные объекты лайкнутых треков (для вкладки лайков).
            token = request.get('token', '')
            try:
                me = _sc_api_get('/me', {}, oauth_token=token) if token else None
                uid = (me or {}).get('id')
                results = []
                if uid:
                    next_url = f'https://api-v2.soundcloud.com/users/{uid}/track_likes'
                    next_params = {'limit': 200, 'linked_partitioning': 1, 'client_id': get_sc_client_id()}
                    for _ in range(5):  # до ~1000 лайков
                        r = requests.get(next_url, params=next_params, headers=_sc_headers(token), timeout=12)
                        if not r.ok:
                            break
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
                                'thumbUrl': _sc_pick_thumb(t.get('artwork_url') or ''),
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
                safe_print({'status': 'ok', 'results': results, 'callId': call_id})
            except Exception as e:
                print(f"[error] sc_liked_tracks: {e}", file=sys.stderr)
                safe_print({'status': 'error', 'message': str(e), 'callId': call_id})

        elif command == 'sc_liked_meta':
            # Дёшево: общее число SC-лайков + первые id (для сверки без полной загрузки).
            token = request.get('token', '')
            try:
                me = _sc_api_get('/me', {}, oauth_token=token) if token else None
                uid = (me or {}).get('id')
                count = int((me or {}).get('likes_count') or 0)
                head_ids = []
                if uid:
                    data = _sc_api_get(f'/users/{uid}/track_likes', {'limit': 15}, oauth_token=token)
                    for item in ((data or {}).get('collection') or []):
                        t = item.get('track') or {}
                        if t.get('id') is not None:
                            head_ids.append(str(t['id']))
                safe_print({'status': 'ok', 'count': count, 'headIds': head_ids, 'callId': call_id})
            except Exception as e:
                print(f"[error] sc_liked_meta: {e}", file=sys.stderr)
                safe_print({'status': 'error', 'message': str(e), 'callId': call_id})

        elif command == 'sc_wave_stations':
            # Курируемые станции SoundCloud (жанровые подборки из mixed-selections).
            # С токеном — региональные/персональные подборки как в залогиненном вебе.
            token = request.get('token', '')
            try:
                data = _sc_api_get('/mixed-selections', {'limit': 6}, oauth_token=token or None)
                stations = []
                seen = set()
                for sel in ((data or {}).get('collection') or []):
                    urn = sel.get('urn') or ''
                    # Только «Trending by genre» — там подборки лучше, чем editorial/charts.
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
                safe_print({'status': 'ok', 'stations': stations, 'callId': call_id})
            except Exception as e:
                print(f"[error] sc_wave_stations: {e}", file=sys.stderr)
                safe_print({'status': 'error', 'message': str(e), 'callId': call_id})

        elif command == 'sc_station_tracks':
            # Треки станции (плейлиста) через api-v2: /playlists/{id} → ids → /tracks?ids (быстро).
            sid = request.get('id', '')
            token = request.get('token', '')
            try:
                results = []
                if sid:
                    pl = _sc_api_get(f'/playlists/{sid}', {'representation': 'full'}, oauth_token=token or None)
                    ids = [str(t.get('id')) for t in ((pl or {}).get('tracks') or []) if t.get('id')][:50]
                    full = _sc_api_get('/tracks', {'ids': ','.join(ids)}, oauth_token=token or None) if ids else []
                    # /tracks?ids отдаёт в произвольном порядке — восстанавливаем порядок плейлиста.
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
                            'thumbUrl': _sc_pick_thumb(t.get('artwork_url') or ''),
                            'source': 'soundcloud',
                            'scId': str(t.get('id') or ''),
                            'uploaderUrl': user.get('permalink_url', ''),
                        })
                safe_print({'status': 'ok', 'results': results, 'callId': call_id})
            except Exception as e:
                print(f"[error] sc_station_tracks: {e}", file=sys.stderr)
                safe_print({'status': 'error', 'message': str(e), 'callId': call_id})

        elif command == 'sc_recommendations':
            # SC-радио от трека: api-v2 /tracks/{id}/related (с oauth_token — персонализировано).
            token = request.get('token', '')
            sc_id = request.get('scId', '')
            track_url = request.get('url', '')
            try:
                tid = sc_id or _sc_extract_track_id(track_url)
                if not tid and track_url:
                    resolved = _sc_api_get('/resolve', {'url': track_url}, oauth_token=token or None)
                    tid = (resolved or {}).get('id')
                results = []
                if tid:
                    data = _sc_api_get(f'/tracks/{tid}/related', {'limit': 25}, oauth_token=token or None)
                    for t in ((data or {}).get('collection') or []):
                        if not t or not t.get('permalink_url'):
                            continue
                        user = t.get('user') or {}
                        results.append({
                            'url': t.get('permalink_url', ''),
                            'title': t.get('title', ''),
                            'artist': user.get('username', ''),
                            'duration': int((t.get('duration') or 0) / 1000),  # api-v2 отдаёт мс
                            'thumbUrl': _sc_pick_thumb(t.get('artwork_url') or ''),
                            'source': 'soundcloud',
                            'scId': str(t.get('id') or ''),
                            'uploaderUrl': user.get('permalink_url', ''),
                        })
                safe_print({'status': 'ok', 'results': results, 'callId': call_id})
            except Exception as e:
                print(f"[error] sc_recommendations: {e}", file=sys.stderr)
                safe_print({'status': 'error', 'message': str(e), 'callId': call_id})

        elif command == 'get_soundcloud_playlist':
            # SoundCloud плейлист: api-v2 /playlists/{id} или /resolve(url)
            url = request.get('url', '')
            try:
                # Resolve playlist URL to get ID
                resolved = _sc_api_get('/resolve', {'url': url})
                if not resolved:
                    safe_print({'status': 'error', 'message': 'Playlist not found', 'callId': call_id})
                else:
                    playlist_id = resolved.get('id')
                    # Fetch full playlist with tracks
                    data = _sc_api_get(f'/playlists/{playlist_id}', {'representation': 'full'})
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
                            'thumbUrl': _sc_pick_thumb(t.get('artwork_url') or ''),
                            'source': 'soundcloud',
                            'scId': str(t.get('id') or ''),
                            'uploaderUrl': tuser.get('permalink_url', ''),
                            'plays': t.get('playback_count', 0),
                            'likes': t.get('likes_count', 0),
                        })
                    safe_print({
                        'status': 'ok',
                        'title': (data or {}).get('title', ''),
                        'description': (data or {}).get('description', ''),
                        'thumbUrl': _sc_pick_thumb((data or {}).get('artwork_url') or ''),
                        'trackCount': len(tracks),
                        'tracks': tracks,
                        'callId': call_id,
                    })
            except Exception as e:
                print(f"[error] get_soundcloud_playlist: {e}", file=sys.stderr)
                safe_print({'status': 'error', 'message': str(e), 'callId': call_id})

        elif command == 'resolve_sc_track':
            url = request.get('url', '')
            try:
                data = _sc_api_get('/resolve', {'url': url})
                if not data or data.get('kind') != 'track':
                    safe_print({'status': 'error', 'message': 'Not a SC track', 'callId': call_id})
                    return
                user = data.get('user', {})
                safe_print({
                    'status': 'ok',
                    'title': data.get('title', ''),
                    'artist': user.get('username', ''),
                    'duration': int((data.get('duration') or 0) / 1000),
                    'thumbUrl': _sc_pick_thumb(data.get('artwork_url') or ''),
                    'scId': str(data.get('id') or ''),
                    'uploaderUrl': user.get('permalink_url', ''),
                    'callId': call_id,
                })
            except Exception as e:
                print(f"[error] resolve_sc_track: {e}", file=sys.stderr)
                safe_print({'status': 'error', 'message': str(e), 'callId': call_id})

        elif command == 'get_preview_url':
            url = request.get('url', '')
            try:
                # SoundCloud: yt-dlp иногда даёт только HLS/DASH (m3u8), а не прямые MP3/AAC
                # Fallback: если не удалось получить прямой стрим — конвертируем через yt-dlp --extract-audio
                is_sc = url and 'soundcloud.com' in url
                
                ydl_opts = {
                    'format': (
                        'bestaudio[protocol=https][ext!=m3u8]'
                        '/bestaudio[protocol=http][ext!=m3u8]'
                        '/bestaudio[protocol^=http]'
                        '/bestaudio'
                    ),
                    'quiet': True,
                    'no_warnings': True,
                    'user_agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                    **_yt_dlp_js_runtime_opts(),
                }
                if is_sc:
                    cid = get_sc_client_id() or ''
                    ydl_opts['http_headers'] = {
                        'Referer': 'https://soundcloud.com/',
                        'Origin': 'https://soundcloud.com',
                        'Accept': '*/*',
                        'client_id': cid,
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
                    parsed = urlparse(stream_url)
                    path = parsed.path
                    idx = path.find('Policy=')
                    if idx >= 0:
                        new_path = path[:idx]
                        new_query = path[idx:]
                        stream_url = urlunparse((parsed.scheme, parsed.netloc, new_path, parsed.params, new_query, parsed.fragment))

                print(f"[debug] get_preview_url: url={url[:60]} proto={protocol} ext={ext} stream={stream_url[:120] if stream_url else 'NONE'}", file=sys.stderr)

                if not stream_url:
                    safe_print({'status': 'error', 'message': 'No playable HTTP stream found (track may be HLS-only)', 'callId': call_id})
                    return

                thumbs = info.get('thumbnails') or []
                thumb_url = thumbs[-1].get('url', '') if thumbs else ''

                # Громкость здесь НЕ меряем: ffmpeg по сетевому стриму стоил 3-6с и стоял
                # ровно между резолвом и выдачей ссылки. Отдаём null, рендерер догоняет
                # фоновым measure_loudness и применяет гейн плавным рампом.
                safe_print({
                    'status': 'ok',
                    'streamUrl': stream_url,
                    'loudness': None,
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
                
                # Для SoundCloud video_id это URL, скачиваем во временный файл, потом переименуем в {artist}-{title}_{suffix}.ext
                is_sc = url and 'soundcloud.com' in url
                if is_sc:
                    output_template = os.path.join(songs_path, f'sc_tmp_{suffix}.%(ext)s')
                else:
                    output_template = os.path.join(songs_path, f'{video_id}_{suffix}.%(ext)s')
                    
                ydl_opts = {
                    'format': 'bestaudio/best',
                    'quiet': True,
                    'no_warnings': True,
                    'noprogress': True, # Crucial: prevent yt-dlp from polluting stdout
                    'outtmpl': output_template,
                    'noplaylist': True,
                    'progress_hooks': [progress_hook],
                    **_yt_dlp_js_runtime_opts(),
                }
                if is_sc:
                    ydl_opts['http_headers'] = {
                        'Referer': 'https://soundcloud.com/',
                        'Origin': 'https://soundcloud.com',
                    }
                    
                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    info = ydl.extract_info(url, download=True)
                    ext = info.get('ext') or 'webm'
                
                if is_sc:
                    # Формируем имя файла {artist}-{title}_{suffix}.ext
                    artist = info.get('uploader') or info.get('artist', 'Unknown Artist')
                    title = info.get('title', 'Unknown Title')

                    artist_s = sanitize(artist)
                    title_s = sanitize(title)
                    
                    filename = f'{artist_s}-{title_s}_{suffix}.{ext}'
                    filepath = os.path.join(songs_path, filename)
                else:
                    filename = f'{video_id}_{suffix}.{ext}'
                    filepath = os.path.join(songs_path, filename)

                # Resolve actual file (yt-dlp may rename extension)
                if not os.path.exists(filepath):
                    for f in os.listdir(songs_path):
                        if is_sc:
                            if f.startswith(f'sc_tmp_{suffix}.'):
                                filename = f
                                filepath = os.path.join(songs_path, f)
                                break
                        else:
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
                                get_ffmpeg_exe(),
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
                                    get_ffmpeg_exe(),
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
            raw_video_id = request.get('videoId', '')
            songs_path = request.get('songsPath', '')
            os.makedirs(songs_path, exist_ok=True)

            video_id_sanitized = sanitize(raw_video_id)
            suffix = str(int(time.time() * 1000))
            output_template = os.path.join(songs_path, f'dl_direct_{video_id_sanitized}_{suffix}.%(ext)s')

            download_url = request.get('url', '') or (raw_video_id if any(x in raw_video_id for x in ['soundcloud.com','youtube.com','youtu.be']) else None) or stream_url
            is_sc = download_url and 'soundcloud.com' in download_url
            is_yt_direct = download_url and ('googlevideo.com' in download_url or 'youtube.com/api' in download_url)

            # Для прямых YouTube stream URL (googlevideo.com) используем requests — в 5-10x быстрее yt-dlp
            if is_yt_direct:
                try:
                    headers = {
                        'Referer': 'https://music.youtube.com/',
                        'Origin': 'https://music.youtube.com',
                    }
                    # Определяем формат по URL
                    content_type = ''
                    total_size = 0
                    ext = 'm4a'
                    if '.m4a' in download_url or 'mp4' in download_url:
                        ext = 'm4a'
                    elif '.opus' in download_url or 'webm' in download_url:
                        ext = 'webm'
                    elif '.mp3' in download_url:
                        ext = 'mp3'
                    elif '.ogg' in download_url:
                        ext = 'ogg'

                    filepath = os.path.join(songs_path, f'dl_direct_{video_id_sanitized}_{suffix}.{ext}')
                    downloaded = 0
                    last_emit = 0.0

                    with requests.get(download_url, stream=True, headers=headers, timeout=120) as r:
                        r.raise_for_status()
                        content_type = r.headers.get('Content-Type', '')
                        total = r.headers.get('Content-Length')
                        total_size = int(total) if total and total.isdigit() else 0

                        with open(filepath, 'wb') as f:
                            for chunk in r.iter_content(chunk_size=262144):
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
                                    if total_size and total_size > 0:
                                        pct = max(0.0, min(100.0, (downloaded / total_size) * 100.0))
                                    status = f"Downloading: {downloaded / (1024 * 1024):.1f} MB"
                                    if total_size:
                                        status += f" / {total_size / (1024 * 1024):.1f} MB"
                                    if pct is not None:
                                        status = f"Downloading: {pct:.1f}% ({status})"
                                    safe_print({
                                        'event': 'download_progress',
                                        'callId': call_id,
                                        'status': status,
                                        'downloadedBytes': downloaded,
                                        'totalBytes': total_size,
                                        'progress': f"{pct:.1f}%" if pct is not None else None,
                                    })

                    safe_print({'event': 'download_progress', 'callId': call_id, 'status': "Download complete, analyzing loudness...", 'progress': '100%'})

                    gain_db = 0.0
                    if os.path.exists(filepath):
                        try:
                            res = _ffmpeg_loudnorm_i(filepath, ss=30, t=12)
                            if res is not None:
                                gain_db = float(res) + 14.0
                        except Exception:
                            print(f"[warn] loudnorm failed", file=sys.stderr)

                    safe_print({'status': 'ok', 'filename': os.path.basename(filepath), 'gainDb': gain_db, 'callId': call_id})
                    return

                except Exception as e:
                    print(f"[error] download_direct requests failed for {video_id_sanitized}: {e}", file=sys.stderr)

            ydl_opts = {
                'format': 'bestaudio/best', 'quiet': True, 'no_warnings': True, 'noprogress': True,
                'outtmpl': output_template, 'noplaylist': True,
                **_yt_dlp_js_runtime_opts(),
            }
            if is_sc:
                ydl_opts['http_headers'] = {'Referer': 'https://soundcloud.com/', 'Origin': 'https://soundcloud.com', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'}

            def progress_hook(d):
                if d['status'] == 'downloading':
                    p = d.get('_percent_str', '0%').replace('\x1b[0;32m', '').replace('\x1b[0m', '').strip()
                    safe_print({'event': 'download_progress', 'callId': call_id, 'status': f"Downloading: {p}", 'progress': p})
                elif d['status'] == 'finished':
                    safe_print({'event': 'download_progress', 'callId': call_id, 'status': "Download complete, analyzing loudness...", 'progress': '100%'})

            ydl_opts['progress_hooks'] = [progress_hook]

            try:
                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    ydl.extract_info(download_url if download_url else stream_url, download=True)

                filename = ""
                for f in os.listdir(songs_path):
                    if f.startswith(f'dl_direct_{video_id_sanitized}_{suffix}.'):
                        filename = f
                        filepath = os.path.join(songs_path, f)
                        break

                gain_db = 0.0
                if os.path.exists(filepath):
                    try:
                        res = _ffmpeg_loudnorm_i(filepath, ss=30, t=12)
                        if res is not None:
                            gain_db = float(res) + 14.0
                    except Exception:
                        print(f"[warn] loudnorm failed", file=sys.stderr)

                safe_print({'status': 'ok', 'filename': filename, 'gainDb': gain_db, 'callId': call_id})
            except Exception as e:
                print(f"[error] download_direct: {e}", file=sys.stderr)
                safe_print({'status': 'error', 'message': str(e), 'callId': call_id})

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
                            except OSError:
                                size = -1
                            if size == last_size and size > 0:
                                stable_ticks += 1
                            else:
                                stable_ticks = 0
                            last_size = size
                            if stable_ticks >= 2:
                                break
                            time.sleep(0.1)
                    except Exception:
                        print(f"[warn] loudnorm failed", file=sys.stderr)

                    # Use subprocess.PIPE to avoid deadlocks on Windows
                    ffmpeg_proc = subprocess.run(
                        [
                            get_ffmpeg_exe(),
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
                                get_ffmpeg_exe(),
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

        elif command == 'spotify_import_streaming':
            from difflib import SequenceMatcher
            import requests as _requests

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

            headers = {'Authorization': f'Bearer {token}'}
            all_tracks = []
            url = 'https://api.spotify.com/v1/me/tracks?limit=50'
            while url:
                resp = _requests.get(url, headers=headers, timeout=15)
                if resp.status_code != 200:
                    raise Exception(f'Spotify API error {resp.status_code}: {resp.text[:200]}')
                data = resp.json()
                all_tracks.extend(data.get('items', []))
                url = data.get('next')

            total = len(all_tracks)
            safe_print({'event': 'spotify_import_total', 'callId': call_id, 'total': total})

            try:
                for i, item in enumerate(all_tracks[start_index:], start=start_index):
                    title = ''
                    artist = ''
                    dur = None
                    status = 'error'

                    try:
                        t = (item or {}).get('track') or {}
                        title = t.get('name', '')
                        artists = t.get('artists', [])
                        artist = artists[0].get('name', '') if artists else ''
                        dur = t.get('duration_ms')

                        if title:
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
                        print(f"[spotify_import] Error at index {i}: {e}", file=sys.stderr)
                        not_found += 1
                        status = 'error'

                    processed = i + 1
                    safe_print({
                        'event': 'spotify_track_done',
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
                print(f"[spotify_import] Fatal error at index {processed}: {e}", file=sys.stderr)
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
