# TODO: Full Refactor `template/` ✓ COMPLETED

## Fase 1 — Duplikasi Kode ✓

- [x] **1a. Merge `getToken()`** — Hapus `api.js:4-6`, import `getToken()` dari `auth.js`
- [x] **1b. Extract `formatNumber()`** — Buat `utils/format.js`, panggil dari `profile.js` & `mediaViewer.js`
- [x] **1c. Extract `createThemeIcon(size)`** — Buat `utils/icons.js`, panggil dari `main.js` & `sidebar.js`
- [x] **1d. Konsolidasi image loading** — profile.js pakai `loadCachedImage` dari `cache.js`, lepas dependensi ke `mediaViewer.js`

## Fase 2 — CSS Cleanup ✓

- [x] **2a. Hapus duplikasi CSS** — `.app-header-actions` merge, `.app-main` hapus dari `sidebar.css`
- [x] **2b. Inline imports / merge CSS** — `components.css` dipertahankan sebagai barrel
- [x] **2c. Variables for login.css** — Tambah `--color-hf-brand*` di `variables.css`, ganti hardcoded `#ffcc4d` dkk
- [x] **2d. Rapihin whitespace** — Extra blank lines di `app.css`, `sidebar.css` dibersihkan
- [x] **2e. Hapus `assets/logo/`** — Folder kosong dihapus

## Fase 3 — mediaViewer.js Refactor ✓

- [x] **3a. Class** — Module-level mutable state dibungkus jadi class `MediaViewer`, singleton instance diexport
- [x] **3b. Extract `ICONS`** — Pindah ke `utils/icons.js` bersama icon helpers
- [x] **3c. Extract helpers** — `formatSize`, `infoLabel`, `statRow`, `createPlaceholderRows`, `populateDescSection` jadi method class

## Fase 4 — Error Handling ✓

- [x] **4a. Minimal logging** — ~15 silent `catch {}` diganti `console.warn` dengan konteks error
- [x] **4b. Cache error logging** — QuotaExceeded di `cache.js` kasih warning

## Fase 5 — Storage Keys Consistency ✓

- [x] **5a. Move to `STORAGE_KEYS`** — `OAUTH_VERIFIER`, `OAUTH_STATE`, `OAUTH_FORCE_CONSENT` daftarkan di `config.js`, pakai dari `oauth.js` & `main.js`

## Fase 6 — Minor Cleanup ✓

- [x] **6a. `main.js:handleRoute`** — Redundansi `^#` strip dihapus, path normalization disederhanakan
- [x] **6b. `store.js:reset()`** — Reset `view`, `users`, `mediaLoading` juga
