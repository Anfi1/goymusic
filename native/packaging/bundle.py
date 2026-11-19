"""Assemble the Windows ZIP from a locked native build and tracked RPC sources."""

import hashlib
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from urllib.request import urlretrieve
from zipfile import ZIP_DEFLATED, ZipFile


ROOT = Path(__file__).resolve().parents[2]
PYTHON = "3.13.2"
EMBED_SHA256 = "1e803610b140cbf69dfa2ceaaeb39651bef75a239c381289e827c30862a27b93"
FORK_INFO = "python/fork/ytmusicapi-1.11.5.dist-info"


def bundle(executable: Path, output: Path) -> None:
    if sys.platform != "win32" or sys.version_info[:2] != (3, 13) or sys.maxsize <= 2**32:
        raise RuntimeError("Install dependencies using 64-bit Windows Python 3.13")
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        stage = work / "portable"
        pybin = stage / "python/bin"
        tools = stage / "tools"
        tools.mkdir(parents=True)
        shutil.copyfile(executable, stage / "goymusic-native.exe")

        # Never copy a working directory (including python/ or the rest of fork/).
        src = work / "tracked.zip"
        subprocess.run([
            "git", "archive", "-o", src, "HEAD", "python/api.py", "python/requirements.txt",
            "python/fork/ytmusicapi", f"{FORK_INFO}/METADATA", f"{FORK_INFO}/licenses/LICENSE",
        ], cwd=ROOT, check=True)
        with ZipFile(src) as tracked:
            tracked.extract("python/requirements.txt", work)
            for name in tracked.namelist():
                if name in {"python/api.py", f"{FORK_INFO}/METADATA", f"{FORK_INFO}/licenses/LICENSE"} or re.fullmatch(
                    r"python/fork/ytmusicapi/(?:(?:[\w]+/)*[\w]+\.py|locales/[\w-]+/LC_MESSAGES/base\.mo)", name
                ):
                    tracked.extract(name, stage)

        embed = work / "embed.zip"
        urlretrieve(f"https://www.python.org/ftp/python/{PYTHON}/python-{PYTHON}-embed-amd64.zip", embed)
        with embed.open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != EMBED_SHA256:
                raise RuntimeError("Unexpected embeddable CPython archive digest")
        with ZipFile(embed) as archive:
            archive.extractall(pybin)
        (pybin / "python313._pth").write_text("python313.zip\n.\nLib/site-packages\nimport site\n", encoding="ascii")

        # Use the full host interpreter to build sdists, not pip/get-pip in the bundle.
        site = pybin / "Lib/site-packages"
        subprocess.run([
            sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "--no-compile",
            "--target", site, "-r", work / "python/requirements.txt", "imageio-ffmpeg==0.6.0",
        ], check=True)
        # Host pip's generated command-line stubs refer to the build machine's Python.
        for directory in (site / "Scripts", site / "bin"):
            if directory.is_dir():
                shutil.rmtree(directory)
        decoder = tools / "ffmpeg.exe"
        (site / "imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe").rename(decoder)
        notices = tools / "ffmpeg-licenses"
        notices.mkdir()
        ffmpeg_source = "https://github.com/FFmpeg/FFmpeg/tree/n7.1"
        with (notices / "BUILD.txt").open("wb") as info:
            info.write((
                "Unmodified FFmpeg executable distributed by imageio-ffmpeg 0.6.0.\n"
                "Distribution: https://pypi.org/project/imageio-ffmpeg/0.6.0/\n"
                f"Upstream source: {ffmpeg_source}\n\n"
            ).encode("ascii"))
            info.flush()
            for option in ("-version", "-L"):
                subprocess.run([decoder, option], stdout=info, stderr=subprocess.STDOUT, check=True)
        for name in ("LICENSE.md", "COPYING.GPLv2", "COPYING.GPLv3", "COPYING.LGPLv2.1", "COPYING.LGPLv3"):
            urlretrieve(f"https://raw.githubusercontent.com/FFmpeg/FFmpeg/n7.1/{name}", notices / name)

        output.parent.mkdir(parents=True, exist_ok=True)
        with ZipFile(output, "x", ZIP_DEFLATED, compresslevel=6) as archive:
            for path in sorted(stage.rglob("*")):
                if path.is_file():
                    archive.write(path, path.relative_to(stage))


if __name__ == "__main__":
    bundle(Path(sys.argv[1]), Path(sys.argv[2]))
