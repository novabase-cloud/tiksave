import { el, icon, clear } from '../utils/dom.js';
import { HF_MEDIA_PROXY, getDatasetRepo } from '../config.js';
import { getToken } from '../auth.js';
import { fetchJSON } from '../utils/http.js';
import { navigate } from '../router.js';
import { formatNumber } from '../utils/format.js';
import { ICONS } from '../utils/icons.js?v=20261120_1';
import { generateVideoThumbnail, getVideoPreviewUrl } from '../utils/thumbUtils.js';
import { getBackendUrl, invalidateBackendUrl, loadResizedImage } from '../utils/cache.js';

const PAGE_SIZE = 10;
const MIN_LOAD_INTERVAL = 1500;

let items = [];
let page = 1;
let loading = false;
let allDone = false;
let container = null;
let pageEl = null;
let feedEl = null;
let infoPanelEl = null;
let thumbGrid = null;
let thumbContainer = null;
let navUpBtn = null;
let navDownBtn = null;
let muteBtn = null;
let sentinelEl = null;
let sentinelObserver = null;
let observer = null;
let thumbObserver = null;
const MAX_CONCURRENT_THUMBS = 2;
let thumbPending = 0;
const thumbQueue = [];

function processThumbQueue() {
  while (thumbPending < MAX_CONCURRENT_THUMBS && thumbQueue.length > 0) {
    const task = thumbQueue.shift();
    if (task.item) {
      if (!task.item.isConnected || task.item._myGen !== renderGen) {
        continue;
      }
      if (!task.item._inView && !task.item._loaded) {
        task.item._enqueued = false;
        continue;
      }
    }
    thumbPending++;
    task.run().finally(() => {
      thumbPending--;
      processThumbQueue();
    });
  }
}

function enqueueThumb(fn, item = null, priority = false) {
  return new Promise((resolve, reject) => {
    const task = {
      item,
      run: () => fn().then(resolve, reject),
    };
    if (priority) {
      thumbQueue.unshift(task);
    } else {
      thumbQueue.push(task);
    }
    processThumbQueue();
  });
}

function resetThumbQueue() {
  thumbQueue.length = 0;
  thumbPending = 0;
}
let activeItemIndex = -1;
let renderGen = 0;
let globalMuted = localStorage.getItem('newest-muted') !== 'false';
let lastLoadTime = 0;
let keydownHandler = null;
let isJumping = false;
let jumpTimeout = null;
let visibilityHandler = null;
const loadedVideoIndices = new Set();
const preloadedUrls = new Set();

function preloadPostImages(entry) {
  if (!entry || isVideo(entry.descData)) return;
  const count = getImageCount(entry.descData);
  if (count <= 1) return;
  for (let i = 0; i < count; i++) {
    const url = mediaUrl(entry.uid, entry.itemId, 'jpg', i);
    if (!preloadedUrls.has(url)) {
      preloadedUrls.add(url);
      const pre = new Image();
      pre.src = url;
    }
  }
}

function getBase() {
  const repo = getDatasetRepo() || 'Novabase/Tiktok';
  return `${HF_MEDIA_PROXY}/proxy/datasets/${repo}/resolve/main`;
}

function recUrl(p) {
  const token = getToken();
  let url = `${HF_MEDIA_PROXY}/recommendation?_t=${Date.now()}`;
  url += `&page=${p}&limit=${PAGE_SIZE}&sort=newest&enrich=true`;
  if (token) url += `&token=${encodeURIComponent(token)}`;
  return url;
}

function descUrl(uid, itemId) {
  const token = getToken();
  const base = getBase();
  let u = `${base}/Posts/${uid}/${itemId}/description.json`;
  if (token) u += `?token=${encodeURIComponent(token)}`;
  return u;
}

async function fetchBatchDescriptions(itemsToFetch) {
  if (!itemsToFetch || !itemsToFetch.length) return [];
  const token = getToken();
  const repo = getDatasetRepo() || 'Novabase/Tiktok';
  const payload = {
    repo,
    token: token || undefined,
    items: itemsToFetch.map(x => ({ uid: x.uid, itemId: x.itemId })),
  };

  // 1. Try active Rust runner backend first (via Teller)
  let backend = await getBackendUrl();
  if (backend) {
    try {
      const resp = await fetch(`${backend}/api/batch-descriptions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(payload),
      });
      if (resp.ok) {
        const json = await resp.json();
        if (json && json.ok && Array.isArray(json.data) && json.data.length > 0) {
          return json.data;
        }
      }
    } catch (err) {
      console.warn('[newest] Rust backend batch-descriptions failed, trying worker:', err);
    }
  }

  // 2. Try Cloudflare Worker batch endpoint
  try {
    const resp = await fetch(`${HF_MEDIA_PROXY}/batch-descriptions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
    });
    if (resp.ok) {
      const json = await resp.json();
      if (json && json.ok && Array.isArray(json.data) && json.data.length > 0) {
        return json.data;
      }
    }
  } catch (err) {
    console.warn('[newest] Cloudflare worker batch-descriptions failed, using fallback:', err);
  }

  // 3. Fallback: parallel individual requests
  const fallback = await Promise.all(
    itemsToFetch.map(item => {
      const uid = item.uid;
      const itemId = item.itemId;
      return fetchJSON(descUrl(uid, itemId))
        .then(r => {
          if (r.ok && r.data) return { descData: r.data, uid, itemId };
          return null;
        })
        .catch(() => null);
    })
  );
  return fallback.filter(Boolean);
}

function mediaUrl(uid, itemId, ext, index = 0) {
  const token = getToken();
  const base = getBase();
  let u = `${base}/Posts/${uid}/${itemId}/${itemId}-${index}.${ext}`;
  if (token) u += `?token=${encodeURIComponent(token)}`;
  return u;
}

function isVideo(descData) {
  if (descData.imagePost) return false;
  return !!descData.video;
}

function getImageCount(descData) {
  return descData.imagePost?.images?.length || 1;
}

function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function formatDateDDMMYY(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getFullYear()).slice(-2)}`;
}

/* SVG play/pause: text glyphs (U+25B6/U+23F8) render inconsistently across platforms */
const PLAY_SVG_LG = '<svg width="52" height="52" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M5 3l16 9-16 9V3z"/></svg>';
const PAUSE_SVG_LG = '<svg width="52" height="52" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>';
const PLAY_SVG_SM = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M5 3l16 9-16 9V3z"/></svg>';
const PAUSE_SVG_SM = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>';

function infoLabel(svgPath, text) {
  const svg = el('svg', { width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', style: 'vertical-align:middle;margin-right:3px;' }, [
    el('path', { d: svgPath }),
  ]);
  return el('span', { class: 'media-info-label' }, [svg, ` ${text}`]);
}

function buildInfoPanel() {
  const rows = [
    ['media-info-row-author', ICONS.users, 'author:'],
    ['media-info-row-uid', ICONS.users, 'uid:'],
    ['media-info-row-item-id', ICONS.fileText, 'item id:'],
    ['media-info-row-tiktok-link', ICONS.externalLink, 'TikTok link:'],
    ['media-info-row-likes', ICONS.heart, 'likes:'],
    ['media-info-row-plays', ICONS.play, 'plays:'],
    ['media-info-row-comments', ICONS.messageCircle, 'comments:'],
    ['media-info-row-shares', ICONS.share, 'shares:'],
    ['media-info-row-saves', ICONS.bookmark, 'saves:'],
    ['media-info-row-caption', ICONS.fileText, 'caption:'],
    ['media-info-row-hashtags', ICONS.hash, 'hashtags:'],
    ['media-info-row-music', ICONS.music, 'music:'],
    ['media-info-row-posted', ICONS.calendar, 'posted:'],
  ];

  const children = rows.map(([cls, path, text]) =>
    el('div', { class: `media-info-row ${cls}` }, [
      infoLabel(path, text),
      el('span', { class: 'media-info-value media-info-placeholder' }, ''),
    ])
  );

  return el('div', { class: 'media-info-panel newest2-info-panel' }, children);
}

function populateInfoPanel(entry) {
  const { descData, uid, itemId } = entry;
  const stats = descData.stats || {};
  const desc = descData.desc || '';
  const challenges = descData.challenges || [];
  const tags = challenges.map(c => c.title).filter(Boolean);
  const music = descData.music || {};
  const musicTitle = music.title || '';
  const musicAuthor = music.authorName || '';
  const authorStats = descData.authorStats || {};
  const auth = descData.author || {};
  const uniqueId = auth.uniqueId || auth.unique_id || uid;
  const dateStr = formatDate(descData.createTime);

  function setVal(cls, val) {
    const row = infoPanelEl?.querySelector(`.${cls} .media-info-value`);
    if (!row) return;
    row.textContent = val ?? '';
    if (val != null && val !== '') {
      row.classList.remove('media-info-placeholder');
    } else {
      row.classList.add('media-info-placeholder');
    }
  }

  setVal('media-info-row-author', uniqueId ? `@${uniqueId}` : null);
  setVal('media-info-row-uid', uid || null);
  setVal('media-info-row-item-id', itemId || null);

  const authorRow = infoPanelEl?.querySelector('.media-info-row-author .media-info-value');
  if (authorRow && uid) {
    authorRow.style.cursor = 'pointer';
    authorRow.title = `View @${uniqueId}'s profile`;
    authorRow.onclick = (e) => {
      e.stopPropagation();
      resetNewestCache();
      navigate(`profile/${uid}`);
    };
  }

  const uidRow = infoPanelEl?.querySelector('.media-info-row-uid .media-info-value');
  if (uidRow && uid) {
    uidRow.style.cursor = 'pointer';
    uidRow.title = `View profile (${uid})`;
    uidRow.onclick = (e) => {
      e.stopPropagation();
      resetNewestCache();
      navigate(`profile/${uid}`);
    };
  }

  const linkRow = infoPanelEl?.querySelector('.media-info-row-tiktok-link');
  if (linkRow) {
    const valEl = linkRow.querySelector('.media-info-value');
    if (valEl) {
      if (uniqueId && itemId) {
        const tUrl = `https://www.tiktok.com/@${uniqueId}/video/${itemId}`;
        valEl.innerHTML = '';
        valEl.appendChild(el('a', {
          class: 'media-info-link',
          href: tUrl,
          target: '_blank',
          rel: 'noopener',
        }, tUrl));
        valEl.classList.remove('media-info-placeholder');
      } else {
        valEl.textContent = '';
        valEl.classList.add('media-info-placeholder');
      }
    }
  }

  setVal('media-info-row-likes', stats.diggCount != null ? formatNumber(stats.diggCount) : null);
  setVal('media-info-row-plays', stats.playCount != null ? formatNumber(stats.playCount) : null);
  setVal('media-info-row-comments', stats.commentCount != null ? String(stats.commentCount) : null);
  setVal('media-info-row-shares', stats.shareCount != null ? String(stats.shareCount) : null);
  setVal('media-info-row-saves', stats.collectCount != null ? String(stats.collectCount) : null);
  setVal('media-info-row-caption', desc || null);
  setVal('media-info-row-hashtags', tags.length ? '#' + tags.join(' #') : null);
  const musicStr = (musicTitle || musicAuthor)
    ? [musicAuthor ? `${musicAuthor} · ` : '', musicTitle].filter(Boolean).join('')
    : null;
  setVal('media-info-row-music', musicStr);
  setVal('media-info-row-posted', dateStr || null);
}

function buildThumbnailItem(entry, index) {
  const { descData, uid, itemId } = entry;
  const loader = el('div', { class: 'newest2-thumb-loader' }, [
    el('div', { class: 'spinner' }),
  ]);

  const item = el('div', {
    class: 'newest2-thumb-item' + (index === activeItemIndex ? ' active' : ''),
    'data-index': String(index),
    onClick: () => switchToItem(index),
  }, [loader]);

  const vid = isVideo(descData);
  const ext = vid ? 'mp4' : 'jpg';
  const src = mediaUrl(uid, itemId, ext);
  const myGen = renderGen;

  if (vid) {
    let hoverTimeout = null;
    let previewVideo = null;
    let isHovered = false;

    item.addEventListener('mouseenter', () => {
      isHovered = true;
      hoverTimeout = setTimeout(async () => {
        if (!isHovered || !item.isConnected || renderGen !== myGen) return;

        if (!previewVideo) {
          previewVideo = el('video', {
            class: 'newest2-thumb-preview-video',
            muted: true,
            loop: true,
            playsinline: true,
            preload: 'auto',
          });
          previewVideo.muted = true;
          previewVideo.playsInline = true;

          previewVideo.addEventListener('canplay', () => {
            if (isHovered && previewVideo && item.isConnected) {
              previewVideo.style.opacity = '1';
              previewVideo.play().catch(() => {});
            }
          });

          previewVideo.addEventListener('error', () => {
            if (previewVideo && previewVideo.src !== src) {
              invalidateBackendUrl();
              previewVideo.src = src;
              previewVideo.load();
            }
          });

          item.appendChild(previewVideo);
        }

        try {
          const previewSrc = await getVideoPreviewUrl(src, 180, 4);
          if (isHovered && previewVideo && item.isConnected) {
            if (previewVideo.src !== previewSrc) {
              previewVideo.src = previewSrc;
              previewVideo.load();
            } else {
              previewVideo.style.opacity = '1';
              previewVideo.play().catch(() => {});
            }
          }
        } catch {
          if (isHovered && previewVideo && item.isConnected) {
            previewVideo.src = src;
            previewVideo.load();
          }
        }
      }, 180);
    });

    item.addEventListener('mouseleave', () => {
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

    item._myGen = myGen;
    item._loadThumb = (priority = false) => {
      if (!item.isConnected || renderGen !== myGen || item._loaded) return;
      if (item._enqueued) return;
      item._enqueued = true;

      enqueueThumb(() => generateVideoThumbnail(src, 160), item, priority).then(dataUrl => {
        item._enqueued = false;
        if (!dataUrl || renderGen !== myGen || !item.isConnected) return;
        item._loaded = true;
        if (thumbObserver) thumbObserver.unobserve(item);

        const img = el('img', { src: dataUrl, alt: '', loading: 'lazy' });
        const hideVideoThumbLoader = () => {
          if (renderGen !== myGen) return;
          const existingLoader = item.querySelector('.newest2-thumb-loader');
          if (existingLoader) {
            existingLoader.style.display = 'none';
            existingLoader.remove();
          }
        };
        if (img.complete && img.naturalWidth > 0) {
          hideVideoThumbLoader();
        } else {
          img.onload = hideVideoThumbLoader;
          img.onerror = hideVideoThumbLoader;
        }
        item.appendChild(img);
      }).catch(() => {
        item._enqueued = false;
        const existingLoader = item.querySelector('.newest2-thumb-loader');
        if (existingLoader) {
          existingLoader.style.display = 'none';
          existingLoader.remove();
        }
      });
    };
  } else {
    item._myGen = myGen;
    item._loadThumb = (priority = false) => {
      if (!item.isConnected || renderGen !== myGen || item._loaded) return;
      if (item._enqueued) return;
      item._enqueued = true;

      enqueueThumb(() => loadResizedImage(src, 160, 80), item, priority).then(thumbUrl => {
        item._enqueued = false;
        if (renderGen !== myGen || !item.isConnected) return;
        item._loaded = true;
        if (thumbObserver) thumbObserver.unobserve(item);

        const finalSrc = thumbUrl || src;
        const img = el('img', { src: finalSrc, alt: '', loading: 'lazy' });
        const hideImgThumbLoader = () => {
          if (renderGen !== myGen) return;
          const existingLoader = item.querySelector('.newest2-thumb-loader');
          if (existingLoader) {
            existingLoader.style.display = 'none';
            existingLoader.remove();
          }
        };
        if (img.complete && img.naturalWidth > 0) {
          hideImgThumbLoader();
        } else {
          img.onload = hideImgThumbLoader;
          img.onerror = hideImgThumbLoader;
        }
        item.appendChild(img);
      }).catch(() => {
        item._enqueued = false;
        const existingLoader = item.querySelector('.newest2-thumb-loader');
        if (existingLoader) {
          existingLoader.style.display = 'none';
          existingLoader.remove();
        }
      });
    };
  }

  return item;
}

function renderThumbnailBatch(batch, startIdx) {
  if (!thumbGrid) return;
  if (sentinelEl) {
    sentinelEl.remove();
    sentinelEl = null;
  }

  batch.forEach((entry, i) => {
    const item = buildThumbnailItem(entry, startIdx + i);
    thumbGrid.appendChild(item);
    if (thumbObserver) {
      thumbObserver.observe(item);
    } else if (item._loadThumb) {
      item._loadThumb();
    }
  });

  sentinelEl = el('div', { class: 'newest2-thumb-sentinel' });
  thumbGrid.appendChild(sentinelEl);

  if (sentinelObserver) sentinelObserver.disconnect();
  sentinelObserver = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && !loading && !allDone) {
      loadPage(page);
    }
  }, { root: thumbContainer, rootMargin: '200px' });
  sentinelObserver.observe(sentinelEl);
}

function updateNavButtons() {
  if (navUpBtn) navUpBtn.disabled = activeItemIndex <= 0;
  if (navDownBtn) navDownBtn.disabled = activeItemIndex >= items.length - 1;
}

function highlightActiveThumb() {
  if (!thumbGrid) return;
  thumbGrid.querySelectorAll('.newest2-thumb-item').forEach(item => {
    const isAct = parseInt(item.dataset.index, 10) === activeItemIndex;
    item.classList.toggle('active', isAct);
    if (isAct) {
      item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  });
}

function updateMediaWindow(activeIndex) {
  if (!feedEl) return;

  const windowIndices = new Set();
  for (let offset = -1; offset <= 1; offset++) {
    const idx = activeIndex + offset;
    if (idx >= 0 && idx < items.length) {
      windowIndices.add(idx);
    }
  }

  // 1. Unload videos outside active window
  for (const idx of Array.from(loadedVideoIndices)) {
    if (!windowIndices.has(idx)) {
      const slide = feedEl.querySelector(`.newest2-slide[data-index="${idx}"]`);
      if (slide) {
        const video = slide.querySelector('video');
        if (video) {
          video.pause();
          video.removeAttribute('src');
          video.load();
          const timeEl = slide.querySelector('.newest2-time-display');
          const seekBar = slide.querySelector('.newest2-seek-bar');
          if (timeEl) timeEl.textContent = '0:00 / 0:00';
          if (seekBar) seekBar.value = '0';
          const flashBtn = slide.querySelector('.newest2-play-flash');
          const playBtnBottom = slide.querySelector('.newest2-play-btn-bottom');
          if (flashBtn) {
            flashBtn.innerHTML = PLAY_SVG_LG;
            flashBtn.classList.add('newest2-play-flash-visible');
          }
          if (playBtnBottom) playBtnBottom.innerHTML = PLAY_SVG_SM;
          const freezeImg = slide.querySelector('.newest2-freeze-frame');
          if (freezeImg) {
            freezeImg.style.display = 'none';
            freezeImg.removeAttribute('src');
          }
        }
      }
      loadedVideoIndices.delete(idx);
    }
  }

  // 2. Load videos inside active window
  for (const idx of windowIndices) {
    const slide = feedEl.querySelector(`.newest2-slide[data-index="${idx}"]`);
    if (!slide) continue;
    const video = slide.querySelector('video');
    if (!video) continue;

    const targetSrc = video.dataset.src;
    if (targetSrc && video.getAttribute('src') !== targetSrc) {
      video.src = targetSrc;
      video.preload = (idx === activeIndex) ? 'auto' : 'metadata';
      video.load();
    }

    loadedVideoIndices.add(idx);

    if (idx === activeIndex) {
      video.muted = globalMuted;
      video.play().catch(() => {});
    } else {
      if (!video.paused) video.pause();
    }
  }
}

function activateSlide(idx) {
  if (idx < 0 || idx >= items.length) return;

  const prevIdx = activeItemIndex;
  activeItemIndex = idx;

  if (prevIdx >= 0 && prevIdx !== idx) {
    const prevSlide = feedEl?.querySelector(`.newest2-slide[data-index="${prevIdx}"]`);
    if (prevSlide) {
      prevSlide.classList.remove('active');
      if (prevSlide.dataset.imgCount > 1) {
        prevSlide.dataset.imgIdx = '0';
        const img = prevSlide.querySelector('img');
        if (img) {
          const entry2 = items[prevIdx];
          if (entry2) img.src = mediaUrl(entry2.uid, entry2.itemId, 'jpg', 0);
        }
        const ctr = prevSlide.querySelector('[data-counter]');
        if (ctr) ctr.textContent = `1/${prevSlide.dataset.imgCount}`;
      }
    }
  }

  const curSlide = feedEl?.querySelector(`.newest2-slide[data-index="${idx}"]`);
  if (curSlide) {
    curSlide.classList.add('active');
  }

  updateMediaWindow(idx);

  if (items[idx]) {
    const { uid, itemId } = items[idx];
    if (uid && itemId) {
      window.history.replaceState(null, '', `#/newest/${uid}/${itemId}`);
    }
    populateInfoPanel(items[idx]);
    preloadPostImages(items[idx]);
    if (items[idx + 1]) preloadPostImages(items[idx + 1]);
    if (items[idx + 2]) preloadPostImages(items[idx + 2]);
  }
  highlightActiveThumb();
  updateNavButtons();
  loadMoreIfNeeded();
}

function switchToItem(index) {
  if (!feedEl || index < 0 || index >= items.length) return;
  if (index === activeItemIndex) return;

  isJumping = true;
  if (jumpTimeout) clearTimeout(jumpTimeout);

  pauseAllVideos();

  const prevBehavior = feedEl.style.scrollBehavior;
  feedEl.style.scrollBehavior = 'auto';

  const targetSlide = feedEl.querySelector(`.newest2-slide[data-index="${index}"]`);
  if (targetSlide) {
    targetSlide.scrollIntoView({ behavior: 'instant', block: 'start' });
  } else {
    feedEl.scrollTop = index * feedEl.clientHeight;
  }

  feedEl.style.scrollBehavior = prevBehavior;

  activateSlide(index);

  jumpTimeout = setTimeout(() => {
    isJumping = false;
    jumpTimeout = null;
  }, 100);
}

function buildMuteButton() {
  const icon = globalMuted
    ? el('svg', { width: 22, height: 22, viewBox: '0 0 48 48', fill: '#fff' }, [
        el('path', { d: 'M7 16a3 3 0 0 0-3 3v11.17a3 3 0 0 0 3 3h4.2a2 2 0 0 1 1.46.63l8.88 9.5A2 2 0 0 0 25 41.93V6.4a2 2 0 0 0-3.51-1.3L12.67 15.3a2 2 0 0 1-1.52.7H7Z' }),
        el('line', { x1: '40', y1: '8', x2: '8', y2: '40', stroke: '#fff', 'stroke-width': '3', 'stroke-linecap': 'round' }),
      ])
    : el('svg', { width: 22, height: 22, viewBox: '0 0 48 48', fill: '#fff' }, [
        el('path', { d: 'M7 16a3 3 0 0 0-3 3v11.17a3 3 0 0 0 3 3h4.2a2 2 0 0 1 1.46.63l8.88 9.5A2 2 0 0 0 25 41.93V6.4a2 2 0 0 0-3.51-1.3L12.67 15.3a2 2 0 0 1-1.52.7H7Zm23.81 0a1 1 0 0 1 1.4.01 11.93 11.93 0 0 1 0 15.96 1 1 0 0 1-1.4.02l-1.5-1.5a1 1 0 0 1-.02-1.4 7.93 7.93 0 0 0 0-11.2 1 1 0 0 1 .02-1.4l1.5-1.5Z' }),
      ]);

  return el('button', {
    class: 'newest2-mute-btn',
    title: globalMuted ? 'Unmuted' : 'Muted',
    'aria-label': globalMuted ? 'Sound is muted' : 'Sound is on',
    onClick: () => {
      globalMuted = !globalMuted;
      localStorage.setItem('newest-muted', String(globalMuted));
      muteBtn.title = globalMuted ? 'Unmuted' : 'Muted';
      muteBtn.setAttribute('aria-label', globalMuted ? 'Sound is muted' : 'Sound is on');
      muteBtn.innerHTML = '';
      muteBtn.appendChild(
        globalMuted
          ? el('svg', { width: 22, height: 22, viewBox: '0 0 48 48', fill: '#fff' }, [
              el('path', { d: 'M7 16a3 3 0 0 0-3 3v11.17a3 3 0 0 0 3 3h4.2a2 2 0 0 1 1.46.63l8.88 9.5A2 2 0 0 0 25 41.93V6.4a2 2 0 0 0-3.51-1.3L12.67 15.3a2 2 0 0 1-1.52.7H7Z' }),
              el('line', { x1: '40', y1: '8', x2: '8', y2: '40', stroke: '#fff', 'stroke-width': '3', 'stroke-linecap': 'round' }),
            ])
          : el('svg', { width: 22, height: 22, viewBox: '0 0 48 48', fill: '#fff' }, [
              el('path', { d: 'M7 16a3 3 0 0 0-3 3v11.17a3 3 0 0 0 3 3h4.2a2 2 0 0 1 1.46.63l8.88 9.5A2 2 0 0 0 25 41.93V6.4a2 2 0 0 0-3.51-1.3L12.67 15.3a2 2 0 0 1-1.52.7H7Zm23.81 0a1 1 0 0 1 1.4.01 11.93 11.93 0 0 1 0 15.96 1 1 0 0 1-1.4.02l-1.5-1.5a1 1 0 0 1-.02-1.4 7.93 7.93 0 0 0 0-11.2 1 1 0 0 1 .02-1.4l1.5-1.5Z' }),
            ])
      );
      feedEl.querySelectorAll('video').forEach(v => { v.muted = globalMuted; });
    },
  }, [icon]);
}

function formatTime(seconds) {
  if (!seconds || !isFinite(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function togglePlayVideo(index) {
  const slide = feedEl?.querySelector(`.newest2-slide[data-index="${index}"]`);
  if (!slide) return;
  const video = slide.querySelector('video');
  if (!video) return;
  if (!video.src && video.dataset.src) {
    video.src = video.dataset.src;
    video.load();
  }
  if (video.paused) video.play().catch(() => {});
  else video.pause();
}

function updateVideoTimeDisplay(video, timeEl, seekBar) {
  const cur = video.currentTime || 0;
  const dur = video.duration || 0;
  timeEl.textContent = `${formatTime(cur)} / ${formatTime(dur)}`;
}

function buildOverlay(entry) {
  const { descData, uid } = entry;
  const metaUser = descData.author?.uniqueId || descData.author?.unique_id || uid;
  const dateStr = formatDateDDMMYY(descData.createTime);
  const cap = (descData.desc || '').trim();

  const userEl = el('a', {
    class: 'newest2-video-overlay-user',
    href: `#/profile/${uid}`,
    title: `View @${metaUser}'s profile`,
    onClick: (e) => {
      e.preventDefault();
      e.stopPropagation();
      resetNewestCache();
      navigate(`profile/${uid}`);
    },
  }, [`@${metaUser}`]);

  return el('div', { class: 'newest2-video-overlay' }, [
    el('div', { class: 'newest2-video-overlay-meta' }, [
      userEl,
      el('span', { class: 'newest2-video-overlay-date' }, [` · ${dateStr}`]),
    ]),
    cap ? el('div', { class: 'newest2-video-overlay-caption' }, [cap]) : null,
  ].filter(Boolean));
}

function buildSlide(entry, index) {
  const { descData, uid, itemId } = entry;
  const vid = isVideo(descData);
  const imgCount = getImageCount(descData);

  let slideChildren;

  if (vid) {
    const src = mediaUrl(uid, itemId, 'mp4');
    const video = el('video', {
      'data-src': src,
      playsinline: true,
      muted: globalMuted,
      loop: true,
      preload: 'none',
      crossOrigin: 'anonymous',
    });
    video.addEventListener('error', (e) => {
      console.warn('[newest] video failed to load:', src, e.type);
    });

    const freezeImg = el('img', {
      class: 'newest2-freeze-frame',
      alt: '',
    });

    const wrap = el('div', { class: 'newest2-video-wrap' });

    const flashBtn = el('div', { class: 'newest2-play-flash' });
    flashBtn.innerHTML = PLAY_SVG_LG;
    const timeEl = el('span', { class: 'newest2-time-display' }, '0:00 / 0:00');
    const playBtnBottom = el('button', { class: 'newest2-play-btn-bottom', 'aria-label': 'Play or pause' });
    playBtnBottom.innerHTML = PLAY_SVG_SM;
    const seekBar = el('input', { type: 'range', class: 'newest2-seek-bar', min: '0', max: '100', value: '0', step: '0.1' });
    const bottomBar = el('div', { class: 'newest2-video-bottom' }, [playBtnBottom, seekBar, timeEl]);
    const controls = el('div', { class: 'newest2-video-controls' }, [bottomBar]);

    wrap.appendChild(video);
    wrap.appendChild(freezeImg);
    wrap.appendChild(flashBtn);

    const overlayEl = buildOverlay(entry);
    wrap.appendChild(overlayEl);

    wrap.appendChild(controls);

    let hideTimer = null;
    let flashTimer = null;
    let dragging = false;

    const flashBriefly = () => {
      flashBtn.classList.add('newest2-play-flash-visible');
      if (flashTimer) clearTimeout(flashTimer);
      if (!video.paused) {
        flashTimer = setTimeout(() => flashBtn.classList.remove('newest2-play-flash-visible'), 700);
      }
    };

    const showControls = () => {
      controls.classList.remove('newest2-controls-hidden');
      if (hideTimer) clearTimeout(hideTimer);
      if (!video.paused) {
        hideTimer = setTimeout(() => controls.classList.add('newest2-controls-hidden'), 2000);
      }
    };

    const syncTime = () => {
      if (!dragging) seekBar.value = String(video.currentTime || 0);
      updateVideoTimeDisplay(video, timeEl, seekBar);
    };

    const togglePlay = () => {
      if (video.paused) video.play().catch(() => {});
      else video.pause();
      flashBriefly();
    };

    const updateFreezeFrame = () => {
      if (video.paused && video.readyState >= 2 && video.videoWidth > 0) {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          freezeImg.src = canvas.toDataURL('image/png');
          freezeImg.style.display = 'block';
        } catch (err) {
          console.warn('[newest] freeze frame capture failed:', err);
        }
      }
    };

    video.addEventListener('loadedmetadata', () => {
      seekBar.max = String(video.duration || 0);
      syncTime();
    });
    video.addEventListener('timeupdate', syncTime);
    video.addEventListener('play', () => {
      freezeImg.style.display = 'none';
      freezeImg.removeAttribute('src');
      playBtnBottom.innerHTML = PAUSE_SVG_SM;
      flashBtn.innerHTML = PAUSE_SVG_LG;
      flashBtn.classList.remove('newest2-play-flash-visible');
      showControls();
    });
    video.addEventListener('pause', () => {
      playBtnBottom.innerHTML = PLAY_SVG_SM;
      flashBtn.innerHTML = PLAY_SVG_LG;
      flashBtn.classList.add('newest2-play-flash-visible');
      if (hideTimer) clearTimeout(hideTimer);
      controls.classList.remove('newest2-controls-hidden');
      updateFreezeFrame();
    });
    video.addEventListener('seeked', () => {
      if (video.paused) {
        updateFreezeFrame();
      }
    });
    video.addEventListener('loadeddata', () => {
      if (video.paused) {
        updateFreezeFrame();
      }
    });

    freezeImg.addEventListener('click', (e) => {
      if (e.button === 0) {
        e.stopPropagation();
        togglePlay();
      }
    });
    freezeImg.addEventListener('mousemove', showControls);
    freezeImg.addEventListener('touchstart', showControls, { passive: true });

    playBtnBottom.addEventListener('click', (e) => { e.stopPropagation(); togglePlay(); });
    seekBar.addEventListener('mousedown', () => { dragging = true; });
    seekBar.addEventListener('mouseup', () => { dragging = false; });
    seekBar.addEventListener('input', () => {
      const seekTo = parseFloat(seekBar.value);
      if (!isNaN(seekTo)) video.currentTime = seekTo;
      updateVideoTimeDisplay(video, timeEl, seekBar);
    });

    wrap.addEventListener('contextmenu', () => {
      if (video.paused && freezeImg.style.display !== 'block') {
        updateFreezeFrame();
      }
    });
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap || e.target === video || e.target === controls) togglePlay();
    });
    wrap.addEventListener('mousemove', showControls);
    wrap.addEventListener('touchstart', showControls, { passive: true });

    slideChildren = [wrap];
  } else {
    const imgWrap = el('div', { class: 'newest2-img-wrap' });

    preloadPostImages(entry);

    const src0 = mediaUrl(uid, itemId, 'jpg', 0);
    const img = el('img', { src: src0, alt: '', loading: 'lazy', 'data-img-idx': '0' });
    img.addEventListener('error', (e) => {
      console.warn('[newest] image failed to load:', src0, e.type);
    });

    const loader = el('div', { class: 'newest2-img-loader' }, [
      el('span', { class: 'spinner' }),
    ]);

    const hideSlideLoader = () => {
      loader.classList.remove('active');
    };

    if (img.complete && img.naturalWidth > 0) {
      hideSlideLoader();
    } else {
      loader.classList.add('active');
      img.addEventListener('load', hideSlideLoader, { once: true });
      img.addEventListener('error', hideSlideLoader, { once: true });
    }

    imgWrap.appendChild(img);
    imgWrap.appendChild(loader);

    if (imgCount > 1) {
      const prevBtn = el('button', {
        class: 'media-viewer-nav-prev',
        'aria-label': 'Previous image',
        onClick: (e) => { e.stopPropagation(); navigateImage(index, -1); },
      }, [icon(ICONS.chevronLeft, 18)]);
      const nextBtn = el('button', {
        class: 'media-viewer-nav-next',
        'aria-label': 'Next image',
        onClick: (e) => { e.stopPropagation(); navigateImage(index, 1); },
      }, [icon(ICONS.chevronRight, 18)]);
      const counter = el('div', {
        class: 'media-viewer-counter',
        style: 'position:absolute;top:12px;left:50%;transform:translateX(-50%);z-index:10;',
        'data-counter': '',
      }, [`1/${imgCount}`]);

      imgWrap.appendChild(prevBtn);
      imgWrap.appendChild(nextBtn);
      imgWrap.appendChild(counter);
    }

    const overlayEl = buildOverlay(entry);
    imgWrap.appendChild(overlayEl);

    slideChildren = [imgWrap];
  }

  const slide = el('div', {
    class: 'newest2-slide',
    'data-index': String(index),
    'data-img-count': String(vid ? 0 : imgCount),
    'data-img-idx': '0',
  }, slideChildren);
  if (index === 0) slide.classList.add('active');
  return slide;
}

function navigateImage(slideIndex, dir) {
  const slide = feedEl?.querySelector(`.newest2-slide[data-index="${slideIndex}"]`);
  if (!slide) return;
  const max = parseInt(slide.dataset.imgCount, 10);
  if (max <= 1) return;
  let cur = parseInt(slide.dataset.imgIdx, 10);
  const next = Math.max(0, Math.min(max - 1, cur + dir));
  if (next === cur) return;
  cur = next;
  slide.dataset.imgIdx = String(cur);

  const counter = slide.querySelector('[data-counter]');
  if (counter) counter.textContent = `${cur + 1}/${max}`;

  const entry = items[slideIndex];
  if (!entry) return;
  const src = mediaUrl(entry.uid, entry.itemId, 'jpg', cur);
  const img = slide.querySelector('.newest2-img-wrap > img') || slide.querySelector('img');
  const loader = slide.querySelector('.newest2-img-loader');

  if (loader) loader.classList.add('active');
  if (img) img.style.opacity = '0.25';

  const startTime = Date.now();
  let done = false;
  const applyImage = () => {
    if (done) return;
    done = true;
    const elapsed = Date.now() - startTime;
    const minDelay = 180;
    const remaining = Math.max(0, minDelay - elapsed);
    setTimeout(() => {
      if (parseInt(slide.dataset.imgIdx, 10) === cur) {
        if (img) {
          img.src = src;
          img.style.opacity = '1';
        }
        if (loader) loader.classList.remove('active');
      }
    }, remaining);
  };

  const pre = new Image();
  pre.onload = applyImage;
  pre.onerror = () => {
    if (parseInt(slide.dataset.imgIdx, 10) === cur) {
      if (img) {
        img.src = src;
        img.style.opacity = '1';
      }
      if (loader) loader.classList.remove('active');
    }
  };
  pre.src = src;
  if (pre.complete && pre.naturalWidth > 0) {
    applyImage();
  }

  if (cur + 1 < max) {
    const n1 = mediaUrl(entry.uid, entry.itemId, 'jpg', cur + 1);
    if (!preloadedUrls.has(n1)) {
      preloadedUrls.add(n1);
      const p = new Image();
      p.src = n1;
    }
  }
}

function setupIntersectionObserver() {
  if (observer) observer.disconnect();
  observer = new IntersectionObserver((entries) => {
    if (isJumping) return;
    let bestEntry = null;
    let bestRatio = 0;
    for (const entry of entries) {
      if (entry.intersectionRatio > bestRatio) {
        bestRatio = entry.intersectionRatio;
        bestEntry = entry;
      }
    }
    if (!bestEntry || bestRatio < 0.3) return;
    const slide = bestEntry.target;
    const idx = parseInt(slide.dataset.index, 10);
    if (isNaN(idx) || idx === activeItemIndex) return;

    activateSlide(idx);
  }, { threshold: [0.3, 0.5, 0.7] });

  feedEl.querySelectorAll('.newest2-slide').forEach(s => observer.observe(s));
}

function loadMoreIfNeeded() {
  if (loading || allDone) return;
  if (Date.now() - lastLoadTime < MIN_LOAD_INTERVAL) return;
  if (activeItemIndex >= items.length - 3) {
    loadPage(page);
  }
}

function pauseAllVideos() {
  if (!feedEl) return;
  feedEl.querySelectorAll('video').forEach(v => { if (!v.paused) v.pause(); });
}

function resumeActiveVideo() {
  if (!feedEl) return;
  const activeSlide = feedEl.querySelector('.newest2-slide.active');
  if (!activeSlide) return;
  const video = activeSlide.querySelector('video');
  if (video && video.paused && video.src) {
    video.muted = globalMuted;
    video.play().catch(() => {});
  }
}

async function loadPage(p) {
  if (loading || allDone) return;
  loading = true;

  try {
    const res = await fetchJSON(recUrl(p));
    if (!res.ok || !res.data) throw new Error(`HTTP ${res.status}`);

    const raw = res.data;
    let itemsData;
    let hasMore = false;

    if (Array.isArray(raw.data)) {
      itemsData = raw.data;
      hasMore = raw.totalPages ? p < raw.totalPages : false;
    } else {
      let all;
      if (Array.isArray(raw)) {
        all = raw.map((entry, i) => ({ itemId: entry.itemId || i, ...entry }));
      } else if (raw && typeof raw === 'object') {
        all = Object.entries(raw).map(([itemId, entry]) => ({ itemId, ...entry }));
      } else {
        all = [];
      }
      all.sort((a, b) => (b.createTime || 0) - (a.createTime || 0));
      const start = (p - 1) * PAGE_SIZE;
      itemsData = all.slice(start, start + PAGE_SIZE);
      hasMore = start + PAGE_SIZE < all.length;
    }

    if (!itemsData || !itemsData.length) {
      if (!hasMore) allDone = true;
      if (!items.length) showEmpty('No recommendations available');
      return;
    }

    const enriched = [];
    const missing = [];
    for (const item of itemsData) {
      const uid = item.uid;
      const itemId = item.itemId || Object.keys(item)[0];
      if (item.descData) {
        enriched.push({ descData: item.descData, uid, itemId });
      } else {
        missing.push({ uid, itemId });
      }
    }

    if (missing.length > 0) {
      const fetched = await fetchBatchDescriptions(missing);
      enriched.push(...fetched);
    }

    const existingItemIds = new Set(items.map(it => String(it.itemId)));
    const enrichedUnique = enriched.filter(it => !existingItemIds.has(String(it.itemId)));

    if (!enrichedUnique.length) {
      if (!items.length) { allDone = true; showEmpty('Could not load media details'); return; }
      if (!hasMore) allDone = true;
      return;
    }

    const startIdx = items.length;
    const wasEmpty = !items.length;
    items.push(...enrichedUnique);

    renderThumbnailBatch(enrichedUnique, startIdx);

    enrichedUnique.forEach((entry, i) => {
      const slide = buildSlide(entry, startIdx + i);
      feedEl.appendChild(slide);
    });

    if (observer) observer.disconnect();
    setupIntersectionObserver();

    if (wasEmpty && activeItemIndex === -1) {
      activateSlide(0);
    }

    page = p + 1;
    lastLoadTime = Date.now();
    if (!hasMore) allDone = true;
  } catch (err) {
    console.error('[newest] loadPage error:', err);
    if (!items.length) showEmpty(`Failed to load: ${err.message}`);
  } finally {
    loading = false;
  }
}

async function loadTargetAndPage(targetUid, targetItemId) {
  if (loading || allDone) return;
  loading = true;

  try {
    const recRes = await fetchJSON(recUrl(1)).catch(() => null);

    let recItems = [];
    let hasMore = false;
    if (recRes && recRes.ok && recRes.data) {
      const raw = recRes.data;
      if (Array.isArray(raw.data)) {
        recItems = raw.data;
        hasMore = raw.totalPages ? 1 < raw.totalPages : false;
      } else {
        let all;
        if (Array.isArray(raw)) {
          all = raw.map((entry, i) => ({ itemId: entry.itemId || i, ...entry }));
        } else if (raw && typeof raw === 'object') {
          all = Object.entries(raw).map(([itemId, entry]) => ({ itemId, ...entry }));
        } else {
          all = [];
        }
        all.sort((a, b) => (b.createTime || 0) - (a.createTime || 0));
        recItems = all.slice(0, PAGE_SIZE);
        hasMore = PAGE_SIZE < all.length;
      }
    }

    const filteredRecItems = recItems.filter(item => {
      const iId = item.itemId || Object.keys(item)[0];
      return String(iId) !== String(targetItemId);
    });

    const initialItems = [];
    const toBatchFetch = [{ uid: targetUid, itemId: targetItemId }];

    for (const item of filteredRecItems) {
      const uid = item.uid;
      const itemId = item.itemId || Object.keys(item)[0];
      if (item.descData) {
        initialItems.push({ descData: item.descData, uid, itemId });
      } else {
        toBatchFetch.push({ uid, itemId });
      }
    }

    if (toBatchFetch.length > 0) {
      const fetched = await fetchBatchDescriptions(toBatchFetch);
      for (const entry of fetched) {
        if (String(entry.itemId) === String(targetItemId)) {
          initialItems.unshift(entry);
        } else {
          initialItems.push(entry);
        }
      }
    }

    if (!initialItems.length) {
      allDone = true;
      showEmpty('Could not load media details');
      return;
    }

    items.push(...initialItems);

    renderThumbnailBatch(initialItems, 0);

    initialItems.forEach((entry, i) => {
      const slide = buildSlide(entry, i);
      feedEl.appendChild(slide);
    });

    if (observer) observer.disconnect();
    setupIntersectionObserver();

    activateSlide(0);

    page = 2;
    lastLoadTime = Date.now();
    if (!hasMore) allDone = true;
  } catch (err) {
    console.error('[newest] loadTargetAndPage error:', err);
    if (!items.length) showEmpty(`Failed to load: ${err.message}`);
  } finally {
    loading = false;
  }
}

function showEmpty(msg) {
  clear(container);
  container.appendChild(el('div', { style: 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;color:rgba(255,255,255,0.5);gap:16px;padding:40px;font-size:15px;' }, [
    el('div', {}, msg),
    el('button', {
      class: 'btn btn-primary',
      onClick: () => { items = []; page = 1; allDone = false; loading = false; activeItemIndex = -1; renderNewest(container); },
    }, 'Retry'),
  ]));
}

function buildLayout() {
  const closeBtn = el('button', {
    class: 'newest2-close',
    title: 'Close feed',
    'aria-label': 'Close feed',
    onClick: close,
  }, [icon(ICONS.close, 18)]);

  infoPanelEl = buildInfoPanel();

  navUpBtn = el('button', {
    class: 'newest2-nav-btn',
    title: 'Previous (ArrowUp)',
    'aria-label': 'Previous post',
    disabled: true,
    onClick: () => scrollToSlide(-1),
  }, [icon(ICONS.chevronUp, 18)]);
  navDownBtn = el('button', {
    class: 'newest2-nav-btn',
    title: 'Next (ArrowDown)',
    'aria-label': 'Next post',
    disabled: true,
    onClick: () => scrollToSlide(1),
  }, [icon(ICONS.chevronDown, 18)]);
  const navSide = el('div', { class: 'newest2-nav-side' }, [navUpBtn, navDownBtn]);

  thumbContainer = el('div', { class: 'newest2-thumb-container' });
  thumbGrid = el('div', { class: 'newest2-thumb-grid' });
  thumbContainer.appendChild(thumbGrid);

  if (thumbObserver) thumbObserver.disconnect();
  thumbObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const itemEl = entry.target;
      if (entry.isIntersecting) {
        itemEl._inView = true;
        if (!itemEl._loaded && itemEl._loadThumb) {
          itemEl._loadThumb(true);
        }
      } else {
        itemEl._inView = false;
      }
    }
  }, { root: thumbContainer, rootMargin: '80px 0px' });

  feedEl = el('div', { class: 'newest2-feed' });

  muteBtn = buildMuteButton();

  const body = el('div', { class: 'newest2-body' }, [
    thumbContainer,
    feedEl,
    navSide,
    infoPanelEl,
  ]);

  pageEl = el('div', { class: 'newest2-page' }, [
    closeBtn,
    muteBtn,
    body,
  ]);
}

function scrollToSlide(dir) {
  const vh = window.innerHeight;
  feedEl.scrollBy({ top: dir * vh, behavior: 'smooth' });
}

export function destroyNewest() {
  pauseAllVideos();
  if (feedEl) {
    feedEl.querySelectorAll('video').forEach(v => {
      v.pause();
      v.removeAttribute('src');
      v.load();
    });
  }
  if (keydownHandler) {
    document.removeEventListener('keydown', keydownHandler);
    keydownHandler = null;
  }
  if (visibilityHandler) {
    document.removeEventListener('visibilitychange', visibilityHandler);
    visibilityHandler = null;
  }
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  if (sentinelObserver) {
    sentinelObserver.disconnect();
    sentinelObserver = null;
  }
  if (thumbObserver) {
    thumbObserver.disconnect();
    thumbObserver = null;
  }
  resetThumbQueue();
}

export function resetNewestCache() {
  destroyNewest();
  preloadedUrls.clear();
  if (jumpTimeout) clearTimeout(jumpTimeout);
  jumpTimeout = null;
  isJumping = false;
  loadedVideoIndices.clear();
  renderGen++;
  items = [];
  page = 1;
  loading = false;
  allDone = false;
  activeItemIndex = -1;
  feedEl = null;
  infoPanelEl = null;
  thumbGrid = null;
  thumbContainer = null;
  navUpBtn = null;
  navDownBtn = null;
  muteBtn = null;
  sentinelEl = null;
  lastLoadTime = 0;
}

function close() {
  destroyNewest();
  resetNewestCache();
  navigate('/');
}

function setupKeydownHandler() {
  if (keydownHandler) document.removeEventListener('keydown', keydownHandler);
  keydownHandler = (e) => {
    if (e.key === 'Escape') { close(); return; }
    if (e.key === 'ArrowUp' || e.key === 'PageUp') { e.preventDefault(); scrollToSlide(-1); return; }
    if (e.key === 'ArrowDown' || e.key === 'PageDown') { e.preventDefault(); scrollToSlide(1); return; }
    if (e.key === ' ') { e.preventDefault(); togglePlayVideo(activeItemIndex); return; }
    if (e.key === 'k') { e.preventDefault(); togglePlayVideo(activeItemIndex); return; }
    if (e.key === 'm' || e.key === 'M') { e.preventDefault(); document.querySelector('.newest2-mute-btn')?.click(); return; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); navigateImage(activeItemIndex, -1); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); navigateImage(activeItemIndex, 1); return; }
  };
  document.addEventListener('keydown', keydownHandler);
}

function restoreCachedItems() {
  if (sentinelEl) {
    sentinelEl.remove();
    sentinelEl = null;
  }

  for (let i = 0; i < items.length; i++) {
    const thumb = buildThumbnailItem(items[i], i);
    thumbGrid.appendChild(thumb);
    if (thumbObserver) {
      thumbObserver.observe(thumb);
    } else if (thumb._loadThumb) {
      thumb._loadThumb();
    }
  }

  if (!allDone && items.length > 0) {
    sentinelEl = el('div', { class: 'newest2-thumb-sentinel' });
    thumbGrid.appendChild(sentinelEl);
    if (sentinelObserver) sentinelObserver.disconnect();
    sentinelObserver = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && !loading && !allDone) {
        loadPage(page);
      }
    }, { root: thumbContainer, rootMargin: '200px' });
    sentinelObserver.observe(sentinelEl);
  }

  items.forEach((entry, i) => {
    const slide = buildSlide(entry, i);
    feedEl.appendChild(slide);
  });

  const targetIdx = (activeItemIndex >= 0 && activeItemIndex < items.length) ? activeItemIndex : (items.length > 0 ? 0 : -1);

  if (targetIdx >= 0) {
    const targetSlide = feedEl.querySelector(`.newest2-slide[data-index="${targetIdx}"]`);
    if (targetSlide) {
      targetSlide.scrollIntoView({ behavior: 'instant', block: 'start' });
    } else {
      feedEl.scrollTop = targetIdx * feedEl.clientHeight;
    }
    activateSlide(targetIdx);
  }

  if (observer) observer.disconnect();
  setupIntersectionObserver();
}

export function renderNewest(containerEl, target = null) {
  container = containerEl;
  renderGen++;
  clear(container);
  container.classList.add('newest-active');

  const isFresh = items.length === 0;

  if (isFresh) {
    page = 1;
    loading = false;
    allDone = false;
    activeItemIndex = -1;
    lastLoadTime = 0;
  }

  if (keydownHandler) document.removeEventListener('keydown', keydownHandler);
  if (observer) observer.disconnect();
  if (sentinelObserver) sentinelObserver.disconnect();
  if (thumbObserver) thumbObserver.disconnect();
  if (visibilityHandler) document.removeEventListener('visibilitychange', visibilityHandler);
  keydownHandler = null;
  observer = null;
  sentinelObserver = null;
  thumbObserver = null;
  visibilityHandler = null;
  resetThumbQueue();

  buildLayout();
  container.appendChild(pageEl);

  setupKeydownHandler();

  visibilityHandler = () => {
    if (document.hidden) pauseAllVideos();
    else resumeActiveVideo();
  };
  document.addEventListener('visibilitychange', visibilityHandler);

  if (isFresh) {
    if (target && target.targetUid && target.targetItemId) {
      loadTargetAndPage(target.targetUid, target.targetItemId);
    } else {
      loadPage(1);
    }
  } else {
    if (target && target.targetUid && target.targetItemId) {
      const existingIdx = items.findIndex(it => String(it.uid) === String(target.targetUid) && String(it.itemId) === String(target.targetItemId));
      if (existingIdx !== -1) {
        activeItemIndex = existingIdx;
        restoreCachedItems();
        return;
      } else {
        resetNewestCache();
        renderNewest(containerEl, target);
        return;
      }
    }
    restoreCachedItems();
  }
}
