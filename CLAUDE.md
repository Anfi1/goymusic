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

- Renderer вызывает Python: `window.bridge.pyCall('<command>', args)`; диспетчер команд — `handle_request` в `python/api.py` (≈стр. 518+).
- Аудио играет **HTML5 `<audio>`** с двойной буферизацией и Web Audio (нормализация, 6-полосный EQ): `src/api/player.ts`. Поток — stream URL от `get_stream_url` (pytubefix → fallback yt-dlp).

## Ключевые модули

| Что | Файл |
|---|---|
| Тип трека `YTMTrack` / `YTMArtist` | `src/api/yt.ts` |
| API-обёртки renderer→python | `src/api/yt.ts` |
| Плеер (очередь, воспроизведение, EQ, радио) | `src/api/player.ts` |
| Кэш stream URL (IndexedDB, TTL) | `src/api/cache.ts` |
| История прослушивания (IndexedDB) | `src/api/history.ts`, `src/api/historyManager.ts` |
| Python: поиск, стрим, рекомендации, история, SoundCloud (`search_alternatives`) | `python/api.py` |

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
- Новый код — в стиле окружающих файлов; компоненты по atomic-структуре (`atoms`/`molecules`/`organisms`).
- Деплой идёт через GitHub Actions — **в `main` не вливать нерабочее**; фичи через ветки, мердж после стабилизации.

## Текущая работа

Эпик **SoundCloud-гибрид + «Моя волна»** — ветка `feature/soundcloud-hybrid`.
Roadmap: [docs/superpowers/plans/2026-06-26-sc-hybrid-mywave-roadmap.md](docs/superpowers/plans/2026-06-26-sc-hybrid-mywave-roadmap.md).
