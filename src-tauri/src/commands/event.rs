use chrono::{DateTime, Utc};
use rusqlite::Connection;
use serde::Serialize;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tauri_plugin_store::StoreExt;
use serde_json::json;

// --- AppState Definition ---
pub struct AppState {
    pub db: Arc<Mutex<Connection>>,
    pub server: Arc<Mutex<Option<crate::commands::sidecar::ServerProcess>>>,
    pub watcher: Arc<Mutex<Option<crate::commands::watcher::FolderWatcher>>>,
    pub active_event_id: Arc<Mutex<Option<String>>>,
    pub active_license_key: Arc<Mutex<Option<String>>>,
    // --- PHASE 1: IDENTITY MEMORY SLOTS ---
    pub active_user_id: Arc<Mutex<Option<String>>>,
    pub active_user_email: Arc<Mutex<Option<String>>>,
    pub active_user_name: Arc<Mutex<Option<String>>>,
}

#[derive(Serialize)]
pub struct StartEventResult {
    pub event_id: String,
    pub server_url: String,
    pub event_name: String,
}

#[derive(Serialize)]
pub struct EventReport {
    pub event_id: String,
    pub owner_id: Option<String>,
    pub event_name: String,
    pub started_at: String,
    pub ended_at: String,
    pub duration_minutes: i64,
    pub total_photos: i32,    // For Supabase
    pub photos_approved: i32, // For local UI
    pub photos_rejected: i32, // For local UI
    pub archive_path: String,
}

// --- PHASE 1: THE IDENTITY HANDSHAKE COMMAND ---
#[tauri::command]
pub async fn sync_user_session(
    user_id: String,
    email: String,
    name: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    // THE FIX: Print the email FIRST before we move its ownership into the State!
    println!("Security: User Identity Synced & Locked -> {}", email);

    *state.active_user_id.lock().unwrap() = Some(user_id);
    *state.active_user_email.lock().unwrap() = Some(email);
    *state.active_user_name.lock().unwrap() = Some(name);

    Ok(())
}

#[tauri::command]
pub async fn start_event(
    event_name: String,
    license_key: String,
    photo_limit: Option<i32>,
    expires_at: String,
    storage_path: String, // <--- ADDED
    compression_quality: String,
    guest_cam_enabled: bool,
    state: tauri::State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<StartEventResult, String> {
    // 1. Validate license key against the Cloud
    let key_info = crate::commands::license::validate_key(license_key.clone()).await?;
    let effective_limit = photo_limit.or(key_info.photo_limit);

    // --- 1.5 THE SECURE VAULT CHECK ---
    // Open the hidden file in the Windows AppData directory
    let store = app_handle.store("secure_vault.json").map_err(|e| format!("Vault Error: {}", e))?;
    
    // If the key is found in the local vault, it means they are trying the offline deletion exploit!
    if store.has(&license_key) {
        return Err("SECURITY BREACH: This license key has already been used on this machine. Please purchase a new key.".to_string());
    }

    // If it's a fresh key, instantly burn it into the hidden vault
    store.set(&license_key, json!(Utc::now().to_rfc3339()));
    let _ = store.save(); // Force write to disk immediately
    // -----------------------------------

    // 2. Check firewall
    crate::commands::network::ensure_firewall_rule().ok();

    // 3. Create event in SQLite WITH USER IDENTITY
    let conn = state.db.lock().unwrap();

    // Pull the identity out of memory safely
    let user_id = state.active_user_id.lock().unwrap().clone();
    let user_email = state.active_user_email.lock().unwrap().clone();
    let user_name = state.active_user_name.lock().unwrap().clone();

    // Pass it to the newly upgraded database file!
    let event_id = crate::db::create_event(
        &conn,
        &event_name,
        &license_key,
        effective_limit,
        user_id.as_deref(),
        user_email.as_deref(),
        user_name.as_deref(),
        guest_cam_enabled, // <--- PASS IT TO SQLITE
    )
    .map_err(|e| format!("DB Error: {}", e))?;
    // --- THE SPLIT STORAGE FIX ---
    // 1. App Code stays relative to the installation
    let current_dir = std::env::current_dir().unwrap_or_default();
    let app_root_dir = current_dir.parent().unwrap_or(&current_dir);
    let guest_app_dir = app_root_dir.join("weddingsnap-data/guest-app");

    // 2. Heavy Media routes dynamically to the user's chosen SSD
    let media_root_dir = std::path::PathBuf::from(&storage_path);
    let watch_dir = media_root_dir.join("weddingsnap-data/incoming");
    let pending_dir = media_root_dir.join("weddingsnap-data/incoming_pending");
    let gallery_dir = media_root_dir.join("weddingsnap-data/gallery/compressed");
    
    // THE FIX: Define the paths as variables FIRST before borrowing them
    let rejected_dir = media_root_dir.join("weddingsnap-data/rejected");
    let events_dir = media_root_dir.join("weddingsnap-data/events");

    let folders = vec![
        &watch_dir,
        &pending_dir,
        &gallery_dir,
        &rejected_dir,
        &events_dir,
    ];

    for folder in &folders {
        if !folder.exists() {
            std::fs::create_dir_all(folder).ok();
        }
    }

    let server = crate::commands::sidecar::ServerProcess::new();
    server
        .start(&app_handle, gallery_dir.to_str().unwrap(), guest_app_dir.to_str().unwrap())
        .map_err(|e| format!("Server Error: {}", e))?;
    *state.server.lock().unwrap() = Some(server);

    // --- THE FIX: MOVE THESE TWO LINES UP HERE BEFORE THE WATCHER STARTS ---
    *state.active_event_id.lock().unwrap() = Some(event_id.clone());
    *state.active_license_key.lock().unwrap() = Some(license_key.clone());
    // ----------------------------------------------------------------------

    let incoming_path = watch_dir; 
    let app_handle_clone = app_handle.clone();
    let thread_root_dir = media_root_dir.clone(); 
    let event_id_state = Arc::clone(&state.active_event_id);
    let db_state = Arc::clone(&state.db); 
    let watcher_quality = compression_quality.clone();
    
    // NEW: Create the exact 5-thread concurrency limit!
    let compression_semaphore = Arc::new(tokio::sync::Semaphore::new(5));

    let watcher = crate::commands::watcher::FolderWatcher::start(incoming_path, move |path| {
        if !path.exists() { return; }
        
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
        let thread_quality = watcher_quality.clone();
        let thread_semaphore = compression_semaphore.clone();

        // THE FIX: Spawn an async task for EVERY file. It won't block!
        tauri::async_runtime::spawn(async move {
            match crate::commands::compression::process_incoming_jpeg(&path_clone, &thread_pending, &thread_quality, thread_semaphore).await
            {
                Ok(photo) => {
                    println!("Processed: {} ({}KB)", photo.filename, photo.file_size_kb);
                    if let Ok(conn) = thread_db.lock() {
                        if let Ok(Some(evt_id)) = thread_event_id.lock().as_deref().map(|id| id.clone()) {
                            crate::db::insert_photo(&conn, &photo.filename, &evt_id, &photo.filename, photo.file_size_kb).ok();
                        }
                    }
                    thread_handle.emit("new_pending_photo", &photo.filename).ok();
                    std::fs::remove_file(&path_clone).ok();
                }
                Err(e) => eprintln!("Compression failed: {}", e),
            }
        });
    });
    *state.watcher.lock().unwrap() = Some(watcher);

    // 6. Store active state
    *state.active_event_id.lock().unwrap() = Some(event_id.clone());
    *state.active_license_key.lock().unwrap() = Some(license_key.clone());

    // 7. Return server URL for QR Generation
    let local_ip = crate::commands::network::get_true_local_ip();
    let server_url = format!("http://{}:3000", local_ip);

    // THE GUILLOTINE
    if let Ok(expiration_time) = expires_at.parse::<DateTime<Utc>>() {
        let watcher_arc = state.watcher.clone();
            let server_arc = state.server.clone();
            let db_arc = state.db.clone();
            let active_event_id_arc = state.active_event_id.clone();
            let app_handle_clone = app_handle.clone();

            tokio::spawn(async move {
                loop {
                    let now = Utc::now();
                    if now >= expiration_time {
                        println!("SECURITY: Event expired! Executing Guillotine.");

                        if let Ok(mut watcher_lock) = watcher_arc.lock() {
                            *watcher_lock = None;
                        }
                        if let Ok(mut server_lock) = server_arc.lock() {
                            *server_lock = None;
                        }
                        if let Ok(conn) = db_arc.lock() {
                            if let Ok(guard) = active_event_id_arc.lock() {
                                if let Some(evt_id) = guard.as_ref() {
                                    let _ = conn.execute(
                                        "UPDATE events SET status = 'expired' WHERE id = ?1",
                                        [evt_id],
                                    );
                                }
                            }
                        }
                        let _ = app_handle_clone.emit("force_lock_ui", "License Expired");
                        break;
                    }
                    tokio::time::sleep(Duration::from_secs(10)).await;
                }
            });
        }

    Ok(StartEventResult {
        event_id,
        server_url,
        event_name,
    })
}

#[tauri::command]
pub async fn end_event(storage_path: String, state: tauri::State<'_, AppState>) -> Result<EventReport, String> {
    *state.watcher.lock().unwrap() = None;

    if let Some(server) = state.server.lock().unwrap().as_ref() {
        server.notify_event_ended();
    }
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    *state.server.lock().unwrap() = None;

    let event_id = state
        .active_event_id
        .lock()
        .unwrap()
        .clone()
        .ok_or("No active event")?;
    let conn = state.db.lock().unwrap();
    crate::db::end_event(&conn, &event_id).map_err(|e| e.to_string())?;
    let stats = crate::db::get_event_stats(&conn, &event_id).map_err(|e| e.to_string())?;

    // Fetch the exact data required by the Cloud Mirror
    let mut owner_id: Option<String> = None;
    let mut started_at = String::new();
    let mut ended_at = String::new();
    let mut fetched_event_name = String::new();

    let _ = conn.query_row(
        "SELECT name, user_id, started_at, ended_at FROM events WHERE id = ?1",
        [&event_id],
        |row| {
            fetched_event_name = row.get(0)?;
            owner_id = row.get(1)?;
            started_at = row.get(2)?;
            ended_at = row.get(3).unwrap_or_else(|_| Utc::now().to_rfc3339());
            Ok(())
        },
    );
    drop(conn);

    let key = state
        .active_license_key
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_default();
    tokio::spawn(async move {
        crate::commands::license::invalidate_key(&key).await.ok();
    });

    *state.active_event_id.lock().unwrap() = None;
    *state.active_license_key.lock().unwrap() = None;

    // Calculate duration
    let start_time =
        chrono::DateTime::parse_from_rfc3339(&started_at).unwrap_or_else(|_| Utc::now().into());
    let end_time =
        chrono::DateTime::parse_from_rfc3339(&ended_at).unwrap_or_else(|_| Utc::now().into());
    let duration_minutes = end_time.signed_duration_since(start_time).num_minutes();

    // --- INSTANT ARCHIVE ENGINE ---
    let media_root_dir = std::path::PathBuf::from(&storage_path);
    let gallery_dir = media_root_dir.join("weddingsnap-data/gallery/compressed");
    let event_archive_dir = media_root_dir.join(format!("weddingsnap-data/events/{}", event_id));

    // 1. Instantly move the approved gallery to the safe events folder
    if gallery_dir.exists() {
        std::fs::rename(&gallery_dir, &event_archive_dir).ok();
    }
    // 2. Recreate an empty gallery folder so the Web Gallery is blank for the next wedding
    std::fs::create_dir_all(&gallery_dir).ok();

    // 3. Clear out any leftover junk in the pending or rejected queues
    let pending_dir = media_root_dir.join("weddingsnap-data/incoming_pending");
 let rejected_dir = media_root_dir.join("weddingsnap-data/rejected");

    for dir in [&pending_dir, &rejected_dir] {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                if let Ok(file_type) = entry.file_type() {
                    if file_type.is_file() {
                        std::fs::remove_file(entry.path()).ok();
                    }
                }
            }
        }
    }
    // --------------------------------------------------

    Ok(EventReport {
        event_id: event_id.clone(),
        owner_id,
        event_name: fetched_event_name,
        started_at,
        ended_at,
        duration_minutes,
        total_photos: stats.approved,
        photos_approved: stats.approved,
        photos_rejected: stats.rejected,
        // Removed the .zip extension!
        archive_path: format!("{}/weddingsnap-data/events/{}", storage_path, event_id),
    })
}

// --- PHASE 3: OFFLINE QUEUE RECOVERY COMMANDS ---
#[derive(Serialize)]
pub struct PendingSyncEvent {
    pub event_id: String,
    pub owner_id: String,
    pub event_name: String,
    pub started_at: String,
    pub ended_at: String,
    pub total_photos: i32,
    pub archive_path: String,
}

#[tauri::command]
pub async fn get_pending_sync_events(
    storage_path: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<PendingSyncEvent>, String> {
    let conn = state.db.lock().unwrap();
    let mut stmt = conn.prepare("SELECT id, user_id, name, started_at, ended_at FROM events WHERE sync_pending = 1 AND status = 'ended'").map_err(|e| e.to_string())?;

    let mut pending = Vec::new();
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    for row_result in rows {
        if let Ok((id, owner_opt, name, start, end_opt)) = row_result {
            if let Some(owner) = owner_opt {
                let end = end_opt.unwrap_or_else(|| Utc::now().to_rfc3339());
                let mut total_photos = 0;
                if let Ok(stats) = crate::db::get_event_stats(&conn, &id) {
                    total_photos = stats.approved;
                }
                pending.push(PendingSyncEvent {
                    event_id: id.clone(),
                    owner_id: owner,
                    event_name: name,
                    started_at: start,
                    ended_at: end,
                    total_photos,
                    archive_path: format!("{}/weddingsnap-data/events/{}", storage_path, id), // Removed the .zip extension!
                });
            }
        }
    }
    Ok(pending)
}

#[tauri::command]
pub async fn mark_event_synced(
    event_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    conn.execute(
        "UPDATE events SET sync_pending = 0 WHERE id = ?1",
        [&event_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
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
    storage_path: String,
    compression_quality: String,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<ResumeResult, String> {
    let conn = state.db.lock().map_err(|_| "DB Lock Failed")?;

    // THE FIX: Fetch the 'started_at' time so we can calculate the expiration
    let query_result = conn.query_row(
        "SELECT id, name, license_key, started_at FROM events WHERE status = 'active' LIMIT 1",
        [],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        },
    );

    let (event_id, event_name, license_key, started_at) = match query_result {
        Ok(data) => data,
        Err(_) => {
            return Ok(ResumeResult {
                success: false,
                event_id: None,
                event_name: None,
                server_url: None,
            })
        }
    };
    drop(conn);

    // --- THE SPLIT STORAGE FIX ---
    let current_dir = std::env::current_dir().unwrap_or_default();
    let app_root_dir = current_dir.parent().unwrap_or(&current_dir);
    let guest_app_dir = app_root_dir.join("weddingsnap-data/guest-app");

    let media_root_dir = std::path::PathBuf::from(&storage_path);
    let watch_dir = media_root_dir.join("weddingsnap-data/incoming");
    let pending_dir = media_root_dir.join("weddingsnap-data/incoming_pending");
    let gallery_dir = media_root_dir.join("weddingsnap-data/gallery/compressed");
    
    // THE FIX: Define the paths as variables FIRST before borrowing them
    let rejected_dir = media_root_dir.join("weddingsnap-data/rejected");
    let events_dir = media_root_dir.join("weddingsnap-data/events");

    let folders = vec![
        &watch_dir,
        &pending_dir,
        &gallery_dir,
        &rejected_dir,
        &events_dir,
    ];
    // THE FIX: Added the loop to ensure folders exist before we resume!
    for folder in &folders {
        if !folder.exists() {
            std::fs::create_dir_all(folder).ok();
        }
    }

    let server = crate::commands::sidecar::ServerProcess::new();
    server
        .start(&app_handle, gallery_dir.to_str().unwrap(), guest_app_dir.to_str().unwrap())
        .ok();
    *state.server.lock().unwrap() = Some(server);

    // --- THE FIX: MOVE THESE TWO LINES UP HERE BEFORE THE WATCHER STARTS ---
    *state.active_event_id.lock().unwrap() = Some(event_id.clone());
    *state.active_license_key.lock().unwrap() = Some(license_key.clone());
    // ----------------------------------------------------------------------

    let incoming_path = watch_dir; 
    let app_handle_clone = app_handle.clone();
    let thread_root_dir = media_root_dir.clone(); 
    let event_id_state = Arc::clone(&state.active_event_id);
    let db_state = Arc::clone(&state.db); 
    let watcher_quality = compression_quality.clone();
    
    // NEW: Create the exact 5-thread concurrency limit!
    let compression_semaphore = Arc::new(tokio::sync::Semaphore::new(5));

    let watcher = crate::commands::watcher::FolderWatcher::start(incoming_path, move |path| {
        if !path.exists() { return; }
        
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
        let thread_quality = watcher_quality.clone();
        let thread_semaphore = compression_semaphore.clone();

        // THE FIX: Spawn an async task for EVERY file. It won't block!
        tauri::async_runtime::spawn(async move {
            match crate::commands::compression::process_incoming_jpeg(&path_clone, &thread_pending, &thread_quality, thread_semaphore).await
            {
                Ok(photo) => {
                    println!("Processed: {} ({}KB)", photo.filename, photo.file_size_kb);
                    if let Ok(conn) = thread_db.lock() {
                        if let Ok(Some(evt_id)) = thread_event_id.lock().as_deref().map(|id| id.clone()) {
                            crate::db::insert_photo(&conn, &photo.filename, &evt_id, &photo.filename, photo.file_size_kb).ok();
                        }
                    }
                    thread_handle.emit("new_pending_photo", &photo.filename).ok();
                    std::fs::remove_file(&path_clone).ok();
                }
                Err(e) => eprintln!("Compression failed: {}", e),
            }
        });
    });
    *state.watcher.lock().unwrap() = Some(watcher);

    *state.active_event_id.lock().unwrap() = Some(event_id.clone());
    *state.active_license_key.lock().unwrap() = Some(license_key.clone());

    let local_ip = crate::commands::network::get_true_local_ip();
    let server_url = format!("http://{}:3000", local_ip);

    // --- THE RESUME GUILLOTINE FIX ---
    if let Ok(start_time) = chrono::DateTime::parse_from_rfc3339(&started_at) {
        let start_time_utc = start_time.with_timezone(&Utc);
        let expiration_time = start_time_utc + chrono::Duration::hours(12);
        
        let watcher_arc = state.watcher.clone();
        let server_arc = state.server.clone();
        let db_arc = state.db.clone();
        let active_event_id_arc = state.active_event_id.clone();
        let app_handle_clone = app_handle.clone();

        tokio::spawn(async move {
            loop {
                let now = Utc::now();
                if now >= expiration_time {
                    println!("SECURITY: Resumed Event expired! Executing Guillotine.");

                    if let Ok(mut watcher_lock) = watcher_arc.lock() {
                        *watcher_lock = None;
                    }
                    if let Ok(mut server_lock) = server_arc.lock() {
                        *server_lock = None;
                    }
                    if let Ok(conn) = db_arc.lock() {
                        if let Ok(guard) = active_event_id_arc.lock() {
                            if let Some(evt_id) = guard.as_ref() {
                                let _ = conn.execute(
                                    "UPDATE events SET status = 'expired' WHERE id = ?1",
                                    [evt_id],
                                );
                            }
                        }
                    }
                    let _ = app_handle_clone.emit("force_lock_ui", "License Expired");
                    break;
                }
                tokio::time::sleep(Duration::from_secs(10)).await;
            }
        });
    }

    Ok(ResumeResult {
        success: true,
        event_id: Some(event_id),
        event_name: Some(event_name),
        server_url: Some(server_url),
    })
}
// --- PHASE 4: SETTINGS ACTIONS ---

#[tauri::command]
pub async fn sign_out_user(state: tauri::State<'_, AppState>) -> Result<(), String> {
    // Wipe the identity from the active memory slots
    *state.active_user_id.lock().unwrap() = None;
    *state.active_user_email.lock().unwrap() = None;
    *state.active_user_name.lock().unwrap() = None;
    
    println!("Security: User signed out and identity wiped from memory.");
    Ok(())
}

#[tauri::command]
pub async fn clear_storage_cache(storage_path: String) -> Result<(), String> {
    let media_root_dir = std::path::PathBuf::from(&storage_path);
    let pending_dir = media_root_dir.join("weddingsnap-data/incoming_pending");
    let rejected_dir = media_root_dir.join("weddingsnap-data/rejected");

    // Loop through both folders and instantly delete any leftover un-archived files
    for dir in [&pending_dir, &rejected_dir] {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                if let Ok(file_type) = entry.file_type() {
                    if file_type.is_file() {
                        std::fs::remove_file(entry.path()).ok();
                    }
                }
            }
        }
    }
    
    println!("Maintenance: Local data cache cleared at {}", storage_path);
    Ok(())
}