"""Disposable Windows runner only. The actual backend follows in the same Python process."""
import ctypes
import json
import os
from pathlib import Path
import subprocess

from nodejs_wheel.executable import ROOT_DIR

folder = Path(__file__).resolve().parent
mode = (folder / 'group-mode.txt').read_text(encoding='ascii').strip()
args = [str(Path(ROOT_DIR) / 'node.exe'), '-e']
js = 'process.stdin.resume();setTimeout(()=>process.exit(),240000).unref();'
if mode == 'app-id':
    ctypes.OleDLL('shell32').SetCurrentProcessExplicitAppUserModelID(ctypes.c_wchar_p('com.goymusic.app'))
    js = 'require(process.argv[1]);' + js
    args.extend([js, str(folder / 'lab-app-id.node')])
else:
    args.append(js)
# No login, media or network request. Node exits on EOF when the backend exits.
child = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW)
ready = folder / 'group-ready.json'
tmp = ready.with_suffix('.tmp')
tmp.write_text(json.dumps({'parent': os.getppid(), 'python': os.getpid(), 'node': child.pid}), encoding='ascii')
tmp.replace(ready)
