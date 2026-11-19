import { STORAGE_KEYS } from '../config.js';

let onUnauthorized = null;

export function setOnUnauthorized(callback) {
  onUnauthorized = callback;
}

export function getStoredToken() {
  try {
    const token = localStorage.getItem(STORAGE_KEYS.HF_TOKEN);
    return token ? token.trim() : null;
  } catch (_) {
    return null;
  }
}

export async function request(url, options = {}) {
  const { timeout = 30000, skipAuthHandler = false, ...fetchOptions } = options;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);

  const token = getStoredToken();
  const headers = new Headers(fetchOptions.headers || {});

  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  let finalUrl = url;
  try {
    const urlObj = new URL(url, window.location.origin);
    if (token && !urlObj.searchParams.has('token')) {
      urlObj.searchParams.set('token', token);
      finalUrl = urlObj.toString();
    }
  } catch (_) {}

  if (!headers.has('Accept')) {
    headers.set('Accept', 'application/json, text/plain, */*');
  }

  try {
    const response = await fetch(finalUrl, {
      ...fetchOptions,
      headers,
      signal: controller.signal,
    });
    clearTimeout(id);

    if (response.status === 401 && !skipAuthHandler) {
      handleUnauthorized();
    }

    return response;
  } catch (err) {
    clearTimeout(id);
    if (err.name === 'AbortError') throw new Error('Request timeout');
    throw err;
  }
}

export async function fetchJSON(url, options = {}) {
  try {
    const response = await request(url, options);
    const text = await response.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch (_) { data = null; }
    }
    return { ok: response.ok, status: response.status, data, raw: text, response };
  } catch (err) {
    throw err;
  }
}

function handleUnauthorized() {
  if (typeof onUnauthorized === 'function') {
    onUnauthorized();
  }
}
