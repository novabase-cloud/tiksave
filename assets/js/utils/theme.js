import { STORAGE_KEYS } from '../config.js';

const THEME_KEY = STORAGE_KEYS.THEME;

function readStored() {
  try {
    return localStorage.getItem(THEME_KEY);
  } catch (_) {
    return null;
  }
}

function writeStored(theme) {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch (_) {
    /* ignore */
  }
}

function systemPrefersDark() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function applyTheme(theme) {
  const resolved = theme === 'auto' ? (systemPrefersDark() ? 'dark' : 'light') : theme;
  document.documentElement.setAttribute('data-theme', resolved);
}

export function getStoredTheme() {
  return readStored() || 'light';
}

export function initTheme() {
  const stored = readStored();
  applyTheme(stored || 'light');
}

export function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  const next = current === 'dark' ? 'light' : 'dark';
  writeStored(next);
  applyTheme(next);
  return next;
}

export function isDark() {
  return document.documentElement.getAttribute('data-theme') === 'dark';
}
