//! Managed on-disk locations for a DevTrace workspace.
//!
//! A workspace is one data directory containing the SQLite database plus managed folders
//! for attachments (screenshots, large files), exports and automatic backups. Database rows
//! only ever store paths *relative* to these folders, so a workspace can be moved or backed
//! up as a single directory.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime};

use crate::error::{AppError, AppResult};

pub const DATABASE_FILE_NAME: &str = "devtrace.sqlite3";

/// Environment variable that redirects the workspace directory. Used by automated tests so
/// they never read or modify a user's real data.
pub const DATA_DIR_ENV: &str = "DEVTRACE_DATA_DIR";

#[derive(Debug, Clone)]
pub struct AppPaths {
    pub data_dir: PathBuf,
    pub database_file: PathBuf,
    pub attachments_dir: PathBuf,
    /// Copies of evidence used by playbooks, one folder per playbook.
    pub assets_dir: PathBuf,
    /// Terminal log files the user's terminal writes to, one folder per session.
    pub terminal_logs_dir: PathBuf,
    pub exports_dir: PathBuf,
    pub backups_dir: PathBuf,
    /// Local crash reports (created when the first report is written).
    pub logs_dir: PathBuf,
}

impl AppPaths {
    pub fn resolve<R: Runtime>(app: &AppHandle<R>) -> AppResult<Self> {
        if let Some(dir) = std::env::var_os(DATA_DIR_ENV).filter(|value| !value.is_empty()) {
            return Ok(Self::from_root(PathBuf::from(dir)));
        }
        let dir = app.path().app_data_dir().map_err(|error| {
            AppError::internal(format!("Cannot resolve the app data directory: {error}"))
        })?;
        Ok(Self::from_root(dir))
    }

    pub fn from_root(root: impl AsRef<Path>) -> Self {
        let root = root.as_ref().to_path_buf();
        Self {
            database_file: root.join(DATABASE_FILE_NAME),
            attachments_dir: root.join("attachments"),
            assets_dir: root.join("playbook-assets"),
            terminal_logs_dir: root.join("terminal-logs"),
            exports_dir: root.join("exports"),
            backups_dir: root.join("backups"),
            logs_dir: root.join("logs"),
            data_dir: root,
        }
    }

    /// Creates the workspace folders if they do not exist. Never deletes anything.
    pub fn ensure_dirs(&self) -> AppResult<()> {
        for dir in [
            &self.data_dir,
            &self.attachments_dir,
            &self.assets_dir,
            &self.terminal_logs_dir,
            &self.exports_dir,
            &self.backups_dir,
        ] {
            std::fs::create_dir_all(dir)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_all_locations_from_root() {
        let paths = AppPaths::from_root("C:/data/devtrace");
        assert!(paths.database_file.ends_with(DATABASE_FILE_NAME));
        assert!(paths.attachments_dir.ends_with("attachments"));
        assert!(paths.exports_dir.ends_with("exports"));
        assert!(paths.backups_dir.ends_with("backups"));
    }

    #[test]
    fn ensure_dirs_creates_missing_folders() {
        let temp = tempfile::tempdir().unwrap();
        let paths = AppPaths::from_root(temp.path().join("workspace"));
        paths.ensure_dirs().unwrap();
        assert!(paths.attachments_dir.is_dir());
        assert!(paths.exports_dir.is_dir());
        assert!(paths.backups_dir.is_dir());
    }
}
