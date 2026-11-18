"""Offline IPC regressions; run with the app's Python environment."""
import unittest
from unittest.mock import Mock, patch

import api


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
