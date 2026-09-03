# GoyMusic Mobile (Android)

Android-сборка с **полным функционалом десктопа**: внутри APK работает тот же
`python/api.py`, что и на ПК, а интерфейс — те же компоненты из `../src`.
Десктопные исходники при этом не менялись вообще.

## Как это работает

Десктоп общается с Python-бэкендом ровно через одну точку — `window.bridge.pyCall`,
и бэкенд — отдельный процесс, читающий JSON-строки из stdin. На Android процессов нет,
поэтому подменены только концы трубы:

```
React (../src) ──window.bridge.pyCall──▶ PythonBackendPlugin (Java)
                                              │ Chaquopy, тот же процесс
                                              ▼
                                        python/mobile_host.py
                                              │ подменяет sys.stdout
                                              ▼
                                        python/api.py  (без единой правки)
```

Ответы `api.py` пишет в stdout как обычно — `mobile_host` перехватывает их построчно и
отдаёт колбэком в Java, а сопоставление по `callId` делает JS. Поэтому доступны **все**
команды: YouTube, SoundCloud, Yandex, тексты, история, лайки.

### JS-рантайм вместо Node

YouTube отдаёт ссылки на аудио с зашифрованной подписью, расшифровать её можно только
выполнив кусок их же плеера на JavaScript. На десктопе для этого запускается бандленный
Node, но под Android он не собирается (`nodejs-wheel-binaries` уходит в CMake и падает).

Зато JS-движок в приложении уже есть — сам WebView. `python/js_bridge.py` подменяет
`pytubefix.NodeRunner` реализацией, которая гоняет тот же протокол load/call, но через
`WebView.evaluateJavascript`. Родной раннер тащит для этого jsdom, чтобы у кода плеера
были `window` и `document`; в WebView они настоящие, эмулировать нечего.

Проверено на живом YouTube: pytubefix WEB_MUSIC отдаёт itag 251 (opus 160 kbps), ссылка
рабочая (HTTP 206 с реальными байтами).

## Ограничения, выясненные на живом API

- **Web Audio выключен.** CDN Яндекса отдаёт mp3 с кодом `206` без заголовка `Origin`
  и `403` — с ним, а `Access-Control-Allow-Origin` не шлёт никогда. Значит
  `createMediaElementSource` дал бы тишину. Точка входа удаляет `window.AudioContext`
  (у `initAudioContext` уже есть try/catch) и глушит сеттер `audio.crossOrigin`.
  **Цена: нет эквалайзера и нормализации громкости.**
- **Лайки SoundCloud не работают.** На десктопе они идут через nodriver, которому нужен
  настоящий Chrome. Поиск и воспроизведение SoundCloud работают.
- **Фоновое воспроизведение не настраивалось.** WebView глушит звук при сворачивании;
  нужен foreground service — не делалось.

## Вход в аккаунты

- **Yandex** — тот же Device Flow, что на десктопе, целиком внутри `api.py`.
- **YouTube** — нативный WebView, из которого забираются куки: `ytmusicapi` выводит
  `SAPISIDHASH` из них сам (`fork/ytmusicapi/helpers.py`), поэтому перехватывать
  заголовки запроса, как это делает десктоп, не нужно.
  Google иногда блокирует вход во встроенных WebView. Запасной путь — перенести
  готовый `browser.json` с компьютера: в отладочной консоли приложения
  `goymusicImportAuth('<содержимое browser.json>')`.

## Требования к сборке

- **JDK 21** (Gradle не понимает classfile 25 из свежих JBR)
- Android SDK: `platform-tools`, `platforms;android-35`, `build-tools;35.0.0`
- Python 3.13 для `buildPython` Chaquopy
- `mobile/android/local.properties` → `sdk.dir=C:/Users/.../android-sdk`
  (прямые слэши: в properties-файле `\U` ломает путь)

## Грабли, на которые уже наступили

- **Вложенные `srcDirs` Chaquopy не переваривает.** `python` и `python/fork` дают
  конфликтующие пути в AssetFinder, импорт падает `FileNotFoundError: .../AssetFinder/python`.
  Поэтому форк `ytmusicapi` копируется в `mobile/pysrc` (`npm run pysrc`).
- **`sys.path.insert` внутри дерева Chaquopy ломает импорт.** `api.py` добавляет
  `<BASE>/python/fork`, а импорт-хук Chaquopy на таком пути падает. Проверить наличие
  каталога нельзя — `os.path.isdir` внутри AssetFinder отвечает `True` на что угодно,
  поэтому `mobile_host` запрещает вставки по префиксу.
- **`--no-deps` со списком зависимостей вручную.** Иначе pip тянет
  `nodejs-wheel-binaries` и падает на сборке Node.
- **Дедупликация общих библиотек обязательна.** `../src` резолвит импорты в КОРНЕВОЙ
  `node_modules`, а точка входа — в `mobile/node_modules`. Без `resolve.dedupe` в бандл
  попадают две копии react-query, и приложение падает с «No QueryClient set».
- **`modulePreload` и разбитый по чанкам CSS не работают** в WebView по схеме
  `https://localhost` — стили не доезжают, экран чёрный.

## Сборка

```bash
npm run mobile:build     # vite build в mobile/dist
npm run mobile:sync      # + копия ytmusicapi + npx cap sync android
npm run mobile:apk       # + gradlew assembleDebug
```

APK: `mobile/android/app/build/outputs/apk/debug/app-debug.apk` (~130 МБ: внутри
CPython 3.13, yt-dlp, pytubefix, ytmusicapi, yandex-music).
