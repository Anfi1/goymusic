"""Run against the actual packaged interpreter and API, from outside its tree."""
import json
import os
from pathlib import Path
from queue import Queue, Empty
import subprocess
import sys
import tempfile
from threading import Thread


def check(executable, api):
    with tempfile.TemporaryDirectory() as profile:
        env = {**os.environ, 'GOYMUSIC_USER_DATA': profile}
        with subprocess.Popen([executable, '-u', api], cwd=profile, env=env,
                              stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                              text=True, encoding='utf-8') as child:
            replies = Queue()
            def drain():
                for line in child.stdout:
                    replies.put(line)
                replies.put(None)
            Thread(target=drain, daemon=True).start()
            try:
                def batch(requests):
                    for call_id, command in requests.items():
                        child.stdin.write(json.dumps({'command': command, 'callId': call_id}) + '\n')
                    child.stdin.flush()
                    results = {}
                    while len(results) < len(requests):
                        try:
                            line = replies.get(timeout=30)
                        except Empty as exc:
                            raise RuntimeError(f'Missing RPC replies: {requests.keys() - results.keys()}') from exc
                        if line is None:
                            raise RuntimeError(f'Backend exited before replying: {child.poll()}')
                        reply = json.loads(line)
                        if 'event' in reply:
                            continue
                        key = reply['callId']
                        if key not in requests or key in results:
                            raise RuntimeError(f'Unexpected callId: {key!r}')
                        results[key] = reply
                    return results

                responses = batch({'a': 'ping', 'b': 'check_auth', 'c': 'yandex_auth_status', 'd': 'no_such_command'})
                assert responses['a']['data'] == 'pong' and responses['a']['status'] == 'ok', responses
                assert responses['b']['authenticated'] is False, responses
                assert responses['c']['connected'] is False, responses
                assert responses['d']['status'] == 'error' and 'no_such_command' in responses['d']['message'], responses
                # A routed command must act on the configured profile, not the installation.
                marker = Path(profile, 'yandex.json')
                marker.write_text('{}', encoding='utf-8')
                assert batch({'e': 'yandex_logout'})['e']['status'] == 'ok'
                assert not marker.exists(), 'logout did not affect the selected profile'
            finally:
                child.stdin.close()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
            if child.returncode:
                raise RuntimeError(f'Backend exited with code {child.returncode}')


if __name__ == '__main__':
    check(str(Path(sys.argv[1]).resolve()), str(Path(sys.argv[2]).resolve()))
    print('Packaged backend: concurrent calls, guest profile, unknown command and logout passed.')
