import { STORAGE_KEYS } from '../config.js';

function getRedirectUri() {
  const origin = window.location.origin;
  const path = window.location.pathname.replace(/\/+$/, '').replace(/\/index\.html$/i, '');
  return `${origin}${path}/#/login`.replace(/([^:]\/)\/+/g, '$1');
}

export const OAUTH_CONFIG = {
  CLIENT_ID: '4a24e0b5-f1e2-4594-9244-1576196ab441',
  REDIRECT_URI: getRedirectUri(),
  SCOPE: 'openid profile read-repos',
  AUTH_URL: 'https://huggingface.co/oauth/authorize',
  TOKEN_URL: 'https://huggingface.co/oauth/token',
  REVOKE_URL: 'https://huggingface.co/oauth/revoke',
};

export async function refreshAccessToken(refreshToken) {
  if (!refreshToken) throw new Error('No refresh token');
  const payload = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: OAUTH_CONFIG.CLIENT_ID,
  });
  const response = await fetch(OAUTH_CONFIG.TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: payload,
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error_description || data.error);
  return data;
}

function generateRandomString(length) {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const values = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(values).map((x) => possible[x % possible.length]).join('');
}

async function sha256(plain) {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  return crypto.subtle.digest('SHA-256', data);
}

function base64urlencode(a) {
  return btoa(String.fromCharCode.apply(null, new Uint8Array(a)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export async function initiateLogin() {
  const codeVerifier = generateRandomString(64);
  const hashed = await sha256(codeVerifier);
  const codeChallenge = base64urlencode(hashed);

  const state = generateRandomString(16);
  localStorage.setItem(STORAGE_KEYS.OAUTH_VERIFIER, codeVerifier);
  localStorage.setItem(STORAGE_KEYS.OAUTH_STATE, state);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: OAUTH_CONFIG.CLIENT_ID,
    redirect_uri: OAUTH_CONFIG.REDIRECT_URI,
    scope: OAUTH_CONFIG.SCOPE,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  });

  if (localStorage.getItem(STORAGE_KEYS.OAUTH_FORCE_CONSENT)) {
    params.set('prompt', 'consent');
    localStorage.removeItem(STORAGE_KEYS.OAUTH_FORCE_CONSENT);
  }

  window.location.href = `${OAUTH_CONFIG.AUTH_URL}?${params.toString()}`;
}

export async function revokeToken(token) {
  if (!token) return;
  try {
    await fetch(OAUTH_CONFIG.REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token, client_id: OAUTH_CONFIG.CLIENT_ID }),
    });
  } catch (err) {
    console.warn('revokeToken failed:', err);
  }
}

export async function handleCallback(code) {
  const codeVerifier = localStorage.getItem(STORAGE_KEYS.OAUTH_VERIFIER);
  if (!codeVerifier) throw new Error('Missing code_verifier');

  const payload = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: OAUTH_CONFIG.CLIENT_ID,
    redirect_uri: OAUTH_CONFIG.REDIRECT_URI,
    code_verifier: codeVerifier,
  });

  const response = await fetch(OAUTH_CONFIG.TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: payload,
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error_description || data.error);

  localStorage.removeItem(STORAGE_KEYS.OAUTH_VERIFIER);
  return data;
}
