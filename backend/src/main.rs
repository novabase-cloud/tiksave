mod cache;
mod ffmpeg_ops;
mod handlers;
mod image_ops;
mod models;

use axum::{routing::get, Router};
use std::{env, net::SocketAddr, sync::Arc};
use tower_http::cors::{AllowHeaders, AllowMethods, AllowOrigin, CorsLayer};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,tiksave_backend=debug".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let port: u16 = env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3000);

    let preview_dir = env::temp_dir().join("tiksave-preview-cache");
    let state = Arc::new(cache::AppState::new(preview_dir));

    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::any())
        .allow_methods(AllowMethods::any())
        .allow_headers(AllowHeaders::any())
        .max_age(std::time::Duration::from_secs(86400));

    let app = Router::new()
        .route("/", get(handlers::root))
        .route("/health", get(handlers::health))
        .route("/api/resize", get(handlers::resize))
        .route("/api/video-thumb", get(handlers::video_thumb))
        .route("/api/video-preview", get(handlers::video_preview))
        .route("/api/proxy", get(handlers::proxy))
        .layer(cors)
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    tracing::info!("🚀 TikSave Ultra-Fast Rust Backend listening on http://{}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
