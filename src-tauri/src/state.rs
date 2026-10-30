//! Shared application state managed by Tauri.

use std::sync::Mutex;

use rusqlite::Connection;

use crate::error::{AppError, AppResult};
use crate::paths::AppPaths;

pub struct AppState {
    db: Mutex<Option<Connection>>,
    pub paths: AppPaths,
    /// Set when the database could not be opened. The UI shows this instead of crashing,
    /// because release builds have no console where a startup panic would be visible.
    pub storage_error: Option<String>,
}

impl AppState {
    pub fn ready(connection: Connection, paths: AppPaths) -> Self {
        Self {
            db: Mutex::new(Some(connection)),
            paths,
            storage_error: None,
        }
    }

    pub fn unavailable(error: String, paths: AppPaths) -> Self {
        Self {
            db: Mutex::new(None),
            paths,
            storage_error: Some(error),
        }
    }

    pub fn storage_ready(&self) -> bool {
        self.storage_error.is_none()
    }

    /// Runs `operation` with exclusive access to the workspace database.
    pub fn with_db<T>(
        &self,
        operation: impl FnOnce(&mut Connection) -> AppResult<T>,
    ) -> AppResult<T> {
        let mut guard = self.db.lock().map_err(|_| {
            AppError::internal("The database lock was poisoned by an earlier failure.")
        })?;
        match guard.as_mut() {
            Some(connection) => operation(connection),
            None => Err(AppError::StorageUnavailable(
                self.storage_error
                    .clone()
                    .unwrap_or_else(|| "the database is not open".into()),
            )),
        }
    }

    /// Hands the open connection to `operation`, which may close it (for example to replace the
    /// database file while restoring a backup), and stores the connection it returns. The lock is
    /// held throughout, so no other command can use the database in between. Returning `None`
    /// leaves the workspace without an open database until DevTrace is restarted.
    pub fn replace_database<T>(
        &self,
        operation: impl FnOnce(Connection) -> (Option<Connection>, AppResult<T>),
    ) -> AppResult<T> {
        let mut guard = self.db.lock().map_err(|_| {
            AppError::internal("The database lock was poisoned by an earlier failure.")
        })?;
        let Some(connection) = guard.take() else {
            return Err(AppError::StorageUnavailable(
                self.storage_error
                    .clone()
                    .unwrap_or_else(|| "the database is not open".into()),
            ));
        };
        let (connection, result) = operation(connection);
        *guard = connection;
        result
    }
}
