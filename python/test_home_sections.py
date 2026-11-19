"""Home roles come from shelf actions, not display strings or the order of renderers."""
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parent / 'fork'))

from backend.discovery import get_home_sections


# Reduced anonymous WEB_REMIX Quick picks response: the original first two
# video IDs and their Play all seed fields, with the other 18 seeds removed.
SEEDS = ('g-HR0e4gLzQ', 'ZSRzCbpIxZo')
PLAY_ALL = {'watchEndpoint': {
    'videoId': SEEDS[0], 'params': 'KgtnLUhSMGU0Z0x6USoLWlNSekNicEl4Wm_yAQJ4AQ%3D%3D'}}
LISTEN_AGAIN = {'browseEndpoint': {'browseId': 'FEmusic_listen_again'}}


def song(video_id, playlist_id):
    watch = {'watchEndpoint': {'videoId': video_id, 'playlistId': playlist_id}}
    return {'musicResponsiveListItemRenderer': {
        'overlay': {'musicItemThumbnailOverlayRenderer': {'content': {
            'musicPlayButtonRenderer': {'playNavigationEndpoint': watch}}}},
        'flexColumns': [{'musicResponsiveListItemFlexColumnRenderer': {'text': {'runs': [{'text': t}]}}}
                        for t in ('Song', 'Artist')],
    }}


def shelf(title, *, more=None, link=None, songs=None):
    run = {'text': title}
    if link:
        run['navigationEndpoint'] = link
    header = {'title': {'runs': [run]}}
    if more:
        header['moreContentButton'] = {'buttonRenderer': {'navigationEndpoint': more}}
    return {'musicCarouselShelfRenderer': {
        'header': {'musicCarouselShelfBasicHeaderRenderer': header},
        'contents': songs if songs is not None else [song(i, 'RDAMVM' + i) for i in SEEDS],
    }}


class HomeSections(unittest.TestCase):
    def test_raw_actions_survive_initial_and_continuation_formatting(self):
        first = {'contents': [shelf('未知', more=PLAY_ALL), {'musicTastebuilderShelfRenderer': {}},
                              shelf('特集')],
                 'continuations': [{'nextContinuationData': {'continuation': 'next'}}]}
        second = {'contents': [shelf('Encore', more=LISTEN_AGAIN), shelf('Wieder', link=LISTEN_AGAIN)]}
        api = Mock()
        api._send_request.side_effect = [
            {'contents': {'singleColumnBrowseResultsRenderer': {'tabs': [
                {'tabRenderer': {'content': {'sectionListRenderer': first}}}]}}},
            {'continuationContents': {'sectionListContinuation': second}},
        ]
        replies = []
        ctx = SimpleNamespace(get_api=lambda: api, emit=replies.append)
        get_home_sections({}, ctx)
        get_home_sections({'continuation': replies[0]['continuation']}, ctx)
        self.assertEqual(replies[0]['continuation'], 'next')
        self.assertIsNone(replies[1]['continuation'])
        self.assertEqual([[(s['title'], s.get('homeRole')) for s in page['sections']] for page in replies],
                         [[('未知', 'quick-picks'), ('特集', None)], [('Encore', 'listen-again'), ('Wieder', 'listen-again')]])
        self.assertNotIn('homeRole', replies[0]['sections'][1])
        self.assertEqual([s['id'] for s in replies[0]['sections'][0]['contents']], list(SEEDS))

    def test_similar_play_all_or_radio_rows_do_not_identify_a_shelf(self):
        changed_radio = [song(SEEDS[0], 'RDAMVM' + SEEDS[0]), song(SEEDS[1], 'PLother')]
        unrelated_seed = [song(i, 'RDAMVM' + i) for i in (SEEDS[0], 'otherVideo1')]
        rows = [
            shelf('Quick picks'),  # radio rows but no shelf-level action
            shelf('Play all', more=PLAY_ALL, songs=changed_radio),
            shelf('Play all', more=PLAY_ALL, songs=unrelated_seed),
            shelf('Listen again', more={'browseEndpoint': {'browseId': 'FEmusic_history'}}),
            shelf('Another shelf', more={'watchEndpoint': {'videoId': SEEDS[0], 'params': 'not-base64!'}}),
        ]
        api = Mock()
        api._send_request.return_value = {'continuationContents': {'sectionListContinuation': {'contents': rows}}}
        replies = []
        get_home_sections({'continuation': 'next'}, SimpleNamespace(get_api=lambda: api, emit=replies.append))
        result = replies[0]['sections']
        self.assertEqual(len(result), len(rows))
        self.assertTrue(all('homeRole' not in s for s in result))


if __name__ == '__main__':
    unittest.main()
