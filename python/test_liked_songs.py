"""Offline IPC regressions; run with the app's Python environment."""
import unittest
from unittest.mock import Mock, patch

import api
from ytmusicapi.mixins.playlists import PlaylistsMixin
from ytmusicapi.parsers.songs import parse_song_menu_data


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

    @staticmethod
    def _lm_row(video_id, *, title='Song', menu=None, available=True):
        run = {'text': title}
        if available:
            run['navigationEndpoint'] = {'watchEndpoint': {'videoId': video_id}}
        renderer = {
            'playlistItemData': {'videoId': video_id},
            'flexColumns': [{'musicResponsiveListItemFlexColumnRenderer': {'text': {'runs': [run]}}}],
        }
        if available:
            renderer['overlay'] = {
                'musicItemThumbnailOverlayRenderer': {
                    'content': {
                        'musicPlayButtonRenderer': {
                            'playNavigationEndpoint': {'watchEndpoint': {'videoId': video_id}},
                        }
                    }
                }
            }
        else:
            renderer['musicItemRendererDisplayPolicy'] = 'MUSIC_ITEM_RENDERER_DISPLAY_POLICY_GREY_OUT'
        if menu is not None:
            renderer['menu'] = menu
        return {'musicResponsiveListItemRenderer': renderer}

    @staticmethod
    def _like_menu(target_video_id, *, like_status='LIKE'):
        return {
            'menuRenderer': {
                'items': [],
                'topLevelButtons': [{
                    'likeButtonRenderer': {
                        'likeStatus': like_status,
                        'target': {'videoId': target_video_id},
                    }
                }],
            }
        }

    def _lm_playlist_tracks(self, rows):
        header = {'musicResponsiveHeaderRenderer': {'subtitle': {'runs': []}}}
        shelf = {'musicPlaylistShelfRenderer': {'contents': rows}}
        response = {'contents': {'twoColumnBrowseResultsRenderer': {
            'tabs': [{'tabRenderer': {'content': {'sectionListRenderer': {'contents': [header]}}}}],
            'secondaryContents': {'sectionListRenderer': {'contents': [shelf]}},
        }}}
        client = Mock()
        client._send_request.return_value = response
        client.get_playlist.side_effect = (
            lambda pid, limit=100: PlaylistsMixin.get_playlist(client, pid, limit=limit)
        )
        client.get_liked_songs.side_effect = (
            lambda limit=100: PlaylistsMixin.get_liked_songs(client, limit=limit)
        )
        return self.request(client, 'get_playlist_tracks', playlistId='LM')

    def test_lm_row_exposes_like_target_id_when_different_from_display_id(self):
        rows = [
            self._lm_row('display_av', menu=self._like_menu('  orig_av  ')),
            self._lm_row('display_unav', menu=self._like_menu('orig_unav'), available=False),
        ]

        initial = self._lm_playlist_tracks(rows)
        self.assertEqual(initial['status'], 'ok')
        self.assertEqual(
            [(t['id'], t.get('likeTargetId'), t['likeStatus'], t['isAvailable']) for t in initial['tracks']],
            [
                ('display_av', 'orig_av', 'LIKE', True),
                ('display_unav', 'orig_unav', 'LIKE', False),
            ],
        )

        cont = self.continuation({'onResponseReceivedActions': [self.append(rows)]})
        self.assertEqual(cont['status'], 'ok')
        self.assertEqual(
            [(t['id'], t.get('likeTargetId'), t['likeStatus'], t['isAvailable']) for t in cont['tracks']],
            [
                ('display_av', 'orig_av', 'LIKE', True),
                ('display_unav', 'orig_unav', 'LIKE', False),
            ],
        )

    def test_lm_row_omits_like_target_id_when_equal_to_display_id(self):
        rows = [
            self._lm_row('same_id', menu=self._like_menu('same_id')),
            self._lm_row('trimmed_id', menu=self._like_menu(' trimmed_id ')),
        ]

        for source, reply in (
            ('get_playlist_tracks', self._lm_playlist_tracks(rows)),
            ('get_continuation', self.continuation({'onResponseReceivedActions': [self.append(rows)]})),
        ):
            with self.subTest(source=source):
                self.assertEqual(reply['status'], 'ok')
                self.assertEqual([t['id'] for t in reply['tracks']], ['same_id', 'trimmed_id'])
                for track in reply['tracks']:
                    self.assertNotIn('likeTargetId', track)
                    self.assertEqual(track['likeStatus'], 'LIKE')

    def test_lm_row_omits_like_target_id_when_absent_empty_or_non_string(self):
        menus = [
            None,
            {'menuRenderer': {'items': []}},
            {'menuRenderer': {'items': [], 'topLevelButtons': []}},
            {'menuRenderer': {'items': [], 'topLevelButtons': [{}]}},
            {'menuRenderer': {'items': [], 'topLevelButtons': [{'likeButtonRenderer': {'likeStatus': 'LIKE'}}]}},
            {'menuRenderer': {'items': [], 'topLevelButtons': [{'likeButtonRenderer': {'likeStatus': 'LIKE', 'target': None}}]}},
            {'menuRenderer': {'items': [], 'topLevelButtons': [{'likeButtonRenderer': {'likeStatus': 'LIKE', 'target': {}}}]}},
            self._like_menu(''),
            self._like_menu('   '),
            self._like_menu(None),
            self._like_menu(12345),
            self._like_menu(['orig']),
        ]
        rows = [self._lm_row(f'vid_{i}', menu=menu) for i, menu in enumerate(menus)]

        for source, reply in (
            ('get_playlist_tracks', self._lm_playlist_tracks(rows)),
            ('get_continuation', self.continuation({'onResponseReceivedActions': [self.append(rows)]})),
        ):
            with self.subTest(source=source):
                self.assertEqual(reply['status'], 'ok')
                self.assertEqual(len(reply['tracks']), len(menus))
                for track in reply['tracks']:
                    self.assertNotIn('likeTargetId', track)

    def test_parse_song_menu_data_finds_like_button_at_any_index_and_guards_malformed_nodes(self):
        idx1_menu = {
            'menuRenderer': {
                'items': [],
                'topLevelButtons': [
                    {'buttonRenderer': {'text': 'Share'}},
                    {'likeButtonRenderer': {'likeStatus': 'LIKE', 'target': {'videoId': ' orig_idx1 '}}},
                ],
            }
        }
        row_idx1 = self._lm_row('disp_idx1', menu=idx1_menu)
        for source, reply in (
            ('get_playlist_tracks', self._lm_playlist_tracks([row_idx1])),
            ('get_continuation', self.continuation({'onResponseReceivedActions': [self.append([row_idx1])]})),
        ):
            with self.subTest(source=source):
                self.assertEqual(reply['status'], 'ok')
                self.assertEqual(
                    [(t['id'], t.get('likeTargetId'), t['likeStatus']) for t in reply['tracks']],
                    [('disp_idx1', 'orig_idx1', 'LIKE')],
                )

        # Пропускает None / не-dict элементы перед валидным likeButtonRenderer
        mixed_menu = {
            'menuRenderer': {
                'items': [],
                'topLevelButtons': [
                    None,
                    'invalid',
                    {'likeButtonRenderer': None},
                    {'likeButtonRenderer': {'likeStatus': 'LIKE', 'target': {'videoId': 'orig_mixed'}}},
                ],
            }
        }
        self.assertEqual(
            parse_song_menu_data({'menu': mixed_menu}),
            {'likeStatus': 'LIKE', 'likeTargetId': 'orig_mixed'},
        )
        unav_mixed = self._lm_row('disp_unav_mixed', menu=mixed_menu, available=False)
        cont = self.continuation({'onResponseReceivedActions': [self.append([unav_mixed])]})
        self.assertEqual(cont['status'], 'ok')
        self.assertEqual(
            [(t['id'], t.get('likeTargetId'), t['likeStatus']) for t in cont['tracks']],
            [('disp_unav_mixed', 'orig_mixed', 'LIKE')],
        )

        malformed_inputs = [
            {'menu': None},
            {'menu': 'bad'},
            {'menu': {'menuRenderer': None}},
            {'menu': {'menuRenderer': 'bad'}},
            {'menu': {'menuRenderer': {'items': None, 'topLevelButtons': None}}},
            {'menu': {'menuRenderer': {'items': [None, 'bad'], 'topLevelButtons': 'bad'}}},
            {'menu': {'menuRenderer': {'items': [], 'topLevelButtons': [None, 123]}}},
            {'menu': {'menuRenderer': {'items': [], 'topLevelButtons': [{'likeButtonRenderer': None}]}}},
            {'menu': {'menuRenderer': {'items': [], 'topLevelButtons': [{'likeButtonRenderer': {'target': None}}]}}},
            {'menu': {'menuRenderer': {'items': [], 'topLevelButtons': [{'likeButtonRenderer': {'target': 'bad'}}]}}},
        ]
        for payload in malformed_inputs:
            with self.subTest(payload=payload):
                parsed = parse_song_menu_data(payload)
                self.assertIsInstance(parsed, dict)
                self.assertNotIn('likeTargetId', parsed)

    def test_get_library_songs_forwards_like_target_id_only_when_different(self):
        client = Mock()
        client.get_library_songs.return_value = [
            {'videoId': 'lib_diff', 'title': 'Diff', 'likeStatus': 'LIKE', 'likeTargetId': ' orig_lib '},
            {'videoId': 'lib_same', 'title': 'Same', 'likeStatus': 'LIKE', 'likeTargetId': 'lib_same'},
            {'videoId': 'lib_trim', 'title': 'Trim', 'likeStatus': 'LIKE', 'likeTargetId': ' lib_trim '},
            {'videoId': 'lib_empty', 'title': 'Empty', 'likeStatus': 'LIKE', 'likeTargetId': '   '},
            {'videoId': 'lib_non_str', 'title': 'NonStr', 'likeStatus': 'LIKE', 'likeTargetId': 42},
            {'videoId': 'lib_absent', 'title': 'Absent', 'likeStatus': 'LIKE'},
        ]
        reply = self.request(client, 'get_library', tab='songs')
        self.assertEqual(reply['status'], 'ok')
        by_id = {item['id']: item for item in reply['items']}
        self.assertEqual(by_id['lib_diff'].get('likeTargetId'), 'orig_lib')
        for vid in ('lib_same', 'lib_trim', 'lib_empty', 'lib_non_str', 'lib_absent'):
            self.assertNotIn('likeTargetId', by_id[vid])


if __name__ == '__main__':
    unittest.main()
