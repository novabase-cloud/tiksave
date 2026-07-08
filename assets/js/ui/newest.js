import { el, clear } from '../utils/dom.js';
import { HF_MEDIA_PROXY, getDatasetRepo } from '../config.js';
import { getToken } from '../auth.js';
import { fetchJSON } from '../utils/http.js';
import { navigate } from '../router.js';
import { formatNumber } from '../utils/format.js';
import { ICONS } from '../utils/icons.js';
import { generateVideoThumbnail } from '../utils/thumbUtils.js';

const PAGE_SIZE = 6;
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
let activeItemIndex = -1;
let renderGen = 0;
let globalMuted = localStorage.getItem('newest-muted') !== 'false';
let lastLoadTime = 0;
let keydownHandler = null;

function getBase() {
  const repo = getDatasetRepo() || 'Novabase/Tiktok';
  return `${HF_MEDIA_PROXY}/proxy/datasets/${repo}/resolve/main`;
}

function recUrl(p) {
  const token = getToken();
  let url = `${HF_MEDIA_PROXY}/recommendation?_t=${Date.now()}`;
  url += `&page=${p}&limit=${PAGE_SIZE}&sort=newest`;
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

function infoLabel(svgPath, text) {
  const svg = el('svg', { width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', style: 'vertical-align:middle;margin-right:3px;' }, [
    el('path', { d: svgPath }),
  ]);
  return el('span', { class: 'media-info-label' }, [svg, ` ${text}`]);
}

function buildInfoPanel() {
  const rows = [
    ['media-info-row-likes', ICONS.heart, 'likes:'],
    ['media-info-row-plays', ICONS.play, 'plays:'],
    ['media-info-row-comments', ICONS.messageCircle, 'comments:'],
    ['media-info-row-shares', ICONS.share, 'shares:'],
    ['media-info-row-saves', ICONS.star, 'saves:'],
    ['media-info-row-caption', ICONS.fileText, 'caption:'],
    ['media-info-row-hashtags', ICONS.hash, 'hashtags:'],
    ['media-info-row-music', ICONS.music, 'music:'],
    ['media-info-row-posted', ICONS.calendar, 'posted:'],
    ['media-info-row-author', ICONS.users, 'author:'],
  ];

  const children = rows.map(([cls, path, text]) =>
    el('div', { class: `media-info-row ${cls}` }, [
      infoLabel(path, text),
      el('span', { class: 'media-info-value media-info-placeholder' }, '\u2014'),
    ])
  );

  return el('div', { class: 'media-info-panel newest2-info-panel' }, children);
}

function populateInfoPanel(entry) {
  const { descData, uid } = entry;
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
    row.textContent = val ?? '\u2014';
    row.classList.remove('media-info-placeholder');
  }

  setVal('media-info-row-likes', stats.diggCount != null ? formatNumber(stats.diggCount) : null);
  setVal('media-info-row-plays', stats.playCount != null ? formatNumber(stats.playCount) : null);
  setVal('media-info-row-comments', stats.commentCount != null ? String(stats.commentCount) : null);
  setVal('media-info-row-shares', stats.shareCount != null ? String(stats.shareCount) : null);
  setVal('media-info-row-saves', stats.collectCount != null ? String(stats.collectCount) : null);
  setVal('media-info-row-caption', desc || null);
  setVal('media-info-row-hashtags', tags.length ? '#' + tags.join(' #') : null);
  const musicStr = (musicTitle || musicAuthor)
    ? [musicAuthor ? `${musicAuthor} \u2014 ` : '', musicTitle].filter(Boolean).join('')
    : null;
  setVal('media-info-row-music', musicStr);
  setVal('media-info-row-posted', dateStr || null);
  setVal('media-info-row-author', uniqueId ? `@${uniqueId}` : null);
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
    generateVideoThumbnail(src, 160).then(dataUrl => {
      if (!dataUrl || renderGen !== myGen) return;
      const img = el('img', { src: dataUrl, alt: '', loading: 'lazy' });
      const existingLoader = item.querySelector('.newest2-thumb-loader');
      if (existingLoader) existingLoader.remove();
      item.appendChild(img);
    });
  } else {
    const img = el('img', { src, alt: '', loading: 'lazy' });
    img.onload = () => {
      if (renderGen !== myGen) return;
      const existingLoader = item.querySelector('.newest2-thumb-loader');
      if (existingLoader) existingLoader.remove();
    };
    img.onerror = () => {
      if (renderGen !== myGen) return;
      const existingLoader = item.querySelector('.newest2-thumb-loader');
      if (existingLoader) existingLoader.style.display = 'none';
    };
    item.appendChild(img);
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
    item.classList.toggle('active', parseInt(item.dataset.index, 10) === activeItemIndex);
  });
}

function switchToItem(index) {
  if (!feedEl || index < 0 || index >= items.length) return;
  feedEl.scrollTop = index * feedEl.clientHeight;
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
    onClick: () => {
      globalMuted = !globalMuted;
      localStorage.setItem('newest-muted', String(globalMuted));
      muteBtn.title = globalMuted ? 'Unmuted' : 'Muted';
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
  if (video.paused) video.play().catch(() => {});
  else video.pause();
}

function updateVideoTimeDisplay(video, timeEl, seekBar) {
  const cur = video.currentTime || 0;
  const dur = video.duration || 0;
  timeEl.textContent = `${formatTime(cur)} / ${formatTime(dur)}`;
}

function buildSlide(entry, index) {
  const { descData, uid, itemId } = entry;
  const vid = isVideo(descData);
  const imgCount = getImageCount(descData);

  let slideChildren;

  if (vid) {
    const src = mediaUrl(uid, itemId, 'mp4');
    const video = el('video', { src, playsinline: true, muted: globalMuted, loop: true });
    video.addEventListener('error', (e) => {
      console.warn('[newest] video failed to load:', src, e.type);
    });

    const wrap = el('div', { class: 'newest2-video-wrap' });

    const flashBtn = el('div', { class: 'newest2-play-flash' }, ['\u25B6']);
    const timeEl = el('span', { class: 'newest2-time-display' }, '0:00 / 0:00');
    const playBtnBottom = el('button', { class: 'newest2-play-btn-bottom' }, ['\u25B6']);
    const seekBar = el('input', { type: 'range', class: 'newest2-seek-bar', min: '0', max: '100', value: '0', step: '0.1' });
    const bottomBar = el('div', { class: 'newest2-video-bottom' }, [playBtnBottom, seekBar, timeEl]);
    const controls = el('div', { class: 'newest2-video-controls' }, [bottomBar]);

    wrap.appendChild(video);
    wrap.appendChild(flashBtn);

    const metaUser = descData.author?.uniqueId || descData.author?.unique_id || uid;
    const dateStr = formatDateDDMMYY(descData.createTime);
    const cap = (descData.desc || '').trim();
    const overlayEl = el('div', { class: 'newest2-video-overlay' }, [
      el('div', { class: 'newest2-video-overlay-meta' }, [
        el('span', { class: 'newest2-video-overlay-user' }, [`@${metaUser}`]),
        el('span', { class: 'newest2-video-overlay-date' }, [` · ${dateStr}`]),
      ]),
      cap ? el('div', { class: 'newest2-video-overlay-caption' }, [cap]) : null,
    ].filter(Boolean));
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

    video.addEventListener('loadedmetadata', () => {
      seekBar.max = String(video.duration || 0);
      syncTime();
    });
    video.addEventListener('timeupdate', syncTime);
    video.addEventListener('play', () => {
      playBtnBottom.textContent = '\u23F8';
      flashBtn.textContent = '\u23F8';
      flashBtn.classList.remove('newest2-play-flash-visible');
      showControls();
    });
    video.addEventListener('pause', () => {
      playBtnBottom.textContent = '\u25B6';
      flashBtn.textContent = '\u25B6';
      flashBtn.classList.add('newest2-play-flash-visible');
      if (hideTimer) clearTimeout(hideTimer);
      controls.classList.remove('newest2-controls-hidden');
    });

    playBtnBottom.addEventListener('click', (e) => { e.stopPropagation(); togglePlay(); });
    seekBar.addEventListener('mousedown', () => { dragging = true; });
    seekBar.addEventListener('mouseup', () => { dragging = false; });
    seekBar.addEventListener('input', () => {
      const seekTo = parseFloat(seekBar.value);
      if (!isNaN(seekTo)) video.currentTime = seekTo;
      updateVideoTimeDisplay(video, timeEl, seekBar);
    });

    wrap.addEventListener('click', (e) => {
      if (e.target === wrap || e.target === video || e.target === controls) togglePlay();
    });
    wrap.addEventListener('mousemove', showControls);
    wrap.addEventListener('touchstart', showControls, { passive: true });

    slideChildren = [wrap];
  } else {
    const imgWrap = el('div', { class: 'newest2-img-wrap' });

    const src0 = mediaUrl(uid, itemId, 'jpg', 0);
    const img = el('img', { src: src0, alt: '', 'data-img-idx': '0' });
    img.addEventListener('error', (e) => {
      console.warn('[newest] image failed to load:', src0, e.type);
    });

    imgWrap.appendChild(img);

    if (imgCount > 1) {
      const prevBtn = el('button', {
        class: 'media-viewer-nav-prev',
        style: 'position:absolute;left:8px;top:50%;transform:translateY(-50%);width:36px;height:36px;border-radius:50%;background:rgba(255,255,255,0.1);color:#fff;display:flex;align-items:center;justify-content:center;font-size:22px;border:none;cursor:pointer;z-index:10;transition:background 0.2s;line-height:1;',
        onClick: (e) => { e.stopPropagation(); navigateImage(index, -1); },
      }, ['\u2039']);
      const nextBtn = el('button', {
        class: 'media-viewer-nav-next',
        style: 'position:absolute;right:8px;top:50%;transform:translateY(-50%);width:36px;height:36px;border-radius:50%;background:rgba(255,255,255,0.1);color:#fff;display:flex;align-items:center;justify-content:center;font-size:22px;border:none;cursor:pointer;z-index:10;transition:background 0.2s;line-height:1;',
        onClick: (e) => { e.stopPropagation(); navigateImage(index, 1); },
      }, ['\u203A']);
      const counter = el('div', {
        class: 'media-viewer-counter',
        style: 'position:absolute;top:12px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.5);color:#fff;padding:3px 12px;border-radius:999px;font-size:12px;z-index:10;white-space:nowrap;',
        'data-counter': '',
      }, [`1/${imgCount}`]);

      imgWrap.appendChild(prevBtn);
      imgWrap.appendChild(nextBtn);
      imgWrap.appendChild(counter);
    }

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
  cur = Math.max(0, Math.min(max - 1, cur + dir));
  slide.dataset.imgIdx = String(cur);

  const entry = items[slideIndex];
  if (!entry) return;
  const src = mediaUrl(entry.uid, entry.itemId, 'jpg', cur);
  const img = slide.querySelector('img');
  if (img) img.src = src;

  const counter = slide.querySelector('[data-counter]');
  if (counter) counter.textContent = `${cur + 1}/${max}`;
}

function setupIntersectionObserver() {
  if (observer) observer.disconnect();
  observer = new IntersectionObserver((entries) => {
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
    if (isNaN(idx)) return;

    feedEl.querySelectorAll('.newest2-slide').forEach(s => {
      s.classList.remove('active');
      if (s.dataset.imgCount > 1) {
        s.dataset.imgIdx = '0';
        const img = s.querySelector('img');
        if (img) {
          const entry2 = items[parseInt(s.dataset.index, 10)];
          if (entry2) img.src = mediaUrl(entry2.uid, entry2.itemId, 'jpg', 0);
        }
        const ctr = s.querySelector('[data-counter]');
        if (ctr) ctr.textContent = `1/${s.dataset.imgCount}`;
      }
    });
    slide.classList.add('active');
    if (slide.dataset.imgCount > 1) {
      slide.dataset.imgIdx = '0';
      const img = slide.querySelector('img');
      if (img) {
        const entry2 = items[idx];
        if (entry2) img.src = mediaUrl(entry2.uid, entry2.itemId, 'jpg', 0);
      }
      const ctr = slide.querySelector('[data-counter]');
      if (ctr) ctr.textContent = `1/${slide.dataset.imgCount}`;
    }
    activeItemIndex = idx;

    const video = slide.querySelector('video');
    feedEl.querySelectorAll('video').forEach(v => {
      if (v !== video) v.pause();
    });
    if (video && video.src) {
      video.muted = globalMuted;
      video.play().catch(() => {});
    }

    populateInfoPanel(items[idx]);
    highlightActiveThumb();
    updateNavButtons();
    loadMoreIfNeeded();
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
      if (!items.length) { allDone = true; showEmpty('Could not load media details'); return; }
      allDone = true; return;
    }

    const startIdx = items.length;
    const wasEmpty = !items.length;
    items.push(...enriched);

    renderThumbnailBatch(enriched, startIdx);

    enriched.forEach((entry, i) => {
      const slide = buildSlide(entry, startIdx + i);
      feedEl.appendChild(slide);
    });

    if (observer) observer.disconnect();
    setupIntersectionObserver();

    if (wasEmpty && activeItemIndex === -1) {
      activeItemIndex = 0;
      populateInfoPanel(items[0]);
      highlightActiveThumb();
      updateNavButtons();
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
  const closeBtn = el('button', { class: 'newest2-close', onClick: close }, ['\u2715']);

  infoPanelEl = buildInfoPanel();

  navUpBtn = el('button', {
    class: 'newest2-nav-btn',
    title: 'Previous (ArrowUp)',
    disabled: true,
    onClick: () => scrollToSlide(-1),
  }, ['\u25B2']);
  navDownBtn = el('button', {
    class: 'newest2-nav-btn',
    title: 'Next (ArrowDown)',
    disabled: true,
    onClick: () => scrollToSlide(1),
  }, ['\u25BC']);
  const navSide = el('div', { class: 'newest2-nav-side' }, [navUpBtn, navDownBtn]);

  thumbContainer = el('div', { class: 'newest2-thumb-container' });
  thumbGrid = el('div', { class: 'newest2-thumb-grid' });
  thumbContainer.appendChild(thumbGrid);

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

export function resetNewestCache() {
  if (keydownHandler) document.removeEventListener('keydown', keydownHandler);
  if (observer) observer.disconnect();
  if (sentinelObserver) sentinelObserver.disconnect();
  keydownHandler = null;
  observer = null;
  sentinelObserver = null;
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

  if (activeItemIndex >= 0 && activeItemIndex < items.length) {
    feedEl.scrollTop = activeItemIndex * feedEl.clientHeight;
    populateInfoPanel(items[activeItemIndex]);
    highlightActiveThumb();
    updateNavButtons();
  } else if (items.length > 0) {
    activeItemIndex = 0;
    populateInfoPanel(items[0]);
    highlightActiveThumb();
    updateNavButtons();
  }

  if (observer) observer.disconnect();
  setupIntersectionObserver();
}

export function renderNewest(containerEl) {
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
  keydownHandler = null;
  observer = null;
  sentinelObserver = null;

  buildLayout();
  container.appendChild(pageEl);

  setupKeydownHandler();

  const onVisibilityChange = () => {
    if (document.hidden) pauseAllVideos();
    else resumeActiveVideo();
  };
  document.addEventListener('visibilitychange', onVisibilityChange);

  if (isFresh) {
    loadPage(1).then(() => {
      if (!allDone && !loading) {
        loadPage(2);
      }
    });
  } else {
    restoreCachedItems();
  }
}
