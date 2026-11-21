const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { performance } = require('node:perf_hooks');
const { chromium } = require('playwright-core');

const [rootPid, port, profile] = process.argv.slice(2);
const filename = 'ram-local.wav';
const trackSeconds = 180;
const settleSeconds = 15;
const run = promisify(execFile);

// A real, non-silent 3-minute PCM track; generate one second once, outside the app tree.
function writeWave(file) {
  const rate = 44100, channels = 2, frameBytes = 4;
  const second = Buffer.alloc(rate * frameBytes);
  for (let i = 0; i < rate; i++) {
    const sample = Math.round(1500 * Math.sin(2 * Math.PI * 440 * i / rate));
    second.writeInt16LE(sample, i * frameBytes);
    second.writeInt16LE(sample, i * frameBytes + 2);
  }
  const size = second.length * trackSeconds;
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(size + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(second.length, 28); header.writeUInt16LE(frameBytes, 32);
  header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(size, 40);
  const fd = fs.openSync(file, 'wx');
  try {
    fs.writeSync(fd, header);
    for (let i = 0; i < trackSeconds; i++) fs.writeSync(fd, second);
  } finally { fs.closeSync(fd); }
}

async function primeQueue(page) {
  // The signed-out view has no Local sidebar or PlayerBar. Restore the same queue and
  // IndexedDB override that the desktop player normally loads; never construct/play audio here.
  await page.evaluate(async ({ filename, trackSeconds }) => {
    const duration = `${Math.floor(trackSeconds / 60)}:${String(trackSeconds % 60).padStart(2, '0')}`;
    const track = { id: 'ram-local', title: 'RAM measurement', artists: ['CI'], album: '', thumbUrl: '', duration };
    if (!await window.bridge.songFileExists(filename)) throw new Error('Local fixture missing');
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('goymusic-overrides', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('overrides', { keyPath: 'videoId' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction('overrides', 'readwrite');
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error || new Error('Could not persist local override'));
        tx.objectStore('overrides').put({ videoId: track.id, filename, sourceUrl: '', sourceType: 'local', gainDb: 0, addedAt: Date.now() });
      });
    } finally { db.close(); }
    localStorage.setItem('ytm-last-track', JSON.stringify(track));
    localStorage.setItem('ytm-queue', JSON.stringify([track]));
    localStorage.setItem('ytm-queue-index', '0');
    localStorage.setItem('ytm-queue-source', 'LOCAL');
    localStorage.setItem('ytm-queue-source-type', 'playlist');
    localStorage.setItem('ytm-autoplay', 'false'); // no online continuation after the QA track
  }, { filename, trackSeconds });
  await page.reload();
}

async function mediaProbe(session, fileUrl) {
  // PlayerStore's A/B elements are detached from the DOM. Obtain their real browser
  // handles once before ALL measurement windows; do not patch play() or force GC per sample.
  const { result } = await session.send('Runtime.evaluate', { expression: 'HTMLAudioElement.prototype' });
  const { objects } = await session.send('Runtime.queryObjects', { prototypeObjectId: result.objectId });
  return async () => {
    const { result, exceptionDetails } = await session.send('Runtime.callFunctionOn', {
      objectId: objects.objectId, returnByValue: true,
      functionDeclaration: `function () { return this.map((a, index) => ({ index, src: a.currentSrc, time: a.currentTime,
        duration: Number.isFinite(a.duration) ? a.duration : null, active: !a.paused && !a.ended && !a.error })); }`,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    const elements = result.value;
    if (elements.length < 2) throw new Error('Player A/B audio elements not found');
    const active = elements.filter(a => a.active);
    if (!active.length) return { active: false };
    const a = active[0];
    if (active.length !== 1 || a.src !== fileUrl || Math.abs(a.duration - trackSeconds) > 0.01) {
      throw new Error('Unexpected media playing instead of the isolated WAV');
    }
    return { active: true, index: a.index, currentTime: a.time, duration: a.duration };
  };
}

const round = n => Math.round(n * 100) / 100;
const median = ns => [...ns].sort((a, b) => a - b)[Math.floor(ns.length / 2)]; // seven samples
async function measure(mode, probe) {
  await delay(settleSeconds * 1000);
  const before = await probe();
  if (before.active !== (mode !== 'idle')) throw new Error(`Wrong playback state before ${mode}`);
  const start = performance.now();
  const { stdout } = await run('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'ram-sample.ps1'), '-RootPid', rootPid, '-Mode', mode], { timeout: 90000, windowsHide: true });
  const after = await probe();
  const elapsed = (performance.now() - start) / 1000;
  if (after.active !== before.active || after.index !== before.index || (before.active && after.currentTime - before.currentTime < elapsed * 0.8)) {
    throw new Error(`Playback did not remain in ${mode} for the measurement window: ${JSON.stringify({ before, after, elapsed })}`);
  }
  const samples = JSON.parse(stdout);
  const byRole = samples.map(({ processes }) => {
    const row = {};
    for (const p of processes) row[p.role] = (row[p.role] || 0) + p.privateWorkingSetBytes;
    return row;
  });
  const roles = [...new Set(byRole.flatMap(row => Object.keys(row)))].sort();
  const totals = byRole.map(r => Object.values(r).reduce((a, b) => a + b, 0) / 2 ** 20);
  return {
    minMiB: round(Math.min(...totals)), medianMiB: round(median(totals)), maxMiB: round(Math.max(...totals)),
    roleMedianMiB: Object.fromEntries(roles.map(role => [role, round(median(byRole.map(r => r[role] || 0)) / 2 ** 20)])),
    elapsedSeconds: round(elapsed), playbackBefore: before, playbackAfter: after, samples,
  };
}

async function main() {
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60000;
  while (!(await fetch(`${endpoint}/json/version`).catch(() => null))?.ok) {
    if (Date.now() >= deadline) throw new Error('Installed player did not expose its debugging port');
    await delay(250);
  }
  const browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  let page;
  while (!(page = context.pages().find(p => /^file:.*\/dist\/index\.html$/.test(p.url())))) {
    if (Date.now() >= deadline) throw new Error('Installed renderer did not load');
    await delay(200);
  }
  const guest = page.getByRole('button', { name: 'Sign in with YouTube', exact: true });
  await guest.waitFor({ timeout: 60000 }); // readiness only: never click Sign in
  const dir = await page.evaluate(() => window.bridge.getSongsPath());
  if (path.relative(path.join(profile, 'songs'), dir) !== '') throw new Error('Renderer did not use isolated profile');
  const file = path.join(dir, filename);
  writeWave(file);
  await primeQueue(page);
  await guest.waitFor({ timeout: 60000 });
  const display = await page.evaluate(() => ({
    screenWidth: screen.width, screenHeight: screen.height, viewportWidth: innerWidth, viewportHeight: innerHeight, devicePixelRatio,
    layout: document.documentElement.dataset.layout === 'deck' ? 'deck' : 'classic', nyanEnabled: document.documentElement.dataset.nyan === 'on',
  }));
  const session = await context.newCDPSession(page);
  const probe = await mediaProbe(session, pathToFileURL(file).href);
  // At +5 s the ordinary packaged startup can create a second hidden BrowserWindow for ~15 s.
  // Do not suppress it or subtract its RAM. Let it finish before the comparable steady-state samples.
  await delay(6000);
  const windowDeadline = Date.now() + 60000;
  for (;;) {
    const targets = (await (await fetch(`${endpoint}/json/list`)).json()).filter(t => t.type === 'page');
    if (targets.length === 1 && targets[0].url === page.url()) break;
    if (Date.now() >= windowDeadline) throw new Error('Startup windows did not settle to the sole app renderer');
    await delay(500);
  }
  const idle = await measure('idle', probe);
  // The app's document-level shortcut works without a PlayerBar and invokes PlayerStore.togglePlay().
  await page.getByRole('heading', { name: 'GoyMusic', exact: true }).click();
  await page.keyboard.press('Space');
  const playing = await measure('playing', probe);
  await page.evaluate(() => window.bridge.winMinimize());
  const minimized = await measure('minimized', probe);
  if (minimized.playbackBefore.index !== playing.playbackAfter.index || minimized.playbackBefore.currentTime <= playing.playbackAfter.currentTime) {
    throw new Error('Playback did not continue on the same media element across minimize');
  }
  const report = {
    measuredAt: new Date().toISOString(), platform: `${process.platform}-${process.arch}`, rootPid: Number(rootPid), display,
    metric: 'MiB (2^20 bytes), Win32_PerfRawData_PerfProc_Process.WorkingSetPrivate for the entire installed GoyMusic.exe tree',
    method: 'Median of seven tree totals per mode, 1 s between samples; role medians computed independently (absent role = 0). Same signed-out screen and restored queue, no DevTools window.',
    settleSeconds, track: { filename, trackSeconds, format: 'PCM16 stereo 44100 Hz' }, states: { idle, playing, minimized },
  };
  fs.writeFileSync('ram-report.json', JSON.stringify(report, null, 2) + '\n');
}

// Exiting the external CDP client detaches without issuing Browser.close. PowerShell sends native WM_CLOSE.
main().then(() => process.exit(0), error => {
  console.error(error);
  if (process.env.GITHUB_ACTIONS) console.log(`::error::RAM driver: ${String(error.message).split('\n')[0]}`);
  process.exit(1);
});
