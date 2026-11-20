use crate::{
    cache::{AppState, CachedMedia},
    ffmpeg_ops::{extract_video_frame, transcode_video_preview},
    image_ops::{
        clamp_quality, clamp_width, is_video_url, parse_target_format, resize_and_encode_image,
    },
    models::{
        ErrorResponse, HealthResponse, ProxyQuery, ResizeQuery, RootResponse, VideoPreviewQuery,
        VideoThumbQuery,
    },
};
use axum::{
    body::Body,
    extract::{Query, State},
    http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use bytes::Bytes;
use md5::Digest;
use std::sync::Arc;
use tokio::sync::broadcast;
use tokio_util::io::ReaderStream;

const CACHE_CONTROL_HEADER: &str =
    "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400";

fn extract_token(query_token: Option<&str>, headers: &HeaderMap) -> Option<String> {
    if let Some(t) = query_token {
        if !t.trim().is_empty() {
            return Some(t.trim().to_string());
        }
    }
    if let Some(auth) = headers.get(header::AUTHORIZATION) {
        if let Ok(val) = auth.to_str() {
            let val = val.trim();
            if let Some(stripped) = val.strip_prefix("Bearer ") {
                return Some(stripped.trim().to_string());
            } else if let Some(stripped) = val.strip_prefix("bearer ") {
                return Some(stripped.trim().to_string());
            } else {
                return Some(val.to_string());
            }
        }
    }
    None
}

pub async fn resolve_direct_media_url(
    client: &reqwest::Client,
    raw_url: &str,
    auth_token: Option<&str>,
) -> String {
    let mut current_url = raw_url
        .replace("api-tiksave.mailtestvartext.workers.dev", "huggingface.co")
        .replace("/proxy/", "/");

    let mut token = auth_token.map(|s| s.to_string());
    if let Some(q_idx) = current_url.find("?token=") {
        if token.is_none() {
            token = Some(
                current_url[q_idx + 7..]
                    .split('&')
                    .next()
                    .unwrap_or("")
                    .to_string(),
            );
        }
        current_url.truncate(q_idx);
    }

    let mut req = client.get(&current_url).header(
        header::USER_AGENT,
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    );

    if let Some(ref t) = token {
        if !t.is_empty() {
            req = req.header(header::AUTHORIZATION, format!("Bearer {}", t));
        }
    }

    if let Ok(resp) = req.send().await {
        if resp.status().is_redirection() {
            if let Some(loc) = resp.headers().get(header::LOCATION) {
                if let Ok(loc_str) = loc.to_str() {
                    return loc_str.to_string();
                }
            }
        }
    }

    current_url
}

pub async fn root() -> Json<RootResponse> {
    Json(RootResponse {
        name: "tiksave-backend-runner",
        status: "running",
        endpoints: vec![
            "/health",
            "/api/resize",
            "/api/video-thumb",
            "/api/video-preview",
            "/api/proxy",
        ],
    })
}

pub async fn health(State(state): State<Arc<AppState>>) -> Json<HealthResponse> {
    let now = chrono::Utc::now();
    Json(HealthResponse {
        status: "ok",
        service: "tiksave-backend",
        uptime: state.start_time.elapsed().as_secs(),
        cache_size: state.image_cache.entry_count(),
        timestamp: now.to_rfc3339(),
    })
}

pub async fn handle_video_thumb_internal(
    state: Arc<AppState>,
    url: String,
    w: Option<u32>,
    q: Option<u8>,
    format_opt: Option<String>,
    ss_opt: Option<f32>,
    token: Option<String>,
) -> Response {
    let target_w = clamp_width(w, 300, 16, 1920);
    let target_q = clamp_quality(q, 80, 10, 100);
    let target_format = parse_target_format(format_opt.as_deref());
    let timestamp = ss_opt.unwrap_or(0.5);

    let cache_key = format!(
        "vthumb::{}::w{}::q{}::{:?}::t{:.3}",
        url, target_w, target_q, target_format, timestamp
    );

    if let Some(cached) = state.image_cache.get(&cache_key).await {
        return (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, cached.content_type),
                (header::CACHE_CONTROL, CACHE_CONTROL_HEADER),
                (HeaderName::from_static("x-cache"), "HIT"),
            ],
            cached.data,
        )
            .into_response();
    }

    let direct_url =
        resolve_direct_media_url(&state.no_redirect_client, &url, token.as_deref()).await;

    let raw_frame = match extract_video_frame(&direct_url, timestamp).await {
        Ok(b) => b,
        Err(e) => {
            tracing::error!("Video thumbnail extraction failed for {}: {}", url, e);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: "Video thumbnail extraction failed".to_string(),
                    message: Some(e),
                }),
            )
                .into_response();
        }
    };

    let (output_bytes, content_type) =
        match resize_and_encode_image(&raw_frame, target_w, target_q, target_format) {
            Ok(res) => res,
            Err(e) => {
                tracing::error!("Image processing failed for {}: {}", url, e);
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse {
                        error: "Image processing failed".to_string(),
                        message: Some(e),
                    }),
                )
                    .into_response();
            }
        };

    let data = Bytes::from(output_bytes);
    state
        .image_cache
        .insert(
            cache_key,
            CachedMedia {
                data: data.clone(),
                content_type,
            },
        )
        .await;

    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, content_type),
            (header::CACHE_CONTROL, CACHE_CONTROL_HEADER),
            (HeaderName::from_static("x-cache"), "MISS"),
        ],
        data,
    )
        .into_response()
}

pub async fn resize(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<ResizeQuery>,
) -> Response {
    let url = match query.url {
        Some(u) if !u.trim().is_empty() => u.trim().to_string(),
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: "Missing 'url' query parameter".to_string(),
                    message: None,
                }),
            )
                .into_response();
        }
    };

    let token = extract_token(query.token.as_deref(), &headers);

    let is_video = is_video_url(&url) || query.r#type.as_deref() == Some("video");
    if is_video {
        return handle_video_thumb_internal(
            state,
            url,
            query.w,
            query.q,
            query.format,
            None,
            token,
        )
        .await;
    }

    let target_w = clamp_width(query.w, 300, 16, 1920);
    let target_q = clamp_quality(query.q, 80, 10, 100);
    let target_format = parse_target_format(query.format.as_deref());

    let cache_key = format!("{}::w{}::q{}::{:?}", url, target_w, target_q, target_format);

    if let Some(cached) = state.image_cache.get(&cache_key).await {
        return (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, cached.content_type),
                (header::CACHE_CONTROL, CACHE_CONTROL_HEADER),
                (HeaderName::from_static("x-cache"), "HIT"),
            ],
            cached.data,
        )
            .into_response();
    }

    let direct_url =
        resolve_direct_media_url(&state.no_redirect_client, &url, token.as_deref()).await;

    let mut req = state.client.get(&direct_url).header(
        header::USER_AGENT,
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    );

    if direct_url.starts_with("https://huggingface.co") {
        if let Some(ref t) = token {
            req = req.header(header::AUTHORIZATION, format!("Bearer {}", t));
        }
    }

    let upstream = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(ErrorResponse {
                    error: "Upstream fetch failed".to_string(),
                    message: Some(e.to_string()),
                }),
            )
                .into_response();
        }
    };

    if !upstream.status().is_success() {
        let status = StatusCode::from_u16(upstream.status().as_u16())
            .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        return (
            status,
            Json(ErrorResponse {
                error: format!("Upstream fetch returned status {}", upstream.status()),
                message: Some(url),
            }),
        )
            .into_response();
    }

    let input_bytes = match upstream.bytes().await {
        Ok(b) => b,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(ErrorResponse {
                    error: "Failed to read upstream body".to_string(),
                    message: Some(e.to_string()),
                }),
            )
                .into_response();
        }
    };

    let (output_bytes, content_type) =
        match resize_and_encode_image(&input_bytes, target_w, target_q, target_format) {
            Ok(res) => res,
            Err(e) => {
                tracing::error!("Image processing failed for {}: {}", url, e);
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse {
                        error: "Image processing failed".to_string(),
                        message: Some(e),
                    }),
                )
                    .into_response();
            }
        };

    let data = Bytes::from(output_bytes);
    state
        .image_cache
        .insert(
            cache_key,
            CachedMedia {
                data: data.clone(),
                content_type,
            },
        )
        .await;

    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, content_type),
            (header::CACHE_CONTROL, CACHE_CONTROL_HEADER),
            (HeaderName::from_static("x-cache"), "MISS"),
        ],
        data,
    )
        .into_response()
}

pub async fn video_thumb(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<VideoThumbQuery>,
) -> Response {
    let url = match query.url {
        Some(u) if !u.trim().is_empty() => u.trim().to_string(),
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: "Missing 'url' query parameter".to_string(),
                    message: None,
                }),
            )
                .into_response();
        }
    };

    let token = extract_token(query.token.as_deref(), &headers);

    handle_video_thumb_internal(
        state,
        url,
        query.w,
        query.q,
        query.format,
        query.ss,
        token,
    )
    .await
}

pub async fn video_preview(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<VideoPreviewQuery>,
) -> Response {
    let url = match query.url {
        Some(u) if !u.trim().is_empty() => u.trim().to_string(),
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: "Missing 'url' query parameter".to_string(),
                    message: None,
                }),
            )
                .into_response();
        }
    };

    let token = extract_token(query.token.as_deref(), &headers);
    let target_w = clamp_width(query.w, 320, 120, 720);
    let target_dur = query.dur.unwrap_or(4.0).clamp(1.5, 10.0);
    let target_crf = query.crf.unwrap_or(32).clamp(22, 40);

    let cache_key = format!(
        "vprev::{}::w{}::d{:.2}::c{}",
        url, target_w, target_dur, target_crf
    );
    let mut hasher = md5::Md5::new();
    hasher.update(cache_key.as_bytes());
    let hash = hex::encode(hasher.finalize());
    let cache_file_path = state
        .preview_cache_dir
        .join(format!("preview_{}.mp4", hash));

    if cache_file_path.exists() {
        if let Ok(meta) = tokio::fs::metadata(&cache_file_path).await {
            if meta.len() > 500 {
                if let Ok(file) = tokio::fs::File::open(&cache_file_path).await {
                    let stream = ReaderStream::new(file);
                    let body = Body::from_stream(stream);
                    return (
                        StatusCode::OK,
                        [
                            (header::CONTENT_TYPE, "video/mp4"),
                            (header::CACHE_CONTROL, CACHE_CONTROL_HEADER),
                            (HeaderName::from_static("x-cache"), "HIT"),
                        ],
                        body,
                    )
                        .into_response();
                }
            }
        }
    }

    let rx_opt = {
        let mut inflight = state.preview_inflight.lock();
        if let Some(tx) = inflight.get(&cache_key) {
            Some(tx.subscribe())
        } else {
            let (tx, _rx) = broadcast::channel(1);
            inflight.insert(cache_key.clone(), tx);
            None
        }
    };

    let final_path = if let Some(mut rx) = rx_opt {
        match rx.recv().await {
            Ok(Ok(p)) => p,
            Ok(Err(e)) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse {
                        error: "Video preview transcoding failed".to_string(),
                        message: Some(e),
                    }),
                )
                    .into_response();
            }
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse {
                        error: "In-flight video preview wait failed".to_string(),
                        message: Some(e.to_string()),
                    }),
                )
                    .into_response();
            }
        }
    } else {
        let direct_url =
            resolve_direct_media_url(&state.no_redirect_client, &url, token.as_deref()).await;

        let result = transcode_video_preview(
            &direct_url,
            target_w,
            target_dur,
            target_crf,
            &cache_file_path,
        )
        .await;

        let outcome = match result {
            Ok(()) => Ok(cache_file_path.clone()),
            Err(err) => Err(err),
        };

        {
            let mut inflight = state.preview_inflight.lock();
            if let Some(tx) = inflight.remove(&cache_key) {
                let _ = tx.send(outcome.clone());
            }
        }

        state.cleanup_preview_cache(300);

        match outcome {
            Ok(p) => p,
            Err(e) => {
                tracing::error!("Video preview transcoding failed for {}: {}", url, e);
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse {
                        error: "Video preview transcoding failed".to_string(),
                        message: Some(e),
                    }),
                )
                    .into_response();
            }
        }
    };

    match tokio::fs::File::open(&final_path).await {
        Ok(file) => {
            let stream = ReaderStream::new(file);
            let body = Body::from_stream(stream);
            (
                StatusCode::OK,
                [
                    (header::CONTENT_TYPE, "video/mp4"),
                    (header::CACHE_CONTROL, CACHE_CONTROL_HEADER),
                    (HeaderName::from_static("x-cache"), "MISS"),
                ],
                body,
            )
                .into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: "Failed to open transcoded preview file".to_string(),
                message: Some(e.to_string()),
            }),
        )
            .into_response(),
    }
}

pub async fn proxy(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<ProxyQuery>,
) -> Response {
    let url = match query.url {
        Some(u) if !u.trim().is_empty() => u.trim().to_string(),
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: "Missing 'url' query parameter".to_string(),
                    message: None,
                }),
            )
                .into_response();
        }
    };

    let token = extract_token(query.token.as_deref(), &headers);

    let mut req = state.client.get(&url).header(
        header::USER_AGENT,
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    );

    if let Some(ref t) = token {
        req = req.header(header::AUTHORIZATION, format!("Bearer {}", t));
    }

    let upstream = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(ErrorResponse {
                    error: "Proxy upstream request failed".to_string(),
                    message: Some(e.to_string()),
                }),
            )
                .into_response();
        }
    };

    let status = StatusCode::from_u16(upstream.status().as_u16())
        .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);

    let mut resp_headers = HeaderMap::new();
    let pass_headers = [
        header::CONTENT_TYPE,
        header::CONTENT_LENGTH,
        header::ETAG,
        header::LAST_MODIFIED,
    ];

    for h in pass_headers {
        if let Some(val) = upstream.headers().get(&h) {
            resp_headers.insert(h, val.clone());
        }
    }

    resp_headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=86400"),
    );

    let body = Body::from_stream(upstream.bytes_stream());

    (status, resp_headers, body).into_response()
}
