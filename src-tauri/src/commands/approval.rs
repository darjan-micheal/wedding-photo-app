use crate::commands::event::AppState;
use crate::commands::sidecar::ServerProcess;
use crate::db;
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

// --- Core File Movement Logic ---

pub fn approve_photo_file(
    filename: &str,
    source_dir: &Path, // <--- DYNAMIC ROUTING
    gallery_dir: &Path,
    server: &ServerProcess,
    app_handle: &AppHandle,
) -> Result<(), String> {
    let from = source_dir.join(filename);
    let to = gallery_dir.join(filename);

    if !from.exists() {
        return Err(format!("Not found in source: {}", filename));
    }
    std::fs::rename(&from, &to).map_err(|e| format!("Move failed: {}", e))?;

    let photo_id = Path::new(filename)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(filename);

    server.notify_new_photo(photo_id, filename);
    app_handle.emit("photo_approved", filename).ok();
    Ok(())
}

pub fn reject_photo_file(
    filename: &str,
    source_dir: &Path, 
    rejected_dir: &Path,
    server: &ServerProcess, // <--- INJECT THE SERVER
    app_handle: &AppHandle,
) -> Result<(), String> {
    let from = source_dir.join(filename);
    let to = rejected_dir.join(filename);

    if !from.exists() {
        return Err(format!("Not found in source: {}", filename));
    }
    std::fs::rename(&from, &to).map_err(|e| format!("Move failed: {}", e))?;

    server.notify_removed_photo(filename); // <--- TELL GUESTS TO HIDE IT INSTANTLY
    app_handle.emit("photo_rejected", filename).ok();
    Ok(())
}

// --- Tauri Commands (Now fully wired to SQLite) ---

#[tauri::command]
pub async fn approve_photo(
    filename: String,
    source_dir: String, 
    gallery_dir: String,
    state: State<'_, AppState>, // <--- THE FIX: Pull the Master State!
    app_handle: AppHandle,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "DB Lock Failed")?;

    let event_id = crate::db::get_active_event(&conn)
        .map_err(|e| e.to_string())?
        .map(|e| e.id)
        .unwrap_or_else(|| "default_event".to_string());
        
    if !crate::db::check_photo_limit(&conn, &event_id).unwrap_or(false) {
        return Err("Photo limit reached for this event.".to_string());
    }

    // THE FIX: Extract the actively running Node Sidecar from AppState!
    let server_guard = state.server.lock().unwrap();
    let server = server_guard.as_ref().ok_or("Server is not running")?;

    approve_photo_file(
        &filename,
        Path::new(&source_dir),
        Path::new(&gallery_dir),
        server,
        &app_handle,
    )?;

    crate::db::approve_photo(&conn, &filename).map_err(|e| format!("DB Error: {}", e))?;

    Ok(())
}
#[tauri::command]
pub async fn reject_photo(
    filename: String,
    source_dir: String, 
    rejected_dir: String,
    state: State<'_, AppState>, // <--- THE FIX
    app_handle: AppHandle,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "DB Lock Failed")?;

    // THE FIX: Extract the actively running Node Sidecar!
    let server_guard = state.server.lock().unwrap();
    let server = server_guard.as_ref().ok_or("Server is not running")?;

    reject_photo_file(
        &filename,
        Path::new(&source_dir),
        Path::new(&rejected_dir),
        server, 
        &app_handle,
    )?;

    crate::db::reject_photo(&conn, &filename).map_err(|e| format!("DB Error: {}", e))?;

    Ok(())
}

// Pull pending photos from the SQLite DB instead of the folder
// --- Dynamic SSD Fetchers & Cache Cleaners ---

#[tauri::command]
pub async fn get_pending_photos(target_dir: String, state: State<'_, AppState>) -> Result<Vec<String>, String> {
    fetch_photos_by_status(&target_dir, &state, "pending")
}

#[tauri::command]
pub async fn get_approved_photos(target_dir: String, state: State<'_, AppState>) -> Result<Vec<String>, String> {
    fetch_photos_by_status(&target_dir, &state, "approved")
}

#[tauri::command]
pub async fn get_rejected_photos(target_dir: String, state: State<'_, AppState>) -> Result<Vec<String>, String> {
    fetch_photos_by_status(&target_dir, &state, "rejected")
}

// Reusable macro to fetch data and verify the file physically exists on the chosen SSD
fn fetch_photos_by_status(target_dir: &str, state: &State<'_, AppState>, status: &str) -> Result<Vec<String>, String> {
    let conn = state.db.lock().map_err(|_| "Failed to lock database")?;
    let event_id = db::get_active_event(&conn).map_err(|e| e.to_string())?.map(|e| e.id).unwrap_or_default();
    
    let photos = match status {
        "pending" => db::get_pending_photos(&conn, &event_id).unwrap_or_default(),
        "approved" => db::get_approved_photos(&conn, &event_id).unwrap_or_default(),
        "rejected" => db::get_rejected_photos(&conn, &event_id).unwrap_or_default(),
        _ => vec![],
    };

    let target_path = Path::new(target_dir);
    let mut valid_photos = Vec::new();
    
    for photo in photos {
        if target_path.join(&photo.filename).exists() {
            valid_photos.push(photo.filename);
        } else {
            // Instantly delete ghost files from the SQLite database
            conn.execute("DELETE FROM photos WHERE id = ?1", [&photo.id]).ok();
        }
    }
    Ok(valid_photos)
}

// Fetch the live stats from SQLite
#[tauri::command]
pub async fn get_event_stats(
    state: State<'_, AppState>, // <--- THE FIX
) -> Result<crate::db::EventStats, String> {
    let conn = state.db.lock().map_err(|_| "DB Lock Failed")?;
    let event_id = crate::db::get_active_event(&conn)
        .map_err(|e| e.to_string())?
        .map(|e| e.id)
        .unwrap_or_else(|| "default_event".to_string());

    crate::db::get_event_stats(&conn, &event_id).map_err(|e| format!("DB Error: {}", e))
}

#[tauri::command]
pub async fn approve_all_pending(
    pending_dir: String,
    gallery_dir: String,
    state: State<'_, AppState>, // <--- THE FIX
    app_handle: AppHandle,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "DB Lock Failed")?;
    let event_id = crate::db::get_active_event(&conn)
        .map_err(|e| e.to_string())?
        .map(|e| e.id)
        .unwrap_or_else(|| "default_event".to_string());

    let p_dir = Path::new(&pending_dir);
    let g_dir = Path::new(&gallery_dir);

    // THE FIX: Extract the actively running Node Sidecar!
    let server_guard = state.server.lock().unwrap();
    let server = server_guard.as_ref().ok_or("Server is not running")?;

    if let Ok(photos) = crate::db::get_pending_photos(&conn, &event_id) {
        for photo in photos {
            if approve_photo_file(&photo.filename, p_dir, g_dir, server, &app_handle).is_ok() {
                let _ = crate::db::approve_photo(&conn, &photo.filename);
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn read_image_file(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&path).map_err(|e| format!("Failed to read file: {}", e))
}
