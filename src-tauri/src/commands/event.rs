use tauri::{AppHandle, Emitter}; 
use serde::Serialize;
use std::sync::{Arc, Mutex};
use rusqlite::Connection;

// --- AppState Definition ---
pub struct AppState {
    pub db: Arc<Mutex<Connection>>,
    pub server: Arc<Mutex<Option<crate::commands::sidecar::ServerProcess>>>,
    pub watcher: Arc<Mutex<Option<crate::commands::watcher::FolderWatcher>>>,
    pub active_event_id: Arc<Mutex<Option<String>>>,
    pub active_license_key: Arc<Mutex<Option<String>>>,
}

#[derive(Serialize)]
pub struct StartEventResult {
    pub event_id: String,
    pub server_url: String,
    pub event_name: String,
}

#[derive(Serialize)]
pub struct EventReport {
    pub event_name: String,
    pub duration_minutes: i64,
    pub photos_approved: i32,
    pub photos_rejected: i32,
    pub total_downloads: i32,
    pub archive_path: String,
}

#[tauri::command]
pub async fn start_event(
    event_name: String, 
    license_key: String, 
    photo_limit: Option<i32>,
    state: tauri::State<'_, AppState>, 
    app_handle: AppHandle,
) -> Result<StartEventResult, String> {
    // 1. Validate license key
    let key_info = crate::commands::license::validate_key(license_key.clone()).await?;
    
    // FIX 1: Removed the forced unwrap so it remains an Option<i32> for the database!
    let effective_limit = photo_limit.or(key_info.photo_limit);

    // 2. Check firewall 
    crate::commands::network::ensure_firewall_rule().ok();

    // 3. Create event in SQLite
    let conn = state.db.lock().unwrap();
    let event_id = crate::db::create_event(&conn, &event_name, &license_key, effective_limit)
        .map_err(|e| format!("DB Error: {}", e))?;
    drop(conn);

    // 4. Start Fastify sidecar
    let current_dir = std::env::current_dir().unwrap_or_default();
    let root_dir = current_dir.parent().unwrap_or(&current_dir).to_path_buf(); // FIX: Make owned PathBuf
    
    let gallery_path = root_dir.join("weddingsnap-data/gallery/compressed").to_string_lossy().to_string();
    let guest_app_path = root_dir.join("weddingsnap-data/guest-app").to_string_lossy().to_string();

    let server = crate::commands::sidecar::ServerProcess::new();
    server.start(
        &app_handle,
        &gallery_path, 
        &guest_app_path
    ).map_err(|e| format!("Server Error: {}", e))?;
    *state.server.lock().unwrap() = Some(server);

    // 5. Start folder watcher (WITH COMPRESSION ENGINE!)
    let app_handle_clone = app_handle.clone();
    let current_dir = std::env::current_dir().unwrap_or_default();
    let root_dir = current_dir.parent().unwrap_or(&current_dir).to_path_buf(); // FIX: Make owned PathBuf
    let incoming_path = root_dir.join("weddingsnap-data/incoming");
    let pending_dir = root_dir.join("weddingsnap-data/incoming_pending");

    let db_state = Arc::clone(&state.db);
    let event_id_state = Arc::clone(&state.active_event_id);
    let thread_root_dir = root_dir.clone(); // FIX: Clone the path specifically for the thread!

    let watcher = crate::commands::watcher::FolderWatcher::start(
        incoming_path,
        move |path| {
            if !path.exists() { return; }
            
            // Process JPEGs, reject everything else
            if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                if !matches!(ext.to_lowercase().as_str(), "jpg" | "jpeg") {
                    let rejected_path = thread_root_dir.join("weddingsnap-data/rejected").join(path.file_name().unwrap());
                    std::fs::rename(&path, &rejected_path).ok();
                    return; 
                }
            } else { return; }

            let thread_pending = pending_dir.clone();
            let thread_handle = app_handle_clone.clone();
            let thread_db = db_state.clone();
            let thread_event_id = event_id_state.clone();
            let path_clone = path.clone();

            // Run compression in the background so it doesn't freeze the app
            std::thread::spawn(move || {
                match crate::commands::compression::process_incoming_jpeg(&path_clone, &thread_pending) {
                    Ok(photo) => {
                        println!("Processed: {} ({}KB)", photo.filename, photo.file_size_kb);
                        
                        // Log it into the database
                        if let Ok(conn) = thread_db.lock() {
                            if let Ok(Some(evt_id)) = thread_event_id.lock().as_deref().map(|id| id.clone()) {
                                let photo_id = std::path::Path::new(&photo.filename).file_stem().unwrap().to_str().unwrap();
                                crate::db::insert_photo(&conn, photo_id, &evt_id, &photo.filename, photo.file_size_kb).ok();
                            }
                        }

                        // Emit to UI
                        thread_handle.emit("new_pending_photo", &photo.filename).ok();
                        
                        // Delete the original file from the incoming folder
                        std::fs::remove_file(&path_clone).ok();
                    }
                    Err(e) => eprintln!("Compression failed: {}", e),
                }
            });
        }
    );
    *state.watcher.lock().unwrap() = Some(watcher);

    // 6. Store active state
    *state.active_event_id.lock().unwrap() = Some(event_id.clone());
    *state.active_license_key.lock().unwrap() = Some(license_key.clone());

    // 7. Return server URL for QR Generation
    let local_ip = crate::commands::network::get_true_local_ip();
    let server_url = format!("http://{}:3000", local_ip);
    
    Ok(StartEventResult { event_id, server_url, event_name })
}

#[tauri::command]
pub async fn end_event(state: tauri::State<'_, AppState>) -> Result<EventReport, String> {
    // 1. Stop folder watcher
    *state.watcher.lock().unwrap() = None;

    // 2. Notify guests via sidecar 
    if let Some(server) = state.server.lock().unwrap().as_ref() {
        server.notify_event_ended();
    }
    
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;

    // 3. Stop sidecar
    *state.server.lock().unwrap() = None;

    // 4. Mark ended in SQLite & fetch stats
    let event_id = state.active_event_id.lock().unwrap().clone().ok_or("No active event")?;
    let conn = state.db.lock().unwrap();
    crate::db::end_event(&conn, &event_id).map_err(|e| e.to_string())?;
    let stats = crate::db::get_event_stats(&conn, &event_id).map_err(|e| e.to_string())?;
    
    // FIX 3: Manually grab the event name from the DB since EventStats doesn't hold it
    let fetched_event_name: String = conn.query_row(
        "SELECT name FROM events WHERE id = ?1", 
        [&event_id], 
        |row| row.get(0)
    ).unwrap_or_else(|_| "Wedding Event".to_string());
    
    drop(conn);

    // 5. Invalidate license key on the cloud backend
    let key = state.active_license_key.lock().unwrap().clone().unwrap_or_default();
    tokio::spawn(async move { 
        crate::commands::license::invalidate_key(&key).await.ok(); 
    });

    // 6. Clear state
    *state.active_event_id.lock().unwrap() = None;
    *state.active_license_key.lock().unwrap() = None;

    Ok(EventReport { 
        event_name: fetched_event_name, 
        duration_minutes: 0, // Placeholder for V1 to keep it simple
        photos_approved: stats.approved, 
        photos_rejected: stats.rejected,
        total_downloads: stats.total_downloads, // FIX 3: Corrected field name
        archive_path: format!("../weddingsnap-data/events/{}.zip", event_id)
    })
}

#[derive(serde::Serialize)]
pub struct ResumeResult {
    pub success: bool,
    pub event_id: Option<String>,
    pub event_name: Option<String>,
    pub server_url: Option<String>,
}

#[tauri::command]
pub async fn resume_active_event(
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<ResumeResult, String> {
    let conn = state.db.lock().map_err(|_| "DB Lock Failed")?;

    // 1. Look for an active event
    let query_result = conn.query_row(
        "SELECT id, name, license_key FROM events WHERE status = 'active' LIMIT 1",
        [],
        |row| Ok((
            row.get::<_, String>(0)?, 
            row.get::<_, String>(1)?, 
            row.get::<_, String>(2)?
        ))
    );

    let (event_id, event_name, license_key) = match query_result {
        Ok(data) => data,
        // FIX: Added event_id: None to prevent compilation error
        Err(_) => return Ok(ResumeResult { success: false, event_id: None, event_name: None, server_url: None }),
    };
    drop(conn);

    println!("Found active event: {}. Resuming...", event_name);

    // 2. Boot Sidecar
    let current_dir = std::env::current_dir().unwrap_or_default();
    let root_dir = current_dir.parent().unwrap_or(&current_dir).to_path_buf(); // FIX: Make owned PathBuf
    let gallery_path = root_dir.join("weddingsnap-data/gallery/compressed").to_string_lossy().to_string();
    let guest_app_path = root_dir.join("weddingsnap-data/guest-app").to_string_lossy().to_string();

    let server = crate::commands::sidecar::ServerProcess::new();
    server.start(&app_handle, &gallery_path, &guest_app_path).map_err(|e| e.to_string())?;
    *state.server.lock().unwrap() = Some(server);

    // 3. Boot Watcher
    let incoming_path = root_dir.join("weddingsnap-data/incoming");
    let pending_dir = root_dir.join("weddingsnap-data/incoming_pending");
    let db_state = std::sync::Arc::clone(&state.db);
    let event_id_state = std::sync::Arc::clone(&state.active_event_id);
    let app_handle_clone = app_handle.clone();
    let thread_root_dir = root_dir.clone(); // FIX: Clone the path specifically for the thread!

    let watcher = crate::commands::watcher::FolderWatcher::start(
        incoming_path,
        move |path| {
            // Process JPEGs, reject everything else
            if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                if !matches!(ext.to_lowercase().as_str(), "jpg" | "jpeg") {
                    let rejected_path = thread_root_dir.join("weddingsnap-data/rejected").join(path.file_name().unwrap());
                    std::fs::rename(&path, &rejected_path).ok();
                    return; 
                }
            } else { return; }

            let thread_pending = pending_dir.clone();
            let thread_handle = app_handle_clone.clone();
            let thread_db = db_state.clone();
            let thread_event_id = event_id_state.clone();
            let path_clone = path.clone();

            std::thread::spawn(move || {
                match crate::commands::compression::process_incoming_jpeg(&path_clone, &thread_pending) {
                    Ok(photo) => {
                        if let Ok(conn) = thread_db.lock() {
                            if let Ok(Some(evt_id)) = thread_event_id.lock().as_deref().map(|id| id.clone()) {
                                let photo_id = std::path::Path::new(&photo.filename).file_stem().unwrap().to_str().unwrap();
                                crate::db::insert_photo(&conn, photo_id, &evt_id, &photo.filename, photo.file_size_kb).ok();
                            }
                        }
                        thread_handle.emit("new_pending_photo", &photo.filename).ok();
                        std::fs::remove_file(&path_clone).ok();
                    }
                    Err(e) => eprintln!("Compression failed: {}", e),
                }
            });
        }
    );
    *state.watcher.lock().unwrap() = Some(watcher);

    // 4. Restore State
    *state.active_event_id.lock().unwrap() = Some(event_id.clone());
    *state.active_license_key.lock().unwrap() = Some(license_key.clone());

    let local_ip = crate::commands::network::get_true_local_ip();
    let server_url = format!("http://{}:3000", local_ip);

    Ok(ResumeResult {
        success: true,
        event_id: Some(event_id),
        event_name: Some(event_name),
        server_url: Some(server_url),
    })
}