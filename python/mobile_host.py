"""Хост api.py внутри Android-приложения (Chaquopy).

На десктопе api.py -- отдельный процесс, который читает JSON-строки из stdin и пишет
ответы в stdout. На Android процессов нет, Python живёт в том же процессе, что и UI.
Поэтому здесь подменяются только концы трубы: запрос приходит вызовом call(), а ответы
перехватываются подменённым sys.stdout и уходят колбэком в Kotlin.

Сам api.py при этом не меняется вообще -- он как писал JSON-строки в stdout, так и пишет.
"""
import io
import json
import os
import sys
import threading

_emit = None
_api = None


class _LineSink(io.RawIOBase):
    """Собирает байты из stdout api.py и отдаёт наружу готовыми строками."""

    def __init__(self):
        self._buf = b''

    def writable(self):
        return True

    def write(self, b):
        self._buf += bytes(b)
        while b'\n' in self._buf:
            line, self._buf = self._buf.split(b'\n', 1)
            text = line.decode('utf-8', 'replace').strip()
            if text and _emit is not None:
                try:
                    # Из Kotlin приходит объект с методом onLine (Chaquopy не делает
                    # java-объекты вызываемыми), из чистого Python -- обычная функция.
                    handler = getattr(_emit, 'onLine', _emit)
                    handler(text)
                except Exception:
                    pass
        return len(b)


class _FakeStd:
    """api.py на импорте делает io.TextIOWrapper(sys.stdout.buffer) -- нужен .buffer."""

    def __init__(self, buffer):
        self.buffer = buffer


def start(user_data_dir, emit):
    """Поднимает бэкенд. emit(line) -- колбэк, куда уходят JSON-ответы."""
    global _emit, _api
    _emit = emit

    os.environ['GOYMUSIC_USER_DATA'] = user_data_dir
    os.makedirs(user_data_dir, exist_ok=True)

    # api.py на импорте добавляет <BASE>/python/fork в sys.path -- на десктопе это
    # подключает вендоренный ytmusicapi. В APK такого каталога нет, но проверить это
    # через os.path.isdir нельзя: внутри AssetFinder он отвечает True даже на
    # несуществующие пути. Дальше импорт-хук Chaquopy идёт открывать asset "python",
    # не находит и валит FileNotFoundError -- вместе со всем импортом api.
    # Поэтому запрещаем любые вставки внутрь дерева Chaquopy: своими путями он
    # управляет сам, а ytmusicapi там и так лежит модулем верхнего уровня (mobile/pysrc).
    _asset_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    class _SafePath(list):
        def insert(self, index, value):
            if isinstance(value, str) and value.startswith(_asset_root):
                return
            super().insert(index, value)

    sys.path = _SafePath(sys.path)

    sys.stdin = _FakeStd(io.BytesIO(b''))
    sys.stdout = _FakeStd(io.BufferedWriter(_LineSink()))

    # pytubefix на импорте тянет nodejs_wheel (бандленный Node). Под Android его нет и
    # не нужно -- JS исполняет WebView. Подкладываем заглушку в sys.modules, чтобы импорт
    # прошёл; сам NodeRunner всё равно подменяется ниже.
    import types
    _njs = types.ModuleType('nodejs_wheel')
    _njs_exec = types.ModuleType('nodejs_wheel.executable')
    _njs_exec.ROOT_DIR = ''
    _njs.executable = _njs_exec
    sys.modules.setdefault('nodejs_wheel', _njs)
    sys.modules.setdefault('nodejs_wheel.executable', _njs_exec)

    # JS-рантайм для расшифровки подписей YouTube: Node на Android нет, поэтому
    # скрипты плеера исполняет WebView. Ставим подмену ДО импорта api -- он держит
    # ссылку на NodeRunner прямо в своём неймспейсе.
    try:
        import js_bridge
        js_bridge.set_host(emit)
        js_bridge.install()
    except Exception as e:
        print(f'[mobile_host] js bridge unavailable: {e}', file=sys.stderr)

    import api  # noqa: E402 -- строго после подмены потоков
    _api = api

    # api.py тоже импортировал NodeRunner к себе -- переcтавляем и там, иначе
    # его monkey-patch close() держит старый класс.
    try:
        import js_bridge as _jb
        api._PtfNodeRunner = _jb.WebViewNodeRunner
    except Exception:
        pass

    try:
        api.try_load_auth()
    except Exception as e:
        print(f'[mobile_host] try_load_auth failed: {e}', file=sys.stderr)
    return True


def call(line):
    """Один запрос. Как и на десктопе -- в своём потоке, чтобы не блокировать UI."""
    if _api is None:
        return False
    request = json.loads(line)
    threading.Thread(target=_api.handle_request, args=(request,), daemon=True).start()
    return True
