"""Проверка поиска текстов: get_lyrics целиком + формат LRC, который мы собираем из YT Music.

    venv\\Scripts\\python.exe python\\test_lyrics.py --selfcheck   # без сети
    venv\\Scripts\\python.exe python\\test_lyrics.py               # реальные запросы
"""
import sys
import os
import io
import re
import json
import time
import contextlib

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
sys.stderr.reconfigure(encoding='utf-8', errors='replace')

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import api

# тот же разбор, что в src/components/organisms/LyricsView.tsx
LRC_RE = re.compile(r'\[(\d{2}):(\d{2})\.(\d{2,3})\]')

CASES = [
    # (artist, title, videoId, чего ждём)
    ('Radiohead', 'Creep', '9RfVp-GhKfs', 'synced'),
    ('Wintergatan', 'Marble Machine', None, 'instrumental'),
]


def lrc_line(start_ms, text):
    """Ровно то же выражение, что в api.get_lyrics/_ytmusic."""
    return f'[{start_ms // 60000:02d}:{start_ms // 1000 % 60:02d}.{start_ms % 1000 // 10:02d}]{text}'


def selfcheck():
    # миллисекунды YT Music -> LRC, который умеет разобрать фронт
    assert lrc_line(0, '♪') == '[00:00.00]♪'
    assert lrc_line(19920, 'When you were here before') == '[00:19.92]When you were here before'
    assert lrc_line(125410, 'x') == '[02:05.41]x'
    m = LRC_RE.match(lrc_line(125410, 'x'))
    assert m and int(m[1]) * 60 + int(m[2]) + int(m[3]) / 100 == 125.41, m

    # выбор результата: synced > plain > instrumental
    def pick(results):
        result = None
        for r in results:
            if not r:
                continue
            if r.get('syncedLyrics'):
                return r
            if result is None or (result.get('instrumental') and r.get('plainLyrics')):
                result = r
        return result

    inst = {'instrumental': True}
    plain = {'plainLyrics': 'a'}
    synced = {'syncedLyrics': '[00:00.00]a'}
    assert pick([inst, plain]) is plain
    assert pick([plain, inst]) is plain
    assert pick([inst, plain, synced]) is synced
    assert pick([inst]) is inst
    assert pick([None, None]) is None
    print('selfcheck ok')


def call(**kw):
    buf = io.StringIO()
    kw.setdefault('command', 'get_lyrics')
    kw.setdefault('callId', 'test')
    with contextlib.redirect_stdout(buf):
        api.handle_request(kw)
    return json.loads(buf.getvalue().strip().split('\n')[-1])


def main():
    if '--selfcheck' in sys.argv[1:]:
        selfcheck()
        return
    selfcheck()
    for artist, title, vid, want in CASES:
        t0 = time.time()
        r = call(artist=artist, title=title, videoId=vid)
        print(f"{artist} — {title}: status={r.get('status')} source={r.get('source')} "
              f"instrumental={r.get('instrumental')} "
              f"synced={'да' if r.get('syncedLyrics') else 'нет'} "
              f"plain={'да' if r.get('plainLyrics') else 'нет'} "
              f"(ждали {want}, {time.time() - t0:.1f}с)")


if __name__ == '__main__':
    main()
