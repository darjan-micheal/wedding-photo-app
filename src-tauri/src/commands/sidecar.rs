use tauri::{AppHandle, Emitter, Manager}; // Added Manager to access DB state
use tauri_plugin_shell::{process::CommandChild, process::CommandEvent, ShellExt};
use std::sync::{Arc, Mutex};
use rusqlite::Connection;

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

                            // 2. NEW: Download Logging (Module 8)
                            if event_type == "download_logged" {
                                if let (Some(photo_id), Some(guest_ip)) = (msg["photo_id"].as_str(), msg["guest_ip"].as_str()) {
                                    // THE FIX: We added .inner() right before .lock()
                                    if let Ok(conn) = app_clone.state::<Mutex<Connection>>().inner().lock() {
                                        crate::db::log_download(&conn, photo_id, guest_ip).ok();
                                        println!("Logged download for photo {} by IP {}", photo_id, guest_ip);
                                    }
                                }
                            }
                            
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

    pub fn notify_event_ended(&self) {
        let msg = serde_json::json!({ "event": "event_ended" });
        self.send_to_sidecar(&msg.to_string());
    }

    fn send_to_sidecar(&self, message: &str) {
        if let Some(child) = self.child.lock().unwrap().as_mut() {
            child.write(format!("{}\n", message).as_bytes()).ok();
        }
    }
}