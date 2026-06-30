import { $, el, mount } from './utils/dom.js';
import { isAuthenticated, loginWithCode, validateToken, logout, getUserInfo } from './auth.js';
import { initRouter, onRoute } from './router.js';
import { store } from './store.js';
import { STORAGE_KEYS } from './config.js';
import { setOnUnauthorized } from './utils/http.js';
import { clearUserListCache } from './api.js';
import { initTheme, isDark, toggleTheme } from './utils/theme.js';
import { themeIcon } from './utils/icons.js';
import { initLogin, renderLogin } from './ui/login.js';
import { renderUserList } from './ui/userList.js';
import { renderProfile } from './ui/profile.js';
import { initSidebar, getSidebarToggleButton, closeSidebar } from './ui/sidebar.js';

const root = $('#app');

function buildHeader() {
  const user = getUserInfo();
  const avatarEl = user?.avatarUrl
    ? el('img', { class: 'app-header-avatar', src: user.avatarUrl, alt: '' })
    : el('div', { class: 'app-header-avatar-placeholder' }, [(user?.name?.[0] || 'G').toUpperCase()]);

  let dropdownOpen = false;
  let dropdownEl = null;

  function closeDropdown() {
    if (dropdownEl) {
      dropdownEl.remove();
      dropdownEl = null;
    }
    dropdownOpen = false;
    document.removeEventListener('click', onDocClick);
  }

  function onDocClick(e) {
    if (dropdownOpen) closeDropdown();
  }

  function toggleDropdown(e) {
    e.stopPropagation();
    if (dropdownOpen) { closeDropdown(); return; }

    dropdownEl = el('div', { class: 'user-dropdown' }, [
      el('button', {
        class: 'user-dropdown-item user-dropdown-item--logout',
        onClick: (ev) => {
          ev.stopPropagation();
          closeDropdown();
          clearUserListCache();
          logout();
          showLoginScreen();
        },
      }, [
        el('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, [
          el('path', { d: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4' }),
          el('polyline', { points: '16 17 21 12 16 7' }),
          el('line', { x1: '21', y1: '12', x2: '9', y2: '12' }),
        ]),
        'Logout',
      ]),
    ]);

    const wrapper = e.currentTarget.parentElement;
    wrapper.appendChild(dropdownEl);
    dropdownOpen = true;
    document.addEventListener('click', onDocClick);
  }

  return el('header', { class: 'app-header' }, [
    getSidebarToggleButton(),
    el('div', { class: 'app-header-brand' }, [
      el('div', { class: 'app-header-brand-icon' }, [
        el('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, [
          el('path', { d: 'M19 7V4h-3M15 21H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h4l2 2h5a2 2 0 0 1 2 2v1M11 16a3 3 0 1 0 0-6 3 3 0 0 0 0 6z' }),
        ]),
      ]),
      el('span', { class: 'app-header-brand-text' }, 'TikSave Archive'),
    ]),
    el('div', { class: 'app-header-actions' }, [
      el('button', {
        class: 'btn-icon theme-toggle',
        title: 'Toggle theme',
        onClick: (e) => {
          toggleTheme();
          const btn = e.currentTarget;
          const isNowDark = isDark();
          btn.innerHTML = '';
          btn.appendChild(themeIcon(isNowDark));
        },
      }, [
        themeIcon(isDark()),
      ]),
      el('div', { class: 'app-header-user', onClick: toggleDropdown }, [
        avatarEl,
        el('span', { class: 'app-header-username' }, [user?.name || 'Guest']),
      ]),
    ]),
  ]);
}

function buildAppShell() {
  const header = buildHeader();
  const sidebarContainer = el('div', { class: 'sidebar-container', id: 'sidebar-container' });
  const main = el('main', { class: 'app-main', id: 'app-main' });
  const layout = el('div', { class: 'app-layout' }, [sidebarContainer, main]);
  const shell = el('div', { class: 'app-shell' }, [header, layout]);
  return { shell, main, sidebarContainer };
}

function showLoginScreen() {
  mount(root, el('div', { id: 'login-container' }));
  initLogin(() => {
    showApp();
  });
  renderLogin($('#login-container'));
}

function showApp() {
  const { shell, main, sidebarContainer } = buildAppShell();
  mount(root, shell);
  initSidebar(sidebarContainer);
}

function handleRoute(path) {
  const main = $('#app-main');
  if (!main) return;

  const p = path.replace(/\/$/, '') || '/';

  if (p === 'login') return;
  if (p === '' || p === '/') { renderUserList(main); return; }
  if (p.startsWith('profile/')) {
    renderProfile(main, p.slice(8));
  }
}

async function handleOAuthCallback() {
  const urlParams = new URLSearchParams(window.location.search);
  let code = urlParams.get('code');

  if (!code && window.location.hash.includes('?')) {
    const hashPart = window.location.hash.split('?')[1];
    const hashParams = new URLSearchParams(hashPart);
    code = hashParams.get('code');
  }

  if (code) {
    const storedState = localStorage.getItem(STORAGE_KEYS.OAUTH_STATE);
    const state = urlParams.get('state') || new URLSearchParams(window.location.hash.split('?')[1] || '').get('state');
    if (storedState && state && state !== storedState) {
      console.error('State mismatch');
      localStorage.removeItem(STORAGE_KEYS.OAUTH_STATE);
      return null;
    }
    localStorage.removeItem(STORAGE_KEYS.OAUTH_STATE);

    try {
      const success = await loginWithCode(code);
      if (success) {
        window.history.replaceState({}, document.title, window.location.origin + window.location.pathname + '#/');
        return true;
      }
      return null;
    } catch (err) {
      console.warn('OAuth callback failed:', err);
      return null;
    }
  }
  return null;
}

async function verifyAuthOnStartup() {
  const guestMode = localStorage.getItem(STORAGE_KEYS.GUEST_MODE) === 'true';
  if (guestMode) {
    store.set({ user: { name: 'Guest User', guest: true } });
    return true;
  }

  const oauthResult = await handleOAuthCallback();
  if (oauthResult) {
    clearUserListCache();
    const userData = await validateToken();
    if (userData) {
      store.set({ user: userData });
      return true;
    }
  }

  if (!isAuthenticated()) return false;

  try {
    clearUserListCache();
    const userData = await validateToken();
    if (!userData) return false;
    store.set({ user: userData });
    return true;
  } catch (err) {
    console.warn('verifyAuthOnStartup validation failed:', err);
    return false;
  }
}

function bootstrap() {
  initTheme();
  setOnUnauthorized(() => {
    if (localStorage.getItem(STORAGE_KEYS.GUEST_MODE) === 'true') return;
    logout();
    showLoginScreen();
  });

  verifyAuthOnStartup()
    .then((authed) => {
      onRoute(handleRoute);
      if (authed) {
        showApp();
        initRouter();
      } else {
        showLoginScreen();
        initRouter();
      }
    })
    .catch((err) => {
      console.warn('bootstrap failed:', err);
      onRoute(handleRoute);
      showLoginScreen();
      initRouter();
    });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}
