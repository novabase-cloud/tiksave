use bytes::Bytes;
use moka::future::Cache;
use parking_lot::Mutex;
use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::broadcast;

#[derive(Clone)]
pub struct CachedMedia {
    pub data: Bytes,
    pub content_type: &'static str,
}

#[derive(Clone)]
pub struct AppState {
    pub client: reqwest::Client,
    pub no_redirect_client: reqwest::Client,
    pub image_cache: Cache<String, CachedMedia>,
    pub preview_inflight: Arc<Mutex<HashMap<String, broadcast::Sender<Result<PathBuf, String>>>>>,
    pub preview_cache_dir: PathBuf,
    pub start_time: Instant,
}

impl AppState {
    pub fn new(preview_cache_dir: PathBuf) -> Self {
        let client = reqwest::Client::builder()
            .pool_idle_timeout(Duration::from_secs(60))
            .tcp_nodelay(true)
            .build()
            .expect("Failed to build HTTP client");

        let no_redirect_client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .pool_idle_timeout(Duration::from_secs(60))
            .tcp_nodelay(true)
            .build()
            .expect("Failed to build no-redirect HTTP client");

        let image_cache = Cache::builder()
            .max_capacity(1000)
            .time_to_live(Duration::from_secs(86400))
            .build();

        if !preview_cache_dir.exists() {
            let _ = fs::create_dir_all(&preview_cache_dir);
        }

        Self {
            client,
            no_redirect_client,
            image_cache,
            preview_inflight: Arc::new(Mutex::new(HashMap::new())),
            preview_cache_dir,
            start_time: Instant::now(),
        }
    }

    pub fn cleanup_preview_cache(&self, max_files: usize) {
        if let Ok(entries) = fs::read_dir(&self.preview_cache_dir) {
            let mut files: Vec<(PathBuf, std::time::SystemTime)> = Vec::new();
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    let mtime = entry
                        .metadata()
                        .and_then(|m| m.modified())
                        .unwrap_or(std::time::UNIX_EPOCH);
                    files.push((path, mtime));
                }
            }

            if files.len() > max_files {
                files.sort_by_key(|f| f.1);
                let to_delete = files.len() - max_files;
                for (path, _) in files.into_iter().take(to_delete) {
                    let _ = fs::remove_file(path);
                }
            }
        }
    }
}
