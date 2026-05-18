pub mod commands;
pub mod db;

use std::sync::{Arc, Mutex};
// FIX: Added Listener and Emitter so the Deep Link events can be caught and sent to your UI
use tauri::{Emitter, Listener, Manager};

// We no longer need the hardcoded `start_server` command here because
// it is now handled inside `commands::event::start_event`

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // --- NEW: MUST BE FIRST: Catch the Windows Deep Link and stop a 2nd app from opening! ---
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(url) = argv.get(1) {
                println!("Windows Deep Link Caught: {}", url);
                let _ = app.emit("google_auth_received", url);

                // INSTANTLY BRING THE APP TO THE FRONT!
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
        }))
        // --- NEW: Initialize the Deep Link Plugin ---
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(crate::commands::sidecar::ServerProcess::new())
        .setup(|app| {
            // 1. Initialize Database
            // THE FIX: Route the system database to the secure Windows AppData folder!
            let app_data_dir = app.path().app_data_dir().expect("Failed to resolve AppData");
            let base_path = app_data_dir.join("weddingsnap-data");
            
            // We MUST create this folder before SQLite tries to write to it!
            std::fs::create_dir_all(&base_path).expect("Failed to create base directory");
            
            let db_path = base_path.join("weddingsnap.db");
            let conn = db::init_db(&db_path).expect("Failed to initialize database");
            // THE FIX: Provide the old, unpacked database state for approval.rs!
            let conn_for_approvals = db::init_db(&db_path).expect("Failed to init DB");

            // Tell SQLite to wait in line for 3 seconds if the database is locked by the watcher!
            conn_for_approvals
                .execute("PRAGMA journal_mode=WAL;", [])
                .ok();
            conn_for_approvals
                .busy_timeout(std::time::Duration::from_secs(3))
                .ok();

            app.manage(Mutex::new(conn_for_approvals));

            // 2. Initialize AppState
            // This is the "waiting room". We create empty slots for the server
            // and watcher to sit in until the user clicks "Start Event"
            let app_state = crate::commands::event::AppState {
                db: Arc::new(Mutex::new(conn)),
                server: Arc::new(Mutex::new(None)),
                watcher: Arc::new(Mutex::new(None)),
                active_event_id: Arc::new(Mutex::new(None)),
                active_license_key: Arc::new(Mutex::new(None)),
                // NEW: Initialize the Identity slots as empty when the app boots
                active_user_id: Arc::new(Mutex::new(None)),
                active_user_email: Arc::new(Mutex::new(None)),
                active_user_name: Arc::new(Mutex::new(None)),
            };

            app.manage(app_state);

            // --- NEW: Listen for the deep link natively ---
            let handle = app.handle().clone();
            app.listen("tauri://deep-link", move |event| {
                let payload = event.payload();
                println!("Native Deep Link Received: {}", payload);
                handle.emit("google_auth_received", payload).unwrap();
            });

            // 3. Create required directories just in case they don't exist
            // (We keep this here so the folders exist before the watcher tries to look at them)
            let folders = vec![
                base_path.join("incoming"),
                base_path.join("incoming_pending"),
                base_path.join("gallery/compressed"),
                base_path.join("rejected"),
                base_path.join("events"),
            ];

            for folder in &folders {
                if !folder.exists() {
                    std::fs::create_dir_all(folder).expect("Failed to create directory");
                }
            }

            // --- MODULE 9: Start mDNS Broadcast ---
            // We keep the mDNS broadcast alive from boot so the QR code is ready immediately
            let network_state = crate::commands::network::NetworkState::new();
            network_state.start_broadcast();
            app.manage(network_state); // Keeps the daemon alive!

            // Notice that the 100+ lines of Watcher and Compression threads are gone.
            // They have been moved into `commands/event.rs`.

            Ok(())
        })
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            crate::commands::event::sync_user_session,
            crate::commands::event::resume_active_event,
            // --- NEW PHASE 3 COMMANDS ---
            crate::commands::event::get_pending_sync_events,
            crate::commands::event::mark_event_synced,
            // --- NEW EVENT FLOW COMMANDS ---
            crate::commands::event::start_event,
            crate::commands::event::end_event,
            crate::commands::license::validate_key,
            crate::commands::license::invalidate_key,

            crate::commands::approval::get_approved_photos, // <--- ADD THIS
            crate::commands::approval::get_rejected_photos,  // <--- ADD THIS

            // --- EXISTING COMMANDS ---
            crate::commands::approval::get_pending_photos,
            crate::commands::approval::approve_photo,
            crate::commands::approval::reject_photo,
            crate::commands::approval::approve_all_pending,
            crate::commands::approval::read_image_file,
            crate::commands::approval::get_event_stats,
            crate::commands::network::get_network_urls,
            crate::commands::network::ping_router,

            crate::commands::event::sign_out_user,
            crate::commands::event::clear_storage_cache
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
