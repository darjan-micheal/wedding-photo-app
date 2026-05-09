use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, State};
use std::sync::Mutex;
use rusqlite::Connection;
use crate::commands::sidecar::ServerProcess;
use crate::db;
use crate::commands::event::AppState;

// --- Core File Movement Logic ---

pub fn approve_photo_file(
    filename: &str,
    pending_dir: &Path,
    gallery_dir: &Path,
    server: &ServerProcess,
    app_handle: &AppHandle,
) -> Result<(), String> {
    let from = pending_dir.join(filename);
    let to = gallery_dir.join(filename);

    if !from.exists() { 
        return Err(format!("Not found in pending: {}", filename)); 
    }
    std::fs::rename(&from, &to).map_err(|e| format!("Move failed: {}", e))?;

    let photo_id = Path::new(filename).file_stem().and_then(|s| s.to_str()).unwrap_or(filename);
    
    server.notify_new_photo(photo_id, filename);
    app_handle.emit("photo_approved", filename).ok();
    Ok(())
}

pub fn reject_photo_file(
    filename: &str,
    pending_dir: &Path,
    rejected_dir: &Path,
    app_handle: &AppHandle,
) -> Result<(), String> {
    let from = pending_dir.join(filename);
    let to = rejected_dir.join(filename);

    if !from.exists() { 
        return Err(format!("Not found in pending: {}", filename)); 
    }
    std::fs::rename(&from, &to).map_err(|e| format!("Move failed: {}", e))?;
    
    app_handle.emit("photo_rejected", filename).ok();
    Ok(())
}

// --- Tauri Commands (Now fully wired to SQLite) ---

#[tauri::command]
pub async fn approve_photo(
    filename: String,
    pending_dir: String,
    gallery_dir: String,
    server: State<'_, ServerProcess>,
    db_state: State<'_, Mutex<Connection>>,
    app_handle: AppHandle,
) -> Result<(), String> {
    let conn = db_state.lock().map_err(|_| "DB Lock Failed")?;
    
    let event_id = db::get_active_event(&conn).map_err(|e| e.to_string())?.map(|e| e.id).unwrap_or_else(|| "default_event".to_string());
    if !db::check_photo_limit(&conn, &event_id).unwrap_or(false) {
        return Err("Photo limit reached for this event.".to_string());
    }

    approve_photo_file(&filename, Path::new(&pending_dir), Path::new(&gallery_dir), &server, &app_handle)?;
    
    let photo_id = Path::new(&filename).file_stem().unwrap().to_str().unwrap();
    db::approve_photo(&conn, photo_id).map_err(|e| format!("DB Error: {}", e))?;
    
    Ok(())
}

#[tauri::command]
pub async fn reject_photo(
    filename: String,
    pending_dir: String,
    rejected_dir: String,
    db_state: State<'_, Mutex<Connection>>,
    app_handle: AppHandle,
) -> Result<(), String> {
    let conn = db_state.lock().map_err(|_| "DB Lock Failed")?;
    
    reject_photo_file(&filename, Path::new(&pending_dir), Path::new(&rejected_dir), &app_handle)?;
    
    let photo_id = Path::new(&filename).file_stem().unwrap().to_str().unwrap();
    db::reject_photo(&conn, photo_id).map_err(|e| format!("DB Error: {}", e))?;
    
    Ok(())
}

// Pull pending photos from the SQLite DB instead of the folder
#[tauri::command]
pub async fn get_pending_photos(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let conn = state.db.lock().map_err(|_| "Failed to lock database")?;
    
    // 1. Fetch all pending photos from the database
    let mut stmt = conn.prepare("SELECT id, filename FROM photos WHERE status = 'pending'")
        .map_err(|e| e.to_string())?;
    
    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
    
    let mut valid_photos = Vec::new();
    let mut missing_ids = Vec::new();
    
    // Dynamically calculate paths
    let current_dir = std::env::current_dir().unwrap_or_default();
    let root_dir = current_dir.parent().unwrap_or(&current_dir);
    let pending_dir = root_dir.join("weddingsnap-data/incoming_pending");

    // 2. Cross-reference DB with physical files
    while let Some(row) = rows.next().unwrap_or(None) {
        let photo_id: String = row.get(0).unwrap_or_default();
        let filename: String = row.get(1).unwrap_or_default();
        
        let file_path = pending_dir.join(&filename);
        
        if file_path.exists() {
            valid_photos.push(filename);
        } else {
            missing_ids.push(photo_id);
        }
    }
    
    drop(rows); // Close the read query so we can write

    // 3. Auto-clean ghost entries from SQLite
    for id in missing_ids {
        conn.execute("DELETE FROM photos WHERE id = ?1", [&id]).ok();
        println!("Pruned ghost photo ID: {} from database", id);
    }

    Ok(valid_photos)
}

// Fetch the live stats from SQLite
#[tauri::command]
pub async fn get_event_stats(
    db_state: State<'_, Mutex<Connection>>,
) -> Result<crate::db::EventStats, String> {
    let conn = db_state.lock().map_err(|_| "DB Lock Failed")?;
    let event_id = db::get_active_event(&conn).map_err(|e| e.to_string())?.map(|e| e.id).unwrap_or_else(|| "default_event".to_string());
        
    db::get_event_stats(&conn, &event_id).map_err(|e| format!("DB Error: {}", e))
}

#[tauri::command]
pub async fn approve_all_pending(
    pending_dir: String,
    gallery_dir: String,
    server: State<'_, ServerProcess>,
    db_state: State<'_, Mutex<Connection>>,
    app_handle: AppHandle,
) -> Result<(), String> {
    let conn = db_state.lock().map_err(|_| "DB Lock Failed")?;
    let event_id = db::get_active_event(&conn).map_err(|e| e.to_string())?.map(|e| e.id).unwrap_or_else(|| "default_event".to_string());
    
    let p_dir = Path::new(&pending_dir);
    let g_dir = Path::new(&gallery_dir);
    
    if let Ok(photos) = db::get_pending_photos(&conn, &event_id) {
        for photo in photos {
            if approve_photo_file(&photo.filename, p_dir, g_dir, &server, &app_handle).is_ok() {
                 let photo_id = Path::new(&photo.filename).file_stem().unwrap().to_str().unwrap();
                 let _ = db::approve_photo(&conn, photo_id);
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn read_image_file(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&path).map_err(|e| format!("Failed to read file: {}", e))
}