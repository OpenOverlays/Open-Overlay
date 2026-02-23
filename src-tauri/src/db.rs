use rusqlite::{Connection, Result, params};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use once_cell::sync::Lazy;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OverlaySummary {
    pub id: String,
    pub name: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OverlayRow {
    pub id: String,
    pub name: String,
    pub config: String, // raw JSON string of OverlayConfig
    pub updated_at: String,
}

// ---------------------------------------------------------------------------
// Global DB connection (Mutex-protected)
// ---------------------------------------------------------------------------

pub static DB: Lazy<Mutex<Connection>> = Lazy::new(|| {
    let conn = open_or_create_db().expect("Failed to open database");
    Mutex::new(conn)
});

fn get_db_path() -> std::path::PathBuf {
    // Store the database in the user's local app data directory
    let mut path = dirs_path();
    path.push("overlays.db");
    path
}

fn dirs_path() -> std::path::PathBuf {
    // Use the same dir as the executable for portability
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            return parent.to_path_buf();
        }
    }
    std::path::PathBuf::from(".")
}

fn open_or_create_db() -> Result<Connection> {
    let path = get_db_path();
    let conn = Connection::open(&path)?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS overlays (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            config      TEXT NOT NULL,
            updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
         );",
    )?;
    Ok(conn)
}

// ---------------------------------------------------------------------------
// CRUD helpers
// ---------------------------------------------------------------------------

pub fn list_overlays() -> Result<Vec<OverlaySummary>> {
    let conn = DB.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, name, updated_at FROM overlays ORDER BY updated_at DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(OverlaySummary {
            id: row.get(0)?,
            name: row.get(1)?,
            updated_at: row.get(2)?,
        })
    })?;
    rows.collect()
}

pub fn get_overlay(id: &str) -> Result<Option<OverlayRow>> {
    let conn = DB.lock().unwrap();
    let mut stmt =
        conn.prepare("SELECT id, name, config, updated_at FROM overlays WHERE id = ?1")?;
    let mut rows = stmt.query_map(params![id], |row| {
        Ok(OverlayRow {
            id: row.get(0)?,
            name: row.get(1)?,
            config: row.get(2)?,
            updated_at: row.get(3)?,
        })
    })?;
    if let Some(row) = rows.next() {
        Ok(Some(row?))
    } else {
        Ok(None)
    }
}

pub fn upsert_overlay(id: &str, name: &str, config_json: &str) -> Result<()> {
    let conn = DB.lock().unwrap();
    conn.execute(
        "INSERT INTO overlays (id, name, config) VALUES (?1, ?2, ?3)
         ON CONFLICT(id) DO UPDATE SET
           name       = excluded.name,
           config     = excluded.config,
           updated_at = CURRENT_TIMESTAMP",
        params![id, name, config_json],
    )?;
    Ok(())
}

pub fn delete_overlay(id: &str) -> Result<()> {
    let conn = DB.lock().unwrap();
    conn.execute("DELETE FROM overlays WHERE id = ?1", params![id])?;
    Ok(())
}
