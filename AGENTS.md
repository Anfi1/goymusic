# GoyMusic — руководство для агентов

## Предпочтения

- **Поиск/исследование кода:** всегда запускай субагент (`task` с `subagent_type: "explore"` или `"general"`), а не ищи сам. Субагент обходит код глубже и возвращает структурированный результат, не засоряя чат.

Файл для ИИ-агентов, работающих с проектом. Читатель ничего не знает о проекте — описано всё необходимое для ориентации, сборки и внесения изменений.

> Дополнительный гид в том же репозитории: [`CLAUDE.md`](./CLAUDE.md). `AGENTS.md` фокусируется на фактах об архитектуре, сборке и конвенциях; `CLAUDE.md` — на карте ключевых модулей и текущей дорожной карте.

---

## 1. Обзор проекта

**GoyMusic** — десктопный плеер для YouTube Music с собственным аудио-движком, построенный на Electron + React + TypeScript + Python. Поддерживает аутентификацию Google, плейлисты, лайки, историю, поиск, радио, тексты песен, Discord Rich Presence, автообновление и SoundCloud-гибрид.

- **Название:** `goymusic`
- **Версия:** `6.5.2` (из [`package.json`](./package.json))
- **Репозиторий:** `https://github.com/Anfi1/goymusic.git`
- **Платформа:** Windows (NSIS-установщик)
- **Лицензия:** `ISC`

---

## 2. Стек технологий

### Frontend (renderer)
- **React** `^19.2.4` + **React DOM** `^19.2.4`
- **TypeScript** `^5.9.3`
- **Vite** `^7.3.1` + `@vitejs/plugin-react` + `vite-plugin-electron`
- **TanStack Query** `^5.90.21` — серверное состояние
- **React Virtuoso** `^4.18.1` — виртуализированные списки
- **lucide-react** `^0.575.0` — иконки
- **CSS Modules** + глобальные темы (`src/styles/theme.css`, `src/styles/base.css`)

### Desktop
- **Electron** `^40.6.0`
- **electron-builder** `^26.8.1` — упаковка и NSIS-установщик
- **electron-updater** `^6.8.3` — автообновление из GitHub Releases
- **discord-rpc** `^4.0.1` — интеграция с Discord

### Backend
- **Python 3.13+** — отдельный процесс `python/api.py`
- **ytmusicapi** — форк/адаптация в `python/fork/`
- **pytubefix** `10.3.8` — основной источник stream URL
- **yt-dlp** `2026.2.21` — fallback для stream URL
- **requests** `2.32.5`

### Тестирование
- **Vitest** `^3.2.4` (конфиг [`vitest.config.ts`](./vitest.config.ts))

---

## 3. Архитектура и поток данных

```
React (src/)
   │ window.bridge.pyCall('<cmd>', args)
   ▼
preload.ts  ──ipc 'py:call'──▶  electron/main.ts
                                  │ spawn + stdin/stdout JSON
                                  ▼
                           python/api.py (handle_request)
```

- Electron `main.ts` запускает **один** Python-процесс при старте.
- Связь — построчный JSON через stdin/stdout: `{ command, ..., callId }` → `{ callId, ... }` или `{ event }`.
- `preload.ts` через `contextBridge` открывает типизированный API `window.bridge`.
- Аудио играет в renderer через HTML5 `<audio>` с двойным буфером (A/B) + Web Audio API (нормализация, 6-полосный эквалайзер, анализатор).
- Stream URL получаются из Python (`get_stream_url`), кэшируются в IndexedDB.

### Ключевые точки входа
| Роль | Файл |
|---|---|
| Renderer entry | [`index.html`](./index.html) → [`src/main.tsx`](./src/main.tsx) |
| Корневой компонент | [`src/App.tsx`](./src/App.tsx) |
| Electron main | [`electron/main.ts`](./electron/main.ts) |
| Preload | [`electron/preload.ts`](./electron/preload.ts) |
| Python backend | [`python/api.py`](./python/api.py) |

---

## 4. Структура кода

### `src/` — приложение
- `src/api/` — бизнес-логика и мосты к Python:
  - `yt.ts` — обёртки над YouTube Music API
  - `player.ts` — `PlayerStore`: очередь, воспроизведение, A/B audio, EQ, нормализация, радио, RPC
  - `stream.ts` — получение и prefetch stream URL
  - `cache.ts` — IndexedDB-кэш stream URL
  - `soundcloud.ts` — SoundCloud API и смешивание треков
  - `history.ts`, `historyManager.ts`, `likedStore.ts`, `likedManager.ts`, `scLikedManager.ts` — хранилища
  - `playbackAccumulator.ts`, `source.ts`, `trackLink.ts`, `localOverrides.ts` — утилиты
  - `*.test.ts` — тесты Vitest
- `src/components/` — атомарный дизайн:
  - `atoms/` — базовые элементы (кнопки, иконки, скелетоны, тосты, визуализатор)
  - `molecules/` — составные элементы (TrackRow, QueueItem, MediaCard, ContextMenu, диалоги)
  - `organisms/` — страницы и крупные блоки (Sidebar, PlayerBar, QueuePanel, HomeView, SearchView, ArtistView, SettingsView, MainView, MyWaveView, RadioView, HistoryView, NewReleasesView, LyricsView)
  - `templates/` — `AppLayout`
- `src/hooks/` — `useLibrary`, `usePlaylist`, `useQueue`, `useTrackMenu`
- `src/styles/` — `theme.css`, `base.css`
- `src/types.ts` — `ViewType`, `ActiveView`

### `electron/` — главный процесс
- `main.ts` — окно, spawn Python, IPC, Discord RPC, автообновление, SoundCloud webview, deep links, управление папкой `songs`
- `preload.ts` — безопасный API для renderer

### `python/` — бэкенд
- `api.py` — JSON-RPC-диспетчер (~60 команд: поиск, стримы, плейлисты, лайки, история, SoundCloud, импорт)
- `fork/` — форк `ytmusicapi` и вендорные зависимости
- `bin/` — встроенная portable Python (не в git)
- `requirements.txt` — runtime-зависимости

### `api/` — Vercel serverless
- `share.js` — лендинг для шеринга треков/альбомов с OpenGraph
- `vercel.json` — rewrite `/track/*` и `/album/*` → `/api/share`

### `mockups/`, `conductor/`, `.superpowers/`
- `mockups/` — UI-прототипы, не входят в сборку
- `conductor/` — локальные планировочные документы (в `.gitignore`, не коммитить)

---

## 5. Команды сборки и разработки

```bash
# Установка зависимостей
npm install

# Режим разработки (Vite dev + Electron)
npm run dev

# Сборка: TypeScript + Vite bundle → dist/ + dist-electron/
npm run build

# Упаковка без установщика
npm run pack

# Сборка установщика NSIS (release/)
npm run dist

# Предпросмотр production-бандла
npm run preview
```

### Python-окружение
- Зависимости: [`python/requirements.txt`](./python/requirements.txt)
- Локальный venv: `venv/`
- При старте Electron ищет интерпретатор в порядке: `python/bin/python.exe` → `venv/Scripts/python.exe` → системный `python`/`python3`/`py`
- Для embedded Python в CI скачивается `python-3.13.2-embed-amd64.zip` в `python/bin/`

---

## 6. Инструкции по тестированию

```bash
# Один прогон
npm test

# Watch-режим
npm run test:watch
```

- Тесты располагаются в `src/**/*.test.ts`.
- Среда: `node`.
- Актуальные тесты:
  - `src/api/playbackAccumulator.test.ts`
  - `src/api/soundcloud.test.ts`
  - `src/api/source.test.ts`
- Автоматическое покрытие **не требуется** по правилам проекта; приоритет — ручная проверка через `npm run dev`/`npm run dist`.

---

## 7. Конвенции и стиль кода

### Общие правила
- Комментарии — только для нетривиальной логики; язык комментариев и документации — преимущественно **русский**.
- Новый код должен повторять стиль окружающих файлов.
- Компоненты размещаются по атомарной структуре: `atoms/`, `molecules/`, `organisms/`, `templates/`.
- Пути: алиас `@/` указывает на `src/`.

### TypeScript
- Строгий режим включён (`strict: true`).
- JSX-трансформация: `react-jsx`.
- Модули: `ESNext`, `Node`-разрешение.
- `any` встречается в IPC/бридж-коде; избегать в новом бизнес-коде.

### Python
- Python-стиль прагматичный; важнее надёжность и соответствие окружающему коду `python/api.py`.

### UI
- Тёмная "стеклянная" тема: фон `#09090f`, акцент `#89b4fa`.
- Иконки — `lucide-react`; для брендовых иконок (YouTube, SoundCloud) добавлять SVG в `src/assets`.
- Минимальные размеры окна: `1024×700`.
- **DRY для стилей:** никогда не дублировать CSS. Общие компоненты (бейджи, чипы, тултипы) — в `src/styles/badges.css`. Цвета, прозрачность, блюр — через CSS-переменные из `src/styles/theme.css`. Один визуальный паттерн = один источник правды.
- **DRY для логики:** если код повторяется ≥2 раза — выноси в hook/util. Не копируй бизнес-логику между компонентами.
- **className vs style:** глобальные классы (`pro-badge`, `global-tooltip`) — только `className`. Inline `style` — только для динамических значений (переменные цвета, размеры из пропсов). Не смешивай `className` и `style` для одного и того же элемента, если стили можно вынести в CSS.
- **CSS-переменные:** перед хардкодом цветов, прозрачности, блюра — проверяй `src/styles/theme.css`. Используй или создавай CSS-переменные (`--glass-surface`, `--glass-popover-bg`, `--glass-blur` и т.д.) для повторного использования. Не дублируй `rgba(...)` и `backdrop-filter` в разных файлах.
- **При изменении визуала** — загружай и используй скиллы `ui-ux-pro-max` и `frontend-design`.

### Git
- Фичи делаются в ветках, не лить в `main` нерабочий код.
- `main` собирается GitHub Actions и публикуется в Releases.

---

## 8. Безопасность и приватность

### Аутентификация
- Учётные данные Google сохраняются локально в `{userData}/browser.json`.
- SoundCloud-токен хранится в сессии `persist:soundcloud`.
- OAuth и куки собираются через изолированное sandboxed-окно (`auth:start`), User-Agent маскируется под Chrome.

### CORS и сетевые заголовки
- В `main.ts` для доменов `googleusercontent.com`, `ggpht.com`, `googlevideo.com` принудительно выставляются `Referer`/`Origin` YouTube Music и CORS-заголовки в ответах.
- `webSecurity: false` в renderer используется для воспроизведения стримов.

### SoundCloud и DataDome
- Для обхода защиты DataDome при лайках SoundCloud используется webview с реальным Chromium-контекстом: согласованный UA, client-hints, stealth-патч `navigator` через CDP.
- В `sc:write` лайк выполняется внутри страницы `soundcloud.com`, чтобы несли действительные DataDome-куки.

### Локальные данные
- `{userData}/window-config.json` — границы окна и путь к папке `songs`.
- `{userData}/browser.json` — куки/заголовки Google.
- `app.log` — логи приложения рядом с исполняемым файлом (packaged) или в cwd (dev).

---

## 9. Деплой и CI/CD

### GitHub Actions
- Файл: [`.github/workflows/release.yml`](./.github/workflows/release.yml)
- Триггер: push в `main`.
- Runner: `windows-latest`.
- Шаги:
  1. Определение версии: если `package.json` совпадает с последним тегом, patch-версия автоматически бампается.
  2. Скачивание и настройка embedded Python 3.13 в `python/bin/`.
  3. `npm ci` → `npm run build` → `npx electron-builder --publish always`.
  4. Публикация в GitHub Releases.
  5. Commit и push bumped версии + тег.

### electron-builder
- Конфигурация в [`package.json`](./package.json) → секция `build`.
- Выход: `release/`.
- Артефакты: `GoyMusic-Setup-${version}.exe`, zip.
- `extraResources` включает `python/` в сборку (исключая `__pycache__` и `test_moods.py`).

### Автообновление
- `electron-updater` проверяет GitHub Releases.
- Ручная проверка/загрузка/установка через IPC-хендлеры `update:check`, `update:download`, `update:install`.

### Vercel
- Лендинг шеринга деплоится из `api/share.js` через `vercel.json`.

---

## 10. Полезные замечания для агентов

- **Миграция на `youtubei.js` заархивирована** (ветка `archive`). В `main` бэкенд остаётся на Python; не менять без явной просьбы.
- **Архитектура без React Router:** навигация реализована через состояние `ActiveView` в `App.tsx`.
- **Аудио-движок:** всё воспроизведение в `src/api/player.ts`; UI только подписывается на состояние.
- **Папка `songs/`** используется для локальных файлов и скачанных треков; путь настраивается в настройках.
- **Deep links:** протокол `goymusic://`. В dev не регистрируется (`setAsDefaultProtocolClient` только в packaged); тестировать через `npm run dist`.
- **Память:** в `main.ts` включены флаги оптимизации Chromium и периодическая очистка кэша/GC каждые 5 минут.

---

## Быстрый старт для агента

```bash
npm install
npm run dev          # разработка
npm test             # тесты
npm run dist         # финальный установщик
```

При изменениях соблюдать атомарную структуру компонентов, сохранять русскоязычные комментарии для сложной логики и не коммитить `conductor/` или `mockups/`.
