// server.js
// Express + Puppeteer service, optimized for Render deployment.
// Env vars:
//  PORT (default 3000)
//  USER_DATA_DIR (optional) => path inside container to use Chrome profile
//  CHROME_PATH (optional) => custom chrome executable

const express = require('express');
const puppeteer = require('puppeteer');
const fetch = require('node-fetch');

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
const USER_DATA_DIR = process.env.USER_DATA_DIR || null;
const CHROME_PATH = process.env.CHROME_PATH || undefined;

// Browser pool: keep one browser instance alive to reduce cold starts and overhead.
let browser = null;
let browserLaunching = false;

async function ensureBrowser() {
  if (browser) return browser;
  if (browserLaunching) {
    // wait for ongoing launch
    while (browserLaunching && !browser) await new Promise(r=>setTimeout(r,200));
    return browser;
  }
  browserLaunching = true;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      userDataDir: USER_DATA_DIR || undefined,
      executablePath: CHROME_PATH,
      // default timeout
      timeout: 60000
    });
    browserLaunching = false;
    return browser;
  } catch (e) {
    browserLaunching = false;
    throw e;
  }
}

app.post('/autolink', async (req, res) => {
  const { url, download } = req.body || {};
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'Missing url' });

  try {
    const b = await ensureBrowser();
    const page = await b.newPage();
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1200, height: 800 });

    // Navigate to j2download to give browser context (if profile exists)
    try {
      await page.goto('https://j2download.com/vi', { waitUntil: 'networkidle2', timeout: 30000 });
    } catch (e) {
      // ignore navigation issues — we still try the API call inside page
      console.warn('Warning: initial navigation failed', e.message);
    }

    // Execute the POST to /api/autolink inside page context so cookies/session apply
    const result = await page.evaluate(async (target) => {
      try {
        const r = await fetch('/api/autolink', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: target })
        });
        const status = r.status;
        const text = await r.text();
        try { return { status, body: JSON.parse(text) }; } catch(e) { return { status, body: text }; }
      } catch (err) {
        return { status: 0, error: err.message || String(err) };
      }
    }, url);

    await page.close();

    if (!result || result.status === 0) return res.status(502).json({ error: 'Browser request failed', details: result });
    if (result.status !== 200) return res.status(result.status).json({ error: 'Upstream returned non-200', data: result.body });

    // If download requested, try to find a valid file url and stream it
    const payload = result.body;
    if (download) {
      // heuristics to extract url
      const findUrl = (obj) => {
        if (!obj) return null;
        if (typeof obj === 'string') return obj.startsWith('http') ? obj : null;
        if (Array.isArray(obj)) {
          for (const x of obj) { const f = findUrl(x); if (f) return f; }
        } else if (typeof obj === 'object') {
          for (const k of Object.keys(obj)) { const f = findUrl(obj[k]); if (f) return f; }
        }
        return null;
      };
      const fileUrl = findUrl(payload);
      if (!fileUrl) return res.status(200).json({ message: 'No direct file URL found', payload });

      // Stream upstream file
      const upstream = await fetch(fileUrl);
      if (!upstream.ok) return res.status(502).json({ error: 'Failed to fetch file url', status: upstream.status });

      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
      const cd = upstream.headers.get('content-disposition');
      if (cd) res.setHeader('Content-Disposition', cd);

      upstream.body.pipe(res);
      upstream.body.on('error', (err) => { console.error('Stream error', err); try { res.end(); } catch(e){} });
      return;
    }

    return res.json({ payload });
  } catch (err) {
    console.error('Server error', err);
    return res.status(500).json({ error: err.message || String(err) });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
