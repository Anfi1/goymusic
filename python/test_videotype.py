#!/usr/bin/env python
"""Диагностика «играет клип/лайв вместо студийного трека».

В самом приложении предпочтения ATV над OMV нет нигде — ни в api.py, ни в src/.
Что отдала лента/поиск, то и играет. Скрипт показывает, какие записи существуют
под один трек и чем они отличаются по videoType и длительности.

  python python/test_videotype.py --artist Midix              # все записи артиста
  python python/test_videotype.py --id LtFLvOWFg48 --resolve  # что реально приедет в <audio>
  python python/test_videotype.py "Парад смерти"              # что отдаёт поиск
  python python/test_videotype.py --filters                   # живы ли фильтры поиска

Обозначения videoType:
  ATV  -- art track, студийная запись (то, что нужно почти всегда)
  OMV  -- official music video, клип; аудио может быть лайвом/другим миксом
  UGC  -- пользовательская заливка
"""
import argparse
import copy
import json
import os
import sys

# reconfigure, а НЕ новый TextIOWrapper: api.py на импорте сам переоборачивает
# sys.stdout, наш wrapper теряет ссылку, GC его закрывает вместе с общим буфером
# и любой следующий print падает в ValueError: I/O operation on closed file.
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FORK = os.path.join(BASE_DIR, 'python', 'fork')
if os.path.isdir(FORK):
    sys.path.insert(0, FORK)

from ytmusicapi import YTMusic

HL, GL = 'ru', 'BY'


def make_api():
    """Та же авторизация, что у приложения — иначе выдача поиска будет другой."""
    browser_file = os.path.join(os.environ.get('GOYMUSIC_USER_DATA', BASE_DIR), 'browser.json')
    if os.path.exists(browser_file):
        with open(browser_file, 'r', encoding='utf-8') as f:
            return YTMusic(auth=json.load(f), language=HL, location=GL), True
    return YTMusic(language=HL, location=GL), False


def short_type(vt):
    return vt.replace('MUSIC_VIDEO_TYPE_', '') if vt else '?'


def row(item):
    artists = ', '.join(a.get('name', '') for a in (item.get('artists') or []))
    return (
        f"  {short_type(item.get('videoType')):<18} "
        f"{str(item.get('duration') or '--:--'):>7}  "
        f"{item.get('videoId') or '-':<12}  "
        f"{(item.get('title') or '')[:40]:<40}  {artists[:28]}"
    )


def header():
    print(f"  {'videoType':<18} {'длит.':>7}  {'videoId':<12}  {'название':<40}  исполнитель")
    print("  " + "-" * 96)


def do_artist(api, name):
    """Все записи артиста. Выброс (клип/лайв/склейка) видно по типу или длительности."""
    print(f"\n=== артист: {name} ===")
    try:
        hits = [r for r in api.search(name, limit=20) if r.get('resultType') == 'artist']
    except Exception as e:
        print(f"  поиск ОШИБКА: {type(e).__name__}: {e}")
        return
    if not hits:
        print("  артист не найден")
        return
    aid = hits[0].get('browseId')
    print(f"  browseId: {aid}")
    try:
        art = api.get_artist(aid)
    except Exception as e:
        print(f"  get_artist ОШИБКА: {type(e).__name__}: {e}")
        return

    for key, label in (('songs', 'песни (ожидаем ATV)'), ('videos', 'видео (OMV/UGC)')):
        block = art.get(key) or {}
        items = block.get('results') or []
        print(f"\n--- {label}: {len(items)} ---")
        if not items:
            continue
        header()
        for it in items:
            print(row(it))
        if block.get('browseId'):
            print(f"  (полный список за этим browseId: {block['browseId']})")


def do_filters(api, query):
    """Живы ли фильтры поиска в вендоренном форке."""
    print(f"\n=== фильтры поиска на запросе {query!r} ===")
    for flt in ('songs', 'videos', 'albums', 'artists', None):
        try:
            n = len(api.search(query, filter=flt, limit=5))
            print(f"  filter={str(flt):<8} -> {n} результатов")
        except Exception as e:
            print(f"  filter={str(flt):<8} -> ОШИБКА {type(e).__name__}: {e}")


def do_search(api, query):
    print(f"\n=== поиск без фильтра ===")
    try:
        res = api.search(query, limit=20)
    except Exception as e:
        print(f"  ОШИБКА: {type(e).__name__}: {e}")
        return
    rows = [r for r in res if r.get('videoId')]
    if not rows:
        print("  ничего")
        return
    header()
    for item in rows[:15]:
        print(row(item))


def do_id(api, video_id):
    print(f"\n=== чем является {video_id} ===")
    try:
        song = api.get_song(video_id)
        d = song.get('videoDetails', {})
        secs = int(d.get('lengthSeconds') or 0)
        print(f"  название:     {d.get('title')}")
        print(f"  автор:        {d.get('author')}")
        print(f"  длительность: {secs // 60}:{secs % 60:02d}  ({secs} сек)")
        print(f"  просмотры:    {d.get('viewCount')}")
        print(f"  playability:  {song.get('playabilityStatus', {}).get('status')}")
    except Exception as e:
        print(f"  get_song ОШИБКА: {type(e).__name__}: {e}")
        return

    # videoType живёт не в player-ответе, а в навигации YT Music
    print(f"\n=== очередь-радио от этого id (первые 5) ===")
    try:
        wp = api.get_watch_playlist(videoId=video_id, limit=5)
        tracks = wp.get('tracks') or []
        if tracks:
            header()
            for t in tracks[:5]:
                print(row(t))
            print(f"\n  videoType самого {video_id}: {short_type(tracks[0].get('videoType'))}")
    except Exception as e:
        print(f"  get_watch_playlist ОШИБКА: {type(e).__name__}: {e}")


def do_resolve(video_id):
    """Тем же кодом, что и приложение: сверяем длительность метаданных с длительностью
    того, что реально придёт в <audio>. Расходятся — значит стрим не от этой записи."""
    sys.path.insert(0, os.path.join(BASE_DIR, 'python'))
    import api as goyapi  # main() под if __name__, импорт побочек не даёт
    sys.stdout.reconfigure(errors='replace')  # api.py поставил свой wrapper без errors
    from pytubefix import extract as ptf_extract

    print(f"\n=== что реально резолвится для {video_id} ===")
    try:
        visitor_data, js, js_url, sig_ts = goyapi._pytubefix_state(video_id)
        _, po_token = goyapi._pytubefix_pot(video_id)
        it = goyapi._PtfInnerTube('WEB_MUSIC')
        it.innertube_context = copy.deepcopy(it.innertube_context)
        it.innertube_context.update(sig_ts)
        it.insert_po_token(visitor_data=visitor_data, po_token=po_token)
        resp = it.player(video_id)
    except Exception as e:
        print(f"  ОШИБКА резолва: {type(e).__name__}: {e}")
        return

    d = resp.get('videoDetails', {})
    meta_s = int(d.get('lengthSeconds') or 0)
    print(f"  метаданные:   {d.get('title')} — {d.get('author')}")
    # Ключевой вопрос: несёт ли player-ответ тип записи. Если да -- отличать клип от
    # альбомной версии можно бесплатно, прямо в _resolve_fast, без лишнего запроса.
    print(f"  musicVideoType в player-ответе: {d.get('musicVideoType')!r}")
    print(f"  длительность: {meta_s // 60}:{meta_s % 60:02d}  ({meta_s} сек)")

    manifest = ptf_extract.apply_descrambler(resp['streamingData'])
    audio = [f for f in manifest if str(f.get('mimeType', '')).startswith('audio/')]
    if not audio:
        print("  аудио-форматов нет")
        return
    print(f"\n  {'itag':>5}  {'битрейт':>9}  {'длит. потока':>13}  mimeType")
    print("  " + "-" * 70)
    for f in sorted(audio, key=lambda x: x.get('bitrate', 0), reverse=True):
        secs = int(f.get('approxDurationMs') or 0) // 1000
        mark = ''
        if meta_s and abs(secs - meta_s) > 3:
            mark = f'   <-- РАСХОДИТСЯ на {secs - meta_s:+d} сек'
        print(f"  {f.get('itag'):>5}  {f.get('bitrate', 0) // 1000:>6} kbps  "
              f"{secs // 60:>8}:{secs % 60:02d}  {str(f.get('mimeType'))[:34]}{mark}")


def selfcheck():
    """Офлайн: нормализация названий, на которой держится поиск альбомного близнеца."""
    sys.path.insert(0, os.path.join(BASE_DIR, 'python'))
    import api as goyapi
    sys.stdout.reconfigure(errors='replace')
    n = goyapi._norm_title

    # служебные хвосты клипов не должны мешать совпадению с альбомным названием
    assert n('Парад Смерти') == n('Парад Смерти (Официальный клип)')
    assert n('Рассвет') == n('Рассвет (Премьера 2021)')
    assert n("lyin n' dyin") == n("lyin n dyin [Official Video]")
    # регистр и пунктуация
    assert n('Не моя вина, что я не популярна') == n('не моя вина что я не популярна')
    # разные треки склеиваться не должны
    assert n('Парад Смерти') != n('Парад Смерти 2')
    assert n('Иная') != n('Иные')
    # пустые значения не роняют
    assert n(None) == '' and n('') == ''

    # разбор длительности кандидата из поиска
    cs = goyapi._cand_seconds
    assert cs({'duration_seconds': 107}) == 107
    assert cs({'duration': '1:47'}) == 107
    assert cs({'duration': '1:02:03'}) == 3723
    assert cs({'duration': None}) is None and cs({}) is None
    assert cs({'duration': 'ерунда'}) is None

    # правило подмены: меняем только при расхождении с ожидаемой длительностью.
    # 157/157 -- 'Everlasting Summer', где клип и есть альбомная запись: не трогать.
    # 146/107 -- 'Парад Смерти', где клип на 39с длиннее альбомного: менять.
    def swaps(actual, expected):
        return bool(expected) and bool(actual) and abs(actual - expected) > 3
    assert not swaps(157, 157)
    assert not swaps(157, 155)     # округление в строке трека
    assert swaps(146, 107)
    assert not swaps(146, None)    # без эталона не угадываем

    print("selfcheck OK")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('query', nargs='?', help='название трека для поиска')
    ap.add_argument('--id', dest='video_id', help='конкретный videoId для разбора')
    ap.add_argument('--resolve', action='store_true',
                    help='дорезолвить --id тем же кодом, что и приложение, и сверить длительности')
    ap.add_argument('--artist', help='все записи артиста с videoType и длительностью')
    ap.add_argument('--filters', action='store_true',
                    help='проверить, живы ли фильтры поиска (songs/videos/...)')
    ap.add_argument('--selfcheck', action='store_true', help='офлайн-проверка нормализации названий')
    args = ap.parse_args()

    if args.selfcheck:
        selfcheck()
        return

    if not any((args.query, args.video_id, args.artist, args.filters)):
        ap.error('нужен запрос, --id, --artist или --filters')

    api, authed = make_api()
    print(f"авторизация: {'browser.json' if authed else 'НЕТ (выдача будет отличаться от приложения)'}")

    if args.filters:
        do_filters(api, args.query or 'Nirvana')
    if args.artist:
        do_artist(api, args.artist)
    if args.video_id:
        do_id(api, args.video_id)
        if args.resolve:
            do_resolve(args.video_id)
    if args.query and not args.filters:
        do_search(api, args.query)


if __name__ == '__main__':
    main()
