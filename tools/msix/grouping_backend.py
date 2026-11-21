"""Однократная проба группировки: реальный бэкенд и отдельный диагностический Node."""
import json
import os
from pathlib import Path
import runpy
import subprocess

from nodejs_wheel.executable import ROOT_DIR

profile = Path(os.environ['GOYMUSIC_USER_DATA'])
(profile / 'grouping-probe.request').unlink()
# Чтение stdin удерживает Node, закрытие канала вместе с Python завершает его.
with subprocess.Popen([str(Path(ROOT_DIR) / 'node.exe'), '-e',
                       'process.stdin.resume(); setTimeout(() => process.exit(), 300000).unref()'],
                      stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                      creationflags=subprocess.CREATE_NO_WINDOW) as child:
    record = profile / 'grouping-probe.json'
    tmp = record.with_suffix('.tmp')
    tmp.write_text(json.dumps({'pythonPid': os.getpid(), 'nodePid': child.pid,
                               'kind': 'controlled-bundled-node'}), encoding='utf-8')
    tmp.replace(record)
    try:
        runpy.run_path(str(Path(__file__).with_name('api.py')), run_name='__main__')
    finally:
        child.stdin.close()
