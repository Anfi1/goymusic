# GoyMusic — гид по проекту

Десктоп-плеер (Electron) поверх YouTube Music с собственным аудио-движком.
Источник данных — Python-бэкенд (`ytmusicapi` + `pytubefix`/`yt-dlp`), UI — React/TS.

## Стек

- **Electron main**: `electron/main.ts`, preload `electron/preload.ts` → `dist-electron/`
- **Renderer**: React + TypeScript + Vite, TanStack Query, React Virtuoso → `src/`, `index.html`
- **Backend**: Python `python/api.py` (один процесс, протокол stdin/stdout JSON-строками)
- **Сборка**: `tsc && vite build`, упаковка `electron-builder` (NSIS, Windows)

> Миграция бэкенда на `youtubei.js` **архивирована** (ветка `archive`) — в `main` стек остаётся на Python. Не трогать без явной просьбы.

## Команды

```bash
npm run dev      # Vite dev (renderer)
npm run build    # tsc + vite build
npm run pack     # build + electron-builder --dir (без инсталлятора)
npm run dist     # build + установщик
```

Python: зависимости в `requirements.txt`, venv в `venv/`. Electron при старте ищет интерпретатор: bundled `python.exe` → `venv` → системный `python3` (`electron/main.ts`).

## Архитектура и поток данных

```
React (src/) ──window.bridge.pyCall──▶ preload ──ipc 'py:call'──▶ main.ts
   ▲                                                                  │ spawn + stdin
   └────────── ipc 'py:event' / ответ ◀── pendingCalls ◀── stdout ◀── python/api.py
```

- Renderer вызывает Python: `window.bridge.pyCall('<command>', args)`; диспетчер команд — `handle_request` в `python/api.py` (≈стр. 1690+, ~60 команд).
- Аудио играет **HTML5 `<audio>`** с двойной буферизацией и Web Audio (нормализация, 6-полосный EQ): `src/api/player.ts`. Поток — stream URL от `get_stream_url` (быстрый путь pytubefix WEB_MUSIC → гонка клиентов yt-dlp).

### Нормализация громкости

Цель — **-14 LUFS** на обоих источниках, гейн `10^(-loudness/20)`.

- YouTube: `loudnessDb` из ответа плеера, но его шкала целится в **-7 LUFS**, поэтому в `extract_loudness` прибавляется `+7`. Поле `perceptualLoudnessDb` (= `loudnessDb - 7`) для этого не подходит — смещает в другую сторону.
- SoundCloud и YT-треки без `loudnessDb`: отдаём `loudness: null` сразу, замер идёт **фоном** командой `measure_loudness` (ffmpeg `loudnorm`, трек целиком), гейн применяется плавным рампом. Результат кэшируется в IndexedDB по id трека, без TTL — громкость свойство аудио, а не подписанной ссылки.
- Замерочный стенд: `python/test_loudness.py` (`--selfcheck` — офлайн).

## Ключевые модули

| Что | Файл |
|---|---|
| Тип трека `YTMTrack` / `YTMArtist` | `src/api/yt.ts` |
| API-обёртки renderer→python | `src/api/yt.ts` |
| Плеер (очередь, воспроизведение, EQ, радио) | `src/api/player.ts` |
| Кэш stream URL (IndexedDB, TTL) + громкость (без TTL) | `src/api/cache.ts` |
| Фоновый замер громкости | `src/api/stream.ts` (`ensureLoudness`) |
| История прослушивания (IndexedDB) | `src/api/history.ts`, `src/api/historyManager.ts` |
| Тексты песен (панель, synced/static) | `src/components/organisms/LyricsView.tsx` |
| Python: поиск, стрим, рекомендации, история, SoundCloud (`search_alternatives`) | `python/api.py` |

### Тексты песен (`get_lyrics`)

Четыре источника **параллельно**, побеждает первый с таймкодами (synced > plain > instrumental):

- **LRCLIB** — точный запрос по artist/title/duration + нечёткий поиск (`_pick_lrclib`).
- **YT Music** (`_ytmusic`) — `get_watch_playlist(videoId)` → `lyrics` browseId → `get_lyrics(..., timestamps=True)`. Под капотом Musixmatch, ищет по videoId, поэтому находит там, где текстовый поиск промахивается. Миллисекунды переводим в LRC-строки. ~1.3с.
- **NetEase** через `syncedlyrics` (только в сборке — в dev-venv пакета нет, провайдер молча пропускается).
- Фолбэки после пула: **Genius** (парсинг `data-lyrics-container`), затем **lyrics.ovh** — оба plain-only.

Трек без вокала — не ошибка: LRCLIB отдаёт `instrumental: true`, YT Music — строки из одних `♪`. Такой ответ уходит на фронт как `instrumental` и рисует отдельный экран.

Проверка: `python/test_lyrics.py` (`--selfcheck` — офлайн: формат LRC и приоритет источников).

### UI (компоненты)

- Оболочка/сайдбар: `src/components/organisms/Sidebar.tsx` (навигация — state, без react-router; `ActiveView` в `App.tsx`).
- Страницы: `HomeView.tsx`, `SearchView.tsx`, `ArtistView.tsx`, `MainView.tsx` (лайки = playlist `LM`), `SettingsView.tsx`.
- Плеер-бар: `PlayerBar.tsx`; очередь: `QueuePanel.tsx`.
- Строки/карточки: `src/components/molecules/TrackRow.tsx`, `QueueItem.tsx`.
- Иконки — `lucide-react` (брендовых YT/SC нет — добавлять SVG в `src/assets`).

## Хранилище состояния

- **localStorage** (`ytm-*`): громкость, shuffle/repeat, autoplay, очередь+индекс, last-track, EQ, флаги истории/RPC/нормализации — см. `src/api/player.ts`.
- **IndexedDB**: кэш стримов (`cache.ts`), история (`history.ts`).
- **Файл**: `{userData}/window-config.json` (границы окна, путь к songs) — `electron/main.ts`.
- **Auth**: `browser.json` (куки Google) + ytmusicapi oauth.

## Конвенции

- Комментарии — только для неочевидной логики, на языке диалога.
- Новый код — в стиле окружающих файлов; компоненты по atomic-структуре (`atoms`/`molecules`/`organisms`). Строки UI — английские.
- Деплой идёт через GitHub Actions — **в `main` не вливать нерабочее**; фичи через ветки, мердж после стабилизации.
- **`python/api.py` не открывается инструментом Read** (~4200 строк, превышает лимит токенов) — а значит и Edit по нему не работает. Читать `sed -n`, править скриптом с `ast.parse` после.

## Текущая работа

Эпик **SoundCloud-гибрид + «Моя волна»** влит в `main`: команды `sc_*` в `python/api.py`, UI — `src/components/organisms/MyWaveView.tsx`. Лайки SC идут через nodriver (`sc_like_nodriver`) — прямой api-v2 путь удалён, DataDome его резал.

Открытые планы: [docs/superpowers/plans/](docs/superpowers/plans/) — `2026-07-01-mywave-curate-mix.md`, `2026-07-09-sc-offline-likes-plan.md`.

## Релизы

Push в `main` запускает workflow `Build & Release`: версия = max(последний Release + 1 патч, `version` из `package.json`), на выходе NSIS-установщик в GitHub Releases. Текущая — **6.4.0**.
