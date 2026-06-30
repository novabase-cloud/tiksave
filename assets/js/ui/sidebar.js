import { el, icon, clear, mount } from '../utils/dom.js';
import { listUsers, fetchUserAvatarUrl } from '../api.js';
import { store } from '../store.js';
import { navigate } from '../router.js';
import { isDark, toggleTheme } from '../utils/theme.js';
import { themeIcon } from '../utils/icons.js';
import { loadResizedImage } from '../utils/cache.js';

const BATCH = 30;
const HAMBURGER_ICON = '<path d="M3 6h18M3 12h18M3 18h18"/>';

let sidebarEl = null;
let containerEl = null;
let userListEl = null;
let isOpen = false;
let allUsers = [];
let searchTerm = '';


export function getSidebar() {
  return sidebarEl;
}

export function toggleSidebar() {
  isOpen = !isOpen;
  const target = containerEl || sidebarEl;
  if (target) {
    target.classList.toggle('sidebar-open', isOpen);
  }
}

export function closeSidebar() {
  isOpen = false;
  const target = containerEl || sidebarEl;
  if (target) {
    target.classList.remove('sidebar-open');
  }
}

export function getSidebarToggleButton() {
  return el('button', {
    class: 'btn-icon sidebar-toggle-btn',
    title: 'Toggle user list',
    onClick: toggleSidebar,
  }, [icon(HAMBURGER_ICON, 20)]);
}

/* ── Lazy-loaded Sidebar User List ── */

function createUserItem(displayName, uid) {
  const isActive = store.state.currentUser === uid;
  return el('div', {
    class: 'sidebar-user-item' + (isActive ? ' active' : ''),
    'data-uid': uid,
    'data-username': displayName,
    onClick: () => navigate(`/profile/${uid}`),
  }, [
    el('div', { class: 'sidebar-user-avatar' }, [
      el('span', {}, [displayName[0]?.toUpperCase() || '?']),
    ]),
    el('span', { class: 'sidebar-user-name' }, [`@${displayName}`]),
  ]);
}

function filterUsers(users, term) {
  if (!term.trim()) return users;
  const q = term.toLowerCase();
  return users.filter(u => u.username.toLowerCase().includes(q));
}

function startLazyLoad(users) {
  let idx = 0;
  const filtered = filterUsers(users, searchTerm);

  clear(userListEl);

  if (!filtered.length) {
    userListEl.appendChild(el('div', { class: 'sidebar-empty' }, ['No users found']));
    return;
  }

  const sentinel = el('div', { class: 'sidebar-sentinel', style: { height: 1 } });
  userListEl.appendChild(sentinel);

  const avatarObs = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const item = entry.target;
      const username = item.dataset.username;
      const avatarEl = item.querySelector('.sidebar-user-avatar');
      if (!username || !avatarEl || avatarEl.querySelector('img')) continue;
      fetchUserAvatarUrl(username).then(url => {
        if (!url || !item.isConnected) return;
        loadResizedImage(url, 48).then(dataUrl => {
          if (!dataUrl || !item.isConnected) return;
          avatarEl.innerHTML = '';
          avatarEl.appendChild(el('img', { style: { width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover' }, src: dataUrl, alt: username }));
        });
      });
      avatarObs.unobserve(item);
    }
  }, { root: userListEl, rootMargin: '200px' });

  const loadBatch = () => {
    const batch = filtered.slice(idx, idx + BATCH);
    if (!batch.length) { sentinel.style.display = 'none'; return; }
    idx += BATCH;

    for (const user of batch) {
      const item = createUserItem(user.username, user.uid);
      avatarObs.observe(item);
      userListEl.insertBefore(item, sentinel);
    }
  };

  const sentinelObs = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting) loadBatch();
  }, { root: userListEl, rootMargin: '400px' });
  sentinelObs.observe(sentinel);

  loadBatch();
}

function handleSearchInput() {
  searchTerm = this.value;
  startLazyLoad(allUsers);
}

export async function initSidebar(container) {
  containerEl = container;
  sidebarEl = el('aside', { class: 'sidebar' });
  const headerRow = el('div', { class: 'sidebar-header' }, [
    el('span', { class: 'sidebar-title' }, 'Users'),
    el('button', {
      class: 'btn-icon sidebar-close-btn',
      onClick: closeSidebar,
    }, ['✕']),
  ]);

  const searchBar = el('div', { class: 'sidebar-search' }, [
    el('div', { class: 'sidebar-search-wrapper' }, [
      el('span', { class: 'sidebar-search-icon' }, [
        icon('M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35', 16),
      ]),
      el('input', {
        class: 'sidebar-search-input',
        type: 'text',
        placeholder: 'Search users...',
        onInput: handleSearchInput,
      }),
    ]),
  ]);

  userListEl = el('div', { class: 'sidebar-user-list' });
  sidebarEl.appendChild(headerRow);
  sidebarEl.appendChild(searchBar);
  sidebarEl.appendChild(userListEl);

  const backdrop = el('div', {
    class: 'sidebar-backdrop',
    onClick: closeSidebar,
  });

  const themeBtn = el('button', {
    class: 'sidebar-theme-btn',
    title: 'Toggle theme',
    onClick: () => {
      toggleTheme();
      const newIcon = themeIcon(isDark(), 16);
      themeBtn.replaceChild(newIcon, themeBtn.querySelector('svg'));
    },
  }, [
    themeIcon(isDark(), 16),
    el('span', {}, 'Theme'),
  ]);

  const themeFooter = el('div', { class: 'sidebar-footer' }, [
    themeBtn,
    el('div', { class: 'sidebar-footer-sep' }),
    el('div', { class: 'sidebar-footer-info' }, [
      el('span', {}, ['© 2026 TikSave Archive']),
      el('span', {}, ['Powered by HF Hub']),
    ]),
  ]);
  sidebarEl.appendChild(themeFooter);
  sidebarEl.appendChild(backdrop);

  container.appendChild(sidebarEl);

  store.subscribe((state) => {
    if (state.currentUser && sidebarEl) {
      const items = sidebarEl.querySelectorAll('.sidebar-user-item');
      for (const item of items) {
        item.classList.toggle('active', item.dataset.uid === state.currentUser);
      }
    }
  });

  try {
    allUsers = await listUsers();
    allUsers.sort((a, b) => a.username.localeCompare(b.username));
    store.set({ users: allUsers, loading: false });
    startLazyLoad(allUsers);
  } catch (err) {
    mount(userListEl, el('div', { class: 'sidebar-empty' }, ['Failed to load users']));
  }
}
