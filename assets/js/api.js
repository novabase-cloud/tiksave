import { HF_API, HF_MEDIA_PROXY, getDatasetRepo, IMAGE_EXTS, VIDEO_EXTS } from './config.js';
import { fetchJSON } from './utils/http.js';
import { getToken } from './auth.js';

function resolveUrl(subPath) {
  const base = HF_MEDIA_PROXY || HF_API;
  const repo = getDatasetRepo();
  if (!repo) return null;
  let url = `${base}/datasets/${repo}/resolve/main/${subPath}`;
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

export async function listUserItems(rawUid) {
  const prefix = `Posts/${rawUid}`;

  const [infoResult, metaResult, postResult] = await Promise.all([
    fetchJSON(resolveUrl(`${prefix}/user_info.json`)),
    fetchJSON(resolveUrl(`${prefix}/mediaindex.json`)),
    fetchJSON(resolveUrl(`${prefix}/post_list.json`)),
  ]);

  const userList = await getUserList();
  const avatarPath = userList.find(u => u.uid === rawUid)?.avatar_path || null;

  return {
    items: (postResult.ok ? postResult.data : []).sort((a, b) => b.itemId.localeCompare(a.itemId)),
    metadata: metaResult.ok ? metaResult.data : null,
    avatarPath,
    userInfo: infoResult.ok ? infoResult.data : null,
  };
}

export function getMediaUrl(entryPath) {
  return resolveUrl(entryPath) || '';
}

export async function fetchUserAvatarUrl(username) {
  const data = await getUserList();
  const user = data.find(u => u.unique_id === username);
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
