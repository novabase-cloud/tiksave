import { IMAGE_RESIZER } from '../config.js';

const imageCache = new Map();
const MAX_CACHE = 100;

export function cacheGet(key) {
  if (!imageCache.has(key)) return null;
  const value = imageCache.get(key);
  imageCache.delete(key);
  imageCache.set(key, value);
  return value;
}

export function cacheSet(key, url) {
  if (imageCache.has(key)) {
    imageCache.delete(key);
  }
  while (imageCache.size >= MAX_CACHE) {
    const oldestKey = imageCache.keys().next().value;
    const oldest = imageCache.get(oldestKey);
    if (oldest.startsWith('blob:')) URL.revokeObjectURL(oldest);
    imageCache.delete(oldestKey);
  }
  imageCache.set(key, url);
}

export function cacheClear() {
  for (const url of imageCache.values()) {
    if (url.startsWith('blob:')) URL.revokeObjectURL(url);
  }
  imageCache.clear();
}

export async function loadCachedImage(url, ns = 'img') {
  const key = ns + ':' + url;
  const cached = cacheGet(key);
  if (cached) return cached;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const blob = await resp.blob();
    const objUrl = URL.createObjectURL(blob);
    cacheSet(key, objUrl);
    return objUrl;
  } catch {
    return null;
  }
}

export async function loadResizedImage(url, w = 150, q = 80) {
  const key = 'vrz:' + w + ':' + url;
  const cached = cacheGet(key);
  if (cached) return cached;
  const hfUrl = url.replace('novabase-cloud.mailtestvartext.workers.dev', 'huggingface.co');
  const qIdx = hfUrl.indexOf('?token=');
  const baseUrl = qIdx === -1 ? hfUrl : hfUrl.slice(0, qIdx);
  const token = qIdx === -1 ? '' : hfUrl.slice(qIdx + 7).split('&')[0];
  try {
    let vercelUrl = `${IMAGE_RESIZER}/api/resize?url=${encodeURIComponent(baseUrl)}&w=${w}&q=${q}`;
    if (token) vercelUrl += `&token=${encodeURIComponent(token)}`;
    const vResp = await fetch(vercelUrl);
    if (!vResp.ok) return null;
    const blob = await vResp.blob();
    const objUrl = URL.createObjectURL(blob);
    cacheSet(key, objUrl);
    return objUrl;
  } catch {
    return null;
  }
}
