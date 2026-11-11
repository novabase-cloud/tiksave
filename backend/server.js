import express from "express";
import cors from "cors";
import sharp from "sharp";

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for all routes
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: [
      "Authorization",
      "Content-Type",
      "x-requested-with",
      "x-repo",
      "x-repo-type",
    ],
    maxAge: 86400,
  })
);

// In-memory LRU cache for resized images (max 500 items, ~100MB)
const imageCache = new Map();
const MAX_CACHE_ENTRIES = 500;

function getCache(key) {
  if (!imageCache.has(key)) return null;
  const value = imageCache.get(key);
  imageCache.delete(key);
  imageCache.set(key, value);
  return value;
}

function setCache(key, value) {
  if (imageCache.has(key)) imageCache.delete(key);
  while (imageCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = imageCache.keys().next().value;
    imageCache.delete(oldestKey);
  }
  imageCache.set(key, value);
}

// ─── Health Endpoint ────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "tiksave-backend",
    uptime: Math.round(process.uptime()),
    cacheSize: imageCache.size,
    memory: process.memoryUsage(),
    timestamp: new Date().toISOString(),
  });
});

app.get("/", (req, res) => {
  res.json({
    name: "tiksave-backend-runner",
    status: "running",
    endpoints: ["/health", "/api/resize", "/api/proxy"],
  });
});

// ─── Image Resizer Endpoint ──────────────────────────────────────────────────
// Usage: GET /api/resize?url=<image_url>&w=300&q=80&token=<hf_token>
app.get("/api/resize", async (req, res) => {
  const { url, w, q, format = "webp" } = req.query;

  if (!url) {
    return res.status(400).json({ error: "Missing 'url' query parameter" });
  }

  // Token can come from query param or Authorization header
  const token =
    req.query.token ||
    (req.headers.authorization || "").replace(/^Bearer\s+/i, "");

  const targetWidth = Math.min(Math.max(parseInt(w, 10) || 300, 16), 1920);
  const targetQuality = Math.min(Math.max(parseInt(q, 10) || 80, 10), 100);
  const targetFormat = ["webp", "jpeg", "jpg", "png"].includes(format.toLowerCase())
    ? format.toLowerCase() === "jpg" ? "jpeg" : format.toLowerCase()
    : "webp";

  const cacheKey = `${url}::w${targetWidth}::q${targetQuality}::${targetFormat}`;
  const cached = getCache(cacheKey);

  if (cached) {
    res.set({
      "Content-Type": cached.contentType,
      "Cache-Control": "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400",
      "x-cache": "HIT",
    });
    return res.send(cached.buffer);
  }

  try {
    const fetchHeaders = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    };
    if (token) {
      fetchHeaders["Authorization"] = `Bearer ${token}`;
    }

    const upstream = await fetch(url, { headers: fetchHeaders });

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: "Upstream fetch failed",
        status: upstream.status,
        url,
      });
    }

    const inputBuffer = Buffer.from(await upstream.arrayBuffer());

    let pipeline = sharp(inputBuffer).resize({
      width: targetWidth,
      withoutEnlargement: true,
      fit: "inside",
    });

    let contentType = "image/webp";
    if (targetFormat === "webp") {
      pipeline = pipeline.webp({ quality: targetQuality, effort: 4 });
      contentType = "image/webp";
    } else if (targetFormat === "jpeg") {
      pipeline = pipeline.jpeg({ quality: targetQuality, mozjpeg: true });
      contentType = "image/jpeg";
    } else if (targetFormat === "png") {
      pipeline = pipeline.png({ compressionLevel: 6 });
      contentType = "image/png";
    }

    const outputBuffer = await pipeline.toBuffer();

    // Cache the processed image
    setCache(cacheKey, { buffer: outputBuffer, contentType });

    res.set({
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400",
      "x-cache": "MISS",
    });
    return res.send(outputBuffer);
  } catch (err) {
    console.error(`Resize error for ${url}:`, err.message);
    return res.status(500).json({
      error: "Image processing failed",
      message: err.message,
    });
  }
});

// ─── Proxy Endpoint ──────────────────────────────────────────────────────────
// Usage: GET /api/proxy?url=<target_url>&token=<token>
app.get("/api/proxy", async (req, res) => {
  const { url } = req.query;
  if (!url) {
    return res.status(400).json({ error: "Missing 'url' query parameter" });
  }

  const token =
    req.query.token ||
    (req.headers.authorization || "").replace(/^Bearer\s+/i, "");

  try {
    const fetchHeaders = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    };
    if (token) {
      fetchHeaders["Authorization"] = `Bearer ${token}`;
    }

    const upstream = await fetch(url, { headers: fetchHeaders });
    res.status(upstream.status);

    const passHeaders = ["content-type", "content-length", "etag", "last-modified"];
    for (const h of passHeaders) {
      const v = upstream.headers.get(h);
      if (v) res.set(h, v);
    }
    res.set("Cache-Control", "public, max-age=86400");

    const buffer = Buffer.from(await upstream.arrayBuffer());
    return res.send(buffer);
  } catch (err) {
    console.error(`Proxy error for ${url}:`, err.message);
    return res.status(500).json({ error: "Proxy failed", message: err.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[tiksave-backend] Server listening on port ${PORT}`);
});
