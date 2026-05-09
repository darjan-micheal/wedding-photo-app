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

pub fn process_incoming_jpeg(
    source_path: &Path,
    pending_dir: &Path,
) -> Result<ProcessedPhoto, String> {
    let id = Uuid::new_v4().to_string();
    let filename = format!("{}.jpg", id);
    let pending_path = pending_dir.join(&filename);

    // 1. THE OS ERROR 32 FIX: The Retry Loop
    // Wait for Windows to finish copying/downloading the file before touching it
    let mut attempts = 0;
    loop {
        match std::fs::File::open(source_path) {
            Ok(_) => break, // Success! The OS has released the lock.
            Err(e) => {
                attempts += 1;
                if attempts >= 15 {
                    // Give up after ~3 seconds so we don't hang the thread forever
                    return Err(format!("File locked by OS for too long: {}", e));
                }
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
        }
    }

    // Check the file size to see if it needs compression
    let initial_size_kb = std::fs::metadata(source_path)
        .map(|m| m.len() / 1024)
        .unwrap_or(0);

    // 2. THE SMALL FILE FIX: The Fast Track
    // If it's already under 300KB, skip the heavy CPU work and just copy it over!
    if initial_size_kb <= 300 {
        std::fs::copy(source_path, &pending_path)
            .map_err(|e| format!("Fast-track copy failed: {}", e))?;

        return Ok(ProcessedPhoto {
            id,
            pending_path,
            filename,
            file_size_kb: initial_size_kb,
        });
    }

    // --- Heavy Processing Path (for files > 300KB) ---
    
    // Load image
    let img = ImageReader::open(source_path)
        .map_err(|e| format!("Failed to open: {}", e))?
        .decode()
        .map_err(|e| format!("Failed to decode: {}", e))?;

    // Resize if wider than 1920px (maintains aspect ratio)
    let img = if img.width() > 1920 {
        img.resize(1920, 1920, image::imageops::FilterType::Lanczos3)
    } else {
        img
    };

    // Compress with mozjpeg at quality 75
    compress_jpeg(&img, &pending_path, 75)?;

    let final_size_kb = std::fs::metadata(&pending_path)
        .map(|m| m.len() / 1024)
        .unwrap_or(0);

    Ok(ProcessedPhoto {
        id,
        pending_path,
        filename,
        file_size_kb: final_size_kb,
    })
}

fn compress_jpeg(
    img: &image::DynamicImage,
    output_path: &Path,
    quality: u8,
) -> Result<(), String> {
    let rgb = img.to_rgb8();
    let mut compress = Compress::new(ColorSpace::JCS_RGB);
    compress.set_scan_optimization_mode(ScanMode::Auto);
    compress.set_quality(quality as f32);
    compress.set_size(img.width() as usize, img.height() as usize);

    let mut comp_started = compress
        .start_compress(Vec::new())
        .map_err(|e| format!("Failed to start compression: {}", e))?;

    // FIX: write_scanlines returns a Result. We handle it with map_err and ?
    comp_started.write_scanlines(rgb.as_raw())
        .map_err(|e| format!("Scanline write failed: {}", e))?;
    
    let data = comp_started
        .finish()
        .map_err(|e| format!("Failed to finish compression: {}", e))?;
        
    std::fs::write(output_path, data)
        .map_err(|e| format!("Failed to write: {}", e))?;
        
    Ok(())
}