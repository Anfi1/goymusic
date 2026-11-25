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
from functools import partial
from urllib.parse import urlparse, urlunparse

from ytmusicapi import YTMusic, OAuthCredentials
from ytmusicapi.navigation import nav
from ytmusicapi.mixins._utils import get_datestamp
from pytubefix import YouTube, extract as ptf_extract
from pytubefix.botGuard import bot_guard as _ptf_bot_guard
from pytubefix.cipher import Cipher as _PtfCipher
from pytubefix.innertube import InnerTube as _PtfInnerTube
from pytubefix.sig_nsig.node_runner import NodeRunner as _PtfNodeRunner

from backend import catalog, discovery, history, imports, library, local_media, lyrics, yandex
from backend.context import CommandContext
from backend.local_media import _ffmpeg_loudness_i, get_ffmpeg_exe
from backend.soundcloud import SoundCloudCommands, _sc_extract_track_id

# Force UTF-8 for communication to handle Russian text on Windows
sys.stdin = io.TextIOWrapper(sys.stdin.buffer, encoding='utf-8')
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

# Paths
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
USER_DATA_DIR = os.environ.get('GOYMUSIC_USER_DATA', BASE_DIR)
OAUTH_FILE = os.path.join(USER_DATA_DIR, 'oauth.json')
BROWSER_FILE = os.path.join(USER_DATA_DIR, 'browser.json')
YANDEX_FILE = os.path.join(USER_DATA_DIR, 'yandex.json')

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

# Яндекс.Музыка: клиент кэшируется как get_api() для YTMusic -- токен читается
# один раз из yandex.json, пересоздаётся только на login/logout.
_yandex_client = None
_yandex_lock = threading.Lock()

# dataSyncId аккаунта для GVS PO Token (см. _fetch_stream_meta) — стабилен на весь сеанс,
# достаём один раз из первого успешного player-ответа и переиспользуем.
_yt_data_sync_id = None

# PO Token, добытый Electron'ом из настоящего скрытого браузерного окна (см.
# команду 'set_po_token') — открывает web_music-клиенту адаптивные (opus/aac)
# форматы вместо legacy itag18. Не вечен, Electron периодически перевыпускает.
_yt_po_token = None

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

_api_cache = None  # (auth_data, auth_type, YTMusic)

def _build_api():
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

def get_api():
    """YTMusic для текущей задачи. Инстанс кэшируется: его конструктор ходит в сеть
    за context (~0.7с), а раньше это платилось на КАЖДУЮ команду. Сам объект после
    __init__ иммутабелен и делит thread-safe requests.Session, шарить между потоками
    можно. Сверка `is _auth_data` сбрасывает кэш на любой перезагрузке авторизации."""
    global _api_cache
    if not _auth_data:
        try_load_auth()

    cached = _api_cache
    if cached and cached[0] is _auth_data and cached[1] == _auth_type:
        return cached[2]

    api = _build_api()
    _api_cache = (_auth_data, _auth_type, api)
    return api

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

# Monkey-patch YTMusic._send_request to support cancellation
_original_send_request = YTMusic._send_request
def _patched_send_request(self, endpoint, body, additionalParams=""):
    if is_cancelled():
        raise Exception("Cancelled by client")
    return _original_send_request(self, endpoint, body, additionalParams)

YTMusic._send_request = _patched_send_request

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

def get_yandex_client(force=False):
    """Клиент yandex_music.Client, поднятый из токена в yandex.json (Device Flow).
    None, если пользователь не авторизован."""
    global _yandex_client
    with _yandex_lock:
        if _yandex_client is not None and not force:
            return _yandex_client
        if force:
            _yandex_client = None
        if not os.path.exists(YANDEX_FILE):
            return None
        try:
            from yandex_music import Client as _YClient
            from yandex_music.utils.request import Request as _YRequest
            with open(YANDEX_FILE, 'r', encoding='utf-8') as f:
                data = json.load(f)
            token = data.get('token')
            if not token:
                return None
            client = _YClient(token, request=_YRequest(timeout=15)).init()
            _yandex_client = client
            return client
        except Exception as e:
            print(f"[yandex] failed to load client: {e}", file=sys.stderr)
            return None


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
    cipher = _PtfCipher(js=js, js_url=js_url)

    def via_ejs(kind, ptf_solve):
        # pytubefix зовет get_sig(ciphered_signature=...), а get_nsig позиционно
        def solve(challenge=None, ciphered_signature=None):
            global _ejs_failed_js_url
            challenge = challenge or ciphered_signature
            if _ejs_failed_js_url == js_url:
                return ptf_solve(challenge)
            try:
                return _ejs_solve(js, js_url, kind, challenge)
            except Exception as e:
                _ejs_failed_js_url = js_url
                print(f"[warn] ejs {kind}: {e}, fallback to pytubefix for this player", file=sys.stderr)
                return ptf_solve(challenge)
        return solve

    cipher.get_nsig = via_ejs('n', cipher.get_nsig)
    cipher.get_sig = via_ejs('sig', cipher.get_sig)
    _ptf_cipher = (js_url, cipher)
    return cipher


ptf_extract.Cipher = lambda js, js_url: _cipher_for(js, js_url)
_PtfNodeRunner.close = lambda self: None

# На плеере b485e332 YouTube перенес условие if(...) на новую строку (if((a+7&55)>=\na...)),
# из-за чего pytubefix падает с SyntaxError в eval(expr) внутри _extract_xor_branch_nsig_params.
if hasattr(_PtfCipher, '_extract_xor_branch_nsig_params'):
    _ptf_extract_xor_branch = _PtfCipher._extract_xor_branch_nsig_params

    def _extract_xor_branch_no_newlines(js, n_func, varname, global_obj, body, xor_var, arg_var, w8_xor_b=None):
        clean_body = body.replace('\r', ' ').replace('\n', ' ') if isinstance(body, str) else body
        return _ptf_extract_xor_branch(
            js, n_func, varname, global_obj, clean_body, xor_var, arg_var, w8_xor_b=w8_xor_b
        )

    _PtfCipher._extract_xor_branch_nsig_params = staticmethod(_extract_xor_branch_no_newlines)


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


_bg_proc = None  # (Popen, очередь строк stdout, started_at)
_bg_lock = threading.Lock()
_BG_SERVER_JS = os.path.join(USER_DATA_DIR, 'botguard_server.js')
# Хвост botGuard.js из pytubefix: минт одного токена по argv и выход
_BG_TAIL = 'A=t,C=await x.mintAsWebsafeString(A);var D,O;console.info(C)}'
_BG_LOOP = ('A=t;var D,O;console.info("POT:");for await(const l of require("readline")'
            '.createInterface({input:process.stdin})){try{console.info("POT:"+await '
            'x.mintAsWebsafeString(l.trim()))}catch(e){console.info("POT:")}}}')


def _bg_read(lines, prefix='POT:'):
    while True:
        line = lines.get(timeout=20)
        if line is None:
            raise RuntimeError('node exited')
        if line.startswith(prefix):
            return line[len(prefix):].strip()


def _bg_pump(proc, lines):
    for line in proc.stdout:
        lines.put(line)
    lines.put(None)


_ejs_proc = None  # [Popen, очередь строк stdout, js_url загруженного плеера]
_ejs_failed_js_url = None  # js_url, на котором yt-dlp-ejs уже упал
_ejs_lock = threading.Lock()
_EJS_SERVER_JS = os.path.join(USER_DATA_DIR, 'ejs_server.js')
# Решатель yt-dlp-ejs в цикле по stdin: плеер разбирается один раз, дальше n за ~0.03с
_EJS_LOOP = '''
Object.assign(globalThis, lib);
%s
(async () => {
  let pre = null;
  for await (const l of require("readline").createInterface({input: process.stdin})) {
    let out;
    try {
      const q = JSON.parse(l);
      const reqs = [{type: q.type, challenges: [q.c]}];
      out = q.player ? jsc({type: "player", player: q.player, requests: reqs, output_preprocessed: true})
                     : jsc({type: "preprocessed", preprocessed_player: pre, requests: reqs});
      if (out.preprocessed_player) { pre = out.preprocessed_player; delete out.preprocessed_player; }
    } catch (e) { out = {type: "error", error: String(e)}; }
    console.log("JSC:" + JSON.stringify(out));
  }
})();
'''


def _ejs_solve(js, js_url, kind, challenge):
    """Параметр n (kind='n') или подпись (kind='sig') ссылки googlevideo решателем yt-dlp-ejs.
    Подпись у pytubefix сломалась на плеере 67288f35 (2026-10-20): треки с signatureCipher
    получали 403, а с готовой ссылкой играли. n у pytubefix до этого сломался на плеере c271e571.
    В обоих случаях googlevideo отвечает 403 с нулевого байта: Format error в <audio> и уход
    в SoundCloud. Решатель yt-dlp чинят быстрее, поэтому он основной.
    Холодный node на каждый вызов, как делает сам yt-dlp, стоит ~0.75с на трек, поэтому
    держим один процесс: первый вызов на новом base.js ~0.9с, дальше ~0.03с."""
    global _ejs_proc
    import subprocess, queue
    from yt_dlp_ejs.yt import solver
    with _ejs_lock:
        try:
            if not (_ejs_proc and _ejs_proc[0].poll() is None):
                with open(_EJS_SERVER_JS, 'w', encoding='utf-8') as f:
                    f.write(solver.lib() + '\n' + _EJS_LOOP % solver.core())
                proc = subprocess.Popen([_ptf_bot_guard.NODE_PATH, _EJS_SERVER_JS], stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                        text=True, encoding='utf-8', errors='ignore')
                lines = queue.Queue()
                threading.Thread(target=_bg_pump, args=(proc, lines), daemon=True).start()
                _ejs_proc = [proc, lines, None]
            proc, lines, loaded = _ejs_proc
            msg = {'type': kind, 'c': challenge}
            if loaded != js_url:
                msg['player'] = js
            proc.stdin.write(json.dumps(msg) + '\n')
            proc.stdin.flush()
            out = json.loads(_bg_read(lines, 'JSC:'))
            if out.get('type') == 'error':
                raise RuntimeError(out.get('error'))
            _ejs_proc[2] = js_url
            res = out['responses'][0]
            if res.get('type') == 'error':
                raise RuntimeError(res.get('error'))
            return res['data'][challenge]
        except Exception:
            # на любом сбое следующий вызов поднимет процесс и плеер заново
            if _ejs_proc:
                _ejs_proc[0].kill()
                _ejs_proc = None
            raise


def _bg_mint(video_id):
    """botGuard.js pytubefix на каждый токен заново стартует node, качает youtube.com и гоняет
    VM: 3.7с на трек (замер 2026-09-27). Но дорогой здесь только integrity token, а минт под
    video_id из него мгновенный. Поэтому держим один процесс с патченным хвостом: он читает
    video_id из stdin и отвечает токеном за ~1мс. Хвост не нашёлся (обновили pytubefix) или
    процесс умер: старый путь."""
    global _bg_proc
    import subprocess, queue
    try:
        with _bg_lock:
            # ponytail: перезапуск раз в час вместо слежения за estimatedTtlSecs integrity token
            if not (_bg_proc and _bg_proc[0].poll() is None and time.time() - _bg_proc[2] < 3600):
                if _bg_proc:
                    _bg_proc[0].kill()
                    _bg_proc = None
                src = open(_ptf_bot_guard.VM_PATH, encoding='utf-8').read()
                if _BG_TAIL not in src:
                    raise RuntimeError('botGuard.js tail changed')
                with open(_BG_SERVER_JS, 'w', encoding='utf-8') as f:
                    f.write(src.replace(_BG_TAIL, _BG_LOOP))
                proc = subprocess.Popen([_ptf_bot_guard.NODE_PATH, _BG_SERVER_JS], stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                        text=True, encoding='utf-8', errors='ignore')
                lines = queue.Queue()
                threading.Thread(target=_bg_pump, args=(proc, lines), daemon=True).start()
                _bg_proc = (proc, lines, time.time())
                _bg_read(lines)
            proc, lines, _ = _bg_proc
            proc.stdin.write(video_id + '\n')
            proc.stdin.flush()
            pot = _bg_read(lines)
            if pot:
                return pot
            raise RuntimeError('empty token')
    except Exception as e:
        print(f"[warn] botGuard server: {e}, fallback to one-shot mint", file=sys.stderr)
        with _bg_lock:
            if _bg_proc:
                _bg_proc[0].kill()
                _bg_proc = None
    return _ptf_bot_guard.generate_po_token(video_id=video_id)


def _pytubefix_pot(video_id):
    """PO-токен минтится НА КАЖДЫЙ video_id -- переиспользовать его между треками нельзя.

    Проверено в самом приложении (не в тестах -- они этого не ловят):
      * identifier=video_id  -> играет ровно тот ролик, для которого намолот, остальные
        падают в MEDIA_ELEMENT_ERROR Format error;
      * identifier=visitor_data -> не играет ни один.
    То есть googlevideo сверяет pot с video_id. Цена -- ~1мс на трек через прогретый
    node, см. _bg_mint. Кэш по video_id нужен для повторного резолва того же трека
    (prefetch, перезаход, сброс кэша ссылок в renderer)."""
    visitor_data = _pytubefix_state(video_id)[0]
    with _ptf_pot_lock:
        hit = _ptf_pot_cache.get(video_id)
        if hit and time.time() - hit[1] < 3 * 3600:
            return visitor_data, hit[0]
    po_token = _bg_mint(video_id)
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


_atv_twin_cache = {}   # video_id клипа -> video_id альбомной версии (или None, если нет)
_atv_twin_lock = threading.Lock()


def _norm_title(s):
    """Для сверки названий: регистр, пунктуация и служебные хвосты вида
    (Официальный клип) / (Премьера 2021) / [Official Video] только мешают."""
    s = re.sub(r'[\(\[].*?[\)\]]', ' ', str(s or '').lower())
    return re.sub(r'[^a-zа-яё0-9]+', '', s)


def _cand_seconds(cand):
    """У песен из поиска длительность приходит либо числом, либо строкой 'м:сс'."""
    sec = cand.get('duration_seconds')
    if isinstance(sec, int) and sec > 0:
        return sec
    parts = str(cand.get('duration') or '').split(':')
    try:
        if len(parts) == 2:
            return int(parts[0]) * 60 + int(parts[1])
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
    except ValueError:
        pass
    return None


def _find_atv_twin(video_id, details, expected_sec):
    """Ищем ту запись, чья длительность совпадает с ОЖИДАЕМОЙ -- той, что показана в
    альбоме/списке, откуда трек запустили.

    Длительность здесь главный признак, и это выучено дорого. Первая версия сверяла
    только название и исполнителя и брала первого подошедшего -- на 'Everlasting Summer'
    (Sergey Eybog) она подменила альбомные 2:37 на другую запись того же автора на 6:25.
    Ровно то, что фикс должен был предотвращать.

    Исполнитель НЕ жёсткий фильтр по той же причине: в той выдаче правильный кандидат был
    записан как 'Сергей Ейбог' против 'Sergey Eybog' в клипе, и строгая сверка его
    выбрасывала. При совпавшей длительности и названии транслитерация роли не играет,
    а совпадение исполнителя используется как приоритет между равными кандидатами.

    Стоит один поиск и только для клипов с расхождением длительности. Результат
    кэшируется, в том числе отрицательный -- у части клипов альбомной версии нет."""
    key = (video_id, expected_sec)
    with _atv_twin_lock:
        if key in _atv_twin_cache:
            return _atv_twin_cache[key]

    title = details.get('title') or ''
    author = details.get('author') or ''
    twin = None
    try:
        api = get_api()
        # filter='songs' отдаёт только ATV -- ровно то, что нужно. До фикса локали
        # в форке он возвращал ноль на любой запрос (см. mixins/search.py).
        matches = []
        for cand in api.search(f"{author} {title}".strip(), filter='songs', limit=20):
            cid = cand.get('videoId')
            if not cid or cid == video_id:
                continue
            if _norm_title(cand.get('title')) != _norm_title(title):
                continue
            sec = _cand_seconds(cand)
            if sec is None or abs(sec - expected_sec) > 2:
                continue
            names = [a.get('name', '') for a in (cand.get('artists') or [])]
            same_artist = any(_norm_title(n) == _norm_title(author) for n in names)
            matches.append((0 if same_artist else 1, abs(sec - expected_sec), cid))
        if matches:
            twin = min(matches)[2]
    except Exception as e:
        print(f"[atv] twin lookup failed for {video_id}: {e}", file=sys.stderr)

    with _atv_twin_lock:
        if len(_atv_twin_cache) > 512:
            _atv_twin_cache.clear()  # ponytail: сброс целиком вместо LRU, записей мало
        _atv_twin_cache[key] = twin
    if twin:
        print(f"[atv] {video_id} (клип) -> {twin} (совпал по длительности {expected_sec}с)",
              file=sys.stderr)
    else:
        print(f"[atv] {video_id}: записи на {expected_sec}с не нашлось, играем как есть",
              file=sys.stderr)
    return twin


# Бот-чек (LOGIN_REQUIRED "Sign in to confirm you're not a bot") -- это репутация IP (VPN)
# или протухшие куки, а не устаревший base.js. Сбрасывать из-за него прогретое состояние
# бессмысленно, а повторять тот же запрос на каждом треке стоило 4-7с до старта гонки
# (лог 2026-09-25). Путь, словивший бот-чек, пропускаем на время.
_BOT_CHECK_COOLDOWN = 15 * 60
_bot_check_until = {'auth': 0.0, 'anon': 0.0}


def _fast_paths_on_cooldown():
    now = time.time()
    return all(now < t for t in _bot_check_until.values())


def _player_or_bot_check(path, video_id, request):
    """player-ответ со streamingData или None. Бот-чек ставит путь path на паузу."""
    resp = request()
    if 'streamingData' in resp:
        return resp
    if (resp.get('playabilityStatus') or {}).get('status') == 'LOGIN_REQUIRED':
        _bot_check_until[path] = time.time() + _BOT_CHECK_COOLDOWN
        print(f"[warn] fast-path ({path}): бот-чек на {video_id} (VPN или протухшие куки?), "
              f"путь пропускается {_BOT_CHECK_COOLDOWN // 60} мин", file=sys.stderr)
    return None


def _fast_player_response(video_id, visitor_data, sig_ts):
    """(player-ответ со streamingData, PO-токен к нему или None), либо (None, None).

    Первым идёт авторизованный WEB_REMIX самого ytmusicapi: ~0.2с, opus 251. С 2026-09-27
    googlevideo без PO-токена отдаёт по его ссылке только первые ~800 КБ, дальше 403 (и кусками
    не обойти: лимит по смещению), поэтому токен botGuard под video_id нужен и ему. Минтим его
    параллельно с player-запросом. Анонимный WEB_MUSIC запасной: кук нет или они протухли."""
    now = time.time()
    if try_load_auth() and now >= _bot_check_until['auth']:
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            pot = pool.submit(_pytubefix_pot, video_id)
            try:
                resp = _player_or_bot_check('auth', video_id, lambda: get_api()._send_request(
                    'player', {**sig_ts, 'video_id': video_id}))
                if resp:
                    return resp, pot.result()[1]
            except Exception as e:
                print(f"[debug] fast-path (auth) failed for {video_id}: {e}", file=sys.stderr)

    if now < _bot_check_until['anon']:
        return None, None
    _, po_token = _pytubefix_pot(video_id)
    it = _PtfInnerTube('WEB_MUSIC')
    # innertube_context у pytubefix -- ОБЩИЙ изменяемый словарь из _default_clients,
    # а не копия. Гонка потом мутирует его из нескольких потоков, поэтому работаем со своей.
    it.innertube_context = copy.deepcopy(it.innertube_context)
    # без signatureTimestamp часть треков приходит с playabilityStatus=UNPLAYABLE
    it.innertube_context.update(sig_ts)
    it.insert_po_token(visitor_data=visitor_data, po_token=po_token)
    resp = _player_or_bot_check('anon', video_id, lambda: it.player(video_id))
    return (resp, po_token) if resp else (None, None)


def _resolve_fast(video_id, expected_sec=None, _swapped=False):
    """Самый быстрый путь: один innertube player-запрос + локальная расшифровка на
    прогретом node. С куками это авторизованный WEB_REMIX без botGuard (~0.3с), без них
    анонимный WEB_MUSIC с PO-токеном (~0.8-5с), см. _fast_player_response. Для сравнения:
    ~1.9с у pytubefix и 4-14с у tv+cookies. Формат лучший из всех -- opus itag251 (145-168kbps) против itag140
    (m4a 128k) у pytubefix и itag18 (склейка с видео, 96k) у tv.

    Возвращает (url, loudness, video_id) -- третий элемент это ФАКТИЧЕСКИ сыгранный id:
    у клипа он отличается от запрошенного, см. подмену на альбомную версию ниже. На любой
    осечке (None, None, video_id) -- дальше отработает обычная гонка. Громкость берём из
    этого же ответа: отдельный запрос за ней не нужен."""
    # Если этот клип уже разбирали, идём сразу к найденной записи: тип лежит в
    # player-ответе, но делать ради него лишний запрос на каждом повторе незачем.
    if not _swapped and expected_sec:
        with _atv_twin_lock:
            known = _atv_twin_cache.get((video_id, expected_sec))
        if known:
            url, loudness, eff = _resolve_fast(known, _swapped=True)
            if url:
                return url, loudness, eff

    if _fast_paths_on_cooldown():
        return None, None, video_id
    try:
        visitor_data, js, js_url, sig_ts = _pytubefix_state(video_id)
        resp, po_token = _fast_player_response(video_id, visitor_data, sig_ts)
        if resp is None:
            return None, None, video_id

        # Клип вместо альбомной версии. Тип и длительность лежат в этом же ответе, так
        # что проверка бесплатна. Меняем ТОЛЬКО при расхождении с ожидаемой длительностью:
        # сам по себе OMV не признак беды -- у 'Everlasting Summer' клип и есть альбомные
        # 2:37, и подмена там всё портила. Без expected_sec (фронт не прислал, SC-трек и
        # т.п.) не трогаем ничего: угадывать вслепую хуже, чем не делать. _swapped
        # страхует от петли.
        details = resp.get('videoDetails') or {}
        if not _swapped and expected_sec and details.get('musicVideoType') == 'MUSIC_VIDEO_TYPE_OMV':
            actual = int(details.get('lengthSeconds') or 0)
            if actual and abs(actual - expected_sec) > 3:
                twin = _find_atv_twin(video_id, details, expected_sec)
                if twin:
                    url, loudness, eff = _resolve_fast(twin, _swapped=True)
                    if url:
                        return url, loudness, eff

        manifest = ptf_extract.apply_descrambler(resp['streamingData'])
        if po_token:
            ptf_extract.apply_po_token(manifest, resp, po_token)
        audio = [f for f in manifest if str(f.get('mimeType', '')).startswith('audio/')]
        if not audio:
            return None, None, video_id
        best = [max(audio, key=lambda f: f.get('bitrate', 0))]
        ptf_extract.apply_signature(best, resp, js, js_url)
        return best[0].get('url'), extract_loudness(resp), video_id
    except Exception as e:
        _invalidate_pytubefix_state()
        print(f"[debug] fast-path failed for {video_id}: {e}", file=sys.stderr)
        return None, None, video_id


def _find_key(o, key):
    if isinstance(o, dict):
        for k, v in o.items():
            if k == key:
                yield v
            yield from _find_key(v, key)
    elif isinstance(o, list):
        for v in o:
            yield from _find_key(v, key)


def _yt_comments(video_id, continuation=None):
    """Описание и страница топ-комментариев ролика через next-запросы WEB-клиента, ~1с.
    WEB_REMIX комментариев не отдаёт, поэтому обычный YouTube. Без continuation это первая
    страница вместе с описанием, с ним следующая."""
    it = _PtfInnerTube('WEB')
    # next(continuation=...) пишет токен в innertube_context, а это общий словарь клиента на
    # весь процесс: без копии все следующие ролики уходили со старым токеном и без комментариев
    it.innertube_context = copy.deepcopy(it.innertube_context)
    description = ''
    if not continuation:
        r = it.next(video_id)
        description = next((d.get('content') for d in _find_key(r, 'attributedDescription')), '')
        continuation = next((next(_find_key(sec, 'token'), None) for sec in _find_key(r, 'itemSectionRenderer')
                             if sec.get('sectionIdentifier') == 'comment-item-section'), None)
    if not continuation:
        return {'description': description, 'comments': [], 'continuation': None}
    page = it.next(continuation=continuation)
    comments = []
    for m in page.get('frameworkUpdates', {}).get('entityBatchUpdate', {}).get('mutations', []):
        c = m.get('payload', {}).get('commentEntityPayload')
        if not c:
            continue
        props = c.get('properties', {})
        comments.append({
            'author': c.get('author', {}).get('displayName', ''),
            'text': props.get('content', {}).get('content', ''),
            'likes': c.get('toolbar', {}).get('likeCountNotliked', ''),
            'published': props.get('publishedTime', ''),
        })
    # Следующая страница: continuationItemRenderer в конце списка. Такие же токены есть
    # у веток ответов внутри тредов, поэтому смотрим только на последний элемент.
    items = next(_find_key((page.get('onResponseReceivedEndpoints') or [{}])[-1], 'continuationItems'), [])
    last = items[-1] if items else {}
    token = next(_find_key(last, 'token'), None) if 'continuationItemRenderer' in last else None
    return {'description': description, 'comments': comments, 'continuation': token}


def _sc_comments(sc_url, continuation=None):
    """У SoundCloud комментарий привязан к моменту трека: timestamp в мс.
    continuation это next_href предыдущей страницы."""
    description = ''
    if continuation:
        data = _sc_api_get(continuation.replace('https://api-v2.soundcloud.com', ''), {}) or {}
    else:
        track = _sc_api_get('/resolve', {'url': sc_url}) or {}
        if not track.get('id'):
            return None
        description = track.get('description') or ''
        data = _sc_api_get(f"/tracks/{track['id']}/comments", {'threaded': 0, 'limit': 50}) or {}
    comments = [{
        'author': (c.get('user') or {}).get('username', ''),
        'text': c.get('body', ''),
        'likes': '',
        'published': (c.get('created_at') or '')[:10],
        'timestamp': c['timestamp'] / 1000 if c.get('timestamp') is not None else None,
    } for c in data.get('collection', [])]
    return {'description': description, 'comments': comments, 'continuation': data.get('next_href')}


def _yt_stats(url, params):
    """GET на videostats-URL из playbackTracking от имени аккаунта (куки и SAPISIDHASH
    ytmusicapi), как делает сам веб-плеер. Версия клиента та же, что в player-запросе."""
    # URL приходит от renderer: куки аккаунта уходят только на videostats YouTube
    u = urlparse(url)
    if u.scheme != 'https' or not (u.hostname or '').endswith('.youtube.com') or not u.path.startswith('/api/stats/'):
        raise ValueError(f'not a YouTube stats url: {u.scheme}://{u.hostname}{u.path}')
    api = get_api()
    cver = nav(api.context, ['context', 'client', 'clientVersion'], True)
    params = {'ver': 2, 'c': 'WEB_REMIX', 'cver': cver, **{k: v for k, v in params.items() if v is not None}}
    return api._send_get_request(url, params).status_code


def ping(request, ctx):
    ctx.emit({'status': 'ok', 'data': 'pong'})


def check_auth(request, ctx):
    call_id = ctx.call_id
    try_load_auth()
    safe_print({'status': 'ok', 'authenticated': _auth_data is not None, 'callId': call_id})


def load_auth(request, ctx):
    call_id = ctx.call_id
    success = try_load_auth(force=True)
    safe_print({'status': 'ok', 'authenticated': success, 'callId': call_id})


def get_comments(request, ctx):
    call_id = ctx.call_id
    sc_url = request.get('scUrl')
    cont = request.get('continuation')
    res = _sc_comments(sc_url, cont) if sc_url else _yt_comments(request.get('videoId'), cont)
    if res is None:
        safe_print({'status': 'error', 'message': 'Track not found', 'callId': call_id})
    else:
        safe_print({'status': 'ok', **res, 'callId': call_id})


def logout(request, ctx):
    global _auth_data, _auth_type
    call_id = ctx.call_id
    if os.path.exists(OAUTH_FILE): os.remove(OAUTH_FILE)
    if os.path.exists(BROWSER_FILE): os.remove(BROWSER_FILE)
    _auth_data = None
    _auth_type = None
    safe_print({'status': 'ok', 'message': 'Logged out', 'callId': call_id})


def set_po_token(request, ctx):
    call_id = ctx.call_id
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


def get_stream_url(request, ctx):
    call_id = ctx.call_id
    start_time = time.time()
    video_id = request.get('videoId')
    url = f"https://www.youtube.com/watch?v={video_id}"

    stream_url = None
    loudness = None  # None = не знаем; 0.0 = трек ровно на цели. Раньше это было одно и то же
    watchtime_url = None
    playback_url = None
    method = "None"
    # если трек окажется клипом с чужой длительностью, резолв подменит его на
    # запись нужной длины -- фронту нужен фактический id
    effective_id = video_id
    # длительность из строки, которую видит пользователь (альбом/плейлист/поиск).
    # Это единственный доступный эталон: сам YouTube про «правильную» версию
    # ничего не сообщает.
    try:
        expected_sec = int(request.get('expectedDuration') or 0) or None
    except (TypeError, ValueError):
        expected_sec = None

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
            pb = nav(song, ['playbackTracking', 'videostatsPlaybackUrl', 'baseUrl'], True)
            dsid = nav(song, ['responseContext', 'mainAppWebResponseContext', 'datasyncId'], True)
            if dsid:
                global _yt_data_sync_id
                _yt_data_sync_id = dsid
            return extract_loudness(song), wt, pb
        except Exception as e:
            print(f"[warn] player meta fetch failed for {video_id}: {e}", file=sys.stderr)
            return None, None, None

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
            # без token_file: pytubefix берёт pot из файла раньше верификатора, а там
            # лежал токен чужого video_id, и ссылка умирала с нулевого байта
            tube = YouTube(url, client='WEB_MUSIC', use_po_token=True,
                           po_token_verifier=lambda: pot)
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
        # Токен у нас есть -- тот же, что минтит botGuard для pytubefix (_pytubefix_pot),
        # и он привязан к video_id, а не к сессии: минтится заново на каждый трек,
        # кэш там только для повторного резолва ТОГО ЖЕ трека. Здесь раньше стояло
        # обратное утверждение («привязан к visitor_data, переиспользуется между треками») --
        # оно неверно и противоречило коду ниже; см. докстроку _pytubefix_pot, где привязка
        # проверена реальным воспроизведением. Прокидываем пару в yt-dlp и получаем рабочий web.
        #
        # Смысл держать его рядом с pytubefix-racer'ом на том же клиенте: pytubefix
        # в ~8% вызовов давится свежим base.js (RegexMatchError), парсер yt-dlp
        # заметно устойчивее и закрывает именно этот отказ.
        #
        # Куки не передаются сознательно: с ними content binding токена
        # переключается на datasync_id, и наш токен станет невалиден.
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
                    # Без player_skip=['webpage', 'configs']: пропуск страницы оставляет
                    # клиент без visitor_data, и YouTube стал отвечать bot-check.
                    'player_client': ['visionos', 'android_sdkless'], 'skip': ['hls', 'dash'],
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
        stream_url, fast_loudness, effective_id = _resolve_fast(video_id, expected_sec)
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
        ld, wt, pb = meta_future.result(timeout=10)
        if loudness is None and ld is not None:
            loudness = ld  # запасной вариант: быстрый путь не отработал
        watchtime_url = wt
        playback_url = pb
    except Exception as e:
        print(f"[warn] meta fetch timeout for {video_id}: {e}", file=sys.stderr)
    finally:
        meta_pool.shutdown(wait=False)

    total_time = time.time() - start_time
    print(f"[perf] get_stream_url ({method}) for {video_id}: {total_time:.3f}s (loudness: {loudness})", file=sys.stderr)

    if stream_url:
        safe_print({'status': 'ok', 'url': stream_url, 'loudness': loudness,
                    'watchtimeUrl': watchtime_url, 'playbackUrl': playback_url, 'videoId': effective_id,
                    'callId': call_id})
    else:
        safe_print({'status': 'error', 'message': 'Failed to obtain stream URL', 'callId': call_id})


def search_alternatives(request, ctx):
    call_id = ctx.call_id
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


def get_soundcloud_album(request, ctx):
    call_id = ctx.call_id
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


def sc_client_id(request, ctx):
    call_id = ctx.call_id
    # client_id для webview-лайка на стороне renderer.
    try:
        safe_print({'status': 'ok', 'clientId': get_sc_client_id() or '', 'appVersion': get_sc_app_version(), 'callId': call_id})
    except Exception as e:
        safe_print({'status': 'error', 'message': str(e), 'callId': call_id})


def sc_like_nodriver(request, ctx):
    call_id = ctx.call_id
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


def sc_setup_profile(request, ctx):
    call_id = ctx.call_id
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


def get_preview_url(request, ctx):
    call_id = ctx.call_id
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


def download_track(request, ctx):
    call_id = ctx.call_id
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

        is_sc = url and 'soundcloud.com' in url
        # id трека в имени файла: по нему привязку можно восстановить без базы приложения.
        # У SC-трека id это URL, без sanitize слэши превращаются в подпапки.
        safe_id = sanitize(video_id)
        output_template = os.path.join(songs_path, f"{safe_id.replace('%', '%%')}_{suffix}.%(ext)s")

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

        filename = f'{safe_id}_{suffix}.{ext}'
        filepath = os.path.join(songs_path, filename)

        # Resolve actual file (yt-dlp may rename extension)
        if not os.path.exists(filepath):
            for f in os.listdir(songs_path):
                if f.startswith(safe_id + '_' + suffix + '.'):
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


def download_direct(request, ctx):
    call_id = ctx.call_id
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
                    res = _ffmpeg_loudness_i(filepath, ss=30, t=12)
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
                res = _ffmpeg_loudness_i(filepath, ss=30, t=12)
                if res is not None:
                    gain_db = float(res) + 14.0
            except Exception:
                print(f"[warn] loudnorm failed", file=sys.stderr)

        safe_print({'status': 'ok', 'filename': filename, 'gainDb': gain_db, 'callId': call_id})
    except Exception as e:
        print(f"[error] download_direct: {e}", file=sys.stderr)
        safe_print({'status': 'error', 'message': str(e), 'callId': call_id})


def yandex_auth_start(request, ctx):
    call_id = ctx.call_id
    # OAuth Device Flow, шаг 1: код устройства + ссылка для подтверждения.
    # Прямой HTTP вместо yandex_music (request_device_code отсутствует в 2.2.0).
    try:
        import string as _string
        device_id = ''.join(random.choice(_string.ascii_letters + _string.digits) for _ in range(10))
        resp = requests.post(
            'https://oauth.yandex.ru/device/code',
            data={
                'client_id': '23cabbbdc6cd418abb4b39c32c41195d',
                'device_id': device_id,
                'device_name': 'GoyMusic',
            },
            timeout=15,
        )
        data = resp.json()
        safe_print({
            'status': 'ok',
            'deviceCode': data.get('device_code'),
            'userCode': data.get('user_code'),
            'verificationUrl': data.get('verification_url'),
            'expiresIn': data.get('expires_in'),
            'interval': data.get('interval'),
            'callId': call_id,
        })
    except Exception as e:
        print(f"[error] yandex_auth_start: {e}", file=sys.stderr)
        safe_print({'status': 'error', 'message': str(e), 'callId': call_id})


def yandex_auth_poll(request, ctx):
    call_id = ctx.call_id
    # Шаг 2: однократный опрос -- фронт вызывает по таймеру раз в code.interval.
    # Прямой HTTP вместо yandex_music (poll_device_token отсутствует в 2.2.0).
    device_code = request.get('deviceCode', '')
    try:
        resp = requests.post(
            'https://oauth.yandex.ru/token',
            data={
                'grant_type': 'device_code',
                'code': device_code,
                'client_id': '23cabbbdc6cd418abb4b39c32c41195d',
                'client_secret': '53bc75238f0c4d08a118e51fe9203300',
            },
            timeout=15,
        )
        data = resp.json()
        token = data.get('access_token')
        if token:
            with _yandex_lock:
                with open(YANDEX_FILE, 'w', encoding='utf-8') as f:
                    json.dump({'token': token}, f)
            client = get_yandex_client(force=True)
            login = ''
            if client and client.me and client.me.account:
                login = client.me.account.display_name or client.me.account.login or ''
            safe_print({'status': 'ok', 'login': login, 'callId': call_id})
        elif data.get('error') in ('authorization_pending', 'slow_down'):
            safe_print({'status': 'pending', 'callId': call_id})
        else:
            safe_print({
                'status': 'error',
                'message': data.get('error_description') or data.get('error') or 'unknown error',
                'callId': call_id,
            })
    except Exception as e:
        print(f"[error] yandex_auth_poll: {e}", file=sys.stderr)
        safe_print({'status': 'error', 'message': str(e), 'callId': call_id})


def yandex_auth_status(request, ctx):
    call_id = ctx.call_id
    try:
        client = get_yandex_client()
        if not client:
            safe_print({'status': 'ok', 'connected': False, 'callId': call_id})
        else:
            login = ''
            if client.me and client.me.account:
                login = client.me.account.display_name or client.me.account.login or ''
            safe_print({'status': 'ok', 'connected': True, 'login': login, 'callId': call_id})
    except Exception as e:
        print(f"[error] yandex_auth_status: {e}", file=sys.stderr)
        safe_print({'status': 'ok', 'connected': False, 'callId': call_id})


def yandex_logout(request, ctx):
    global _yandex_client
    call_id = ctx.call_id
    if os.path.exists(YANDEX_FILE):
        os.remove(YANDEX_FILE)
    _yandex_client = None
    safe_print({'status': 'ok', 'callId': call_id})


_soundcloud = SoundCloudCommands(_sc_api_get, _sc_headers, get_sc_client_id)

# The wire protocol is explicit: only these names are callable from the renderer.
COMMANDS = {
    'ping': ping,
    'check_auth': check_auth,
    'load_auth': load_auth,
    'logout': logout,
    'set_po_token': set_po_token,
    'get_stream_url': get_stream_url,
    'get_comments': get_comments,
    'search_alternatives': search_alternatives,
    'get_soundcloud_album': get_soundcloud_album,
    'sc_client_id': sc_client_id,
    'sc_like_nodriver': sc_like_nodriver,
    'sc_setup_profile': sc_setup_profile,
    'get_preview_url': get_preview_url,
    'download_track': download_track,
    'download_direct': download_direct,
    'yandex_auth_start': yandex_auth_start,
    'yandex_auth_poll': yandex_auth_poll,
    'yandex_auth_status': yandex_auth_status,
    'yandex_logout': yandex_logout,
    'get_search_suggestions': catalog.get_search_suggestions,
    'search': catalog.search,
    'search_more': catalog.search_more,
    'get_artist': catalog.get_artist,
    'get_artist_songs': catalog.get_artist_songs,
    'get_track_info': catalog.get_track_info,
    'get_album': catalog.get_album,
    'get_home': discovery.get_home,
    'get_home_sections': discovery.get_home_sections,
    'get_explore_releases': discovery.get_explore_releases,
    'get_mixed_for_you': discovery.get_mixed_for_you,
    'get_queue_recommendations': discovery.get_queue_recommendations,
    'get_song_related': discovery.get_song_related,
    'get_playlists': library.get_playlists,
    'get_liked_songs': library.get_liked_songs,
    'get_continuation': library.get_continuation,
    'get_playlist_tracks': library.get_playlist_tracks,
    'get_library': library.get_library,
    'shuffle_library_songs': library.shuffle_library_songs,
    'subscribe_artist': library.subscribe_artist,
    'unsubscribe_artist': library.unsubscribe_artist,
    'get_user_info': library.get_user_info,
    'rate_song': library.rate_song,
    'rate_playlist': library.rate_playlist,
    'create_playlist': library.create_playlist,
    'delete_playlist': library.delete_playlist,
    'edit_playlist': library.edit_playlist,
    'add_playlist_items': library.add_playlist_items,
    'remove_playlist_items': library.remove_playlist_items,
    'send_feedback': library.send_feedback,
    'add_history_item': history.add_history_item,
    'send_playback': partial(history.send_playback, stats=_yt_stats),
    'send_watchtime': partial(history.send_watchtime, stats=_yt_stats),
    'get_lyrics': lyrics.get_lyrics,
    'measure_loudness': local_media.measure_loudness,
    'analyze_file': local_media.analyze_file,
    'yandex_import_streaming': imports.yandex_import_streaming,
    'spotify_import_streaming': imports.spotify_import_streaming,
    'get_soundcloud_artist': _soundcloud.get_soundcloud_artist,
    'search_soundcloud_extra': _soundcloud.search_soundcloud_extra,
    'sc_me': _soundcloud.sc_me,
    'sc_liked_ids': _soundcloud.sc_liked_ids,
    'sc_liked_tracks': _soundcloud.sc_liked_tracks,
    'sc_liked_meta': _soundcloud.sc_liked_meta,
    'sc_wave_stations': _soundcloud.sc_wave_stations,
    'sc_station_tracks': _soundcloud.sc_station_tracks,
    'sc_recommendations': _soundcloud.sc_recommendations,
    'get_soundcloud_playlist': _soundcloud.get_soundcloud_playlist,
    'resolve_sc_track': _soundcloud.resolve_sc_track,
    'yandex_liked_tracks': yandex.yandex_liked_tracks,
    'yandex_set_liked': yandex.yandex_set_liked,
    'yandex_liked_albums': yandex.yandex_liked_albums,
    'yandex_liked_artists': yandex.yandex_liked_artists,
    'yandex_wave_stations': yandex.yandex_wave_stations,
    'yandex_wave_tracks': yandex.yandex_wave_tracks,
    'yandex_recommendations': yandex.yandex_recommendations,
    'yandex_new_releases': yandex.yandex_new_releases,
    'yandex_home_genres': yandex.yandex_home_genres,
    'yandex_genre_stations': yandex.yandex_genre_stations,
    'yandex_new_playlists': yandex.yandex_new_playlists,
    'yandex_album_tracks': yandex.yandex_album_tracks,
    'yandex_album_like': yandex.yandex_album_like,
    'yandex_play_audio': yandex.yandex_play_audio,
    'yandex_rotor_feedback': yandex.yandex_rotor_feedback,
    'yandex_stream_url': yandex.yandex_stream_url,
    'yandex_artist': yandex.yandex_artist,
    'yandex_playlists': yandex.yandex_playlists,
    'yandex_playlist_tracks': yandex.yandex_playlist_tracks,
    'yandex_search': yandex.yandex_search,
}


def handle_request(request):
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
        handler = COMMANDS.get(command) if isinstance(command, str) else None
        if handler is None:
            safe_print({'status': 'error', 'message': f'Unknown command: {command}', 'callId': call_id})
        else:
            context = CommandContext(call_id, safe_print, get_api, get_yandex_client, is_cancelled)
            handler(request, context)
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
