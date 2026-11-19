"""Anonymous YouTube channel metadata and its public uploads playlist (no player requests)."""
import json
import re
from urllib.parse import unquote, urlsplit

import requests
from ytmusicapi.navigation import nav


SITE = 'https://www.youtube.com'
CHANNEL_ID = re.compile(r'UC[A-Za-z0-9_-]{22}')
UPLOADS_ID = re.compile(r'UU[A-Za-z0-9_-]{22}')
VIDEO_ID = re.compile(r'[A-Za-z0-9_-]{11}')
_INITIAL_DATA = re.compile(r'\bvar ytInitialData\s*=\s*')
_CLIENT_VERSION = re.compile(r'"INNERTUBE_CLIENT_VERSION"\s*:\s*"([\w.-]+)"')


def _public_page(path, params=None):
    response = requests.get(SITE + path, params=params, timeout=12)
    response.raise_for_status()
    html = response.text
    match = _INITIAL_DATA.search(html)
    if not match:
        raise ValueError('YouTube did not return a public browse page')
    data, _ = json.JSONDecoder().raw_decode(html, match.end())
    return data, html


def _channel_metadata(data):
    meta = nav(data, ['metadata', 'channelMetadataRenderer'], True) or {}
    if not CHANNEL_ID.fullmatch(meta.get('externalId', '')) or not meta.get('title'):
        raise ValueError('YouTube did not return a channel identity')
    return meta


def public_video_metadata(video_id):
    """oEmbed identifies the uploader even when the music catalog has no byline."""
    response = requests.get(SITE + '/oembed', params={'url': SITE + '/watch?v=' + video_id, 'format': 'json'}, timeout=10)
    response.raise_for_status()
    data = response.json()
    url = urlsplit(data.get('author_url') or '')
    channel_id = None
    if url.hostname in ('www.youtube.com', 'youtube.com'):
        path = url.path.rstrip('/')
        if path.startswith('/channel/') and CHANNEL_ID.fullmatch(path[9:]):
            channel_id = path[9:]
        elif re.fullmatch(r'/(?:@[^/]+|(?:user|c)/[^/]+)', unquote(path)):
            try:
                page, _ = _public_page(path)
                channel_id = _channel_metadata(page)['externalId']
            except (requests.RequestException, ValueError):
                # oEmbed is still authoritative about the name, not an ID.
                pass
    return {
        'title': data.get('title'), 'author': data.get('author_name'), 'channelId': channel_id,
        'thumbnail': {'thumbnails': [{'url': data['thumbnail_url']}] if data.get('thumbnail_url') else []},
    }


def _upload_track(row, owner, channel_id):
    model = row.get('lockupViewModel', {})
    if model.get('contentType') == 'LOCKUP_CONTENT_TYPE_VIDEO':
        video_id = model.get('contentId')
        title = nav(model, ['metadata', 'lockupMetadataViewModel', 'title', 'content'], True)
        thumb = nav(model, ['contentImage', 'thumbnailViewModel'], True) or {}
        thumb_url = nav(thumb, ['image', 'sources', -1, 'url'], True)
        duration = next((text for overlay in thumb.get('overlays', [])
                         for badge in overlay.get('thumbnailBottomOverlayViewModel', {}).get('badges', [])
                         if (text := badge.get('thumbnailBadgeViewModel', {}).get('text'))
                         and re.fullmatch(r'\d+(?::\d\d){1,2}', text)), '')
        # Unavailable uploads can have a title and ID but no watch action.
        if not nav(model, ['rendererContext', 'commandContext', 'onTap', 'innertubeCommand', 'watchEndpoint'], True):
            return None
    else:
        video = row.get('playlistVideoRenderer', {})
        if not video or video.get('isPlayable') is False:
            return None
        video_id = video.get('videoId')
        title = nav(video, ['title', 'runs', 0, 'text'], True) or nav(video, ['title', 'simpleText'], True)
        thumb_url = nav(video, ['thumbnail', 'thumbnails', -1, 'url'], True)
        duration = nav(video, ['lengthText', 'simpleText'], True) or ''
    if video_id and VIDEO_ID.fullmatch(video_id) and title:
        return {'id': video_id, 'title': title, 'artists': [owner], 'artistIds': [channel_id],
                'duration': duration, 'thumbUrl': thumb_url or '', 'album': '', 'source': 'youtube'}


def _upload_rows(data):
    sections = nav(data, ['contents', 'twoColumnBrowseResultsRenderer', 'tabs', 0, 'tabRenderer',
                          'content', 'sectionListRenderer', 'contents'], True)
    if sections is None:
        raise ValueError('YouTube did not return the public uploads list')
    for section in sections:
        for item in section.get('itemSectionRenderer', {}).get('contents', []):
            if 'playlistVideoListRenderer' in item:
                yield from item['playlistVideoListRenderer'].get('contents', [])
            else:
                yield item


def _upload_page(rows, channel_id, owner, version):
    tracks = []
    cursor = None
    for row in rows:
        token = (nav(row, ['continuationItemViewModel', 'continuationCommand', 'innertubeCommand',
                           'continuationCommand', 'token'], True)
                 or nav(row, ['continuationItemRenderer', 'continuationEndpoint', 'continuationCommand', 'token'], True))
        if token:
            if not version:
                raise ValueError('Missing public YouTube browse version')
            cursor = json.dumps([version, owner, token], separators=(',', ':'), ensure_ascii=False)
        elif (track := _upload_track(row, owner, channel_id)):
            tracks.append(track)
    return {'tracks': tracks, 'continuation': cursor}


def uploads(playlist_id, cursor=None):
    """Page only the uploads playlist; recommendations and other shelves are not uploads."""
    if not UPLOADS_ID.fullmatch(playlist_id):
        raise ValueError('Invalid channel uploads ID')
    channel_id = 'UC' + playlist_id[2:]
    if cursor:
        version, owner, token = json.loads(cursor)
        response = requests.post(SITE + '/youtubei/v1/browse', json={
            'context': {'client': {'clientName': 'WEB', 'clientVersion': version}}, 'continuation': token,
        }, timeout=12)
        response.raise_for_status()
        for action in response.json().get('onResponseReceivedActions', []):
            if 'appendContinuationItemsAction' in action:
                return _upload_page(action['appendContinuationItemsAction']['continuationItems'], channel_id, owner, version)
        raise ValueError('YouTube did not return the next uploads page')

    data, html = _public_page('/playlist', {'list': playlist_id})
    header = nav(data, ['header', 'playlistHeaderRenderer'], True) or {}
    owner = nav(header, ['ownerText', 'runs', 0], True) or {}
    if (header.get('playlistId') != playlist_id or not owner.get('text') or
            nav(owner, ['navigationEndpoint', 'browseEndpoint', 'browseId'], True) != channel_id):
        raise ValueError('YouTube did not return this channel’s public uploads')
    version = _CLIENT_VERSION.search(html)
    return _upload_page(_upload_rows(data), channel_id, owner['text'], version[1] if version else None)


def channel_profile(channel_id, visual_header):
    data, _ = _public_page('/channel/' + channel_id)
    meta = _channel_metadata(data)
    if meta['externalId'] != channel_id:
        raise ValueError('YouTube returned a different channel')
    playlist_id = 'UU' + channel_id[2:]
    tabs = nav(data, ['contents', 'twoColumnBrowseResultsRenderer', 'tabs'], True)
    if not tabs:
        raise ValueError('YouTube did not return the channel tabs')
    # Channels with no public videos have no upload tabs or public UU playlist.
    has_uploads = any((nav(t, ['tabRenderer', 'endpoint', 'commandMetadata', 'webCommandMetadata', 'url'], True)
                       or '').rstrip('/').rsplit('/', 1)[-1] in ('videos', 'streams', 'shorts')
                      for t in tabs)
    page = uploads(playlist_id) if has_uploads else {'tracks': [], 'continuation': None}
    preview_limit = 12
    sub = nav(visual_header, ['subscriptionButton', 'subscribeButtonRenderer'], True) or {}
    return {
        'profileType': 'channel', 'channelId': channel_id, 'name': meta['title'],
        'description': meta.get('description') or '',
        'thumbUrl': nav(meta, ['avatar', 'thumbnails', -1, 'url'], True) or '',
        'subscribed': sub.get('subscribed', False),
        'subscribers': nav(sub, ['subscriberCountText', 'runs', 0, 'text'], True),
        'videosPreview': page['tracks'][:preview_limit],
        'videosId': playlist_id if page['continuation'] or len(page['tracks']) > preview_limit else None,
    }
