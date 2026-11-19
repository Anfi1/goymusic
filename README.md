# GoyMusic

Desktop YouTube Music player built with Electron + React + Python.

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

`python/api.py` is the shared entry point: desktop sends newline-delimited JSON on stdin/stdout; Android calls the same dispatcher through `python/mobile_host.py`. `COMMANDS` maps the wire command names to handlers. Catalog, library, discovery, history, lyrics, local media, imports, Yandex and SoundCloud live in `python/backend/`. Handlers receive a `CommandContext`: return results or progress with `ctx.emit(...)` so replies keep the request ID and respect cancellation. The desktop visuals and storage format are unchanged in 7.1.8.

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
