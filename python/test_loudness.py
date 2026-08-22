"""Сверка шкалы громкости YouTube с реальным замером ffmpeg.

Для каждого трека: резолвим стрим тем же быстрым путём, что и продакшен, забираем
loudnessDb из ответа плеера и НЕЗАВИСИМО меряем тот же самый стрим через ffmpeg
loudnorm по всему треку. Дальше считаем, куда попадает громкость после нашего гейна.

    venv\\Scripts\\python.exe python\\test_loudness.py
    venv\\Scripts\\python.exe python\\test_loudness.py dQw4w9WgXcQ ...
    venv\\Scripts\\python.exe python\\test_loudness.py --url "https://...stream..."

Полный проход ffmpeg качает трек целиком, так что ~10-30с на трек. Это нормально,
тест диагностический и разовый.
"""
import sys
import os
import json
import copy
import time
import math
import statistics
import subprocess

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
sys.stderr.reconfigure(encoding='utf-8', errors='replace')

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import api

# id из реального лога воспроизведения
DEFAULT_IDS = ['Ar_vJ10NQHg', 'FDdkK8s87N0', 'JVilaNmHPLY', 'wsG5WtD7DAE', 'Ek_aNdxhTBQ', 'L5j7xQzgTNM']

TARGET_LUFS = -14.0


def resolve(video_id):
    """Повторяет api._resolve_fast, но отдаёт ещё и все поля громкости из ответа плеера."""
    visitor_data, js, js_url, sig_ts = api._pytubefix_state(video_id)
    _, po_token = api._pytubefix_pot(video_id)

    it = api._PtfInnerTube('WEB_MUSIC')
    it.innertube_context = copy.deepcopy(it.innertube_context)
    it.innertube_context.update(sig_ts)
    it.insert_po_token(visitor_data=visitor_data, po_token=po_token)
    resp = it.player(video_id)

    manifest = api.ptf_extract.apply_descrambler(resp['streamingData'])
    api.ptf_extract.apply_po_token(manifest, resp, po_token)
    audio = [f for f in manifest if str(f.get('mimeType', '')).startswith('audio/')]
    if not audio:
        raise RuntimeError('нет аудиоформатов')
    best = [max(audio, key=lambda f: f.get('bitrate', 0))]
    api.ptf_extract.apply_signature(best, resp, js, js_url)
    fmt = best[0]

    audio_cfg = (resp.get('playerConfig') or {}).get('audioConfig') or {}
    details = resp.get('videoDetails') or {}
    try:
        duration = float(details.get('lengthSeconds') or 0)
    except (TypeError, ValueError):
        duration = 0.0

    return {
        'url': fmt.get('url'),
        'itag': fmt.get('itag'),
        'title': details.get('title', '')[:34],
        'duration': duration,
        # то, что реально уходит в плеер сейчас: api.extract_loudness глубоким поиском
        'used': api.extract_loudness(resp),
        # каждое из мест по отдельности -- чтобы увидеть, совпадают ли они
        'fmt_loudness': fmt.get('loudnessDb'),
        'cfg_loudness': audio_cfg.get('loudnessDb'),
        'cfg_perceptual': audio_cfg.get('perceptualLoudnessDb'),
    }


def loudnorm_full(stream_url):
    """input_i / input_tp / input_lra по ВСЕМУ треку. Никаких окон -- эталон."""
    cmd = [api.get_ffmpeg_exe(), '-hide_banner', '-nostats', '-i', stream_url,
           '-vn', '-sn', '-dn', '-af', 'loudnorm=print_format=json', '-f', 'null', '-']
    r = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                       text=True, timeout=300, encoding='utf-8', errors='ignore')
    st = r.stderr or ''
    j0, j1 = st.rfind('{'), st.rfind('}') + 1
    if j0 == -1 or j1 <= j0:
        raise RuntimeError('ffmpeg не отдал json loudnorm')
    d = json.loads(st[j0:j1])
    return float(d['input_i']), float(d['input_tp']), float(d['input_lra'])


def fnum(v, w=7, p=2):
    return f"{v:>{w}.{p}f}" if isinstance(v, (int, float)) else f"{'--':>{w}}"


def selfcheck():
    """Проверка логики без сети: выбор поля громкости и потолок по пикам."""
    resp = {'streamingData': {'adaptiveFormats': [{'loudnessDb': 1.83}]},
            'playerConfig': {'audioConfig': {'loudnessDb': 1.83, 'perceptualLoudnessDb': -5.17}}}
    assert abs(api.extract_loudness(resp) - 8.83) < 1e-9, api.extract_loudness(resp)
    assert api.extract_loudness({'videoDetails': {'title': 'x'}}) is None

    # реальные пары (input_i, loudnessDb) из прогона: гейн = 10^(-loudness/20),
    # итог = input_i - loudness, и все должны сойтись в -14
    for i, ld in ((-5.20, 1.83), (-7.44, -0.41), (-4.85, 2.18),
                  (-8.19, -1.15), (-3.19, 3.85), (-11.62, -4.53)):
        after = i - api.extract_loudness({'loudnessDb': ld})
        assert abs(after + 14.0) < 0.15, (i, ld, after)

    # потолок по пикам: усиление не должно поднять пик выше -1 dBTP
    for i, tp in ((-20.0, -6.0), (-20.0, -0.5), (-6.0, 2.0)):
        loud = i + 14.0
        if loud < 0:
            loud = max(loud, tp + 1.0)
        assert tp - loud <= -1.0 + 1e-9, (i, tp, loud, tp - loud)
    print('selfcheck ok')


def main():
    args = [a for a in sys.argv[1:]]
    if '--selfcheck' in args:
        selfcheck()
        return
    if '--url' in args:
        u = args[args.index('--url') + 1]
        i, tp, lra = loudnorm_full(u)
        print(f"input_i={i:.2f} LUFS  input_tp={tp:.2f} dBTP  LRA={lra:.2f}")
        print(f"чтобы попасть в {TARGET_LUFS:.0f} LUFS: gain = {TARGET_LUFS - i:+.2f} dB")
        return

    if '--fields' in args:
        args.remove('--fields')
        print('  id             loudnessDb  perceptual   разница')
        print('  ' + '-' * 48)
        deltas = []
        for vid in (args or DEFAULT_IDS):
            try:
                info = resolve(vid)
            except Exception as e:
                print(f"  {vid:<12} провал -- {e}")
                continue
            ld, pl = info['cfg_loudness'], info['cfg_perceptual']
            d = (ld - pl) if isinstance(ld, (int, float)) and isinstance(pl, (int, float)) else None
            if d is not None:
                deltas.append(d)
            print(f"  {vid:<12}{fnum(ld, 10)}{fnum(pl, 12)}{fnum(d, 10)}")
        if deltas:
            print()
            print(f"  loudnessDb - perceptualLoudnessDb: среднее {statistics.mean(deltas):.3f} дБ, "
                  f"разброс {statistics.pstdev(deltas):.3f} дБ")
        return

    ids = args or DEFAULT_IDS
    rows = []

    for vid in ids:
        t0 = time.time()
        try:
            info = resolve(vid)
        except Exception as e:
            print(f"{vid}: резолв провалился -- {e}")
            continue
        t_resolve = time.time() - t0

        t0 = time.time()
        try:
            i_full, tp, lra = loudnorm_full(info['url'])
        except Exception as e:
            print(f"{vid}: ffmpeg провалился -- {e}")
            continue
        t_ffmpeg = time.time() - t0

        # та же оценка по 3 окнам, которой мы меряем SoundCloud -- насколько она врёт
        try:
            i_win = api.sc_measure_loudness(info['url'], info['duration']) - 14.0
        except Exception:
            i_win = None

        rows.append({**info, 'id': vid, 'i_full': i_full, 'tp': tp, 'lra': lra, 'i_win': i_win})
        print(f"{vid} [{info['itag']}] {info['title']:<34} "
              f"резолв {t_resolve:.2f}с, ffmpeg {t_ffmpeg:.1f}с")

    if not rows:
        print('нечего анализировать')
        return

    print()
    print('  id             YT dB   формат  audioCfg   input_i  input_tp   после гейна  при инверсии  3 окна')
    print('  ' + '-' * 104)
    for r in rows:
        yt = r['used']
        after = r['i_full'] - yt if isinstance(yt, (int, float)) else None
        inverted = r['i_full'] + yt if isinstance(yt, (int, float)) else None
        win_err = (r['i_win'] - r['i_full']) if r['i_win'] is not None else None
        print(f"  {r['id']:<12}{fnum(yt)} {fnum(r['fmt_loudness'])} {fnum(r['cfg_loudness'])}  "
              f"{fnum(r['i_full'])}  {fnum(r['tp'])}   {fnum(after)}      {fnum(inverted)}   {fnum(win_err, 6)}")

    vals_after = [r['i_full'] - r['used'] for r in rows if isinstance(r['used'], (int, float))]
    vals_inv = [r['i_full'] + r['used'] for r in rows if isinstance(r['used'], (int, float))]
    vals_raw = [r['i_full'] for r in rows]

    def summary(name, vals):
        if len(vals) < 2:
            return
        m, sd = statistics.mean(vals), statistics.pstdev(vals)
        print(f"  {name:<26} среднее {m:>7.2f} LUFS   разброс {sd:>5.2f} дБ   "
              f"промах мимо {TARGET_LUFS:.0f}: {m - TARGET_LUFS:+.2f} дБ")

    print()
    print('  Итог (чем меньше разброс, тем лучше выровнено):')
    summary('без нормализации', vals_raw)
    summary('наша формула', vals_after)
    summary('если знак перевёрнут', vals_inv)

    wins = [r['i_win'] - r['i_full'] for r in rows if r['i_win'] is not None]
    if wins:
        print(f"\n  Оценка по 3 окнам (наш метод для SC) врёт на "
              f"{statistics.mean(wins):+.2f} дБ в среднем, максимум {max(map(abs, wins)):.2f} дБ")

    boosted = [r for r in rows if isinstance(r['used'], (int, float)) and r['used'] < 0]
    risky = [r for r in boosted if r['tp'] - r['used'] > -1.0]
    if risky:
        print(f"\n  Клиппинг: {len(risky)} из {len(rows)} треков после нашего гейна выходят выше -1 dBTP:")
        for r in risky:
            print(f"    {r['title']}: {r['tp']:.2f} -> {r['tp'] - r['used']:+.2f} dBTP")
    else:
        print(f"\n  Клиппинг: ни один трек после гейна не превышает -1 dBTP")


if __name__ == '__main__':
    main()
