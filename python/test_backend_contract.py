"""Cancellation belongs to a callId, not the provider or worker thread."""
import contextlib
import io
import json
import math
import os
import tempfile
from threading import Barrier, Event, Lock, Thread
import time
import unittest
from unittest.mock import MagicMock, patch
from urllib.parse import parse_qsl, urlparse

import requests

import api
from backend import local_media, lyrics, soundcloud
from backend.context import CommandContext


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


class _FakeResponse:
    def __init__(self, body: bytes = b'', status_code: int = 200, headers: dict | None = None):
        self._body = body
        self.status_code = status_code
        self.headers = headers or {}
        self.ok = 200 <= status_code < 400

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def raise_for_status(self):
        if not self.ok:
            err = requests.HTTPError(f'HTTP {self.status_code}')
            err.response = self
            raise err

    def iter_content(self, chunk_size=65536):
        for i in range(0, len(self._body), chunk_size):
            yield self._body[i:i + chunk_size]


class YouTubeDownloadContract(unittest.TestCase):
    def test_extract_youtube_video_id_supported_urls(self):
        cases = [
            ('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'),
            ('https://youtube.com/watch?v=7IzOHlMCkSw&list=PL123', '7IzOHlMCkSw'),
            ('https://music.youtube.com/watch?v=Ar_vJ10NQHg&feature=share', 'Ar_vJ10NQHg'),
            ('https://youtu.be/FDdkK8s87N0?t=42', 'FDdkK8s87N0'),
            ('https://www.youtube.com/shorts/JVilaNmHPLY?feature=share', 'JVilaNmHPLY'),
            ('https://m.youtube.com/watch?v=wsG5WtD7DAE', 'wsG5WtD7DAE'),
        ]
        for url, expected in cases:
            with self.subTest(url=url):
                self.assertEqual(api._extract_youtube_video_id(url), expected)

    def test_extract_youtube_video_id_rejects_non_youtube_and_invalid(self):
        cases = [
            'https://soundcloud.com/artist/track-name',
            'https://rr1---sn-abc.googlevideo.com/videoplayback?id=123',
            'https://notyoutube.com/watch?v=dQw4w9WgXcQ',
            'https://youtube.com/watch?v=short',
            'https://youtube.com/playlist?list=PL1234567890',
            '',
            None,
        ]
        for url in cases:
            with self.subTest(url=url):
                self.assertIsNone(api._extract_youtube_video_id(url))

    def test_set_range_query_preserves_signed_params(self):
        raw = (
            'https://rr1---sn-test.googlevideo.com/videoplayback'
            '?expire=1999999999&mime=audio%2Fwebm&sig=AbC%2B123%3D&n=xyz_1&pot=PoT%2Ftok'
            '&range=0-10&rn=99&rbuf=500'
        )
        updated = api._set_range_query(raw, 524288, 1048575, 2)
        self.assertIn('mime=audio%2Fwebm', updated)
        self.assertIn('sig=AbC%2B123%3D', updated)
        self.assertIn('n=xyz_1', updated)
        self.assertIn('pot=PoT%2Ftok', updated)
        self.assertIn('range=524288-1048575', updated)
        self.assertIn('rn=2', updated)
        self.assertIn('rbuf=0', updated)
        self.assertNotIn('range=0-10', updated)
        self.assertNotIn('rn=99', updated)
        self.assertNotIn('rbuf=500', updated)

    def test_chunked_download_assembles_bytes_from_clen_and_emits_clean_progress(self):
        payload = bytes((i * 37) % 256 for i in range(150000))
        url = f'https://rr1---sn-test.googlevideo.com/videoplayback?clen={len(payload)}&mime=audio%2Fwebm&pot=abc'
        seen_headers = []
        seen_ranges = []
        lock = Lock()

        class FakeSession:
            def get(self, req_url, headers=None, stream=True, timeout=30):
                params = dict(parse_qsl(urlparse(req_url).query))
                s, e = map(int, params['range'].split('-'))
                with lock:
                    seen_headers.append(dict(headers or {}))
                    seen_ranges.append((s, e, params.get('rn'), params.get('rbuf')))
                return _FakeResponse(payload[s:e + 1], 200, {'Content-Length': str(e - s + 1)})

            def close(self):
                pass

        with tempfile.TemporaryDirectory() as tmpdir:
            dest = os.path.join(tmpdir, 'out.webm')
            with patch.object(api.requests, 'Session', side_effect=FakeSession), \
                    contextlib.redirect_stdout(io.StringIO()) as out:
                written = api._download_googlevideo_chunked(
                    url, dest, {}, 'dl-1', lambda: False, chunk_size=32768, max_workers=4
                )
            self.assertEqual(written, len(payload))
            with open(dest, 'rb') as f:
                self.assertEqual(f.read(), payload)

        # Должно быть ровно 5 чанков, без лишнего 0-0 зонда (clen уже в URL)
        self.assertEqual(len(seen_ranges), 5)
        self.assertTrue(all(r[3] == '0' for r in seen_ranges))
        self.assertTrue(all('Chrome/' in h.get('User-Agent', '') for h in seen_headers))
        self.assertTrue(all(h.get('Referer') == 'https://music.youtube.com/' for h in seen_headers))
        self.assertTrue(all(h.get('Origin') == 'https://music.youtube.com' for h in seen_headers))

        events = [json.loads(line) for line in out.getvalue().splitlines()]
        progress_events = [e for e in events if e.get('event') == 'download_progress']
        self.assertGreaterEqual(len(progress_events), 1)
        for ev in progress_events:
            self.assertIn('MB/s)', ev['status'])
            self.assertNotIn('Downloading: ', ev['status'])

    def test_chunked_download_probes_size_when_clen_missing(self):
        payload = bytes((i * 19) % 256 for i in range(90000))
        url = 'https://rr1---sn-test.googlevideo.com/videoplayback?mime=audio%2Fmp4&sig=abc'
        probe_called = []

        class FakeSession:
            def get(self, req_url, headers=None, stream=True, timeout=30):
                params = dict(parse_qsl(urlparse(req_url).query))
                s, e = map(int, params['range'].split('-'))
                if s == 0 and e == 0 and params.get('rn') == '0':
                    probe_called.append(True)
                    return _FakeResponse(
                        payload[0:1],
                        206,
                        {'Content-Range': f'bytes 0-0/{len(payload)}', 'Content-Length': '1'},
                    )
                return _FakeResponse(payload[s:e + 1], 200, {'Content-Length': str(e - s + 1)})

            def close(self):
                pass

        with tempfile.TemporaryDirectory() as tmpdir:
            dest = os.path.join(tmpdir, 'probe.m4a')
            with patch.object(api.requests, 'Session', side_effect=FakeSession), \
                    contextlib.redirect_stdout(io.StringIO()):
                written = api._download_googlevideo_chunked(
                    url, dest, {}, 'dl-probe', lambda: False, chunk_size=32768, max_workers=3
                )
            self.assertEqual(written, len(payload))
            self.assertEqual(len(probe_called), 1)
            with open(dest, 'rb') as f:
                self.assertEqual(f.read(), payload)

    def test_chunked_download_retries_transient_chunk_failure(self):
        payload = b'A' * 40000 + b'B' * 40000
        url = f'https://rr1---sn-test.googlevideo.com/videoplayback?clen={len(payload)}'
        attempts = {}
        lock = Lock()

        class FakeSession:
            def get(self, req_url, headers=None, stream=True, timeout=30):
                params = dict(parse_qsl(urlparse(req_url).query))
                rng = params['range']
                s, e = map(int, rng.split('-'))
                with lock:
                    attempts[rng] = attempts.get(rng, 0) + 1
                    count = attempts[rng]
                if s == 40000 and count == 1:
                    raise requests.ConnectionError('transient reset')
                return _FakeResponse(payload[s:e + 1], 200)

            def close(self):
                pass

        with tempfile.TemporaryDirectory() as tmpdir:
            dest = os.path.join(tmpdir, 'retry.webm')
            with patch.object(api.requests, 'Session', side_effect=FakeSession), \
                    patch.object(api.time, 'sleep'), \
                    contextlib.redirect_stdout(io.StringIO()):
                written = api._download_googlevideo_chunked(
                    url, dest, {}, 'dl-retry', lambda: False, chunk_size=40000, max_workers=2
                )
            self.assertEqual(written, len(payload))
            self.assertEqual(attempts['40000-79999'], 2)
            with open(dest, 'rb') as f:
                self.assertEqual(f.read(), payload)

    def test_chunked_download_fails_fast_on_403_and_removes_partial_file(self):
        url = 'https://rr1---sn-test.googlevideo.com/videoplayback?clen=80000'
        call_count = 0
        lock = Lock()

        class FakeSession:
            def get(self, req_url, headers=None, stream=True, timeout=30):
                nonlocal call_count
                with lock:
                    call_count += 1
                return _FakeResponse(b'', 403)

            def close(self):
                pass

        with tempfile.TemporaryDirectory() as tmpdir:
            dest = os.path.join(tmpdir, 'expired.webm')
            with patch.object(api.requests, 'Session', side_effect=FakeSession), \
                    contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(requests.HTTPError) as ctx:
                    api._download_googlevideo_chunked(
                        url, dest, {}, 'dl-403', lambda: False, chunk_size=40000, max_workers=1
                    )
            self.assertEqual(ctx.exception.response.status_code, 403)
            self.assertEqual(call_count, 1)
            self.assertFalse(os.path.exists(dest))

    def test_chunked_download_cancellation_removes_partial_file(self):
        payload = b'X' * 120000
        url = f'https://rr1---sn-test.googlevideo.com/videoplayback?clen={len(payload)}'
        cancelled = Event()

        class FakeSession:
            def get(self, req_url, headers=None, stream=True, timeout=30):
                params = dict(parse_qsl(urlparse(req_url).query))
                s, e = map(int, params['range'].split('-'))
                cancelled.set()
                return _FakeResponse(payload[s:e + 1], 200)

            def close(self):
                pass

        with tempfile.TemporaryDirectory() as tmpdir:
            dest = os.path.join(tmpdir, 'cancel.webm')
            with patch.object(api.requests, 'Session', side_effect=FakeSession), \
                    contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(api._DownloadCancelled):
                    api._download_googlevideo_chunked(
                        url, dest, {}, 'dl-cancel', cancelled.is_set, chunk_size=30000, max_workers=1
                    )
            self.assertTrue(cancelled.is_set())
            self.assertFalse(os.path.exists(dest))

    def test_chunked_download_falls_back_to_streaming_when_size_unknown(self):
        payload = b'stream-fallback-bytes' * 100
        url = 'https://rr1---sn-test.googlevideo.com/videoplayback?mime=audio%2Fmp4'
        get_headers = []

        class FakeSession:
            def get(self, req_url, headers=None, stream=True, timeout=30):
                return _FakeResponse(b's', 200, {'Content-Length': '1'})

            def close(self):
                pass

        def fake_get(req_url, stream=True, headers=None, timeout=120):
            get_headers.append(dict(headers or {}))
            return _FakeResponse(payload, 200, {'Content-Length': str(len(payload))})

        with tempfile.TemporaryDirectory() as tmpdir:
            dest = os.path.join(tmpdir, 'fallback.m4a')
            with patch.object(api.requests, 'Session', side_effect=FakeSession), \
                    patch.object(api.requests, 'get', side_effect=fake_get), \
                    contextlib.redirect_stdout(io.StringIO()):
                written = api._download_googlevideo_chunked(
                    url, dest, {}, 'dl-stream', lambda: False
                )
            self.assertEqual(written, len(payload))
            with open(dest, 'rb') as f:
                self.assertEqual(f.read(), payload)
        self.assertEqual(len(get_headers), 1)
        self.assertIn('Chrome/', get_headers[0]['User-Agent'])

    def test_download_direct_uses_chunked_and_reresolves_on_403(self):
        expired_url = 'https://rr1---sn-old.googlevideo.com/videoplayback?clen=1024&mime=audio%2Fwebm'
        fresh_url = 'https://rr2---sn-new.googlevideo.com/videoplayback?clen=2048&mime=audio%2Fwebm'
        chunk_calls = []

        def fake_chunked(url, filepath, headers, call_id, is_cancelled, **kwargs):
            chunk_calls.append((url, headers))
            if url == expired_url:
                err = requests.HTTPError('403 Forbidden')
                err.response = _FakeResponse(b'', 403)
                raise err
            with open(filepath, 'wb') as f:
                f.write(b'ok-audio')
            return 8

        with tempfile.TemporaryDirectory() as tmpdir:
            with patch.object(api, '_download_googlevideo_chunked', side_effect=fake_chunked), \
                    patch.object(api, '_resolve_youtube_audio_stream', return_value=(fresh_url, -1.5, {})) as mock_resolve, \
                    patch.object(local_media, '_ffmpeg_loudness', return_value=(-12.0, -1.0)), \
                    patch.object(api.yt_dlp, 'YoutubeDL') as mock_ydl, \
                    contextlib.redirect_stdout(io.StringIO()) as out:
                api.handle_request({
                    'command': 'download_direct',
                    'streamUrl': expired_url,
                    'videoId': 'dQw4w9WgXcQ',
                    'songsPath': tmpdir,
                    'callId': 'dd-403',
                })

            mock_resolve.assert_called_once_with('dQw4w9WgXcQ')
            mock_ydl.assert_not_called()
            self.assertEqual([c[0] for c in chunk_calls], [expired_url, fresh_url])
            self.assertIn('Chrome/', chunk_calls[0][1]['User-Agent'])

            replies = [json.loads(line) for line in out.getvalue().splitlines()]
            final = [r for r in replies if r.get('status') == 'ok'][-1]
            self.assertEqual(final['callId'], 'dd-403')
            self.assertTrue(final['filename'].startswith('dl_direct_dQw4w9WgXcQ_'))
            self.assertTrue(final['filename'].endswith('.webm'))
            self.assertAlmostEqual(final['gainDb'], 2.0)
            self.assertTrue(final['gainMeasured'])

    def test_download_track_routes_youtube_to_fast_chunked_and_soundcloud_to_ytdlp(self):
        yt_stream = 'https://rr1---sn-yt.googlevideo.com/videoplayback?clen=4096&mime=audio%2Fwebm'

        def fake_chunked(url, filepath, headers, call_id, is_cancelled, **kwargs):
            with open(filepath, 'wb') as f:
                f.write(b'yt-fast-audio')
            return 13

        with tempfile.TemporaryDirectory() as tmpdir:
            # 1) YouTube URL -> fast resolve + chunked download, без yt-dlp
            with patch.object(api, '_resolve_youtube_audio_stream', return_value=(yt_stream, -2.0, {})) as mock_resolve, \
                    patch.object(api, '_download_googlevideo_chunked', side_effect=fake_chunked) as mock_chunked, \
                    patch.object(local_media, '_ffmpeg_loudness', return_value=(-15.0, -3.0)), \
                    patch.object(api.yt_dlp, 'YoutubeDL') as mock_ydl, \
                    contextlib.redirect_stdout(io.StringIO()) as out:
                api.handle_request({
                    'command': 'download_track',
                    'url': 'https://music.youtube.com/watch?v=7IzOHlMCkSw',
                    'videoId': '7IzOHlMCkSw',
                    'songsPath': tmpdir,
                    'callId': 'dt-yt',
                })
            mock_resolve.assert_called_once_with('7IzOHlMCkSw')
            mock_chunked.assert_called_once()
            mock_ydl.assert_not_called()
            replies = [json.loads(line) for line in out.getvalue().splitlines()]
            final_yt = [r for r in replies if r.get('status') == 'ok'][-1]
            self.assertTrue(final_yt['filename'].startswith('7IzOHlMCkSw_'))
            self.assertTrue(final_yt['filename'].endswith('.webm'))
            self.assertAlmostEqual(final_yt['gainDb'], -1.0)
            self.assertTrue(final_yt['gainMeasured'])

            # 2) SoundCloud URL -> существующий yt-dlp путь не тронут
            def fake_ydl_factory(opts):
                ydl = MagicMock()
                def extract(u, download=True):
                    out_path = opts['outtmpl'].replace('%%(', '%(').replace('%(ext)s', 'mp3')
                    with open(out_path, 'wb') as f:
                        f.write(b'sc-audio')
                    return {'ext': 'mp3'}
                ydl.__enter__.return_value.extract_info.side_effect = extract
                return ydl

            with patch.object(api, '_resolve_youtube_audio_stream') as mock_resolve_sc, \
                    patch.object(api, '_download_googlevideo_chunked') as mock_chunked_sc, \
                    patch.object(api.yt_dlp, 'YoutubeDL', side_effect=fake_ydl_factory) as mock_ydl_sc, \
                    patch('subprocess.run', side_effect=FileNotFoundError('skip ffmpeg')), \
                    contextlib.redirect_stdout(io.StringIO()) as out_sc:
                api.handle_request({
                    'command': 'download_track',
                    'url': 'https://soundcloud.com/artist/song',
                    'videoId': 'sc-track-1',
                    'songsPath': tmpdir,
                    'callId': 'dt-sc',
                })
            mock_resolve_sc.assert_not_called()
            mock_chunked_sc.assert_not_called()
            mock_ydl_sc.assert_called_once()
            replies_sc = [json.loads(line) for line in out_sc.getvalue().splitlines()]
            final_sc = [r for r in replies_sc if r.get('status') == 'ok'][-1]
            self.assertTrue(final_sc['filename'].startswith('sc-track-1_'))
            self.assertTrue(final_sc['filename'].endswith('.mp3'))

    def test_get_preview_url_uses_fast_resolve_for_youtube_and_ytdlp_for_soundcloud(self):
        yt_details = {
            'title': 'Test Song',
            'author': 'Test Artist',
            'lengthSeconds': '213',
            'thumbnail': {'thumbnails': [{'url': 'https://i.ytimg.com/small.jpg'}, {'url': 'https://i.ytimg.com/hq.jpg'}]},
        }
        with patch.object(
            api,
            '_resolve_youtube_audio_stream',
            return_value=('https://rr1---sn-yt.googlevideo.com/videoplayback?clen=123', -1.2, yt_details),
        ) as mock_resolve, \
                patch.object(api.yt_dlp, 'YoutubeDL') as mock_ydl, \
                contextlib.redirect_stdout(io.StringIO()) as out:
            api.handle_request({
                'command': 'get_preview_url',
                'url': 'https://youtu.be/dQw4w9WgXcQ',
                'callId': 'prev-yt',
            })
        mock_resolve.assert_called_once_with('dQw4w9WgXcQ')
        mock_ydl.assert_not_called()
        replies = [json.loads(line) for line in out.getvalue().splitlines()]
        self.assertEqual(replies, [{
            'status': 'ok',
            'streamUrl': 'https://rr1---sn-yt.googlevideo.com/videoplayback?clen=123',
            'loudness': -1.2,
            'title': 'Test Song',
            'artist': 'Test Artist',
            'duration': 213,
            'thumbUrl': 'https://i.ytimg.com/hq.jpg',
            'callId': 'prev-yt',
        }])

        # SoundCloud URL продолжает идти через yt-dlp без fast-path YouTube
        sc_ydl = MagicMock()
        sc_ydl.__enter__.return_value.extract_info.return_value = {
            'url': 'https://cf-media.sndcdn.com/audio.mp3',
            'protocol': 'https',
            'ext': 'mp3',
            'title': 'SC Track',
            'uploader': 'SC Artist',
            'duration': 180,
            'thumbnails': [{'url': 'https://i1.sndcdn.com/art.jpg'}],
        }
        with patch.object(api, '_resolve_youtube_audio_stream') as mock_resolve_sc, \
                patch.object(api, 'get_sc_client_id', return_value='cid123'), \
                patch.object(api.yt_dlp, 'YoutubeDL', return_value=sc_ydl) as mock_ydl_sc, \
                contextlib.redirect_stdout(io.StringIO()) as out_sc:
            api.handle_request({
                'command': 'get_preview_url',
                'url': 'https://soundcloud.com/artist/track',
                'callId': 'prev-sc',
            })
        mock_resolve_sc.assert_not_called()
        mock_ydl_sc.assert_called_once()
        replies_sc = [json.loads(line) for line in out_sc.getvalue().splitlines()]
        self.assertEqual(replies_sc, [{
            'status': 'ok',
            'streamUrl': 'https://cf-media.sndcdn.com/audio.mp3',
            'loudness': None,
            'title': 'SC Track',
            'artist': 'SC Artist',
            'duration': 180,
            'thumbUrl': 'https://i1.sndcdn.com/art.jpg',
            'callId': 'prev-sc',
        }])

    def test_chunked_download_403_with_4_workers_never_misclassified_as_cancel(self):
        # 4 потока одновременно: чанк 0 получает 403, соседние чанки активно стримят
        # и прерываются по stop_event раньше, чем поток 0 успеет выйти из контекста.
        chunk_size = 4096
        total_size = chunk_size * 8
        url = f'https://rr1---sn-test.googlevideo.com/videoplayback?clen={total_size}'
        all_started = Barrier(4, timeout=5)
        sibling_aborted = Event()

        class SlowSiblingResponse(_FakeResponse):
            def iter_content(self, chunk_size=65536):
                yield b'x' * 512
                # Ждем, пока соседний поток выставит stop_event на 403, и продолжаем итерацию
                sibling_aborted.wait(timeout=2)
                yield b'y' * 512

        class Delayed403Response(_FakeResponse):
            def __exit__(self, exc_type, exc, tb):
                # Даем соседним потокам первыми увидеть stop_event и завершиться
                sibling_aborted.set()
                api.time.sleep(0.05)
                return False

        class FakeSession:
            def get(self, req_url, headers=None, stream=True, timeout=30):
                params = dict(parse_qsl(urlparse(req_url).query))
                s, _ = map(int, params['range'].split('-'))
                try:
                    all_started.wait()
                except Exception:
                    pass
                if s == 0:
                    return Delayed403Response(b'', 403)
                return SlowSiblingResponse(b'z' * chunk_size, 200)

            def close(self):
                pass

        with tempfile.TemporaryDirectory() as tmpdir:
            dest = os.path.join(tmpdir, 'race403.webm')
            with patch.object(api.requests, 'Session', side_effect=FakeSession), \
                    contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(requests.HTTPError) as ctx:
                    api._download_googlevideo_chunked(
                        url, dest, {}, 'dl-race-403', lambda: False,
                        chunk_size=chunk_size, max_workers=4,
                    )
            self.assertEqual(ctx.exception.response.status_code, 403)
            self.assertFalse(os.path.exists(dest))

    def test_chunked_download_fails_fast_on_oversized_chunk(self):
        expected_len = 8192
        url = f'https://rr1---sn-test.googlevideo.com/videoplayback?clen={expected_len}'
        pieces_yielded = 0

        class OversizedResponse(_FakeResponse):
            def iter_content(self, chunk_size=65536):
                nonlocal pieces_yielded
                for _ in range(20):
                    pieces_yielded += 1
                    yield b'A' * 4096

        class FakeSession:
            def get(self, req_url, headers=None, stream=True, timeout=30):
                return OversizedResponse(b'', 200)

            def close(self):
                pass

        with tempfile.TemporaryDirectory() as tmpdir:
            dest = os.path.join(tmpdir, 'oversized.webm')
            with patch.object(api.requests, 'Session', side_effect=FakeSession), \
                    patch.object(api.time, 'sleep'), \
                    contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(IOError):
                    api._download_googlevideo_chunked(
                        url, dest, {}, 'dl-oversize', lambda: False,
                        chunk_size=expected_len, max_workers=1,
                    )
            # 3 попытки * по 3 куска (4096 + 4096 + 4096 > 8192 -> обрыв), далеко не 3 * 20
            self.assertLessEqual(pieces_yielded, 9)
            self.assertFalse(os.path.exists(dest))

    def test_download_direct_yt_api_cleans_partial_file_and_honors_cancel(self):
        yt_api_url = 'https://www.youtube.com/api/timedtext?foo=1'

        class MidStreamFailResponse(_FakeResponse):
            def iter_content(self, chunk_size=262144):
                yield b'partial-bytes'
                raise requests.ConnectionError('dropped mid-stream')

        # 1) Обычная ошибка сети: частичный файл должен быть удален ДО фолбэка в yt-dlp
        with tempfile.TemporaryDirectory() as tmpdir:
            seen_files_on_fallback = []

            def fake_ydl_factory(opts):
                ydl = MagicMock()
                def extract(u, download=True):
                    seen_files_on_fallback.extend(os.listdir(tmpdir))
                    out_path = opts['outtmpl'].replace('%(ext)s', 'webm')
                    with open(out_path, 'wb') as f:
                        f.write(b'ytdlp-good')
                    return {'ext': 'webm'}
                ydl.__enter__.return_value.extract_info.side_effect = extract
                return ydl

            with patch.object(api.requests, 'get', return_value=MidStreamFailResponse()), \
                    patch.object(api.yt_dlp, 'YoutubeDL', side_effect=fake_ydl_factory), \
                    patch.object(local_media, '_ffmpeg_loudness', return_value=(-14.0, -1.0)), \
                    contextlib.redirect_stdout(io.StringIO()) as out:
                api.handle_request({
                    'command': 'download_direct',
                    'url': yt_api_url,
                    'videoId': 'dQw4w9WgXcQ',
                    'songsPath': tmpdir,
                    'callId': 'ytapi-fail',
                })
            self.assertEqual(seen_files_on_fallback, [])
            replies = [json.loads(line) for line in out.getvalue().splitlines()]
            final = [r for r in replies if r.get('status') == 'ok'][-1]
            self.assertTrue(final['filename'].endswith('.webm'))
            self.assertTrue(final['gainMeasured'])

        # 2) Отмена при ошибке в yt_api: частичный файл удален, yt-dlp не запускается
        with tempfile.TemporaryDirectory() as tmpdir:
            class CancelThenErrorResponse(_FakeResponse):
                def iter_content(self, chunk_size=262144):
                    yield b'partial-before-cancel'
                    api.handle_request({'command': 'cancel', 'callId': 'ytapi-cancel'})
                    raise requests.ConnectionError('socket aborted on cancel')

            with patch.object(api.requests, 'get', return_value=CancelThenErrorResponse()), \
                    patch.object(api.yt_dlp, 'YoutubeDL') as mock_ydl, \
                    contextlib.redirect_stdout(io.StringIO()):
                api.handle_request({
                    'command': 'download_direct',
                    'url': yt_api_url,
                    'videoId': 'dQw4w9WgXcQ',
                    'songsPath': tmpdir,
                    'callId': 'ytapi-cancel',
                })
            mock_ydl.assert_not_called()
            self.assertEqual(os.listdir(tmpdir), [])

    def test_download_direct_googlevideo_fallback_passes_watch_url_to_ytdlp(self):
        dead_gv_url = 'https://rr1---sn-dead.googlevideo.com/videoplayback?clen=4096&mime=audio%2Fwebm'
        captured_urls = []

        def fake_ydl_factory(opts):
            ydl = MagicMock()
            def extract(u, download=True):
                captured_urls.append(u)
                out_path = opts['outtmpl'].replace('%(ext)s', 'webm')
                with open(out_path, 'wb') as f:
                    f.write(b'fallback-audio')
                return {'ext': 'webm'}
            ydl.__enter__.return_value.extract_info.side_effect = extract
            return ydl

        with tempfile.TemporaryDirectory() as tmpdir:
            with patch.object(api, '_download_googlevideo_chunked', side_effect=IOError('chunk failed')), \
                    patch.object(api.yt_dlp, 'YoutubeDL', side_effect=fake_ydl_factory), \
                    patch.object(local_media, '_ffmpeg_loudness', return_value=(-14.0, -1.0)), \
                    contextlib.redirect_stdout(io.StringIO()) as out:
                api.handle_request({
                    'command': 'download_direct',
                    'streamUrl': dead_gv_url,
                    'videoId': 'dQw4w9WgXcQ',
                    'songsPath': tmpdir,
                    'callId': 'gv-fallback',
                })
            self.assertEqual(captured_urls, ['https://www.youtube.com/watch?v=dQw4w9WgXcQ'])
            replies = [json.loads(line) for line in out.getvalue().splitlines()]
            final = [r for r in replies if r.get('status') == 'ok'][-1]
            self.assertTrue(final['filename'].startswith('dl_direct_dQw4w9WgXcQ_'))
            self.assertTrue(final['gainMeasured'])

    def test_download_track_cancelled_during_fast_resolve_skips_ytdlp(self):
        def fake_resolve_and_cancel(vid):
            api.handle_request({'command': 'cancel', 'callId': 'dt-cancel-resolve'})
            return None, None, None

        with tempfile.TemporaryDirectory() as tmpdir:
            with patch.object(api, '_resolve_youtube_audio_stream', side_effect=fake_resolve_and_cancel), \
                    patch.object(api.yt_dlp, 'YoutubeDL') as mock_ydl, \
                    contextlib.redirect_stdout(io.StringIO()):
                api.handle_request({
                    'command': 'download_track',
                    'url': 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
                    'videoId': 'dQw4w9WgXcQ',
                    'songsPath': tmpdir,
                    'callId': 'dt-cancel-resolve',
                })
            mock_ydl.assert_not_called()


class LocalLoudnessContract(unittest.TestCase):
    def test_measure_loudness_full_guards_non_finite_and_clamps_tp_safely(self):
        with patch.object(local_media, '_ffmpeg_loudness', return_value=(-70.0, float('-inf'))):
            self.assertEqual(local_media.measure_loudness_full('a.mp3'), (None, None))
        with patch.object(local_media, '_ffmpeg_loudness', return_value=(float('-inf'), float('-inf'))):
            self.assertEqual(local_media.measure_loudness_full('a.mp3'), (None, None))
        with patch.object(local_media, '_ffmpeg_loudness', return_value=(float('nan'), -1.0)):
            self.assertEqual(local_media.measure_loudness_full('a.mp3'), (None, None))
        with patch.object(local_media, '_ffmpeg_loudness', return_value=(-20.0, -0.5)):
            loud, tp = local_media.measure_loudness_full('a.mp3')
            self.assertAlmostEqual(loud, 0.5)
            self.assertAlmostEqual(tp, -0.5)
        with patch.object(local_media, '_ffmpeg_loudness', return_value=(-20.0, float('-inf'))):
            loud, tp = local_media.measure_loudness_full('a.mp3')
            self.assertAlmostEqual(loud, -6.0)
            self.assertTrue(tp is None or math.isfinite(tp))

    def test_measure_local_gain_db_uses_full_ebur128_and_skips_volumedetect_on_success(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = os.path.join(tmpdir, 'short.mp3')
            with open(path, 'wb') as f:
                f.write(b'fake-audio')
            with patch.object(local_media, '_ffmpeg_loudness', return_value=(-20.0, -0.5)) as mock_ebur, \
                    patch('subprocess.run') as mock_run:
                gain, measured = local_media.measure_local_gain_db(path)
            mock_ebur.assert_called_once_with(path, timeout=300)
            mock_run.assert_not_called()
            self.assertTrue(measured)
            self.assertAlmostEqual(gain, 0.5)

    def test_measure_local_gain_db_volumedetect_fallback_has_no_ss30_and_clamps_peak(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = os.path.join(tmpdir, 'short.mp3')
            with open(path, 'wb') as f:
                f.write(b'fake-audio')

            seen_cmds = []

            def fake_run(cmd, **kwargs):
                seen_cmds.append(cmd)
                res = MagicMock()
                res.stderr = (
                    '[Parsed_volumedetect_0 @ 000] mean_volume: -20.0 dB\n'
                    '[Parsed_volumedetect_0 @ 000] max_volume: -0.5 dB\n'
                )
                return res

            with patch.object(local_media, 'measure_loudness_full', return_value=(None, None)), \
                    patch('subprocess.run', side_effect=fake_run):
                gain, measured = local_media.measure_local_gain_db(path)

            self.assertTrue(measured)
            self.assertAlmostEqual(gain, 0.5)
            self.assertEqual(len(seen_cmds), 1)
            self.assertNotIn('-ss', seen_cmds[0])
            self.assertNotIn('-t', seen_cmds[0])
            self.assertIn('volumedetect', seen_cmds[0])

            # Тишина (<= -70 dB) отбрасывается и возвращает fallback + measured=False
            def fake_silent(cmd, **kwargs):
                res = MagicMock()
                res.stderr = '[Parsed_volumedetect_0 @ 000] mean_volume: -91.0 dB\n'
                return res

            with patch.object(local_media, 'measure_loudness_full', side_effect=RuntimeError('boom')), \
                    patch('subprocess.run', side_effect=fake_silent):
                gain_s, measured_s = local_media.measure_local_gain_db(path, fallback_gain_db=0.0)
            self.assertFalse(measured_s)
            self.assertAlmostEqual(gain_s, 0.0)

        # Отсутствующий файл -> fallback + measured=False без запуска ffmpeg
        gain_m, measured_m = local_media.measure_local_gain_db('/nonexistent/file.mp3', fallback_gain_db=-1.25)
        self.assertFalse(measured_m)
        self.assertAlmostEqual(gain_m, -1.25)

    def test_analyze_file_emits_measured_flag_and_uses_unified_helper(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = os.path.join(tmpdir, 'song.mp3')
            with open(path, 'wb') as f:
                f.write(b'fake-audio')
            with patch.object(local_media, 'measure_local_gain_db', return_value=(1.75, True)) as mock_m, \
                    contextlib.redirect_stdout(io.StringIO()) as out:
                api.handle_request({
                    'command': 'analyze_file',
                    'filename': 'song.mp3',
                    'songsPath': tmpdir,
                    'callId': 'an-1',
                })
            mock_m.assert_called_once_with(path, fallback_gain_db=0.0, wait_stable=True)
            replies = [json.loads(line) for line in out.getvalue().splitlines()]
            self.assertEqual(replies, [{
                'status': 'ok',
                'gainDb': 1.75,
                'measured': True,
                'callId': 'an-1',
            }])

    def test_api_measure_local_gain_and_soundcloud_download_use_unified_ebur128(self):
        # _measure_local_gain: при провале локального замера конечный fallback считается измеренным
        with patch.object(api, 'measure_local_gain_db', return_value=(None, False)):
            self.assertEqual(api._measure_local_gain('x.mp3', fallback_gain_db=-2.5), (-2.5, True))
            self.assertEqual(api._measure_local_gain('x.mp3', fallback_gain_db=None), (0.0, False))
            self.assertEqual(api._measure_local_gain('x.mp3', fallback_gain_db=float('nan')), (0.0, False))

        with tempfile.TemporaryDirectory() as tmpdir:
            def fake_ydl_factory(opts):
                ydl = MagicMock()
                def extract(u, download=True):
                    out_path = opts['outtmpl'].replace('%%(', '%(').replace('%(ext)s', 'mp3')
                    with open(out_path, 'wb') as f:
                        f.write(b'sc-short-audio')
                    return {'ext': 'mp3'}
                ydl.__enter__.return_value.extract_info.side_effect = extract
                return ydl

            with patch.object(api.yt_dlp, 'YoutubeDL', side_effect=fake_ydl_factory), \
                    patch.object(local_media, 'measure_loudness_full', return_value=(-1.25, -2.0)) as mock_full, \
                    patch('subprocess.run') as mock_subproc, \
                    contextlib.redirect_stdout(io.StringIO()) as out:
                api.handle_request({
                    'command': 'download_track',
                    'url': 'https://soundcloud.com/artist/short-track',
                    'videoId': 'sc-short',
                    'songsPath': tmpdir,
                    'callId': 'dt-sc-unified',
                })
            mock_full.assert_called_once()
            mock_subproc.assert_not_called()
            replies = [json.loads(line) for line in out.getvalue().splitlines()]
            final = [r for r in replies if r.get('status') == 'ok'][-1]
            self.assertAlmostEqual(final['gainDb'], -1.25)
            self.assertTrue(final['gainMeasured'])

            # При провале замера download_track YouTube с fast_loudness=None -> gainMeasured=False
            yt_stream = 'https://rr1---sn-yt.googlevideo.com/videoplayback?clen=1024&mime=audio%2Fwebm'
            def fake_chunked(url, filepath, headers, call_id, is_cancelled, **kwargs):
                with open(filepath, 'wb') as f:
                    f.write(b'yt-audio')
                return 8

            with patch.object(api, '_resolve_youtube_audio_stream', return_value=(yt_stream, None, {})), \
                    patch.object(api, '_download_googlevideo_chunked', side_effect=fake_chunked), \
                    patch.object(api, 'measure_local_gain_db', return_value=(None, False)), \
                    contextlib.redirect_stdout(io.StringIO()) as out_yt:
                api.handle_request({
                    'command': 'download_track',
                    'url': 'https://music.youtube.com/watch?v=dQw4w9WgXcQ',
                    'videoId': 'dQw4w9WgXcQ',
                    'songsPath': tmpdir,
                    'callId': 'dt-yt-unmeasured',
                })
            final_yt = [json.loads(line) for line in out_yt.getvalue().splitlines() if '"status": "ok"' in line][-1]
            self.assertEqual(final_yt['gainDb'], 0.0)
            self.assertFalse(final_yt['gainMeasured'])

            # download_direct yt_api success path тоже отдает gainMeasured
            with patch.object(api.requests, 'get', return_value=_FakeResponse(b'yt-api-audio', 200, {'Content-Length': '12'})), \
                    patch.object(local_media, 'measure_loudness_full', return_value=(1.25, -1.0)), \
                    contextlib.redirect_stdout(io.StringIO()) as out_ytapi:
                api.handle_request({
                    'command': 'download_direct',
                    'url': 'https://www.youtube.com/api/timedtext?foo=1',
                    'videoId': 'dQw4w9WgXcQ',
                    'songsPath': tmpdir,
                    'callId': 'dd-ytapi-ok',
                })
            final_ytapi = [json.loads(line) for line in out_ytapi.getvalue().splitlines() if '"status": "ok"' in line][-1]
            self.assertAlmostEqual(final_ytapi['gainDb'], 1.25)
            self.assertTrue(final_ytapi['gainMeasured'])


class SoundCloudThumbFallbackContract(unittest.TestCase):
    def test_sc_pick_track_thumb_fallback_order_and_default_avatar_filter(self):
        pick = soundcloud._sc_pick_track_thumb
        self.assertEqual(
            pick({
                'artwork_url': 'https://i1.sndcdn.com/artworks-1-large.jpg',
                'user': {'avatar_url': 'https://i1.sndcdn.com/avatars-1-large.jpg'},
            }),
            'https://i1.sndcdn.com/artworks-1-t500x500.jpg',
        )
        self.assertEqual(
            pick({
                'artwork_url': None,
                'user': {'avatar_url': 'https://i1.sndcdn.com/avatars-1-large.jpg'},
            }),
            'https://i1.sndcdn.com/avatars-1-t500x500.jpg',
        )
        self.assertEqual(
            pick({'artwork_url': ''}, fallback_user={'avatar_url': 'https://i1.sndcdn.com/avatars-2-large.jpg'}),
            'https://i1.sndcdn.com/avatars-2-t500x500.jpg',
        )
        self.assertEqual(
            pick({
                'artwork_url': None,
                'user': {'avatar_url': 'https://a1.sndcdn.com/images/default_avatar_large.png'},
            }),
            '',
        )
        self.assertEqual(
            pick({'artwork_url': None}, fallback_user={'avatar_url': 'https://a1.sndcdn.com/images/default_avatar_large.png'}),
            '',
        )

    def test_sc_pick_track_thumb_guards_non_dict_users_and_non_string_urls(self):
        pick = soundcloud._sc_pick_track_thumb
        av_large = 'https://i1.sndcdn.com/avatars-safe-large.jpg'
        av_500 = 'https://i1.sndcdn.com/avatars-safe-t500x500.jpg'

        # Не-строковый truthy artwork_url игнорируется и откатывается к аватару автора
        self.assertEqual(
            pick({'artwork_url': 12345, 'user': {'avatar_url': av_large}}),
            av_500,
        )
        self.assertEqual(
            pick({'artwork_url': {'nested': True}, 'user': {'avatar_url': 999}}, fallback_user={'avatar_url': av_large}),
            av_500,
        )
        # Не-dict truthy user / fallback_user не падают с AttributeError
        self.assertEqual(
            pick({'artwork_url': None, 'user': 'invalid-user'}, fallback_user={'avatar_url': av_large}),
            av_500,
        )
        self.assertEqual(
            pick({'artwork_url': None, 'user': ['bad']}, fallback_user=42),
            '',
        )
        self.assertEqual(
            pick({'artwork_url': 777, 'user': None}, fallback_user='not-a-dict'),
            '',
        )
        self.assertEqual(pick('not-a-dict', fallback_user={'avatar_url': av_large}), '')

    def test_soundcloud_builders_apply_avatar_fallback(self):
        avatar_large = 'https://i1.sndcdn.com/avatars-artist-large.jpg'
        avatar_500 = 'https://i1.sndcdn.com/avatars-artist-t500x500.jpg'
        default_av = 'https://a1.sndcdn.com/images/default_avatar_large.png'

        def fake_get(path, params, oauth_token=None):
            if path == '/resolve' and params.get('url') == 'https://soundcloud.com/artist':
                return {'id': 1, 'username': 'Art', 'permalink_url': 'https://soundcloud.com/artist', 'avatar_url': avatar_large}
            if path.startswith('/users/1/tracks'):
                return {'collection': [
                    {'id': 10, 'permalink_url': 'https://soundcloud.com/artist/t1', 'title': 'T1', 'duration': 60000, 'artwork_url': None, 'user': {'username': 'Art'}},
                    {'id': 11, 'permalink_url': 'https://soundcloud.com/artist/t2', 'title': 'T2', 'duration': 60000, 'artwork_url': None, 'user': {'username': 'Art', 'avatar_url': default_av}},
                ]}
            if path == '/users/1/albums':
                return {'collection': [{'permalink_url': 'https://soundcloud.com/artist/sets/a1', 'title': 'A1', 'artwork_url': None, 'track_count': 2, 'created_at': '2025-01-01'}]}
            if path == '/users/1/playlists':
                return {'collection': [{'permalink_url': 'https://soundcloud.com/artist/sets/p1', 'title': 'P1', 'artwork_url': None, 'track_count': 3}]}
            if path == '/users/1/followings':
                return {'collection': []}
            if path == '/search/users':
                return {'collection': []}
            if path == '/search/albums':
                return {'collection': [{'permalink_url': 'https://soundcloud.com/artist/sets/sa', 'title': 'SA', 'artwork_url': None, 'user': {'username': 'Art', 'avatar_url': avatar_large}}]}
            if path == '/me':
                return {'id': 42}
            if path == '/playlists/99':
                return {'title': 'PL', 'artwork_url': None, 'user': {'avatar_url': avatar_large}, 'tracks': [
                    {'id': 20, 'permalink_url': 'https://soundcloud.com/artist/pt', 'title': 'PT', 'duration': 30000, 'artwork_url': None, 'user': {'username': 'Art', 'avatar_url': avatar_large}},
                ]}
            if path == '/tracks' and params.get('ids') == '20':
                return [{'id': 20, 'permalink_url': 'https://soundcloud.com/artist/pt', 'title': 'PT', 'duration': 30000, 'artwork_url': None, 'user': {'username': 'Art', 'avatar_url': avatar_large}}]
            if path == '/tracks/10/related':
                return {'collection': [{'id': 30, 'permalink_url': 'https://soundcloud.com/artist/rel', 'title': 'Rel', 'duration': 45000, 'artwork_url': None, 'user': {'username': 'Art', 'avatar_url': avatar_large}}]}
            if path == '/resolve' and params.get('url') == 'https://soundcloud.com/artist/sets/pl':
                return {'id': 99, 'user': {'avatar_url': avatar_large}}
            if path == '/resolve' and params.get('url') == 'https://soundcloud.com/artist/t1':
                return {'kind': 'track', 'id': 10, 'title': 'T1', 'duration': 60000, 'artwork_url': None, 'user': {'username': 'Art', 'avatar_url': avatar_large, 'permalink_url': 'https://soundcloud.com/artist'}}
            return None

        sc = soundcloud.SoundCloudCommands(fake_get, lambda tok=None: {}, lambda: 'cid')

        def run_cmd(fn, req):
            emitted = []
            ctx = CommandContext('c1', emitted.append, lambda: None, lambda: None, lambda: False)
            fn(req, ctx)
            return emitted[-1]

        art = run_cmd(sc.get_soundcloud_artist, {'url': 'https://soundcloud.com/artist'})
        by_id = {t['scId']: t for t in art['results']}
        self.assertEqual(by_id['10']['thumbUrl'], avatar_500)
        self.assertEqual(by_id['11']['thumbUrl'], '')
        self.assertEqual(art['albums'][0]['thumbUrl'], avatar_500)
        self.assertEqual(art['playlists'][0]['thumbUrl'], avatar_500)

        extra = run_cmd(sc.search_soundcloud_extra, {'query': 'art'})
        self.assertEqual(extra['albums'][0]['thumbUrl'], avatar_500)

        st = run_cmd(sc.sc_station_tracks, {'id': '99'})
        self.assertEqual(st['results'][0]['thumbUrl'], avatar_500)

        rec = run_cmd(sc.sc_recommendations, {'scId': '10'})
        self.assertEqual(rec['results'][0]['thumbUrl'], avatar_500)

        pl = run_cmd(sc.get_soundcloud_playlist, {'url': 'https://soundcloud.com/artist/sets/pl'})
        self.assertEqual(pl['thumbUrl'], avatar_500)
        self.assertEqual(pl['tracks'][0]['thumbUrl'], avatar_500)

        res = run_cmd(sc.resolve_sc_track, {'url': 'https://soundcloud.com/artist/t1'})
        self.assertEqual(res['thumbUrl'], avatar_500)

        fake_likes_resp = MagicMock(ok=True)
        fake_likes_resp.json.return_value = {
            'collection': [{
                'created_at': '2026-01-01T00:00:00Z',
                'track': {
                    'id': 50,
                    'permalink_url': 'https://soundcloud.com/artist/liked',
                    'title': 'Liked',
                    'duration': 50000,
                    'artwork_url': None,
                    'user': {'username': 'Art', 'avatar_url': avatar_large, 'permalink_url': 'https://soundcloud.com/artist'},
                },
            }],
            'next_href': None,
        }
        with patch.object(soundcloud.requests, 'get', return_value=fake_likes_resp):
            liked = run_cmd(sc.sc_liked_tracks, {'token': 'tok'})
        self.assertEqual(liked['results'][0]['thumbUrl'], avatar_500)


class LyricsCancellationContract(unittest.TestCase):
    def test_get_lyrics_returns_cancelled_immediately_when_already_cancelled(self):
        emitted = []
        ctx = CommandContext('lyr-pre', emitted.append, MagicMock(), MagicMock(), lambda: True)
        with patch.object(lyrics.requests, 'get') as mock_get, \
                patch.object(lyrics, 'fetch_genius_lyrics') as mock_genius, \
                patch.object(lyrics, 'fetch_lyrics_ovh') as mock_ovh:
            lyrics.get_lyrics({'artist': 'Radiohead', 'title': 'Creep', 'videoId': 'vid1', 'yandexId': '123'}, ctx)
        mock_get.assert_not_called()
        mock_genius.assert_not_called()
        mock_ovh.assert_not_called()
        ctx.get_yandex_client.assert_not_called()
        self.assertEqual(emitted, [{'status': 'error', 'message': 'Cancelled by client', 'callId': 'lyr-pre'}])

    def test_get_lyrics_cancels_parallel_race_without_blocking_on_slow_providers(self):
        entered = Event()
        release = Event()
        cancelled = Event()
        emitted = []

        def slow_get(*args, **kwargs):
            entered.set()
            release.wait(timeout=5)
            return MagicMock(status_code=404)

        class SlowYT:
            def get_watch_playlist(self, **kwargs):
                entered.set()
                release.wait(timeout=5)
                return None

        ctx = CommandContext('lyr-race', emitted.append, lambda: SlowYT(), lambda: None, cancelled.is_set)
        fake_sl = MagicMock()
        fake_sl.search.side_effect = lambda *a, **kw: (entered.set(), release.wait(timeout=5), None)[-1]

        t0 = time.monotonic()
        try:
            with patch.object(lyrics.requests, 'get', side_effect=slow_get), \
                    patch.dict('sys.modules', {'syncedlyrics': fake_sl}), \
                    patch.object(lyrics, 'fetch_genius_lyrics') as mock_genius, \
                    patch.object(lyrics, 'fetch_lyrics_ovh') as mock_ovh:
                worker = Thread(
                    target=lyrics.get_lyrics,
                    args=({'artist': 'Artist', 'title': 'Song', 'videoId': 'vid1'}, ctx),
                )
                worker.start()
                self.assertTrue(entered.wait(timeout=2))
                cancelled.set()
                worker.join(timeout=1.5)
                elapsed = time.monotonic() - t0
                self.assertFalse(worker.is_alive(), 'get_lyrics hung waiting for slow providers after cancel')
                self.assertLess(elapsed, 1.5)
                mock_genius.assert_not_called()
                mock_ovh.assert_not_called()
        finally:
            release.set()

        self.assertEqual(emitted, [{'status': 'error', 'message': 'Cancelled by client', 'callId': 'lyr-race'}])

    def test_get_lyrics_returns_synced_hit_without_waiting_for_slow_providers(self):
        release = Event()
        emitted = []

        def fast_exact_slow_search(url, *args, **kwargs):
            if '/api/get' in url:
                resp = MagicMock(status_code=200)
                resp.json.return_value = {'plainLyrics': 'hello', 'syncedLyrics': '[00:01.00]hello'}
                return resp
            release.wait(timeout=5)
            return MagicMock(status_code=404)

        class SlowYT:
            def get_watch_playlist(self, **kwargs):
                release.wait(timeout=5)
                return None

        ctx = CommandContext('lyr-fast', emitted.append, lambda: SlowYT(), lambda: None, lambda: False)
        fake_sl = MagicMock()
        fake_sl.search.side_effect = lambda *a, **kw: (release.wait(timeout=5), None)[-1]

        t0 = time.monotonic()
        try:
            with patch.object(lyrics.requests, 'get', side_effect=fast_exact_slow_search), \
                    patch.dict('sys.modules', {'syncedlyrics': fake_sl}):
                lyrics.get_lyrics({'artist': 'Artist', 'title': 'Song', 'videoId': 'vid1'}, ctx)
            elapsed = time.monotonic() - t0
        finally:
            release.set()

        self.assertLess(elapsed, 1.5)
        self.assertEqual(len(emitted), 1)
        self.assertEqual(emitted[0]['status'], 'ok')
        self.assertEqual(emitted[0]['syncedLyrics'], '[00:01.00]hello')

    def test_fetch_genius_lyrics_stops_between_queries_when_cancelled(self):
        calls = []
        cancelled = Event()

        def fake_get(url, *args, **kwargs):
            calls.append((url, kwargs.get('params')))
            cancelled.set()
            resp = MagicMock(status_code=200)
            resp.json.return_value = {'response': {'sections': []}}
            return resp

        with patch.object(lyrics.requests, 'get', side_effect=fake_get):
            res = lyrics.fetch_genius_lyrics('Artist', 'Title (Alt)', is_cancelled=cancelled.is_set)
        self.assertIsNone(res)
        self.assertEqual(len(calls), 1)

    def test_api_cancel_command_propagates_to_get_lyrics_via_handle_request(self):
        entered = Event()
        release = Event()

        def slow_get(*args, **kwargs):
            entered.set()
            release.wait(timeout=5)
            return MagicMock(status_code=404)

        fake_sl = MagicMock()
        fake_sl.search.side_effect = lambda *a, **kw: (entered.set(), release.wait(timeout=5), None)[-1]

        try:
            with patch.object(lyrics.requests, 'get', side_effect=slow_get), \
                    patch.dict('sys.modules', {'syncedlyrics': fake_sl}), \
                    patch.object(lyrics, 'fetch_genius_lyrics') as mock_genius, \
                    contextlib.redirect_stdout(io.StringIO()) as out:
                worker = Thread(
                    target=api.handle_request,
                    args=({'command': 'get_lyrics', 'artist': 'A', 'title': 'T', 'callId': 'lyr-api-cancel'},),
                )
                worker.start()
                self.assertTrue(entered.wait(timeout=2))
                api.handle_request({'command': 'cancel', 'callId': 'lyr-api-cancel'})
                worker.join(timeout=1.5)
                self.assertFalse(worker.is_alive())
                mock_genius.assert_not_called()
            # Отмененный вызов не должен ничего писать в stdout
            self.assertEqual(out.getvalue().strip(), '')
        finally:
            release.set()

    def test_get_lyrics_cancels_after_yandex_and_before_ovh_fallback(self):
        # 1) Отмена во время Yandex lookup не идет дальше в параллельные провайдеры
        cancelled = Event()
        emitted = []

        class FakeYandexClient:
            def tracks_lyrics(self, track_id, format_='LRC'):
                cancelled.set()
                return MagicMock(download_url='https://yandex.example/lrc')

        ctx = CommandContext('lyr-ya', emitted.append, MagicMock(), lambda: FakeYandexClient(), cancelled.is_set)
        with patch.object(lyrics.requests, 'get') as mock_get, \
                patch.object(lyrics, 'fetch_genius_lyrics') as mock_genius:
            lyrics.get_lyrics({'artist': 'A', 'title': 'T', 'yandexId': '777'}, ctx)
        mock_get.assert_not_called()
        mock_genius.assert_not_called()
        self.assertEqual(emitted, [{'status': 'error', 'message': 'Cancelled by client', 'callId': 'lyr-ya'}])

        # 2) Отмена во время Genius не запускает lyrics.ovh
        cancelled2 = Event()
        emitted2 = []
        ctx2 = CommandContext('lyr-ovh', emitted2.append, lambda: None, lambda: None, cancelled2.is_set)

        def fake_genius(artist, title, is_cancelled=None):
            cancelled2.set()
            return None

        fake_sl = MagicMock()
        fake_sl.search.return_value = None
        with patch.object(lyrics.requests, 'get', return_value=MagicMock(status_code=404)), \
                patch.dict('sys.modules', {'syncedlyrics': fake_sl}), \
                patch.object(lyrics, 'fetch_genius_lyrics', side_effect=fake_genius), \
                patch.object(lyrics, 'fetch_lyrics_ovh') as mock_ovh:
            lyrics.get_lyrics({'artist': 'A', 'title': 'T'}, ctx2)
        mock_ovh.assert_not_called()
        self.assertEqual(emitted2, [{'status': 'error', 'message': 'Cancelled by client', 'callId': 'lyr-ovh'}])


if __name__ == '__main__':
    unittest.main()
