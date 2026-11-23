# GoyMusic

Desktop YouTube Music player built with Electron + React + Python.

## Features

- YouTube Music streaming with account authentication
- When a YouTube Music stream is unavailable, the player looks for another YouTube Music version before trying SoundCloud. It only likes the replacement after playback starts and only if the original was liked.
- YouTube Music Home keeps **Listen again** first and **Quick picks** second when both shelves are available. Other shelves keep their feed order.
- Shared YouTube videos can open the uploader's channel from the player. Channel profiles show uploaded videos, which play as audio; artist profiles keep their music catalog.
- On Yandex Music Home, clicking a song or its Play button starts that song and keeps the rest of the shelf in the queue, including tracks beyond the first 20 cards.
- Crossfade playback with dual audio engine
- Live spectrum and EQ response, with built-in Flat, Bass Boost, Rock, Vocal Focus and Warm presets. Saved presets remain separate from the built-ins.
- Discord Rich Presence integration
- Playlist management, liked songs, history. YouTube likes sync can resume after an interruption. If the last page arrives but the playlist header reports more tracks than YouTube returned, GoyMusic saves the tracks it received and keeps any previously cached likes missing from the response.
- Liked Songs keeps the YouTube Music order in date view. It places SoundCloud likes using their actual dates and available YouTube date hints. Existing cached tracks use the new order automatically.
- Opening Liked Songs checks the first YouTube page. If it is unchanged, the app reuses the last successful import for up to 15 minutes instead of downloading every page again.
- Lyrics view
- Search with suggestions
- Deck desktop layout: centered playback controls, full-width seek bar, and optional Nyan Cat on the progress bar. Switch in **Settings → Appearance → new Experement Layout** without restarting. Right-click the current track for track actions.
- In Deck, **Settings → Appearance → Playback time** offers **Right side** (always visible) or **At cursor** (only while using the seek bar). Both preview the pointed time without seeking until you press or drag. **Transition speed** includes Ultra fast (120 ms); reduced motion takes precedence. **Dimming** changes surfaces and text together.
- **Settings → Appearance → Sidebar buttons** and **Sidebar width** are independent in both layouts. Choose **Classic** buttons with **New** width for classic navigation rows in the adaptive sidebar.
- **Settings → Accessibility → Interface scale** changes text, artwork and controls together (100%, 110%, 125% or 150%). The setting is saved for both layouts and works in full screen.

## Tech Stack

- **Frontend:** React, TypeScript, Vite, CSS Modules
- **Backend:** Python (ytmusicapi fork, yt-dlp, pytubefix)
- **Desktop:** Electron with custom frameless window

`python/api.py` is the shared entry point: desktop sends newline-delimited JSON on stdin/stdout; Android calls the same dispatcher through `python/mobile_host.py`. `COMMANDS` maps the wire command names to handlers. Catalog, library, discovery, history, lyrics, local media, imports, Yandex and SoundCloud live in `python/backend/`. Handlers receive a `CommandContext`: return results or progress with `ctx.emit(...)` so replies keep the request ID and respect cancellation. The desktop visuals and storage format are unchanged in 7.1.8.

On Windows, launching GoyMusic again opens the existing player for that profile. Several entries in Task Manager are normal: Chromium runs the renderer, GPU and utilities separately, and Python runs the music backend. The installed shortcut and player windows use the same taskbar identity. During a silent update, the installer releases its launch lock before restarting the updated player.

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
