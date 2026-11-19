"""Exercise the Android host callback contract with the shipped mobile Python sources."""
import json
from pathlib import Path
from queue import Queue
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / 'python'), str(ROOT / 'mobile/pysrc')]
import mobile_host


def check():
    replies = Queue()
    # Same method that the Kotlin proxy exposes; start() replaces the process streams.
    class Sink:
        def onLine(self, line):
            replies.put(json.loads(line))

    with tempfile.TemporaryDirectory() as profile:
        assert mobile_host.start(profile, Sink())
        for key, command in [('α', 'ping'), ('β', 'yandex_auth_status')]:
            assert mobile_host.call(json.dumps({'callId': key, 'command': command}))
        received = {}
        while len(received) < 2:
            response = replies.get(timeout=10)
            if 'event' not in response:
                received[response['callId']] = response
        assert received['α']['data'] == 'pong', received
        assert received['β']['connected'] is False, received
    print('Android host: both asynchronous callbacks delivered.', file=sys.stderr)


if __name__ == '__main__':
    check()
