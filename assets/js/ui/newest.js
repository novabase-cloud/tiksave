import { el, clear, mount, $ } from '../utils/dom.js';
import { HF_MEDIA_PROXY, getDatasetRepo } from '../config.js';
import { getToken } from '../auth.js';
import { fetchJSON } from '../utils/http.js';
import { navigate } from '../router.js';
import { loadResizedImage } from '../utils/cache.js';
import { formatNumber } from '../utils/format.js';

const PAGE_SIZE = 5;
const MAX_DOM_ITEMS = 15;
const UNLOAD_DISTANCE = 4;

function getBase() {
  const repo = getDatasetRepo() || 'Novabase/Tiktok';
  return `${HF_MEDIA_PROXY}/datasets/${repo}/resolve/main`;
}

function recUrl(page) {
  const token = getToken();
  const base = getBase();
  let url = `${base}/Posts/recommendation.json?_t=${Date.now()}`;
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

function mediaUrl(uid, itemId, ext) {
  const token = getToken();
  const base = getBase();
  let u = `${base}/Posts/${uid}/${itemId}/${itemId}-0.${ext}`;
  if (token) u += `?token=${encodeURIComponent(token)}`;
  return u;
}

function avatarUrl(uid) {
  const token = getToken();
  const base = getBase();
  let u = `${base}/Posts/${uid}/avatar/${uid}.jpg`;
  if (token) u += `?token=${encodeURIComponent(token)}`;
  return u;
}

let feedEl = null;
let items = [];
let loadHandler = null;
let page = 1;
let loading = false;
let allDone = false;
let videoObs = null;
let activeObs = null;
let container = null;
let loadingEl = null;
let lastLoadTime = 0;
let activeItemIndex = 0;
let globalMuted = true;  // Global mute state
const MIN_LOAD_INTERVAL = 1500;

function showToast(msg) {
  const existing = $('.newest-toast');
  if (existing) existing.remove();
  const toast = el('div', { class: 'newest-toast' }, [msg]);
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2000);
}

function formatCaption(desc) {
  if (!desc) return '';
  return desc.replace(/#\S+/g, '').trim() || desc;
}

function isVideo(descData) {
  return !!descData.video;
}

function showLoading() {
  if (loadingEl) return;
  loadingEl = el('div', { class: 'newest-toast' }, [
    el('div', { class: 'spinner', style: 'width:16px;height:16px;border-width:2px;display:inline-block;vertical-align:middle;margin-right:6px;' }),
    el('span', { style: 'vertical-align:middle' }, 'Loading...'),
  ]);
  document.body.appendChild(loadingEl);
}

function hideLoading() {
  if (loadingEl) { loadingEl.remove(); loadingEl = null; }
}

function showEmptyMsg(msg) {
  mount(feedEl, el('div', { class: 'newest-empty' }, [
    el('div', {}, msg),
    el('button', {
      class: 'btn btn-primary',
      onClick: () => { clear(feedEl); items = []; page = 1; allDone = false; loading = false; loadPage(1); },
    }, 'Retry'),
  ]));
}

function formatTime(s) {
  if (!s || !isFinite(s)) return '00:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function unloadFarVideos(activeIdx) {
  const allItems = feedEl.querySelectorAll('.newest-item');
  allItems.forEach((itemEl, idx) => {
    const video = itemEl.querySelector('video');
    if (!video) return;
    const dist = Math.abs(idx - activeIdx);
    if (dist > UNLOAD_DISTANCE && video.src) {
      video.dataset.src = video.src;
      video.removeAttribute('src');
      video.load();
    } else if (dist <= UNLOAD_DISTANCE && video.dataset.src && !video.src) {
      video.src = video.dataset.src;
      video.load();
      delete video.dataset.src;
    }
  });
}

function pruneDOM(activeIdx) {
  const allItems = feedEl.querySelectorAll('.newest-item');
  if (allItems.length <= MAX_DOM_ITEMS) return;
  const removeBefore = activeIdx - Math.floor(MAX_DOM_ITEMS / 3);
  const removeAfter = activeIdx + Math.floor(MAX_DOM_ITEMS / 3);
  allItems.forEach((itemEl, idx) => {
    if (idx < removeBefore || idx > removeAfter) {
      if (videoObs) videoObs.unobserve(itemEl);
      if (activeObs) activeObs.unobserve(itemEl);
      itemEl.remove();
    }
  });
}

// ── Video play manager ──

function handleVideoPlay(entries) {
  for (const entry of entries) {
    const itemEl = entry.target;
    const video = itemEl.querySelector('video');
    if (!video) continue;

    if (entry.isIntersecting) {
      feedEl.querySelectorAll('.newest-item video').forEach(other => {
        if (other !== video && !other.paused) other.pause();
      });
      video.muted = globalMuted;  // Gunakan global mute state
      video.currentTime = 0;
      const p = video.play();
      if (p) p.catch(() => video.addEventListener('loadeddata', () => video.play().catch(() => {}), { once: true }));
    } else {
      video.pause();
      video.currentTime = 0;
    }
  }
}

function handleActiveChange(entries) {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const allItems = feedEl.querySelectorAll('.newest-item');
    let foundIdx = -1;
    for (let i = 0; i < allItems.length; i++) {
      if (allItems[i] === entry.target) { foundIdx = i; break; }
    }
    if (foundIdx >= 0) {
      activeItemIndex = foundIdx;
      unloadFarVideos(foundIdx);
      pruneDOM(foundIdx);
    }
  }
}

// ── Render single item ──

function renderItem(descData, uid, itemId) {
  const vid = isVideo(descData);
  const ext = vid ? 'mp4' : 'jpg';
  const src = mediaUrl(uid, itemId, ext);
  const auth = descData.author || {};
  const stats = descData.stats || {};
  const caption = formatCaption(descData.desc || '');
  const uniqueId = auth.uniqueId || auth.unique_id || uid;
  const musicTitle = descData.music?.title || '';

  // ── Media element ──
  let mediaEl;
  if (vid) {
    mediaEl = el('video', {
      src, playsinline: true, preload: 'metadata',
      loop: true, muted: globalMuted,
    });
  } else {
    mediaEl = el('img', { src, alt: '', loading: 'lazy' });
  }

  mediaEl.addEventListener('error', (e) => {
    console.warn('[newest] media failed to load:', src, e.type);
  });

  // ── Placeholder ──
  const placeholderIcon = el('svg', {
    width: 48, height: 48, viewBox: '0 0 24 24',
    fill: 'none', stroke: 'currentColor',
    'stroke-width': '1.5',
    class: 'newest-placeholder-icon',
  }, [
    el('path', { d: 'M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25h-9A2.25 2.25 0 002.25 7.5v9a2.25 2.25 0 002.25 2.25z' }),
  ]);
  const placeholderEl = el('div', { class: 'newest-placeholder' }, [placeholderIcon]);

  // ── Media wrapper (aspect-ratio box) ──
  const mediaWrap = el('div', { class: 'newest-media-wrap' });
  mediaWrap.appendChild(mediaEl);
  mediaWrap.appendChild(placeholderEl);

  const loadDone = () => placeholderEl.classList.add('hidden');
  if (vid) {
    mediaEl.addEventListener('loadeddata', loadDone);
    mediaEl.addEventListener('error', loadDone);
  } else {
    mediaEl.addEventListener('load', loadDone);
    mediaEl.addEventListener('error', loadDone);
  }

  // ── Overlay top (removed per-video volume button) ──
  const overlayTop = el('div', { class: 'newest-overlay-top' }, [
    el('button', { class: 'newest-btn-icon' }, [
      el('svg', { width: 18, height: 18, viewBox: '0 0 48 48', fill: '#fff' }, [
        el('path', { d: 'M5 24a4 4 0 1 1 8 0 4 4 0 0 1-8 0Zm15 0a4 4 0 1 1 8 0 4 4 0 0 1-8 0Zm15 0a4 4 0 1 1 8 0 4 4 0 0 1-8 0Z' }),
      ]),
    ]),
  ]);

  // ── Creator info ──
  const avatarSmall = el('div', { class: 'newest-creator-avatar', onClick: (e) => { e.stopPropagation(); navigate(`/profile/${uid}`); }}, [(uniqueId[0] || '?').toUpperCase()]);
  loadResizedImage(avatarUrl(uid), 64).then(dataUrl => {
    if (dataUrl && avatarSmall.isConnected) {
      avatarSmall.innerHTML = '';
      avatarSmall.appendChild(el('img', { src: dataUrl, alt: uniqueId }));
    }
  });

  const overlayBottom = el('div', { class: 'newest-overlay-bottom' }, [
    el('div', { class: 'newest-creator' }, [
      avatarSmall,
      el('a', { class: 'newest-creator-name', onClick: (e) => { e.stopPropagation(); navigate(`/profile/${uid}`); }}, [`@${uniqueId}`]),
    ]),
    caption ? el('div', { class: 'newest-caption' }, [caption]) : null,
    musicTitle ? el('div', { class: 'newest-music' }, [
      el('svg', { width: 14, height: 14, viewBox: '0 0 48 48', fill: '#fff' }, [
        el('path', { d: 'M35 10.76a1 1 0 0 0-1.22-.98l-15.99 3.64a1 1 0 0 0-.78.97V38c.03 2.17-2.2 4.43-5.4 5.28-3.56.96-6.96-.2-7.6-2.57-.63-2.37 1.74-5.07 5.3-6.02a9.2 9.2 0 0 1 3.7-.25V14.39a5 5 0 0 1 3.9-4.87l15.98-3.64A5 5 0 0 1 39 10.76v22.36c.08 2.2-2.17 4.5-5.4 5.36-3.56.95-6.96-.2-7.6-2.57-.63-2.38 1.74-5.08 5.3-6.03a9.2 9.2 0 0 1 3.7-.25V10.76Z' }),
      ]),
      el('span', {}, [musicTitle]),
    ]) : null,
  ].filter(Boolean));

  // ── Media card ──
  const mediaCard = el('div', { class: 'newest-media-card', onClick: (e) => {
    if (!vid) return;
    if (e.target.closest('.newest-btn-icon') || e.target.closest('.newest-creator-name') || e.target.closest('.newest-creator-avatar') || e.target.closest('.newest-action-btn')) return;
    if (mediaEl.paused) {
      mediaEl.play().catch(() => {});
    } else {
      mediaEl.pause();
    }
  }}, [mediaWrap, overlayTop, overlayBottom]);

  // ── Progress bar (videos only) ──
  if (vid) {
    const progTime = el('span', { class: 'newest-progress-time' }, ['00:00 / 00:00']);
    const progFill = el('div', { class: 'newest-progress-fill' });
    const progBar = el('div', { class: 'newest-progress-bar' }, [progFill]);
    const progContainer = el('div', { class: 'newest-progress' }, [progTime, progBar]);

    const updateProgress = () => {
      if (!mediaEl.duration) return;
      progTime.textContent = `${formatTime(mediaEl.currentTime)} / ${formatTime(mediaEl.duration)}`;
      progFill.style.width = `${(mediaEl.currentTime / mediaEl.duration) * 100}%`;
    };
    mediaEl.addEventListener('timeupdate', updateProgress);
    mediaEl.addEventListener('loadedmetadata', updateProgress);
    mediaEl.addEventListener('seeked', updateProgress);

    progBar.addEventListener('click', (e) => {
      e.stopPropagation();
      const rect = progBar.getBoundingClientRect();
      const pct = (e.clientX - rect.left) / rect.width;
      mediaEl.currentTime = pct * (mediaEl.duration || 1);
    });

    mediaCard.appendChild(progContainer);
  }

  // ── Action bar (right) ──
  const avatarBig = el('div', { class: 'newest-creator-avatar', style: 'width:48px;height:48px;', onClick: (e) => { e.stopPropagation(); navigate(`/profile/${uid}`); }}, [(uniqueId[0] || '?').toUpperCase()]);
  loadResizedImage(avatarUrl(uid), 96).then(dataUrl => {
    if (dataUrl && avatarBig.isConnected) {
      avatarBig.innerHTML = '';
      avatarBig.appendChild(el('img', { src: dataUrl, alt: uniqueId }));
    }
  });

  function copyLink(e) {
    e.stopPropagation();
    const type = vid ? 'video' : 'photo';
    navigator.clipboard.writeText(`https://www.tiktok.com/@${uniqueId}/${type}/${itemId}`)
      .then(() => showToast('TikTok link copied!'))
      .catch(() => showToast('Failed to copy'));
  }

  const actionsEl = el('div', { class: 'newest-actions' }, [
    avatarBig,
    el('button', { class: 'newest-action-btn', type: 'button', 'aria-label': `Like ${stats.diggCount ? formatNumber(stats.diggCount) + ' likes' : ''}`.trim(), 'aria-pressed': 'false' }, [
      el('svg', { width: 24, height: 24, viewBox: '0 0 24 24', fill: '#fff' }, [
        el('path', { 'fill-rule': 'evenodd', d: 'M7.5 2.25C10.5 2.25 12 4.25 12 4.25C12 4.25 13.5 2.25 16.5 2.25C20 2.25 22.5 4.99999 22.5 8.5C22.5 12.5 19.2311 16.0657 16.25 18.75C14.4095 20.4072 13 21.5 12 21.5C11 21.5 9.55051 20.3989 7.75 18.75C4.81949 16.0662 1.5 12.5 1.5 8.5C1.5 4.99999 4 2.25 7.5 2.25Z' }),
      ]),
      el('strong', {}, [formatNumber(stats.diggCount || 0)]),
    ]),
    el('button', { class: 'newest-action-btn', type: 'button', 'aria-label': `Comments ${stats.commentCount ? formatNumber(stats.commentCount) + ' comments' : ''}`.trim() }, [
      el('svg', { width: 24, height: 24, viewBox: '0 0 48 48', fill: '#fff' }, [
        el('path', { 'fill-rule': 'evenodd', d: 'M2 21.5c0-10.22 9.88-18 22-18s22 7.78 22 18c0 5.63-3.19 10.74-7.32 14.8a43.6 43.6 0 0 1-14.14 9.1A1.5 1.5 0 0 1 22.5 44v-5.04C11.13 38.4 2 31.34 2 21.5M14 25a3 3 0 1 0 0-6 3 3 0 0 0 0 6m10 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6m13-3a3 3 0 1 1-6 0 3 3 0 0 1 6 0' }),
      ]),
      el('strong', {}, [formatNumber(stats.commentCount || 0)]),
    ]),
    el('button', { class: 'newest-action-btn', type: 'button', 'aria-label': 'Share video', onClick: copyLink }, [
      el('svg', { width: 24, height: 24, viewBox: '0 0 20 20', fill: '#fff' }, [
        el('path', { 'fill-rule': 'evenodd', d: 'M10.938 3.175a.674.674 0 0 1 1.138-.488l6.526 6.215c.574.547.554 1.47-.043 1.991l-6.505 5.676a.674.674 0 0 1-1.116-.508V13.49s-6.985-1.258-9.225 2.854c-.209.384-1.023.518-.857-1.395.692-3.52 2.106-9.017 10.082-9.017Z' }),
      ]),
      el('strong', {}, ['Share']),
    ]),
  ]);

  // ── Item ──
  const itemEl = el('div', { class: 'newest-item' }, [
    el('div', { class: 'newest-item-inner' }, [mediaCard, actionsEl]),
  ]);

  feedEl.appendChild(itemEl);

  if (vid && videoObs) videoObs.observe(itemEl);
  if (activeObs) activeObs.observe(itemEl);
}

// ── Load page ──

async function loadPage(p) {
  if (loading || allDone) return;
  loading = true;
  showLoading();

  try {
    const res = await fetchJSON(recUrl(p));
    if (!res.ok || !res.data) throw new Error(`HTTP ${res.status}: ${res.raw?.slice?.(0, 200) || 'no body'}`);

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
      allDone = true;
      hideLoading();
      if (!items.length) showEmptyMsg('No recommendations available');
      return;
    }

    const enriched = (await Promise.all(itemsData.map(item => {
      const uid = item.uid;
      const itemId = item.itemId || Object.keys(item)[0];
      return fetchJSON(descUrl(uid, itemId)).then(r => {
        if (r.ok && r.data) return { descData: r.data, uid, itemId };
        console.warn('[newest] failed to fetch description for', uid, itemId, r.status);
        return null;
      }).catch(() => null);
    }))).filter(Boolean);

    if (!enriched.length) {
      if (!items.length) { hideLoading(); showEmptyMsg('Could not load media details'); allDone = true; return; }
      allDone = true; hideLoading(); return;
    }

    for (const entry of enriched) {
      items.push(entry);
      renderItem(entry.descData, entry.uid, entry.itemId);
    }

    if (!hasMore) allDone = true;
    page = p + 1;
    lastLoadTime = Date.now();
  } catch (err) {
    console.error('[newest] loadPage error:', err);
    hideLoading();
    if (!items.length) showEmptyMsg(`Failed to load: ${err.message}`);
  } finally {
    loading = false;
    hideLoading();
  }
}

// ── Entry point ──

export function renderNewest(containerEl) {
  container = containerEl;
  clear(container);
  container.innerHTML = '';
  container.classList.add('newest-active');

  items = [];
  page = 1;
  loading = false;
  allDone = false;
  loadingEl = null;
  lastLoadTime = 0;
  activeItemIndex = 0;

  if (loadHandler && feedEl) feedEl.removeEventListener('scroll', loadHandler);

  feedEl = el('div', { class: 'newest-feed', tabindex: 0 });

  loadHandler = () => {
    if (loading || allDone) return;
    if (Date.now() - lastLoadTime < MIN_LOAD_INTERVAL) return;
    if (feedEl.scrollTop + feedEl.clientHeight >= feedEl.scrollHeight - 600) {
      loadPage(page);
    }
  };
  feedEl.addEventListener('scroll', loadHandler, { passive: true });

  videoObs = new IntersectionObserver(handleVideoPlay, {
    root: feedEl,
    rootMargin: '0px',
    threshold: 0.6,
  });

  activeObs = new IntersectionObserver(handleActiveChange, {
    root: feedEl,
    rootMargin: '0px',
    threshold: 0.5,
  });

  feedEl.addEventListener('keydown', (e) => {
    const isDown = e.key === 'ArrowDown' || e.key === 'PageDown';
    const isUp = e.key === 'ArrowUp' || e.key === 'PageUp';
    if (!isDown && !isUp) return;
    e.preventDefault();
    const allItems = feedEl.querySelectorAll('.newest-item');
    if (!allItems.length) return;
    let idx = activeItemIndex;
    if (idx >= allItems.length) idx = allItems.length - 1;
    if (isDown) idx = Math.min(idx + 1, allItems.length - 1);
    else idx = Math.max(idx - 1, 0);
    activeItemIndex = idx;
    allItems[idx].scrollIntoView({ behavior: 'smooth', block: 'start' });
    unloadFarVideos(idx);
    pruneDOM(idx);
  });

  // ── Global mute button ──
  function updateGlobalMuteIcon() {
    const icon = globalMuted 
      ? el('svg', { width: 22, height: 22, viewBox: '0 0 48 48', fill: '#fff' }, [
          el('path', { d: 'M7 16a3 3 0 0 0-3 3v11.17a3 3 0 0 0 3 3h4.2a2 2 0 0 1 1.46.63l8.88 9.5A2 2 0 0 0 25 41.93V6.4a2 2 0 0 0-3.51-1.3L12.67 15.3a2 2 0 0 1-1.52.7H7Z' }),
          el('line', { x1: '40', y1: '8', x2: '8', y2: '40', stroke: '#fff', 'stroke-width': '3', 'stroke-linecap': 'round' }),
        ])
      : el('svg', { width: 22, height: 22, viewBox: '0 0 48 48', fill: '#fff' }, [
          el('path', { d: 'M7 16a3 3 0 0 0-3 3v11.17a3 3 0 0 0 3 3h4.2a2 2 0 0 1 1.46.63l8.88 9.5A2 2 0 0 0 25 41.93V6.4a2 2 0 0 0-3.51-1.3L12.67 15.3a2 2 0 0 1-1.52.7H7Zm23.81 0a1 1 0 0 1 1.4.01 11.93 11.93 0 0 1 0 15.96 1 1 0 0 1-1.4.02l-1.5-1.5a1 1 0 0 1-.02-1.4 7.93 7.93 0 0 0 0-11.2 1 1 0 0 1 .02-1.4l1.5-1.5Z' }),
        ]);
    return icon;
  }

  const globalMuteBtn = el('button', { 
    class: 'newest-global-mute-btn',
    title: globalMuted ? 'Unmute' : 'Mute',
    onClick: (e) => {
      e.stopPropagation();
      globalMuted = !globalMuted;
      globalMuteBtn.title = globalMuted ? 'Unmute' : 'Mute';
      
      // Update icon
      globalMuteBtn.innerHTML = '';
      globalMuteBtn.appendChild(updateGlobalMuteIcon());
      
      // Update all videos
      const allVideos = feedEl.querySelectorAll('video');
      allVideos.forEach(video => {
        video.muted = globalMuted;
      });
    }
  }, [updateGlobalMuteIcon()]);

  const pageEl = el('div', { class: 'newest-page' }, [globalMuteBtn, feedEl]);
  container.appendChild(pageEl);

  loadPage(1);
}
