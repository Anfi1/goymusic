"""Local audio metadata and ffmpeg loudness measurements."""
import math
import os
import re
import subprocess
import sys
import time


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

def _ffmpeg_loudness(stream_url, ss=None, t=None, timeout=20):
    """(интегрированная громкость LUFS, true peak dBTP) для среза стрима, None при провале.

    Фильтр ebur128, а не loudnorm: цифры те же (EBU R128, расхождение до 0.05 дБ на замере
    2026-09-25), но loudnorm ради своей второй фазы апсемплит всё до 192 кГц и ест в 4-5 раз
    больше CPU. Трек в 2.5 минуты: 2.9с против 0.6с, по сети упирается уже в загрузку."""
    import subprocess
    cmd = [get_ffmpeg_exe(), '-hide_banner', '-nostats', '-probesize', '64k', '-analyzeduration', '0']
    if ss is not None: cmd += ['-ss', str(int(ss))]
    cmd += ['-i', stream_url]
    if t is not None: cmd += ['-t', str(int(t))]
    cmd += ['-vn', '-sn', '-dn', '-af', 'ebur128=peak=true:framelog=quiet', '-f', 'null', '-']
    r = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                       text=True, timeout=timeout, encoding='utf-8', errors='ignore')
    return _parse_ebur128(r.stderr or '')

def _parse_ebur128(stderr):
    """Итоговая сводка ebur128 (Summary в конце stderr) -> (I, true peak) или None."""
    _, sep, summary = stderr.rpartition('Summary:')
    if not sep:  # ffmpeg оборвался до конца -- промежуточным цифрам не верим
        return None
    m_i = re.search(r'\bI:\s*(-?[\d.]+|-inf) LUFS', summary)
    m_tp = re.search(r'\bPeak:\s*(-?[\d.]+|-inf) dBFS', summary)
    if not m_i or not m_tp:
        return None
    return float(m_i.group(1)), float(m_tp.group(1))

def _ffmpeg_loudness_i(stream_url, ss=None, t=None):
    """Интегрированная громкость (LUFS) для среза стрима. None при провале."""
    d = _ffmpeg_loudness(stream_url, ss=ss, t=t)
    return None if d is None else d[0]

def measure_loudness_full(stream_url):
    """Поправка до -14 LUFS для стрима без готовых метаданных (SoundCloud и YT-треки,
    у которых YouTube не отдал громкость). Меряем ТРЕК ЦЕЛИКОМ: раньше брали 3 окна по
    10с ради скорости, но замер показал промах до 2.56 дБ, а с уходом замера в фон
    экономить время больше незачем.

    Возвращает (loudness, true_peak) или (None, None)."""
    d = _ffmpeg_loudness(stream_url, timeout=300)
    if not d:
        return None, None
    i, tp = d
    if not math.isfinite(i) or i <= -70:  # тишина / -inf / NaN
        return None, None

    loudness = i + 14.0
    # При усилении (loudness < 0) не даем пикам вылезти выше -1 dBTP: пик после гейна
    # равен tp - loudness, значит loudness не должен опускаться ниже tp + 1.
    if loudness < 0 and math.isfinite(tp):
        loudness = max(loudness, tp + 1.0)
    safe_tp = tp if math.isfinite(tp) else None
    return loudness, safe_tp


def _safe_fallback_gain(value: float | None) -> float | None:
    if value is None:
        return None
    try:
        v = float(value)
    except (TypeError, ValueError):
        return 0.0
    return v if math.isfinite(v) else 0.0


def _wait_file_stable(filepath: str) -> None:
    """Ждем стабилизации размера свежезаписанного/импортированного файла на диске."""
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
        pass


def _volumedetect_full(filepath: str, timeout: int = 120) -> float | None:
    """Запасной замер по всему файлу без -ss 30, чтобы короткие треки не уходили в тишину."""
    vd_proc = subprocess.run(
        [
            get_ffmpeg_exe(),
            '-hide_banner',
            '-nostats',
            '-vn', '-sn', '-dn',
            '-i', filepath,
            '-af', 'volumedetect',
            '-f', 'null', '-',
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout,
        encoding='utf-8',
        errors='ignore',
    )
    stderr = vd_proc.stderr or ''
    m_mean = re.search(r'mean_volume:\s*([+-]?[\d.]+|-inf|inf|nan)\s*dB', stderr, re.IGNORECASE)
    if not m_mean:
        return None
    mean_db = float(m_mean.group(1))
    if not math.isfinite(mean_db) or mean_db <= -70.0:
        return None
    gain = mean_db + 14.0
    m_max = re.search(r'max_volume:\s*([+-]?[\d.]+|-inf|inf|nan)\s*dB', stderr, re.IGNORECASE)
    if m_max:
        max_db = float(m_max.group(1))
        if gain < 0 and math.isfinite(max_db):
            gain = max(gain, max_db + 1.0)
    return float(gain)


def measure_local_gain_db(
    filepath: str,
    fallback_gain_db: float | None = 0.0,
    wait_stable: bool = False,
) -> tuple[float | None, bool]:
    """Единый замер громкости локального файла через полный EBU R128 с фолбэком на volumedetect."""
    fallback = _safe_fallback_gain(fallback_gain_db)
    if not filepath or not os.path.exists(filepath):
        return fallback, False

    if wait_stable:
        _wait_file_stable(filepath)

    try:
        loud, _ = measure_loudness_full(filepath)
        if loud is not None and math.isfinite(loud):
            return float(loud), True
    except Exception as e:
        print(f"[warn] ffmpeg ebur128 failed: {e}", file=sys.stderr)

    try:
        vd_gain = _volumedetect_full(filepath)
        if vd_gain is not None and math.isfinite(vd_gain):
            return float(vd_gain), True
    except Exception as e2:
        print(f"[warn] ffmpeg volumedetect failed: {e2}", file=sys.stderr)

    return fallback, False


def measure_loudness(request, ctx):
    # Фоновый замер для стримов без метаданных громкости (SoundCloud и редкие
    # YT-треки, где YouTube не отдал perceptualLoudnessDb). Каждый запрос и так
    # обрабатывается в своем потоке, воспроизведение не ждет.
    t0 = time.time()
    loud, tp = measure_loudness_full(request.get('url'))
    print(f"[perf] measure_loudness: {time.time() - t0:.1f}s (loudness: {loud}, tp: {tp})", file=sys.stderr)
    if loud is None:
        ctx.emit({'status': 'error', 'message': 'loudnorm failed'})
    else:
        ctx.emit({'status': 'ok', 'loudness': loud, 'truePeak': tp})


def analyze_file(request, ctx):
    filename = request.get('filename', '')
    songs_path = request.get('songsPath', '')
    filepath = os.path.join(songs_path, filename)
    gain_db, measured = measure_local_gain_db(filepath, fallback_gain_db=0.0, wait_stable=True)
    ctx.emit({'status': 'ok', 'gainDb': gain_db, 'measured': measured})
