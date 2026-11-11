import { IMAGE_RESIZER, TELLER_ENDPOINT } from '../config.js';

const imageCache = new Map();
const MAX_CACHE = 100;

// Backend runner tunnel state
const BACKEND_STORAGE_KEY = 'tiktok.backend.tunnel';
let currentBackendUrl = typeof localStorage !== 'undefined' ? (localStorage.getItem(BACKEND_STORAGE_KEY) || null) : null;
let lastTellerRequestTime = 0;
const TELLER_COOLDOWN_MS = 3000; // 3 seconds delay between requests to avoid spam
let tellerFetchPromise = null;

export async function getBackendUrl(forceRefresh = false) {
  const now = Date.now();

  // Return cached backend if valid and not forcing refresh
  if (!forceRefresh && currentBackendUrl) {
    return currentBackendUrl;
  }

  // Enforce 3s delay before asking teller again to prevent spam
  if (now - lastTellerRequestTime < TELLER_COOLDOWN_MS && currentBackendUrl) {
    return currentBackendUrl;
  }

  // Deduplicate concurrent requests
  if (tellerFetchPromise) {
    return tellerFetchPromise;
  }

  lastTellerRequestTime = now;
  tellerFetchPromise = (async () => {
    try {
      if (!TELLER_ENDPOINT) return null;
      const resp = await fetch(TELLER_ENDPOINT, { cache: 'no-store' });
      if (!resp.ok) return null;
      const data = await resp.json();
      if (data && data.ok && data.url) {
        const cleanUrl = data.url.replace(/\/+$/, '');
        currentBackendUrl = cleanUrl;
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(BACKEND_STORAGE_KEY, cleanUrl);
        }
        return cleanUrl;
      }
      return null;
    } catch (err) {
      console.warn('[teller-client] Failed to get backend URL from teller:', err);
      return null;
    } finally {
      tellerFetchPromise = null;
    }
  })();

  return tellerFetchPromise;
}

export function invalidateBackendUrl() {
  currentBackendUrl = null;
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem(BACKEND_STORAGE_KEY);
  }
}

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
  const hfUrl = url.replace('api-tiksave.mailtestvartext.workers.dev', 'huggingface.co').replace('/proxy/', '/');
  const qIdx = hfUrl.indexOf('?token=');
  const baseUrl = qIdx === -1 ? hfUrl : hfUrl.slice(0, qIdx);
  const token = qIdx === -1 ? '' : hfUrl.slice(qIdx + 7).split('&')[0];

  function buildResizeUrl(host) {
    let u = `${host}/api/resize?url=${encodeURIComponent(baseUrl)}&w=${w}&q=${q}`;
    if (token) u += `&token=${encodeURIComponent(token)}`;
    return u;
  }

  // 1. Try GitHub Action Runner backend first (via Teller discovery)
  let backend = await getBackendUrl();
  if (backend) {
    try {
      const resp = await fetch(buildResizeUrl(backend));
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
          const retryResp = await fetch(buildResizeUrl(backend));
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
          const retryResp = await fetch(buildResizeUrl(backend));
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

  // 2. Fallback to Vercel image resizer if runner is not available
  try {
    const vResp = await fetch(buildResizeUrl(IMAGE_RESIZER));
    if (!vResp.ok) return null;
    const blob = await vResp.blob();
    const objUrl = URL.createObjectURL(blob);
    cacheSet(key, objUrl);
    return objUrl;
  } catch {
    return null;
  }
}
