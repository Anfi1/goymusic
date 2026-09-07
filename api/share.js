const cache = new Map();

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function fetchOembed(url, ttl = 3600000) {
  const cached = cache.get(url);
  if (cached && Date.now() - cached.ts < ttl) return cached.data;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GoyMusic/1.0)' }
    });
    if (!res.ok) return null;
    const data = await res.json();
    cache.set(url, { data, ts: Date.now() });
    return data;
  } catch { return null; }
}

function decodeMeta(search) {
  try {
    const params = new URLSearchParams(search);
    const m = params.get('m');
    if (!m) return null;
    const base64 = m.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(base64, 'base64').toString('utf-8'));
  } catch { return null; }
}

module.exports = async function handler(req, res) {
  const fullUrl = req.url ?? '/';
  const qIdx = fullUrl.indexOf('?');
  const path = qIdx >= 0 ? fullUrl.slice(0, qIdx) : fullUrl;
  const search = qIdx >= 0 ? fullUrl.slice(qIdx) : '';
  const parts = path.replace(/^\//, '').split('/');
  const type    = parts[0];
  const id      = parts[1];

  const urlMeta = decodeMeta(search);
  const urlParams = new URLSearchParams(search);
  const timecode = urlParams.get('t') || '';

  let ogTitle       = 'GoyMusic';
  let ogDescription = 'Listen on GoyMusic desktop app or YouTube Music';
  let ogImage       = '';
  let protocolUrl   = '';
  let fallbackUrl   = '';
  let fallbackLabel = 'Open in YouTube Music';

  if (type === 'track' && id === 'sc') {
    const scSlug = parts.slice(2).join('/');
    if (scSlug) {
      protocolUrl   = `goymusic://track/sc/${scSlug}`;
      fallbackUrl   = `https://soundcloud.com/${scSlug}`;
      fallbackLabel = 'Open in SoundCloud';
      const oembed = await fetchOembed(`https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(fallbackUrl)}`);
      if (oembed) {
        ogTitle       = escapeHtml(oembed.title ?? 'Track on GoyMusic');
        ogDescription = escapeHtml(oembed.author_name ?? '');
        ogImage       = escapeHtml(oembed.thumbnail_url ?? '');
      }
    }
  } else if (type === 'track' && id) {
    fallbackUrl   = `https://music.youtube.com/watch?v=${id}`;
    ogImage       = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
    if (urlMeta) {
      ogTitle       = escapeHtml(urlMeta.t || 'Track on GoyMusic');
      ogDescription = escapeHtml((urlMeta.a || []).join(', ') || 'GoyMusic');
      if (urlMeta.i) ogImage = escapeHtml(urlMeta.i);
    } else {
      const oembed = await fetchOembed(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`);
      if (oembed) {
        ogTitle       = escapeHtml(oembed.title ?? 'Track on GoyMusic');
        ogDescription = escapeHtml(oembed.author_name ?? 'GoyMusic');
      }
    }
    const meta = { t: urlMeta?.t || ogTitle.replace(/ — GoyMusic$/, ''), a: urlMeta?.a || [ogDescription], i: ogImage };
    const b64 = Buffer.from(unescape(encodeURIComponent(JSON.stringify(meta))), 'binary').toString('base64');
    // URL-safe base64: replace + with - and / with _
    const safeB64 = b64.replace(/\+/g, '-').replace(/\//g, '_');
    const timeParam = timecode ? `&t=${timecode}` : '';
    protocolUrl   = `goymusic://track/${id}?m=${safeB64}${timeParam}`;
  } else if (type === 'album' && id) {
    ogTitle       = 'Album on GoyMusic';
    ogDescription = 'Open album in GoyMusic desktop app';
    protocolUrl   = `goymusic://album/${id}`;
    fallbackUrl   = `https://music.youtube.com/browse/${id}`;
  }

  const artDisplay    = ogImage ? `<img class="art" src="${escapeHtml(ogImage)}" alt="" />` : '<div class="art art--empty"></div>';
  const titleDisplay  = ogTitle !== 'GoyMusic' ? `<div class="track-title">${ogTitle}</div>` : '';
  const artistDisplay = ogDescription !== 'Listen on GoyMusic desktop app or YouTube Music' && ogDescription !== 'GoyMusic'
    ? `<div class="track-artists">${ogDescription}</div>` : '';
  const bgDisplay     = ogImage ? `<div class="bg" style="background-image:url(&quot;${escapeHtml(ogImage)}&quot;)"></div>` : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${ogTitle} — GoyMusic</title>
  <meta name="theme-color" content="#09090f" />
  <meta property="og:site_name" content="GoyMusic" />
  <meta property="og:type" content="music.song" />
  <meta property="og:title" content="${ogTitle}" />
  <meta property="og:description" content="${ogDescription}" />
  <meta property="og:image" content="${escapeHtml(ogImage)}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${ogTitle}" />
  <meta name="twitter:description" content="${ogDescription}" />
  <meta name="twitter:image" content="${escapeHtml(ogImage)}" />
  <link rel="icon" href="/icon.svg" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; -webkit-font-smoothing: antialiased; }
    body {
      background: #09090f; color: #cdd6f4;
      font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif;
      display: flex; align-items: center; justify-content: center;
      min-height: 100svh; padding: 24px; overflow: hidden;
    }

    /* Размытая обложка на фоне — как в «Моей волне» приложения */
    .bg {
      position: fixed; inset: -12%; z-index: 0;
      background-size: cover; background-position: center;
      filter: blur(80px) saturate(1.8) brightness(0.5);
      transform: scale(1.3);
    }
    .bg-overlay {
      position: fixed; inset: 0; z-index: 0;
      background: radial-gradient(ellipse at 50% 40%, rgba(0,0,0,0.15) 0%, rgba(0,0,0,0.62) 62%, rgba(9,9,15,0.9) 100%);
    }

    .card {
      position: relative; z-index: 1;
      width: 100%; max-width: 380px;
      display: flex; flex-direction: column; align-items: center; gap: 14px;
      padding: 28px 26px 22px;
      background: rgba(10, 10, 16, 0.55);
      border: 1px solid rgba(255, 255, 255, 0.07);
      border-radius: 20px;
      backdrop-filter: blur(24px) saturate(1.4);
      -webkit-backdrop-filter: blur(24px) saturate(1.4);
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55);
      animation: cardIn 0.35s cubic-bezier(0.16, 1, 0.3, 1) both;
    }
    @keyframes cardIn { from { opacity: 0; transform: translateY(12px) scale(0.97); } }

    .logo { display: flex; align-items: center; gap: 8px; color: #cdd6f4; }
    .logo svg { width: 22px; height: 22px; }
    .logo span { font-size: 0.95rem; font-weight: 700; letter-spacing: -0.2px; }

    .art {
      width: 168px; height: 168px; border-radius: 14px; object-fit: cover;
      background: rgba(255, 255, 255, 0.05);
      box-shadow: 0 18px 44px rgba(0, 0, 0, 0.6);
    }
    .art--empty { display: block; }

    .track-title { font-size: 1.05rem; font-weight: 600; text-align: center; line-height: 1.35; }
    .track-artists { font-size: 0.85rem; color: #a6adc8; text-align: center; margin-top: -8px; }

    .status { font-size: 0.85rem; color: #a6adc8; min-height: 1.4em; text-align: center; }
    .dot { display: inline-block; animation: blink 1.2s step-end infinite; }
    .dot:nth-child(2) { animation-delay: 0.2s; }
    .dot:nth-child(3) { animation-delay: 0.4s; }
    @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }

    .buttons { display: none; flex-direction: column; gap: 8px; width: 100%; }
    .btn {
      display: flex; align-items: center; justify-content: center; gap: 8px;
      padding: 11px 18px; border-radius: 12px; border: 1px solid transparent;
      font-family: inherit; font-size: 0.88rem; font-weight: 600;
      text-decoration: none; cursor: pointer;
      transition: background 0.15s, transform 0.15s, color 0.15s;
    }
    .btn:active { transform: scale(0.985); }
    .btn-primary { background: #89b4fa; color: #11111b; }
    .btn-primary:hover { background: #b4befe; }
    .btn-secondary { background: rgba(255, 255, 255, 0.05); border-color: rgba(255, 255, 255, 0.1); color: #cdd6f4; }
    .btn-secondary:hover { background: rgba(255, 255, 255, 0.09); }
    .btn-download { background: transparent; color: #89b4fa; font-size: 0.82rem; padding: 6px; }
    .btn-download:hover { color: #b4befe; }

    .sub { font-size: 0.75rem; color: #6c7086; text-align: center; }

    @media (max-width: 400px) {
      .art { width: 132px; height: 132px; }
    }
  </style>
</head>
<body>
  ${bgDisplay}
  <div class="bg-overlay"></div>
  <main class="card">
    <div class="logo">
      <svg viewBox="0 0 1024 1024" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <circle cx="512" cy="512" r="512" fill="#09090f"/>
        <g transform="translate(512, 512) scale(0.85) translate(-512, -512)">
          <path d="M 800 512 A 288 288 0 1 1 680 230" stroke="#cdd6f4" stroke-width="180" stroke-linecap="round"/>
          <path d="M 430 322 L 780 512 L 430 702 Z" fill="#FF3333" stroke="#FF3333" stroke-width="20" stroke-linejoin="round"/>
        </g>
      </svg>
      <span>GoyMusic</span>
    </div>
    ${artDisplay}
    ${titleDisplay}
    ${artistDisplay}
    <div class="status" id="status">
      Opening app<span class="dot">.</span><span class="dot">.</span><span class="dot">.</span>
    </div>
    <div class="buttons" id="buttons">
      <a class="btn btn-primary" href="${escapeHtml(protocolUrl)}">Open in GoyMusic</a>
      <a class="btn btn-secondary" href="${escapeHtml(fallbackUrl)}" target="_blank" rel="noopener">${fallbackLabel}</a>
      <a class="btn btn-download" id="downloadBtn" href="/download" target="_blank" rel="noopener" style="display:none">Download GoyMusic</a>
    </div>
    <div class="sub" id="sub"></div>
  </main>
  <script>
    var protocolUrl = ${JSON.stringify(protocolUrl)};
    var statusEl    = document.getElementById('status');
    var buttonsEl   = document.getElementById('buttons');
    var subEl       = document.getElementById('sub');
    var downloadBtn = document.getElementById('downloadBtn');

    if (!protocolUrl) {
      statusEl.textContent = 'Invalid link.';
    } else {
      window.location.href = protocolUrl;
      var appOpened = false;
      window.addEventListener('blur', function() { appOpened = true; });
      document.addEventListener('visibilitychange', function() {
        if (document.hidden) appOpened = true;
      });
      setTimeout(function() {
        buttonsEl.style.display = 'flex';
        if (appOpened) {
          statusEl.textContent = 'GoyMusic should be open now.';
          subEl.textContent = 'Nothing happened? Try the buttons above.';
        } else {
          statusEl.textContent = 'GoyMusic not installed?';
          downloadBtn.style.display = 'flex';
          subEl.textContent = 'Download GoyMusic to open links directly.';
        }
      }, 1500);
    }
  </script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.status(200).send(html);
};
