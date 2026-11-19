"""Offline YouTube channel/attribution contracts. PYTHONPATH=python/fork:python."""
import json
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from backend import catalog, youtube_channel as channel
from backend.formatting import parse_watch_video_renderer


CID = 'UCAK23Cyt9iPX-LF2-xd1gcQ'
PID = 'UU' + CID[2:]
VID = 'c5D1bTJ1cig'
OWNER = 'скучна'


class ChannelContracts(unittest.TestCase):
    def setUp(self):
        self.api = Mock()
        self.replies = []
        self.ctx = SimpleNamespace(get_api=lambda: self.api, emit=self.replies.append)

    def test_only_creator_header_selects_channel(self):
        self.api._send_request.return_value = {'header': {'musicVisualHeaderRenderer': {}}}
        with patch.object(channel, 'channel_profile', return_value={'profileType': 'channel'}) as profile:
            catalog.get_artist({'artistId': CID}, self.ctx)
            profile.assert_called_once_with(CID, {})
            self.api.get_artist.assert_not_called()
            for header in ({}, {'musicImmersiveHeaderRenderer': {}}):
                self.api._send_request.return_value = {'header': header}
                self.api.get_artist.side_effect = KeyError('broken artist response')
                with self.assertRaises(KeyError):
                    catalog.get_artist({'artistId': CID}, self.ctx)
            self.assertEqual(profile.call_count, 1)

    def test_unrelated_queue_rows_never_supply_metadata(self):
        self.api.get_song.return_value = {'playabilityStatus': {'status': 'LOGIN_REQUIRED'}}
        self.api.get_watch_playlist.return_value = {'tracks': [{'videoId': 'notTheShare', 'title': 'Wrong'}]}
        with patch.object(channel, 'public_video_metadata', return_value={'author': OWNER, 'channelId': CID, 'title': 'Share'}):
            catalog.get_track_info({'videoId': VID}, self.ctx)
        info = self.replies[0]['info']
        self.assertEqual(info['playabilityStatus']['status'], 'LOGIN_REQUIRED')
        self.assertEqual(info['videoDetails']['title'], 'Share')
        self.assertEqual(info['videoDetails']['artists'], [OWNER])
        self.assertEqual(info['videoDetails']['artistIds'], [CID])

    def test_upload_uses_uploader_and_preserves_duration(self):
        self.api.get_song.return_value = {}
        self.api.get_watch_playlist.return_value = {'tracks': [{'videoId': VID, 'title': 'AI cover', 'length': '3:13',
            'videoType': 'MUSIC_VIDEO_TYPE_UGC', 'artists': [{'name': 'Other', 'id': 'unrelated'}]}]}
        with patch.object(channel, 'public_video_metadata', return_value={'author': OWNER, 'channelId': CID}):
            catalog.get_track_info({'videoId': VID}, self.ctx)
        v = self.replies[0]['info']['videoDetails']
        self.assertEqual((v['author'], v['channelId'], v['artists'], v['artistIds'], v['lengthSeconds']),
                         (OWNER, CID, [OWNER], [CID], '193'))

    def test_catalog_credits_not_replaced_with_label(self):
        self.api.get_song.return_value = {'videoDetails': {'title': 'Song', 'author': 'Label', 'channelId': CID}}
        self.api.get_watch_playlist.return_value = {'tracks': [{'videoId': VID, 'videoType': 'MUSIC_VIDEO_TYPE_ATV',
            'artists': [{'name': 'A'}, {'name': 'B', 'id': 'artist-b'}]}]}
        catalog.get_track_info({'videoId': VID}, self.ctx)
        v = self.replies[0]['info']['videoDetails']
        self.assertEqual((v['artists'], v['artistIds']), (['A', 'B'], [None, 'artist-b']))

    def test_radio_keeps_unlinked_artist_slot(self):
        def artist(name, channel_id):
            return {'text': name, 'navigationEndpoint': {'browseEndpoint': {'browseId': channel_id,
                    'browseEndpointContextSupportedConfigs': {'browseEndpointContextMusicConfig': {'pageType': 'MUSIC_PAGE_TYPE_ARTIST'}}}}}
        track = parse_watch_video_renderer({'videoId': VID, 'longBylineText': {'runs': [artist('A', None), artist('B', CID)]}})
        self.assertEqual((track['artists'], track['artistIds']), (['A', 'B'], [None, CID]))

    def test_uploads_page_and_web_continuation(self):
        row = {'lockupViewModel': {'contentType': 'LOCKUP_CONTENT_TYPE_VIDEO', 'contentId': VID,
            'metadata': {'lockupMetadataViewModel': {'title': {'content': 'Shared upload'}}},
            'rendererContext': {'commandContext': {'onTap': {'innertubeCommand': {'watchEndpoint': {'videoId': VID}}}}},
            'contentImage': {'thumbnailViewModel': {'image': {'sources': [{'url': 'poster'}]}, 'overlays': [
                {'thumbnailBottomOverlayViewModel': {'badges': [{'thumbnailBadgeViewModel': {'text': '3:13'}}]}}]}}}}
        more = {'continuationItemViewModel': {'continuationCommand': {'innertubeCommand': {'continuationCommand': {'token': 'next'}}}}}
        section = {'itemSectionRenderer': {'contents': [row, more]}}
        owner = {'text': OWNER, 'navigationEndpoint': {'browseEndpoint': {'browseId': CID}}}
        data = {'header': {'playlistHeaderRenderer': {'playlistId': PID, 'ownerText': {'runs': [owner]}}},
                'contents': {'twoColumnBrowseResultsRenderer': {'tabs': [{'tabRenderer': {'content': {
                    'sectionListRenderer': {'contents': [section]}}}}]}}}
        with patch.object(channel, '_public_page', return_value=(data, '"INNERTUBE_CLIENT_VERSION":"2.0"')):
            catalog.get_artist_songs({'browseId': PID}, self.ctx)
        page = self.replies[0]
        self.assertEqual(page['tracks'], [{'id': VID, 'title': 'Shared upload', 'artists': [OWNER], 'artistIds': [CID],
                                          'album': '', 'source': 'youtube', 'thumbUrl': 'poster', 'duration': '3:13'}])
        row2 = {'playlistVideoRenderer': {'videoId': '1AYjUoy7dGw', 'title': {'simpleText': 'Next upload'}}}
        with patch.object(channel.requests, 'post') as post:
            post.return_value.json.return_value = {'onResponseReceivedActions': [{'appendContinuationItemsAction': {'continuationItems': [row2]}}]}
            catalog.get_artist_songs({'browseId': PID, 'params': page['continuation']}, self.ctx)
            self.assertEqual(post.call_args.kwargs['json'], {'context': {'client': {'clientName': 'WEB', 'clientVersion': '2.0'}}, 'continuation': 'next'})
        self.assertEqual(self.replies[1]['tracks'][0]['id'], '1AYjUoy7dGw')
        self.assertIsNone(self.replies[1]['continuation'])

    def test_public_oembed_handle_resolves_to_real_channel_id(self):
        with patch.object(channel.requests, 'get') as get:
            embed, handle = Mock(), Mock()
            embed.json.return_value = {'title': 'Cover', 'author_name': OWNER, 'author_url': 'https://www.youtube.com/@skuchnamne'}
            handle.text = 'var ytInitialData = ' + json.dumps({'metadata': {'channelMetadataRenderer': {'externalId': CID, 'title': OWNER}}}) + ';'
            get.side_effect = [embed, handle]
            metadata = channel.public_video_metadata(VID)
            self.assertEqual(get.call_args.args[0], 'https://www.youtube.com/@skuchnamne')
            self.assertEqual((metadata['channelId'], metadata['author']), (CID, OWNER))


    def test_channel_uses_public_about_and_skips_nonexistent_uploads(self):
        meta = {'externalId': CID, 'title': OWNER, 'description': 'Real bio', 'avatar': {'thumbnails': [{'url': 'photo'}]}}
        def tab(suffix):
            return {'tabRenderer': {'endpoint': {'commandMetadata': {'webCommandMetadata': {'url': '/@skuchnamne/' + suffix}}}}}
        tabs = [tab('playlists')]
        data = {'metadata': {'channelMetadataRenderer': meta}, 'contents': {'twoColumnBrowseResultsRenderer': {'tabs': tabs}}}
        with patch.object(channel, '_public_page', return_value=(data, '')), patch.object(channel, 'uploads') as uploads:
            result = channel.channel_profile(CID, {})
            uploads.assert_not_called()
            self.assertEqual((result['description'], result['thumbUrl'], result['videosPreview'], result['videosId']),
                             ('Real bio', 'photo', [], None))
            tabs.append(tab('shorts'))
            uploads.return_value = {'tracks': [{'id': VID}], 'continuation': 'next page'}
            result = channel.channel_profile(CID, {})
            uploads.assert_called_once_with(PID)
            self.assertEqual((result['profileType'], result['videosPreview'], result['videosId']),
                             ('channel', [{'id': VID}], PID))


if __name__ == '__main__':
    unittest.main()
