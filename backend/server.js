import express from 'express';
import cors from 'cors';
import sharp from 'sharp';

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for all origins and headers
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['*'],
  exposedHeaders: ['Content-Type', 'Content-Length', 'Cache-Control'],
}));

function clamp(v, min, max, defaultVal) {
  const num = parseInt(v, 10);
  if (isNaN(num)) return defaultVal;
  return Math.min(Math.max(num, min), max);
}

async function resizeImage(buf, w, q, fmt) {
  let targetFmt = fmt;
  if (!['jpeg', 'webp', 'png', 'avif'].includes(targetFmt)) {
    targetFmt = 'jpeg';
  }
  const mime = targetFmt === 'webp' ? 'image/webp' :
               targetFmt === 'png' ? 'image/png' :
               targetFmt === 'avif' ? 'image/avif' : 'image/jpeg';

  const data = await sharp(buf)
    .rotate() // auto-orient based on EXIF
    .resize({ width: w, withoutEnlargement: true })
    .toFormat(targetFmt, { quality: q })
    .toBuffer();

  return { data, mime };
}

// Health check
app.get(['/', '/health'], (req, res) => {
  res.json({
    status: 'ok',
    service: 'tiksave-backend',
    uptime: Math.round(process.uptime()),
    timestamp: Date.now(),
    node: process.version,
  });
});

// GET /api/resize?url=...&w=300&q=80&fmt=jpeg&token=...
app.get('/api/resize', async (req, res) => {
  try {
    const targetUrl = req.query.url;
    if (!targetUrl) {
      return res.status(400).json({ error: 'Missing required query param: url' });
    }

    const w = clamp(req.query.w, 16, 4096, 300);
    const q = clamp(req.query.q, 1, 100, 80);
    const fmt = (req.query.fmt || 'jpeg').toLowerCase();

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) TikSave/1.0',
    };
    if (req.query.token) {
      headers['Authorization'] = 'Bearer ' + req.query.token;
    }

    // Hugging Face resolve returns 302 to CDN URL.
    // Manual redirect follow preserves credentials or switches to signed location
    let resp = await fetch(targetUrl, { redirect: 'manual', headers });
    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get('location');
      if (!location) {
        return res.status(502).json({ error: 'Redirect without Location header' });
      }
      resp = await fetch(location, { redirect: 'follow' });
    }

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      return res.status(resp.status).json({
        error: `Source fetch failed: HTTP ${resp.status}`,
        details: errText.slice(0, 200),
      });
    }

    const buffer = Buffer.from(await resp.arrayBuffer());
    const { data, mime } = await resizeImage(buffer, w, q, fmt);

    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'public, max-age=604800, s-maxage=604800, immutable');
    return res.status(200).send(data);
  } catch (err) {
    console.error('[resize-error]', err);
    return res.status(500).json({ error: err.message || 'Internal image resizing error' });
  }
});

// POST /api/resize (Binary body)
app.post('/api/resize', express.raw({ type: '*/*', limit: '25mb' }), async (req, res) => {
  try {
    const buf = req.body;
    if (!buf || !buf.length) {
      return res.status(400).json({ error: 'Empty request body' });
    }

    const w = clamp(req.query.w, 16, 4096, 300);
    const q = clamp(req.query.q, 1, 100, 80);
    const fmt = (req.query.fmt || 'jpeg').toLowerCase();

    const { data, mime } = await resizeImage(buf, w, q, fmt);

    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'public, max-age=604800, s-maxage=604800, immutable');
    return res.status(200).send(data);
  } catch (err) {
    console.error('[resize-post-error]', err);
    return res.status(500).json({ error: err.message });
  }
});

// Proxy endpoint for general media forwarding with CORS
app.get('/proxy/*', async (req, res) => {
  try {
    const subpath = req.params[0];
    const targetUrl = 'https://huggingface.co/' + subpath + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');
    const headers = {
      'User-Agent': 'Mozilla/5.0 (compatible; TikSaveProxy/1.0)',
    };
    const token = req.query.token;
    if (token) {
      headers['Authorization'] = 'Bearer ' + token;
    }

    let resp = await fetch(targetUrl, { redirect: 'manual', headers });
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('location');
      if (loc) resp = await fetch(loc, { redirect: 'follow' });
    }

    if (!resp.ok) {
      return res.status(resp.status).send(`Upstream returned ${resp.status}`);
    }

    const contentType = resp.headers.get('content-type') || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');

    const buffer = Buffer.from(await resp.arrayBuffer());
    return res.status(200).send(buffer);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[tiksave-backend] Server listening on http://0.0.0.0:${PORT}`);
});
