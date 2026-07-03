import { el, icon } from '../utils/dom.js';
import { fetchPostDescription } from '../api.js';
import { formatNumber } from '../utils/format.js';
import { ICONS } from '../utils/icons.js';

class MediaViewer {
  posts = [];
  postIdx = 0;
  mediaIdx = 0;
  backdrop = null;
  profileInfo = null;
  renderGen = 0;
  imageCache = new Map();
  pendingFetches = new Map();
  descCache = new Map();
  keydownHandler = null;

  infoLabel(svgPath, text) {
    const svg = icon(svgPath, 12);
    svg.style.verticalAlign = 'middle';
    svg.style.marginRight = '3px';
    return el('span', { class: 'media-info-label' }, [svg, ` ${text}`]);
  }

  loadImage(url) {
    if (this.imageCache.has(url)) return Promise.resolve(this.imageCache.get(url));
    if (this.pendingFetches.has(url)) return this.pendingFetches.get(url);
    const promise = fetch(url)
      .then(r => { if (!r.ok) throw Error('fetch failed'); return r.blob(); })
      .then(blob => { const objUrl = URL.createObjectURL(blob); this.imageCache.set(url, objUrl); this.pendingFetches.delete(url); return objUrl; })
      .catch(err => { this.pendingFetches.delete(url); throw err; });
    this.pendingFetches.set(url, promise);
    return promise;
  }

  open(allPosts, startPostIdx = 0, startMediaIdx = 0, info = null) {
    if (!allPosts || !allPosts.length) return;
    this.posts = allPosts;
    this.postIdx = startPostIdx;
    this.mediaIdx = startMediaIdx;
    this.profileInfo = info;
    this.render();
  }

  close() {
    if (this.keydownHandler) {
      document.removeEventListener('keydown', this.keydownHandler);
      this.keydownHandler = null;
    }
    if (this.backdrop) {
      this.backdrop.style.opacity = '0';
      this.backdrop.addEventListener('transitionend', () => {
        this.backdrop.remove();
        this.backdrop = null;
      }, { once: true });
    }
    this.posts = [];
    this.postIdx = 0;
    this.mediaIdx = 0;
    this.profileInfo = null;
    this.imageCache.forEach(url => URL.revokeObjectURL(url));
    this.imageCache.clear();
    this.pendingFetches.clear();
  }

  currentMedia() {
    const post = this.posts[this.postIdx];
    if (!post) return null;
    return post.media?.[this.mediaIdx] || null;
  }

  currentFile() {
    const post = this.posts[this.postIdx];
    if (!post || !post.files) return null;
    const item = this.currentMedia();
    if (!item) return null;
    return post.files.find(f => f.name === item.name) || post.files[0] || null;
  }

  formatSize(bytes) {
    if (!bytes) return '\u2014';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let size = bytes;
    while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
    return `${size.toFixed(i === 0 ? 0 : 1)}${units[i]}`;
  }

  buildCachedImage(url, alt, gen) {
    const img = el('img', { alt });
    const cached = this.imageCache.get(url);
    if (cached) {
      img.src = cached;
    } else {
      img.style.opacity = '0.3';
      this.loadImage(url).then(objUrl => {
        if (gen !== this.renderGen) return;
        img.src = objUrl;
        img.style.opacity = '1';
      }).catch(() => { if (gen === this.renderGen) img.style.display = 'none'; });
    }
    return img;
  }

  render() {
    this.renderGen++;

    const item = this.currentMedia();
    if (!item) return;

    const post = this.posts[this.postIdx];
    const file = this.currentFile();
    const totalPosts = this.posts.length;
    const totalMedia = post?.media?.length || 1;

    const closeBtn = el('button', {
      class: 'media-viewer-close',
      onClick: () => this.close(),
    }, ['\u2715']);

    const myGen = this.renderGen;

    const mediaEl = item.type === 'video'
      ? el('video', { src: item.url, controls: true, autoplay: true })
      : this.buildCachedImage(item.url, item.name, myGen);

    const prevMedia = this.mediaIdx > 0
      ? el('button', { class: 'media-viewer-nav-prev', onClick: () => { this.mediaIdx--; this.render(); } }, ['\u2039'])
      : null;
    const nextMedia = this.mediaIdx < totalMedia - 1
      ? el('button', { class: 'media-viewer-nav-next', onClick: () => { this.mediaIdx++; this.render(); } }, ['\u203A'])
      : null;

    const mediaWrap = el('div', { class: 'media-viewer-media-wrap' }, [
      mediaEl,
      prevMedia, nextMedia,
    ].filter(Boolean));

    const content = el('div', { class: 'media-viewer-content' }, [mediaWrap]);

    const counter = el('div', { class: 'media-viewer-counter' }, [
      `Post ${this.postIdx + 1}/${totalPosts} \u00B7 Media ${this.mediaIdx + 1}/${totalMedia}`,
    ]);

    let strip = null;
    if (totalMedia > 1) {
      strip = el('div', { class: 'media-viewer-strip' });
      post.media.forEach((m, i) => {
        const thumb = this.buildCachedImage(m.thumbnail || m.url, '', myGen);
        const btn = el('button', {
          class: 'media-viewer-strip-item' + (i === this.mediaIdx ? ' active' : ''),
          onClick: () => { this.mediaIdx = i; this.render(); },
        }, [thumb]);
        strip.appendChild(btn);
      });
    }

    const sideNav = el('div', { class: 'media-viewer-nav-side' }, [
      this.postIdx > 0
        ? el('button', { class: 'media-viewer-nav-btn', onClick: () => { this.postIdx--; this.mediaIdx = 0; this.render(); } }, ['\u25B2'])
        : null,
      this.postIdx < totalPosts - 1
        ? el('button', { class: 'media-viewer-nav-btn', onClick: () => { this.postIdx++; this.mediaIdx = 0; this.render(); } }, ['\u25BC'])
        : null,
    ].filter(Boolean));

    const infoRows = [];

    if (file) {
      infoRows.push(
        el('div', { class: 'media-info-row media-info-row-file-size' }, [
          el('span', { class: 'media-info-label' }, 'file size:'),
          el('span', { class: 'media-info-value' }, this.formatSize(file.size)),
        ])
      );
      infoRows.push(
        el('div', { class: 'media-info-row media-info-row-file-path' }, [
          el('span', { class: 'media-info-label' }, 'file on disk:'),
          el('span', { class: 'media-info-value media-info-path' }, file.path),
        ])
      );
    }

    const username = this.profileInfo?.username || '';
    const linkType = post?.isVideo ? 'video' : 'photo';
    const tiktokUrl = username
      ? `https://www.tiktok.com/@${username}/${linkType}/${post?.itemId || ''}`
      : null;

    if (tiktokUrl) {
      infoRows.push(
        el('div', { class: 'media-info-row media-info-row-tiktok-link' }, [
          this.infoLabel(ICONS.externalLink, 'TikTok link:'),
          el('a', { class: 'media-info-value media-info-link', href: tiktokUrl, target: '_blank', rel: 'noopener' }, tiktokUrl),
        ])
      );
    }

    if (username) {
      infoRows.push(el('div', { class: 'media-info-row media-info-row-author' }, [
        this.infoLabel(ICONS.users, 'author:'),
        el('span', { class: 'media-info-value' }, [`@${username}`]),
      ]));
    }

    if (post?.createTime) {
      const date = new Date(post.createTime * 1000);
      infoRows.push(el('div', { class: 'media-info-row media-info-row-posted' }, [
        this.infoLabel(ICONS.calendar, 'posted:'),
        el('span', { class: 'media-info-value' }, date.toLocaleDateString()),
      ]));
    }

    const userInfo = this.profileInfo?.userInfo;
    if (userInfo?.username_history?.length > 0) {
      const historyText = userInfo.username_history.map(h => `@${h.username}`).join(' \u2192 ');
      infoRows.push(el('div', { class: 'media-info-row media-info-row-username-history' }, [
        this.infoLabel(ICONS.edit, 'username history:'),
        el('span', { class: 'media-info-value', style: { fontSize: 12 } }, [historyText]),
      ]));
    }

    infoRows.push(...this.createPlaceholderRows());

    const infoPanel = el('div', { class: 'media-info-panel' }, infoRows);

    const viewerWrap = el('div', { class: 'media-viewer-wrap' }, [
      el('div', { class: 'media-viewer-inner' }, [
        sideNav,
        el('div', { class: 'media-viewer-center' }, [
          content,
          counter,
        ]),
      ]),
      infoPanel,
    ]);

    const newContent = [closeBtn, viewerWrap, strip].filter(Boolean);

    if (!this.backdrop) {
      this.backdrop = el('div', {
        class: 'media-viewer-backdrop',
        onClick: (e) => {
          if (e.target === this.backdrop) this.close();
        },
      });

      this.keydownHandler = (e) => this.handleKeydown(e);
      document.addEventListener('keydown', this.keydownHandler);
      this.backdrop.append(...newContent);
      document.body.appendChild(this.backdrop);
      requestAnimationFrame(() => { this.backdrop.style.opacity = '1'; });
    } else {
      this.backdrop.replaceChildren(...newContent);
    }

    const postPath = post?.path;
    if (postPath) {
      const cached = this.descCache.get(postPath);
      if (cached) {
        this.populateDescSection(cached, post);
      } else {
        fetchPostDescription(postPath).then(data => {
          if (!data || myGen !== this.renderGen) return;
          this.descCache.set(postPath, data);
          this.populateDescSection(data, post);
        }).catch(() => {});
      }
    }

    const mediaList = post?.media;
    if (mediaList) {
      [this.mediaIdx - 1, this.mediaIdx + 1].forEach(i => {
        const m = mediaList[i];
        if (m && m.type !== 'video' && !this.imageCache.has(m.url)) {
          this.loadImage(m.url).catch(() => {});
        }
      });
    }
  }

  createPlaceholderRows() {
    const items = [
      ['media-info-row-likes', ICONS.heart, 'likes:'],
      ['media-info-row-plays', ICONS.play, 'plays:'],
      ['media-info-row-comments', ICONS.messageCircle, 'comments:'],
      ['media-info-row-shares', ICONS.share, 'shares:'],
      ['media-info-row-saves', ICONS.star, 'saves:'],
      ['media-info-row-caption', ICONS.fileText, 'caption:'],
      ['media-info-row-hashtags', ICONS.hash, 'hashtags:'],
      ['media-info-row-music', ICONS.music, 'music:'],
      ['media-info-row-posted-desc', ICONS.calendar, 'posted:'],
      ['media-info-row-author-followers', ICONS.users, 'author followers:'],
    ];
    return items.map(([cls, path, text]) =>
      el('div', { class: `media-info-row ${cls}` }, [
        this.infoLabel(path, text),
        el('span', { class: 'media-info-value media-info-placeholder' }, '\u2014'),
      ])
    );
  }

  populateDescSection(data, post) {
    const stats = data.stats || {};
    const desc = data.desc || post?.desc || '';
    const challenges = data.challenges || [];
    const tags = challenges.map(c => c.title).filter(Boolean);
    const music = data.music || {};
    const musicTitle = music.title || '';
    const musicAuthor = music.authorName || '';
    const authorStats = data.authorStats || {};

    const dateStr = data.createTime
      ? new Date(data.createTime * 1000).toLocaleDateString()
      : null;
    const existing = this.backdrop?.querySelector('.media-info-row-posted');

    this.setRowValue('media-info-row-likes', stats.diggCount != null ? formatNumber(stats.diggCount) : '\u2014');
    this.setRowValue('media-info-row-plays', stats.playCount != null ? formatNumber(stats.playCount) : '\u2014');
    this.setRowValue('media-info-row-comments', stats.commentCount != null ? String(stats.commentCount) : '\u2014');
    this.setRowValue('media-info-row-shares', stats.shareCount != null ? String(stats.shareCount) : '\u2014');
    this.setRowValue('media-info-row-saves', stats.collectCount != null ? String(stats.collectCount) : '\u2014');
    this.setRowValue('media-info-row-caption', desc || '\u2014');
    this.setRowValue('media-info-row-hashtags', tags.length ? '#' + tags.join(' #') : '\u2014');

    const musicStr = (musicTitle || musicAuthor)
      ? [musicAuthor ? `${musicAuthor} \u2014 ` : '', musicTitle].filter(Boolean).join('')
      : '\u2014';
    this.setRowValue('media-info-row-music', musicStr);

    if (dateStr && !existing) {
      this.setRowValue('media-info-row-posted-desc', dateStr);
    }

    this.setRowValue('media-info-row-author-followers', authorStats.followerCount != null ? formatNumber(authorStats.followerCount) : '\u2014');
  }

  setRowValue(cls, value) {
    const el = this.backdrop?.querySelector(`.${cls} .media-info-value`);
    if (!el) return;
    el.classList.remove('media-info-placeholder');
    el.textContent = value;
  }

  statRow(iconPath, label, value) {
    return el('div', { class: 'media-info-row' }, [
      this.infoLabel(iconPath, label),
      el('span', { class: 'media-info-value' }, value),
    ]);
  }

  handleKeydown(e) {
    if (e.key === 'Escape') { this.close(); return; }
    if (e.key === 'ArrowUp' && this.postIdx > 0) { e.preventDefault(); this.postIdx--; this.mediaIdx = 0; this.render(); return; }
    if (e.key === 'ArrowDown' && this.postIdx < this.posts.length - 1) { e.preventDefault(); this.postIdx++; this.mediaIdx = 0; this.render(); return; }
    const totalMedia = this.posts[this.postIdx]?.media?.length || 1;
    if (e.key === 'ArrowLeft' && this.mediaIdx > 0) { e.preventDefault(); this.mediaIdx--; this.render(); return; }
    if (e.key === 'ArrowRight' && this.mediaIdx < totalMedia - 1) { e.preventDefault(); this.mediaIdx++; this.render(); return; }
  }
}

const instance = new MediaViewer();
export const openMediaViewer = (...args) => instance.open(...args);
