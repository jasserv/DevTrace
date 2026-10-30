//! Application and workspace diagnostics shown in Settings and the workspace selector.

use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

use crate::db::migrations;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub identifier: String,
    pub os: &'static str,
    pub arch: &'static str,
    pub debug_build: bool,
    pub tauri_version: &'static str,
    pub sqlite_version: &'static str,
    pub data_dir: String,
    pub database_file: String,
    pub attachments_dir: String,
    pub exports_dir: String,
    pub backups_dir: String,
    pub schema_version: Option<u32>,
    pub latest_schema_version: u32,
    pub storage_ready: bool,
    pub storage_error: Option<String>,
    /// Whether this build can export PDF files (WebView2 printing, Windows only).
    pub pdf_export_supported: bool,
}

#[tauri::command]
pub async fn get_app_info(app: AppHandle, state: State<'_, AppState>) -> AppResult<AppInfo> {
    let schema_version = state
        .with_db(|connection| migrations::current_version(connection))
        .ok();
    let package = app.package_info();
    let paths = &state.paths;
    Ok(AppInfo {
        name: package.name.clone(),
        version: package.version.to_string(),
        identifier: app.config().identifier.clone(),
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        debug_build: cfg!(debug_assertions),
        tauri_version: tauri::VERSION,
        sqlite_version: rusqlite::version(),
        data_dir: paths.data_dir.display().to_string(),
        database_file: paths.database_file.display().to_string(),
        attachments_dir: paths.attachments_dir.display().to_string(),
        exports_dir: paths.exports_dir.display().to_string(),
        backups_dir: paths.backups_dir.display().to_string(),
        schema_version,
        latest_schema_version: migrations::latest_version(),
        storage_ready: state.storage_ready(),
        storage_error: state.storage_error.clone(),
        pdf_export_supported: crate::export::pdf::SUPPORTED,
    })
}

/// Opens the workspace folder in the system file manager. Implemented in Rust so the webview
/// never needs a general-purpose "open path" permission.
#[tauri::command]
pub async fn reveal_data_directory(app: AppHandle, state: State<'_, AppState>) -> AppResult<()> {
    let paths = &state.paths;
    let target = if paths.database_file.exists() {
        &paths.database_file
    } else {
        &paths.data_dir
    };
    app.opener().reveal_item_in_dir(target).map_err(|error| {
        AppError::internal(format!("Could not open the workspace folder: {error}"))
    })
}
