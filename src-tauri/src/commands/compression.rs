use image::ImageReader;
use mozjpeg::{ColorSpace, Compress, ScanMode};
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub struct ProcessedPhoto {
    pub id: String,
    pub pending_path: PathBuf, // Saved in incoming_pending/ awaiting approval
    pub filename: String,
    pub file_size_kb: u64,
}

pub async fn process_incoming_jpeg(
    source_path: &Path,
    pending_dir: &Path,
    quality_setting: &str,
    semaphore: std::sync::Arc<tokio::sync::Semaphore>, // NEW: Accept the 5-thread limit
) -> Result<ProcessedPhoto, String> {
    let id = Uuid::new_v4().to_string();
    let filename = format!("{}.jpg", id);
    let pending_path = pending_dir.join(&filename);

    // 1. THE OS ERROR 32 FIX (Now Async to save CPU!)
    let mut attempts = 0;
    loop {
        match std::fs::File::open(source_path) {
            Ok(_) => break,
            Err(e) => {
                attempts += 1;
                if attempts >= 15 { return Err(format!("File locked by OS for too long: {}", e)); }
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
        }
    }

    let initial_size_kb = std::fs::metadata(source_path).map(|m| m.len() / 1024).unwrap_or(0);

    // 2. THE SMALL FILE BYPASS (Instantly skips the 5-thread queue!)
    if initial_size_kb <= 300 {
        std::fs::copy(source_path, &pending_path).map_err(|e| format!("Fast-track copy failed: {}", e))?;
        return Ok(ProcessedPhoto { id, pending_path, filename, file_size_kb: initial_size_kb });
    }

    // 3. THE HEAVY QUEUE (Waits for a permit, max 5 at once)
    let _permit = semaphore.acquire().await.map_err(|e| e.to_string())?;

    let source_path_buf = source_path.to_path_buf();
    let pending_path_clone = pending_path.clone();
    let quality_str = quality_setting.to_string();

    // 4. THE THREAD POOL (Spins up a background worker so we don't crash the main runtime)
    let final_size_kb = tokio::task::spawn_blocking(move || {
        let (max_width, jpeg_quality) = match quality_str.as_str() {
            "speed" => (1280, 60),
            "quality" => (2560, 90),
            _ => (1920, 75),
        };

        let img = ImageReader::open(&source_path_buf).map_err(|e| format!("Failed to open: {}", e))?
            .decode().map_err(|e| format!("Failed to decode: {}", e))?;

        let img = if img.width() > max_width {
            img.resize(max_width, max_width, image::imageops::FilterType::Lanczos3)
        } else { img };

        compress_jpeg(&img, &pending_path_clone, jpeg_quality)?;

        let size = std::fs::metadata(&pending_path_clone).map(|m| m.len() / 1024).unwrap_or(0);
        Ok::<u64, String>(size)
    }).await.map_err(|e| format!("Thread panic: {}", e))??;

    Ok(ProcessedPhoto { id, pending_path, filename, file_size_kb: final_size_kb })
}

fn compress_jpeg(img: &image::DynamicImage, output_path: &Path, quality: u8) -> Result<(), String> {
    let rgb = img.to_rgb8();
    let mut compress = Compress::new(ColorSpace::JCS_RGB);
    compress.set_scan_optimization_mode(ScanMode::Auto);
    compress.set_quality(quality as f32);
    compress.set_size(img.width() as usize, img.height() as usize);

    let mut comp_started = compress
        .start_compress(Vec::new())
        .map_err(|e| format!("Failed to start compression: {}", e))?;

    // FIX: write_scanlines returns a Result. We handle it with map_err and ?
    comp_started
        .write_scanlines(rgb.as_raw())
        .map_err(|e| format!("Scanline write failed: {}", e))?;

    let data = comp_started
        .finish()
        .map_err(|e| format!("Failed to finish compression: {}", e))?;

    std::fs::write(output_path, data).map_err(|e| format!("Failed to write: {}", e))?;

    Ok(())
}
