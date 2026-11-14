import { HF_API, HF_MEDIA_PROXY, getDatasetRepo, IMAGE_EXTS, VIDEO_EXTS } from './config.js';
import { fetchJSON } from './utils/http.js';
import { getToken } from './auth.js';

function resolveUrl(subPath) {
  const base = HF_MEDIA_PROXY || HF_API;
  const repo = getDatasetRepo();
  if (!repo) return null;
  let url = `${base}/proxy/datasets/${repo}/resolve/main/${subPath}`;
  const token = getToken();
  if (token) url += `?token=${encodeURIComponent(token)}`;
  return url;
}

let _userListCache = null;

export function clearUserListCache() {
  _userListCache = null;
}

async function getUserList() {
  if (_userListCache) return _userListCache;
  const url = resolveUrl('Posts/user_list.json');
  const result = await fetchJSON(url);
  _userListCache = result.ok ? (result.data || []) : [];
  return _userListCache;
}

export async function listUsers() {
  const data = await getUserList();
  if (!data.length) return [];

  return data.map(u => ({
    uid: u.uid,
    username: u.unique_id,
    nickname: u.nickname || u.unique_id,
    avatar_path: u.avatar_path || null,
    userInfo: null,
  }));
}

function extractItemsFromMediaIndex(prefix, mediaindex) {
  if (!mediaindex) return [];
  const map = new Map();
  const allMedia = [
    ...Object.values(mediaindex.videos || {}),
    ...Object.values(mediaindex.images || {})
  ];
  for (const m of allMedia) {
    const itemId = m.itemId || m.item_id;
    if (!itemId) continue;
    if (!map.has(itemId)) {
      map.set(itemId, {
        itemId,
        path: `${prefix}/${itemId}`,
        files: [],
      });
    }
    const name = m.fileName || m.filename || `${itemId}-${m.index || 0}.mp4`;
    const ext = name.split('.').pop().toLowerCase();
    map.get(itemId).files.push({
      name,
      path: `${prefix}/${itemId}/${name}`,
      size: m.size || 0,
      ext,
    });
  }
  return Array.from(map.values());
}

export async function listUserItems(rawUid) {
  const prefix = `Posts/${rawUid}`;

  const [infoResult, metaResult, postResult] = await Promise.all([
    fetchJSON(resolveUrl(`${prefix}/user_info.json`)),
    fetchJSON(resolveUrl(`${prefix}/mediaindex.json`)),
    fetchJSON(resolveUrl(`${prefix}/post_list.json`)),
  ]);

  let items = [];
  if (postResult.ok && Array.isArray(postResult.data)) {
    items = postResult.data;
  } else if (metaResult.ok && metaResult.data) {
    items = extractItemsFromMediaIndex(prefix, metaResult.data);
  }

  // Fallback tambahan jika items kosong namun metadata.json ada
  if (!items.length) {
    const dirMeta = await fetchJSON(resolveUrl(`${prefix}/metadata.json`));
    if (dirMeta.ok && Array.isArray(dirMeta.data?.children)) {
      for (const c of dirMeta.data.children) {
        if (c.type === 'directory') {
          const name = c.path.split('/').pop();
          if (name && name !== 'avatar' && name !== 'Following') {
            items.push({
              itemId: name,
              path: c.path,
              files: [],
            });
          }
        }
      }
    }
  }

  const userList = await getUserList();
  const matchedUser = userList.find(u => u.uid === rawUid || u.unique_id === rawUid);
  let avatarPath = matchedUser?.avatar_path || null;
  let avatarPaths = matchedUser?.avatar_paths || (avatarPath ? [avatarPath] : []);

  // Coba cek avatar/metadata.json jika avatarPaths belum terisi
  if (!avatarPaths.length) {
    const avMeta = await fetchJSON(resolveUrl(`${prefix}/avatar/metadata.json`));
    if (avMeta.ok && Array.isArray(avMeta.data?.children)) {
      const imgExts = ['.jpg', '.jpeg', '.png', '.webp'];
      const found = avMeta.data.children
        .filter(c => c.type === 'file' && imgExts.some(ext => c.path.toLowerCase().endsWith(ext)))
        .map(c => c.path);
      if (found.length) {
        found.sort((a, b) => {
          const vA = parseInt((a.match(/-(\d+)\.[^.]+$/) || [0, 0])[1], 10);
          const vB = parseInt((b.match(/-(\d+)\.[^.]+$/) || [0, 0])[1], 10);
          return vA - vB;
        });
        avatarPaths = found;
        avatarPath = found[found.length - 1];
      }
    }
  }

  const remoteAvatarUrl = infoResult.ok
    ? (infoResult.data?.avatarLarger || infoResult.data?.avatarMedium || infoResult.data?.avatarThumb || null)
    : null;

  return {
    items: items.sort((a, b) => b.itemId.localeCompare(a.itemId)),
    metadata: metaResult.ok ? metaResult.data : null,
    avatarPath,
    avatarPaths,
    remoteAvatarUrl,
    userInfo: infoResult.ok ? infoResult.data : null,
  };
}

export function getMediaUrl(entryPath) {
  return resolveUrl(entryPath) || '';
}

export async function fetchUserAvatarUrl(username) {
  const data = await getUserList();
  const user = data.find(u => u.unique_id === username || u.uid === username);
  return user?.avatar_path ? getMediaUrl(user.avatar_path) : null;
}

export async function fetchPostDescription(postPath) {
  const url = resolveUrl(`${postPath}/description.json`);
  const result = await fetchJSON(url);
  return result.ok ? result.data : null;
}

export function getItemThumbnail(item) {
  const imageFile = item.files.find(f => IMAGE_EXTS.includes(f.ext));
  if (imageFile) return getMediaUrl(imageFile.path);
  const videoFile = item.files.find(f => VIDEO_EXTS.includes(f.ext));
  if (videoFile) return getMediaUrl(videoFile.path);
  return null;
}

export function getItemMediaFiles(item) {
  const media = [];
  for (const f of item.files) {
    if (IMAGE_EXTS.includes(f.ext) || VIDEO_EXTS.includes(f.ext)) {
      media.push({
        url: getMediaUrl(f.path),
        type: IMAGE_EXTS.includes(f.ext) ? 'image' : 'video',
        name: f.name,
      });
    }
  }
  return media.sort((a, b) => a.name.localeCompare(b.name));
}
