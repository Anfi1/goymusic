# GoyMusic Mobile (Android)

Android-сборка поверх **того же UI**, что и десктоп: `mobile/` не копирует компоненты,
а импортирует их из `../src`. Десктопные исходники при этом не меняются вообще.

## Как это работает

Десктопный рендерер общается с Python-бэкендом ровно через одну точку —
`window.bridge.pyCall(command, args)`. На Android Python нет, поэтому мобильная
точка входа подменяет `window.bridge` JS-реализацией тех же команд:

```
React (../src) ──window.bridge.pyCall──▶ mobile/src/bridge ──CapacitorHttp──▶ api.music.yandex.net
```

`CapacitorHttp` — нативный HTTP Capacitor'а, он ходит мимо WebView и поэтому не
упирается в CORS (а упереться есть во что, см. ниже).

## Ограничения, выясненные на живом API

- **CDN Яндекса враждебен к CORS.** Тот же mp3-линк отдаёт `206` без заголовка
  `Origin` и `403` — с ним, а `Access-Control-Allow-Origin` не шлёт никогда.
  Значит `fetch` за аудио из WebView невозможен, а `<audio src>` работает
  (media-элемент без `crossOrigin` не отправляет `Origin`).
- **Из-за этого Web Audio на мобиле отключён.** `createMediaElementSource` на
  cross-origin потоке даёт тишину. Точка входа удаляет `window.AudioContext`
  до старта приложения — плеер ловит исключение в `initAudioContext` (там уже
  есть try/catch) и играет обычным `<audio>`. Цена: нет эквалайзера.
- **YouTube и SoundCloud в APK не работают.** Их резолв стрима держится на
  Python (pytubefix/yt-dlp, PO-токены, nodriver для лайков SC) — в браузерном
  JS этого нет. Мобильная сборка — клиент Yandex Music.

## Что проверено на живом API

Мобильный бэкенд гоняется в Node с подменой `CapacitorHttp` на `fetch`
(`mobile/tools/` не нужен — скрипт лежал в скретчпаде). Результат:

| Команда | Результат |
|---|---|
| `yandex_auth_status` | connected |
| `yandex_search` | оба артиста, `loudness` из r128 |
| `yandex_wave_stations` / `yandex_wave_tracks` | 4 станции, 10 треков, `batchId` |
| `yandex_new_releases` | 30 альбомов |
| `yandex_album_tracks` | тип SINGLE/EP/ALBUM, оба артиста |
| `yandex_playlists` / `yandex_liked_albums` / `yandex_liked_artists` | 2 / 21 / 78 |
| `yandex_artist` | top-5, 50 треков, альбомы, похожие, слушатели |
| `yandex_home_genres` / `yandex_genre_stations` | 24 жанра / 9 подстанций |
| `yandex_liked_tracks` | 1412 треков за 2.6 с, все с датой лайка |
| `get_lyrics` | LRC от Яндекса (нужна HMAC-подпись запроса) |
| `yandex_stream_url` | HTTP 206, реальные байты mp3 320 kbps |

## Требования к сборке

- JDK **21** (Gradle не понимает classfile 25 из свежих JBR)
- Android SDK: `platform-tools`, `platforms;android-35`, `build-tools;35.0.0`
- `mobile/android/local.properties` → `sdk.dir=C:/Users/.../android-sdk`
  (прямые слэши: в properties-файле `\U` ломает путь)

## Сборка

```bash
npm run mobile:build     # vite build в mobile/dist
npm run mobile:sync      # + npx cap sync android
npm run mobile:apk       # + gradlew assembleDebug
```

APK: `mobile/android/app/build/outputs/apk/debug/app-debug.apk`
