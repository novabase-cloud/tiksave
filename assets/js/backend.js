import { HF_MEDIA_PROXY } from './config.js';

const WORKER_BASE = HF_MEDIA_PROXY || 'https://api-tiksave.mailtestvartext.workers.dev';
const STORAGE_KEY = 'tiksave.backend.tunnel_url';
const RETRY_DELAY_MS = 3000; // 3 seconds delay between requests to prevent spam

let _inMemoryUrl = null;
let _fetchPromise = null;
let _lastAttemptTime = 0;

/**
 * Mendapatkan URL backend tunnel aktif dari Cloudflare Worker (Teller).
 * Disimpan di memori & localStorage, dengan proteksi anti-spam 3 detik.
 *
 * @param {boolean} forceRefresh - Paksa minta URL baru ke Teller jika URL lama gagal/mati
 * @returns {Promise<string|null>} URL backend (misal: "https://xyz.trycloudflare.com") atau null
 */
export async function getBackendUrl(forceRefresh = false) {
  const now = Date.now();

  // Jika sudah ada URL di memori & tidak dipaksa refresh, gunakan langsung
  if (_inMemoryUrl && !forceRefresh) {
    return _inMemoryUrl;
  }

  // Coba ambil dari localStorage jika ada & belum expired (< 15 menit)
  if (!forceRefresh) {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.url && now - (parsed.savedAt || 0) < 15 * 60 * 1000) {
          _inMemoryUrl = parsed.url;
          return _inMemoryUrl;
        }
      }
    } catch {}
  }

  // Jeda permintaan minimal 3 detik agar tidak spamming ke teller
  const timeSinceLast = now - _lastAttemptTime;
  if (timeSinceLast < RETRY_DELAY_MS) {
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS - timeSinceLast));
  }

  // Jika ada request yang sedang berjalan bersamaan, gabungkan
  if (_fetchPromise) {
    return _fetchPromise;
  }

  _lastAttemptTime = Date.now();

  _fetchPromise = (async () => {
    try {
      const resp = await fetch(`${WORKER_BASE}/teller`, {
        headers: { Accept: 'application/json' },
      });

      if (!resp.ok) {
        return null;
      }

      const data = await resp.json();
      if (data.ok && data.url) {
        const cleanUrl = data.url.replace(/\/+$/, '');
        _inMemoryUrl = cleanUrl;
        try {
          localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({ url: cleanUrl, savedAt: Date.now() })
          );
        } catch {}
        return cleanUrl;
      }

      return null;
    } catch (err) {
      console.warn('[Teller] Gagal mengambil URL backend dari worker:', err);
      return null;
    } finally {
      _fetchPromise = null;
    }
  })();

  return _fetchPromise;
}

/**
 * Hapus cache URL backend jika tunnel mati atau mengembalikan error jaringan/502/404.
 */
export function invalidateBackendUrl() {
  _inMemoryUrl = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
  _lastAttemptTime = Date.now();
}
