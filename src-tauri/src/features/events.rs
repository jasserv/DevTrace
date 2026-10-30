//! Session events: the ordered steps of a session.
//!
//! Milestone 2 events are authored by the user (`step`, `note`, `command`) or created from a
//! user-provided image (`screenshot`). Every event records its `source`, so content recorded by
//! native capture (Milestone 3) or by an integration the user started (Milestone 8: terminal
//! logs, watched configuration files) stays distinguishable from content written or supplied by
//! a person. Commands are stored as text and are never executed.

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::clock;
use crate::error::{AppError, AppResult};
use crate::features::attachments::{self, Attachment};
use crate::features::sessions;
use crate::state::AppState;
use crate::storage::{self, FileCleanup};
use crate::validate::{self, TextRule};

text_enum! {
    pub enum EventType {
        Step => "step",
        Note => "note",
        Command => "command",
        Screenshot => "screenshot",
        /// Terminal output recorded from a log file (Milestone 8).
        Log => "log",
        /// A change seen in a watched configuration file (Milestone 8).
        Change => "change",
    }
}

impl EventType {
    /// Types whose `code` holds monospaced text (a command, terminal output or a diff).
    pub fn has_code(self) -> bool {
        matches!(self, Self::Command | Self::Log | Self::Change)
    }
}

text_enum! {
    /// Where an event's content came from.
    pub enum EventSource {
        /// Written by the user.
        Manual => "manual",
        /// Created from an image file the user chose or dropped.
        File => "file",
        /// Created from an image the user pasted.
        Clipboard => "clipboard",
        /// Recorded by native capture.
        Capture => "capture",
        /// Read from a terminal log the user started (Milestone 8).
        Terminal => "terminal",
        /// Recorded from a configuration file the user chose to watch (Milestone 8).
        FileWatch => "file_watch",
    }
}

text_enum! {
    /// The reviewer's decision on a step. Only approved steps can become playbook content;
    /// rejected (wrong or misleading) and excluded (irrelevant) steps never do.
    pub enum EventReviewStatus {
        Pending => "pending",
        Approved => "approved",
        Rejected => "rejected",
        Excluded => "excluded",
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub id: String,
    pub session_id: String,
    pub position: i64,
    pub occurred_at: String,
    pub event_type: EventType,
    pub source: EventSource,
    pub title: String,
    pub description: String,
    pub notes: String,
    pub code: String,
    pub review_status: EventReviewStatus,
    pub created_at: String,
    pub updated_at: String,
    /// Recorded facts such as the capture target and trigger; `{}` for manual events.
    pub metadata: serde_json::Value,
    pub attachments: Vec<Attachment>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventInput {
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub code: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventDeletion {
    pub id: String,
    pub session_id: String,
    pub attachment_count: i64,
    pub files: FileCleanup,
}

pub const TITLE_RULE: TextRule = TextRule {
    field: "title",
    label: "Title",
    max_chars: 200,
    required: true,
    multiline: false,
};

pub const DESCRIPTION_RULE: TextRule = TextRule {
    field: "description",
    label: "Description",
    max_chars: 10_000,
    required: false,
    multiline: true,
};

pub const NOTES_RULE: TextRule = TextRule {
    field: "notes",
    label: "Notes",
    max_chars: 10_000,
    required: false,
    multiline: true,
};

pub const CODE_RULE: TextRule = TextRule {
    field: "code",
    label: "Command",
    max_chars: 20_000,
    required: true,
    multiline: true,
};

/// Validated event text.
pub(crate) struct ValidEvent {
    pub title: String,
    pub description: String,
    pub notes: String,
    pub code: String,
    /// JSON object with recorded facts (`{}` for manual events).
    pub metadata: String,
}

fn validated(event_type: EventType, input: &EventInput) -> AppResult<ValidEvent> {
    let title = validate::text(&TITLE_RULE, &input.title)?;
    let description = validate::preformatted(&DESCRIPTION_RULE, &input.description)?;
    let notes = validate::preformatted(&NOTES_RULE, &input.notes)?;
    let code = if event_type == EventType::Command {
        validate::preformatted(&CODE_RULE, &input.code)?
    } else if event_type.has_code() {
        validate::preformatted(
            &TextRule {
                required: false,
                label: "Recorded text",
                ..CODE_RULE
            },
            &input.code,
        )?
    } else if input.code.trim().is_empty() {
        String::new()
    } else {
        return Err(AppError::validation(
            "code",
            "Only command steps can include a command.",
        ));
    };
    Ok(ValidEvent {
        title,
        description,
        notes,
        code,
        metadata: "{}".into(),
    })
}

const SELECT_EVENT: &str = "
    SELECT e.id, e.session_id, e.position, e.occurred_at, e.event_type, e.source, e.title,
           e.description, e.notes, e.code, e.review_status, e.created_at, e.updated_at,
           e.metadata_json
    FROM events e";

fn map_event(row: &Row<'_>) -> rusqlite::Result<Event> {
    let metadata: String = row.get(13)?;
    Ok(Event {
        id: row.get(0)?,
        session_id: row.get(1)?,
        position: row.get(2)?,
        occurred_at: row.get(3)?,
        event_type: row.get(4)?,
        source: row.get(5)?,
        title: row.get(6)?,
        description: row.get(7)?,
        notes: row.get(8)?,
        code: row.get(9)?,
        review_status: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
        metadata: serde_json::from_str(&metadata).unwrap_or_else(|_| serde_json::json!({})),
        attachments: Vec::new(),
    })
}

/// Events of a session in timeline order, each with its attachments.
pub fn list(connection: &Connection, session_id: &str) -> AppResult<Vec<Event>> {
    let session_id = validate::id("sessionId", session_id)?;
    sessions::ensure_exists(connection, &session_id)?;
    let mut statement = connection.prepare(&format!(
        "{SELECT_EVENT} WHERE e.session_id = ?1 ORDER BY e.position, e.created_at, e.id"
    ))?;
    let mut events = statement
        .query_map([&session_id], map_event)?
        .collect::<Result<Vec<_>, _>>()?;

    let mut by_event: HashMap<String, Vec<Attachment>> = HashMap::new();
    for attachment in attachments::list_for_session(connection, &session_id)? {
        if let Some(event_id) = attachment.event_id.clone() {
            by_event.entry(event_id).or_default().push(attachment);
        }
    }
    for event in &mut events {
        event.attachments = by_event.remove(&event.id).unwrap_or_default();
    }
    Ok(events)
}

pub fn get(connection: &Connection, id: &str) -> AppResult<Event> {
    let id = validate::id("id", id)?;
    let mut event = connection
        .query_row(&format!("{SELECT_EVENT} WHERE e.id = ?1"), [&id], map_event)
        .optional()?
        .ok_or_else(|| AppError::not_found("Event", &id))?;
    event.attachments = attachments::list_for_event(connection, &event.id)?;
    Ok(event)
}

/// Appends an event to the end of a session's timeline. The caller validates the session.
pub(crate) fn insert(
    connection: &Connection,
    session_id: &str,
    event_type: EventType,
    source: EventSource,
    event: &ValidEvent,
    now: &str,
) -> AppResult<String> {
    let id = clock::new_id();
    let position: i64 = connection.query_row(
        "SELECT COALESCE(MAX(position), -1) + 1 FROM events WHERE session_id = ?1",
        [session_id],
        |row| row.get(0),
    )?;
    connection.execute(
        "INSERT INTO events (id, session_id, position, occurred_at, event_type, source, title,
                             description, notes, code, review_status, metadata_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?4, ?4)",
        params![
            id,
            session_id,
            position,
            now,
            event_type,
            source,
            event.title,
            event.description,
            event.notes,
            event.code,
            EventReviewStatus::Pending,
            event.metadata
        ],
    )?;
    // New evidence after a completed review means the review is no longer complete.
    connection.execute(
        "UPDATE sessions SET review_state = 'in_review' WHERE id = ?1 AND review_state = 'reviewed'",
        [session_id],
    )?;
    Ok(id)
}

/// Adds a manually written step, note or command.
pub fn create(
    connection: &mut Connection,
    session_id: &str,
    event_type: EventType,
    input: &EventInput,
) -> AppResult<Event> {
    let session_id = validate::id("sessionId", session_id)?;
    if matches!(
        event_type,
        EventType::Screenshot | EventType::Log | EventType::Change
    ) {
        return Err(AppError::validation(
            "eventType",
            "Screenshot, terminal and change steps are recorded, not written.",
        ));
    }
    let event = validated(event_type, input)?;
    let transaction = connection.transaction()?;
    sessions::ensure_editable(&transaction, &session_id)?;
    let now = clock::now();
    let id = insert(
        &transaction,
        &session_id,
        event_type,
        EventSource::Manual,
        &event,
        &now,
    )?;
    sessions::touch(&transaction, &session_id, &now)?;
    transaction.commit()?;
    get(connection, &id)
}

/// Content recorded by an integration (terminal log, watched file). Text that is too long is
/// shortened with a marker instead of being refused, so recording never fails on length.
pub struct RecordedEvent<'a> {
    pub event_type: EventType,
    pub source: EventSource,
    pub title: &'a str,
    pub description: &'a str,
    pub code: &'a str,
    pub metadata: serde_json::Value,
}

/// Shortens a single line (a title) with an ellipsis, keeping it on one line.
fn shorten_line(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
    out.push('\u{2026}');
    out
}

fn shorten(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    const MARKER: &str = "\n[\u{2026} shortened by DevTrace]";
    let keep = max.saturating_sub(MARKER.chars().count());
    let mut out: String = text.chars().take(keep).collect();
    out.push_str(MARKER);
    out
}

/// Appends a recorded event to a session that can still be changed. Uses a savepoint, so callers
/// can record it together with other rows in one outer transaction.
pub fn record(
    connection: &mut Connection,
    session_id: &str,
    recorded: &RecordedEvent<'_>,
) -> AppResult<Event> {
    let session_id = validate::id("sessionId", session_id)?;
    let title_line = recorded.title.lines().next().unwrap_or_default().trim();
    let title = if title_line.is_empty() {
        "Recorded step".to_string()
    } else {
        shorten_line(title_line, TITLE_RULE.max_chars)
    };
    let event = ValidEvent {
        title,
        description: shorten(recorded.description.trim_end(), DESCRIPTION_RULE.max_chars),
        notes: String::new(),
        code: shorten(recorded.code.trim_end(), CODE_RULE.max_chars),
        metadata: recorded.metadata.to_string(),
    };
    let transaction = connection.savepoint()?;
    sessions::ensure_editable(&transaction, &session_id)?;
    let now = clock::now();
    let id = insert(
        &transaction,
        &session_id,
        recorded.event_type,
        recorded.source,
        &event,
        &now,
    )?;
    sessions::touch(&transaction, &session_id, &now)?;
    transaction.commit()?;
    get(connection, &id)
}

fn owner(connection: &Connection, id: &str) -> AppResult<(String, EventType)> {
    connection
        .query_row(
            "SELECT session_id, event_type FROM events WHERE id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::not_found("Event", id))
}

/// Edits an event's text. The event type and source never change.
pub fn update(connection: &mut Connection, id: &str, input: &EventInput) -> AppResult<Event> {
    let id = validate::id("id", id)?;
    let transaction = connection.transaction()?;
    let (session_id, event_type) = owner(&transaction, &id)?;
    sessions::ensure_editable(&transaction, &session_id)?;
    let event = validated(event_type, input)?;
    let now = clock::now();
    transaction.execute(
        "UPDATE events SET title = ?2, description = ?3, notes = ?4, code = ?5, updated_at = ?6
         WHERE id = ?1",
        params![
            id,
            event.title,
            event.description,
            event.notes,
            event.code,
            now
        ],
    )?;
    sessions::touch(&transaction, &session_id, &now)?;
    transaction.commit()?;
    get(connection, &id)
}

/// Deletes an event and its attachment rows, returning the files to remove afterwards.
pub fn delete_records(
    connection: &mut Connection,
    id: &str,
) -> AppResult<(EventDeletion, Vec<String>)> {
    let id = validate::id("id", id)?;
    let transaction = connection.transaction()?;
    let (session_id, _) = owner(&transaction, &id)?;
    sessions::ensure_editable(&transaction, &session_id)?;
    let paths = {
        let mut statement =
            transaction.prepare("SELECT relative_path FROM attachments WHERE event_id = ?1")?;
        statement
            .query_map([&id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?
    };
    transaction.execute("DELETE FROM events WHERE id = ?1", [&id])?;
    sessions::touch(&transaction, &session_id, &clock::now())?;
    transaction.commit()?;
    Ok((
        EventDeletion {
            id,
            session_id,
            attachment_count: paths.len() as i64,
            files: FileCleanup::default(),
        },
        paths,
    ))
}

#[tauri::command]
pub async fn list_events(state: State<'_, AppState>, session_id: String) -> AppResult<Vec<Event>> {
    state.with_db(|connection| list(connection, &session_id))
}

#[tauri::command]
pub async fn create_event(
    state: State<'_, AppState>,
    session_id: String,
    event_type: EventType,
    input: EventInput,
) -> AppResult<Event> {
    state.with_db(|connection| create(connection, &session_id, event_type, &input))
}

#[tauri::command]
pub async fn update_event(
    state: State<'_, AppState>,
    id: String,
    input: EventInput,
) -> AppResult<Event> {
    state.with_db(|connection| update(connection, &id, &input))
}

#[tauri::command]
pub async fn delete_event(state: State<'_, AppState>, id: String) -> AppResult<EventDeletion> {
    let (mut deletion, paths) = state.with_db(|connection| delete_records(connection, &id))?;
    deletion.files = storage::remove_files(&state.paths.attachments_dir, &paths);
    Ok(deletion)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::features::sessions::{SessionInput, SessionStatus};

    fn session(connection: &Connection) -> String {
        sessions::create(
            connection,
            &SessionInput {
                title: "Rotate certificates".into(),
                project_id: None,
                application: String::new(),
                environment: String::new(),
            },
            "",
        )
        .unwrap()
        .summary
        .id
    }

    fn text(title: &str) -> EventInput {
        EventInput {
            title: title.into(),
            ..EventInput::default()
        }
    }

    #[test]
    fn recorded_events_are_shortened_and_can_join_an_outer_transaction() {
        let mut connection = db::open_in_memory();
        let session_id = session(&connection);
        let long_title = "x".repeat(TITLE_RULE.max_chars + 50);
        let output = "line\n".repeat(CODE_RULE.max_chars);
        let event = record(
            &mut connection,
            &session_id,
            &RecordedEvent {
                event_type: EventType::Log,
                source: EventSource::Terminal,
                title: &long_title,
                description: "",
                code: &output,
                metadata: serde_json::json!({ "terminal": { "format": "plain" } }),
            },
        )
        .unwrap();
        assert_eq!(event.title.chars().count(), TITLE_RULE.max_chars);
        assert!(!event.title.contains('\n'), "titles stay on one line");
        assert!(event.code.ends_with("shortened by DevTrace]"));
        assert!(event.code.chars().count() <= CODE_RULE.max_chars);
        assert_eq!(event.source, EventSource::Terminal);

        // Inside an outer savepoint that is rolled back, nothing is kept.
        connection.execute_batch("SAVEPOINT outer_test").unwrap();
        record(
            &mut connection,
            &session_id,
            &RecordedEvent {
                event_type: EventType::Change,
                source: EventSource::FileWatch,
                title: "Changed: app.conf",
                description: "1 line added, 0 lines removed.",
                code: "+ debug = true",
                metadata: serde_json::json!({}),
            },
        )
        .unwrap();
        connection
            .execute_batch("ROLLBACK TO outer_test; RELEASE outer_test")
            .unwrap();
        assert_eq!(list(&connection, &session_id).unwrap().len(), 1);
    }

    #[test]
    fn appends_events_in_order_and_touches_the_session() {
        let mut connection = db::open_in_memory();
        let session_id = session(&connection);
        let before = sessions::get(&connection, &session_id)
            .unwrap()
            .summary
            .updated_at;
        std::thread::sleep(std::time::Duration::from_millis(5));

        let step = create(
            &mut connection,
            &session_id,
            EventType::Step,
            &text("Open the console"),
        )
        .unwrap();
        let note = create(
            &mut connection,
            &session_id,
            EventType::Note,
            &text("Maintenance window approved"),
        )
        .unwrap();
        let command = create(
            &mut connection,
            &session_id,
            EventType::Command,
            &EventInput {
                title: "Check expiry".into(),
                code: "\n    certutil -store My\n".into(),
                ..EventInput::default()
            },
        )
        .unwrap();

        assert_eq!((step.position, note.position, command.position), (0, 1, 2));
        assert_eq!(step.source, EventSource::Manual);
        assert_eq!(step.review_status, EventReviewStatus::Pending);
        assert_eq!(command.code, "    certutil -store My");

        let listed = list(&connection, &session_id).unwrap();
        let titles: Vec<&str> = listed.iter().map(|event| event.title.as_str()).collect();
        assert_eq!(
            titles,
            vec![
                "Open the console",
                "Maintenance window approved",
                "Check expiry"
            ]
        );

        let detail = sessions::get(&connection, &session_id).unwrap();
        assert_eq!(detail.summary.event_count, 3);
        assert!(detail.summary.updated_at > before);
    }

    #[test]
    fn validates_event_input_per_type() {
        let mut connection = db::open_in_memory();
        let session_id = session(&connection);
        let missing_code = create(
            &mut connection,
            &session_id,
            EventType::Command,
            &text("Run"),
        )
        .unwrap_err();
        assert_eq!(missing_code.field(), Some("code"));
        let stray_code = create(
            &mut connection,
            &session_id,
            EventType::Step,
            &EventInput {
                title: "Step".into(),
                code: "rm -rf /".into(),
                ..EventInput::default()
            },
        )
        .unwrap_err();
        assert_eq!(stray_code.field(), Some("code"));
        assert_eq!(
            create(
                &mut connection,
                &session_id,
                EventType::Screenshot,
                &text("Shot")
            )
            .unwrap_err()
            .field(),
            Some("eventType")
        );
        assert_eq!(
            create(&mut connection, &session_id, EventType::Step, &text(" "))
                .unwrap_err()
                .field(),
            Some("title")
        );
        assert_eq!(
            create(
                &mut connection,
                &clock::new_id(),
                EventType::Step,
                &text("Orphan")
            )
            .unwrap_err()
            .kind(),
            "not_found"
        );
        assert_eq!(
            list(&connection, &clock::new_id()).unwrap_err().kind(),
            "not_found"
        );
    }

    #[test]
    fn updates_text_but_never_the_type() {
        let mut connection = db::open_in_memory();
        let session_id = session(&connection);
        let event = create(
            &mut connection,
            &session_id,
            EventType::Step,
            &text("Draft"),
        )
        .unwrap();
        let updated = update(
            &mut connection,
            &event.id,
            &EventInput {
                title: "Open Certificates snap-in".into(),
                description: "Run mmc and add the snap-in.".into(),
                notes: "Use the computer account.".into(),
                code: String::new(),
            },
        )
        .unwrap();
        assert_eq!(updated.title, "Open Certificates snap-in");
        assert_eq!(updated.event_type, EventType::Step);
        assert_eq!(updated.notes, "Use the computer account.");
        assert_eq!(updated.created_at, event.created_at);
        assert_eq!(
            update(&mut connection, &clock::new_id(), &text("X"))
                .unwrap_err()
                .kind(),
            "not_found"
        );
    }

    #[test]
    fn completed_sessions_are_read_only_until_reopened() {
        let mut connection = db::open_in_memory();
        let session_id = session(&connection);
        let event = create(&mut connection, &session_id, EventType::Step, &text("Step")).unwrap();
        sessions::set_status(&connection, &session_id, SessionStatus::Completed).unwrap();

        for error in [
            create(&mut connection, &session_id, EventType::Note, &text("Late")).unwrap_err(),
            update(&mut connection, &event.id, &text("Changed")).unwrap_err(),
            delete_records(&mut connection, &event.id).unwrap_err(),
        ] {
            assert_eq!(error.kind(), "conflict");
        }

        sessions::set_status(&connection, &session_id, SessionStatus::Draft).unwrap();
        assert!(update(&mut connection, &event.id, &text("Changed")).is_ok());
    }

    #[test]
    fn delete_reports_attachment_files_to_remove() {
        let mut connection = db::open_in_memory();
        let session_id = session(&connection);
        let event = create(&mut connection, &session_id, EventType::Step, &text("Step")).unwrap();
        connection
            .execute(
                "INSERT INTO attachments (id, session_id, event_id, kind, source, relative_path, media_type, byte_size, sha256, created_at)
                 VALUES ('a1', ?1, ?2, 'screenshot', 'file', ?3, 'image/png', 3, ?4, 't')",
                params![session_id, event.id, format!("{session_id}/a1.png"), "0".repeat(64)],
            )
            .unwrap();
        let (deletion, paths) = delete_records(&mut connection, &event.id).unwrap();
        assert_eq!(deletion.attachment_count, 1);
        assert_eq!(paths, vec![format!("{session_id}/a1.png")]);
        let remaining: i64 = connection
            .query_row("SELECT COUNT(*) FROM attachments", [], |row| row.get(0))
            .unwrap();
        assert_eq!(remaining, 0);
        assert!(list(&connection, &session_id).unwrap().is_empty());
    }
}
