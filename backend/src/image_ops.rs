use image::{
    codecs::jpeg::JpegEncoder, codecs::png::PngEncoder, codecs::webp::WebPEncoder,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageFormatType {
    Webp,
    Jpeg,
    Png,
}

impl ImageFormatType {
    pub fn mime_type(&self) -> &'static str {
        match self {
            ImageFormatType::Webp => "image/webp",
            ImageFormatType::Jpeg => "image/jpeg",
            ImageFormatType::Png => "image/png",
        }
    }
}

pub fn parse_target_format(fmt: Option<&str>) -> ImageFormatType {
    match fmt.map(|s| s.to_ascii_lowercase()).as_deref() {
        Some("jpeg") | Some("jpg") => ImageFormatType::Jpeg,
        Some("png") => ImageFormatType::Png,
        _ => ImageFormatType::Webp,
    }
}

pub fn clamp_width(w: Option<u32>, default: u32, min: u32, max: u32) -> u32 {
    w.unwrap_or(default).clamp(min, max)
}

pub fn clamp_quality(q: Option<u8>, default: u8, min: u8, max: u8) -> u8 {
    q.unwrap_or(default).clamp(min, max)
}

pub fn is_video_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    let path = lower.split('?').next().unwrap_or(&lower);
    path.ends_with(".mp4")
        || path.ends_with(".webm")
        || path.ends_with(".mov")
        || path.ends_with(".m4v")
        || path.ends_with(".mkv")
}

pub fn resize_and_encode_image(
    raw_bytes: &[u8],
    target_width: u32,
    target_quality: u8,
    format: ImageFormatType,
) -> Result<(Vec<u8>, &'static str), String> {
    let img = image::load_from_memory(raw_bytes)
        .map_err(|e| format!("Failed to decode image: {e}"))?;

    let orig_w = img.width();
    let orig_h = img.height();

    let processed = if orig_w > target_width && target_width > 0 {
        let ratio = target_width as f64 / orig_w as f64;
        let target_h = ((orig_h as f64 * ratio).round() as u32).max(1);
        img.resize(target_width, target_h, image::imageops::FilterType::Triangle)
    } else {
        img
    };

    let mut output = Vec::with_capacity(32 * 1024);
    match format {
        ImageFormatType::Webp => {
            let enc = WebPEncoder::new_lossless(&mut output);
            processed
                .write_with_encoder(enc)
                .map_err(|e| format!("WebP encoding error: {e}"))?;
        }
        ImageFormatType::Jpeg => {
            let enc = JpegEncoder::new_with_quality(&mut output, target_quality);
            processed
                .write_with_encoder(enc)
                .map_err(|e| format!("JPEG encoding error: {e}"))?;
        }
        ImageFormatType::Png => {
            let enc = PngEncoder::new(&mut output);
            processed
                .write_with_encoder(enc)
                .map_err(|e| format!("PNG encoding error: {e}"))?;
        }
    }

    Ok((output, format.mime_type()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::DynamicImage;

    #[test]
    fn test_clamp_values() {
        assert_eq!(clamp_width(Some(5), 300, 16, 1920), 16);
        assert_eq!(clamp_width(Some(5000), 300, 16, 1920), 1920);
        assert_eq!(clamp_width(None, 300, 16, 1920), 300);

        assert_eq!(clamp_quality(Some(5), 80, 10, 100), 10);
        assert_eq!(clamp_quality(Some(120), 80, 10, 100), 100);
        assert_eq!(clamp_quality(None, 80, 10, 100), 80);
    }

    #[test]
    fn test_is_video_url() {
        assert!(is_video_url("https://example.com/video.mp4"));
        assert!(is_video_url("https://example.com/video.webm?token=123"));
        assert!(is_video_url("https://example.com/video.mov"));
        assert!(!is_video_url("https://example.com/image.jpg"));
        assert!(!is_video_url("https://example.com/image.webp"));
    }

    #[test]
    fn test_format_parsing() {
        assert_eq!(parse_target_format(Some("jpeg")), ImageFormatType::Jpeg);
        assert_eq!(parse_target_format(Some("JPG")), ImageFormatType::Jpeg);
        assert_eq!(parse_target_format(Some("png")), ImageFormatType::Png);
        assert_eq!(parse_target_format(Some("webp")), ImageFormatType::Webp);
        assert_eq!(parse_target_format(None), ImageFormatType::Webp);
    }

    #[test]
    fn test_resize_and_encode() {
        let dummy = DynamicImage::new_rgb8(200, 100);
        let mut raw_png = Vec::new();
        dummy
            .write_with_encoder(image::codecs::png::PngEncoder::new(&mut raw_png))
            .unwrap();

        let (webp_bytes, mime) =
            resize_and_encode_image(&raw_png, 100, 80, ImageFormatType::Webp).unwrap();
        assert_eq!(mime, "image/webp");
        assert!(!webp_bytes.is_empty());

        let (jpeg_bytes, mime) =
            resize_and_encode_image(&raw_png, 50, 85, ImageFormatType::Jpeg).unwrap();
        assert_eq!(mime, "image/jpeg");
        assert!(!jpeg_bytes.is_empty());

        let (png_bytes, mime) =
            resize_and_encode_image(&raw_png, 100, 80, ImageFormatType::Png).unwrap();
        assert_eq!(mime, "image/png");
        assert!(!png_bytes.is_empty());
    }
}
