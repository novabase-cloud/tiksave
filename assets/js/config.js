export const HF_API = 'https://huggingface.co';

// Worker — proxy semua request ke HF + CORS + redirect follow
const WORKER = 'https://novabase-cloud.mailtestvartext.workers.dev';
export const HF_API_BASE = `${WORKER}/api`;
export const HF_MEDIA_PROXY = WORKER;

// Kalau worker mati, fallback langsung ke HF:
// export const HF_API_BASE = 'https://huggingface.co/api';
// export const HF_MEDIA_PROXY = '';

export const STORAGE_KEYS = {
  HF_TOKEN: 'tiktok.hf.token',
  HF_REFRESH_TOKEN: 'tiktok.hf.refresh_token',
  USER_INFO: 'tiktok.user.info',
  GUEST_MODE: 'tiktok.guest_mode',
  THEME: 'tiktok.theme',
  OAUTH_VERIFIER: 'tiktok_oauth_verifier',
  OAUTH_STATE: 'tiktok_oauth_state',
  OAUTH_FORCE_CONSENT: 'tiktok_oauth_force_consent',
  CUSTOM_REPO: 'tiktok.custom.repo',
};

export function getDatasetRepo() {
  const custom = localStorage.getItem(STORAGE_KEYS.CUSTOM_REPO);
  if (custom) return custom;
  const raw = localStorage.getItem(STORAGE_KEYS.USER_INFO);
  if (raw) {
    try {
      const user = JSON.parse(raw);
      const name = user.preferred_username || user.name || user.sub;
      if (name) return `${name}/Tiktok`;
    } catch {}
  }
  return null;
}

export const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif'];
export const VIDEO_EXTS = ['mp4', 'webm', 'mov', 'avi', 'mkv', 'm4v', 'ogv'];

// Vercel Image Resizer — POST binary → return thumbnail
export const IMAGE_RESIZER = 'https://image-resizer-sable.vercel.app';
