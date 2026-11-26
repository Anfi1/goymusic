import sys
import os
import io

# Force using local fork - MUST BE AT THE VERY TOP
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(BASE_DIR, 'python', 'fork'))

import copy
import json
import logging
import math
import threading
import concurrent.futures
import time
import random
import traceback
import yt_dlp
import requests
import re
from functools import partial
from urllib.parse import parse_qsl, urlparse, urlunparse

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
from backend.local_media import _ffmpeg_loudness_i, get_ffmpeg_exe, measure_local_gain_db, measure_loudness_full
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


def _resolve_fast_with_details(video_id, expected_sec=None, _swapped=False):
    """Как _resolve_fast, но также возвращает videoDetails из того же player-ответа."""
    if not _swapped and expected_sec:
        with _atv_twin_lock:
            known = _atv_twin_cache.get((video_id, expected_sec))
        if known:
            url, loudness, eff, det = _resolve_fast_with_details(known, _swapped=True)
            if url:
                return url, loudness, eff, det

    if _fast_paths_on_cooldown():
        return None, None, video_id, None
    try:
        visitor_data, js, js_url, sig_ts = _pytubefix_state(video_id)
        resp, po_token = _fast_player_response(video_id, visitor_data, sig_ts)
        if resp is None:
            return None, None, video_id, None

        details = resp.get('videoDetails') or {}
        if not _swapped and expected_sec and details.get('musicVideoType') == 'MUSIC_VIDEO_TYPE_OMV':
            actual = int(details.get('lengthSeconds') or 0)
            if actual and abs(actual - expected_sec) > 3:
                twin = _find_atv_twin(video_id, details, expected_sec)
                if twin:
                    url, loudness, eff, det = _resolve_fast_with_details(twin, _swapped=True)
                    if url:
                        return url, loudness, eff, det

        manifest = ptf_extract.apply_descrambler(resp['streamingData'])
        if po_token:
            ptf_extract.apply_po_token(manifest, resp, po_token)
        audio = [f for f in manifest if str(f.get('mimeType', '')).startswith('audio/')]
        if not audio:
            return None, None, video_id, None
        best = [max(audio, key=lambda f: f.get('bitrate', 0))]
        ptf_extract.apply_signature(best, resp, js, js_url)
        return best[0].get('url'), extract_loudness(resp), video_id, details
    except Exception as e:
        _invalidate_pytubefix_state()
        print(f"[debug] fast-path failed for {video_id}: {e}", file=sys.stderr)
        return None, None, video_id, None


def _resolve_fast(video_id, expected_sec=None, _swapped=False):
    """Самый быстрый путь: один innertube player-запрос + локальная расшифровка на
    прогретом node. Возвращает (url, loudness, video_id)."""
    url, loudness, eff, _ = _resolve_fast_with_details(
        video_id, expected_sec=expected_sec, _swapped=_swapped
    )
    return url, loudness, eff


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


def _race_youtube_stream(video_id):
    """Приоритетная гонка запасных резолверов (visionos > pytubefix > web > tv+cookies).
    Возвращает (stream_url, method) или (None, None)."""
    url = f"https://www.youtube.com/watch?v={video_id}"

    def _try_pytubefix():
        try:
            pot = _pytubefix_pot(video_id)
            tube = YouTube(url, client='WEB_MUSIC', use_po_token=True,
                           po_token_verifier=lambda: pot)
            stream = tube.streams.get_audio_only()
            return stream.url if stream else None
        except Exception as e:
            print(f"[debug] pytubefix failed for {video_id}: {e}", file=sys.stderr)
            return None

    def _try_yt_dlp_web():
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
                    'player_client': ['visionos', 'android_sdkless'], 'skip': ['hls', 'dash'],
                }},
                'extractor_timeout': 15, 'socket_timeout': 15,
                **_yt_dlp_js_runtime_opts(),
            }
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)
                return info['url']
        except Exception as e:
            print(f"[debug] yt-dlp(visionos) failed for {video_id}: {e}", file=sys.stderr)
            return None

    PRIORITY = ['visionos', 'pytubefix', 'web', 'tv+cookies']
    racer_fns = {
        'visionos': _try_yt_dlp_visionos,
        'pytubefix': _try_pytubefix,
        'web': _try_yt_dlp_web,
        'tv+cookies': _try_yt_dlp_cookies,
    }

    stream_url = None
    method = None
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
            break
        if best_name in results and any(results.get(n) for n in PRIORITY):
            break

    for name in PRIORITY:
        if results.get(name):
            stream_url = results[name]
            method = name
            break

    stream_pool.shutdown(wait=False)
    return stream_url, method


def _resolve_youtube_audio_stream(video_id):
    """Единая точка резолва прямого аудио-потока YouTube: сначала _resolve_fast_with_details,
    при осечке - приоритетная гонка. Возвращает (stream_url, loudness, details)."""
    stream_url, loudness, _, details = _resolve_fast_with_details(video_id)
    if stream_url:
        return stream_url, loudness, details
    raced_url, _ = _race_youtube_stream(video_id)
    if raced_url:
        return raced_url, None, None
    return None, None, None


def get_stream_url(request, ctx):
    call_id = ctx.call_id
    start_time = time.time()
    video_id = request.get('videoId')

    stream_url = None
    loudness = None
    watchtime_url = None
    playback_url = None
    method = "None"
    effective_id = video_id
    try:
        expected_sec = int(request.get('expectedDuration') or 0) or None
    except (TypeError, ValueError):
        expected_sec = None

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

    if not stream_url:
        stream_url, fast_loudness, effective_id = _resolve_fast(video_id, expected_sec)
        if stream_url:
            method = 'fast'
            if fast_loudness is not None:
                loudness = fast_loudness

    if not stream_url:
        raced_url, raced_method = _race_youtube_stream(video_id)
        if raced_url:
            stream_url = raced_url
            method = raced_method

    try:
        ld, wt, pb = meta_future.result(timeout=10)
        if loudness is None and ld is not None:
            loudness = ld
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
    force = bool(request.get('force'))
    try:
        client_id = get_sc_client_id(force=force)
        if not client_id:
            safe_print({'status': 'error', 'message': 'client_id not found', 'callId': call_id})
            return
        safe_print({'status': 'ok', 'clientId': client_id, 'appVersion': get_sc_app_version(), 'callId': call_id})
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


_CHROME_UA = (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    '(KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
)
_YT_VIDEO_ID_RE = re.compile(r'^[A-Za-z0-9_-]{11}$')


class _DownloadCancelled(Exception):
    pass


class _PeerAborted(Exception):
    pass


def _is_youtube_video_id(value) -> bool:
    return isinstance(value, str) and bool(_YT_VIDEO_ID_RE.match(value))


def _extract_youtube_video_id(url: str) -> str | None:
    """Извлекает 11-символьный videoId из ссылок YouTube/YouTube Music, иначе None."""
    if not url or not isinstance(url, str):
        return None
    try:
        parsed = urlparse(url.strip())
    except Exception:
        return None
    if parsed.scheme not in ('http', 'https'):
        return None
    host = (parsed.hostname or '').lower()
    path_parts = [p for p in (parsed.path or '').split('/') if p]

    vid = None
    if host in ('youtu.be', 'www.youtu.be'):
        if path_parts:
            vid = path_parts[0]
    elif host in (
        'youtube.com', 'www.youtube.com', 'm.youtube.com',
        'music.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com',
    ):
        if path_parts and path_parts[0] == 'watch':
            params = dict(parse_qsl(parsed.query, keep_blank_values=True))
            vid = params.get('v')
        elif len(path_parts) >= 2 and path_parts[0] in ('shorts', 'embed', 'live', 'v'):
            vid = path_parts[1]
    else:
        return None
    return vid if _is_youtube_video_id(vid) else None


def _set_range_query(url: str, start: int, end: int, rn: int) -> str:
    """Устанавливает range/rn/rbuf в query без перекодирования остальных параметров (sig/n/pot)."""
    parsed = urlparse(url)
    kept = []
    if parsed.query:
        for part in parsed.query.split('&'):
            if not part:
                continue
            key = part.split('=', 1)[0]
            if key in ('range', 'rn', 'rbuf'):
                continue
            kept.append(part)
    kept.append(f'range={int(start)}-{int(end)}')
    kept.append(f'rn={int(rn)}')
    kept.append('rbuf=0')
    return urlunparse((
        parsed.scheme,
        parsed.netloc,
        parsed.path,
        parsed.params,
        '&'.join(kept),
        parsed.fragment,
    ))


def _yt_download_headers(headers=None) -> dict:
    ua = (_auth_data or {}).get('User-Agent') if isinstance(_auth_data, dict) else None
    default_ua = ua if (isinstance(ua, str) and 'Chrome/' in ua) else _CHROME_UA
    merged = {
        'User-Agent': default_ua,
        'Referer': 'https://music.youtube.com/',
        'Origin': 'https://music.youtube.com',
        'Accept': '*/*',
    }
    if headers:
        merged.update(headers)
    if not merged.get('User-Agent') or 'python-requests' in str(merged.get('User-Agent', '')).lower():
        merged['User-Agent'] = default_ua
    return merged


def _infer_audio_ext(url: str, content_type: str = '') -> str:
    query = dict(parse_qsl(urlparse(url or '').query, keep_blank_values=True))
    mime = (query.get('mime') or content_type or '').lower()
    if 'webm' in mime or 'opus' in mime:
        return 'webm'
    if 'mp4' in mime or 'm4a' in mime:
        return 'm4a'
    if 'mpeg' in mime or 'mp3' in mime:
        return 'mp3'
    if 'ogg' in mime:
        return 'ogg'
    low_url = (url or '').lower()
    if '.m4a' in low_url or 'mp4' in low_url:
        return 'm4a'
    if '.opus' in low_url or 'webm' in low_url:
        return 'webm'
    if '.mp3' in low_url:
        return 'mp3'
    if '.ogg' in low_url:
        return 'ogg'
    return 'm4a'


def _http_status_code(exc: Exception):
    resp = getattr(exc, 'response', None)
    return getattr(resp, 'status_code', None)


def _is_task_cancelled(call_id, check_fn=None) -> bool:
    if check_fn is not None and check_fn():
        return True
    if call_id:
        with tasks_lock:
            ev = active_tasks.get(call_id)
            if ev is not None and ev.is_set():
                return True
    return False


def _parse_content_range_total(content_range: str) -> int:
    if not content_range:
        return 0
    m = re.search(r'/(\d+)\s*$', str(content_range))
    return int(m.group(1)) if m else 0


def _download_googlevideo_chunked(
    url,
    filepath,
    headers,
    call_id,
    is_cancelled,
    chunk_size=512 * 1024,
    max_workers=4,
) -> int:
    """Параллельная загрузка googlevideo по query range=start-end.

    Обходит 2x realtime pacing (~30 KB/s) на открытых GET для адаптивных потоков
    c=WEB_REMIX (gir=yes). На 403/410 падает сразу без повторов, чтобы вызывающий
    код мог перерезолвить протухшую ссылку."""
    req_headers = _yt_download_headers(headers)
    cancel_check = lambda: _is_task_cancelled(call_id, is_cancelled)

    if cancel_check():
        raise _DownloadCancelled('Cancelled by client')

    start_mono = time.monotonic()
    progress_lock = threading.Lock()
    downloaded = 0
    last_emit = start_mono

    def _emit_progress(done_bytes: int, total_bytes: int, force: bool = False):
        nonlocal last_emit
        now = time.monotonic()
        if not force and (now - last_emit) < 0.15:
            return
        last_emit = now
        mb_done = done_bytes / (1024 * 1024)
        elapsed = max(now - start_mono, 0.001)
        speed_mb = mb_done / elapsed
        if total_bytes > 0:
            mb_total = total_bytes / (1024 * 1024)
            pct = max(0.0, min(100.0, (done_bytes / total_bytes) * 100.0))
            status = f'{mb_done:.1f} / {mb_total:.1f} MB ({speed_mb:.1f} MB/s)'
            progress_str = f'{pct:.1f}%'
        else:
            status = f'{mb_done:.1f} MB ({speed_mb:.1f} MB/s)'
            progress_str = None
        safe_print({
            'event': 'download_progress',
            'callId': call_id,
            'status': status,
            'downloadedBytes': done_bytes,
            'totalBytes': total_bytes,
            'progress': progress_str,
        })

    def _add_progress(delta: int, total_bytes: int, force: bool = False):
        nonlocal downloaded
        with progress_lock:
            downloaded = max(0, downloaded + delta)
            _emit_progress(downloaded, total_bytes, force=force)

    # Размер берем сначала из clen в query (0 лишних запросов), иначе 1-byte зонд
    total_size = 0
    query_params = dict(parse_qsl(urlparse(url).query, keep_blank_values=True))
    clen_raw = query_params.get('clen', '')
    if clen_raw.isdigit() and int(clen_raw) > 0:
        total_size = int(clen_raw)
    else:
        probe_session = requests.Session()
        try:
            probe_url = _set_range_query(url, 0, 0, 0)
            with probe_session.get(probe_url, headers=req_headers, stream=True, timeout=20) as r:
                if r.status_code in (403, 410):
                    r.raise_for_status()
                if r.ok:
                    total_size = _parse_content_range_total(r.headers.get('Content-Range', ''))
        finally:
            try:
                probe_session.close()
            except Exception:
                pass

    if cancel_check():
        raise _DownloadCancelled('Cancelled by client')

    if total_size <= 0:
        try:
            with requests.get(url, stream=True, headers=req_headers, timeout=120) as r:
                r.raise_for_status()
                cl = r.headers.get('Content-Length')
                stream_total = int(cl) if cl and str(cl).isdigit() else 0
                with open(filepath, 'wb') as f:
                    for chunk in r.iter_content(chunk_size=262144):
                        if cancel_check():
                            raise _DownloadCancelled('Cancelled by client')
                        if not chunk:
                            continue
                        f.write(chunk)
                        _add_progress(len(chunk), stream_total)
                _add_progress(0, stream_total, force=True)
            return downloaded
        except Exception:
            try:
                if os.path.exists(filepath):
                    os.remove(filepath)
            except OSError:
                pass
            raise

    ranges = []
    rn = 1
    offset = 0
    while offset < total_size:
        end = min(offset + chunk_size - 1, total_size - 1)
        ranges.append((offset, end, rn))
        offset = end + 1
        rn += 1

    stop_event = threading.Event()
    file_lock = threading.Lock()
    error_lock = threading.Lock()
    sessions_lock = threading.Lock()
    worker_local = threading.local()
    sessions = []
    written_bytes = 0
    first_error: Exception | None = None

    def _record_error(exc: Exception):
        nonlocal first_error
        if isinstance(exc, (_DownloadCancelled, _PeerAborted, concurrent.futures.CancelledError)):
            return
        with error_lock:
            # Приоритет у 403/410, чтобы вызывающий код гарантированно перерезолвил протухшую ссылку
            if first_error is None:
                first_error = exc
            elif _http_status_code(exc) in (403, 410) and _http_status_code(first_error) not in (403, 410):
                first_error = exc

    def _check_stop():
        if cancel_check():
            stop_event.set()
            raise _DownloadCancelled('Cancelled by client')
        if stop_event.is_set():
            raise _PeerAborted()

    def _get_worker_session():
        sess = getattr(worker_local, 'session', None)
        if sess is None:
            sess = requests.Session()
            worker_local.session = sess
            with sessions_lock:
                sessions.append(sess)
        return sess

    def _fetch_chunk(start: int, end: int, req_num: int, out_file):
        nonlocal written_bytes
        expected_len = end - start + 1
        chunk_url = _set_range_query(url, start, end, req_num)
        backoffs = (0.2, 0.5)
        last_err = None

        for attempt in range(3):
            _check_stop()

            if attempt > 0:
                delay = backoffs[min(attempt - 1, len(backoffs) - 1)]
                stop_event.wait(delay)
                _check_stop()

            attempt_bytes = 0
            buf = bytearray()
            try:
                sess = _get_worker_session()
                with sess.get(chunk_url, headers=req_headers, stream=True, timeout=30) as r:
                    if r.status_code in (403, 410):
                        try:
                            r.raise_for_status()
                        except Exception as http_err:
                            _record_error(http_err)
                            stop_event.set()
                            raise
                    r.raise_for_status()
                    for piece in r.iter_content(chunk_size=65536):
                        _check_stop()
                        if not piece:
                            continue
                        if len(buf) + len(piece) > expected_len:
                            raise IOError(f'Oversized chunk {start}-{end}: exceeded {expected_len} bytes')
                        buf.extend(piece)
                        attempt_bytes += len(piece)
                        _add_progress(len(piece), total_size)
                if len(buf) != expected_len:
                    raise IOError(f'Incomplete chunk {start}-{end}: got {len(buf)}/{expected_len} bytes')
                with file_lock:
                    out_file.seek(start)
                    out_file.write(buf)
                    written_bytes += len(buf)
                return expected_len
            except (_DownloadCancelled, _PeerAborted):
                if attempt_bytes:
                    _add_progress(-attempt_bytes, total_size)
                raise
            except Exception as e:
                if attempt_bytes:
                    _add_progress(-attempt_bytes, total_size)
                if _http_status_code(e) in (403, 410):
                    _record_error(e)
                    stop_event.set()
                    raise
                last_err = e

        final_err = last_err if last_err is not None else IOError(f'Chunk {start}-{end} failed')
        _record_error(final_err)
        stop_event.set()
        raise final_err

    out_file = open(filepath, 'wb')
    try:
        out_file.truncate(total_size)
        worker_count = max(1, min(int(max_workers or 4), len(ranges)))
        pool_err: Exception | None = None
        with concurrent.futures.ThreadPoolExecutor(max_workers=worker_count) as pool:
            futures = [pool.submit(_fetch_chunk, s, e, n, out_file) for (s, e, n) in ranges]
            for fut in concurrent.futures.as_completed(futures):
                try:
                    fut.result()
                except (_PeerAborted, concurrent.futures.CancelledError):
                    stop_event.set()
                    for f in futures:
                        f.cancel()
                except _DownloadCancelled as exc:
                    stop_event.set()
                    for f in futures:
                        f.cancel()
                    if pool_err is None:
                        pool_err = exc
                except Exception as exc:
                    _record_error(exc)
                    stop_event.set()
                    for f in futures:
                        f.cancel()
                    if pool_err is None:
                        pool_err = exc
        # Все воркеры завершены; выбираем истинную причину отказа без гонки с прерванными потоками
        if cancel_check():
            raise _DownloadCancelled('Cancelled by client')
        with error_lock:
            recorded = first_error
        if recorded is not None:
            raise recorded
        if pool_err is not None:
            raise pool_err
        out_file.flush()
        out_file.close()
        out_file = None

        if written_bytes != total_size or os.path.getsize(filepath) != total_size:
            raise IOError(f'Size mismatch: wrote {written_bytes}/{total_size} bytes')

        _add_progress(0, total_size, force=True)
        return total_size
    except Exception:
        stop_event.set()
        if out_file is not None:
            try:
                out_file.close()
            except Exception:
                pass
        try:
            if os.path.exists(filepath):
                os.remove(filepath)
        except OSError:
            pass
        raise
    finally:
        if out_file is not None:
            try:
                out_file.close()
            except Exception:
                pass
        with sessions_lock:
            for s in sessions:
                try:
                    s.close()
                except Exception:
                    pass


def _measure_local_gain(
    filepath: str,
    fallback_gain_db: float | None = None,
    wait_stable: bool = False,
) -> tuple[float, bool]:
    gain_db, measured = measure_local_gain_db(filepath, fallback_gain_db=None, wait_stable=wait_stable)
    if measured and gain_db is not None and math.isfinite(gain_db):
        return float(gain_db), True
    if fallback_gain_db is not None:
        try:
            fb = float(fallback_gain_db)
            if math.isfinite(fb):
                return fb, True
        except (TypeError, ValueError):
            pass
    return 0.0, False


def _measure_local_gain_db(filepath: str, fallback_gain_db: float = 0.0) -> float:
    return _measure_local_gain(filepath, fallback_gain_db=fallback_gain_db)[0]


def get_preview_url(request, ctx):
    call_id = ctx.call_id
    url = request.get('url', '')
    try:
        yt_vid = _extract_youtube_video_id(url)
        if yt_vid:
            try:
                stream_url, loudness, details = _resolve_youtube_audio_stream(yt_vid)
                if stream_url:
                    det = details if isinstance(details, dict) else {}
                    if not det:
                        try:
                            song = get_api().get_song(yt_vid) or {}
                            det = song.get('videoDetails') or {}
                            if loudness is None:
                                loudness = extract_loudness(song)
                        except Exception:
                            det = {}
                    thumbs = ((det.get('thumbnail') or {}).get('thumbnails') or [])
                    thumb_url = thumbs[-1].get('url', '') if thumbs else ''
                    try:
                        duration = int(det['lengthSeconds']) if det.get('lengthSeconds') else None
                    except (TypeError, ValueError):
                        duration = None
                    safe_print({
                        'status': 'ok',
                        'streamUrl': stream_url,
                        'loudness': loudness,
                        'title': det.get('title', ''),
                        'artist': det.get('author', ''),
                        'duration': duration,
                        'thumbUrl': thumb_url,
                        'callId': call_id,
                    })
                    return
            except Exception as e:
                print(f"[warn] get_preview_url fast path failed for {yt_vid}: {e}", file=sys.stderr)

        # SoundCloud и прочие домены (а также фолбэк при отказе быстрого пути YouTube)
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
            'user_agent': _CHROME_UA,
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

        stream_url = info.get('url', '')
        protocol = info.get('protocol', '')
        ext = info.get('ext', '')

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
        suffix = str(int(time.time() * 1000))
        yt_vid = _extract_youtube_video_id(url)
        safe_id = sanitize(video_id or yt_vid or '')

        # Для YouTube-ссылок резолвим аудио через рабочий fast-path и качаем чанками
        if yt_vid:
            try:
                stream_url, fast_loudness, _ = _resolve_youtube_audio_stream(yt_vid)
                if _is_task_cancelled(call_id, ctx.is_cancelled):
                    raise _DownloadCancelled('Cancelled by client')
                if stream_url:
                    headers = _yt_download_headers()
                    ext = _infer_audio_ext(stream_url)
                    filename = f'{safe_id}_{suffix}.{ext}'
                    filepath = os.path.join(songs_path, filename)
                    try:
                        _download_googlevideo_chunked(
                            stream_url, filepath, headers, call_id, ctx.is_cancelled
                        )
                    except _DownloadCancelled:
                        raise
                    except Exception as dl_err:
                        if _http_status_code(dl_err) in (403, 410):
                            with _ptf_pot_lock:
                                _ptf_pot_cache.pop(yt_vid, None)
                            fresh_url, fresh_loudness, _ = _resolve_youtube_audio_stream(yt_vid)
                            if not fresh_url:
                                raise
                            if fresh_loudness is not None:
                                fast_loudness = fresh_loudness
                            ext = _infer_audio_ext(fresh_url)
                            filename = f'{safe_id}_{suffix}.{ext}'
                            filepath = os.path.join(songs_path, filename)
                            _download_googlevideo_chunked(
                                fresh_url, filepath, headers, call_id, ctx.is_cancelled
                            )
                        else:
                            raise

                    safe_print({
                        'event': 'download_progress',
                        'callId': call_id,
                        'status': "Download complete, analyzing loudness...",
                        'progress': '100%',
                    })
                    gain_db, gain_measured = _measure_local_gain(filepath, fallback_gain_db=fast_loudness)
                    safe_print({
                        'status': 'ok',
                        'filename': filename,
                        'gainDb': gain_db,
                        'gainMeasured': gain_measured,
                        'callId': call_id,
                    })
                    return
            except _DownloadCancelled as e:
                safe_print({'status': 'error', 'message': str(e), 'callId': call_id})
                return
            except Exception as e:
                if _is_task_cancelled(call_id, ctx.is_cancelled):
                    safe_print({'status': 'error', 'message': 'Cancelled by client', 'callId': call_id})
                    return
                print(f"[warn] download_track fast path failed for {yt_vid}, falling back to yt-dlp: {e}", file=sys.stderr)

        is_sc = url and 'soundcloud.com' in url
        output_template = os.path.join(songs_path, f"{safe_id.replace('%', '%%')}_{suffix}.%(ext)s")

        ydl_opts = {
            'format': 'bestaudio/best',
            'quiet': True,
            'no_warnings': True,
            'noprogress': True,
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

        if not os.path.exists(filepath):
            for f in os.listdir(songs_path):
                if f.startswith(safe_id + '_' + suffix + '.'):
                    filename = f
                    filepath = os.path.join(songs_path, f)
                    break

        gain_db, gain_measured = _measure_local_gain(filepath, wait_stable=True)
        safe_print({
            'status': 'ok',
            'filename': filename,
            'gainDb': gain_db,
            'gainMeasured': gain_measured,
            'callId': call_id,
        })
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

    download_url = (
        request.get('url', '')
        or (raw_video_id if any(x in raw_video_id for x in ['soundcloud.com', 'youtube.com', 'youtu.be']) else None)
        or stream_url
    )
    is_sc = download_url and 'soundcloud.com' in download_url
    is_googlevideo = bool(download_url and 'googlevideo.com' in download_url)
    is_yt_api = bool(download_url and 'youtube.com/api' in download_url)
    yt_vid = (
        raw_video_id
        if _is_youtube_video_id(raw_video_id)
        else _extract_youtube_video_id(request.get('url', ''))
    )

    # Для googlevideo.com качаем параллельными range-чанками с Chrome UA
    if is_googlevideo:
        try:
            headers = _yt_download_headers()
            ext = _infer_audio_ext(download_url)
            filepath = os.path.join(songs_path, f'dl_direct_{video_id_sanitized}_{suffix}.{ext}')

            try:
                _download_googlevideo_chunked(
                    download_url, filepath, headers, call_id, ctx.is_cancelled
                )
            except _DownloadCancelled:
                raise
            except Exception as dl_err:
                if _http_status_code(dl_err) in (403, 410) and yt_vid:
                    print(f"[warn] download_direct 403/410 for {yt_vid}, re-resolving stream URL", file=sys.stderr)
                    with _ptf_pot_lock:
                        _ptf_pot_cache.pop(yt_vid, None)
                    fresh_url, _, _ = _resolve_youtube_audio_stream(yt_vid)
                    if not fresh_url:
                        raise
                    ext = _infer_audio_ext(fresh_url)
                    filepath = os.path.join(songs_path, f'dl_direct_{video_id_sanitized}_{suffix}.{ext}')
                    _download_googlevideo_chunked(
                        fresh_url, filepath, headers, call_id, ctx.is_cancelled
                    )
                else:
                    raise

            safe_print({
                'event': 'download_progress',
                'callId': call_id,
                'status': "Download complete, analyzing loudness...",
                'progress': '100%',
            })
            gain_db, gain_measured = _measure_local_gain(filepath)
            safe_print({
                'status': 'ok',
                'filename': os.path.basename(filepath),
                'gainDb': gain_db,
                'gainMeasured': gain_measured,
                'callId': call_id,
            })
            return
        except _DownloadCancelled as e:
            safe_print({'status': 'error', 'message': str(e), 'callId': call_id})
            return
        except Exception as e:
            if _is_task_cancelled(call_id, ctx.is_cancelled):
                safe_print({'status': 'error', 'message': 'Cancelled by client', 'callId': call_id})
                return
            print(f"[error] download_direct chunked failed for {video_id_sanitized}: {e}", file=sys.stderr)

    elif is_yt_api:
        filepath = ''
        try:
            headers = _yt_download_headers()
            ext = _infer_audio_ext(download_url)
            filepath = os.path.join(songs_path, f'dl_direct_{video_id_sanitized}_{suffix}.{ext}')
            downloaded = 0
            start_mono = time.monotonic()
            last_emit = start_mono

            with requests.get(download_url, stream=True, headers=headers, timeout=120) as r:
                r.raise_for_status()
                total = r.headers.get('Content-Length')
                total_size = int(total) if total and str(total).isdigit() else 0

                with open(filepath, 'wb') as f:
                    for chunk in r.iter_content(chunk_size=262144):
                        if _is_task_cancelled(call_id, ctx.is_cancelled):
                            raise _DownloadCancelled("Cancelled by client")
                        if not chunk:
                            continue
                        f.write(chunk)
                        downloaded += len(chunk)
                        now = time.monotonic()
                        if now - last_emit >= 0.15:
                            last_emit = now
                            mb_done = downloaded / (1024 * 1024)
                            speed_mb = mb_done / max(now - start_mono, 0.001)
                            if total_size > 0:
                                mb_total = total_size / (1024 * 1024)
                                pct = max(0.0, min(100.0, (downloaded / total_size) * 100.0))
                                status = f'{mb_done:.1f} / {mb_total:.1f} MB ({speed_mb:.1f} MB/s)'
                                progress_str = f'{pct:.1f}%'
                            else:
                                status = f'{mb_done:.1f} MB ({speed_mb:.1f} MB/s)'
                                progress_str = None
                            safe_print({
                                'event': 'download_progress',
                                'callId': call_id,
                                'status': status,
                                'downloadedBytes': downloaded,
                                'totalBytes': total_size,
                                'progress': progress_str,
                            })

            safe_print({'event': 'download_progress', 'callId': call_id, 'status': "Download complete, analyzing loudness...", 'progress': '100%'})
            gain_db, gain_measured = _measure_local_gain(filepath)
            safe_print({
                'status': 'ok',
                'filename': os.path.basename(filepath),
                'gainDb': gain_db,
                'gainMeasured': gain_measured,
                'callId': call_id,
            })
            return
        except _DownloadCancelled as e:
            try:
                if filepath and os.path.exists(filepath):
                    os.remove(filepath)
            except OSError:
                pass
            safe_print({'status': 'error', 'message': str(e), 'callId': call_id})
            return
        except Exception as e:
            try:
                if filepath and os.path.exists(filepath):
                    os.remove(filepath)
            except OSError:
                pass
            if _is_task_cancelled(call_id, ctx.is_cancelled):
                safe_print({'status': 'error', 'message': 'Cancelled by client', 'callId': call_id})
                return
            print(f"[error] download_direct requests failed for {video_id_sanitized}: {e}", file=sys.stderr)

    ydl_opts = {
        'format': 'bestaudio/best', 'quiet': True, 'no_warnings': True, 'noprogress': True,
        'outtmpl': output_template, 'noplaylist': True,
        **_yt_dlp_js_runtime_opts(),
    }
    if is_sc:
        ydl_opts['http_headers'] = {'Referer': 'https://soundcloud.com/', 'Origin': 'https://soundcloud.com', 'User-Agent': _CHROME_UA}

    def progress_hook(d):
        if d['status'] == 'downloading':
            p = d.get('_percent_str', '0%').replace('\x1b[0;32m', '').replace('\x1b[0m', '').strip()
            safe_print({'event': 'download_progress', 'callId': call_id, 'status': f"Downloading: {p}", 'progress': p})
        elif d['status'] == 'finished':
            safe_print({'event': 'download_progress', 'callId': call_id, 'status': "Download complete, analyzing loudness...", 'progress': '100%'})

    ydl_opts['progress_hooks'] = [progress_hook]

    try:
        ytdlp_target = f'https://www.youtube.com/watch?v={yt_vid}' if (is_googlevideo and yt_vid) else (download_url if download_url else stream_url)
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.extract_info(ytdlp_target, download=True)

        filename = ""
        filepath = ""
        for f in os.listdir(songs_path):
            if f.startswith(f'dl_direct_{video_id_sanitized}_{suffix}.'):
                filename = f
                filepath = os.path.join(songs_path, f)
                break

        gain_db, gain_measured = _measure_local_gain(filepath)
        safe_print({
            'status': 'ok',
            'filename': filename,
            'gainDb': gain_db,
            'gainMeasured': gain_measured,
            'callId': call_id,
        })
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
    cancel_event = None
    if call_id:
        thread_local.call_id = call_id
        cancel_event = threading.Event()
        with tasks_lock:
            active_tasks[call_id] = cancel_event

    def _call_is_cancelled():
        if cancel_event is not None and cancel_event.is_set():
            return True
        return is_cancelled()

    try:
        handler = COMMANDS.get(command) if isinstance(command, str) else None
        if handler is None:
            safe_print({'status': 'error', 'message': f'Unknown command: {command}', 'callId': call_id})
        else:
            context = CommandContext(call_id, safe_print, get_api, get_yandex_client, _call_is_cancelled)
            handler(request, context)
    except Exception as e:
        if not _call_is_cancelled():
            traceback.print_exc()
            safe_print({'status': 'error', 'message': str(e), 'callId': call_id})
    finally:
        if call_id:
            with tasks_lock:
                if active_tasks.get(call_id) is cancel_event:
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
