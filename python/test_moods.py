"""
Test script: find "Миксы для вас" section in YTM Home.
Run from repo root: python/bin/python.exe python/test_moods.py
"""
import sys
import os
import json

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(BASE_DIR, 'python', 'fork'))

from ytmusicapi import YTMusic
from ytmusicapi.navigation import nav, SINGLE_COLUMN_TAB

BROWSER_FILE = os.path.join(BASE_DIR, 'browser.json')
OAUTH_FILE = os.path.join(BASE_DIR, 'oauth.json')
HL = 'ru'
GL = 'BY'


def get_api():
    if os.path.exists(BROWSER_FILE):
        with open(BROWSER_FILE, encoding='utf-8') as f:
            auth = json.load(f)
        print('[auth] Using browser.json', file=sys.stderr)
        return YTMusic(auth=auth, language=HL, location=GL)
    if os.path.exists(OAUTH_FILE):
        print('[auth] Using oauth.json', file=sys.stderr)
        return YTMusic(auth=OAUTH_FILE, language=HL, location=GL)
    print('[auth] No auth file found', file=sys.stderr)
    return YTMusic(language=HL, location=GL)


def extract_sections(response):
    """Extract all carousel sections with titles + browse endpoints from a home response."""
    # Continuation responses use a different root path
    if 'continuationContents' in response:
        section_list = response['continuationContents'].get('sectionListContinuation', {})
    else:
        section_list = nav(response, SINGLE_COLUMN_TAB + ['sectionListRenderer'])
    sections = section_list.get('contents', [])
    continuation = None
    conts = section_list.get('continuations', [])
    if conts:
        continuation = conts[0].get('nextContinuationData', {}).get('continuation') \
                    or conts[0].get('reloadContinuationData', {}).get('continuation')

    results = []
    for i, section in enumerate(sections):
        for renderer_key in ('musicCarouselShelfRenderer', 'musicImmersiveCarouselShelfRenderer', 'musicShelfRenderer'):
            if renderer_key not in section:
                continue
            renderer = section[renderer_key]
            header = renderer.get('header', {})
            for hkey in ('musicCarouselShelfBasicHeaderRenderer', 'musicImmersiveCarouselShelfHeaderRenderer', 'musicShelfRenderer'):
                if hkey not in header:
                    continue
                title_runs = header[hkey].get('title', {}).get('runs', [])
                if not title_runs:
                    break
                title_text = title_runs[0].get('text', '')
                nav_ep = title_runs[0].get('navigationEndpoint', {})
                browse_ep = nav_ep.get('browseEndpoint', {})
                results.append({
                    'index': i,
                    'title': title_text,
                    'browseId': browse_ep.get('browseId', ''),
                    'params': browse_ep.get('params', ''),
                })
                break
            break

    return results, continuation


def main():
    api = get_api()

    print('\nFetching Home sections (continuing until mixes found or exhausted)...\n')

    # Initial request
    response = api._send_request('browse', {'browseId': 'FEmusic_home'})
    all_sections = []
    page = 0

    while True:
        sections, continuation = extract_sections(response)
        for s in sections:
            s['index'] = len(all_sections) + s['index']
        all_sections.extend(sections)
        page += 1
        print(f'[page {page}] got {len(sections)} sections, total={len(all_sections)}, continuation={"yes" if continuation else "no"}')

        # Stop if we have enough or no more
        if not continuation or len(all_sections) >= 20:
            break

        # Fetch next page via continuation
        response = api._send_request('browse', {
            'browseId': 'FEmusic_home',
            'continuation': continuation,
        })

    print(f'\nAll sections ({len(all_sections)} total):')
    print('='*70)
    for s in all_sections:
        bid = s['browseId'] or '-'
        par = (s['params'][:35] + '...') if len(s['params']) > 35 else (s['params'] or '-')
        print(f"  [{s['index']:2d}] {s['title']:40s}  browseId={bid}  params={par}")

    # --- Browse FEmusic_mixed_for_you (with gridContinuation) ---
    print('\n' + '='*70)
    print('МИКСЫ ДЛЯ ВАС — FEmusic_mixed_for_you (all pages)')
    print('='*70)

    def parse_mix_item(item):
        for ikey in ('musicTwoRowItemRenderer', 'musicResponsiveListItemRenderer'):
            if ikey not in item:
                continue
            idata = item[ikey]
            title_runs = idata.get('title', {}).get('runs', [])
            title = title_runs[0].get('text', '') if title_runs else '?'
            nav_ep = idata.get('navigationEndpoint', {})
            browse_ep = nav_ep.get('browseEndpoint', {})
            playlist_ep = nav_ep.get('watchPlaylistEndpoint', {})
            raw_id = browse_ep.get('browseId') or playlist_ep.get('playlistId') or '?'
            # Strip leading VL prefix → real playlistId
            playlist_id = raw_id[2:] if raw_id.startswith('VL') else raw_id
            return title, playlist_id
        return None, None

    def get_grid_continuation(renderer):
        conts = renderer.get('continuations', [])
        if conts:
            return conts[0].get('nextContinuationData', {}).get('continuation') \
                or conts[0].get('reloadContinuationData', {}).get('continuation')
        return None

    mix_response = api._send_request('browse', {'browseId': 'FEmusic_mixed_for_you'})
    all_mixes = []
    page = 0

    try:
        section_list = nav(mix_response, SINGLE_COLUMN_TAB + ['sectionListRenderer'])
        grid_section = section_list.get('contents', [{}])[0]
        grid = grid_section.get('gridRenderer', {})
        items = grid.get('items', [])
        continuation = get_grid_continuation(grid)

        for item in items:
            t, pid = parse_mix_item(item)
            if t:
                all_mixes.append((t, pid))
        page += 1
        print(f'[page {page}] {len(items)} items, continuation={"yes" if continuation else "no"}')

        # Fetch continuation pages
        while continuation:
            cont_response = api._send_request('browse', {
                'browseId': 'FEmusic_mixed_for_you',
                'continuation': continuation,
            })
            if 'continuationContents' in cont_response:
                grid_cont = cont_response['continuationContents'].get('gridContinuation', {})
                items = grid_cont.get('items', [])
                continuation = get_grid_continuation(grid_cont)
            else:
                print('Unexpected continuation response structure')
                break

            for item in items:
                t, pid = parse_mix_item(item)
                if t:
                    all_mixes.append((t, pid))
            page += 1
            print(f'[page {page}] {len(items)} items, continuation={"yes" if continuation else "no"}')

    except Exception as e:
        print(f'Parse error: {e}')

    print(f'\nTotal mixes: {len(all_mixes)}')
    print('-'*70)
    for title, pid in all_mixes:
        print(f'  {title:50s}  playlistId={pid}')

    # --- Dynamic grouping ---
    import re
    from collections import defaultdict

    def group_key(title):
        """Normalize title to a group key by stripping trailing numbers and 'Супер' prefix."""
        t = title.strip()
        t = re.sub(r'\s+\d+$', '', t)          # strip trailing number: "Микс 1" → "Микс"
        t = t.replace('Супермикс', 'Микс')     # "Супермикс для сна" → "Микс для сна"
        t = t.replace('супермикс', 'микс')
        t = re.sub(r'\s+', ' ', t).strip()
        return t

    groups = defaultdict(list)
    for title, pid in all_mixes:
        groups[group_key(title)].append((title, pid))

    print('\n' + '='*70)
    print('ГРУППИРОВКА')
    print('='*70)
    for group, members in sorted(groups.items(), key=lambda x: (-len(x[1]), x[0])):
        supermix = next((m for m in members if 'упер' in m[0] or ('микс' not in m[0].lower() and 'mix' not in m[0].lower())), None)
        marker = ' ★' if len(members) > 1 else ''
        print(f'\n[{group}]{marker}  ({len(members)} плейл.)')
        for title, pid in members:
            print(f'  - {title}')


if __name__ == '__main__':
    main()
