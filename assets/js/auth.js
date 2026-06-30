import { STORAGE_KEYS, HF_API } from './config.js';
import { fetchJSON } from './utils/http.js';
import { handleCallback, revokeToken, refreshAccessToken } from './utils/oauth.js';

const TOKEN_KEY = STORAGE_KEYS.HF_TOKEN;
const REFRESH_KEY = STORAGE_KEYS.HF_REFRESH_TOKEN;
const USER_KEY = STORAGE_KEYS.USER_INFO;
const GUEST_KEY = STORAGE_KEYS.GUEST_MODE;

let cachedToken = null;

export function getToken() {
  if (cachedToken) return cachedToken;
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    if (token) {
      cachedToken = token.trim();
      return cachedToken;
    }
  } catch (_) {}
  return null;
}

export function getRefreshToken() {
  try { return localStorage.getItem(REFRESH_KEY); } catch (_) { return null; }
}

export function isAuthenticated() {
  return Boolean(getToken()) || isGuestMode();
}

export function isGuestMode() {
  return localStorage.getItem(GUEST_KEY) === 'true';
}

export function setGuestMode(enabled) {
  if (enabled) {
    localStorage.setItem(GUEST_KEY, 'true');
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);
  } else {
    localStorage.removeItem(GUEST_KEY);
  }
}

export function getUserInfo() {
  if (isGuestMode()) {
    return { name: 'Guest User', avatarUrl: null, guest: true };
  }
  try {
    const info = localStorage.getItem(USER_KEY);
    return info ? JSON.parse(info) : null;
  } catch (_) {
    return null;
  }
}

async function tryRefresh() {
  const refresh = getRefreshToken();
  if (!refresh) return false;
  try {
    const data = await refreshAccessToken(refresh);
    if (data.access_token) {
      localStorage.setItem(TOKEN_KEY, data.access_token);
      cachedToken = data.access_token;
      if (data.refresh_token) localStorage.setItem(REFRESH_KEY, data.refresh_token);
      return true;
    }
    return false;
  } catch (_) {
    return false;
  }
}

export async function validateToken() {
  if (isGuestMode()) return { name: 'Guest User', guest: true };
  let token = getToken();
  if (!token) return false;

  try {
    let result = await fetchJSON(`${HF_API}/oauth/userinfo`, { skipAuthHandler: true });
    if (result.status === 401) {
      const refreshed = await tryRefresh();
      if (refreshed) {
        token = getToken();
        result = await fetchJSON(`${HF_API}/oauth/userinfo`, { skipAuthHandler: true });
      }
    }
    if (result.ok && result.data) {
      const user = result.data;
      const normalized = {
        name: user.preferred_username || user.name || user.sub,
        avatarUrl: user.picture,
        ...user,
      };
      localStorage.setItem(USER_KEY, JSON.stringify(normalized));
      return normalized;
    }
    return false;
  } catch (err) {
    console.warn('validateToken failed:', err);
    return false;
  }
}

export async function loginWithCode(code) {
  try {
    const data = await handleCallback(code);
    if (data.access_token) {
      localStorage.setItem(TOKEN_KEY, data.access_token);
      cachedToken = data.access_token;
      if (data.refresh_token) localStorage.setItem(REFRESH_KEY, data.refresh_token);
      return true;
    }
    return false;
  } catch (err) {
    console.warn('loginWithCode failed:', err);
    return false;
  }
}

export function logout() {
  const token = cachedToken || getToken();
  cachedToken = null;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(GUEST_KEY);
  if (token) revokeToken(token);
}
