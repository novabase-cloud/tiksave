import { cacheGet, cacheSet } from './cache.js';

export async function generateVideoThumbnail(videoUrl, maxDim = 300) {
  const key = 'thumb:' + videoUrl;
  const cached = cacheGet(key);
  if (cached) return cached;

  const video = document.createElement('video');
  video.preload = 'metadata';
  video.muted = true;
  video.crossOrigin = 'anonymous';
  video.src = videoUrl;

  try {
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = () => {
        video.currentTime = Math.min(1, video.duration * 0.1);
      };
      video.onseeked = () => resolve();
      video.onerror = () => reject(new Error('Video load failed'));
      video.load();
    });

    const vw = video.videoWidth;
    const vh = video.videoHeight;
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
    cacheSet(key, dataUrl);
    return dataUrl;
  } catch (err) {
    console.warn('generateVideoThumbnail failed:', err);
    return null;
  }
}
