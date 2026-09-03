"""JS-рантайм для Android: вместо Node исполняем скрипты в WebView приложения.

YouTube отдаёт ссылки на аудио с зашифрованной подписью, и расшифровать её можно
только выполнив кусок их же плеера на JavaScript. На десктопе pytubefix запускает
для этого бандленный Node, но под Android его нет и собрать нельзя.

Зато JS-движок в приложении уже есть -- сам WebView, в котором крутится интерфейс.
Здесь лежит подмена pytubefix.NodeRunner, которая гоняет тот же протокол
(load/call), только через мост в Kotlin.

Отличие от родного раннера: тот поднимает jsdom, чтобы у кода плеера были window и
document. В WebView они настоящие, эмулировать нечего.
"""
import json
import threading

_host = None
_lock = threading.Lock()


def set_host(host):
    """host -- java-объект из Kotlin с методом runJs(code) -> str."""
    global _host
    _host = host


def available():
    return _host is not None


def run_js(code, timeout=20.0):
    """Выполняет JS в WebView и возвращает разобранный результат.

    evaluateJavascript отдаёт значение в JSON-виде, поэтому строку с результатом
    приходится разбирать дважды: сначала обёртку WebView, потом наш JSON.
    """
    if _host is None:
        raise RuntimeError('js bridge is not available')
    # WebView -- один на всё приложение, параллельные evaluate ломают друг другу
    # глобальное состояние загруженного плеера.
    with _lock:
        raw = _host.runJs(code)
    if raw is None:
        raise RuntimeError('js bridge returned nothing')
    outer = json.loads(raw) if isinstance(raw, str) else raw
    if outer is None:
        raise RuntimeError('js bridge returned null')
    return json.loads(outer) if isinstance(outer, str) else outer


class WebViewNodeRunner:
    """Совместим по интерфейсу с pytubefix.sig_nsig.node_runner.NodeRunner."""

    _counter = 0

    def __init__(self, code):
        self.code = code
        self.function_name = None
        WebViewNodeRunner._counter += 1
        self._loaded = False

    @staticmethod
    def _exposed(code, fun_name):
        exposed = f"_exposed['{fun_name}']={fun_name};" + "})(_yt_player);"
        return code.replace("})(_yt_player);", exposed)

    def is_running(self):
        return self._loaded

    def restart(self):
        self._loaded = False
        if self.function_name:
            self.load_function(self.function_name)

    def load_function(self, function_name):
        self.function_name = function_name
        payload = self._exposed(self.code, function_name)
        # Код плеера кладём в глобальную область через косвенный eval -- ровно как
        # runInContext у родного раннера, где sandbox и есть global. Поэтому _exposed
        # тоже должен быть глобальным: локальную переменную такой eval не увидит.
        # Объект общий на все раннеры (их два -- sig и nsig), различаются они именем
        # функции, а не хранилищем -- в родном sandbox ровно так же.
        script = (
            '(function(){try{'
            'window._exposed=window._exposed||{};'
            '(0,eval)(' + json.dumps(payload) + ');'
            'return JSON.stringify({loaded:true});'
            '}catch(e){return JSON.stringify({error:String(e&&e.message||e)});}})()'
        )
        res = run_js(script)
        if isinstance(res, dict) and res.get('error'):
            raise RuntimeError(f'js load failed: {res["error"]}')
        self._loaded = True
        return res

    def call(self, args):
        if not self._loaded:
            self.load_function(self.function_name)
        script = (
            '(function(){try{'
            f'var f=(window._exposed||{{}})[{json.dumps(self.function_name)}];'
            'if(typeof f!=="function")return JSON.stringify({error:"fun not found"});'
            'var r=f.apply(null,' + json.dumps(args or []) + ');'
            'return JSON.stringify({result:r});'
            '}catch(e){return JSON.stringify({error:String(e&&e.message||e)});}})()'
        )
        res = run_js(script)
        if isinstance(res, dict) and res.get('error'):
            raise RuntimeError(f'js call failed: {res["error"]}')
        return res.get('result') if isinstance(res, dict) else res

    def close(self):
        self._loaded = False


def install():
    """Подменяет NodeRunner в pytubefix. Вызывать до первого резолва стрима."""
    try:
        from pytubefix.sig_nsig import node_runner as _nr
        from pytubefix import cipher as _cipher
        _nr.NodeRunner = WebViewNodeRunner
        _cipher.NodeRunner = WebViewNodeRunner
        return True
    except Exception:
        return False
