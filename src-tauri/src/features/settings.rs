//! Persisted application settings (the `ApplicationSettings` entity).
//!
//! Stored as one row per key in `app_settings` with JSON values, so new settings can be added
//! without schema migrations. Missing or unreadable values fall back to defaults instead of
//! blocking startup.

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, State};

use crate::clock;
use crate::error::AppResult;
use crate::state::AppState;
use crate::validate::{self, TextRule};

text_enum! {
    /// Requested color theme. `System` follows the operating system setting.
    pub enum ThemePreference {
        System => "system",
        Light => "light",
        Dark => "dark",
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub theme: ThemePreference,
    pub reduce_motion: bool,
    pub sidebar_collapsed: bool,
    pub workspace_name: String,
    pub author_name: String,
    /// Global shortcut that takes a screenshot while a capture is recording.
    pub capture_shortcut: String,
}

pub const DEFAULT_WORKSPACE_NAME: &str = "Local Workspace";

/// Shortcuts offered for capturing. A fixed list avoids collisions with common editor and
/// operating system shortcuts and keeps the value easy to validate.
pub const CAPTURE_SHORTCUTS: [&str; 4] =
    ["Ctrl+Alt+Shift+S", "Ctrl+Shift+F9", "Ctrl+Alt+F10", "Pause"];

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: ThemePreference::System,
            reduce_motion: false,
            sidebar_collapsed: false,
            workspace_name: DEFAULT_WORKSPACE_NAME.to_string(),
            author_name: String::new(),
            capture_shortcut: CAPTURE_SHORTCUTS[0].to_string(),
        }
    }
}

/// Partial update. Absent fields are left unchanged; unknown fields are rejected.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsPatch {
    pub theme: Option<ThemePreference>,
    pub reduce_motion: Option<bool>,
    pub sidebar_collapsed: Option<bool>,
    pub workspace_name: Option<String>,
    pub author_name: Option<String>,
    pub capture_shortcut: Option<String>,
}

const KEY_THEME: &str = "appearance.theme";
const KEY_REDUCE_MOTION: &str = "appearance.reduce_motion";
const KEY_SIDEBAR_COLLAPSED: &str = "appearance.sidebar_collapsed";
const KEY_WORKSPACE_NAME: &str = "workspace.name";
const KEY_AUTHOR_NAME: &str = "profile.author_name";
const KEY_CAPTURE_SHORTCUT: &str = "capture.shortcut";

const WORKSPACE_NAME_RULE: TextRule = TextRule {
    field: "workspaceName",
    label: "Workspace name",
    max_chars: 60,
    required: true,
    multiline: false,
};

const AUTHOR_NAME_RULE: TextRule = TextRule {
    field: "authorName",
    label: "Author name",
    max_chars: 80,
    required: false,
    multiline: false,
};

pub fn load(connection: &Connection) -> AppResult<AppSettings> {
    let mut settings = AppSettings::default();
    let mut statement = connection.prepare("SELECT key, value_json FROM app_settings")?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    for row in rows {
        let (key, raw) = row?;
        let Ok(value) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        match key.as_str() {
            KEY_THEME => {
                if let Some(theme) = value.as_str().and_then(ThemePreference::parse) {
                    settings.theme = theme;
                }
            }
            KEY_REDUCE_MOTION => {
                if let Some(flag) = value.as_bool() {
                    settings.reduce_motion = flag;
                }
            }
            KEY_SIDEBAR_COLLAPSED => {
                if let Some(flag) = value.as_bool() {
                    settings.sidebar_collapsed = flag;
                }
            }
            KEY_WORKSPACE_NAME => {
                if let Some(name) = value.as_str().filter(|name| !name.trim().is_empty()) {
                    settings.workspace_name = name.to_string();
                }
            }
            KEY_AUTHOR_NAME => {
                if let Some(name) = value.as_str() {
                    settings.author_name = name.to_string();
                }
            }
            KEY_CAPTURE_SHORTCUT => {
                if let Some(shortcut) = value
                    .as_str()
                    .filter(|value| CAPTURE_SHORTCUTS.contains(value))
                {
                    settings.capture_shortcut = shortcut.to_string();
                }
            }
            _ => {}
        }
    }
    Ok(settings)
}

/// Validates every field first, then writes all changes in one transaction (all or nothing).
pub fn update(connection: &mut Connection, patch: SettingsPatch) -> AppResult<AppSettings> {
    let mut changes: Vec<(&str, Value)> = Vec::new();
    if let Some(theme) = patch.theme {
        changes.push((KEY_THEME, json!(theme.as_str())));
    }
    if let Some(flag) = patch.reduce_motion {
        changes.push((KEY_REDUCE_MOTION, json!(flag)));
    }
    if let Some(flag) = patch.sidebar_collapsed {
        changes.push((KEY_SIDEBAR_COLLAPSED, json!(flag)));
    }
    if let Some(name) = patch.workspace_name {
        changes.push((
            KEY_WORKSPACE_NAME,
            json!(validate::text(&WORKSPACE_NAME_RULE, &name)?),
        ));
    }
    if let Some(name) = patch.author_name {
        changes.push((
            KEY_AUTHOR_NAME,
            json!(validate::text(&AUTHOR_NAME_RULE, &name)?),
        ));
    }
    if let Some(shortcut) = patch.capture_shortcut {
        if !CAPTURE_SHORTCUTS.contains(&shortcut.as_str()) {
            return Err(crate::error::AppError::validation(
                "captureShortcut",
                "Choose one of the offered capture shortcuts.",
            ));
        }
        changes.push((KEY_CAPTURE_SHORTCUT, json!(shortcut)));
    }

    if !changes.is_empty() {
        let now = clock::now();
        let transaction = connection.transaction()?;
        for (key, value) in changes {
            transaction.execute(
                "INSERT INTO app_settings (key, value_json, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
                params![key, value.to_string(), now],
            )?;
        }
        transaction.commit()?;
    }
    load(connection)
}

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> AppResult<AppSettings> {
    state.with_db(|connection| load(connection))
}

/// Saves settings. A changed capture shortcut takes effect immediately, also mid-capture.
#[tauri::command]
pub async fn update_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    patch: SettingsPatch,
) -> AppResult<AppSettings> {
    let saved = state.with_db(|connection| update(connection, patch))?;
    crate::capture::shortcut_changed(&app, &saved.capture_shortcut);
    Ok(saved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    #[test]
    fn returns_defaults_for_a_new_workspace() {
        let connection = db::open_in_memory();
        assert_eq!(load(&connection).unwrap(), AppSettings::default());
    }

    #[test]
    fn persists_partial_updates() {
        let mut connection = db::open_in_memory();
        let updated = update(
            &mut connection,
            SettingsPatch {
                theme: Some(ThemePreference::Dark),
                workspace_name: Some("  Network Lab  ".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(updated.theme, ThemePreference::Dark);
        assert_eq!(updated.workspace_name, "Network Lab");
        assert!(!updated.reduce_motion);
        assert_eq!(load(&connection).unwrap(), updated);
    }

    #[test]
    fn rejects_invalid_values_without_partial_writes() {
        let mut connection = db::open_in_memory();
        let error = update(
            &mut connection,
            SettingsPatch {
                theme: Some(ThemePreference::Light),
                workspace_name: Some("   ".into()),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert_eq!(error.field(), Some("workspaceName"));
        assert_eq!(load(&connection).unwrap().theme, ThemePreference::System);
    }

    #[test]
    fn ignores_corrupt_or_unknown_rows() {
        let connection = db::open_in_memory();
        connection
            .execute_batch(
                "INSERT INTO app_settings VALUES ('appearance.theme', '\"purple\"', 't');
                 INSERT INTO app_settings VALUES ('future.setting', '42', 't');",
            )
            .unwrap();
        assert_eq!(load(&connection).unwrap(), AppSettings::default());
    }

    #[test]
    fn patch_rejects_unknown_fields() {
        let result: Result<SettingsPatch, _> = serde_json::from_str(r#"{"telemetry": true}"#);
        assert!(result.is_err());
    }
}
