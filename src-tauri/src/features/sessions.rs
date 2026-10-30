//! Capture sessions: one technical task with its ordered events, evidence and notes.
//!
//! Status in Milestone 2 is `draft` (being documented) or `completed` (documentation finished;
//! steps and evidence become read-only until the session is reopened). `recording` and
//! `paused` are reserved for native capture (Milestone 3) and cannot be set here.

use std::path::Path;

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::clock;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::storage::{self, FileCleanup};
use crate::validate::{self, TextRule};

text_enum! {
    /// Lifecycle of a capture session.
    pub enum SessionStatus {
        Draft => "draft",
        Recording => "recording",
        Paused => "paused",
        Completed => "completed",
    }
}

text_enum! {
    /// Human review progress for the evidence captured in a session.
    pub enum ReviewState {
        Unreviewed => "unreviewed",
        InReview => "in_review",
        Reviewed => "reviewed",
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub title: String,
    pub project_id: Option<String>,
    pub project_name: Option<String>,
    pub application: String,
    pub environment: String,
    pub status: SessionStatus,
    pub review_state: ReviewState,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub playbook_count: i64,
    pub event_count: i64,
    pub attachment_count: i64,
}

/// A session with the fields needed by the session workspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDetail {
    #[serde(flatten)]
    pub summary: SessionSummary,
    pub notes: String,
    /// Total size of the session's stored evidence files.
    pub attachment_bytes: i64,
    /// Change records that reference this session.
    pub change_count: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionInput {
    pub title: String,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub application: String,
    #[serde(default)]
    pub environment: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesSaved {
    pub updated_at: String,
}

/// Exactly what a session deletion removed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDeletion {
    pub id: String,
    pub title: String,
    pub event_count: i64,
    pub attachment_count: i64,
    /// Playbooks keep their content but lose the link to this session.
    pub unlinked_playbooks: i64,
    /// Change records are kept without a session reference.
    pub unlinked_changes: i64,
    pub files: FileCleanup,
}

pub const TITLE_RULE: TextRule = TextRule {
    field: "title",
    label: "Session title",
    max_chars: 200,
    required: true,
    multiline: false,
};

pub const APPLICATION_RULE: TextRule = TextRule {
    field: "application",
    label: "Application or platform",
    max_chars: 120,
    required: false,
    multiline: false,
};

pub const ENVIRONMENT_RULE: TextRule = TextRule {
    field: "environment",
    label: "Environment",
    max_chars: 60,
    required: false,
    multiline: false,
};

pub const NOTES_RULE: TextRule = TextRule {
    field: "notes",
    label: "Notes",
    max_chars: 20_000,
    required: false,
    multiline: true,
};

pub(crate) const SELECT_SESSION: &str = "
    SELECT s.id, s.title, s.project_id, p.name, s.application, s.environment, s.status,
           s.review_state, s.started_at, s.ended_at, s.created_at, s.updated_at,
           (SELECT COUNT(*) FROM playbook_sessions ps WHERE ps.session_id = s.id),
           (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id),
           (SELECT COUNT(*) FROM attachments a WHERE a.session_id = s.id)
    FROM sessions s
    LEFT JOIN projects p ON p.id = s.project_id";

pub(crate) fn map_session(row: &Row<'_>) -> rusqlite::Result<SessionSummary> {
    Ok(SessionSummary {
        id: row.get(0)?,
        title: row.get(1)?,
        project_id: row.get(2)?,
        project_name: row.get(3)?,
        application: row.get(4)?,
        environment: row.get(5)?,
        status: row.get(6)?,
        review_state: row.get(7)?,
        started_at: row.get(8)?,
        ended_at: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
        playbook_count: row.get(12)?,
        event_count: row.get(13)?,
        attachment_count: row.get(14)?,
    })
}

struct ValidSession {
    title: String,
    project_id: Option<String>,
    application: String,
    environment: String,
}

fn validated(connection: &Connection, input: &SessionInput) -> AppResult<ValidSession> {
    let title = validate::text(&TITLE_RULE, &input.title)?;
    let application = validate::text(&APPLICATION_RULE, &input.application)?;
    let environment = validate::text(&ENVIRONMENT_RULE, &input.environment)?;
    let project_id = match input
        .project_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        None => None,
        Some(raw) => {
            let id = validate::id("projectId", raw)?;
            let exists: bool = connection.query_row(
                "SELECT EXISTS (SELECT 1 FROM projects WHERE id = ?1)",
                [&id],
                |row| row.get(0),
            )?;
            if !exists {
                return Err(AppError::validation(
                    "projectId",
                    "The selected project no longer exists. Choose another project.",
                ));
            }
            Some(id)
        }
    };
    Ok(ValidSession {
        title,
        project_id,
        application,
        environment,
    })
}

/// Most recently updated first.
pub fn list(connection: &Connection, limit: Option<u32>) -> AppResult<Vec<SessionSummary>> {
    let sql = format!(
        "{SELECT_SESSION} ORDER BY s.updated_at DESC, s.id DESC LIMIT {}",
        limit.map_or(-1, i64::from)
    );
    let mut statement = connection.prepare(&sql)?;
    let sessions = statement
        .query_map([], map_session)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(sessions)
}

pub fn get(connection: &Connection, id: &str) -> AppResult<SessionDetail> {
    let id = validate::id("id", id)?;
    let summary = connection
        .query_row(
            &format!("{SELECT_SESSION} WHERE s.id = ?1"),
            [&id],
            map_session,
        )
        .optional()?
        .ok_or_else(|| AppError::not_found("Session", &id))?;
    let (notes, attachment_bytes, change_count) = connection.query_row(
        "SELECT s.notes,
                (SELECT COALESCE(SUM(a.byte_size), 0) FROM attachments a WHERE a.session_id = s.id),
                (SELECT COUNT(*) FROM change_records c WHERE c.session_id = s.id)
         FROM sessions s WHERE s.id = ?1",
        [&id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    Ok(SessionDetail {
        summary,
        notes,
        attachment_bytes,
        change_count,
    })
}

pub fn create(
    connection: &Connection,
    input: &SessionInput,
    notes: &str,
) -> AppResult<SessionDetail> {
    let valid = validated(connection, input)?;
    let notes = validate::preformatted(&NOTES_RULE, notes)?;
    let id = clock::new_id();
    let now = clock::now();
    connection.execute(
        "INSERT INTO sessions (id, project_id, title, application, environment, status, review_state, notes, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
        params![
            id,
            valid.project_id,
            valid.title,
            valid.application,
            valid.environment,
            SessionStatus::Draft,
            ReviewState::Unreviewed,
            notes,
            now
        ],
    )?;
    get(connection, &id)
}

/// Updates title, project, application and environment (renaming included).
pub fn update(connection: &Connection, id: &str, input: &SessionInput) -> AppResult<SessionDetail> {
    let id = validate::id("id", id)?;
    let valid = validated(connection, input)?;
    let changed = connection.execute(
        "UPDATE sessions SET title = ?2, project_id = ?3, application = ?4, environment = ?5, updated_at = ?6
         WHERE id = ?1",
        params![
            id,
            valid.title,
            valid.project_id,
            valid.application,
            valid.environment,
            clock::now()
        ],
    )?;
    if changed == 0 {
        return Err(AppError::not_found("Session", id));
    }
    get(connection, &id)
}

/// Saves session notes. Notes are annotations, so they stay editable in completed sessions.
pub fn update_notes(connection: &Connection, id: &str, notes: &str) -> AppResult<NotesSaved> {
    let id = validate::id("id", id)?;
    let notes = validate::preformatted(&NOTES_RULE, notes)?;
    let now = clock::now();
    let changed = connection.execute(
        "UPDATE sessions SET notes = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, notes, now],
    )?;
    if changed == 0 {
        return Err(AppError::not_found("Session", id));
    }
    Ok(NotesSaved { updated_at: now })
}

fn status_of(connection: &Connection, id: &str) -> AppResult<SessionStatus> {
    connection
        .query_row("SELECT status FROM sessions WHERE id = ?1", [id], |row| {
            row.get(0)
        })
        .optional()?
        .ok_or_else(|| AppError::not_found("Session", id))
}

/// Marks a session completed or reopens it as a draft. Recording and pausing are controlled by
/// the capture controller (`set_capture_status`).
pub fn set_status(
    connection: &Connection,
    id: &str,
    status: SessionStatus,
) -> AppResult<SessionDetail> {
    let id = validate::id("id", id)?;
    let current = status_of(connection, &id)?;
    let now = clock::now();
    if matches!(current, SessionStatus::Recording | SessionStatus::Paused) {
        return Err(AppError::conflict(
            "status",
            "This session is being captured. Stop the capture first.",
        ));
    }
    match status {
        SessionStatus::Completed if current != SessionStatus::Completed => {
            let events: i64 = connection.query_row(
                "SELECT COUNT(*) FROM events WHERE session_id = ?1",
                [&id],
                |row| row.get(0),
            )?;
            if events == 0 {
                return Err(AppError::conflict(
                    "status",
                    "Add at least one step before completing the session.",
                ));
            }
            connection.execute(
                "UPDATE sessions SET status = ?2, ended_at = ?3, updated_at = ?3 WHERE id = ?1",
                params![id, SessionStatus::Completed, now],
            )?;
        }
        SessionStatus::Draft if current == SessionStatus::Completed => {
            connection.execute(
                "UPDATE sessions SET status = ?2, ended_at = NULL, updated_at = ?3 WHERE id = ?1",
                params![id, SessionStatus::Draft, now],
            )?;
        }
        SessionStatus::Completed | SessionStatus::Draft if current == status => {}
        SessionStatus::Draft => {
            return Err(AppError::conflict(
                "status",
                "Only completed sessions can be reopened.",
            ));
        }
        SessionStatus::Recording | SessionStatus::Paused | SessionStatus::Completed => {
            return Err(AppError::validation(
                "status",
                "Recording and pausing are controlled from the Capture workspace.",
            ));
        }
    }
    get(connection, &id)
}

/// Status changes driven by the capture controller: draft -> recording (records `started_at`
/// the first time), recording <-> paused, and recording/paused -> draft when capture stops.
pub(crate) fn set_capture_status(
    connection: &Connection,
    id: &str,
    status: SessionStatus,
) -> AppResult<()> {
    let current = status_of(connection, id)?;
    let allowed = matches!(
        (current, status),
        (SessionStatus::Draft, SessionStatus::Recording)
            | (SessionStatus::Recording, SessionStatus::Paused)
            | (SessionStatus::Paused, SessionStatus::Recording)
            | (SessionStatus::Recording, SessionStatus::Draft)
            | (SessionStatus::Paused, SessionStatus::Draft)
    );
    if !allowed {
        return Err(AppError::conflict(
            "status",
            match current {
                SessionStatus::Completed => {
                    "This session is completed. Reopen it before capturing more screenshots."
                }
                _ => "The capture state of this session changed. Refresh and try again.",
            },
        ));
    }
    connection.execute(
        "UPDATE sessions
            SET status = ?2,
                started_at = CASE WHEN ?2 = 'recording' THEN COALESCE(started_at, ?3) ELSE started_at END,
                updated_at = ?3
          WHERE id = ?1",
        params![id, status, clock::now()],
    )?;
    Ok(())
}

/// Sessions left recording or paused (the app closed during a capture) return to draft.
pub fn recover_interrupted_captures(connection: &Connection) -> AppResult<usize> {
    Ok(connection.execute(
        "UPDATE sessions SET status = 'draft', updated_at = ?1 WHERE status IN ('recording', 'paused')",
        [clock::now()],
    )?)
}

/// Fails unless the session exists and its steps and evidence may be changed.
pub(crate) fn ensure_editable(connection: &Connection, id: &str) -> AppResult<()> {
    match status_of(connection, id)? {
        SessionStatus::Completed => Err(AppError::conflict(
            "status",
            "This session is completed. Reopen it to change its steps or evidence.",
        )),
        _ => Ok(()),
    }
}

/// Fails with `not_found` unless the session exists.
pub(crate) fn ensure_exists(connection: &Connection, id: &str) -> AppResult<()> {
    status_of(connection, id).map(|_| ())
}

/// Records that the session's content changed.
pub(crate) fn touch(connection: &Connection, id: &str, now: &str) -> AppResult<()> {
    connection.execute(
        "UPDATE sessions SET updated_at = ?2 WHERE id = ?1",
        params![id, now],
    )?;
    Ok(())
}

/// Deletes the session rows in one transaction (events and attachments cascade) and returns
/// the relative paths of the evidence files that must be removed afterwards.
pub fn delete_records(
    connection: &mut Connection,
    id: &str,
) -> AppResult<(SessionDeletion, Vec<String>)> {
    let session = get(connection, id)?;
    if matches!(
        session.summary.status,
        SessionStatus::Recording | SessionStatus::Paused
    ) {
        return Err(AppError::conflict(
            "status",
            "This session is being captured. Stop the capture before deleting it.",
        ));
    }
    let transaction = connection.transaction()?;
    let paths = {
        let mut statement =
            transaction.prepare("SELECT relative_path FROM attachments WHERE session_id = ?1")?;
        statement
            .query_map([&session.summary.id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?
    };
    let deleted =
        transaction.execute("DELETE FROM sessions WHERE id = ?1", [&session.summary.id])?;
    if deleted == 0 {
        return Err(AppError::not_found("Session", session.summary.id));
    }
    transaction.commit()?;
    Ok((
        SessionDeletion {
            id: session.summary.id,
            title: session.summary.title,
            event_count: session.summary.event_count,
            attachment_count: session.summary.attachment_count,
            unlinked_playbooks: session.summary.playbook_count,
            unlinked_changes: session.change_count,
            files: FileCleanup::default(),
        },
        paths,
    ))
}

/// Removes a deleted session's evidence files and then its attachment folder.
pub fn remove_session_files(
    attachments_dir: &Path,
    session_id: &str,
    paths: &[String],
) -> FileCleanup {
    let cleanup = storage::remove_files(attachments_dir, paths);
    if let Ok(folder) = storage::resolve_contained(attachments_dir, session_id)
        && let Err(error) = storage::remove_dir_if_exists(&folder)
    {
        eprintln!(
            "DevTrace: could not remove attachment folder {}: {error}",
            folder.display()
        );
    }
    cleanup
}

/// Deletes a session and its evidence files with a single connection. Tests use this; the
/// command runs the same steps but removes files after releasing the database lock.
#[cfg(test)]
pub fn delete(
    connection: &mut Connection,
    attachments_dir: &Path,
    id: &str,
) -> AppResult<SessionDeletion> {
    let (mut deletion, paths) = delete_records(connection, id)?;
    deletion.files = remove_session_files(attachments_dir, &deletion.id, &paths);
    Ok(deletion)
}

#[tauri::command]
pub async fn list_sessions(state: State<'_, AppState>) -> AppResult<Vec<SessionSummary>> {
    state.with_db(|connection| list(connection, None))
}

#[tauri::command]
pub async fn get_session(state: State<'_, AppState>, id: String) -> AppResult<SessionDetail> {
    state.with_db(|connection| get(connection, &id))
}

#[tauri::command]
pub async fn create_session(
    state: State<'_, AppState>,
    input: SessionInput,
    notes: Option<String>,
) -> AppResult<SessionDetail> {
    state.with_db(|connection| create(connection, &input, notes.as_deref().unwrap_or_default()))
}

#[tauri::command]
pub async fn update_session(
    state: State<'_, AppState>,
    id: String,
    input: SessionInput,
) -> AppResult<SessionDetail> {
    state.with_db(|connection| update(connection, &id, &input))
}

#[tauri::command]
pub async fn update_session_notes(
    state: State<'_, AppState>,
    id: String,
    notes: String,
) -> AppResult<NotesSaved> {
    state.with_db(|connection| update_notes(connection, &id, &notes))
}

#[tauri::command]
pub async fn set_session_status(
    state: State<'_, AppState>,
    logs: State<'_, crate::integrations::terminal::TerminalLogs>,
    watches: State<'_, crate::integrations::file_watch::FileWatches>,
    id: String,
    status: SessionStatus,
) -> AppResult<SessionDetail> {
    let detail = state.with_db(|connection| set_status(connection, &id, status))?;
    if status == SessionStatus::Completed {
        // A completed session no longer accepts recorded steps.
        logs.stop(&detail.summary.id);
        watches.stop_session(&detail.summary.id);
    }
    Ok(detail)
}

/// Database rows are deleted while holding the database lock; files are removed afterwards
/// so slow disks never block other commands. Terminal logging and file watches of the session
/// stop first, and its terminal log files are removed with it.
#[tauri::command]
pub async fn delete_session(
    state: State<'_, AppState>,
    logs: State<'_, crate::integrations::terminal::TerminalLogs>,
    watches: State<'_, crate::integrations::file_watch::FileWatches>,
    id: String,
) -> AppResult<SessionDeletion> {
    let session_id = validate::id("id", &id)?;
    logs.stop(&session_id);
    watches.stop_session(&session_id);
    let (mut deletion, paths) = state.with_db(|connection| delete_records(connection, &id))?;
    deletion.files = remove_session_files(&state.paths.attachments_dir, &deletion.id, &paths);
    if let Ok(folder) =
        crate::integrations::terminal::session_folder(&state.paths.terminal_logs_dir, &deletion.id)
        && let Err(error) = storage::remove_dir_if_exists(&folder)
    {
        eprintln!("DevTrace: could not remove {}: {error}", folder.display());
        deletion.files.failed += 1;
    }
    Ok(deletion)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn input(title: &str) -> SessionInput {
        SessionInput {
            title: title.into(),
            project_id: None,
            application: String::new(),
            environment: String::new(),
        }
    }

    fn add_event(connection: &Connection, session_id: &str) {
        connection
            .execute(
                "INSERT INTO events (id, session_id, position, occurred_at, event_type, source, title, created_at, updated_at)
                 VALUES (?1, ?2, 0, 't', 'step', 'manual', 'Step', 't', 't')",
                params![clock::new_id(), session_id],
            )
            .unwrap();
    }

    #[test]
    fn empty_workspace_has_no_sessions() {
        let connection = db::open_in_memory();
        assert!(list(&connection, None).unwrap().is_empty());
    }

    #[test]
    fn lists_sessions_with_project_names_newest_first() {
        let connection = db::open_in_memory();
        connection
            .execute_batch(
                "INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1', 'Core Network', 't', 't');
                 INSERT INTO sessions (id, project_id, title, application, status, review_state, created_at, updated_at)
                   VALUES ('s1', 'p1', 'VLAN change', 'Switch CLI', 'completed', 'unreviewed', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
                 INSERT INTO sessions (id, title, created_at, updated_at)
                   VALUES ('s2', 'Unassigned capture', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');",
            )
            .unwrap();
        let sessions = list(&connection, None).unwrap();
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].id, "s2");
        assert_eq!(sessions[0].status, SessionStatus::Draft);
        assert_eq!(sessions[0].project_name, None);
        assert_eq!(sessions[1].project_name.as_deref(), Some("Core Network"));
        assert_eq!(sessions[1].status, SessionStatus::Completed);
        assert_eq!(list(&connection, Some(1)).unwrap().len(), 1);
    }

    #[test]
    fn unknown_status_values_fail_loudly() {
        let connection = db::open_in_memory();
        connection
            .execute_batch(
                "INSERT INTO sessions (id, title, status, created_at, updated_at) VALUES ('s1', 'Bad', 'exploded', 't', 't');",
            )
            .unwrap();
        assert!(list(&connection, None).is_err());
    }

    #[test]
    fn creates_and_reads_a_session_with_metadata_and_notes() {
        let connection = db::open_in_memory();
        connection
            .execute_batch(
                "INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1', 'Firewall Migration', 't', 't');",
            )
            .unwrap();
        let created = create(
            &connection,
            &SessionInput {
                title: "  Export policy  ".into(),
                project_id: Some("p1".into()),
                application: "FortiGate 7.4".into(),
                environment: "Lab".into(),
            },
            "\n  Goal: export the policy\n",
        )
        .unwrap();
        assert_eq!(created.summary.title, "Export policy");
        assert_eq!(
            created.summary.project_name.as_deref(),
            Some("Firewall Migration")
        );
        assert_eq!(created.summary.status, SessionStatus::Draft);
        assert_eq!(created.summary.review_state, ReviewState::Unreviewed);
        assert_eq!(created.summary.started_at, None);
        assert_eq!(created.summary.event_count, 0);
        assert_eq!(created.notes, "  Goal: export the policy");
        assert_eq!(created.attachment_bytes, 0);
        assert_eq!(get(&connection, &created.summary.id).unwrap(), created);
    }

    #[test]
    fn validates_session_input() {
        let connection = db::open_in_memory();
        assert_eq!(
            create(&connection, &input("  "), "").unwrap_err().field(),
            Some("title")
        );
        let mut bad_project = input("Title");
        bad_project.project_id = Some(clock::new_id());
        assert_eq!(
            create(&connection, &bad_project, "").unwrap_err().field(),
            Some("projectId")
        );
        let mut long_environment = input("Title");
        long_environment.environment = "x".repeat(61);
        assert_eq!(
            create(&connection, &long_environment, "")
                .unwrap_err()
                .field(),
            Some("environment")
        );
        assert_eq!(
            create(&connection, &input("Title"), &"n".repeat(20_001))
                .unwrap_err()
                .field(),
            Some("notes")
        );
        assert_eq!(
            get(&connection, "../../etc").unwrap_err().kind(),
            "validation"
        );
    }

    #[test]
    fn renames_reassigns_and_saves_notes() {
        let connection = db::open_in_memory();
        connection
            .execute_batch(
                "INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1', 'Lab', 't', 't');",
            )
            .unwrap();
        let created = create(&connection, &input("Draft title"), "").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let mut changed = input("Final title");
        changed.project_id = Some("p1".into());
        changed.application = "Windows Server 2022".into();
        let updated = update(&connection, &created.summary.id, &changed).unwrap();
        assert_eq!(updated.summary.title, "Final title");
        assert_eq!(updated.summary.project_id.as_deref(), Some("p1"));
        assert!(updated.summary.updated_at > created.summary.updated_at);

        let saved = update_notes(&connection, &created.summary.id, "Line 1\n  Line 2  \n").unwrap();
        let reread = get(&connection, &created.summary.id).unwrap();
        assert_eq!(reread.notes, "Line 1\n  Line 2");
        assert_eq!(reread.summary.updated_at, saved.updated_at);

        let missing = clock::new_id();
        assert_eq!(
            update(&connection, &missing, &input("X"))
                .unwrap_err()
                .kind(),
            "not_found"
        );
        assert_eq!(
            update_notes(&connection, &missing, "").unwrap_err().kind(),
            "not_found"
        );
    }

    #[test]
    fn completes_and_reopens_with_guards() {
        let connection = db::open_in_memory();
        let session = create(&connection, &input("Patch servers"), "").unwrap();
        let id = session.summary.id.clone();

        let empty = set_status(&connection, &id, SessionStatus::Completed).unwrap_err();
        assert_eq!(empty.kind(), "conflict");

        add_event(&connection, &id);
        let completed = set_status(&connection, &id, SessionStatus::Completed).unwrap();
        assert_eq!(completed.summary.status, SessionStatus::Completed);
        assert!(completed.summary.ended_at.is_some());
        assert!(ensure_editable(&connection, &id).is_err());
        // Completing twice is a no-op.
        assert_eq!(
            set_status(&connection, &id, SessionStatus::Completed)
                .unwrap()
                .summary
                .ended_at,
            completed.summary.ended_at
        );

        let reopened = set_status(&connection, &id, SessionStatus::Draft).unwrap();
        assert_eq!(reopened.summary.status, SessionStatus::Draft);
        assert_eq!(reopened.summary.ended_at, None);
        assert!(ensure_editable(&connection, &id).is_ok());

        for reserved in [SessionStatus::Recording, SessionStatus::Paused] {
            assert_eq!(
                set_status(&connection, &id, reserved).unwrap_err().kind(),
                "validation"
            );
        }
    }

    #[test]
    fn capture_status_transitions_are_guarded() {
        let mut connection = db::open_in_memory();
        let session = create(&connection, &input("Capture me"), "").unwrap();
        let id = session.summary.id.clone();
        assert!(session.summary.started_at.is_none());

        // Only a draft can start recording; started_at is set once.
        assert!(set_capture_status(&connection, &id, SessionStatus::Paused).is_err());
        set_capture_status(&connection, &id, SessionStatus::Recording).unwrap();
        let recording = get(&connection, &id).unwrap();
        assert_eq!(recording.summary.status, SessionStatus::Recording);
        let started = recording.summary.started_at.clone().unwrap();
        assert!(
            ensure_editable(&connection, &id).is_ok(),
            "screenshots can be added"
        );

        // While capturing, the session can be neither completed, reopened nor deleted.
        add_event(&connection, &id);
        let blocked = set_status(&connection, &id, SessionStatus::Completed).unwrap_err();
        assert!(blocked.to_string().contains("Stop the capture"));
        let blocked = delete_records(&mut connection, &id).unwrap_err();
        assert_eq!(blocked.kind(), "conflict");

        set_capture_status(&connection, &id, SessionStatus::Paused).unwrap();
        set_capture_status(&connection, &id, SessionStatus::Recording).unwrap();
        set_capture_status(&connection, &id, SessionStatus::Draft).unwrap();
        let stopped = get(&connection, &id).unwrap();
        assert_eq!(stopped.summary.status, SessionStatus::Draft);
        assert_eq!(
            stopped.summary.started_at.as_deref(),
            Some(started.as_str())
        );

        // Restarting keeps the original start time.
        set_capture_status(&connection, &id, SessionStatus::Recording).unwrap();
        set_capture_status(&connection, &id, SessionStatus::Draft).unwrap();
        assert_eq!(
            get(&connection, &id).unwrap().summary.started_at.as_deref(),
            Some(started.as_str())
        );

        // Completed sessions cannot be captured into.
        set_status(&connection, &id, SessionStatus::Completed).unwrap();
        let refused = set_capture_status(&connection, &id, SessionStatus::Recording).unwrap_err();
        assert!(refused.to_string().contains("Reopen it"));
    }

    #[test]
    fn interrupted_captures_return_to_draft() {
        let connection = db::open_in_memory();
        let recording = create(&connection, &input("Recording"), "")
            .unwrap()
            .summary
            .id;
        let paused = create(&connection, &input("Paused"), "")
            .unwrap()
            .summary
            .id;
        let draft = create(&connection, &input("Draft"), "").unwrap().summary.id;
        set_capture_status(&connection, &recording, SessionStatus::Recording).unwrap();
        set_capture_status(&connection, &paused, SessionStatus::Recording).unwrap();
        set_capture_status(&connection, &paused, SessionStatus::Paused).unwrap();

        assert_eq!(recover_interrupted_captures(&connection).unwrap(), 2);
        for id in [&recording, &paused, &draft] {
            assert_eq!(
                get(&connection, id).unwrap().summary.status,
                SessionStatus::Draft
            );
        }
        assert_eq!(recover_interrupted_captures(&connection).unwrap(), 0);
    }

    #[test]
    fn delete_removes_rows_files_and_folder_and_reports_impact() {
        let temp = tempfile::tempdir().unwrap();
        let attachments_dir = temp.path();
        let mut connection = db::open_in_memory();
        let session = create(&connection, &input("To delete"), "").unwrap();
        let id = session.summary.id.clone();
        let event_id = clock::new_id();
        connection
            .execute(
                "INSERT INTO events (id, session_id, position, occurred_at, event_type, source, title, created_at, updated_at)
                 VALUES (?1, ?2, 0, 't', 'screenshot', 'file', 'Shot', 't', 't')",
                params![event_id, id],
            )
            .unwrap();
        let relative = format!("{id}/a1.png");
        storage::write_atomic(
            &storage::resolve_contained(attachments_dir, &relative).unwrap(),
            b"png",
        )
        .unwrap();
        // A leftover temporary file inside the session folder is removed with the folder.
        std::fs::write(attachments_dir.join(&id).join(".partial.tmp"), b"x").unwrap();
        connection
            .execute(
                "INSERT INTO attachments (id, session_id, event_id, kind, source, relative_path, media_type, byte_size, sha256, created_at)
                 VALUES ('a1', ?1, ?2, 'screenshot', 'file', ?3, 'image/png', 3, ?4, 't')",
                params![id, event_id, relative, "0".repeat(64)],
            )
            .unwrap();
        connection
            .execute_batch(&format!(
                "INSERT INTO playbooks (id, title, created_at, updated_at) VALUES ('b1', 'Playbook', 't', 't');
                 INSERT INTO playbook_sessions (playbook_id, session_id, linked_at) VALUES ('b1', '{id}', 't');
                 INSERT INTO change_records (id, session_id, occurred_at, target, created_at, updated_at)
                   VALUES ('c1', '{id}', 't', 'ntp', 't', 't');"
            ))
            .unwrap();

        let deletion = delete(&mut connection, attachments_dir, &id).unwrap();
        assert_eq!(deletion.event_count, 1);
        assert_eq!(deletion.attachment_count, 1);
        assert_eq!(deletion.unlinked_playbooks, 1);
        assert_eq!(deletion.unlinked_changes, 1);
        assert_eq!(
            deletion.files,
            FileCleanup {
                removed: 1,
                missing: 0,
                failed: 0
            }
        );
        assert!(!attachments_dir.join(&id).exists());

        let counts: (i64, i64, i64, i64, i64) = connection
            .query_row(
                "SELECT (SELECT COUNT(*) FROM sessions), (SELECT COUNT(*) FROM events),
                        (SELECT COUNT(*) FROM attachments), (SELECT COUNT(*) FROM playbooks),
                        (SELECT COUNT(*) FROM change_records WHERE session_id IS NULL)",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(counts, (0, 0, 0, 1, 1));
        assert_eq!(
            delete(&mut connection, attachments_dir, &id)
                .unwrap_err()
                .kind(),
            "not_found"
        );
    }
}
