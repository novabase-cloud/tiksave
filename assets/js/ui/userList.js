import { el, icon, clear, mount } from '../utils/dom.js';
import { listUsers, fetchUserAvatarUrl } from '../api.js';
import { store } from '../store.js';
import { navigate } from '../router.js';
import { loadResizedImage } from '../utils/cache.js';
import { getDatasetRepo } from '../config.js';

const FOLDER_ICON = '<path d="M2 6a2 2 0 0 1 2-2h5l2 2h5a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6z"></path>';

export async function renderUserList(container) {
  clear(container);
  store.set({ loading: true, error: null, view: 'users' });

  const header = el('div', { class: 'page-header' }, [
    el('h1', { class: 'page-title' }, 'TikTok Archive'),
    el('p', { class: 'page-subtitle' }, `Browse archived TikTok profiles${getDatasetRepo() ? ` from ${getDatasetRepo()}` : ''}.`),
  ]);

  const searchWrap = el('div', { class: 'user-search-wrap' }, [
    el('input', {
      type: 'text',
      class: 'user-search-input',
      placeholder: 'Search users...',
      autocomplete: 'off',
      spellcheck: 'false',
      onInput: function () {
        const q = this.value.toLowerCase().trim();
        const grid = document.querySelector('.user-grid');
        if (!grid) return;
        const cards = grid.querySelectorAll('.user-card');
        for (const card of cards) {
          const name = (card.dataset.username || '').toLowerCase();
          card.style.display = (!q || name.includes(q)) ? '' : 'none';
        }
      },
    }),
  ]);

  const gridWrap = el('div', { class: 'user-grid-wrap' });
  mount(container, el('div', {}, [header, searchWrap, gridWrap]));

  try {
    const users = await listUsers();
    users.sort((a, b) => a.username.localeCompare(b.username));
    store.set({ users, loading: false });

    if (!users.length) {
      mount(gridWrap, el('div', { class: 'empty-state' }, [
        el('div', { class: 'empty-state-icon' }, ['📁']),
        el('h3', {}, 'No Users Found'),
        el('p', {}, 'The archive does not contain any user data yet.'),
      ]));
      return;
    }

    const grid = el('div', { class: 'user-grid' });

    for (const user of users) {
      const displayName = user.username;
      const card = el('div', {
        class: 'user-card',
        'data-username': displayName,
        onClick: () => navigate(`/profile/${user.uid}`),
      }, [
        el('div', { class: 'user-card-avatar-placeholder' }, [displayName[0]?.toUpperCase() || '?']),
        el('div', { class: 'user-card-name' }, [`@${displayName}`]),
        user.nickname ? el('div', { class: 'user-card-nickname' }, [user.nickname]) : null,
      ]);
      grid.appendChild(card);
      fetchUserAvatarUrl(displayName).then(url => {
        if (!url) return;
        const ph = card.querySelector('.user-card-avatar-placeholder');
        if (!ph || !ph.isConnected) return;
        loadResizedImage(url, 300).then(dataUrl => {
          if (!dataUrl || !ph.isConnected) return;
          ph.textContent = '';
          ph.appendChild(el('img', { class: 'user-card-avatar-img', src: dataUrl, alt: displayName }));
        });
      }).catch(() => {});
    }

    mount(gridWrap, el('div', {}, [
      grid,
      el('div', { style: { textAlign: 'center', marginTop: 16, fontSize: 13, color: 'var(--color-text-subtle)' } }, [
        `${users.length} archived user${users.length !== 1 ? 's' : ''}`,
      ]),
    ]));
  } catch (err) {
    store.set({ loading: false, error: err.message });
    mount(gridWrap, el('div', { class: 'empty-state' }, [
      el('div', { class: 'empty-state-icon' }, ['⚠️']),
      el('h3', {}, 'Failed to Load Users'),
      el('p', {}, err.message),
      el('button', { class: 'btn btn-primary', onClick: () => renderUserList(container) }, 'Retry'),
    ]));
  }
}
