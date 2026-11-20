use std::{path::Path, process::Stdio, time::Duration};
use tokio::{io::AsyncReadExt, process::Command, time::timeout};

pub async fn run_ffmpeg_extract(stream_url: &str, timestamp: f32) -> Result<Vec<u8>, String> {
    let mut cmd = Command::new("ffmpeg");
    cmd.args([
        "-ss",
        &format!("{:.3}", timestamp),
        "-i",
        stream_url,
        "-vframes",
        "1",
        "-f",
        "image2pipe",
        "-vcodec",
        "mjpeg",
        "-q:v",
        "3",
        "-",
    ])
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn ffmpeg: {e}"))?;

    let stdout = child.stdout.take().ok_or("Failed to open ffmpeg stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to open ffmpeg stderr")?;

    let read_task = async move {
        let mut buf = Vec::new();
        let mut stdout_reader = stdout;
        stdout_reader.read_to_end(&mut buf).await?;
        Ok::<Vec<u8>, std::io::Error>(buf)
    };

    let stderr_task = async move {
        let mut err_buf = Vec::new();
        let mut stderr_reader = stderr;
        let _ = stderr_reader.read_to_end(&mut err_buf).await;
        err_buf
    };

    let res = timeout(Duration::from_secs(15), async {
        let (out_res, err_bytes) = tokio::join!(read_task, stderr_task);
        let status = child.wait().await.map_err(|e| e.to_string())?;
        let bytes = out_res.map_err(|e| e.to_string())?;
        if status.success() && !bytes.is_empty() {
            Ok(bytes)
        } else {
            let err_msg = String::from_utf8_lossy(&err_bytes);
            Err(format!("FFmpeg exited with {status}: {err_msg}"))
        }
    })
    .await;

    match res {
        Ok(Ok(bytes)) => Ok(bytes),
        Ok(Err(e)) => Err(e),
        Err(_) => {
            let _ = child.kill().await;
            Err("FFmpeg frame extraction timed out after 15s".to_string())
        }
    }
}

pub async fn extract_video_frame(stream_url: &str, timestamp: f32) -> Result<Vec<u8>, String> {
    match run_ffmpeg_extract(stream_url, timestamp).await {
        Ok(bytes) => Ok(bytes),
        Err(e) => {
            if timestamp != 0.0 {
                tracing::warn!(
                    "FFmpeg timestamp {} failed ({}), retrying at frame 0s...",
                    timestamp,
                    e
                );
                run_ffmpeg_extract(stream_url, 0.0).await
            } else {
                Err(e)
            }
        }
    }
}

pub async fn transcode_video_preview(
    stream_url: &str,
    target_width: u32,
    dur: f32,
    crf: u8,
    output_path: &Path,
) -> Result<(), String> {
    let temp_path = output_path.with_extension(format!(
        "tmp.{}.{}.mp4",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));

    let vf_scale = format!("scale=min({}\\,iw):-2", target_width);

    let mut cmd = Command::new("ffmpeg");
    cmd.args([
        "-ss",
        "0",
        "-t",
        &format!("{:.2}", dur),
        "-i",
        stream_url,
        "-vf",
        &vf_scale,
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        &crf.to_string(),
        "-pix_fmt",
        "yuv420p",
        "-an",
        "-movflags",
        "+faststart",
        "-y",
    ])
    .arg(&temp_path)
    .stdout(Stdio::null())
    .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn ffmpeg: {e}"))?;

    let stderr = child.stderr.take();

    let res = timeout(Duration::from_secs(25), async {
        let err_bytes = if let Some(mut err_reader) = stderr {
            let mut err_buf = Vec::new();
            let _ = err_reader.read_to_end(&mut err_buf).await;
            err_buf
        } else {
            Vec::new()
        };

        let status = child.wait().await.map_err(|e| e.to_string())?;
        if status.success() && temp_path.exists() {
            let meta = tokio::fs::metadata(&temp_path).await.map_err(|e| e.to_string())?;
            if meta.len() > 500 {
                tokio::fs::rename(&temp_path, output_path)
                    .await
                    .map_err(|e| e.to_string())?;
                return Ok(());
            }
        }

        let _ = tokio::fs::remove_file(&temp_path).await;
        let err_msg = String::from_utf8_lossy(&err_bytes);
        Err(format!("FFmpeg preview failed with {status}: {err_msg}"))
    })
    .await;

    match res {
        Ok(r) => r,
        Err(_) => {
            let _ = child.kill().await;
            let _ = tokio::fs::remove_file(&temp_path).await;
            Err("FFmpeg preview transcoding timed out after 25s".to_string())
        }
    }
}
