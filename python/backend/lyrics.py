"""Lyrics lookup, provider matching and text normalization."""
import concurrent.futures
import html as html_lib
import re
import sys
import time

import requests


def _clean_genius_lyrics(text):
    """Убираем из текста Genius служебные вставки (Contributors, Voices, Embed и локализованные заголовки)."""
    # Genius склеивает шапку песни в одну строку без переносов:
    #   "5 ContributorsНазвание Lyrics[Текст песни «...»]" — построчный фильтр её не ловит.
    text = re.sub(r'^\s*\d*\s*Contributors?[^\n]*?\bLyrics\b', '', text, count=1, flags=re.IGNORECASE)
    # Локализованный маркер перевода в начале (не трогаем [Интро:], [Куплет:] и т.п.).
    text = re.sub(r'^\s*\[[^\]]*(?:Текст\s+песни|Lyrics\s+(?:for|of))[^\]]*\]', '', text, count=1, flags=re.IGNORECASE)
    # Хвостовой "…NNEmbed".
    text = re.sub(r'\d*Embed\s*$', '', text)
    # Разбиваем на строки, фильтруем мусор, собираем обратно.
    lines = text.split('\n')
    cleaned = []
    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        # Пропускаем явный мусор Genius
        if re.match(r'^\d+\s*Contributor(s)?$', stripped, re.IGNORECASE):
            continue
        if re.match(r'^Contributor(s)?$', stripped, re.IGNORECASE):
            continue
        if re.match(r'^Voices$', stripped, re.IGNORECASE):
            continue
        if re.match(r'^Translations?$', stripped, re.IGNORECASE):
            continue
        if re.match(r'^Lyrics$', stripped, re.IGNORECASE):
            continue
        if re.match(r'^Embed$', stripped, re.IGNORECASE):
            continue
        if re.match(r'^You might also like$', stripped, re.IGNORECASE):
            continue
        # Локализованные заголовки типа [Текс песни "..."] / [Текст песни "..."] / [Lyrics for "..."]
        if re.match(r'^(\[)?\s*(Текс|Текст)\s+песни\s+["\u201c\u201e].*["\u201d\u201f]\s*\]?$', stripped, re.IGNORECASE):
            continue
        if re.match(r'^(\[)?\s*Lyrics\s+(for|of)\s+["\u201c\u201e].*["\u201d\u201f]\s*\]?$', stripped, re.IGNORECASE):
            continue
        cleaned.append(line)
    # Убираем хвостовой "Embed", если остался на последней строке
    if cleaned and re.match(r'^Embed\s*$', cleaned[-1].strip(), re.IGNORECASE):
        cleaned.pop()
    return '\n'.join(cleaned).strip()


def _clean_artist(artist):
    """Убираем мусорные значения артиста, чтобы не отравлять поиск лириксов."""
    if not artist:
        return ''
    a = str(artist).strip()
    if a.lower() in ('unknown', 'various artists', 'va', 'topic'):
        return ''
    a = re.sub(r'\s*-\s*topic\s*$', '', a, flags=re.IGNORECASE)
    return a.strip()


def _normalize_lyric_title(title):
    """Нормализуем название: убираем (feat…), (Official Video), [Explicit], prod. и т.п."""
    if not title:
        return ''
    t = str(title)
    t = re.sub(r'\s*[\(\[][^\)\]]*(feat\.?|ft\.?|official|lyric|audio|video|visualizer|prod\.?|remaster|explicit|clean|slowed|sped\s*up)[^\)\]]*[\)\]]', '', t, flags=re.IGNORECASE)
    t = re.sub(r'\s*(feat\.?|ft\.?)\s+.*$', '', t, flags=re.IGNORECASE)
    t = re.sub(r'\s*-\s*(topic|official.*|lyric.*|audio|video)\s*$', '', t, flags=re.IGNORECASE)
    t = re.sub(r'\s{2,}', ' ', t).strip(' -–—')
    return t or str(title).strip()


def _pick_lrclib(candidates, title, artist, duration):
    """Лучший результат из LRCLIB /api/search (нечёткий, терпим к неточному artist)."""
    from difflib import SequenceMatcher
    if not candidates:
        return None
    def score(c):
        s = SequenceMatcher(None, (c.get('trackName') or '').lower(), (title or '').lower()).ratio() * 2
        if artist:
            s += SequenceMatcher(None, (c.get('artistName') or '').lower(), artist.lower()).ratio()
        if duration and c.get('duration'):
            try:
                if abs(float(c['duration']) - float(duration)) <= 3:
                    s += 1
            except (TypeError, ValueError):
                pass
        if c.get('syncedLyrics'):
            s += 0.5
        return s
    best = max(candidates, key=score)
    # Отсекаем совсем непохожие (защита от мусора при поиске только по названию).
    if SequenceMatcher(None, (best.get('trackName') or '').lower(), (title or '').lower()).ratio() < 0.5:
        return None
    return best


def fetch_genius_lyrics(artist, title, is_cancelled=None):
    def _cancelled():
        return bool(is_cancelled and is_cancelled())

    if _cancelled():
        return None
    try:
        # 1. Ищем URL именно ПЕСНИ (не страницы артиста), пробуя несколько запросов.
        headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"}

        # Сопоставляем найденную песню с нашим названием: фаззи-похожесть (работает и
        # для кириллицы) ИЛИ общий латинский токен (транслит/латиница в скобках, "Wannablood").
        from difflib import SequenceMatcher
        def _norm_t(s):
            return re.sub(r'[^0-9a-zа-яёÀ-ɏ]+', ' ', (s or '').lower()).strip()
        def _matches(cand):
            c, o = _norm_t(cand), _norm_t(title)
            if not c or not o:
                return False
            if SequenceMatcher(None, c, o).ratio() >= 0.55:
                return True
            ctok = set(re.findall(r'[0-9a-z]{4,}', c))
            otok = set(re.findall(r'[0-9a-z]{4,}', o))
            return bool(ctok & otok)

        def _song_url(query):
            query = (query or '').strip()
            if not query:
                return None
            try:
                r = requests.get("https://genius.com/api/search/multi",
                                 params={"q": query}, headers=headers, timeout=5)
                if r.status_code != 200:
                    return None
                for section in r.json().get("response", {}).get("sections", []):
                    if section.get("type") not in ("top_hit", "song"):
                        continue
                    for hit in section.get("hits", []):
                        res = hit.get("result", {})
                        u = res.get("url", "")
                        # Только песня (не артист) И только если название совпадает с нашим —
                        # так находим верный трек, даже если он не первый в выдаче.
                        if res.get("_type") != "song" or "/artists/" in u:
                            continue
                        if _matches(res.get("title") or res.get("full_title") or ""):
                            return u
            except:
                pass
            return None

        # Несколько запросов: у не-английских треков полезно искать и по латинскому
        # названию в скобках ("Кровопийца (Wannablood)" → "Wannablood").
        a = (artist or '').strip()
        queries = []
        if a:
            queries.append(f"{a} {title}")
        m = re.search(r'\(([^)]+)\)', title or '')
        if m:
            paren = m.group(1).strip()
            base = re.sub(r'\([^)]*\)', '', title or '').strip()
            if a and paren:
                queries.append(f"{a} {paren}")
            if a and base:
                queries.append(f"{a} {base}")
            if paren:
                queries.append(paren)
        queries.append(title or '')

        song_url = None
        seen_q = set()
        for q in queries:
            if _cancelled():
                return None
            q = (q or '').strip()
            if not q or q in seen_q:
                continue
            seen_q.add(q)
            song_url = _song_url(q)
            if song_url:
                break

        if not song_url or _cancelled():
            return None

        # 2. Fetch the page and extract ALL containers
        r = requests.get(song_url, headers=headers, timeout=5)
        if _cancelled() or r.status_code != 200:
            return None
        html_text = r.text
        
        # We find all starts of lyrics containers
        marker = 'data-lyrics-container="true"'
        parts = []
        
        for match in re.finditer(marker, html_text):
            # For each match, find the matching closing </div>
            # We start from the '<div' just before the marker
            start_search = html_text.rfind('<div', 0, match.start())
            if start_search == -1: continue
            
            # Simple balancing
            pos = start_search + 4
            depth = 1
            while depth > 0:
                next_open = html_text.find('<div', pos)
                next_close = html_text.find('</div>', pos)
                
                if next_close == -1: break # Should not happen
                
                if next_open != -1 and next_open < next_close:
                    depth += 1
                    pos = next_open + 4
                else:
                    depth -= 1
                    pos = next_close + 6
            
            # Extract content and remove the outer div
            container = html_text[start_search:pos]
            content = re.sub(r'^<div[^>]*>', '', container)
            content = re.sub(r'</div>$', '', content)
            # Предварительно отсеиваем контейнеры, в которых только мусор
            plain_preview = re.sub(r'<.*?>', '', content).strip()
            if plain_preview and not re.match(r'^(\d+\s*Contributor(s)?|Contributor(s)?|Voices|Translations?|Lyrics|Embed)$', plain_preview, re.IGNORECASE):
                parts.append(content)
            
        if not parts:
            # Last resort fallback for old Genius layout
            parts = re.findall(r'<div class="lyrics">(.*?)</div>', html_text, re.DOTALL)
            
        if not parts: return None
        
        # 3. Join, clean and unescape
        full_lyrics = "\n".join(parts)
        full_lyrics = re.sub(r'<br\s*/?>', '\n', full_lyrics)
        full_lyrics = re.sub(r'<.*?>', '', full_lyrics)
        full_lyrics = _clean_genius_lyrics(html_lib.unescape(full_lyrics))
        
        if not full_lyrics: return None
        return {"plainLyrics": full_lyrics, "syncedLyrics": None}
    except:
        return None


def fetch_lyrics_ovh(artist, title):
    """Простой фолбек-источник lyrics.ovh."""
    try:
        url = f"https://api.lyrics.ovh/v1/{requests.utils.quote(artist)}/{requests.utils.quote(title)}"
        r = requests.get(url, timeout=6)
        if r.status_code != 200: return None
        data = r.json()
        lyrics = data.get('lyrics')
        if not lyrics: return None
        return {"plainLyrics": lyrics.strip(), "syncedLyrics": None}
    except:
        return None


def get_lyrics(request, ctx):
    def _cancelled():
        return bool(ctx.is_cancelled and ctx.is_cancelled())

    def _emit_cancelled():
        ctx.emit({'status': 'error', 'message': 'Cancelled by client'})

    if _cancelled():
        _emit_cancelled()
        return

    artist = _clean_artist(request.get('artist'))
    title = _normalize_lyric_title(request.get('title'))
    duration = request.get('duration')
    video_id = request.get('videoId')

    def _lrclib_exact():
        if _cancelled() or not (artist and title):
            return None
        try:
            params = {'artist_name': artist, 'track_name': title}
            if duration: params['duration'] = int(duration)
            r = requests.get('https://lrclib.net/api/get', params=params, timeout=5)
            if r.status_code == 200:
                d = r.json()
                if d.get('plainLyrics') or d.get('syncedLyrics'):
                    return {'plainLyrics': d.get('plainLyrics'), 'syncedLyrics': d.get('syncedLyrics'), 'source': 'lrclib'}
                # У трека без вокала lrclib отдает instrumental: true и пустые поля.
                # Это не "не нашли", а "текста нет" -- в UI это разные экраны.
                if d.get('instrumental'):
                    return {'instrumental': True, 'source': 'lrclib'}
        except: pass
        return None

    def _lrclib_search():
        if _cancelled() or not title:
            return None
        try:
            q = f"{artist} {title}".strip() if artist else title
            sr = requests.get('https://lrclib.net/api/search', params={'q': q}, timeout=5)
            if sr.status_code == 200:
                best = _pick_lrclib(sr.json() or [], title, artist, duration)
                if best and (best.get('plainLyrics') or best.get('syncedLyrics')):
                    return {'plainLyrics': best.get('plainLyrics'), 'syncedLyrics': best.get('syncedLyrics'), 'source': 'lrclib'}
        except: pass
        return None

    def _netease():
        if _cancelled() or not title:
            return None
        try:
            import syncedlyrics
            q = f"{artist} {title}".strip() if artist else title
            lrc = syncedlyrics.search(q, providers=["NetEase"], synced_only=False)
            if lrc:
                lines = lrc.strip().split('\n')
                synced_lines = [l for l in lines if l.startswith('[') and ':' in l and ']' in l]
                plain_lines = [l.split(']', 1)[1].strip() for l in lines if l.startswith('[') and ']' in l and l.split(']', 1)[1].strip()]
                has_synced = len(synced_lines) > 2
                return {
                    'plainLyrics': '\n'.join(plain_lines) if plain_lines else None,
                    'syncedLyrics': lrc if has_synced else None,
                    'source': 'netease'
                }
        except: pass
        return None

    def _ytmusic():
        """Тексты самого YT Music (Musixmatch) -- часто с таймкодами там, где lrclib пуст.
                browseId лежит в watch-плейлисте трека, отдельный поиск не нужен."""
        if _cancelled() or not video_id:
            return None
        try:
            yt = ctx.get_api()
            browse_id = (yt.get_watch_playlist(videoId=video_id, limit=1) or {}).get('lyrics')
            if not browse_id or _cancelled():
                return None
            ly = yt.get_lyrics(browse_id, timestamps=True)
            if not ly:
                return None
            if not ly.get('hasTimestamps'):
                text = (ly.get('lyrics') or '').strip()
                return {'plainLyrics': text, 'syncedLyrics': None, 'source': 'ytmusic'} if text else None
            lines = ly.get('lyrics') or []
            plain = [l.text for l in lines if l.text.strip() and l.text.strip() != '♪']
            if not plain:
                return {'instrumental': True, 'source': 'ytmusic'}
            lrc = '\n'.join(
                f'[{l.start_time // 60000:02d}:{l.start_time // 1000 % 60:02d}.{l.start_time % 1000 // 10:02d}]{l.text}'
                for l in lines)
            return {'plainLyrics': '\n'.join(plain), 'syncedLyrics': lrc, 'source': 'ytmusic'}
        except: pass
        return None

    # Для трека из Яндекса сначала спрашиваем сам Яндекс: он ищет по id трека,
    # а не по строке "артист - название", и отдает готовый LRC с таймкодами.
    yandex_id = request.get('yandexId')
    if yandex_id:
        if _cancelled():
            _emit_cancelled()
            return
        try:
            yclient = ctx.get_yandex_client()
            if yclient and not _cancelled():
                info = yclient.tracks_lyrics(str(yandex_id), format_='LRC')
                link = getattr(info, 'download_url', None) if info else None
                if link and not _cancelled():
                    lrc = requests.get(link, timeout=8).text.strip()
                    if _cancelled():
                        _emit_cancelled()
                        return
                    if lrc:
                        plain = '\n'.join(
                            re.sub(r'^\[\d+:\d+(?:\.\d+)?\]\s*', '', line).strip()
                            for line in lrc.splitlines()
                        ).strip()
                        ctx.emit({
                            'status': 'ok',
                            'plainLyrics': plain or None,
                            'syncedLyrics': lrc,
                            'source': 'yandex',
                        })
                        return
        except Exception as e:
            print(f"[lyrics] yandex source failed: {e}", file=sys.stderr)
        if _cancelled():
            _emit_cancelled()
            return

    # LRCLIB (точный + поиск), NetEase и YT Music -- параллельно.
    # Не используем context manager, чтобы shutdown(wait=False) не ждал зависшие источники
    # после отмены запроса или получения synced-текста.
    result = None
    cancelled = False
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=4)
    try:
        pending = {
            pool.submit(_lrclib_exact),
            pool.submit(_lrclib_search),
            pool.submit(_netease),
            pool.submit(_ytmusic),
        }
        deadline = time.monotonic() + 15.0
        while pending:
            if _cancelled():
                cancelled = True
                break
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            done, pending = concurrent.futures.wait(
                pending,
                timeout=min(0.2, remaining),
                return_when=concurrent.futures.FIRST_COMPLETED,
            )
            if _cancelled():
                cancelled = True
                break
            got_synced = False
            for future in done:
                try:
                    r = future.result(timeout=0)
                except Exception:
                    continue
                if not r:
                    continue
                # Приоритет: synced > plain > instrumental
                if r.get('syncedLyrics'):
                    result = r
                    got_synced = True
                    break
                if result is None or (result.get('instrumental') and r.get('plainLyrics')):
                    result = r
            if got_synced:
                break
    finally:
        pool.shutdown(wait=False, cancel_futures=True)

    if cancelled or _cancelled():
        _emit_cancelled()
        return

    if result and not result.get('instrumental'):
        ctx.emit({'status': 'ok', **result})
        return

    if _cancelled():
        _emit_cancelled()
        return

    # Фолбэк: Genius (plain only).
    genius = fetch_genius_lyrics(artist, title, is_cancelled=_cancelled)
    if _cancelled():
        _emit_cancelled()
        return
    if genius:
        ctx.emit({
            'status': 'ok',
            'plainLyrics': genius['plainLyrics'],
            'syncedLyrics': None,
            'source': 'genius',
        })
        return

    # Фолбэк: lyrics.ovh (plain only).
    if artist:
        if _cancelled():
            _emit_cancelled()
            return
        ovh = fetch_lyrics_ovh(artist, title)
        if _cancelled():
            _emit_cancelled()
            return
        if ovh:
            ctx.emit({
                'status': 'ok',
                'plainLyrics': ovh['plainLyrics'],
                'syncedLyrics': None,
                'source': 'lyrics.ovh',
            })
            return

    if _cancelled():
        _emit_cancelled()
        return

    # Текста нет не потому что не нашли, а потому что его нет.
    if result and result.get('instrumental'):
        ctx.emit({'status': 'ok', 'instrumental': True, 'plainLyrics': None,
                    'syncedLyrics': None, 'source': result.get('source')})
        return

    ctx.emit({'status': 'error', 'message': 'Lyrics not found'})
