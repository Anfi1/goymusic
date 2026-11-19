"""Verify the extracted Windows release, not the source tree or target directory."""

from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
from queue import Queue
import shutil
import ssl
import subprocess
import sys
import tempfile
from threading import Thread
import time
import wave

from pycaw.pycaw import AudioUtilities, IAudioMeterInformation
import trustme
import win32gui
import win32process


def verify_rpc(bundle, cwd, env):
    with subprocess.Popen(
        [bundle / "python/bin/python.exe", "-I", "-B", "-u", bundle / "python/api.py"],
        cwd=cwd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
    ) as rpc:
        try:
            reply = Queue()
            Thread(target=lambda: reply.put(rpc.stdout.readline()), daemon=True).start()
            rpc.stdin.write(b'{"command":"ping","callId":"portable-smoke"}\n')
            rpc.stdin.flush()  # The server dispatches in a worker: keep stdin open until its reply.
            response = json.loads(reply.get(timeout=45))
            if response != {"status": "ok", "data": "pong", "callId": "portable-smoke"}:
                raise RuntimeError(f"Unexpected RPC response: {response!r}")
        finally:
            rpc.kill()


def track_window(pid, stem):
    matches = []

    def inspect(hwnd, _):
        if win32gui.IsWindowVisible(hwnd) and win32process.GetWindowThreadProcessId(hwnd)[1] == pid:
            title = win32gui.GetWindowText(hwnd)
            l, t, r, b = win32gui.GetClientRect(hwnd)
            if stem in title and r - l > 100 and b - t > 100:
                matches.append(title)
        return True

    win32gui.EnumWindows(inspect, None)
    return matches


def verify_local_playback(bundle, cwd, env):
    # A fresh filename (with spaces) proves the CLI argument reached the real window.
    fixture = cwd / f"Deck smoke {os.urandom(4).hex()}.mp3"
    subprocess.run([
        bundle / "tools/ffmpeg.exe", "-v", "error", "-f", "lavfi", "-i",
        "sine=frequency=440:duration=60", "-codec:a", "libmp3lame", fixture,
    ], cwd=cwd, env=env, check=True, timeout=15)
    verify_player(bundle, cwd, env, fixture, fixture.stem)


def verify_player(bundle, cwd, env, source, stem):
    with subprocess.Popen([bundle / "goymusic-native.exe", source], cwd=cwd, env=env) as player:
        try:
            deadline = time.monotonic() + 45
            meter = None
            peak = 0.0
            while time.monotonic() < deadline:
                if player.poll() is not None:
                    raise RuntimeError(f"Deck exited early: {player.returncode}")
                titles = track_window(player.pid, stem)
                if meter is None:
                    session = AudioUtilities.GetProcessSession(player.pid)
                    if session is not None:
                        meter = session._ctl.QueryInterface(IAudioMeterInformation)
                if meter is not None:
                    peak = max(peak, meter.GetPeakValue())
                if titles and peak > 0.001:
                    print(f"Verified visible window {titles[0]!r} and WASAPI peak {peak:.4f} for PID {player.pid}")
                    return
                time.sleep(0.1)
            raise RuntimeError(f"Missing fixture window or real Deck output: titles={titles}, peak={peak}")
        finally:
            # Let the player drop the decoder and release the extracted files on Windows.
            def close(hwnd, _):
                if win32process.GetWindowThreadProcessId(hwnd)[1] == player.pid:
                    win32gui.PostMessage(hwnd, 0x0010, 0, 0)  # WM_CLOSE
                return True
            win32gui.EnumWindows(close, None)
            try:
                player.wait(timeout=8)
            except subprocess.TimeoutExpired:
                player.kill()
                raise RuntimeError("Deck failed to close after playback")


def verify_tls(bundle, cwd, env, packaged_ca):
    # No external server, system trust changes or private keys in the portable ZIP.
    media = cwd / "tls-media"
    media.mkdir()
    fixture = media / f"deck-online-{os.urandom(4).hex()}.wav"
    # 60 seconds of a 1 kHz square wave. Long enough to observe the live audio session.
    samples = (b"\x00\x20" * 4 + b"\x00\xe0" * 4) * 60000
    with wave.open(str(fixture), "wb") as wav:
        wav.setparams((1, 2, 8000, 0, "NONE", "not compressed"))
        wav.writeframes(samples)
    authority = trustme.CA()
    trusted = cwd / "fixture-ca.pem"
    authority.cert_pem.write_to_path(trusted)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    authority.issue_cert("127.0.0.1").configure_cert(context)
    handler = partial(SimpleHTTPRequestHandler, directory=media)
    with ThreadingHTTPServer(("127.0.0.1", 0), handler) as server:
        server.socket = context.wrap_socket(server.socket, server_side=True)
        worker = Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            url = f"https://127.0.0.1:{server.server_port}/{fixture.name}"
            loopback_env = {**env, "NO_PROXY": "127.0.0.1"}
            for store in (packaged_ca, trusted):
                decoded = subprocess.run([
                    bundle / "tools/ffmpeg.exe", "-nostdin", "-v", "error", "-xerror",
                    "-protocol_whitelist", "https,tls,tcp,crypto", "-tls_verify", "1",
                    "-ca_file", store, "-i", url, "-map", "0:a:0", "-c:a", "pcm_s16le",
                    "-f", "s16le", "pipe:1",
                ], cwd=cwd, env=loopback_env, capture_output=True, timeout=10)
                if store == trusted:
                    if decoded.returncode != 0 or decoded.stdout != samples:
                        raise RuntimeError(f"Trusted HTTPS fixture did not decode: {decoded.stderr!r}")
                elif decoded.returncode == 0 or decoded.stdout:
                    raise RuntimeError("FFmpeg accepted a certificate outside the packaged trust store")

            # Exercise URL entry, TLS options, actual render and title in the shipped app.
            # Trust the private CA only in an independent copy, never the release candidate.
            trusted_bundle = cwd / "Deck with test CA"
            shutil.copytree(bundle, trusted_bundle)
            with (trusted_bundle / packaged_ca.relative_to(bundle)).open("ab") as pem:
                pem.write(b"\n" + authority.cert_pem.bytes())
            verify_player(trusted_bundle, cwd, loopback_env, url, fixture.stem)
        finally:
            server.shutdown()
            worker.join()


def smoke(bundle):
    ca = bundle / "python/bin/Lib/site-packages/certifi/cacert.pem"
    if not ca.is_file() or b"-----BEGIN CERTIFICATE-----" not in ca.read_bytes():
        raise RuntimeError("Missing CA trust bundle for HTTPS playback")
    with tempfile.TemporaryDirectory() as scratch:
        cwd = Path(scratch)
        env = dict(os.environ)
        # No globally installed Python, ffmpeg, Node, or repo resources on PATH.
        windows = Path(env["SystemRoot"])
        env.update(PATH=os.pathsep.join(map(str, [windows / "System32", windows])), GOYMUSIC_USER_DATA=scratch)
        env.pop("PYTHONPATH", None)
        env.pop("PYTHONHOME", None)
        verify_rpc(bundle, cwd, env)
        verify_tls(bundle, cwd, env, ca)
        verify_local_playback(bundle, cwd, env)


if __name__ == "__main__":
    try:
        smoke(Path(sys.argv[1]).resolve(strict=True))
    except Exception as error:
        print(f"::error::{type(error).__name__}: {error}", flush=True)
        raise
