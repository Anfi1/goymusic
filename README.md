# GoyMusic

Desktop YouTube Music player built with Electron + React + Python.

## Features

- YouTube Music streaming with account authentication
- Crossfade playback with dual audio engine
- Equalizer and audio normalization (Web Audio API)
- Discord Rich Presence integration
- Playlist management, liked songs, history
- Lyrics view
- Search with suggestions
- Compact desktop layout with an icon rail, slim queue and single-row player. Toggle **Settings → Appearance → new Experement Layout** without restarting. Classic remains the default; upgrading from 7.1.0 keeps your choice.

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
