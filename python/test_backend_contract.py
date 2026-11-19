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


if __name__ == '__main__':
    unittest.main()
