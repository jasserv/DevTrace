//! System file dialogs, shown from Rust: the webview has no dialog or file-system permission and
//! never supplies a path. Each dialog has a test hook — an environment variable that, when set,
//! supplies the path instead of showing the dialog. Only the automated end-to-end test sets them,
//! together with an isolated workspace; they give no access beyond what the user who starts
//! DevTrace already has.

use std::path::PathBuf;

use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

/// Test hook: the file "Watch a file…" picks.
pub const PICK_WATCH_FILE_ENV: &str = "DEVTRACE_E2E_PICK_FILE";
/// Test hook: the backup "Restore from backup…" picks.
pub const PICK_BACKUP_ENV: &str = "DEVTRACE_E2E_PICK_BACKUP";
/// Test hook: where "Back up workspace…" saves.
pub const SAVE_BACKUP_ENV: &str = "DEVTRACE_E2E_SAVE_BACKUP";

fn hooked(hook: &str) -> Option<PathBuf> {
    std::env::var_os(hook)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// Shows an open-file dialog; `None` when cancelled.
pub fn pick_file(
    app: &AppHandle,
    title: &str,
    filter: Option<(&str, &[&str])>,
    hook: &str,
) -> Option<PathBuf> {
    if let Some(path) = hooked(hook) {
        return Some(path);
    }
    let mut dialog = app.dialog().file().set_title(title);
    if let Some((name, extensions)) = filter {
        dialog = dialog.add_filter(name, extensions);
    }
    dialog
        .blocking_pick_file()
        .and_then(|picked| picked.into_path().ok())
}

/// Shows a save-file dialog proposing `file_name`; `None` when cancelled.
pub fn save_file(
    app: &AppHandle,
    title: &str,
    file_name: &str,
    filter: (&str, &[&str]),
    hook: &str,
) -> Option<PathBuf> {
    if let Some(path) = hooked(hook) {
        return Some(path);
    }
    app.dialog()
        .file()
        .set_title(title)
        .set_file_name(file_name)
        .add_filter(filter.0, filter.1)
        .blocking_save_file()
        .and_then(|picked| picked.into_path().ok())
}
