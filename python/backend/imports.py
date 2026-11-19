"""Streaming playlist imports, including progress events and cancellation."""
import random
import re
import sys
import time


def yandex_import_streaming(request, ctx):
    from difflib import SequenceMatcher
    from yandex_music import Client

    def _norm(s):
        return re.sub(r'[^\w\s]', '', (s or '').lower()).strip()

    def _sim(a, b):
        return SequenceMatcher(None, _norm(a), _norm(b)).ratio()

    token = request.get('token', '')
    start_index = int(request.get('startIndex', 0))
    ytm_api = ctx.get_api()
    matched = 0
    not_found = 0
    processed = start_index

    client = Client(token).init()
    tracks_list = client.users_likes_tracks()
    total = len(tracks_list)

    ctx.emit({'event': 'yandex_import_total', 'total': total})

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
            ctx.emit({
                'event': 'yandex_track_done',

                'index': i,
                'total': total,
                'title': title,
                'artist': artist,
                'durationMs': dur,
                'status': status,
            })
            if ctx.is_cancelled():
                break
            time.sleep(random.uniform(0.05, 0.15))

        if not ctx.is_cancelled():
            ctx.emit({'status': 'ok', 'matched': matched, 'notFound': not_found})
    except Exception as e:
        print(f"[yandex_import] Fatal error at index {processed}: {e}", file=sys.stderr)
        ctx.emit({'status': 'error', 'message': str(e), 'processedCount': processed})


def spotify_import_streaming(request, ctx):
    from difflib import SequenceMatcher
    import requests as _requests

    def _norm(s):
        return re.sub(r'[^\w\s]', '', (s or '').lower()).strip()

    def _sim(a, b):
        return SequenceMatcher(None, _norm(a), _norm(b)).ratio()

    token = request.get('token', '')
    start_index = int(request.get('startIndex', 0))
    ytm_api = ctx.get_api()
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
    ctx.emit({'event': 'spotify_import_total', 'total': total})

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
            ctx.emit({
                'event': 'spotify_track_done',

                'index': i,
                'total': total,
                'title': title,
                'artist': artist,
                'durationMs': dur,
                'status': status,
            })
            if ctx.is_cancelled():
                break
            time.sleep(random.uniform(0.05, 0.15))

        if not ctx.is_cancelled():
            ctx.emit({'status': 'ok', 'matched': matched, 'notFound': not_found})
    except Exception as e:
        print(f"[spotify_import] Fatal error at index {processed}: {e}", file=sys.stderr)
        ctx.emit({'status': 'error', 'message': str(e), 'processedCount': processed})
