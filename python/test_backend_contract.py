"""Cancellation belongs to a callId, not the provider or worker thread."""
import contextlib
import io
import json
import os
import tempfile
from threading import Event, Lock, Thread
import unittest
from unittest.mock import MagicMock, patch
from urllib.parse import parse_qsl, urlparse

import requests

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
                    patch.object(api, '_ffmpeg_loudness_i', return_value=-12.0), \
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
                    patch.object(api, '_ffmpeg_loudness_i', return_value=-15.0), \
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


if __name__ == '__main__':
    unittest.main()
