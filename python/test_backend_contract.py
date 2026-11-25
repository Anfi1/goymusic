"""Cancellation belongs to a callId, not the provider or worker thread."""
import contextlib
import io
import json
from threading import Event, Thread
import unittest
from unittest.mock import patch

import api


class CancellationContract(unittest.TestCase):
    def test_one_cancelled_search_does_not_suppress_concurrent_or_subsequent_replies(self):
        entered, resume = Event(), Event()

        class Catalog:
            def search(self, query, limit):
                if query == 'slow':
                    entered.set()
                    if not resume.wait(timeout=10):
                        raise TimeoutError('test search was not released')
                return [{'resultType': 'song', 'videoId': query, 'title': query}]

        def search(call_id, query):
            api.handle_request({'command': 'search', 'query': query, 'callId': call_id})

        with patch.object(api, 'get_api', return_value=Catalog()), contextlib.redirect_stdout(io.StringIO()) as out:
            worker = Thread(target=search, args=('cancelled', 'slow'))
            worker.start()
            try:
                self.assertTrue(entered.wait(timeout=10))
                api.handle_request({'command': 'cancel', 'callId': 'cancelled'})
                search('parallel', 'first')
            finally:
                resume.set()
                worker.join(timeout=10)
            self.assertFalse(worker.is_alive())
            search('cancelled', 'second')
        replies = [json.loads(line) for line in out.getvalue().splitlines()]
        self.assertEqual([(r['callId'], r['results']['tracks'][0]['id']) for r in replies],
                         [('parallel', 'first'), ('cancelled', 'second')])


class ScClientIdContract(unittest.TestCase):
    def test_sc_client_id_default_calls_without_force(self):
        with patch.object(api, 'get_sc_client_id', return_value='cid1') as mock_cid, \
                patch.object(api, 'get_sc_app_version', return_value='v1'), \
                contextlib.redirect_stdout(io.StringIO()) as out:
            api.handle_request({'command': 'sc_client_id', 'callId': 'cid-default'})
        mock_cid.assert_called_once_with(force=False)
        replies = [json.loads(line) for line in out.getvalue().splitlines()]
        self.assertEqual(replies, [{
            'status': 'ok',
            'clientId': 'cid1',
            'appVersion': 'v1',
            'callId': 'cid-default',
        }])

    def test_sc_client_id_with_force_refreshes_client_id(self):
        with patch.object(api, 'get_sc_client_id', return_value='cid2') as mock_cid, \
                patch.object(api, 'get_sc_app_version', return_value='v2'), \
                contextlib.redirect_stdout(io.StringIO()) as out:
            api.handle_request({'command': 'sc_client_id', 'force': True, 'callId': 'cid-force'})
        mock_cid.assert_called_once_with(force=True)
        replies = [json.loads(line) for line in out.getvalue().splitlines()]
        self.assertEqual(replies, [{
            'status': 'ok',
            'clientId': 'cid2',
            'appVersion': 'v2',
            'callId': 'cid-force',
        }])

    def test_sc_client_id_returns_error_when_not_found(self):
        with patch.object(api, 'get_sc_client_id', return_value=None) as mock_cid, \
                patch.object(api, 'get_sc_app_version', return_value='v1'), \
                contextlib.redirect_stdout(io.StringIO()) as out:
            api.handle_request({'command': 'sc_client_id', 'callId': 'cid-missing'})
        mock_cid.assert_called_once_with(force=False)
        replies = [json.loads(line) for line in out.getvalue().splitlines()]
        self.assertEqual(replies, [{
            'status': 'error',
            'message': 'client_id not found',
            'callId': 'cid-missing',
        }])


if __name__ == '__main__':
    unittest.main()
