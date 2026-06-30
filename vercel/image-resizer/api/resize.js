import sharp from 'sharp';

async function resize(buf, w, q, fmt) {
  const mime = fmt === 'webp' ? 'image/webp' : fmt === 'png' ? 'image/png' : 'image/jpeg';
  const data = await sharp(buf)
    .rotate()
    .resize({ width: w, withoutEnlargement: true })
    .toFormat(fmt, { quality: q })
    .toBuffer();
  return { data, mime };
}

function clamp(v, min, max) {
  return Math.min(Math.max(parseInt(v) || min, min), max);
}

export default async function handler(req, res) {
  try {
    const w = clamp(req.query.w, 16, 4096);
    const q = clamp(req.query.q, 1, 100);
    const fmt = req.query.fmt || 'jpeg';

    if (req.method === 'GET' && req.query.url) {
      let targetUrl = req.query.url;
      const headers = { 'User-Agent': 'Mozilla/5.0 (compatible; ImageResizer/1.0)' };
      if (req.query.token) {
        headers['Authorization'] = 'Bearer ' + req.query.token;
      }
      // HF resolve returns 302 to signed CDN URL. undici's follow strips
      // Authorization; manual follow preserves the signed URL.
      const resp = await fetch(targetUrl, { redirect: 'manual', headers });
      let src = resp;
      if (resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers.get('location');
        if (!loc) {
          return res.status(502).json({ error: 'Redirect with no Location' });
        }
        src = await fetch(loc, { redirect: 'follow' });
      }
      if (!src.ok) {
        const text = await src.text().catch(() => '');
        return res.status(502).json({ error: 'Fetch failed: ' + src.status + ' ' + text.slice(0, 200) });
      }
      const { data, mime } = await resize(Buffer.from(await src.arrayBuffer()), w, q, fmt);
      res.setHeader('Content-Type', mime);
      res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800');
      return res.status(200).send(data);
    }

    if (req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      if (!buf.length) {
        return res.status(400).json({ error: 'Empty request body' });
      }
      const { data, mime } = await resize(buf, w, q, fmt);
      res.setHeader('Content-Type', mime);
      res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800');
      return res.status(200).send(data);
    }

    return res.status(405).json({ error: 'Use POST (binary) or GET (?url=)' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
