import { cacheGet, cacheSet, getBackendUrl, invalidateBackendUrl } from './cache.js';

// Hardware video decoder semaphore: strictly max 1 concurrent client-side video decode
// This completely avoids GPU decoder slot contention and eliminates main thread frame drops.
const MAX_CLIENT_DECODERS = 1;
let activeClientDecoders = 0;
const clientDecoderQueue = [];

function processClientDecoderQueue() {
  while (activeClientDecoders < MAX_CLIENT_DECODERS && clientDecoderQueue.length > 0) {
    const next = clientDecoderQueue.shift();
    activeClientDecoders++;
    next().finally(() => {
      activeClientDecoders--;
      processClientDecoderQueue();
    });
  }
}

function queueClientVideoExtraction(fn) {
  return new Promise((resolve, reject) => {
    clientDecoderQueue.push(() => fn().then(resolve, reject));
    processClientDecoderQueue();
  });
}

function fetchWithTimeout(url, options = {}, timeoutMs = 4000) {
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
    return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  }
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(id));
}

export async function generateVideoThumbnail(videoUrl, maxDim = 300) {
  if (!videoUrl) return null;
  const key = 'vthumb:' + maxDim + ':' + videoUrl;
  const cached = cacheGet(key);
  if (cached) return cached;

  const hfUrl = videoUrl
    .replace('api-tiksave.mailtestvartext.workers.dev', 'huggingface.co')
    .replace('/proxy/', '/');
  const qIdx = hfUrl.indexOf('?token=');
  const baseUrl = qIdx === -1 ? hfUrl : hfUrl.slice(0, qIdx);
  const token = qIdx === -1 ? '' : hfUrl.slice(qIdx + 7).split('&')[0];

  function buildThumbUrl(host) {
    let u = `${host}/api/video-thumb?url=${encodeURIComponent(baseUrl)}&w=${maxDim}&q=80`;
    if (token) u += `&token=${encodeURIComponent(token)}`;
    return u;
  }

  // 1. Primary: Use GitHub Action Runner backend (FFmpeg server-side frame extraction)
  let backend = await getBackendUrl();
  if (backend) {
    try {
      const resp = await fetchWithTimeout(buildThumbUrl(backend), {}, 4000);
      if (resp.ok) {
        const blob = await resp.blob();
        const objUrl = URL.createObjectURL(blob);
        cacheSet(key, objUrl);
        return objUrl;
      }

      // If server returned 502/503/404, tunnel may have rotated/expired
      if (resp.status >= 500 || resp.status === 404) {
        invalidateBackendUrl();
        backend = await getBackendUrl(true);
        if (backend) {
          const retryResp = await fetchWithTimeout(buildThumbUrl(backend), {}, 3000);
          if (retryResp.ok) {
            const blob = await retryResp.blob();
            const objUrl = URL.createObjectURL(blob);
            cacheSet(key, objUrl);
            return objUrl;
          }
        }
      }
    } catch {
      // Network error / timeout: tunnel dead or expired. Refresh with 3s debounce
      invalidateBackendUrl();
      backend = await getBackendUrl(true);
      if (backend) {
        try {
          const retryResp = await fetchWithTimeout(buildThumbUrl(backend), {}, 3000);
          if (retryResp.ok) {
            const blob = await retryResp.blob();
            const objUrl = URL.createObjectURL(blob);
            cacheSet(key, objUrl);
            return objUrl;
          }
        } catch {}
      }
    }
  }

  // 2. Fallback: Client-side <video> + canvas extraction (strictly queued & throttled)
  try {
    const dataUrl = await queueClientVideoExtraction(() => extractClientVideoThumbnail(videoUrl, maxDim));
    if (dataUrl) {
      cacheSet(key, dataUrl);
      return dataUrl;
    }
  } catch (err) {
    console.warn('[thumbUtils] Video thumbnail extraction failed:', err);
  }

  return null;
}

function extractClientVideoThumbnail(videoUrl, maxDim = 300) {
  return new Promise((resolve) => {
    let settled = false;
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = 'anonymous';

    let timeoutId = null;

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      video.onloadedmetadata = null;
      video.onseeked = null;
      video.onerror = null;
      try {
        video.pause();
        video.removeAttribute('src');
        video.src = '';
        video.load();
      } catch {}
    };

    const done = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    // 8-second safety timeout so dead links or decoder stalls never permanently lock the slot
    timeoutId = setTimeout(() => done(null), 8000);

    video.onloadedmetadata = () => {
      if (settled) return;
      video.currentTime = Math.min(1, (video.duration || 10) * 0.1);
    };

    video.onseeked = async () => {
      if (settled) return;
      try {
        const vw = video.videoWidth || 300;
        const vh = video.videoHeight || 300;
        let cw, ch;
        if (vw > vh) {
          cw = maxDim;
          ch = Math.round(vh * (maxDim / vw));
        } else {
          ch = maxDim;
          cw = Math.round(vw * (maxDim / vh));
        }

        // Fast off-thread path: OffscreenCanvas + createImageBitmap
        if (typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap !== 'undefined') {
          try {
            const bitmap = await createImageBitmap(video);
            const canvas = new OffscreenCanvas(cw, ch);
            const ctx = canvas.getContext('2d');
            ctx.drawImage(bitmap, 0, 0, cw, ch);
            bitmap.close();
            const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
            const objUrl = URL.createObjectURL(blob);
            done(objUrl);
            return;
          } catch {
            // fallback to DOM canvas below if OffscreenCanvas fails (e.g. security origin)
          }
        }

        // DOM canvas fallback: yield to browser paint frame first to avoid scroll jank
        requestAnimationFrame(() => {
          if (settled) return;
          try {
            const canvas = document.createElement('canvas');
            canvas.width = cw;
            canvas.height = ch;
            const ctx = canvas.getContext('2d');
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(video, 0, 0, cw, ch);

            if (canvas.toBlob) {
              canvas.toBlob((blob) => {
                if (blob) {
                  done(URL.createObjectURL(blob));
                } else {
                  done(canvas.toDataURL('image/jpeg', 0.82));
                }
              }, 'image/jpeg', 0.82);
            } else {
              done(canvas.toDataURL('image/jpeg', 0.82));
            }
          } catch {
            done(null);
          }
        });
      } catch {
        done(null);
      }
    };

    video.onerror = () => {
      done(null);
    };

    video.src = videoUrl;
    video.load();
  });
}

export async function getVideoPreviewUrl(videoUrl, maxDim = 320, dur = 4) {
  if (!videoUrl) return null;

  const hfUrl = videoUrl
    .replace('api-tiksave.mailtestvartext.workers.dev', 'huggingface.co')
    .replace('/proxy/', '/');
  const qIdx = hfUrl.indexOf('?token=');
  const baseUrl = qIdx === -1 ? hfUrl : hfUrl.slice(0, qIdx);
  const token = qIdx === -1 ? '' : hfUrl.slice(qIdx + 7).split('&')[0];

  function buildPreviewUrl(host) {
    let u = `${host}/api/video-preview?url=${encodeURIComponent(baseUrl)}&w=${maxDim}&dur=${dur}`;
    if (token) u += `&token=${encodeURIComponent(token)}`;
    return u;
  }

  // 1. Primary: Use GitHub Action Runner backend if available
  let backend = await getBackendUrl();
  if (backend) {
    return buildPreviewUrl(backend);
  }

  // 2. Fallback: Direct video URL if runner is offline
  return videoUrl;
}
