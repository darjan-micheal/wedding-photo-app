use rusqlite::Connection;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager}; // Added Manager to access DB state
use tauri_plugin_shell::{process::CommandChild, process::CommandEvent, ShellExt};

pub struct ServerProcess {
    pub child: Arc<Mutex<Option<CommandChild>>>,
}

impl ServerProcess {
    pub fn new() -> Self {
        Self {
            child: Arc::new(Mutex::new(None)),
        }
    }

    pub fn start(
        &self,
        app: &AppHandle,
        gallery_path: &str,
        guest_app_path: &str,
    ) -> Result<String, String> {
        let mut child_guard = self.child.lock().unwrap();

        if child_guard.is_some() {
            return Ok("Server is already running".to_string());
        }

        let (mut rx, child) = app
            .shell()
            .sidecar("server")
            .map_err(|e| format!("Failed to setup sidecar: {}", e))?
            .env("PORT", "3000")
            .env("GALLERY_PATH", gallery_path)
            .env("GUEST_APP_PATH", guest_app_path)
            .spawn()
            .map_err(|e| format!("Failed to spawn sidecar: {}", e))?;

        *child_guard = Some(child);

        // Clone the AppHandle so we can emit events from inside the async thread
        let app_clone = app.clone();

        // Listen to stdout in the background
        tauri::async_runtime::spawn(async move {
            while let Some(event) = rx.recv().await {
                if let CommandEvent::Stdout(line) = event {
                    let text = String::from_utf8_lossy(&line);
                    println!("Node Sidecar: {}", text);

                    // Catch Socket.io events and forward to Tauri UI or SQLite DB
                    if let Ok(msg) = serde_json::from_str::<serde_json::Value>(&text) {
                        if let Some(event_type) = msg["event"].as_str() {
                            
                            // 1. Guest Count Update
                            if event_type == "guest_count" {
                                let count = msg["count"].as_u64().unwrap_or(0);
                                app_clone.emit("guest_count_update", count).ok();
                            }
                            
                            // --- NEW PHASE 4: GUEST UPLOAD BRIDGE ---
                            else if event_type == "guest_upload_received" {
                                if let (Some(filename), Some(size_kb), Some(source)) = (
                                    msg["filename"].as_str(),
                                    msg["size_kb"].as_u64(),
                                    msg["source"].as_str(),
                                ) {
                                    let app_clone_db = app_clone.clone();
                                    let f_name = filename.to_string();
                                    let src = source.to_string();
                                    let s_kb = size_kb;

                                    tauri::async_runtime::spawn(async move {
                                        // 1. Extract the raw Arc pointers FIRST so we don't trap the State reference
                                        let state = app_clone_db.state::<crate::commands::event::AppState>();
                                        let db_arc = state.db.clone();
                                        let event_id_arc = state.active_event_id.clone();
                                        
                                        // 2. Clone the filename so the DB and the UI both get their own copy
                                        let f_name_db = f_name.clone();

                                        let inserted = tokio::task::spawn_blocking(move || {
                                            if let Ok(conn) = db_arc.lock() {
                                                if let Ok(Some(evt_id)) = event_id_arc.lock().as_deref().map(|id| id.clone()) {
                                                    let now = chrono::Utc::now().to_rfc3339();
                                                    
                                                    // THE FIX: Do not silently ignore SQL failures! Catch and print them!
                                                    let insert_result = conn.execute(
                                                        "INSERT INTO photos (id, event_id, filename, file_size_kb, status, added_at, source) VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6)",
                                                        rusqlite::params![&f_name_db, &evt_id, &f_name_db, s_kb as i64, &now, &src],
                                                    );
                                                    
                                                    match insert_result {
                                                        Ok(_) => return true,
                                                        Err(e) => {
                                                            eprintln!("CRITICAL DB ERROR: Failed to insert guest photo into SQLite: {}", e);
                                                            return false;
                                                        }
                                                    }
                                                }
                                            }
                                            false
                                        }).await.unwrap_or(false);

                                        if inserted {
                                            app_clone_db.emit("new_pending_photo", f_name).ok();
                                        }
                                    });
                                }
                            }
                            // --- NEW PHASE 4: GUEST DELETION BRIDGE ---
                            else if event_type == "guest_delete_photo" {
                                if let Some(filename) = msg["filename"].as_str() {
                                    let state = app_clone.state::<crate::commands::event::AppState>();
                                    let db_arc = state.db.clone();
                                    let f_name = filename.to_string();

                                    tauri::async_runtime::spawn(async move {
                                        let _ = tokio::task::spawn_blocking(move || {
                                            if let Ok(conn) = db_arc.lock() {
                                                let _ = conn.execute(
                                                    "DELETE FROM photos WHERE filename = ?1",
                                                    rusqlite::params![f_name],
                                                );
                                            }
                                        }).await;
                                    });
                                    // Clear it from the Command Center UI instantly
                                    app_clone.emit("photo_removed", filename).ok();
                                }
                            }
                            // ----------------------------------------
                        }
                    }
                }
            }
        });

        Ok("Server started successfully".to_string())
    }

   // --- Methods to send data via STDIN to Node.js ---

    pub fn notify_new_photo(&self, photo_id: &str, filename: &str) {
        let msg = serde_json::json!({
            "event": "new_photo",
            "data": {
                "id": photo_id,
                "filename": filename,
                "url": format!("/photos/{}", filename)
            }
        });
        self.send_to_sidecar(&msg.to_string());
    }

    pub fn notify_removed_photo(&self, filename: &str) {
        let msg = serde_json::json!({
            "event": "photo_removed",
            "data": {
                "filename": filename
            }
        });
        self.send_to_sidecar(&msg.to_string());
    }

    pub fn notify_event_ended(&self) {
        let msg = serde_json::json!({ "event": "event_ended" });
        self.send_to_sidecar(&msg.to_string());
    }

    fn send_to_sidecar(&self, message: &str) {
        println!("TRACER 1 (RUST): Attempting to write to Node STDIN -> {}", message);
        if let Some(child) = self.child.lock().unwrap().as_mut() {
            if let Err(e) = child.write(format!("{}\n", message).as_bytes()) {
                println!("TRACER 1 ERROR (RUST): Failed to write to sidecar: {}", e);
            } else {
                println!("TRACER 1 SUCCESS (RUST): Write command successfully sent to pipe.");
            }
        } else {
            println!("TRACER 1 ERROR (RUST): Child process is missing or dead!");
        }
    }
}