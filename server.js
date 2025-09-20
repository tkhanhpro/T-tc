/**
 * server.js
 * Puppeteer service that:
 *  - launches chromium (reusing profile if provided)
 *  - optionally attempts Google login using env vars GOOGLE_EMAIL and GOOGLE_PASS
 *  - calls j2download's /api/autolink inside the browser context (so cookies/session apply)
 *
 * Env vars:
 *   PORT (default 3000)
 *   USER_DATA_DIR (optional)  --> e.g. /data/chrome-profile (mounted Render Disk)
 *   CHROME_PATH (optional)    --> custom chromium executable path
 *   GOOGLE_EMAIL (optional)   --> google email to attempt auto-login
 *   GOOGLE_PASS  (optional)   --> google password
 *   SHOW_BROWSER (optional)   --> '1' to launch non-headless (useful locally only)
 *
 * SECURITY: Put GOOGLE_EMAIL/GOOGLE_PASS into Render Environment (Dashboard -> Environment).
 *
 * WARNING: This will not bypass CAPTCHA/2FA. If Google asks for extra challenge, automation will fail.
 */

const express = require('express');
const puppeteer = require('puppeteer');
const fetch = require('node-fetch');

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
const USER_DATA_DIR = process.env.USER_DATA_DIR || null;
const CHROME_PATH = process.env.CHROME_PATH || undefined;
const GOOGLE_EMAIL = process.env.GOOGLE_EMAIL || 'nakano.miku.5@gmail.com;
const GOOGLE_PASS = process.env.GOOGLE_PASS || 'mikuchan2025@';
const SHOW_BROWSER = !!process.env.SHOW_BROWSER;

let browser = null;
let browserLaunching = false;

// ensure single browser instance (pool)
async function ensureBrowser() {
  if (browser) return browser;
  if (browserLaunching) {
    while (browserLaunching && !browser) await new Promise(r => setTimeout(r, 200));
    return browser;
  }
  browserLaunching = true;
  try {
    browser = await puppeteer.launch({
      headless: SHOW_BROWSER ? false : true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        // don't pass user-data-dir here if not set
      ],
      userDataDir: USER_DATA_DIR || undefined,
      executablePath: CHROME_PATH,
      timeout: 60000
    });
    browserLaunching = false;
    return browser;
  } catch (e) {
    browserLaunching = false;
    throw e;
  }
}

// Basic check if we are "logged into Google" by visiting a Google account URL
async function isGoogleLoggedIn(page) {
  try {
    // Visit a Google endpoint that redirects to login if not authenticated
    await page.goto('https://myaccount.google.com/?utm_source=signin', { waitUntil: 'networkidle2', timeout: 30000 });
    const url = page.url();
    // If URL contains 'signin' or 'accounts.google.com', not logged in
    if (url.includes('accounts.google.com') || url.includes('signin')) return false;
    // Otherwise likely logged in
    return true;
  } catch (e) {
    // On error, assume not logged in
    return false;
  }
}

// Attempt login flow on accounts.google.com using provided env vars.
// NOTE: Very fragile due to Google's dynamic pages and anti-bot checks.
// Returns { ok: boolean, reason?:string }
async function attemptGoogleLogin(page) {
  if (!GOOGLE_EMAIL || !GOOGLE_PASS) {
    return { ok: false, reason: 'Missing GOOGLE_EMAIL or GOOGLE_PASS' };
  }

  try {
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36');
    await page.goto('https://accounts.google.com/ServiceLogin?hl=en', { waitUntil: 'networkidle2', timeout: 60000 });

    // Email input
    const emailSelector = 'input[type="email"], input#identifierId';
    await page.waitForSelector(emailSelector, { visible: true, timeout: 15000 });
    await page.type(emailSelector, GOOGLE_EMAIL, { delay: 50 });
    // click Next - try multiple possible buttons
    const nextButtons = ['#identifierNext', 'button[jsname="LgbsSe"]', 'button:has-text("Next")'];
    try {
      await page.click('#identifierNext');
    } catch (e) {
      // fallback: press Enter
      await page.keyboard.press('Enter');
    }

    // Wait for password input
    const passwordSelector = 'input[type="password"], input[name="password"]';
    await page.waitForSelector(passwordSelector, { visible: true, timeout: 20000 });
    await page.type(passwordSelector, GOOGLE_PASS, { delay: 50 });

    // Click password next
    try {
      await page.click('#passwordNext');
    } catch (e) {
      await page.keyboard.press('Enter');
    }

    // Wait some time for navigation or possible MFA / challenge
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => { /* ignore */ });

    // Check logged-in
    const logged = await isGoogleLoggedIn(page);
    if (logged) return { ok: true };
    // If not logged, attempt to detect visible 2FA/CAPTCHA messages
    const bodyText = await page.evaluate(() => document.body.innerText || '');
    if (/verify|verification|2-step|2 step|challenge|captcha/i.test(bodyText)) {
      return { ok: false, reason: 'Google requested 2FA/CAPTCHA or extra verification' };
    }
    return { ok: false, reason: 'Unknown — login not confirmed' };
  } catch (err) {
    return { ok: false, reason: `Exception during login: ${err.message}` };
  }
}

// Call j2download /api/autolink inside page context so cookies & cf_clearance apply
async function callAutolinkFromPage(page, targetUrl) {
  return await page.evaluate(async (apiUrl, turl) => {
    try {
      const resp = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/plain, */*'
        },
        body: JSON.stringify({ url: turl })
      });
      const status = resp.status;
      const text = await resp.text();
      try { return { status, body: JSON.parse(text) }; } catch (e) { return { status, body: text }; }
    } catch (err) {
      return { status: 0, error: err.message || String(err) };
    }
  }, 'https://j2download.com/api/autolink', targetUrl);
}

// Public: trigger login attempt manually
app.post('/login', async (req, res) => {
  let b;
  try {
    b = await ensureBrowser();
    const page = await b.newPage();
    // If user provided cookies JSON in body, set them first (optional)
    if (req.body && req.body.cookies && Array.isArray(req.body.cookies)) {
      try { await page.setCookie(...req.body.cookies); } catch(e){ console.warn('setCookie error', e.message); }
    }
    const already = await isGoogleLoggedIn(page);
    if (already) {
      await page.close();
      return res.json({ ok: true, message: 'Already logged in (detected)' });
    }
    const attempt = await attemptGoogleLogin(page);
    await page.close();
    return res.json(attempt);
  } catch (err) {
    console.error('Login endpoint error', err);
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// Main: autolink endpoint
app.post('/autolink', async (req, res) => {
  const { url, download } = req.body || {};
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'Missing "url" in body' });

  let b;
  try {
    b = await ensureBrowser();
    const page = await b.newPage();
    await page.setViewport({ width: 1200, height: 800 });

    // Ensure we have valid Google/j2download session if desired
    let needLogin = false;
    // If USER_DATA_DIR provided, profile may already contain session
    try {
      const gLogged = await isGoogleLoggedIn(page);
      if (!gLogged && GOOGLE_EMAIL && GOOGLE_PASS) {
        // Attempt login automatically
        const attempt = await attemptGoogleLogin(page);
        if (!attempt.ok) {
          console.warn('Auto-login incomplete:', attempt.reason);
          // Not fatal: proceed to try autolink, but likely to get 401
        } else {
          console.log('Auto-login success');
        }
      }
    } catch (e) {
      console.warn('Error checking/login:', e.message);
    }

    // Go to j2download page first (so cookies & Cloudflare context)
    try {
      await page.goto('https://j2download.com/vi', { waitUntil: 'networkidle2', timeout: 30000 });
    } catch (e) {
      console.warn('Navigation to j2download failed or timed out:', e.message);
    }

    // Now call autolink inside page context
    const result = await callAutolinkFromPage(page, url);
    await page.close();

    if (!result || result.status === 0) {
      return res.status(502).json({ error: 'Request inside browser failed', details: result });
    }
    if (result.status !== 200) {
      return res.status(result.status).json({ error: 'Upstream non-200', data: result.body });
    }

    // If download requested: try to find direct file url (simple heuristic) and stream it
    if (download) {
      const payload = result.body;
      // find first URL inside payload
      const findUrl = obj => {
        if (!obj) return null;
        if (typeof obj === 'string') {
          return obj.startsWith('http') ? obj : null;
        } else if (Array.isArray(obj)) {
          for (const v of obj) { const f = findUrl(v); if (f) return f; }
        } else if (typeof obj === 'object') {
          for (const k of Object.keys(obj)) { const f = findUrl(obj[k]); if (f) return f; }
        }
        return null;
      };
      const fileUrl = findUrl(payload);
      if (!fileUrl) return res.status(200).json({ message: 'No direct file URL found', payload });
      // stream
      const upstream = await fetch(fileUrl);
      if (!upstream.ok) return res.status(502).json({ error: 'Failed fetch file', status: upstream.status });
      const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
      res.setHeader('Content-Type', contentType);
      const cd = upstream.headers.get('content-disposition');
      if (cd) res.setHeader('Content-Disposition', cd);
      upstream.body.pipe(res);
      upstream.body.on('error', (err) => { console.error('Stream error', err); try { res.end(); } catch (e) {} });
      return;
    }

    return res.json({ ok: true, payload: result.body });
  } catch (err) {
    console.error('Autolink server error', err);
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  } finally {
    // keep browser alive for reuse (do not close global browser here)
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Puppeteer autolink service listening on ${PORT} (USER_DATA_DIR=${USER_DATA_DIR || 'none'})`);
});
