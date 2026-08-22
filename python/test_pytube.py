"""Замер pytubefix: где именно уходит время на резолв аудио-ссылки.

Запускать ТОЛЬКО с реального IP (не под VPN).

  python python/test_pytube.py                    # WEB_MUSIC + WEB, обычный режим и с кэшем токена
  python python/test_pytube.py --repeat 3
  python python/test_pytube.py --cookies          # добавить прогоны с куками (нужны для 18+)
  python python/test_pytube.py --cookies <id-18+>  # проверить age-restricted трек
  python python/test_pytube.py wxcnuc0GLSw MhsUKjwH1dE

Три фазы:
  botguard -- spawn node + botGuard.js VM ради PO-токена (pytubefix делает это на КАЖДЫЙ трек)
  player   -- visitor_data + innertube player-запрос (сеть)
  nsig     -- расшифровка signature/n в чистом python при обращении к .url

Режим 'pot-cache' переиспользует одну пару (visitorData, poToken) на все треки через штатный
po_token_verifier -- это и есть проверяемая гипотеза «за botGuard можно платить один раз».

Полученные ссылки НЕ проверяются запросом: googlevideo отдаёт 403 и requests, и ffmpeg
независимо от валидности URL. Проверить можно только реальным <audio> в Electron.
"""
import argparse
import functools
import json
import os
import sys
import time

for _s in (sys.stdout, sys.stderr):
    _s.reconfigure(encoding='utf-8', errors='replace')

import yt_dlp
from pytubefix import YouTube, extract as ptf_extract, request as ptf_request
from pytubefix.botGuard import bot_guard
from pytubefix.cipher import Cipher
from pytubefix.innertube import InnerTube, _default_clients
from pytubefix.sig_nsig.node_runner import NodeRunner

# dQw4w9WgXcQ намеренно НЕ в списке -- он у Google фактически в белом списке и
# всегда даёт ложный зелёный результат.
DEFAULT_VIDEOS = ['wxcnuc0GLSw', 'MhsUKjwH1dE', 'xfhbxDh4xrk']

# Замер 2026-08-22 с домашнего IP: ANDROID_VR (он же дефолтный клиент pytubefix) -- бот-детект
# на 100% треков, IOS -- HTTP 400, MEDIA_CONNECT -- HTTP 403, TV -- "unavailable" (протухшие
# параметры внутри pytubefix). Выброшены, чтобы не жечь репутацию IP мёртвыми запросами.
DEFAULT_CLIENTS = ['WEB_MUSIC', 'WEB']

TOKEN_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.pot_cache.json')


def find_browser_json():
    for p in (os.environ.get('GOYMUSIC_USER_DATA'),
              os.path.join(os.environ.get('APPDATA', ''), 'GoyMusic'),
              os.path.dirname(os.path.dirname(os.path.abspath(__file__)))):
        if p and os.path.exists(os.path.join(p, 'browser.json')):
            return os.path.join(p, 'browser.json')
    return None


def patch_cookies(cookie_header, user_agent):
    """pytubefix не умеет куки -- вшиваем заголовки в его единственную точку выхода в сеть."""
    orig = ptf_request._execute_request

    def patched(url, method=None, headers=None, data=None, **kw):
        headers = dict(headers or {})
        headers['Cookie'] = cookie_header
        if user_agent:
            headers['User-Agent'] = user_agent
        return orig(url, method=method, headers=headers, data=data, **kw)

    ptf_request._execute_request = patched
    return lambda: setattr(ptf_request, '_execute_request', orig)


def probe(video_id, client, cookies_auth, pot_pair):
    """pot_pair=None -- обычный путь (botGuard на каждый трек).
    pot_pair=(visitor_data, po_token) -- переиспользуем готовый токен."""
    undo = patch_cookies(cookies_auth['Cookie'], cookies_auth.get('User-Agent')) if cookies_auth else None
    url = f'https://www.youtube.com/watch?v={video_id}'
    t0 = time.perf_counter()
    try:
        if pot_pair:
            yt = YouTube(url, client=client, use_po_token=True,
                         po_token_verifier=lambda: pot_pair, token_file=TOKEN_FILE)
            t1 = time.perf_counter()
        else:
            yt = YouTube(url, client=client)
            yt.pot  # форсим botGuard отдельно, чтобы отделить его от сетевой фазы
            t1 = time.perf_counter()
        s = yt.streams.get_audio_only()
        t2 = time.perf_counter()
        if not s:
            return t1 - t0, t2 - t1, 0.0, 'нет аудио-форматов'
        stream_url = s.url
        t3 = time.perf_counter()
        return t1 - t0, t2 - t1, t3 - t2, f'OK itag={s.itag} {s.abr} len={len(stream_url)}'
    except Exception as e:
        return time.perf_counter() - t0, 0.0, 0.0, f'FAIL {type(e).__name__}: {str(e)[:70]}'
    finally:
        if undo:
            undo()


def mint_pot(video_id, client, cookies_auth=None):
    """Одна пара (visitorData, poToken) -- та самая, что мы хотим переиспользовать.

    Токен привязан к visitor_data сессии, поэтому для куки-режима нужна СВОЯ пара:
    анонимный visitor_data в авторизованной сессии невалиден."""
    undo = patch_cookies(cookies_auth['Cookie'], cookies_auth.get('User-Agent')) if cookies_auth else None
    try:
        yt = YouTube(f'https://www.youtube.com/watch?v={video_id}', client=client)
        return yt.visitor_data, yt.pot
    finally:
        if undo:
            undo()


def probe_ytdlp_web(video_id, pot_pair):
    """Тот же клиент WEB, но через yt-dlp и с нашим botGuard-токеном.
    Проверяем, принимает ли yt-dlp пару (visitor_data, po_token) от pytubefix."""
    visitor_data, po_token = pot_pair

    class Silent:
        def debug(self, m): pass
        def warning(self, m): pass
        def error(self, m): pass

    opts = {
        'format': 'bestaudio[ext=m4a]/bestaudio/best',
        'quiet': True, 'no_warnings': True, 'nocheckcertificate': True,
        'logger': Silent(), 'youtube_include_dash_manifest': False, 'cachedir': False,
        'extractor_args': {'youtube': {
            'player_client': ['web'], 'skip': ['hls', 'dash'],
            'visitor_data': [visitor_data], 'po_token': ['web.gvs+' + po_token],
        }},
        'extractor_timeout': 15, 'socket_timeout': 15,
    }
    t = time.perf_counter()
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(f'https://www.youtube.com/watch?v={video_id}', download=False)
        return time.perf_counter() - t, f"OK itag={info.get('format_id')} {info.get('abr')}kbps"
    except Exception as e:
        return time.perf_counter() - t, f'FAIL {type(e).__name__}: {str(e)[:70]}'


def probe_single_request(video_id, pot_pair, with_sig_ts):
    """Гипотеза: ОДИН innertube player-запрос с PO-токеном отдаёт и loudness, и готовый
    stream URL -- то есть отдельный резолв через pytubefix/yt-dlp вообще не нужен, потому
    что такой запрос приложение уже делает параллельно ради loudness/watchtime."""
    visitor_data, po_token = pot_pair
    t = time.perf_counter()
    try:
        it = InnerTube('WEB_MUSIC')
        if with_sig_ts:
            # pytubefix подмешивает signatureTimestamp, когда клиенту нужен JS-плеер;
            # без него форматы могут прийти с signatureCipher вместо готового url
            yt = YouTube(f'https://www.youtube.com/watch?v={video_id}', client='WEB_MUSIC',
                         use_po_token=True, po_token_verifier=lambda: pot_pair,
                         token_file=TOKEN_FILE)
            it.innertube_context.update(yt.signature_timestamp)
        it.insert_po_token(visitor_data=visitor_data, po_token=po_token)
        resp = it.player(video_id)
        dt = time.perf_counter() - t

        fmts = (resp.get('streamingData') or {}).get('adaptiveFormats') or []
        audio = [f for f in fmts if str(f.get('mimeType', '')).startswith('audio/')]
        ready = [f for f in audio if f.get('url')]
        ciphered = [f for f in audio if f.get('signatureCipher') and not f.get('url')]
        loud = (resp.get('playerConfig') or {}).get('audioConfig', {}).get('loudnessDb')
        status = (resp.get('playabilityStatus') or {}).get('status')
        if ready:
            best = max(ready, key=lambda f: f.get('bitrate', 0))
            return dt, f"OK url готов itag={best.get('itag')} {best.get('bitrate', 0) // 1000}kbps loudness={loud}"
        if ciphered:
            return dt, f'ЧАСТИЧНО: {len(ciphered)} форматов, но только signatureCipher (нужна расшифровка)'
        return dt, f'нет аудио-форматов (playabilityStatus={status}, всего форматов {len(fmts)})'
    except Exception as e:
        return time.perf_counter() - t, f'FAIL {type(e).__name__}: {str(e)[:70]}'


def probe_fast_path(video_id, pot_pair, warm, optimize):
    """Быстрый путь: один player-запрос + ЛОКАЛЬНАЯ расшифровка подписи.

    Всё дорогое (watch-страница ради js_url, сам base.js, signatureTimestamp) не зависит
    от трека и берётся из warm -- один раз на процесс. На трек остаётся ровно один
    сетевой запрос."""
    visitor_data, po_token = pot_pair
    js, js_url, sig_ts = warm
    t0 = time.perf_counter()
    try:
        it = InnerTube('WEB_MUSIC')
        it.innertube_context.update(sig_ts)
        it.insert_po_token(visitor_data=visitor_data, po_token=po_token)
        resp = it.player(video_id)
        t1 = time.perf_counter()

        manifest = ptf_extract.apply_descrambler(resp['streamingData'])
        ptf_extract.apply_po_token(manifest, resp, po_token)
        if optimize:
            # расшифровывать все форматы незачем -- нужен ровно один, лучший аудио
            audio = [f for f in manifest if str(f.get('mimeType', '')).startswith('audio/')]
            if not audio:
                return t1 - t0, time.perf_counter() - t1, 'нет аудио-форматов'
            manifest = [max(audio, key=lambda f: f.get('bitrate', 0))]
        ptf_extract.apply_signature(manifest, resp, js, js_url)
        audio = [f for f in manifest if str(f.get('mimeType', '')).startswith('audio/') and f.get('url')]
        t2 = time.perf_counter()
        if not audio:
            return t1 - t0, t2 - t1, 'нет аудио с url'
        best = max(audio, key=lambda f: f.get('bitrate', 0))
        return t1 - t0, t2 - t1, f"OK itag={best.get('itag')} {best.get('bitrate', 0) // 1000}kbps len={len(best['url'])}"
    except Exception as e:
        return time.perf_counter() - t0, 0.0, f'FAIL {type(e).__name__}: {str(e)[:70]}'


# Cipher.__init__ спавнит ДВА node-процесса и грузит в каждый 2MB base.js, а apply_signature
# в finally их убивает -- на каждый трек. Это и есть те ~0.8с «расшифровки»: не вычисление,
# а два холодных старта node. js между треками один и тот же, так что кэшируем Cipher и
# держим его процессы живыми -- они и есть «тёплое» состояние.
ptf_extract.Cipher = functools.lru_cache(maxsize=2)(Cipher)

_KEEP_NODE = False
_orig_close = NodeRunner.close


def _maybe_close(self):
    if not _KEEP_NODE:
        _orig_close(self)


NodeRunner.close = _maybe_close


def warm_up(video_id, pot_pair):
    """js_url тянет watch-страницу, base.js -- сам плеер, signatureTimestamp лежит в нём же.
    Ничего из этого не зависит от video_id, поэтому платим один раз."""
    yt = YouTube(f'https://www.youtube.com/watch?v={video_id}', client='WEB_MUSIC',
                 use_po_token=True, po_token_verifier=lambda: pot_pair, token_file=TOKEN_FILE)
    return yt.js, yt.js_url, yt.signature_timestamp


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('videos', nargs='*', default=DEFAULT_VIDEOS)
    ap.add_argument('--clients', default=','.join(DEFAULT_CLIENTS))
    ap.add_argument('--repeat', type=int, default=2)
    ap.add_argument('--cookies', action='store_true', help='добавить прогоны с куками')
    ap.add_argument('--no-pot-cache', action='store_true', help='не проверять переиспользование токена')
    ap.add_argument('--ytdlp-web', action='store_true', help='проверить yt-dlp client=web с нашим PO-токеном')
    ap.add_argument('--fast-path', action='store_true',
                    help='один player-запрос + локальная расшифровка подписи (кандидат в прод)')
    ap.add_argument('--single-request', action='store_true',
                    help='проверить, отдаёт ли один player-запрос сразу и loudness, и stream URL')
    args = ap.parse_args()

    clients = [c.strip() for c in args.clients.split(',') if c.strip()]
    bad = [c for c in clients if c not in _default_clients]
    if bad:
        sys.exit(f'неизвестные клиенты: {bad}\nдоступны: {sorted(_default_clients)}')
    videos = args.videos or DEFAULT_VIDEOS

    auth = None
    if args.cookies:
        path = find_browser_json()
        if path:
            with open(path, encoding='utf-8') as f:
                auth = json.load(f)
            print(f'куки: {path}')
        else:
            print('куки: browser.json не найден -- прогоны с куками пропущены')

    t = time.perf_counter()
    bot_guard.generate_po_token(video_id=videos[0])
    print(f'\nbotGuard в одиночку (spawn node + 2.6MB VM): {time.perf_counter() - t:.2f}s')

    pot_pair = None
    pot_auth = None
    if (args.ytdlp_web or args.single_request or args.fast_path) and args.no_pot_cache:
        sys.exit('этот режим несовместим с --no-pot-cache: токен обязателен')
    if not args.no_pot_cache:
        if os.path.exists(TOKEN_FILE):
            os.remove(TOKEN_FILE)
        t = time.perf_counter()
        pot_pair = mint_pot(videos[0], clients[0])
        print(f'намолот пары (visitorData, poToken), аноним: {time.perf_counter() - t:.2f}s')
        if auth:
            t = time.perf_counter()
            pot_auth = mint_pot(videos[0], clients[0], auth)
            print(f'намолот пары с куками: {time.perf_counter() - t:.2f}s')

    if args.fast_path:
        t = time.perf_counter()
        warm = warm_up(videos[0], pot_pair)
        print()
        print(f'разогрев (watch-страница + base.js + signatureTimestamp), один раз: {time.perf_counter() - t:.2f}s')
        print('дальше на каждый трек -- ровно один сетевой запрос:')
        global _KEEP_NODE
        for keep in (False, True):
            _KEEP_NODE = keep
            for vid in videos:
                for _ in range(args.repeat):
                    net, local, res = probe_fast_path(vid, pot_pair, warm, True)
                    print(f'  {vid:<14}{"node тёплый" if keep else "node холодный":<15}'
                          f'сеть={net:5.2f}s расшифровка={local:5.2f}s '
                          f'итого={net + local:5.2f}s  {res}')
        return

    if args.single_request:
        print()
        print('один innertube player-запрос с PO-токеном (loudness + stream URL сразу):')
        for vid in videos:
            for sig_ts in (False, True):
                for _ in range(args.repeat):
                    dt, res = probe_single_request(vid, pot_pair, sig_ts)
                    print(f'  {vid:<14}sig_ts={str(sig_ts):<6}{dt:6.2f}s  {res}')
        return

    if args.ytdlp_web:
        print()
        print('yt-dlp client=web с botGuard-токеном от pytubefix:')
        for vid in videos:
            for _ in range(args.repeat):
                dt, res = probe_ytdlp_web(vid, pot_pair)
                print(f'  {vid:<14}{dt:6.2f}s  {res}')
        return

    print(f'\n{"клиент":<11}{"режим":<11}{"куки":<7}{"botguard":>9}{"player":>8}{"nsig":>7}{"итого":>8}  результат')
    for vid in videos:
        print(f'--- {vid}')
        for client in clients:
            for mode, pair in (('обычный', None), ('pot-cache', pot_pair)):
                if mode == 'pot-cache' and not pair:
                    continue
                for ck in ([None, auth] if auth else [None]):
                    # с куками -- только «свой» токен, иначе замер бессмысленный
                    p = (pot_auth if ck else pair) if pair else None
                    if pair and ck and not p:
                        continue
                    for _ in range(args.repeat):
                        bg, pl, ns, res = probe(vid, client, ck, p)
                        print(f'{client:<11}{mode:<11}{"да" if ck else "нет":<7}'
                              f'{bg:8.2f}s{pl:7.2f}s{ns:6.2f}s{bg + pl + ns:7.2f}s  {res}')


if __name__ == '__main__':
    main()
