let cached = null; // { url, ts }
const TTL = 10 * 60 * 1000;

module.exports = async function handler(req, res) {
  if (cached && Date.now() - cached.ts < TTL) {
    res.setHeader('Location', cached.url);
    return res.status(302).end();
  }

  try {
    const r = await fetch('https://api.github.com/repos/Anfi1/goymusic/releases/latest', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GoyMusic/1.0)', Accept: 'application/vnd.github+json' }
    });
    if (!r.ok) throw new Error(`GitHub API ${r.status}`);
    const release = await r.json();
    const asset = (release.assets || []).find(a => a.name.endsWith('.exe'));
    if (!asset) throw new Error('No .exe asset in latest release');

    cached = { url: asset.browser_download_url, ts: Date.now() };
    res.setHeader('Location', asset.browser_download_url);
    res.status(302).end();
  } catch (e) {
    res.setHeader('Location', 'https://github.com/Anfi1/goymusic/releases/latest');
    res.status(302).end();
  }
};
