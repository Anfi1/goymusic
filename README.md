# GoyMusic

Desktop YouTube Music player built with Electron + React + Python.

## Windows: самостоятельный Rust Deck 7.1.7-rust

Это отдельный тестовый плеер на Rust (`iced`, CPAL/WASAPI, FFmpeg), без Electron, WebView и автообновления. Распакуйте **весь ZIP** в новую папку и запустите `goymusic-native.exe`. Устанавливать его поверх обычного GoyMusic не нужно. Громкость, фон и Nyan Cat сохраняются отдельно: `%LOCALAPPDATA%\GoyMusic-Native-Preview\appearance.json`.

- **Open files** (`Ctrl+O`), перетаскивание файлов или пути в командной строке — локальное воспроизведение. Для обложки положите рядом с аудиофайлом одноимённое изображение или `cover.jpg`.
- **Ctrl+F** — поиск в гостевом каталоге. Плюс добавляет результат в очередь. Можно также вставить **прямую HTTPS-ссылку на аудио** вместо поискового запроса. Гостевой доступ к потоку зависит от провайдера; Deck не читает cookies установленного плеера.
- **Пробел** — пауза, **← / →** — перемотка на 5 секунд, **Ctrl+← / →** — предыдущий/следующий трек. Есть системное управление воспроизведением Windows.

Это один рабочий экран для сравнения с Deck в стабильной версии, а не перенос аккаунтов, библиотеки или эквалайзера. Чтобы сравнить нагрузку, используйте один файл, размер окна и состояние Nyan Cat; смотрите память и CPU всей группы процессов при паузе, воспроизведении и сворачивании.

## Features

- YouTube Music streaming with account authentication
- Crossfade playback with dual audio engine
- Live spectrum and EQ response, with built-in Flat, Bass Boost, Rock, Vocal Focus and Warm presets. Saved presets remain separate from the built-ins.
- Discord Rich Presence integration
- Playlist management, liked songs, history
- Lyrics view
- Search with suggestions
- Deck desktop layout: centered playback controls, full-width seek bar, and optional Nyan Cat on the progress bar. Switch in **Settings → Appearance → new Experement Layout** without restarting. Right-click the current track for track actions.
- In Deck, **Settings → Appearance → Playback time** offers **Right side** (always visible) or **At cursor** (only while using the seek bar). Both preview the pointed time without seeking until you press or drag. **Transition speed** includes Ultra fast (120 ms); reduced motion takes precedence. **Dimming** changes surfaces and text together.
- **Settings → Appearance → Sidebar font size** changes the text of the expanded Deck sidebar. **Match queue heading** uses the larger font without changing button height or the queue.
- **Settings → Accessibility → Interface scale** changes text, artwork and controls together (100%, 110%, 125% or 150%). The setting is saved for both layouts and works in full screen.

## Tech Stack

- **Frontend:** React, TypeScript, Vite, CSS Modules
- **Backend:** Python (ytmusicapi fork, yt-dlp, pytubefix)
- **Desktop:** Electron with custom frameless window

## Prerequisites

- Node.js 18+
- Python 3.13+ (bundled in `python/bin/` for builds)

## Development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build    # Compile TypeScript + Vite bundle
npm run pack     # Package as directory (no installer)
npm run dist     # Package as distributable zip
```

## Setup

On first launch, sign in with your Google account through the built-in auth window. Credentials are stored locally in `browser.json`.
