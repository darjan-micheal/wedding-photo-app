use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Result};
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Serialize)]
pub struct Event {
    pub id: String,
    pub name: String,
    pub license_key: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub photo_limit: Option<i32>,
    pub status: String,
    pub user_id: Option<String>,
    pub user_email: Option<String>,
    pub user_name: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Photo {
    pub id: String,
    pub event_id: String,
    pub filename: String,
    pub file_size_kb: i64,
    pub status: String,
    pub added_at: String,
    pub approved_at: Option<String>,
    pub source: String,
}

#[derive(Debug, Serialize)]
pub struct EventStats {
    pub pending: i32,
    pub approved: i32,
    pub rejected: i32,
    // Removed total_downloads
}

pub fn init_db(db_path: &Path) -> Result<Connection> {
    let conn = Connection::open(db_path)?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS events (
            id TEXT PRIMARY KEY, 
            name TEXT NOT NULL, 
            license_key TEXT NOT NULL,
            started_at TEXT NOT NULL, 
            ended_at TEXT,
            photo_limit INTEGER, 
            status TEXT DEFAULT 'active'
        )",
        [],
    )?;

    conn.execute("ALTER TABLE events ADD COLUMN user_id TEXT", [])
        .ok();
    conn.execute("ALTER TABLE events ADD COLUMN user_email TEXT", [])
        .ok();
    conn.execute("ALTER TABLE events ADD COLUMN user_name TEXT", [])
        .ok();
    conn.execute(
        "ALTER TABLE events ADD COLUMN sync_pending BOOLEAN DEFAULT 0",
        [],
    )
    .ok();
    
    // --- NEW: PHASE 1 GUEST CAM SCHEMA ---
    conn.execute(
        "ALTER TABLE events ADD COLUMN guest_cam_enabled BOOLEAN DEFAULT 1",
        [],
    )
    .ok();

    conn.execute(
        "CREATE TABLE IF NOT EXISTS photos (
            id TEXT PRIMARY KEY, 
            event_id TEXT NOT NULL, 
            filename TEXT NOT NULL,
            file_size_kb INTEGER, 
            status TEXT DEFAULT 'pending',
            added_at TEXT NOT NULL, 
            approved_at TEXT, 
            download_count INTEGER DEFAULT 0,
            FOREIGN KEY (event_id) REFERENCES events(id)
        )",
        [],
    )?;

    // --- NEW: PHASE 1 GUEST CAM SCHEMA ---
    // Add the source column to distinguish between Pro and Guest photos
    conn.execute("ALTER TABLE photos ADD COLUMN source TEXT DEFAULT 'pro'", []).ok();

    Ok(conn)
}

pub fn create_event(
    conn: &Connection,
    name: &str,
    key: &str,
    limit: Option<i32>,
    user_id: Option<&str>,
    user_email: Option<&str>,
    user_name: Option<&str>,
    guest_cam_enabled: bool, // <--- ADDED
) -> Result<String> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO events (id, name, license_key, started_at, photo_limit, status, user_id, user_email, user_name, guest_cam_enabled) 
         VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?7, ?8, ?9)",
        params![id, name, key, now, limit, user_id, user_email, user_name, guest_cam_enabled],
    )?;
    Ok(id)
}

pub fn end_event(conn: &Connection, event_id: &str) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE events SET status = 'ended', ended_at = ?1, sync_pending = 1 WHERE id = ?2",
        params![now, event_id],
    )?;
    Ok(())
}

pub fn get_active_event(conn: &Connection) -> Result<Option<Event>> {
    conn.query_row(
        "SELECT id, name, license_key, started_at, ended_at, photo_limit, status, user_id, user_email, user_name FROM events WHERE status = 'active' LIMIT 1",
        [],
        |row| {
            Ok(Event {
                id: row.get(0)?, name: row.get(1)?, license_key: row.get(2)?, started_at: row.get(3)?, ended_at: row.get(4)?, photo_limit: row.get(5)?, status: row.get(6)?, user_id: row.get(7)?, user_email: row.get(8)?, user_name: row.get(9)?,
            })
        },
    ).optional()
}

pub fn insert_photo(
    conn: &Connection,
    id: &str,
    event_id: &str,
    filename: &str,
    size_kb: u64,
) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO photos (id, event_id, filename, file_size_kb, status, added_at) VALUES (?1, ?2, ?3, ?4, 'pending', ?5)",
        params![id, event_id, filename, size_kb as i64, now],
    )?;
    Ok(())
}

pub fn approve_photo(conn: &Connection, id: &str) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE photos SET status = 'approved', approved_at = ?1 WHERE id = ?2",
        params![now, id],
    )?;
    Ok(())
}

pub fn reject_photo(conn: &Connection, id: &str) -> Result<()> {
    conn.execute(
        "UPDATE photos SET status = 'rejected' WHERE id = ?1",
        params![id],
    )?;
    Ok(())
}

pub fn get_pending_photos(conn: &Connection, event_id: &str) -> Result<Vec<Photo>> {
    // THE FIX: Added 'source' to the SELECT statement
    let mut stmt = conn.prepare("SELECT id, event_id, filename, file_size_kb, status, added_at, approved_at, source FROM photos WHERE event_id = ?1 AND status = 'pending' ORDER BY added_at ASC")?;
    let photo_iter = stmt.query_map(params![event_id], |row| {
        Ok(Photo {
            id: row.get(0)?,
            event_id: row.get(1)?,
            filename: row.get(2)?,
            file_size_kb: row.get(3)?,
            status: row.get(4)?,
            added_at: row.get(5)?,
            approved_at: row.get(6)?,
            source: row.get(7)?, 
        })
    })?;
    let mut photos = Vec::new();
    for photo in photo_iter {
        photos.push(photo?);
    }
    Ok(photos)
}

pub fn get_approved_photos(conn: &Connection, event_id: &str) -> Result<Vec<Photo>> {
    // THE FIX: Added 'source' to the SELECT statement
    let mut stmt = conn.prepare("SELECT id, event_id, filename, file_size_kb, status, added_at, approved_at, source FROM photos WHERE event_id = ?1 AND status = 'approved' ORDER BY approved_at DESC")?;
    let photo_iter = stmt.query_map(params![event_id], |row| {
        Ok(Photo {
            id: row.get(0)?,
            event_id: row.get(1)?,
            filename: row.get(2)?,
            file_size_kb: row.get(3)?,
            status: row.get(4)?,
            added_at: row.get(5)?,
            approved_at: row.get(6)?,
            source: row.get(7)?, 
        })
    })?;
    let mut photos = Vec::new();
    for photo in photo_iter {
        photos.push(photo?);
    }
    Ok(photos)
}

pub fn get_rejected_photos(conn: &Connection, event_id: &str) -> Result<Vec<Photo>> {
    // THE FIX: Added 'source' to the SELECT statement
    let mut stmt = conn.prepare("SELECT id, event_id, filename, file_size_kb, status, added_at, approved_at, source FROM photos WHERE event_id = ?1 AND status = 'rejected' ORDER BY added_at DESC")?;
    let photo_iter = stmt.query_map(params![event_id], |row| {
        Ok(Photo {
            id: row.get(0)?,
            event_id: row.get(1)?,
            filename: row.get(2)?,
            file_size_kb: row.get(3)?,
            status: row.get(4)?,
            added_at: row.get(5)?,
            approved_at: row.get(6)?,
            source: row.get(7)?, 
        })
    })?;
    let mut photos = Vec::new();
    for photo in photo_iter {
        photos.push(photo?);
    }
    Ok(photos)
}

pub fn check_photo_limit(conn: &Connection, event_id: &str) -> Result<bool> {
    let event_opt = get_active_event(conn)?;
    if let Some(event) = event_opt {
        if let Some(limit) = event.photo_limit {
            let count: i32 = conn.query_row(
                "SELECT COUNT(*) FROM photos WHERE event_id = ?1 AND status = 'approved'",
                params![event_id],
                |row| row.get(0),
            )?;
            return Ok(count < limit);
        }
    }
    Ok(true)
}

// Completely removed the log_download function

pub fn get_event_stats(conn: &Connection, event_id: &str) -> Result<EventStats> {
    let pending: i32 = conn
        .query_row(
            "SELECT COUNT(*) FROM photos WHERE event_id = ?1 AND status = 'pending'",
            params![event_id],
            |row| row.get(0),
        )
        .unwrap_or(0);
    let approved: i32 = conn
        .query_row(
            "SELECT COUNT(*) FROM photos WHERE event_id = ?1 AND status = 'approved'",
            params![event_id],
            |row| row.get(0),
        )
        .unwrap_or(0);
    let rejected: i32 = conn
        .query_row(
            "SELECT COUNT(*) FROM photos WHERE event_id = ?1 AND status = 'rejected'",
            params![event_id],
            |row| row.get(0),
        )
        .unwrap_or(0);

    // Removed total_downloads SQLite query

    Ok(EventStats {
        pending,
        approved,
        rejected,
    })
}
