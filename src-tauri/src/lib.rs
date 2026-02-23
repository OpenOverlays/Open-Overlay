mod db;
mod obs_server;

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Tauri Commands (called from frontend via invoke())
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
pub struct SaveOverlayArgs {
    pub id: String,
    pub name: String,
    pub config: serde_json::Value,
}

#[tauri::command]
fn list_overlays() -> Result<Vec<db::OverlaySummary>, String> {
    db::list_overlays().map_err(|e| e.to_string())
}

#[tauri::command]
fn get_overlay(id: String) -> Result<Option<serde_json::Value>, String> {
    match db::get_overlay(&id).map_err(|e| e.to_string())? {
        Some(row) => {
            let config_val: serde_json::Value =
                serde_json::from_str(&row.config).unwrap_or(serde_json::Value::Null);
            Ok(Some(serde_json::json!({
                "id": row.id,
                "name": row.name,
                "config": config_val,
                "updated_at": row.updated_at
            })))
        }
        None => Ok(None),
    }
}

#[tauri::command]
fn save_overlay(args: SaveOverlayArgs) -> Result<(), String> {
    let config_str = serde_json::to_string(&args.config).map_err(|e| e.to_string())?;
    db::upsert_overlay(&args.id, &args.name, &config_str).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_overlay(id: String) -> Result<(), String> {
    db::delete_overlay(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_obs_url(id: String) -> String {
    format!("http://localhost:{}/widget/{}", obs_server::OBS_HTTP_PORT, id)
}

// ---------------------------------------------------------------------------
// App entry point
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize the DB early to ensure the table exists
    let _ = &*db::DB;

    tauri::Builder::default()
        .setup(|app| {
            // Start the OBS HTTP server in a background Tokio runtime
            let rt = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .expect("Failed to build Tokio runtime");

            // Leak the runtime so it lives for the entire app lifetime
            let rt = Box::leak(Box::new(rt));
            rt.spawn(async {
                obs_server::start_obs_server_async().await;
            });

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            list_overlays,
            get_overlay,
            save_overlay,
            delete_overlay,
            get_obs_url,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
