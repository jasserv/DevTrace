//! Evidence attachments: image files stored in the workspace and linked to events.
//!
//! Images reach the backend as raw bytes over IPC (file picker, paste or drag and drop in the
//! webview); no file-system path ever crosses the IPC boundary. Import order:
//! 1. check that the session (and target event) can be changed;
//! 2. inspect, hash and write the file atomically, without holding the database lock;
//! 3. record the rows in one transaction; if that fails, the written file is removed.

use std::path::{Path, PathBuf};

use percent_encoding::percent_decode_str;
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use tauri::State;
use tauri::http::HeaderMap;
use tauri::ipc::{InvokeBody, Request};

use crate::clock;
use crate::error::{AppError, AppResult};
use crate::features::events::{self, Event, EventSource, EventType, ValidEvent};
use crate::features::sessions;
use crate::state::AppState;
use crate::storage::{self, FileCleanup, InspectedImage};
use crate::validate;

text_enum! {
    pub enum AttachmentKind {
        Screenshot => "screenshot",
    }
}

text_enum! {
    /// How an attachment entered the workspace. Drag and drop counts as `file`.
    pub enum AttachmentSource {
        File => "file",
        Clipboard => "clipboard",
        /// Recorded by native capture (reserved for Milestone 3).
        Capture => "capture",
    }
}

impl AttachmentSource {
    fn event_source(self) -> EventSource {
        match self {
            Self::File => EventSource::File,
            Self::Clipboard => EventSource::Clipboard,
            Self::Capture => EventSource::Capture,
        }
    }
}

/// Attachment metadata. The stored file location is deliberately not exposed; the webview
/// loads images through the `evidence` URI scheme by attachment id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub session_id: String,
    pub event_id: Option<String>,
    pub kind: AttachmentKind,
    pub source: AttachmentSource,
    pub original_name: String,
    pub media_type: String,
    pub byte_size: i64,
    pub sha256: String,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub created_at: String,
    /// Non-destructive highlight boxes drawn on the image.
    pub annotations: Vec<Annotation>,
    /// Set when regions were permanently redacted (burned into the image).
    pub redacted_at: Option<String>,
}

/// A highlight box on a screenshot, in image pixel coordinates.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Annotation {
    pub id: String,
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub label: String,
}

pub const MAX_ANNOTATIONS: usize = 50;
const MIN_ANNOTATION_SIDE: u32 = 4;

pub const ANNOTATION_LABEL_RULE: validate::TextRule = validate::TextRule {
    field: "annotations",
    label: "Annotation label",
    max_chars: 120,
    required: false,
    multiline: false,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedImage {
    /// The event the image belongs to, with all its attachments.
    pub event: Event,
    pub attachment_id: String,
    /// True when a new screenshot event was created for the image.
    pub event_created: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentDeletion {
    pub id: String,
    pub session_id: String,
    pub event_id: Option<String>,
    pub files: FileCleanup,
}

/// Where a stored attachment lives, for the `evidence` protocol handler.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredFile {
    pub relative_path: String,
    pub media_type: String,
}

const SELECT_ATTACHMENT: &str = "
    SELECT a.id, a.session_id, a.event_id, a.kind, a.source, a.original_name, a.media_type,
           a.byte_size, a.sha256, a.width, a.height, a.created_at, a.annotations_json, a.redacted_at
    FROM attachments a";

fn map_attachment(row: &Row<'_>) -> rusqlite::Result<Attachment> {
    let annotations: String = row.get(12)?;
    Ok(Attachment {
        id: row.get(0)?,
        session_id: row.get(1)?,
        event_id: row.get(2)?,
        kind: row.get(3)?,
        source: row.get(4)?,
        original_name: row.get(5)?,
        media_type: row.get(6)?,
        byte_size: row.get(7)?,
        sha256: row.get(8)?,
        width: row.get(9)?,
        height: row.get(10)?,
        created_at: row.get(11)?,
        annotations: serde_json::from_str(&annotations).unwrap_or_default(),
        redacted_at: row.get(13)?,
    })
}

pub(crate) fn list_for_session(
    connection: &Connection,
    session_id: &str,
) -> AppResult<Vec<Attachment>> {
    let mut statement = connection.prepare(&format!(
        "{SELECT_ATTACHMENT} WHERE a.session_id = ?1 ORDER BY a.created_at, a.id"
    ))?;
    let attachments = statement
        .query_map([session_id], map_attachment)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(attachments)
}

pub(crate) fn list_for_event(
    connection: &Connection,
    event_id: &str,
) -> AppResult<Vec<Attachment>> {
    let mut statement = connection.prepare(&format!(
        "{SELECT_ATTACHMENT} WHERE a.event_id = ?1 ORDER BY a.created_at, a.id"
    ))?;
    let attachments = statement
        .query_map([event_id], map_attachment)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(attachments)
}

/// Looks up the stored file of an attachment.
pub fn locate(connection: &Connection, id: &str) -> AppResult<StoredFile> {
    let id = validate::id("id", id)?;
    connection
        .query_row(
            "SELECT relative_path, media_type FROM attachments WHERE id = ?1",
            [&id],
            |row| {
                Ok(StoredFile {
                    relative_path: row.get(0)?,
                    media_type: row.get(1)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| AppError::not_found("Attachment", id))
}

/// A validated image import request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportRequest {
    pub session_id: String,
    /// Attach to this existing event instead of creating a new screenshot event.
    pub event_id: Option<String>,
    /// Title for a new screenshot event.
    pub title: String,
    /// Original file name, kept for reference only (never used to build paths).
    pub original_name: String,
    pub source: AttachmentSource,
    /// JSON object stored on a new event (capture target and trigger); `{}` otherwise.
    pub metadata: String,
}

pub const SESSION_HEADER: &str = "x-session-id";
pub const EVENT_HEADER: &str = "x-event-id";
pub const TITLE_HEADER: &str = "x-title";
pub const FILE_NAME_HEADER: &str = "x-file-name";
pub const SOURCE_HEADER: &str = "x-source";

fn header<'a>(headers: &'a HeaderMap, name: &str) -> AppResult<Option<&'a str>> {
    headers
        .get(name)
        .map(|value| {
            value.to_str().map_err(|_| {
                AppError::validation("file", format!("The {name} request header is not valid."))
            })
        })
        .transpose()
}

/// Reads a percent-encoded UTF-8 header (the webview encodes text with `encodeURIComponent`).
fn decoded_header(headers: &HeaderMap, name: &str) -> AppResult<Option<String>> {
    header(headers, name)?
        .map(|raw| {
            percent_decode_str(raw)
                .decode_utf8()
                .map(|text| text.into_owned())
                .map_err(|_| {
                    AppError::validation("file", format!("The {name} request header is not valid."))
                })
        })
        .transpose()
}

/// Collapses whitespace and replaces control characters, producing a single clean line.
pub(crate) fn clean_line(value: &str) -> String {
    value
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

pub(crate) fn truncate_chars(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

/// Keeps only the final component of a file name and removes control characters.
fn sanitize_file_name(raw: &str) -> String {
    let last = raw.rsplit(['/', '\\']).next().unwrap_or_default();
    truncate_chars(&clean_line(last), 255)
}

/// Title for a new screenshot event when none was given.
fn default_title(source: AttachmentSource, original_name: &str) -> String {
    if source == AttachmentSource::File {
        let stem = match original_name.rsplit_once('.') {
            Some((stem, _)) if !stem.trim().is_empty() => stem,
            _ => original_name,
        };
        let stem = truncate_chars(&clean_line(stem), events::TITLE_RULE.max_chars);
        if !stem.is_empty() {
            return stem;
        }
        return "Screenshot".into();
    }
    "Pasted screenshot".into()
}

impl ImportRequest {
    pub fn from_headers(headers: &HeaderMap) -> AppResult<Self> {
        let session_id = validate::id(
            "sessionId",
            header(headers, SESSION_HEADER)?.unwrap_or_default(),
        )?;
        let event_id = header(headers, EVENT_HEADER)?
            .filter(|value| !value.trim().is_empty())
            .map(|value| validate::id("eventId", value))
            .transpose()?;
        let source = match header(headers, SOURCE_HEADER)?.unwrap_or("file") {
            "file" => AttachmentSource::File,
            "clipboard" => AttachmentSource::Clipboard,
            _ => {
                return Err(AppError::validation(
                    "source",
                    "Images can be added from a file or the clipboard.",
                ));
            }
        };
        let original_name = decoded_header(headers, FILE_NAME_HEADER)?
            .map(|name| sanitize_file_name(&name))
            .unwrap_or_default();
        let title =
            match decoded_header(headers, TITLE_HEADER)?.filter(|title| !title.trim().is_empty()) {
                Some(title) => validate::text(&events::TITLE_RULE, &title)?,
                None => default_title(source, &original_name),
            };
        Ok(Self {
            session_id,
            event_id,
            title,
            original_name,
            source,
            metadata: "{}".into(),
        })
    }
}

/// Fails unless the image can be added to the requested session and event.
fn check_target(connection: &Connection, request: &ImportRequest) -> AppResult<()> {
    sessions::ensure_editable(connection, &request.session_id)?;
    if let Some(event_id) = &request.event_id {
        let owner: Option<String> = connection
            .query_row(
                "SELECT session_id FROM events WHERE id = ?1",
                [event_id],
                |row| row.get(0),
            )
            .optional()?;
        match owner {
            None => return Err(AppError::not_found("Event", event_id)),
            Some(owner) if owner != request.session_id => {
                return Err(AppError::validation(
                    "eventId",
                    "The step belongs to a different session.",
                ));
            }
            Some(_) => {}
        }
    }
    Ok(())
}

/// An image written to its final location but not yet recorded in the database.
struct StagedImage {
    id: String,
    relative_path: String,
    path: PathBuf,
    inspected: InspectedImage,
}

fn stage(attachments_dir: &Path, request: &ImportRequest, bytes: &[u8]) -> AppResult<StagedImage> {
    let inspected = storage::inspect_image(bytes)?;
    let id = clock::new_id();
    let relative_path = format!(
        "{}/{}.{}",
        request.session_id,
        id,
        inspected.format.extension()
    );
    let path = storage::resolve_contained(attachments_dir, &relative_path)?;
    storage::write_atomic(&path, bytes)?;
    Ok(StagedImage {
        id,
        relative_path,
        path,
        inspected,
    })
}

/// Removes a staged file after a failed import, and its session folder if now empty.
fn discard(staged: &StagedImage) {
    if let Err(error) = storage::remove_file_if_exists(&staged.path) {
        eprintln!(
            "DevTrace: could not remove {} after a failed import: {error}",
            staged.path.display()
        );
    }
    if let Some(folder) = staged.path.parent() {
        storage::remove_dir_if_empty(folder);
    }
}

fn record(
    connection: &mut Connection,
    request: &ImportRequest,
    staged: &StagedImage,
) -> AppResult<ImportedImage> {
    let transaction = connection.transaction()?;
    check_target(&transaction, request)?;
    let now = clock::now();
    let (event_id, event_created) = match &request.event_id {
        Some(event_id) => {
            transaction.execute(
                "UPDATE events SET updated_at = ?2 WHERE id = ?1",
                params![event_id, now],
            )?;
            (event_id.clone(), false)
        }
        None => {
            let event = ValidEvent {
                title: request.title.clone(),
                description: String::new(),
                notes: String::new(),
                code: String::new(),
                metadata: request.metadata.clone(),
            };
            let id = events::insert(
                &transaction,
                &request.session_id,
                EventType::Screenshot,
                request.source.event_source(),
                &event,
                &now,
            )?;
            (id, true)
        }
    };
    transaction.execute(
        "INSERT INTO attachments (id, session_id, event_id, kind, source, original_name, relative_path,
                                  media_type, byte_size, sha256, width, height, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            staged.id,
            request.session_id,
            event_id,
            AttachmentKind::Screenshot,
            request.source,
            request.original_name,
            staged.relative_path,
            staged.inspected.format.media_type(),
            staged.inspected.byte_size as i64,
            staged.inspected.sha256,
            staged.inspected.width,
            staged.inspected.height,
            now
        ],
    )?;
    sessions::touch(&transaction, &request.session_id, &now)?;
    transaction.commit()?;
    Ok(ImportedImage {
        event: events::get(connection, &event_id)?,
        attachment_id: staged.id.clone(),
        event_created,
    })
}

/// Imports an image with a single connection. Tests use this; the command runs the same steps
/// but writes the file without holding the database lock.
#[cfg(test)]
pub fn import(
    connection: &mut Connection,
    attachments_dir: &Path,
    request: &ImportRequest,
    bytes: &[u8],
) -> AppResult<ImportedImage> {
    check_target(connection, request)?;
    let staged = stage(attachments_dir, request, bytes)?;
    record(connection, request, &staged).inspect_err(|_| discard(&staged))
}

/// Imports image bytes through the application state: the target is checked, the file is
/// written without holding the database lock, then the rows are recorded (file removed on
/// failure). Used by the `import_image` command and by screen capture.
pub(crate) fn import_with_state(
    state: &AppState,
    request: &ImportRequest,
    bytes: &[u8],
) -> AppResult<ImportedImage> {
    state.with_db(|connection| check_target(connection, request))?;
    let staged = stage(&state.paths.attachments_dir, request, bytes)?;
    state
        .with_db(|connection| record(connection, request, &staged))
        .inspect_err(|_| discard(&staged))
}

fn validate_annotations(
    annotations: &[Annotation],
    width: Option<i64>,
    height: Option<i64>,
) -> AppResult<Vec<Annotation>> {
    if annotations.len() > MAX_ANNOTATIONS {
        return Err(AppError::validation(
            "annotations",
            format!("A screenshot can have at most {MAX_ANNOTATIONS} annotations."),
        ));
    }
    let mut seen = std::collections::HashSet::new();
    annotations
        .iter()
        .map(|annotation| {
            let id = validate::id("annotations", &annotation.id)?;
            if !seen.insert(id.clone()) {
                return Err(AppError::validation(
                    "annotations",
                    "Annotation identifiers must be unique.",
                ));
            }
            if annotation.width < MIN_ANNOTATION_SIDE || annotation.height < MIN_ANNOTATION_SIDE {
                return Err(AppError::validation(
                    "annotations",
                    "Annotations must be at least 4 pixels wide and tall.",
                ));
            }
            let right = u64::from(annotation.x) + u64::from(annotation.width);
            let bottom = u64::from(annotation.y) + u64::from(annotation.height);
            let outside = width.is_some_and(|w| right > w as u64)
                || height.is_some_and(|h| bottom > h as u64);
            if outside {
                return Err(AppError::validation(
                    "annotations",
                    "An annotation lies outside the image.",
                ));
            }
            Ok(Annotation {
                id,
                label: validate::text(&ANNOTATION_LABEL_RULE, &annotation.label)?,
                ..annotation.clone()
            })
        })
        .collect()
}

/// Replaces the highlight annotations of an attachment.
pub fn set_annotations(
    connection: &mut Connection,
    id: &str,
    annotations: &[Annotation],
) -> AppResult<Attachment> {
    let id = validate::id("id", id)?;
    let transaction = connection.transaction()?;
    let (session_id, event_id, width, height): (String, Option<String>, Option<i64>, Option<i64>) =
        transaction
            .query_row(
                "SELECT session_id, event_id, width, height FROM attachments WHERE id = ?1",
                [&id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?
            .ok_or_else(|| AppError::not_found("Attachment", &id))?;
    sessions::ensure_editable(&transaction, &session_id)?;
    let valid = validate_annotations(annotations, width, height)?;
    let now = clock::now();
    transaction.execute(
        "UPDATE attachments SET annotations_json = ?2 WHERE id = ?1",
        params![id, serde_json::to_string(&valid)?],
    )?;
    if let Some(event_id) = &event_id {
        transaction.execute(
            "UPDATE events SET updated_at = ?2 WHERE id = ?1",
            params![event_id, now],
        )?;
    }
    sessions::touch(&transaction, &session_id, &now)?;
    transaction.commit()?;
    get(connection, &id)
}

pub fn get(connection: &Connection, id: &str) -> AppResult<Attachment> {
    let id = validate::id("id", id)?;
    connection
        .query_row(
            &format!("{SELECT_ATTACHMENT} WHERE a.id = ?1"),
            [&id],
            map_attachment,
        )
        .optional()?
        .ok_or_else(|| AppError::not_found("Attachment", id))
}

/// Deletes an attachment row and returns the relative path of its file.
pub fn delete_records(
    connection: &mut Connection,
    id: &str,
) -> AppResult<(AttachmentDeletion, String)> {
    let id = validate::id("id", id)?;
    let transaction = connection.transaction()?;
    let (session_id, event_id, relative_path): (String, Option<String>, String) = transaction
        .query_row(
            "SELECT session_id, event_id, relative_path FROM attachments WHERE id = ?1",
            [&id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::not_found("Attachment", &id))?;
    sessions::ensure_editable(&transaction, &session_id)?;
    let now = clock::now();
    transaction.execute("DELETE FROM attachments WHERE id = ?1", [&id])?;
    if let Some(event_id) = &event_id {
        transaction.execute(
            "UPDATE events SET updated_at = ?2 WHERE id = ?1",
            params![event_id, now],
        )?;
    }
    sessions::touch(&transaction, &session_id, &now)?;
    transaction.commit()?;
    Ok((
        AttachmentDeletion {
            id,
            session_id,
            event_id,
            files: FileCleanup::default(),
        },
        relative_path,
    ))
}

/// Receives image bytes as the raw request body. Metadata travels in headers:
/// `x-session-id`, optional `x-event-id`, `x-source` (`file` or `clipboard`), and optional
/// percent-encoded `x-title` and `x-file-name`.
#[tauri::command]
pub async fn import_image(
    state: State<'_, AppState>,
    request: Request<'_>,
) -> AppResult<ImportedImage> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(AppError::validation(
            "file",
            "The image must be sent as raw bytes.",
        ));
    };
    let import = ImportRequest::from_headers(request.headers())?;
    import_with_state(&state, &import, bytes)
}

#[tauri::command]
pub async fn update_annotations(
    state: State<'_, AppState>,
    id: String,
    annotations: Vec<Annotation>,
) -> AppResult<Attachment> {
    state.with_db(|connection| set_annotations(connection, &id, &annotations))
}

#[tauri::command]
pub async fn delete_attachment(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<AttachmentDeletion> {
    let (mut deletion, path) = state.with_db(|connection| delete_records(connection, &id))?;
    deletion.files = storage::remove_files(&state.paths.attachments_dir, &[path]);
    Ok(deletion)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::features::events::EventInput;
    use crate::features::sessions::{SessionInput, SessionStatus};
    use crate::storage::test_images;
    use tauri::http::HeaderValue;

    fn session(connection: &Connection, title: &str) -> String {
        sessions::create(
            connection,
            &SessionInput {
                title: title.into(),
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

    fn request(session_id: &str, source: AttachmentSource, name: &str) -> ImportRequest {
        ImportRequest {
            session_id: session_id.into(),
            event_id: None,
            title: default_title(source, name),
            original_name: name.into(),
            source,
            metadata: "{}".into(),
        }
    }

    fn files_in(dir: &Path) -> Vec<PathBuf> {
        if !dir.exists() {
            return Vec::new();
        }
        let mut found = Vec::new();
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                found.extend(files_in(&path));
            } else {
                found.push(path);
            }
        }
        found
    }

    #[test]
    fn saves_validated_annotations_and_respects_the_completed_lock() {
        let temp = tempfile::tempdir().unwrap();
        let mut connection = db::open_in_memory();
        let session_id = session(&connection, "Annotate");
        let imported = import(
            &mut connection,
            temp.path(),
            &request(&session_id, AttachmentSource::Clipboard, "shot.png"),
            &test_images::png(200, 100),
        )
        .unwrap();
        let id = imported.attachment_id;
        assert!(imported.event.attachments[0].annotations.is_empty());
        assert!(imported.event.attachments[0].redacted_at.is_none());

        let box_at = |id: &str, x: u32, y: u32, width: u32, height: u32| Annotation {
            id: id.into(),
            x,
            y,
            width,
            height,
            label: "  Apply button \n".into(),
        };
        let saved = set_annotations(&mut connection, &id, &[box_at("a1", 10, 10, 50, 20)]).unwrap();
        assert_eq!(saved.annotations.len(), 1);
        assert_eq!(saved.annotations[0].label, "Apply button");
        assert_eq!(
            get(&connection, &id).unwrap().annotations,
            saved.annotations
        );

        let mut field_error = |annotations: &[Annotation]| {
            set_annotations(&mut connection, &id, annotations)
                .unwrap_err()
                .field()
        };
        assert_eq!(
            field_error(&[box_at("a1", 190, 0, 20, 20)]),
            Some("annotations")
        );
        assert_eq!(
            field_error(&[box_at("a1", 0, 0, 3, 20)]),
            Some("annotations")
        );
        assert_eq!(
            field_error(&[box_at("a1", 0, 0, 10, 10), box_at("a1", 20, 20, 10, 10)]),
            Some("annotations")
        );
        let too_many: Vec<Annotation> = (0..=MAX_ANNOTATIONS)
            .map(|index| box_at(&format!("a{index}"), 0, 0, 10, 10))
            .collect();
        assert_eq!(field_error(&too_many), Some("annotations"));
        let mut long_label = box_at("a1", 0, 0, 10, 10);
        long_label.label = "x".repeat(121);
        assert_eq!(field_error(&[long_label]), Some("annotations"));
        // Rejected updates leave the saved annotations untouched.
        assert_eq!(
            get(&connection, &id).unwrap().annotations,
            saved.annotations
        );

        let cleared = set_annotations(&mut connection, &id, &[]).unwrap();
        assert!(cleared.annotations.is_empty());

        sessions::set_status(&connection, &session_id, SessionStatus::Completed).unwrap();
        let locked =
            set_annotations(&mut connection, &id, &[box_at("a2", 0, 0, 10, 10)]).unwrap_err();
        assert_eq!(locked.kind(), "conflict");
        assert_eq!(
            set_annotations(&mut connection, &clock::new_id(), &[])
                .unwrap_err()
                .kind(),
            "not_found"
        );
    }

    #[test]
    fn annotation_payloads_reject_unknown_fields() {
        let parsed: Result<Annotation, _> = serde_json::from_str(
            r#"{"id":"a1","x":1,"y":2,"width":10,"height":10,"label":"","color":"red"}"#,
        );
        assert!(parsed.is_err());
        let parsed: Annotation =
            serde_json::from_str(r#"{"id":"a1","x":1,"y":2,"width":10,"height":10}"#).unwrap();
        assert_eq!(parsed.label, "");
    }

    #[test]
    fn imports_an_image_as_a_new_screenshot_event() {
        let temp = tempfile::tempdir().unwrap();
        let mut connection = db::open_in_memory();
        let session_id = session(&connection, "Configure NTP");
        let bytes = test_images::png(1920, 1080);

        let imported = import(
            &mut connection,
            temp.path(),
            &request(&session_id, AttachmentSource::File, "NTP settings.png"),
            &bytes,
        )
        .unwrap();
        assert!(imported.event_created);
        assert_eq!(imported.event.event_type, EventType::Screenshot);
        assert_eq!(imported.event.source, EventSource::File);
        assert_eq!(imported.event.title, "NTP settings");
        let attachment = &imported.event.attachments[0];
        assert_eq!(attachment.id, imported.attachment_id);
        assert_eq!(attachment.media_type, "image/png");
        assert_eq!(
            (attachment.width, attachment.height),
            (Some(1920), Some(1080))
        );
        assert_eq!(attachment.byte_size, bytes.len() as i64);
        assert_eq!(attachment.sha256, storage::sha256_hex(&bytes));
        assert_eq!(attachment.original_name, "NTP settings.png");

        let stored = locate(&connection, &attachment.id).unwrap();
        assert_eq!(
            stored.relative_path,
            format!("{session_id}/{}.png", attachment.id)
        );
        let path = storage::resolve_contained(temp.path(), &stored.relative_path).unwrap();
        assert_eq!(std::fs::read(path).unwrap(), bytes);

        let detail = sessions::get(&connection, &session_id).unwrap();
        assert_eq!(detail.summary.attachment_count, 1);
        assert_eq!(detail.attachment_bytes, bytes.len() as i64);
    }

    #[test]
    fn attaches_additional_images_to_an_existing_event() {
        let temp = tempfile::tempdir().unwrap();
        let mut connection = db::open_in_memory();
        let session_id = session(&connection, "Patch");
        let step = events::create(
            &mut connection,
            &session_id,
            EventType::Step,
            &EventInput {
                title: "Open Windows Update".into(),
                ..EventInput::default()
            },
        )
        .unwrap();
        let mut attach = request(&session_id, AttachmentSource::Clipboard, "image.png");
        attach.event_id = Some(step.id.clone());
        let first = import(
            &mut connection,
            temp.path(),
            &attach,
            &test_images::png(10, 10),
        )
        .unwrap();
        let second = import(
            &mut connection,
            temp.path(),
            &attach,
            &test_images::gif(5, 5),
        )
        .unwrap();
        assert!(!first.event_created && !second.event_created);
        assert_eq!(second.event.id, step.id);
        assert_eq!(second.event.attachments.len(), 2);
        assert_eq!(second.event.attachments[1].media_type, "image/gif");
        assert_eq!(
            second.event.attachments[1].source,
            AttachmentSource::Clipboard
        );
        assert_eq!(events::list(&connection, &session_id).unwrap().len(), 1);
    }

    #[test]
    fn rejected_imports_leave_no_files_or_rows() {
        let temp = tempfile::tempdir().unwrap();
        let mut connection = db::open_in_memory();
        let session_id = session(&connection, "Session A");
        let other_session = session(&connection, "Session B");
        let other_event = events::create(
            &mut connection,
            &other_session,
            EventType::Note,
            &EventInput {
                title: "Elsewhere".into(),
                ..EventInput::default()
            },
        )
        .unwrap();

        let not_an_image = import(
            &mut connection,
            temp.path(),
            &request(&session_id, AttachmentSource::File, "notes.txt"),
            b"plain text pretending to be a screenshot",
        )
        .unwrap_err();
        assert_eq!(not_an_image.field(), Some("file"));

        let mut wrong_event = request(&session_id, AttachmentSource::File, "a.png");
        wrong_event.event_id = Some(other_event.id.clone());
        assert_eq!(
            import(
                &mut connection,
                temp.path(),
                &wrong_event,
                &test_images::png(1, 1)
            )
            .unwrap_err()
            .field(),
            Some("eventId")
        );

        let missing_session = request(&clock::new_id(), AttachmentSource::File, "a.png");
        assert_eq!(
            import(
                &mut connection,
                temp.path(),
                &missing_session,
                &test_images::png(1, 1)
            )
            .unwrap_err()
            .kind(),
            "not_found"
        );

        events::create(
            &mut connection,
            &session_id,
            EventType::Note,
            &EventInput {
                title: "Done".into(),
                ..EventInput::default()
            },
        )
        .unwrap();
        sessions::set_status(&connection, &session_id, SessionStatus::Completed).unwrap();
        assert_eq!(
            import(
                &mut connection,
                temp.path(),
                &request(&session_id, AttachmentSource::File, "late.png"),
                &test_images::png(1, 1)
            )
            .unwrap_err()
            .kind(),
            "conflict"
        );

        assert!(files_in(temp.path()).is_empty());
        let attachments: i64 = connection
            .query_row("SELECT COUNT(*) FROM attachments", [], |row| row.get(0))
            .unwrap();
        assert_eq!(attachments, 0);
    }

    #[test]
    fn a_failed_database_write_removes_the_staged_file() {
        let temp = tempfile::tempdir().unwrap();
        let mut connection = db::open_in_memory();
        let session_id = session(&connection, "Race");
        let import_request = request(&session_id, AttachmentSource::File, "shot.png");
        let staged = stage(temp.path(), &import_request, &test_images::png(4, 4)).unwrap();
        assert!(staged.path.is_file());
        // The session disappears between writing the file and recording it.
        sessions::delete_records(&mut connection, &session_id).unwrap();
        let error = record(&mut connection, &import_request, &staged).unwrap_err();
        assert_eq!(error.kind(), "not_found");
        discard(&staged);
        assert!(files_in(temp.path()).is_empty());
        assert!(!temp.path().join(&session_id).exists());
    }

    #[test]
    fn deletes_an_attachment_and_its_file() {
        let temp = tempfile::tempdir().unwrap();
        let mut connection = db::open_in_memory();
        let session_id = session(&connection, "Cleanup");
        let imported = import(
            &mut connection,
            temp.path(),
            &request(&session_id, AttachmentSource::File, "a.png"),
            &test_images::png(2, 2),
        )
        .unwrap();
        let (deletion, path) = delete_records(&mut connection, &imported.attachment_id).unwrap();
        assert_eq!(
            deletion.event_id.as_deref(),
            Some(imported.event.id.as_str())
        );
        let cleanup = storage::remove_files(temp.path(), &[path]);
        assert_eq!(cleanup.removed, 1);
        assert!(files_in(temp.path()).is_empty());
        // The event itself is kept; only the image was removed.
        assert!(
            events::get(&connection, &imported.event.id)
                .unwrap()
                .attachments
                .is_empty()
        );
        assert_eq!(
            locate(&connection, &imported.attachment_id)
                .unwrap_err()
                .kind(),
            "not_found"
        );
    }

    #[test]
    fn parses_and_sanitizes_import_headers() {
        let session_id = clock::new_id();
        let mut headers = HeaderMap::new();
        headers.insert(SESSION_HEADER, HeaderValue::from_str(&session_id).unwrap());
        headers.insert(
            FILE_NAME_HEADER,
            HeaderValue::from_static("C%3A%5CUsers%5Cme%5CPol%C3%ADtica%20export.png"),
        );
        let parsed = ImportRequest::from_headers(&headers).unwrap();
        assert_eq!(parsed.source, AttachmentSource::File);
        assert_eq!(parsed.original_name, "Política export.png");
        assert_eq!(parsed.title, "Política export");
        assert_eq!(parsed.event_id, None);

        headers.insert(
            TITLE_HEADER,
            HeaderValue::from_static("Firewall%20rule%20%231"),
        );
        headers.insert(SOURCE_HEADER, HeaderValue::from_static("clipboard"));
        let titled = ImportRequest::from_headers(&headers).unwrap();
        assert_eq!(titled.title, "Firewall rule #1");
        assert_eq!(titled.source, AttachmentSource::Clipboard);

        headers.insert(TITLE_HEADER, HeaderValue::from_static("Two%0Alines"));
        assert_eq!(
            ImportRequest::from_headers(&headers).unwrap_err().field(),
            Some("title")
        );
        headers.remove(TITLE_HEADER);

        headers.insert(SOURCE_HEADER, HeaderValue::from_static("capture"));
        assert_eq!(
            ImportRequest::from_headers(&headers).unwrap_err().field(),
            Some("source")
        );
        headers.insert(SOURCE_HEADER, HeaderValue::from_static("clipboard"));
        assert_eq!(
            ImportRequest::from_headers(&headers).unwrap().title,
            "Pasted screenshot"
        );

        headers.insert(SESSION_HEADER, HeaderValue::from_static("..%2F..%2Fetc"));
        assert_eq!(
            ImportRequest::from_headers(&headers).unwrap_err().field(),
            Some("sessionId")
        );
        assert!(ImportRequest::from_headers(&HeaderMap::new()).is_err());
    }
}
