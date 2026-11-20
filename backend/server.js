import express from "express";
import cors from "cors";
import sharp from "sharp";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

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

// ─── Video Preview Cache & Transcoder ────────────────────────────────────────
const PREVIEW_CACHE_DIR = path.join(os.tmpdir(), "tiksave-preview-cache");
try {
  if (!fs.existsSync(PREVIEW_CACHE_DIR)) {
    fs.mkdirSync(PREVIEW_CACHE_DIR, { recursive: true });
  }
} catch (e) {
  console.warn("Could not create preview cache dir:", e.message);
}

const inflightPreviews = new Map();

function cleanupPreviewCache(maxFiles = 300) {
  try {
    const files = fs.readdirSync(PREVIEW_CACHE_DIR);
    if (files.length <= maxFiles) return;
    const stats = files
      .map((file) => {
        const fullPath = path.join(PREVIEW_CACHE_DIR, file);
        try {
          return { file: fullPath, mtime: fs.statSync(fullPath).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    stats.sort((a, b) => a.mtime - b.mtime);
    const toDelete = stats.slice(0, stats.length - maxFiles);
    for (const item of toDelete) {
      try {
        fs.unlinkSync(item.file);
      } catch {}
    }
  } catch (err) {
    console.warn("Preview cache cleanup error:", err.message);
  }
}

function transcodeVideoPreview(
  streamUrl,
  targetWidth,
  targetDur,
  targetCrf,
  outputPath
) {
  return new Promise((resolve, reject) => {
    const tempPath = `${outputPath}.tmp.${Date.now()}.${Math.random()
      .toString(36)
      .slice(2, 7)}.mp4`;

    // Scale preserving aspect ratio: width = min(targetWidth, iw), height proportional (-2)
    const vfScale = `scale=min(${targetWidth}\\,iw):-2`;

    const args = [
      "-ss",
      "0",
      "-t",
      String(targetDur),
      "-i",
      streamUrl,
      "-vf",
      vfScale,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      String(targetCrf),
      "-pix_fmt",
      "yuv420p",
      "-an",
      "-movflags",
      "+faststart",
      "-y",
      tempPath,
    ];

    const ff = spawn("ffmpeg", args);
    const errChunks = [];

    const timer = setTimeout(() => {
      ff.kill("SIGKILL");
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch {}
      reject(new Error("FFmpeg preview timeout after 25s"));
    }, 25000);

    ff.stderr.on("data", (c) => errChunks.push(c));

    ff.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(tempPath)) {
        try {
          const stat = fs.statSync(tempPath);
          if (stat.size > 500) {
            fs.renameSync(tempPath, outputPath);
            return resolve(outputPath);
          }
        } catch (e) {
          return reject(e);
        }
      }
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch {}
      reject(
        new Error(
          `FFmpeg preview failed with code ${code}: ${Buffer.concat(
            errChunks
          )
            .toString()
            .slice(-400)}`
        )
      );
    });

    ff.on("error", (err) => {
      clearTimeout(timer);
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch {}
      reject(err);
    });
  });
}

// ─── Video Preview Handler ───────────────────────────────────────────────────
// Usage: GET /api/video-preview?url=<video_url>&w=320&dur=4&crf=32&token=<token>
async function handleVideoPreview(req, res) {
  const { url, w, dur, crf } = req.query;

  if (!url) {
    return res.status(400).json({ error: "Missing 'url' query parameter" });
  }

  const token =
    req.query.token ||
    (req.headers.authorization || "").replace(/^Bearer\s+/i, "");

  const targetWidth = Math.min(Math.max(parseInt(w, 10) || 320, 120), 720);
  const targetDur = Math.min(Math.max(parseFloat(dur) || 4, 1.5), 10);
  const targetCrf = Math.min(Math.max(parseInt(crf, 10) || 32, 22), 40);

  const cacheKey = `vprev::${url}::w${targetWidth}::d${targetDur}::c${targetCrf}`;
  const hash = crypto.createHash("md5").update(cacheKey).digest("hex");
  const cacheFilePath = path.join(PREVIEW_CACHE_DIR, `preview_${hash}.mp4`);

  // Check on-disk cache hit
  try {
    if (fs.existsSync(cacheFilePath)) {
      const stat = fs.statSync(cacheFilePath);
      if (stat.size > 500) {
        res.set({
          "Cache-Control":
            "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400",
          "x-cache": "HIT",
        });
        return res.sendFile(cacheFilePath);
      }
    }
  } catch {}

  // Deduplicate concurrent transcode requests for same cacheKey
  let promise = inflightPreviews.get(cacheKey);
  if (!promise) {
    promise = (async () => {
      try {
        const directUrl = await resolveDirectMediaUrl(url, token);
        await transcodeVideoPreview(
          directUrl,
          targetWidth,
          targetDur,
          targetCrf,
          cacheFilePath
        );
        cleanupPreviewCache(300);
        return cacheFilePath;
      } finally {
        inflightPreviews.delete(cacheKey);
      }
    })();
    inflightPreviews.set(cacheKey, promise);
  }

  try {
    const finalPath = await promise;
    res.set({
      "Cache-Control":
        "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400",
      "x-cache": "MISS",
    });
    return res.sendFile(finalPath);
  } catch (err) {
    console.error(`Video preview error for ${url}:`, err.message);
    return res.status(500).json({
      error: "Video preview transcoding failed",
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
    endpoints: [
      "/health",
      "/api/resize",
      "/api/video-thumb",
      "/api/video-preview",
      "/api/proxy",
    ],
  });
});

// ─── Video Preview Endpoint ──────────────────────────────────────────────────
// Usage: GET /api/video-preview?url=<video_url>&w=320&dur=4&token=<hf_token>
app.get("/api/video-preview", handleVideoPreview);

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
