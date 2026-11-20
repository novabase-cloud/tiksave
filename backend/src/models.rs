use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
pub struct ResizeQuery {
    pub url: Option<String>,
    pub w: Option<u32>,
    pub q: Option<u8>,
    pub format: Option<String>,
    pub token: Option<String>,
    pub r#type: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct VideoThumbQuery {
    pub url: Option<String>,
    pub w: Option<u32>,
    pub q: Option<u8>,
    pub format: Option<String>,
    pub ss: Option<f32>,
    pub token: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct VideoPreviewQuery {
    pub url: Option<String>,
    pub w: Option<u32>,
    pub dur: Option<f32>,
    pub crf: Option<u8>,
    pub token: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ProxyQuery {
    pub url: Option<String>,
    pub token: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
    pub service: &'static str,
    pub uptime: u64,
    #[serde(rename = "cacheSize")]
    pub cache_size: u64,
    pub timestamp: String,
}

#[derive(Debug, Serialize)]
pub struct RootResponse {
    pub name: &'static str,
    pub status: &'static str,
    pub endpoints: Vec<&'static str>,
}

#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}
