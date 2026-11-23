"""Offline IPC regressions; run with the app's Python environment."""
import unittest
from unittest.mock import Mock, patch

import api
from ytmusicapi.mixins.playlists import PlaylistsMixin


class LikedSongsIPC(unittest.TestCase):
    def request(self, client, command, **params):
        with patch.object(api, 'get_api', return_value=client), patch.object(api, 'safe_print') as output:
            api.handle_request({'command': command, **params})
        output.assert_called_once()
        return output.call_args.args[0]

    def test_failed_likes_browse_is_not_replaced_by_a_one_song_playback_queue(self):
        client = Mock()
        client.get_liked_songs.side_effect = client.get_playlist.side_effect = ValueError('unavailable')
        client.get_watch_playlist.return_value = {'tracks': [{'videoId': 'one'}]}
        with patch.object(api.traceback, 'print_exc'):
            reply = self.request(client, 'get_playlist_tracks', playlistId='LM', limit=100)
        self.assertEqual(reply['status'], 'error')
        client.get_watch_playlist.assert_not_called()

    def continuation(self, response):
        client = Mock()
        client._send_request.return_value = response
        with patch.object(api.traceback, 'print_exc'):
            return self.request(client, 'get_continuation', token='previous', liked=True)

    @staticmethod
    def append(rows):
        return {'appendContinuationItemsAction': {'continuationItems': rows}}

    def test_explicit_empty_append_after_an_unrelated_action_is_terminal(self):
        reply = self.continuation({'onResponseReceivedActions': [
            {'updateToggleButtonStateCommand': {}}, self.append([]),
        ]})
        self.assertEqual(reply['status'], 'ok')
        self.assertEqual(reply['tracks'], [])
        self.assertEqual(reply['unavailableCount'], 0)
        self.assertIsNone(reply['continuation'])

    def test_unknown_or_broken_pages_cannot_end_a_likes_import(self):
        for response in (
            {}, {'onResponseReceivedActions': []},
            {'onResponseReceivedActions': [self.append(None)]},
            {'onResponseReceivedActions': [self.append({})]},
            {'onResponseReceivedActions': [self.append([{'unexpectedRenderer': {}}])]},
            {'onResponseReceivedActions': [self.append([{'continuationItemRenderer': {}}])]},
            {'onResponseReceivedActions': [self.append([{'musicResponsiveListItemRenderer': {'flexColumns': []}}])]},
        ):
            with self.subTest(response=response):
                self.assertEqual(self.continuation(response)['status'], 'error')

    def test_playlist_shelf_continuations_are_not_mistaken_for_end_of_list(self):
        row_cursor = {'continuationItemRenderer': {'continuationEndpoint': {'continuationCommand': {'token': 'next'}}}}
        shelf_cursor = [{'nextContinuationData': {'continuation': 'next'}}]
        for shelf, token in (
            ({'contents': []}, None),
            ({'contents': [], 'continuations': shelf_cursor}, 'next'),
            ({'contents': [row_cursor]}, 'next'),
            ({'contents': [row_cursor], 'continuations': shelf_cursor}, 'next'),
        ):
            with self.subTest(shelf=shelf):
                reply = self.continuation({'continuationContents': {'musicPlaylistShelfContinuation': shelf}})
                self.assertEqual(reply['status'], 'ok')
                self.assertEqual(reply['continuation'], token)
                self.assertEqual(reply['tracks'], [])
                self.assertEqual(reply['unavailableCount'], 0)

        for shelf in ({}, {'contents': None}, {'contents': [], 'continuations': [{}]},
                      {'contents': [row_cursor], 'continuations': [{'nextContinuationData': {'continuation': 'other'}}]}):
            with self.subTest(shelf=shelf):
                reply = self.continuation({'continuationContents': {'musicPlaylistShelfContinuation': shelf}})
                self.assertEqual(reply['status'], 'error')
        reply = self.continuation({'onResponseReceivedActions': [self.append([])],
                                   'continuationContents': {'musicPlaylistShelfContinuation': {'contents': []}}})
        self.assertEqual(reply['status'], 'error')

    def test_sparse_last_page_retains_title_watch_id_and_counts_only_unavailable_rows(self):
        song = {'musicResponsiveListItemRenderer': {
            'flexColumns': [{'musicResponsiveListItemFlexColumnRenderer': {'text': {'runs': [{
                'text': 'Last song', 'navigationEndpoint': {'watchEndpoint': {'videoId': 'last'}},
            }]}}}],
            'fixedColumns': [{'musicResponsiveListItemFixedColumnRenderer': {'text': {'simpleText': '1:23'}}}],
        }}
        unavailable = {'musicResponsiveListItemRenderer': {
            'musicItemRendererDisplayPolicy': 'MUSIC_ITEM_RENDERER_DISPLAY_POLICY_GREY_OUT',
            'flexColumns': [],
        }}
        cursor = {'continuationItemRenderer': {'continuationEndpoint': {'commandExecutorCommand': {
            'commands': [{'continuationCommand': {'request': 'CONTINUATION_REQUEST_TYPE_BROWSE', 'token': 'next'}}],
        }}}}
        reply = self.continuation({'onResponseReceivedActions': [
            {'updateToggleButtonStateCommand': {}}, self.append([song, unavailable, cursor]),
        ]})
        self.assertEqual(reply['status'], 'ok')
        self.assertEqual([(t['id'], t['duration']) for t in reply['tracks']], [('last', '1:23')])
        self.assertEqual(reply['unavailableCount'], 1)
        self.assertEqual(reply['continuation'], 'next')

    def test_unavailable_row_with_a_playlist_item_id_is_not_lost(self):
        row = {'musicResponsiveListItemRenderer': {
            'musicItemRendererDisplayPolicy': 'MUSIC_ITEM_RENDERER_DISPLAY_POLICY_GREY_OUT',
            'playlistItemData': {'videoId': 'retained'},
            'flexColumns': [{'musicResponsiveListItemFlexColumnRenderer': {'text': {
                'runs': [{'text': 'Unavailable song'}],
            }}}],
        }}
        reply = self.continuation({'onResponseReceivedActions': [self.append([row])]})
        self.assertEqual(reply['status'], 'ok')
        self.assertEqual([(t['id'], t['isAvailable']) for t in reply['tracks']], [('retained', False)])
        self.assertEqual(reply['unavailableCount'], 0)

    def test_finite_likes_fetch_returns_consumed_pages_unavailable_count_and_new_cursor(self):
        def cursor(token):
            return {'continuationItemRenderer': {'continuationEndpoint': {'continuationCommand': {'token': token}}}}

        header = {'musicResponsiveHeaderRenderer': {'subtitle': {'runs': []}}}
        shelf = {'musicPlaylistShelfRenderer': {'contents': [], 'continuations': [
            {'nextContinuationData': {'continuation': 'first'}},
        ]}}
        first = {'contents': {'twoColumnBrowseResultsRenderer': {
            'tabs': [{'tabRenderer': {'content': {'sectionListRenderer': {'contents': [header]}}}}],
            'secondaryContents': {'sectionListRenderer': {'contents': [shelf]}},
        }}}
        unavailable = {'musicResponsiveListItemRenderer': {
            'musicItemRendererDisplayPolicy': 'MUSIC_ITEM_RENDERER_DISPLAY_POLICY_GREY_OUT', 'flexColumns': [],
        }}
        track = {'musicResponsiveListItemRenderer': {'flexColumns': [
            {'musicResponsiveListItemFlexColumnRenderer': {'text': {'runs': [{
                'text': 'Song', 'navigationEndpoint': {'watchEndpoint': {'videoId': 'track'}},
            }]}}},
        ]}}
        client = Mock()
        client._send_request.side_effect = [first, {'onResponseReceivedActions': [
            self.append([unavailable, track, cursor('second')]),
        ]}]
        result = PlaylistsMixin.get_playlist(client, 'LM', limit=1)
        self.assertEqual([t['videoId'] for t in result['tracks']], ['track'])
        self.assertEqual(result['unavailableCount'], 1)
        self.assertEqual(result['continuation'], 'second')

    def test_album_bookmarks_are_not_track_likes_and_artistless_songs_survive(self):
        client = Mock()
        client.get_album.return_value = {'title': 'Fixture album', 'tracks': [
            {'videoId': 'saved', 'inLibrary': True},
            {'videoId': 'rated', 'inLibrary': False, 'likeStatus': 'LIKE', 'artists': None},
        ]}
        reply = self.request(client, 'get_album', albumId='fixture')
        self.assertEqual([(t['id'], t['likeStatus']) for t in reply['tracks']],
                         [('saved', None), ('rated', 'LIKE')])


if __name__ == '__main__':
    unittest.main()
