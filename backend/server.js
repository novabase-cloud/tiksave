import express from "express";
import cors from "cors";
import sharp from "sharp";
import { spawn } from "node:child_process";

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

// In-memory LRU cache for resized images & thumbnails (max 1000 items, ~200MB)
const imageCache = new Map();
const MAX_CACHE_ENTRIES = 1000;

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

// ─── Direct Media Resolver (Follows HF 302 redirects) ───────────────────────
async function resolveDirectMediaUrl(url, authToken) {
  let currentUrl = url;
  if (currentUrl.includes("api-tiksave.mailtestvartext.workers.dev")) {
    currentUrl = currentUrl
      .replace("api-tiksave.mailtestvartext.workers.dev", "huggingface.co")
      .replace("/proxy/", "/");
  }

  const qIdx = currentUrl.indexOf("?token=");
  if (qIdx !== -1) {
    if (!authToken) authToken = currentUrl.slice(qIdx + 7).split("&")[0];
    currentUrl = currentUrl.slice(0, qIdx);
  }

  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

  // Follow redirect manually to get direct signed CDN URL (CloudFront/S3/LFS)
  const resp = await fetch(currentUrl, { headers, redirect: "manual" });
  if (resp.status >= 300 && resp.status < 400) {
    const loc = resp.headers.get("location");
    if (loc) return loc;
  }
  return currentUrl;
}

// ─── FFmpeg Frame Extractor ──────────────────────────────────────────────────
function runFfmpegExtract(streamUrl, timestamp = 0.5) {
  return new Promise((resolve, reject) => {
    const args = [
      "-ss",
      String(timestamp),
      "-i",
      streamUrl,
      "-vframes",
      "1",
      "-f",
      "image2pipe",
      "-vcodec",
      "mjpeg",
      "-q:v",
      "3",
      "-",
    ];

    const ff = spawn("ffmpeg", args);
    const chunks = [];
    const errChunks = [];

    const timer = setTimeout(() => {
      ff.kill("SIGKILL");
      reject(new Error("FFmpeg timeout after 15s"));
    }, 15000);

    ff.stdout.on("data", (c) => chunks.push(c));
    ff.stderr.on("data", (c) => errChunks.push(c));

    ff.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && chunks.length > 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(
          new Error(
            `FFmpeg exited with code ${code}: ${Buffer.concat(errChunks).toString()}`
          )
        );
      }
    });

    ff.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function extractVideoFrame(streamUrl, timestamp = 0.5) {
  try {
    return await runFfmpegExtract(streamUrl, timestamp);
  } catch (err) {
    // If timestamp 0.5s failed (e.g. ultra-short video), fallback to beginning frame (0s)
    if (timestamp !== 0) {
      return await runFfmpegExtract(streamUrl, 0);
    }
    throw err;
  }
}

// ─── Video Thumbnail Handler ─────────────────────────────────────────────────
async function handleVideoThumbnail(req, res) {
  const { url, w, q, format = "webp", ss } = req.query;

  if (!url) {
    return res.status(400).json({ error: "Missing 'url' query parameter" });
  }

  const token =
    req.query.token ||
    (req.headers.authorization || "").replace(/^Bearer\s+/i, "");

  const targetWidth = Math.min(Math.max(parseInt(w, 10) || 300, 16), 1920);
  const targetQuality = Math.min(Math.max(parseInt(q, 10) || 80, 10), 100);
  const targetFormat = ["webp", "jpeg", "jpg", "png"].includes(
    format.toLowerCase()
  )
    ? format.toLowerCase() === "jpg"
      ? "jpeg"
      : format.toLowerCase()
    : "webp";
  const timestamp = parseFloat(ss) || 0.5;

  const cacheKey = `vthumb::${url}::w${targetWidth}::q${targetQuality}::${targetFormat}::t${timestamp}`;
  const cached = getCache(cacheKey);

  if (cached) {
    res.set({
      "Content-Type": cached.contentType,
      "Cache-Control":
        "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400",
      "x-cache": "HIT",
    });
    return res.send(cached.buffer);
  }

  try {
    // 1. Resolve direct signed media URL from Hugging Face
    const directUrl = await resolveDirectMediaUrl(url, token);

    // 2. Extract frame via FFmpeg
    const rawFrameBuffer = await extractVideoFrame(directUrl, timestamp);

    // 3. Resize and encode via Sharp
    let pipeline = sharp(rawFrameBuffer).resize({
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

    // Cache the processed thumbnail
    setCache(cacheKey, { buffer: outputBuffer, contentType });

    res.set({
      "Content-Type": contentType,
      "Cache-Control":
        "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400",
      "x-cache": "MISS",
    });
    return res.send(outputBuffer);
  } catch (err) {
    console.error(`Video thumbnail error for ${url}:`, err.message);
    return res.status(500).json({
      error: "Video thumbnail extraction failed",
      message: err.message,
    });
  }
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
    endpoints: ["/health", "/api/resize", "/api/video-thumb", "/api/proxy"],
  });
});

// ─── Video Thumbnail Endpoint ────────────────────────────────────────────────
// Usage: GET /api/video-thumb?url=<video_url>&w=300&q=80&token=<hf_token>
app.get("/api/video-thumb", handleVideoThumbnail);

// ─── Image Resizer Endpoint ──────────────────────────────────────────────────
// Usage: GET /api/resize?url=<image_url>&w=300&q=80&token=<hf_token>
app.get("/api/resize", async (req, res) => {
  const { url, w, q, format = "webp" } = req.query;

  if (!url) {
    return res.status(400).json({ error: "Missing 'url' query parameter" });
  }

  // If the URL is a video, automatically route to video frame extraction
  const isVideo =
    /\.(mp4|webm|mov|m4v|mkv)(\?|$)/i.test(url) || req.query.type === "video";
  if (isVideo) {
    return handleVideoThumbnail(req, res);
  }

  // Token can come from query param or Authorization header
  const token =
    req.query.token ||
    (req.headers.authorization || "").replace(/^Bearer\s+/i, "");

  const targetWidth = Math.min(Math.max(parseInt(w, 10) || 300, 16), 1920);
  const targetQuality = Math.min(Math.max(parseInt(q, 10) || 80, 10), 100);
  const targetFormat = ["webp", "jpeg", "jpg", "png"].includes(
    format.toLowerCase()
  )
    ? format.toLowerCase() === "jpg"
      ? "jpeg"
      : format.toLowerCase()
    : "webp";

  const cacheKey = `${url}::w${targetWidth}::q${targetQuality}::${targetFormat}`;
  const cached = getCache(cacheKey);

  if (cached) {
    res.set({
      "Content-Type": cached.contentType,
      "Cache-Control":
        "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400",
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
      "Cache-Control":
        "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400",
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

    const passHeaders = [
      "content-type",
      "content-length",
      "etag",
      "last-modified",
    ];
    for (const h of passHeaders) {
      const v = upstream.headers.get(h);
      if (v) res.set(h, v);
    }
    res.set("Cache-Control", "public, max-age=86400");

    const buffer = Buffer.from(await upstream.arrayBuffer());
    return res.send(buffer);
  } catch (err) {
    console.error(`Proxy error for ${url}:`, err.message);
    return res
      .status(500)
      .json({ error: "Proxy failed", message: err.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[tiksave-backend] Server listening on port ${PORT}`);
});
