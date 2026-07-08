import { el, icon, clear, mount } from '../utils/dom.js';
import { listUserItems, getItemThumbnail, getItemMediaFiles, getMediaUrl } from '../api.js';
import { store } from '../store.js';
import { openMediaViewer } from './mediaViewer.js';
import { generateVideoThumbnail } from '../utils/thumbUtils.js';
import { loadResizedImage, loadCachedImage } from '../utils/cache.js';
import { formatNumber } from '../utils/format.js';

const PLAY_ICON = '<polygon points="5 3 19 12 5 21 5 3"/>';

const MAX_CONCURRENT = 4;
let _pending = 0;
const _queue = [];

export function resetProfileQueue() {
  _queue.length = 0;
  _pending = 0;
}

function _processQueue() {
  while (_pending < MAX_CONCURRENT && _queue.length > 0) {
    const next = _queue.shift();
    _pending++;
    next().finally(() => { _pending--; _processQueue(); });
  }
}

function _enqueue(fn) {
  return new Promise((resolve, reject) => {
    _queue.push(() => fn().then(resolve, reject));
    _processQueue();
  });
}

export async function renderProfile(container, uid) {
  clear(container);
  window.scrollTo(0, 0);
  store.set({ loading: true, error: null, currentUser: uid, view: 'profile' });

  try {
    const data = await listUserItems(uid);
    const { items, metadata, avatarPath, userInfo } = data;

    store.set({ currentItems: items, loading: false });

    // Profile header
    const avatarUrl = avatarPath ? getMediaUrl(avatarPath) : null;
    const displayName = userInfo?.uniqueId || userInfo?.unique_id || uid;
    const nickname = userInfo?.nickname || '';
    const following = userInfo?.followingCount;
    const followers = userInfo?.followerCount;
    const likes = userInfo?.diggCount || userInfo?.heartCount;
    const bio = userInfo?.signature || '';
    const isVerified = userInfo?.verified || userInfo?.isVerified || false;

    const cachedAvatarSrc = avatarUrl ? await loadResizedImage(avatarUrl, 200) : null;
    const avatarImg = cachedAvatarSrc
      ? el('img', { class: 'profile-avatar', src: cachedAvatarSrc, alt: displayName, loading: 'lazy' })
      : avatarUrl
        ? el('img', { class: 'profile-avatar', src: avatarUrl, alt: displayName, loading: 'lazy' })
        : el('div', { class: 'profile-avatar-placeholder' }, [(displayName[0] || '?').toUpperCase()]);

    avatarImg.addEventListener('click', () => openAvatarPreview(avatarPath, displayName));

    const verifiedIcon = isVerified
      ? el('svg', { width: 20, height: 20, viewBox: '0 0 48 48', fill: 'currentColor', class: 'profile-verified-icon' }, [
          el('path', { d: 'M24 8.5a5.5 5.5 0 0 1 5.5 5.5v4.5h-11V14A5.5 5.5 0 0 1 24 8.5Zm8.5 10V14a8.5 8.5 0 0 0-17 0v4.5H11A2.5 2.5 0 0 0 8.5 21v19a2.5 2.5 0 0 0 2.5 2.5h26a2.5 2.5 0 0 0 2.5-2.5V21a2.5 2.5 0 0 0-2.5-2.5h-4.5Zm-21 3h25v18h-25v-18Z' }),
        ])
      : null;

    const statItems = [];
    if (following != null) statItems.push(el('div', { class: 'profile-stat' }, [
      el('strong', {}, formatNumber(following)),
      el('span', {}, 'Mengikuti'),
    ]));
    if (followers != null) statItems.push(el('div', { class: 'profile-stat' }, [
      el('strong', {}, formatNumber(followers)),
      el('span', {}, 'Pengikut'),
    ]));
    if (likes != null) statItems.push(el('div', { class: 'profile-stat' }, [
      el('strong', {}, formatNumber(likes)),
      el('span', {}, 'Suka'),
    ]));

    const profileHeader = el('div', { class: 'profile-header' }, [
      el('div', { class: 'profile-avatar-wrap' }, [avatarImg]),
      el('div', { class: 'profile-header-info' }, [
        el('div', { class: 'profile-name-row' }, [
          el('h1', { class: 'profile-nickname' }, [nickname || displayName]),
          verifiedIcon,
        ]),
        el('h2', { class: 'profile-username' }, [`@${displayName}`]),
        statItems.length ? el('div', { class: 'profile-stats' }, statItems) : null,
        bio ? el('div', { class: 'profile-bio' }, [bio]) : null,
      ]),
    ]);

    mount(container, el('div', {}, [profileHeader]));

    if (!items.length) {
      container.appendChild(el('div', { class: 'empty-state' }, [
        el('div', { class: 'empty-state-icon' }, ['📸']),
        el('h3', {}, 'No Posts Yet'),
        el('p', {}, 'This user has no archived content.'),
      ]));
      return;
    }

    const grid = el('div', { class: 'post-grid' });
    const posts = [];

    for (const [postIdx, item] of items.entries()) {
      const thumbUrl = getItemThumbnail(item);
      const mediaFiles = getItemMediaFiles(item);
      const isVideo = item.files.some(f => ['mp4', 'webm', 'mov'].includes(f.ext));
      const isImage = item.files.some(f => ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(f.ext));
      const stats = item.stats || {};
      const diggCount = stats.diggCount;
      const playCount = stats.playCount;

      posts.push({
        itemId: item.itemId,
        path: item.path,
        media: mediaFiles,
        files: item.files,
        isVideo,
        description: item.description,
        stats: item.stats,
        desc: item.desc,
        createTime: item.createTime,
      });

      let imgEl;
      if (isImage && thumbUrl) {
        imgEl = el('img', { alt: item.itemId });
      } else if (isVideo && thumbUrl) {
        const videoLoader = el('div', { class: 'post-card-video-loader' }, [
          el('span', { class: 'spinner' }),
        ]);
        imgEl = el('div', { class: 'post-card-video-thumb-wrap' }, [
          el('img', { class: 'post-card-video-thumb', alt: item.itemId, style: { display: 'none' } }),
          videoLoader,
        ]);
      } else {
        imgEl = el('div', { style: { width: '100%', height: '100%', background: 'var(--color-bg-muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-subtle)', fontSize: 12 } }, ['No preview']);
      }

      const card = el('div', {
        class: 'post-card',
        onClick: () => openMediaViewer(posts, postIdx, 0, {
          username: displayName,
          nickname,
          followers,
          userInfo,
        }),
      }, [
        imgEl,
        isVideo ? el('div', { class: 'post-card-video-indicator' }, [icon(PLAY_ICON, 14)]) : null,
        el('div', { class: 'post-card-stats' }, [
          diggCount != null ? el('span', { class: 'post-card-stat' }, [
            '❤️ ', formatNumber(diggCount),
          ]) : null,
          playCount != null ? el('span', { class: 'post-card-stat' }, [
            '▶️ ', formatNumber(playCount),
          ]) : null,
        ].filter(Boolean)),
      ]);
      card._thumbUrl = thumbUrl;
      card._isImage = isImage;
      card._isVideo = isVideo;
      grid.appendChild(card);
    }

    container.appendChild(grid);

    // Lazy-load thumbnails via IntersectionObserver
    const obs = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const card = entry.target;
        obs.unobserve(card);

        if (card._isImage && card._thumbUrl) {
          _enqueue(() => loadResizedImage(card._thumbUrl, 300)).then(dataUrl => {
            const img = card.querySelector('img:not(.post-card-video-thumb)');
            if (dataUrl && img && card.isConnected) img.src = dataUrl;
          });
        } else if (card._isVideo && card._thumbUrl) {
          _enqueue(() => generateVideoThumbnail(card._thumbUrl)).then(thumbUrl2 => {
            const vthumb = card.querySelector('.post-card-video-thumb');
            const loader = card.querySelector('.post-card-video-loader');
            if (thumbUrl2 && vthumb && card.isConnected) {
              vthumb.src = thumbUrl2;
              vthumb.style.display = '';
              if (loader) loader.style.display = 'none';
            }
          });
        }
      }
    }, { rootMargin: '400px' });

    for (const card of grid.children) {
      obs.observe(card);
    }
  } catch (err) {
    store.set({ loading: false, error: err.message });
    mount(container, el('div', { class: 'empty-state' }, [
      el('div', { class: 'empty-state-icon' }, ['⚠️']),
      el('h3', {}, 'Failed to Load Profile'),
      el('p', {}, err.message),
      el('button', {
        class: 'btn btn-primary',
        onClick: () => renderProfile(container, uid),
      }, 'Retry'),
    ]));
  }
}

function openAvatarPreview(avatarPath, username) {
  if (!avatarPath) return;
  const url = getMediaUrl(avatarPath);
  let backdrop = null;

  function closePreview() {
    if (backdrop) {
      backdrop.style.opacity = '0';
      backdrop.addEventListener('transitionend', () => {
        backdrop.remove();
        backdrop = null;
      }, { once: true });
    }
  }

  const img = el('img', { class: 'avatar-preview-img', alt: username });
  loadCachedImage(url, 'avatar').then(dataUrl => { if (img.isConnected) img.src = dataUrl; });

  backdrop = el('div', {
    class: 'avatar-preview-backdrop',
    onClick: (e) => { if (e.target === backdrop) closePreview(); },
    onKeydown: (e) => { if (e.key === 'Escape') closePreview(); },
    tabindex: '0',
  }, [
    el('button', { class: 'avatar-preview-close', onClick: () => closePreview() }, ['✕']),
    img,
  ]);
  document.body.appendChild(backdrop);
  requestAnimationFrame(() => { backdrop.style.opacity = '1'; });
  backdrop.focus();
}
