#!/usr/bin/env python
"""Качает все версии трека с YouTube, чтобы послушать и выбрать правильную.

Имена файлов явные — тип, название, исполнитель, длительность и videoId прямо
в имени, чтобы после прослушивания можно было назвать нужный id.

  python python/download_versions.py "Midix Парад Смерти"
  python python/download_versions.py --ids LtFLvOWFg48 Ssj3MLxtJr8
  python python/download_versions.py "Midix Парад Смерти" --limit 8

Кладёт в папку versions/ в корне проекта.

Качаем через yt-dlp двумя путями по очереди: сначала tv+cookies (в логах приложения
он отрабатывает 28 из 28), затем web+botGuard-токен. У client=web селектор bestaudio
регулярно не находит ничего — "Requested format is not available", — поэтому он второй.
Прямой GET по ссылке из fast-path не годится: googlevideo отдаёт не-браузерным
HTTP-стекам 403 либо пропускает только мелкие range-запросы.
"""
import argparse
import os
import re
import sys

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FORK = os.path.join(BASE_DIR, 'python', 'fork')
if os.path.isdir(FORK):
    sys.path.insert(0, FORK)
sys.path.insert(0, os.path.join(BASE_DIR, 'python'))

OUT_DIR = os.path.join(BASE_DIR, 'versions')


def safe_name(s):
    """Windows не переваривает \\ / : * ? \" < > | в именах файлов."""
    s = re.sub(r'[\\/:*?"<>|]', '-', str(s or ''))
    return re.sub(r'\s+', ' ', s).strip()[:70]


def candidates_from_query(query, limit):
    import json
    from ytmusicapi import YTMusic
    browser_file = os.path.join(os.environ.get('GOYMUSIC_USER_DATA', BASE_DIR), 'browser.json')
    if os.path.exists(browser_file):
        with open(browser_file, 'r', encoding='utf-8') as f:
            api = YTMusic(auth=json.load(f), language='ru', location='BY')
    else:
        api = YTMusic(language='ru', location='BY')

    # без filter= сознательно: нужны ВСЕ типы сразу (ATV, OMV, UGC) в одном списке
    out = []
    for r in api.search(query, limit=30):
        vid = r.get('videoId')
        if not vid or any(c['id'] == vid for c in out):
            continue
        out.append({
            'id': vid,
            'type': (r.get('videoType') or '?').replace('MUSIC_VIDEO_TYPE_', ''),
            'title': r.get('title'),
            'artist': ', '.join(a.get('name', '') for a in (r.get('artists') or [])),
            'duration': r.get('duration'),
        })
        if len(out) >= limit:
            break
    return out


def download(cand, index):
    import yt_dlp
    import api as goyapi

    vid = cand['id']
    url = f'https://www.youtube.com/watch?v={vid}'
    name = (f"{index:02d} [{cand['type']}] {safe_name(cand['title'])}"
            f" - {safe_name(cand['artist'])}"
            f" ({safe_name(cand['duration']).replace(':', '-') or 'nn'}) {vid}")
    target = os.path.join(OUT_DIR, name + ".%(ext)s")

    class Quiet:
        def debug(self, m): pass
        def warning(self, m): pass
        def error(self, m): pass

    base = {
        'format': 'bestaudio/best',
        'outtmpl': target,
        'quiet': True, 'no_warnings': True, 'nocheckcertificate': True,
        'logger': Quiet(),
        'cachedir': False,
        'extractor_timeout': 30, 'socket_timeout': 30,
        **goyapi._yt_dlp_js_runtime_opts(),
    }

    attempts = []

    # 1) tv+cookies -- проверенный путь. player_skip НЕ ставим: без ytcfg
    #    авторизованной сессии tv отдаёт "Requested format is not available".
    goyapi.try_load_auth()
    cookie = (goyapi._auth_data or {}).get('Cookie') if goyapi._auth_type == 'browser' else None
    cookiefile = goyapi._youtube_cookiefile(cookie) if cookie else None
    if cookiefile:
        opts = dict(base, cookiefile=cookiefile,
                    extractor_args={'youtube': {'player_client': ['tv', 'web', 'mweb'],
                                                'skip': ['dash']}})
        ua = (goyapi._auth_data or {}).get('User-Agent')
        if ua:
            opts['user_agent'] = ua
        attempts.append(('tv+cookies', opts))

    # 2) web + botGuard-токен, привязанный к этому video_id
    try:
        visitor_data, po_token = goyapi._pytubefix_pot(vid)
        attempts.append(('web+pot', dict(base, extractor_args={'youtube': {
            'player_client': ['web'], 'skip': ['hls', 'dash'],
            'visitor_data': [visitor_data],
            'po_token': ['web.gvs+' + po_token],
        }})))
    except Exception as e:
        print(f"    токен не намолот: {type(e).__name__}: {e}")

    for label, opts in attempts:
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                ydl.download([url])
            print(f"    ok ({label})")
            return True
        except Exception as e:
            print(f"    {label}: {str(e)[:110]}")
    return False


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('query', nargs='?', help='что искать')
    ap.add_argument('--ids', nargs='+', help='качать эти videoId напрямую')
    ap.add_argument('--limit', type=int, default=6, help='сколько кандидатов из поиска (по умолчанию 6)')
    args = ap.parse_args()

    if not args.query and not args.ids:
        ap.error('нужен запрос или --ids')

    os.makedirs(OUT_DIR, exist_ok=True)

    if args.ids:
        cands = [{'id': v, 'type': 'id', 'title': v, 'artist': '', 'duration': ''}
                 for v in args.ids]
    else:
        cands = candidates_from_query(args.query, args.limit)
        if not cands:
            print("ничего не нашлось")
            return

    print(f"кандидатов: {len(cands)}, папка: {OUT_DIR}\n")
    ok = 0
    for i, c in enumerate(cands, 1):
        print(f"{i:02d} [{c['type']:<4}] {c['title']} — {c['artist']} "
              f"({c['duration'] or '?'})  {c['id']}")
        if download(c, i):
            ok += 1

    print(f"\nскачано {ok} из {len(cands)} -> {OUT_DIR}")
    print("Послушай и скажи, у какого videoId правильный студийный звук.")


if __name__ == '__main__':
    main()
