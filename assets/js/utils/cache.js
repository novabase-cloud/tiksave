import { IMAGE_RESIZER, TELLER_ENDPOINT } from '../config.js';

// In-memory LRU session cache
const imageCache = new Map();
const MAX_CACHE = 150;

// ─── IndexedDB Persistent Local Memory for Avatars ──────────────────────────
const DB_NAME = 'tiksave-local-cache';
const DB_VERSION = 1;
const AVATAR_STORE = 'avatars';

let _idbPromise = null;
function getIDB() {
  if (_idbPromise) return _idbPromise;
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);

  _idbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(AVATAR_STORE)) {
          db.createObjectStore(AVATAR_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        console.warn('[cache] IndexedDB open error');
        resolve(null);
      };
    } catch (err) {
      console.warn('[cache] IndexedDB unsupported or blocked:', err);
      resolve(null);
    }
  });
  return _idbPromise;
}

export async function getLocalAvatarBlob(key) {
  try {
    const db = await getIDB();
    if (!db) return null;
    return new Promise((resolve) => {
      const tx = db.transaction(AVATAR_STORE, 'readonly');
      const store = tx.objectStore(AVATAR_STORE);
      const req = store.get(key);
      req.onsuccess = () => {
        const val = req.result;
        if (!val) return resolve(null);
        if (val instanceof Blob) return resolve(val);
        if (val.blob instanceof Blob) return resolve(val.blob);
        if (val.buffer) return resolve(new Blob([val.buffer], { type: val.type || 'image/jpeg' }));
        resolve(null);
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function setLocalAvatarBlob(key, blob) {
  try {
    const db = await getIDB();
    if (!db || !blob) return;
    const tx = db.transaction(AVATAR_STORE, 'readwrite');
    const store = tx.objectStore(AVATAR_STORE);
    store.put({ blob, type: blob.type || 'image/jpeg', timestamp: Date.now() }, key);
  } catch (err) {
    console.warn('[cache] Failed to persist avatar to local memory:', err);
  }
}

export async function clearLocalAvatarStorage() {
  try {
    const db = await getIDB();
    if (!db) return;
    const tx = db.transaction(AVATAR_STORE, 'readwrite');
    tx.objectStore(AVATAR_STORE).clear();
  } catch {}
}

// ─── Backend Runner Tunnel State ────────────────────────────────────────────
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

// ─── In-Memory Session Cache Helpers ─────────────────────────────────────────
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
    if (oldest && oldest.startsWith('blob:')) URL.revokeObjectURL(oldest);
    imageCache.delete(oldestKey);
  }
  imageCache.set(key, url);
}

export function cacheClear() {
  for (const url of imageCache.values()) {
    if (url && url.startsWith('blob:')) URL.revokeObjectURL(url);
  }
  imageCache.clear();
}

// ─── Full-Size / Raw Image Loader ───────────────────────────────────────────
export async function loadCachedImage(url, ns = 'img') {
  if (!url) return null;
  const key = ns + ':' + url;
  const cached = cacheGet(key);
  if (cached) return cached;

  const hfUrl = url.replace('api-tiksave.mailtestvartext.workers.dev', 'huggingface.co').replace('/proxy/', '/');
  const qIdx = hfUrl.indexOf('?token=');
  const baseUrl = qIdx === -1 ? hfUrl : hfUrl.slice(0, qIdx);

  const isAvatar = ns === 'avatar' || baseUrl.includes('/avatar/');
  const avatarGenericKey = isAvatar ? `avatar:generic:${baseUrl}` : null;

  // Check persistent local memory (IndexedDB) for avatars first
  if (isAvatar && avatarGenericKey) {
    const localBlob = await getLocalAvatarBlob(avatarGenericKey);
    if (localBlob) {
      const objUrl = URL.createObjectURL(localBlob);
      cacheSet(key, objUrl);
      return objUrl;
    }
  }

  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const blob = await resp.blob();

    // Persist avatar to IndexedDB so future visits never make network requests
    if (isAvatar && avatarGenericKey) {
      setLocalAvatarBlob(avatarGenericKey, blob);
    }

    const objUrl = URL.createObjectURL(blob);
    cacheSet(key, objUrl);
    return objUrl;
  } catch {
    return null;
  }
}

// ─── Resized / Avatar Image Loader ──────────────────────────────────────────
export async function loadResizedImage(url, w = 150, q = 80) {
  if (!url) return null;
  const key = 'vrz:' + w + ':' + url;
  const cached = cacheGet(key);
  if (cached) return cached;

  const hfUrl = url.replace('api-tiksave.mailtestvartext.workers.dev', 'huggingface.co').replace('/proxy/', '/');
  const qIdx = hfUrl.indexOf('?token=');
  const baseUrl = qIdx === -1 ? hfUrl : hfUrl.slice(0, qIdx);
  const token = qIdx === -1 ? '' : hfUrl.slice(qIdx + 7).split('&')[0];

  const isAvatar = baseUrl.includes('/avatar/');
  const avatarStorageKey = isAvatar ? `avatar:${w}:${baseUrl}` : null;
  const avatarGenericKey = isAvatar ? `avatar:generic:${baseUrl}` : null;

  // 1. Check persistent local memory (IndexedDB) for avatars first
  if (isAvatar) {
    let localBlob = await getLocalAvatarBlob(avatarStorageKey);
    if (!localBlob && avatarGenericKey) {
      localBlob = await getLocalAvatarBlob(avatarGenericKey);
    }
    if (localBlob) {
      const objUrl = URL.createObjectURL(localBlob);
      cacheSet(key, objUrl);
      return objUrl;
    }
  }

  function buildResizeUrl(host) {
    let u = `${host}/api/resize?url=${encodeURIComponent(baseUrl)}&w=${w}&q=${q}`;
    if (token) u += `&token=${encodeURIComponent(token)}`;
    return u;
  }

  // Helper to persist avatar once fetched
  function saveToLocalMemory(blob) {
    if (isAvatar && blob) {
      setLocalAvatarBlob(avatarStorageKey, blob);
      setLocalAvatarBlob(avatarGenericKey, blob);
    }
  }

  // 2. Try GitHub Action Runner backend first (via Teller discovery)
  let backend = await getBackendUrl();
  if (backend) {
    try {
      const resp = await fetch(buildResizeUrl(backend));
      if (resp.ok) {
        const blob = await resp.blob();
        saveToLocalMemory(blob);
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
            saveToLocalMemory(blob);
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
            saveToLocalMemory(blob);
            const objUrl = URL.createObjectURL(blob);
            cacheSet(key, objUrl);
            return objUrl;
          }
        } catch {}
      }
    }
  }

  // 3. Fallback to Vercel image resizer if runner is not available
  try {
    const vResp = await fetch(buildResizeUrl(IMAGE_RESIZER));
    if (!vResp.ok) return null;
    const blob = await vResp.blob();
    saveToLocalMemory(blob);
    const objUrl = URL.createObjectURL(blob);
    cacheSet(key, objUrl);
    return objUrl;
  } catch {
    return null;
  }
}

// ─── Explicit Avatar Loader ──────────────────────────────────────────────────
export async function loadAvatar(url, size = 200) {
  return loadResizedImage(url, size, 85);
}
