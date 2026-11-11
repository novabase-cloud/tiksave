import { cacheGet, cacheSet, getBackendUrl, invalidateBackendUrl } from './cache.js';

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
      const resp = await fetch(buildThumbUrl(backend));
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
          const retryResp = await fetch(buildThumbUrl(backend));
          if (retryResp.ok) {
            const blob = await retryResp.blob();
            const objUrl = URL.createObjectURL(blob);
            cacheSet(key, objUrl);
            return objUrl;
          }
        }
      }
    } catch {
      // Network error: tunnel dead or expired. Refresh with 3s debounce
      invalidateBackendUrl();
      backend = await getBackendUrl(true);
      if (backend) {
        try {
          const retryResp = await fetch(buildThumbUrl(backend));
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

  // 2. Fallback: Client-side <video> + canvas extraction (only if runner is unavailable)
  try {
    const dataUrl = await extractClientVideoThumbnail(videoUrl, maxDim);
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
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.crossOrigin = 'anonymous';
    video.src = videoUrl;

    const cleanup = () => {
      video.onloadedmetadata = null;
      video.onseeked = null;
      video.onerror = null;
      video.removeAttribute('src');
      video.load();
    };

    video.onloadedmetadata = () => {
      video.currentTime = Math.min(1, (video.duration || 10) * 0.1);
    };

    video.onseeked = () => {
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

        const canvas = document.createElement('canvas');
        canvas.width = cw;
        canvas.height = ch;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(video, 0, 0, cw, ch);

        const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
        cleanup();
        resolve(dataUrl);
      } catch {
        cleanup();
        resolve(null);
      }
    };

    video.onerror = () => {
      cleanup();
      resolve(null);
    };

    video.load();
  });
}
