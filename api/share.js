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

module.exports = async function handler(req, res) {
  const parts = (req.url ?? '/').replace(/^\//, '').split('/');
  const type    = parts[0];
  const id      = parts[1];

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
    protocolUrl   = `goymusic://track/${id}`;
    fallbackUrl   = `https://music.youtube.com/watch?v=${id}`;
    ogImage       = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
    const oembed = await fetchOembed(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`);
    if (oembed) {
      ogTitle       = escapeHtml(oembed.title ?? 'Track on GoyMusic');
      ogDescription = escapeHtml(oembed.author_name ?? 'GoyMusic');
    }
  } else if (type === 'album' && id) {
    ogTitle       = 'Album on GoyMusic';
    ogDescription = 'Open album in GoyMusic desktop app';
    protocolUrl   = `goymusic://album/${id}`;
    fallbackUrl   = `https://music.youtube.com/browse/${id}`;
  }

  const thumbDisplay  = ogImage ? `<img class="thumb" src="${escapeHtml(ogImage)}" alt="" />` : '';
  const titleDisplay  = ogTitle !== 'GoyMusic' ? `<div class="track-title">${ogTitle}</div>` : '';
  const artistDisplay = ogDescription !== 'Listen on GoyMusic desktop app or YouTube Music' && ogDescription !== 'GoyMusic'
    ? `<div class="track-artists">${ogDescription}</div>` : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${ogTitle} — GoyMusic</title>
  <meta name="theme-color" content="#1e1e2e" />
  <meta property="og:site_name" content="GoyMusic" />
  <meta property="og:type" content="music.song" />
  <meta property="og:title" content="${ogTitle}" />
  <meta property="og:description" content="${ogDescription}" />
  <meta property="og:image" content="${escapeHtml(ogImage)}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${ogTitle}" />
  <meta name="twitter:description" content="${ogDescription}" />
  <meta name="twitter:image" content="${escapeHtml(ogImage)}" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #1e1e2e; color: #cdd6f4;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      display: flex; flex-direction: column; align-items: center;
      justify-content: center; min-height: 100vh; gap: 24px; padding: 24px;
    }
    .logo { font-size: 1.4rem; font-weight: 700; letter-spacing: -0.5px; color: #cba6f7; }
    .card {
      background: #313244; border-radius: 16px; padding: 28px 32px;
      text-align: center; max-width: 380px; width: 100%;
      display: flex; flex-direction: column; gap: 16px; align-items: center;
    }
    .thumb { width: 120px; height: 120px; border-radius: 10px; object-fit: cover; background: #45475a; }
    .track-title { font-size: 1.05rem; font-weight: 600; color: #cdd6f4; }
    .track-artists { font-size: 0.85rem; color: #a6adc8; }
    .status { font-size: 0.9rem; color: #a6adc8; min-height: 1.4em; }
    .dot { display: inline-block; animation: blink 1.2s step-end infinite; }
    .dot:nth-child(2) { animation-delay: 0.2s; }
    .dot:nth-child(3) { animation-delay: 0.4s; }
    @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }
    .btn {
      display: inline-block; padding: 10px 20px; border-radius: 8px;
      font-size: 0.9rem; font-weight: 600; text-decoration: none;
      cursor: pointer; border: none; transition: opacity 0.15s;
    }
    .btn:hover { opacity: 0.85; }
    .btn-primary { background: #cba6f7; color: #1e1e2e; }
    .btn-secondary { background: #45475a; color: #cdd6f4; }
    .buttons { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
    .sub { font-size: 0.78rem; color: #6c7086; }
  </style>
</head>
<body>
  <div class="logo">GoyMusic</div>
  <div class="card">
    ${thumbDisplay}
    ${titleDisplay}
    ${artistDisplay}
    <div class="status" id="status">
      Opening app<span class="dot">.</span><span class="dot">.</span><span class="dot">.</span>
    </div>
    <div class="buttons" id="buttons" style="display:none">
      <a class="btn btn-primary" href="${escapeHtml(protocolUrl)}">Open in GoyMusic</a>
      <a class="btn btn-secondary" href="${escapeHtml(fallbackUrl)}" target="_blank" rel="noopener">${fallbackLabel}</a>
    </div>
    <div class="sub" id="sub"></div>
  </div>
  <script>
    var protocolUrl = ${JSON.stringify(protocolUrl)};
    var statusEl  = document.getElementById('status');
    var buttonsEl = document.getElementById('buttons');
    var subEl     = document.getElementById('sub');

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