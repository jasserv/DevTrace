//! Configuration and workflow change records (Milestone 8: recording, review and verification).
//!
//! A change record is never inferred from an arbitrary captured event. Its `assertion` keeps
//! three different levels of evidence apart:
//! * `observed`  - recorded by DevTrace from a source the user authorized (for example a watched
//!   configuration file); the values are what DevTrace saw, nothing more;
//! * `declared`  - a change stated by the user;
//! * `verified`  - a change whose outcome was explicitly verified, with a note saying how.
//!
//! Review (approve or reject with a comment) is independent of verification. Observed values are
//! facts and cannot be edited; declared changes can be edited until they are reviewed.

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::clock;
use crate::error::{AppError, AppResult};
use crate::features::settings;
use crate::state::AppState;
use crate::validate::{self, TextRule};

text_enum! {
    pub enum ChangeAssertion {
        Observed => "observed",
        Declared => "declared",
        Verified => "verified",
    }
}

text_enum! {
    pub enum ApprovalState {
        Pending => "pending",
        Approved => "approved",
        Rejected => "rejected",
    }
}

text_enum! {
    /// How a change record was created.
    pub enum ChangeSource {
        /// Written by a user in Change History.
        Manual => "manual",
        /// Recorded when a configuration file the user chose to watch changed.
        FileWatch => "file_watch",
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeRecord {
    pub id: String,
    pub project_id: Option<String>,
    pub project_name: Option<String>,
    pub session_id: Option<String>,
    pub session_title: Option<String>,
    pub event_id: Option<String>,
    pub event_title: Option<String>,
    pub occurred_at: String,
    pub target: String,
    pub summary: String,
    pub environment: String,
    pub platform: String,
    pub version: String,
    pub before_value: Option<String>,
    pub after_value: Option<String>,
    pub assertion: ChangeAssertion,
    pub approval_state: ApprovalState,
    pub source: ChangeSource,
    pub review_comment: String,
    pub reviewer: String,
    pub reviewed_at: Option<String>,
    pub verification_note: String,
    pub verified_by: String,
    pub verified_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// A change declared or edited by a user.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChangeInput {
    pub target: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    /// RFC 3339; defaults to now.
    #[serde(default)]
    pub occurred_at: Option<String>,
    #[serde(default)]
    pub environment: String,
    #[serde(default)]
    pub platform: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub before_value: Option<String>,
    #[serde(default)]
    pub after_value: Option<String>,
}

/// A change DevTrace saw happen in a source the user authorized.
#[derive(Debug, Clone)]
pub struct ObservedChange {
    pub session_id: Option<String>,
    pub event_id: Option<String>,
    pub target: String,
    pub summary: String,
    pub before_value: Option<String>,
    pub after_value: Option<String>,
    pub source: ChangeSource,
}

const SELECT_CHANGE: &str = "
    SELECT c.id, c.project_id, p.name, c.session_id, s.title, c.event_id, e.title, c.occurred_at, c.target,
           c.summary, c.environment, c.platform, c.version, c.before_value, c.after_value, c.assertion,
           c.approval_state, c.source, c.review_comment, c.reviewer, c.reviewed_at, c.verification_note,
           c.verified_by, c.verified_at, c.created_at, c.updated_at
    FROM change_records c
    LEFT JOIN projects p ON p.id = c.project_id
    LEFT JOIN sessions s ON s.id = c.session_id
    LEFT JOIN events e ON e.id = c.event_id";

fn map_change(row: &Row<'_>) -> rusqlite::Result<ChangeRecord> {
    Ok(ChangeRecord {
        id: row.get(0)?,
        project_id: row.get(1)?,
        project_name: row.get(2)?,
        session_id: row.get(3)?,
        session_title: row.get(4)?,
        event_id: row.get(5)?,
        event_title: row.get(6)?,
        occurred_at: row.get(7)?,
        target: row.get(8)?,
        summary: row.get(9)?,
        environment: row.get(10)?,
        platform: row.get(11)?,
        version: row.get(12)?,
        before_value: row.get(13)?,
        after_value: row.get(14)?,
        assertion: row.get(15)?,
        approval_state: row.get(16)?,
        source: row.get(17)?,
        review_comment: row.get(18)?,
        reviewer: row.get(19)?,
        reviewed_at: row.get(20)?,
        verification_note: row.get(21)?,
        verified_by: row.get(22)?,
        verified_at: row.get(23)?,
        created_at: row.get(24)?,
        updated_at: row.get(25)?,
    })
}

/// Newest first by the time the change occurred.
pub fn list(connection: &Connection, limit: Option<u32>) -> AppResult<Vec<ChangeRecord>> {
    let sql = format!(
        "{SELECT_CHANGE} ORDER BY c.occurred_at DESC, c.created_at DESC LIMIT {}",
        limit.map_or(-1, i64::from)
    );
    let mut statement = connection.prepare(&sql)?;
    let changes = statement
        .query_map([], map_change)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(changes)
}

pub fn get(connection: &Connection, id: &str) -> AppResult<ChangeRecord> {
    let id = validate::id("id", id)?;
    connection
        .query_row(
            &format!("{SELECT_CHANGE} WHERE c.id = ?1"),
            [&id],
            map_change,
        )
        .optional()?
        .ok_or_else(|| AppError::not_found("Change", id))
}

const fn line(field: &'static str, label: &'static str, max_chars: usize) -> TextRule {
    TextRule {
        field,
        label,
        max_chars,
        required: false,
        multiline: false,
    }
}

const TARGET_RULE: TextRule = TextRule {
    field: "target",
    label: "What changed",
    max_chars: 300,
    required: true,
    multiline: false,
};
const SUMMARY_RULE: TextRule = TextRule {
    field: "summary",
    label: "Summary",
    max_chars: 2_000,
    required: false,
    multiline: true,
};
const VALUE_RULE: TextRule = TextRule {
    field: "values",
    label: "Value",
    max_chars: 100_000,
    required: false,
    multiline: true,
};
const COMMENT_RULE: TextRule = TextRule {
    field: "comment",
    label: "Comment",
    max_chars: 2_000,
    required: false,
    multiline: true,
};
const VERIFICATION_RULE: TextRule = TextRule {
    field: "note",
    label: "How the outcome was verified",
    max_chars: 2_000,
    required: true,
    multiline: true,
};

struct ValidChange {
    target: String,
    summary: String,
    project_id: Option<String>,
    session_id: Option<String>,
    occurred_at: String,
    environment: String,
    platform: String,
    version: String,
    before_value: Option<String>,
    after_value: Option<String>,
}

fn optional_reference(
    connection: &Connection,
    field: &'static str,
    table: &str,
    value: Option<&str>,
    missing: &str,
) -> AppResult<Option<String>> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let id = validate::id(field, value)?;
    let exists: bool = connection.query_row(
        &format!("SELECT EXISTS (SELECT 1 FROM {table} WHERE id = ?1)"),
        [&id],
        |row| row.get(0),
    )?;
    if !exists {
        return Err(AppError::validation(field, missing));
    }
    Ok(Some(id))
}

fn value(raw: Option<&str>) -> AppResult<Option<String>> {
    match raw {
        Some(text) if !text.is_empty() => {
            // Values are kept verbatim (configuration is whitespace-sensitive); only the length
            // is limited.
            if text.chars().count() > VALUE_RULE.max_chars {
                return Err(AppError::validation(
                    "values",
                    "Before and after values can have at most 100000 characters each.",
                ));
            }
            Ok(Some(text.replace("\r\n", "\n")))
        }
        _ => Ok(None),
    }
}

fn validated(connection: &Connection, input: &ChangeInput) -> AppResult<ValidChange> {
    let occurred_at = match input.occurred_at.as_deref().map(str::trim) {
        Some(raw) if !raw.is_empty() => {
            let parsed = chrono::DateTime::parse_from_rfc3339(raw)
                .map_err(|_| AppError::validation("occurredAt", "Enter a valid date and time."))?;
            parsed
                .with_timezone(&chrono::Utc)
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        }
        _ => clock::now(),
    };
    let before_value = value(input.before_value.as_deref())?;
    let after_value = value(input.after_value.as_deref())?;
    if before_value.is_none() && after_value.is_none() {
        return Err(AppError::validation(
            "values",
            "Enter the value before or after the change (or both).",
        ));
    }
    Ok(ValidChange {
        target: validate::text(&TARGET_RULE, &input.target)?,
        summary: validate::preformatted(&SUMMARY_RULE, &input.summary)?,
        project_id: optional_reference(
            connection,
            "projectId",
            "projects",
            input.project_id.as_deref(),
            "The selected project no longer exists. Choose another project.",
        )?,
        session_id: optional_reference(
            connection,
            "sessionId",
            "sessions",
            input.session_id.as_deref(),
            "The selected session no longer exists. Choose another session.",
        )?,
        occurred_at,
        environment: validate::text(&line("environment", "Environment", 60), &input.environment)?,
        platform: validate::text(&line("platform", "Platform", 120), &input.platform)?,
        version: validate::text(&line("version", "Version", 60), &input.version)?,
        before_value,
        after_value,
    })
}

fn person(connection: &Connection) -> String {
    settings::load(connection)
        .map(|loaded| loaded.author_name)
        .unwrap_or_default()
}

/// Records a change stated by the user (`declared`, pending review).
pub fn declare(connection: &Connection, input: &ChangeInput) -> AppResult<ChangeRecord> {
    let valid = validated(connection, input)?;
    let id = clock::new_id();
    let now = clock::now();
    connection.execute(
        "INSERT INTO change_records (id, project_id, session_id, occurred_at, target, summary, environment, platform,
                                     version, before_value, after_value, assertion, approval_state, source,
                                     created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'declared', 'pending', 'manual', ?12, ?12)",
        params![
            id,
            valid.project_id,
            valid.session_id,
            valid.occurred_at,
            valid.target,
            valid.summary,
            valid.environment,
            valid.platform,
            valid.version,
            valid.before_value,
            valid.after_value,
            now
        ],
    )?;
    get(connection, &id)
}

/// Edits a declared change that has not been reviewed or verified yet.
pub fn update(connection: &Connection, id: &str, input: &ChangeInput) -> AppResult<ChangeRecord> {
    let current = get(connection, id)?;
    if current.assertion != ChangeAssertion::Declared {
        return Err(AppError::conflict(
            "assertion",
            if current.assertion == ChangeAssertion::Observed {
                "Observed values are what DevTrace recorded and cannot be edited."
            } else {
                "A verified change cannot be edited."
            },
        ));
    }
    if current.approval_state != ApprovalState::Pending {
        return Err(AppError::conflict(
            "approvalState",
            "This change was already reviewed. Reset the review to edit it.",
        ));
    }
    let valid = validated(connection, input)?;
    connection.execute(
        "UPDATE change_records SET project_id = ?2, session_id = ?3, occurred_at = ?4, target = ?5, summary = ?6,
                environment = ?7, platform = ?8, version = ?9, before_value = ?10, after_value = ?11, updated_at = ?12
         WHERE id = ?1",
        params![
            current.id,
            valid.project_id,
            valid.session_id,
            valid.occurred_at,
            valid.target,
            valid.summary,
            valid.environment,
            valid.platform,
            valid.version,
            valid.before_value,
            valid.after_value,
            clock::now()
        ],
    )?;
    get(connection, &current.id)
}

/// Approves, rejects or resets the review of a change, with an optional comment.
pub fn review(
    connection: &Connection,
    id: &str,
    state: ApprovalState,
    comment: &str,
) -> AppResult<ChangeRecord> {
    let current = get(connection, id)?;
    let comment = validate::preformatted(&COMMENT_RULE, comment)?;
    if state == ApprovalState::Rejected && current.assertion == ChangeAssertion::Verified {
        return Err(AppError::conflict(
            "approvalState",
            "A verified change cannot be rejected.",
        ));
    }
    let now = clock::now();
    let (reviewer, reviewed_at) = if state == ApprovalState::Pending {
        (String::new(), None)
    } else {
        (person(connection), Some(now.clone()))
    };
    connection.execute(
        "UPDATE change_records SET approval_state = ?2, review_comment = ?3, reviewer = ?4, reviewed_at = ?5, updated_at = ?6
         WHERE id = ?1",
        params![current.id, state, comment, reviewer, reviewed_at, now],
    )?;
    get(connection, &current.id)
}

/// Marks a change as verified. The note saying how the outcome was checked is required:
/// DevTrace never verifies anything on its own.
pub fn verify(connection: &Connection, id: &str, note: &str) -> AppResult<ChangeRecord> {
    let current = get(connection, id)?;
    let note = validate::preformatted(&VERIFICATION_RULE, note)?;
    if current.approval_state == ApprovalState::Rejected {
        return Err(AppError::conflict(
            "approvalState",
            "A rejected change cannot be verified.",
        ));
    }
    let now = clock::now();
    connection.execute(
        "UPDATE change_records SET assertion = 'verified', verification_note = ?2, verified_by = ?3, verified_at = ?4,
                updated_at = ?4
         WHERE id = ?1",
        params![current.id, note, person(connection), now],
    )?;
    get(connection, &current.id)
}

pub fn delete(connection: &Connection, id: &str) -> AppResult<String> {
    let current = get(connection, id)?;
    connection.execute("DELETE FROM change_records WHERE id = ?1", [&current.id])?;
    Ok(current.target)
}

/// Records a change DevTrace observed (`observed`, pending review). The project and environment
/// are taken from the session when there is one.
pub fn record_observed(
    connection: &Connection,
    change: &ObservedChange,
) -> AppResult<ChangeRecord> {
    let id = clock::new_id();
    let now = clock::now();
    let session: Option<(Option<String>, String, String)> = match &change.session_id {
        Some(session_id) => connection
            .query_row(
                "SELECT project_id, environment, application FROM sessions WHERE id = ?1",
                [session_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?,
        None => None,
    };
    let (project_id, environment, platform) = session.unwrap_or_default();
    connection.execute(
        "INSERT INTO change_records (id, project_id, session_id, event_id, occurred_at, target, summary, environment,
                                     platform, before_value, after_value, assertion, approval_state, source,
                                     created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'observed', 'pending', ?12, ?5, ?5)",
        params![
            id,
            project_id,
            change.session_id,
            change.event_id,
            now,
            truncate_start(&change.target, 300),
            change.summary,
            truncate_chars(&environment, 60),
            truncate_chars(&platform, 120),
            change.before_value,
            change.after_value,
            change.source,
        ],
    )?;
    get(connection, &id)
}

fn truncate_chars(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// Keeps the end of long text (file paths are most useful at their end).
pub fn truncate_start(text: &str, max: usize) -> String {
    let count = text.chars().count();
    if count <= max {
        return text.to_string();
    }
    let tail: String = text.chars().skip(count - (max - 1)).collect();
    format!("\u{2026}{tail}")
}

// ---------------------------------------------------------------------------------------------
// Commands

#[tauri::command]
pub async fn list_changes(state: State<'_, AppState>) -> AppResult<Vec<ChangeRecord>> {
    state.with_db(|connection| list(connection, None))
}

#[tauri::command]
pub async fn declare_change(
    state: State<'_, AppState>,
    input: ChangeInput,
) -> AppResult<ChangeRecord> {
    state.with_db(|connection| declare(connection, &input))
}

#[tauri::command]
pub async fn update_change(
    state: State<'_, AppState>,
    id: String,
    input: ChangeInput,
) -> AppResult<ChangeRecord> {
    state.with_db(|connection| update(connection, &id, &input))
}

#[tauri::command]
pub async fn review_change(
    state: State<'_, AppState>,
    id: String,
    approval_state: ApprovalState,
    comment: Option<String>,
) -> AppResult<ChangeRecord> {
    state.with_db(|connection| {
        review(
            connection,
            &id,
            approval_state,
            comment.as_deref().unwrap_or_default(),
        )
    })
}

#[tauri::command]
pub async fn verify_change(
    state: State<'_, AppState>,
    id: String,
    note: String,
) -> AppResult<ChangeRecord> {
    state.with_db(|connection| verify(connection, &id, &note))
}

#[tauri::command]
pub async fn delete_change(state: State<'_, AppState>, id: String) -> AppResult<String> {
    state.with_db(|connection| delete(connection, &id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn input(target: &str) -> ChangeInput {
        ChangeInput {
            target: target.into(),
            before_value: Some("PermitRootLogin yes".into()),
            after_value: Some("PermitRootLogin no".into()),
            environment: "Production".into(),
            ..ChangeInput::default()
        }
    }

    #[test]
    fn defaults_to_declared_and_pending() {
        let connection = db::open_in_memory();
        connection
            .execute_batch(
                "INSERT INTO change_records (id, occurred_at, target, before_value, after_value, created_at, updated_at)
                   VALUES ('c1', '2026-01-01T00:00:00.000Z', 'sshd_config: PermitRootLogin', 'yes', 'no', 't', 't');",
            )
            .unwrap();
        let changes = list(&connection, None).unwrap();
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].assertion, ChangeAssertion::Declared);
        assert_eq!(changes[0].approval_state, ApprovalState::Pending);
        assert_eq!(changes[0].source, ChangeSource::Manual);
        assert_eq!(changes[0].before_value.as_deref(), Some("yes"));
    }

    #[test]
    fn declares_validates_and_edits_until_reviewed() {
        let connection = db::open_in_memory();
        let change = declare(&connection, &input("/etc/ssh/sshd_config")).unwrap();
        assert_eq!(change.assertion, ChangeAssertion::Declared);
        assert_eq!(change.approval_state, ApprovalState::Pending);
        assert_eq!(change.environment, "Production");

        let mut no_values = input("x");
        no_values.before_value = None;
        no_values.after_value = Some(String::new());
        assert_eq!(
            declare(&connection, &no_values).unwrap_err().field(),
            Some("values")
        );
        assert_eq!(
            declare(&connection, &input("  ")).unwrap_err().field(),
            Some("target")
        );
        let mut bad_session = input("x");
        bad_session.session_id = Some(clock::new_id());
        assert_eq!(
            declare(&connection, &bad_session).unwrap_err().field(),
            Some("sessionId")
        );
        let mut bad_time = input("x");
        bad_time.occurred_at = Some("yesterday".into());
        assert_eq!(
            declare(&connection, &bad_time).unwrap_err().field(),
            Some("occurredAt")
        );

        let mut edited = input("/etc/ssh/sshd_config");
        edited.summary = "Disable root login".into();
        assert_eq!(
            update(&connection, &change.id, &edited).unwrap().summary,
            "Disable root login"
        );
        review(
            &connection,
            &change.id,
            ApprovalState::Approved,
            "Matches CHG-7",
        )
        .unwrap();
        assert_eq!(
            update(&connection, &change.id, &edited).unwrap_err().kind(),
            "conflict"
        );
    }

    #[test]
    fn review_and_verification_are_explicit() {
        let connection = db::open_in_memory();
        let change = declare(&connection, &input("firewall policy 12")).unwrap();
        let approved = review(
            &connection,
            &change.id,
            ApprovalState::Approved,
            "Looks right",
        )
        .unwrap();
        assert_eq!(approved.approval_state, ApprovalState::Approved);
        assert_eq!(approved.review_comment, "Looks right");
        assert!(approved.reviewed_at.is_some());

        assert_eq!(
            verify(&connection, &change.id, "  ").unwrap_err().field(),
            Some("note")
        );
        let verified = verify(&connection, &change.id, "Tested SSH as root: refused").unwrap();
        assert_eq!(verified.assertion, ChangeAssertion::Verified);
        assert_eq!(verified.verification_note, "Tested SSH as root: refused");
        assert!(verified.verified_at.is_some());
        assert_eq!(
            review(&connection, &change.id, ApprovalState::Rejected, "")
                .unwrap_err()
                .kind(),
            "conflict"
        );

        let other = declare(&connection, &input("other")).unwrap();
        review(
            &connection,
            &other.id,
            ApprovalState::Rejected,
            "Wrong host",
        )
        .unwrap();
        assert_eq!(
            verify(&connection, &other.id, "Checked")
                .unwrap_err()
                .kind(),
            "conflict"
        );
        let reset = review(&connection, &other.id, ApprovalState::Pending, "").unwrap();
        assert_eq!(reset.approval_state, ApprovalState::Pending);
        assert!(reset.reviewed_at.is_none());

        assert_eq!(delete(&connection, &other.id).unwrap(), "other");
        assert_eq!(get(&connection, &other.id).unwrap_err().kind(), "not_found");
    }

    #[test]
    fn observed_changes_keep_their_values() {
        let connection = db::open_in_memory();
        let observed = record_observed(
            &connection,
            &ObservedChange {
                session_id: None,
                event_id: None,
                target: format!("C:\\{}\\nginx.conf", "very-long-folder\\".repeat(30)),
                summary: "2 lines changed".into(),
                before_value: Some("listen 80;".into()),
                after_value: Some("listen 8080;".into()),
                source: ChangeSource::FileWatch,
            },
        )
        .unwrap();
        assert_eq!(observed.assertion, ChangeAssertion::Observed);
        assert_eq!(observed.source, ChangeSource::FileWatch);
        assert!(observed.target.starts_with('\u{2026}'));
        assert!(observed.target.ends_with("nginx.conf"));
        assert_eq!(observed.target.chars().count(), 300);
        assert!(
            update(&connection, &observed.id, &input("x"))
                .unwrap_err()
                .to_string()
                .contains("cannot be edited")
        );
    }
}
