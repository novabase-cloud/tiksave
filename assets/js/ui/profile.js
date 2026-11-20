import { el, icon, clear, mount } from '../utils/dom.js';
import { listUserItems, getItemThumbnail, getItemMediaFiles, getItemAudio, getMediaUrl } from '../api.js';
import { store } from '../store.js';
import { openMediaViewer } from './mediaViewer.js?v=20261120_5';
import { generateVideoThumbnail, getVideoPreviewUrl } from '../utils/thumbUtils.js';
import { loadResizedImage, loadCachedImage, invalidateBackendUrl } from '../utils/cache.js';
import { formatNumber } from '../utils/format.js';
import { ICONS } from '../utils/icons.js?v=20261120_1';

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

export async function renderProfile(container, uid, targetItemId = null) {
  clear(container);
  window.scrollTo(0, 0);
  store.set({ loading: true, error: null, currentUser: uid, view: 'profile' });

  try {
    const data = await listUserItems(uid);
    const { items, metadata, avatarPath, avatarPaths, remoteAvatarUrl, userInfo, userEntry } = data;

    store.set({ currentItems: items, loading: false });

    // Profile header
    const avatarUrl = avatarPath ? getMediaUrl(avatarPath) : (remoteAvatarUrl || null);
    const displayName = userInfo?.uniqueId || userInfo?.unique_id || userEntry?.unique_id || uid;
    const nickname = userInfo?.nickname || userEntry?.nickname || '';
    const following = userInfo?.followingCount;
    const followers = userInfo?.followerCount;
    const likes = userInfo?.diggCount || userInfo?.heartCount;
    const bio = userInfo?.signature || '';
    const isVerified = userInfo?.verified || userInfo?.isVerified || false;

    // Profile header (gunakan full-res loadCachedImage tanpa kompresi downscaling backend)
    const cachedAvatarSrc = avatarUrl ? await loadCachedImage(avatarUrl, 'avatar') : null;
    const avatarImg = cachedAvatarSrc
      ? el('img', { class: 'profile-avatar', src: cachedAvatarSrc, alt: displayName, loading: 'lazy' })
      : avatarUrl
        ? el('img', { class: 'profile-avatar', src: avatarUrl, alt: displayName, loading: 'lazy' })
        : el('div', { class: 'profile-avatar-placeholder' }, [(displayName[0] || '?').toUpperCase()]);

    const allAvatarPaths = (avatarPaths && avatarPaths.length) ? avatarPaths : (avatarPath ? [avatarPath] : (remoteAvatarUrl ? [remoteAvatarUrl] : []));
    avatarImg.addEventListener('click', () => openAvatarPreview(allAvatarPaths, displayName));

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
        el('div', { class: 'empty-state-icon' }, [icon(ICONS.camera, 40)]),
        el('h3', {}, 'No Posts Yet'),
        el('p', {}, 'This user has no archived content.'),
      ]));
      return;
    }

    const grid = el('div', { class: 'post-grid' });
    const posts = [];

    const profileInfo = {
      username: displayName,
      nickname,
      followers,
      userInfo,
      uid,
    };
    store.set({ currentPosts: posts, currentProfileInfo: profileInfo });

    for (const [postIdx, item] of items.entries()) {
      const thumbUrl = getItemThumbnail(item);
      const mediaFiles = getItemMediaFiles(item);
      const audioInfo = getItemAudio(item);
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
        audio: audioInfo,
        description: item.description,
        stats: item.stats,
        desc: item.desc,
        createTime: item.createTime,
      });

      let imgEl;
      if (isImage && thumbUrl) {
        imgEl = el('img', { alt: '' });
      } else if (isVideo && thumbUrl) {
        const videoLoader = el('div', { class: 'post-card-video-loader' }, [
          el('span', { class: 'spinner' }),
        ]);
        imgEl = el('div', { class: 'post-card-video-thumb-wrap' }, [
          el('img', { class: 'post-card-video-thumb', alt: '', style: { display: 'none' } }),
          videoLoader,
        ]);
      } else {
        imgEl = el('div', { style: { width: '100%', height: '100%', background: 'var(--color-bg-muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-subtle)', fontSize: 12 } }, ['No preview']);
      }

      const card = el('div', {
        class: 'post-card',
        onClick: () => {
          const pv = card.querySelector('.post-card-preview-video');
          if (pv) {
            pv.style.opacity = '0';
            pv.pause();
          }
          openMediaViewer(posts, postIdx, 0, profileInfo);
        },
      }, [
        imgEl,
        isVideo ? el('div', { class: 'post-card-video-indicator' }, [icon(PLAY_ICON, 14)]) : null,
        !isVideo && audioInfo ? el('div', { class: 'post-card-music-indicator', title: 'Foto dengan musik' }, [icon(ICONS.music, 12)]) : null,
        el('div', { class: 'post-card-stats' }, [
          diggCount != null ? el('span', { class: 'post-card-stat' }, [
            icon(ICONS.heart, 11),
            el('span', {}, formatNumber(diggCount)),
          ]) : null,
          playCount != null ? el('span', { class: 'post-card-stat' }, [
            icon(ICONS.play, 11),
            el('span', {}, formatNumber(playCount)),
          ]) : null,
        ].filter(Boolean)),
      ]);
      card._thumbUrl = thumbUrl;
      card._isImage = isImage;
      card._isVideo = isVideo;

      // Video hover preview (compressed & resized backend streaming)
      if (isVideo && thumbUrl) {
        let hoverTimeout = null;
        let previewVideo = null;
        let isHovered = false;

        card.addEventListener('mouseenter', () => {
          isHovered = true;
          hoverTimeout = setTimeout(async () => {
            if (!isHovered || !card.isConnected) return;

            const wrap = card.querySelector('.post-card-video-thumb-wrap');
            if (!wrap) return;

            if (!previewVideo) {
              previewVideo = el('video', {
                class: 'post-card-preview-video',
                muted: true,
                loop: true,
                playsinline: true,
                preload: 'auto',
              });
              previewVideo.muted = true;
              previewVideo.playsInline = true;

              previewVideo.addEventListener('canplay', () => {
                if (isHovered && previewVideo && card.isConnected) {
                  previewVideo.style.opacity = '1';
                  previewVideo.play().catch(() => {});
                }
              });

              previewVideo.addEventListener('error', () => {
                if (previewVideo && previewVideo.src !== thumbUrl) {
                  invalidateBackendUrl();
                  previewVideo.src = thumbUrl;
                  previewVideo.load();
                }
              });

              wrap.appendChild(previewVideo);
            }

            try {
              const previewSrc = await getVideoPreviewUrl(thumbUrl, 320, 4);
              if (isHovered && previewVideo && card.isConnected) {
                if (previewVideo.src !== previewSrc) {
                  previewVideo.src = previewSrc;
                  previewVideo.load();
                } else {
                  previewVideo.style.opacity = '1';
                  previewVideo.play().catch(() => {});
                }
              }
            } catch {
              if (isHovered && previewVideo && card.isConnected) {
                previewVideo.src = thumbUrl;
                previewVideo.load();
              }
            }
          }, 180);
        });

        card.addEventListener('mouseleave', () => {
          isHovered = false;
          if (hoverTimeout) {
            clearTimeout(hoverTimeout);
            hoverTimeout = null;
          }
          if (previewVideo) {
            previewVideo.style.opacity = '0';
            previewVideo.pause();
            previewVideo.currentTime = 0;
          }
        });
      }

      grid.appendChild(card);
    }

    container.appendChild(grid);

    if (targetItemId) {
      const targetIdx = posts.findIndex(p => String(p.itemId) === String(targetItemId));
      if (targetIdx !== -1) {
        openMediaViewer(posts, targetIdx, 0, profileInfo);
      }
    }

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
              vthumb.onload = () => {
                vthumb.style.display = '';
                if (loader) loader.style.display = 'none';
              };
              vthumb.onerror = () => {
                if (loader) loader.style.display = 'none';
              };
              vthumb.src = thumbUrl2;
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
      el('div', { class: 'empty-state-icon' }, [icon(ICONS.alertTriangle, 40)]),
      el('h3', {}, 'Failed to Load Profile'),
      el('p', {}, err.message),
      el('button', {
        class: 'btn btn-primary',
        onClick: () => renderProfile(container, uid),
      }, 'Retry'),
    ]));
  }
}

function openAvatarPreview(avatarList, username) {
  if (!avatarList) return;
  const rawList = Array.isArray(avatarList) ? avatarList : [avatarList];
  if (!rawList.length) return;

  const urls = rawList.map(item => (typeof item === 'string' && (item.startsWith('http://') || item.startsWith('https://'))) ? item : getMediaUrl(item));
  if (!urls.length) return;

  // Default ke avatar terbaru (indeks terakhir)
  let idx = urls.length - 1;
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

  function updateSlide() {
    if (!backdrop) return;
    const img = backdrop.querySelector('.avatar-preview-img');
    const indicator = backdrop.querySelector('.avatar-preview-indicator');
    const stripItems = backdrop.querySelectorAll('.avatar-preview-strip-item');

    if (img) {
      const url = urls[idx];
      img.src = '';
      loadCachedImage(url, 'avatar').then(dataUrl => {
        if (img.isConnected && urls[idx] === url) {
          img.src = dataUrl;
        }
      }).catch(() => {
        if (img.isConnected) img.src = url;
      });
    }

    if (indicator) {
      const isLatest = idx === urls.length - 1;
      indicator.textContent = urls.length > 1
        ? `${idx + 1} / ${urls.length}${isLatest ? ' (Terbaru)' : ''}`
        : 'Foto Profil';
    }

    stripItems.forEach((btn, i) => {
      btn.classList.toggle('active', i === idx);
    });
  }

  const img = el('img', { class: 'avatar-preview-img', alt: username });

  let strip = null;
  if (urls.length > 1) {
    strip = el('div', { class: 'avatar-preview-strip' });
    urls.forEach((url, i) => {
      const thumb = el('img', { src: url, alt: '', loading: 'lazy' });
      const btn = el('button', {
        class: 'avatar-preview-strip-item' + (i === idx ? ' active' : ''),
        onClick: (e) => { e.stopPropagation(); idx = i; updateSlide(); },
      }, [thumb]);
      strip.appendChild(btn);
    });
  }

  const prevBtn = urls.length > 1 ? el('button', {
    class: 'avatar-preview-nav prev',
    onClick: (e) => {
      e.stopPropagation();
      idx = (idx - 1 + urls.length) % urls.length;
      updateSlide();
    },
    'aria-label': 'Sebelumnya',
  }, [icon(ICONS.chevronLeft, 22)]) : null;

  const nextBtn = urls.length > 1 ? el('button', {
    class: 'avatar-preview-nav next',
    onClick: (e) => {
      e.stopPropagation();
      idx = (idx + 1) % urls.length;
      updateSlide();
    },
    'aria-label': 'Selanjutnya',
  }, [icon(ICONS.chevronRight, 22)]) : null;

  const indicator = el('div', { class: 'avatar-preview-indicator' }, [
    urls.length > 1 ? `${idx + 1} / ${urls.length} (Terbaru)` : 'Foto Profil'
  ]);

  let touchStartX = 0;
  backdrop = el('div', {
    class: 'avatar-preview-backdrop',
    onClick: (e) => {
      if (e.target === backdrop || e.target.classList.contains('avatar-preview-img-wrap')) {
        closePreview();
      }
    },
    onKeydown: (e) => {
      if (e.key === 'Escape') closePreview();
      if (urls.length > 1) {
        if (e.key === 'ArrowLeft') {
          idx = (idx - 1 + urls.length) % urls.length;
          updateSlide();
        } else if (e.key === 'ArrowRight') {
          idx = (idx + 1) % urls.length;
          updateSlide();
        }
      }
    },
    onTouchstart: (e) => {
      touchStartX = e.changedTouches[0].screenX;
    },
    onTouchend: (e) => {
      const diff = e.changedTouches[0].screenX - touchStartX;
      if (Math.abs(diff) > 40 && urls.length > 1) {
        if (diff > 0) {
          idx = (idx - 1 + urls.length) % urls.length;
        } else {
          idx = (idx + 1) % urls.length;
        }
        updateSlide();
      }
    },
    tabindex: '0',
  }, [
    el('button', { class: 'avatar-preview-close', 'aria-label': 'Tutup preview', onClick: () => closePreview() }, [icon(ICONS.close, 18)]),
    indicator,
    prevBtn,
    el('div', { class: 'avatar-preview-img-wrap', style: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%' } }, [img]),
    nextBtn,
    strip,
  ].filter(Boolean));

  document.body.appendChild(backdrop);
  updateSlide();
  requestAnimationFrame(() => { backdrop.style.opacity = '1'; });
  backdrop.focus();
}
