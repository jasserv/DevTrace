//! Application error type shared by every layer of the backend.
//!
//! Errors cross the IPC boundary as `{ kind, message, field }` so the frontend can show
//! precise messages (for example, attach a validation error to the offending form field)
//! without parsing strings.

use serde::ser::{Serialize, SerializeStruct, Serializer};

pub type AppResult<T> = Result<T, AppError>;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    /// User input failed validation. `field` names the input that should show the message.
    #[error("{message}")]
    Validation {
        field: &'static str,
        message: String,
    },

    #[error("{entity} was not found. It may have been deleted.")]
    NotFound { entity: &'static str, id: String },

    /// The request conflicts with existing data (for example, a duplicate name).
    #[error("{message}")]
    Conflict {
        field: &'static str,
        message: String,
    },

    /// The workspace database could not be opened at startup.
    #[error("Local storage is unavailable: {0}")]
    StorageUnavailable(String),

    #[error("Database error: {0}")]
    Database(#[from] rusqlite::Error),

    #[error("File system error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Data error: {0}")]
    Serialization(#[from] serde_json::Error),

    #[error("{0}")]
    Internal(String),
}

impl AppError {
    pub fn validation(field: &'static str, message: impl Into<String>) -> Self {
        Self::Validation {
            field,
            message: message.into(),
        }
    }

    pub fn not_found(entity: &'static str, id: impl Into<String>) -> Self {
        Self::NotFound {
            entity,
            id: id.into(),
        }
    }

    pub fn conflict(field: &'static str, message: impl Into<String>) -> Self {
        Self::Conflict {
            field,
            message: message.into(),
        }
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::Internal(message.into())
    }

    /// Stable machine-readable error category used by the frontend.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Validation { .. } => "validation",
            Self::NotFound { .. } => "not_found",
            Self::Conflict { .. } => "conflict",
            Self::StorageUnavailable(_) => "storage_unavailable",
            Self::Database(_) => "database",
            Self::Io(_) => "io",
            Self::Serialization(_) => "serialization",
            Self::Internal(_) => "internal",
        }
    }

    pub fn field(&self) -> Option<&'static str> {
        match self {
            Self::Validation { field, .. } | Self::Conflict { field, .. } => Some(field),
            _ => None,
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut state = serializer.serialize_struct("AppError", 3)?;
        state.serialize_field("kind", self.kind())?;
        state.serialize_field("message", &self.to_string())?;
        state.serialize_field("field", &self.field())?;
        state.end()
    }
}

/// Returns true when a SQLite error is a UNIQUE constraint violation.
pub fn is_unique_violation(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(inner, _)
            if inner.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_kind_message_and_field() {
        let error = AppError::validation("name", "Name is required.");
        let json = serde_json::to_value(&error).unwrap();
        assert_eq!(json["kind"], "validation");
        assert_eq!(json["message"], "Name is required.");
        assert_eq!(json["field"], "name");
    }

    #[test]
    fn non_field_errors_serialize_null_field() {
        let error = AppError::not_found("Project", "abc");
        let json = serde_json::to_value(&error).unwrap();
        assert_eq!(json["kind"], "not_found");
        assert!(json["field"].is_null());
    }
}
