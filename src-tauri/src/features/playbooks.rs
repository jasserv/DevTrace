//! Playbooks (Milestone 5): reusable procedures generated from reviewed sessions or written from
//! scratch, edited as structured documents, and published as immutable revisions.
//!
//! Evidence is copied into `<workspace>/playbook-assets/<playbook_id>/` when a playbook is
//! generated, so a playbook and its revisions stay complete when a session changes or is deleted.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension, Row, Transaction, params};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::clock;
use crate::error::{AppError, AppResult};
use crate::features::attachments::{self, Annotation, StoredFile};
use crate::features::events;
use crate::features::playbook_content::{self, PlaybookContent};
use crate::features::sessions::{self, ReviewState, SessionStatus};
use crate::features::settings;
use crate::state::AppState;
use crate::storage::{self, FileCleanup};
use crate::validate::{self, TextRule};

text_enum! {
    /// Publication workflow for a playbook.
    pub enum PlaybookStatus {
        Draft => "draft",
        InReview => "in_review",
        Published => "published",
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybookSummary {
    pub id: String,
    pub title: String,
    pub summary: String,
    pub project_id: Option<String>,
    pub project_name: Option<String>,
    pub status: PlaybookStatus,
    pub platform: String,
    pub product: String,
    pub product_version: String,
    pub environment: String,
    pub task_type: String,
    pub author: String,
    pub created_at: String,
    pub updated_at: String,
    pub published_at: Option<String>,
    pub session_count: i64,
    pub step_count: i64,
    pub revision_count: i64,
    /// Set when the playbook was marked out of date.
    pub outdated_at: Option<String>,
}

/// An evidence copy used by a playbook.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybookAsset {
    pub id: String,
    pub playbook_id: String,
    pub source_attachment_id: Option<String>,
    pub source_event_id: Option<String>,
    pub media_type: String,
    pub byte_size: i64,
    pub sha256: String,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub annotations: Vec<Annotation>,
    pub redacted_at: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedSession {
    pub id: String,
    pub title: String,
    pub status: SessionStatus,
    pub review_state: ReviewState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionSummary {
    pub id: String,
    pub revision_number: i64,
    pub title: String,
    pub note: String,
    pub author: String,
    pub created_at: String,
}

/// A working copy that a restore replaced, kept so it can be restored in turn (Milestone 7).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePointSummary {
    pub id: String,
    pub title: String,
    /// What replaced it: `revision:<number>` or `restore-point:<id>`.
    pub replaced_by: String,
    pub created_at: String,
}

/// The playbook a duplicate was made from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BasedOn {
    /// None when the original playbook was deleted later.
    pub playbook_id: Option<String>,
    pub title: Option<String>,
    pub revision_number: Option<i64>,
}

/// Metadata and content of one version of a playbook. Published revisions and restore points
/// store exactly this (as `snapshot_json`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VersionSnapshot {
    pub title: String,
    pub summary: String,
    pub project_id: Option<String>,
    pub project_name: Option<String>,
    pub platform: String,
    pub product: String,
    pub product_version: String,
    pub environment: String,
    pub task_type: String,
    pub author: String,
    pub content: PlaybookContent,
}

impl VersionSnapshot {
    /// The working copy of a playbook as a snapshot.
    pub fn of(detail: &PlaybookDetail) -> Self {
        let summary = &detail.summary;
        Self {
            title: summary.title.clone(),
            summary: summary.summary.clone(),
            project_id: summary.project_id.clone(),
            project_name: summary.project_name.clone(),
            platform: summary.platform.clone(),
            product: summary.product.clone(),
            product_version: summary.product_version.clone(),
            environment: summary.environment.clone(),
            task_type: summary.task_type.clone(),
            author: summary.author.clone(),
            content: detail.content.clone(),
        }
    }

    /// Reads a stored snapshot.
    pub fn from_json(raw: &str) -> AppResult<Self> {
        serde_json::from_str(raw).map_err(|error| {
            AppError::internal(format!("A stored version could not be read: {error}"))
        })
    }

    /// True when both describe the same document (project names are display-only).
    pub fn same_document(&self, other: &Self) -> bool {
        Self {
            project_name: None,
            ..self.clone()
        } == Self {
            project_name: None,
            ..other.clone()
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybookDetail {
    #[serde(flatten)]
    pub summary: PlaybookSummary,
    pub content: PlaybookContent,
    pub assets: Vec<PlaybookAsset>,
    pub sessions: Vec<LinkedSession>,
    pub revisions: Vec<RevisionSummary>,
    pub restore_points: Vec<RestorePointSummary>,
    pub outdated_note: String,
    /// Set while the draft started from an older revision (cleared when published).
    pub restored_from_revision: Option<i64>,
    pub based_on: Option<BasedOn>,
}

/// Editable metadata of a playbook.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlaybookInput {
    pub title: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub platform: String,
    #[serde(default)]
    pub product: String,
    #[serde(default)]
    pub product_version: String,
    #[serde(default)]
    pub environment: String,
    #[serde(default)]
    pub task_type: String,
    #[serde(default)]
    pub author: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybookDeletion {
    pub id: String,
    pub title: String,
    pub files: FileCleanup,
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

pub const TITLE_RULE: TextRule = TextRule {
    field: "title",
    label: "Playbook title",
    max_chars: 200,
    required: true,
    multiline: false,
};
const SUMMARY_RULE: TextRule = TextRule {
    field: "summary",
    label: "Description",
    max_chars: 2_000,
    required: false,
    multiline: true,
};
const NOTE_RULE: TextRule = TextRule {
    field: "note",
    label: "Revision note",
    max_chars: 2_000,
    required: false,
    multiline: true,
};

struct ValidInput {
    title: String,
    summary: String,
    project_id: Option<String>,
    platform: String,
    product: String,
    product_version: String,
    environment: String,
    task_type: String,
    author: String,
}

fn validated(connection: &Connection, input: &PlaybookInput) -> AppResult<ValidInput> {
    let project_id = match input
        .project_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        Some(id) => {
            let id = validate::id("projectId", id)?;
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
        None => None,
    };
    Ok(ValidInput {
        title: validate::text(&TITLE_RULE, &input.title)?,
        summary: validate::preformatted(&SUMMARY_RULE, &input.summary)?,
        project_id,
        platform: validate::text(&line("platform", "Platform", 120), &input.platform)?,
        product: validate::text(&line("product", "Product", 120), &input.product)?,
        product_version: validate::text(
            &line("productVersion", "Version", 60),
            &input.product_version,
        )?,
        environment: validate::text(&line("environment", "Environment", 60), &input.environment)?,
        task_type: validate::text(&line("taskType", "Task type", 60), &input.task_type)?,
        author: validate::text(&line("author", "Author", 80), &input.author)?,
    })
}

const SELECT_PLAYBOOK: &str = "
    SELECT b.id, b.title, b.summary, b.project_id, p.name, b.status, b.platform, b.product,
           b.product_version, b.environment, b.task_type, b.author, b.created_at, b.updated_at,
           b.published_at,
           (SELECT COUNT(*) FROM playbook_sessions ps WHERE ps.playbook_id = b.id),
           COALESCE(json_array_length(b.content_json, '$.steps'), 0),
           (SELECT COUNT(*) FROM playbook_revisions r WHERE r.playbook_id = b.id),
           b.outdated_at
    FROM playbooks b
    LEFT JOIN projects p ON p.id = b.project_id";

fn map_playbook(row: &Row<'_>) -> rusqlite::Result<PlaybookSummary> {
    Ok(PlaybookSummary {
        id: row.get(0)?,
        title: row.get(1)?,
        summary: row.get(2)?,
        project_id: row.get(3)?,
        project_name: row.get(4)?,
        status: row.get(5)?,
        platform: row.get(6)?,
        product: row.get(7)?,
        product_version: row.get(8)?,
        environment: row.get(9)?,
        task_type: row.get(10)?,
        author: row.get(11)?,
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
        published_at: row.get(14)?,
        session_count: row.get(15)?,
        step_count: row.get(16)?,
        revision_count: row.get(17)?,
        outdated_at: row.get(18)?,
    })
}

/// Most recently updated first, optionally restricted to one status.
pub fn list(
    connection: &Connection,
    status: Option<PlaybookStatus>,
    limit: Option<u32>,
) -> AppResult<Vec<PlaybookSummary>> {
    let filter = if status.is_some() {
        "WHERE b.status = ?1"
    } else {
        ""
    };
    let sql = format!(
        "{SELECT_PLAYBOOK} {filter} ORDER BY b.updated_at DESC LIMIT {}",
        limit.map_or(-1, i64::from)
    );
    let mut statement = connection.prepare(&sql)?;
    let rows = match status {
        Some(status) => statement
            .query_map([status], map_playbook)?
            .collect::<Result<Vec<_>, _>>()?,
        None => statement
            .query_map([], map_playbook)?
            .collect::<Result<Vec<_>, _>>()?,
    };
    Ok(rows)
}

fn summary(connection: &Connection, id: &str) -> AppResult<PlaybookSummary> {
    connection
        .query_row(
            &format!("{SELECT_PLAYBOOK} WHERE b.id = ?1"),
            [id],
            map_playbook,
        )
        .optional()?
        .ok_or_else(|| AppError::not_found("Playbook", id))
}

fn map_asset(row: &Row<'_>) -> rusqlite::Result<PlaybookAsset> {
    let annotations: String = row.get(9)?;
    Ok(PlaybookAsset {
        id: row.get(0)?,
        playbook_id: row.get(1)?,
        source_attachment_id: row.get(2)?,
        source_event_id: row.get(3)?,
        media_type: row.get(4)?,
        byte_size: row.get(5)?,
        sha256: row.get(6)?,
        width: row.get(7)?,
        height: row.get(8)?,
        annotations: serde_json::from_str(&annotations).unwrap_or_default(),
        redacted_at: row.get(10)?,
        created_at: row.get(11)?,
    })
}

pub fn assets(connection: &Connection, playbook_id: &str) -> AppResult<Vec<PlaybookAsset>> {
    let mut statement = connection.prepare(
        "SELECT id, playbook_id, source_attachment_id, source_event_id, media_type, byte_size, sha256,
                width, height, annotations_json, redacted_at, created_at
         FROM playbook_assets WHERE playbook_id = ?1 ORDER BY created_at, id",
    )?;
    let rows = statement
        .query_map([playbook_id], map_asset)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn content_of(connection: &Connection, id: &str) -> AppResult<PlaybookContent> {
    let raw: String = connection.query_row(
        "SELECT content_json FROM playbooks WHERE id = ?1",
        [id],
        |row| row.get(0),
    )?;
    Ok(PlaybookContent::from_json(&raw))
}

pub fn get(connection: &Connection, id: &str) -> AppResult<PlaybookDetail> {
    let id = validate::id("id", id)?;
    let summary = summary(connection, &id)?;
    let (raw, outdated_note, restored_from_revision, based_on_id, based_on_revision): (
        String,
        String,
        Option<i64>,
        Option<String>,
        Option<i64>,
    ) = connection.query_row(
        "SELECT content_json, outdated_note, restored_from_revision, based_on_playbook_id, based_on_revision
         FROM playbooks WHERE id = ?1",
        [&id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
    )?;
    let sessions = {
        let mut statement = connection.prepare(
            "SELECT s.id, s.title, s.status, s.review_state FROM playbook_sessions ps
             JOIN sessions s ON s.id = ps.session_id WHERE ps.playbook_id = ?1 ORDER BY ps.linked_at",
        )?;
        statement
            .query_map([&id], |row| {
                Ok(LinkedSession {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    status: row.get(2)?,
                    review_state: row.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?
    };
    let revisions = {
        let mut statement = connection.prepare(
            "SELECT id, revision_number, title, note, author, created_at FROM playbook_revisions
             WHERE playbook_id = ?1 ORDER BY revision_number DESC",
        )?;
        statement
            .query_map([&id], |row| {
                Ok(RevisionSummary {
                    id: row.get(0)?,
                    revision_number: row.get(1)?,
                    title: row.get(2)?,
                    note: row.get(3)?,
                    author: row.get(4)?,
                    created_at: row.get(5)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?
    };
    let restore_points = {
        let mut statement = connection.prepare(
            "SELECT id, title, replaced_by, created_at FROM playbook_restore_points
             WHERE playbook_id = ?1 ORDER BY created_at DESC, id DESC",
        )?;
        statement
            .query_map([&id], |row| {
                Ok(RestorePointSummary {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    replaced_by: row.get(2)?,
                    created_at: row.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?
    };
    let based_on = if based_on_id.is_some() || based_on_revision.is_some() {
        let title = match &based_on_id {
            Some(original) => connection
                .query_row(
                    "SELECT title FROM playbooks WHERE id = ?1",
                    [original],
                    |row| row.get(0),
                )
                .optional()?,
            None => None,
        };
        Some(BasedOn {
            playbook_id: based_on_id,
            title,
            revision_number: based_on_revision,
        })
    } else {
        None
    };
    Ok(PlaybookDetail {
        content: PlaybookContent::from_json(&raw),
        assets: assets(connection, &id)?,
        sessions,
        revisions,
        restore_points,
        outdated_note,
        restored_from_revision,
        based_on,
        summary,
    })
}

pub(crate) fn status_of(connection: &Connection, id: &str) -> AppResult<PlaybookStatus> {
    connection
        .query_row("SELECT status FROM playbooks WHERE id = ?1", [id], |row| {
            row.get(0)
        })
        .optional()?
        .ok_or_else(|| AppError::not_found("Playbook", id))
}

pub(crate) fn author_name(connection: &Connection) -> String {
    settings::load(connection)
        .map(|loaded| loaded.author_name)
        .unwrap_or_default()
}

fn insert_playbook(
    tx: &Transaction<'_>,
    id: &str,
    input: &ValidInput,
    content: &PlaybookContent,
    now: &str,
) -> AppResult<()> {
    tx.execute(
        "INSERT INTO playbooks (id, project_id, title, summary, status, platform, product, product_version,
                                environment, task_type, author, content_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'draft', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)",
        params![
            id,
            input.project_id,
            input.title,
            input.summary,
            input.platform,
            input.product,
            input.product_version,
            input.environment,
            input.task_type,
            input.author,
            serde_json::to_string(content)?,
            now
        ],
    )?;
    Ok(())
}

/// Creates an empty draft playbook.
pub fn create_blank(
    connection: &mut Connection,
    input: &PlaybookInput,
) -> AppResult<PlaybookDetail> {
    let mut valid = validated(connection, input)?;
    if valid.author.is_empty() {
        valid.author = author_name(connection);
    }
    let id = clock::new_id();
    let tx = connection.transaction()?;
    insert_playbook(&tx, &id, &valid, &PlaybookContent::default(), &clock::now())?;
    tx.commit()?;
    get(connection, &id)
}

/// An evidence file copied for a playbook, before its row is recorded.
struct CopiedAsset {
    id: String,
    source_attachment_id: String,
    source_event_id: Option<String>,
    relative_path: String,
    path: PathBuf,
    inspected: storage::InspectedImage,
    annotations: Vec<Annotation>,
    /// Carried over from the source: a copy of a redacted screenshot is redacted too.
    redacted_at: Option<String>,
}

/// What generation needs from the session, read in one go.
struct GenerationPlan {
    session: sessions::SessionDetail,
    events: Vec<events::Event>,
    author: String,
    /// Stored location of every attachment of an approved step.
    files: HashMap<String, String>,
}

fn plan_generation(connection: &Connection, session_id: &str) -> AppResult<GenerationPlan> {
    let session_id = validate::id("sessionId", session_id)?;
    let session = sessions::get(connection, &session_id)?;
    let events = events::list(connection, &session_id)?;
    let approved: Vec<&events::Event> = events
        .iter()
        .filter(|event| event.review_status == events::EventReviewStatus::Approved)
        .collect();
    if approved.is_empty() {
        return Err(AppError::conflict(
            "sessionId",
            "Approve at least one step of this session before creating a playbook from it.",
        ));
    }
    let mut files = HashMap::new();
    for attachment in approved.iter().flat_map(|event| event.attachments.iter()) {
        let stored = attachments::locate(connection, &attachment.id)?;
        files.insert(attachment.id.clone(), stored.relative_path);
    }
    Ok(GenerationPlan {
        session,
        events,
        author: author_name(connection),
        files,
    })
}

fn copy_evidence(
    attachments_dir: &Path,
    assets_dir: &Path,
    playbook_id: &str,
    plan: &GenerationPlan,
) -> AppResult<Vec<CopiedAsset>> {
    let mut copies = Vec::new();
    let approved = plan
        .events
        .iter()
        .filter(|event| event.review_status == events::EventReviewStatus::Approved);
    for event in approved {
        for attachment in &event.attachments {
            let copied = plan
                .files
                .get(&attachment.id)
                .ok_or_else(|| {
                    AppError::conflict(
                        "file",
                        "A screenshot changed while the playbook was created. Try again.",
                    )
                })
                .and_then(|relative| {
                    copy_one(
                        attachments_dir,
                        assets_dir,
                        playbook_id,
                        event,
                        attachment,
                        relative,
                    )
                });
            match copied {
                Ok(copy) => copies.push(copy),
                Err(error) => {
                    discard_copies(&copies);
                    return Err(error);
                }
            }
        }
    }
    Ok(copies)
}

fn copy_one(
    attachments_dir: &Path,
    assets_dir: &Path,
    playbook_id: &str,
    event: &events::Event,
    attachment: &attachments::Attachment,
    relative: &str,
) -> AppResult<CopiedAsset> {
    let source_path = storage::resolve_contained(attachments_dir, relative)?;
    let bytes = std::fs::read(&source_path).map_err(|error| {
        AppError::conflict(
            "file",
            format!(
                "The screenshot of \"{}\" could not be read ({error}).",
                event.title
            ),
        )
    })?;
    let inspected = storage::inspect_image(&bytes)?;
    let id = clock::new_id();
    let relative_path = format!("{playbook_id}/{id}.{}", inspected.format.extension());
    let path = storage::resolve_contained(assets_dir, &relative_path)?;
    storage::write_atomic(&path, &bytes)?;
    Ok(CopiedAsset {
        id,
        source_attachment_id: attachment.id.clone(),
        source_event_id: Some(event.id.clone()),
        relative_path,
        path,
        inspected,
        annotations: attachment.annotations.clone(),
        redacted_at: attachment.redacted_at.clone(),
    })
}

fn discard_copies(copies: &[CopiedAsset]) {
    for copy in copies {
        let _ = storage::remove_file_if_exists(&copy.path);
    }
}

fn record_generation(
    connection: &mut Connection,
    playbook_id: &str,
    plan: &GenerationPlan,
    copies: &[CopiedAsset],
) -> AppResult<()> {
    let session = &plan.session.summary;
    let input = ValidInput {
        title: session.title.clone(),
        summary: String::new(),
        project_id: session.project_id.clone(),
        platform: attachments::truncate_chars(&session.application, 120),
        product: String::new(),
        product_version: String::new(),
        environment: session.environment.clone(),
        task_type: String::new(),
        author: plan.author.clone(),
    };
    let steps = playbook_content::steps_from_events(&session.id, &plan.events, |event| {
        copies
            .iter()
            .filter(|copy| copy.source_event_id.as_deref() == Some(event.id.as_str()))
            .map(|copy| copy.id.clone())
            .collect()
    });
    let content = PlaybookContent {
        steps,
        ..PlaybookContent::default()
    };
    let tx = connection.transaction()?;
    // The session may have changed while files were copied.
    sessions::ensure_exists(&tx, &session.id)?;
    let now = clock::now();
    insert_playbook(&tx, playbook_id, &input, &content, &now)?;
    for copy in copies {
        tx.execute(
            "INSERT INTO playbook_assets (id, playbook_id, source_attachment_id, source_event_id, relative_path,
                                          media_type, byte_size, sha256, width, height, annotations_json, redacted_at, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                copy.id,
                playbook_id,
                copy.source_attachment_id,
                copy.source_event_id,
                copy.relative_path,
                copy.inspected.format.media_type(),
                copy.inspected.byte_size as i64,
                copy.inspected.sha256,
                copy.inspected.width,
                copy.inspected.height,
                serde_json::to_string(&copy.annotations)?,
                copy.redacted_at,
                now
            ],
        )?;
    }
    tx.execute(
        "INSERT INTO playbook_sessions (playbook_id, session_id, linked_at) VALUES (?1, ?2, ?3)",
        params![playbook_id, session.id, now],
    )?;
    tx.commit()?;
    Ok(())
}

/// Generates a draft playbook from the approved steps of a session (single connection; tests).
#[cfg(test)]
pub fn generate(
    connection: &mut Connection,
    attachments_dir: &Path,
    assets_dir: &Path,
    session_id: &str,
) -> AppResult<PlaybookDetail> {
    let plan = plan_generation(connection, session_id)?;
    let id = clock::new_id();
    let copies = copy_evidence(attachments_dir, assets_dir, &id, &plan)?;
    if let Err(error) = record_generation(connection, &id, &plan, &copies) {
        discard_copies(&copies);
        return Err(error);
    }
    get(connection, &id)
}

/// Generates a draft playbook; evidence is copied without holding the database lock.
pub fn generate_with_state(state: &AppState, session_id: &str) -> AppResult<PlaybookDetail> {
    let plan = state.with_db(|connection| plan_generation(connection, session_id))?;
    let id = clock::new_id();
    let copies = copy_evidence(
        &state.paths.attachments_dir,
        &state.paths.assets_dir,
        &id,
        &plan,
    )?;
    if let Err(error) =
        state.with_db(|connection| record_generation(connection, &id, &plan, &copies))
    {
        discard_copies(&copies);
        if let Ok(folder) = storage::resolve_contained(&state.paths.assets_dir, &id) {
            storage::remove_dir_if_empty(&folder);
        }
        return Err(error);
    }
    state.with_db(|connection| get(connection, &id))
}

/// Asset ids referenced by any revision or restore point of a playbook (never deleted while
/// referenced).
pub fn referenced_by_history(
    connection: &Connection,
    playbook_id: &str,
) -> AppResult<HashSet<String>> {
    let mut statement = connection.prepare(
        "SELECT snapshot_json FROM playbook_revisions WHERE playbook_id = ?1
         UNION ALL
         SELECT snapshot_json FROM playbook_restore_points WHERE playbook_id = ?1",
    )?;
    let snapshots = statement
        .query_map([playbook_id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    let mut ids = HashSet::new();
    for raw in snapshots {
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap_or_default();
        if let Ok(content) = serde_json::from_value::<PlaybookContent>(value["content"].clone()) {
            ids.extend(content.asset_ids().into_iter().map(str::to_string));
        }
    }
    Ok(ids)
}

/// Saves metadata and content of a draft. Evidence copies no longer used by the draft or any
/// revision or restore point are removed; their relative paths are returned so files can be
/// deleted afterwards.
pub fn save(
    connection: &mut Connection,
    id: &str,
    input: &PlaybookInput,
    content: &PlaybookContent,
) -> AppResult<(PlaybookDetail, Vec<String>)> {
    let id = validate::id("id", id)?;
    if status_of(connection, &id)? != PlaybookStatus::Draft {
        return Err(AppError::conflict(
            "status",
            "Only drafts can be edited. Return the playbook to draft first.",
        ));
    }
    let valid = validated(connection, input)?;
    let asset_ids: HashSet<String> = assets(connection, &id)?
        .into_iter()
        .map(|asset| asset.id)
        .collect();
    let content = playbook_content::validate_content(content, &asset_ids)?;
    let mut keep: HashSet<String> = content
        .asset_ids()
        .into_iter()
        .map(str::to_string)
        .collect();
    keep.extend(referenced_by_history(connection, &id)?);
    let tx = connection.transaction()?;
    let now = clock::now();
    tx.execute(
        "UPDATE playbooks SET project_id = ?2, title = ?3, summary = ?4, platform = ?5, product = ?6,
                product_version = ?7, environment = ?8, task_type = ?9, author = ?10, content_json = ?11, updated_at = ?12
         WHERE id = ?1",
        params![
            id,
            valid.project_id,
            valid.title,
            valid.summary,
            valid.platform,
            valid.product,
            valid.product_version,
            valid.environment,
            valid.task_type,
            valid.author,
            serde_json::to_string(&content)?,
            now
        ],
    )?;
    let mut removed = Vec::new();
    {
        let mut statement =
            tx.prepare("SELECT id, relative_path FROM playbook_assets WHERE playbook_id = ?1")?;
        let rows = statement
            .query_map([&id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        for (asset_id, path) in rows {
            if !keep.contains(&asset_id) {
                removed.push((asset_id, path));
            }
        }
    }
    for (asset_id, _) in &removed {
        tx.execute("DELETE FROM playbook_assets WHERE id = ?1", [asset_id])?;
    }
    tx.commit()?;
    Ok((
        get(connection, &id)?,
        removed.into_iter().map(|(_, path)| path).collect(),
    ))
}

/// Moves a playbook through draft → in review → published. Publishing records an immutable
/// revision; returning a published playbook to draft starts the next version.
pub fn set_status(
    connection: &mut Connection,
    id: &str,
    status: PlaybookStatus,
    note: &str,
) -> AppResult<PlaybookDetail> {
    let id = validate::id("id", id)?;
    let note = validate::preformatted(&NOTE_RULE, note)?;
    let current = status_of(connection, &id)?;
    if current == status {
        return get(connection, &id);
    }
    let content = content_of(connection, &id)?;
    if matches!(status, PlaybookStatus::InReview | PlaybookStatus::Published)
        && content.steps.is_empty()
    {
        return Err(AppError::conflict(
            "status",
            "Add at least one step before submitting or publishing this playbook.",
        ));
    }
    let tx = connection.transaction()?;
    let now = clock::now();
    match status {
        PlaybookStatus::Published => {
            let detail = get(&tx, &id)?;
            let number: i64 = tx.query_row(
                "SELECT COALESCE(MAX(revision_number), 0) + 1 FROM playbook_revisions WHERE playbook_id = ?1",
                [&id],
                |row| row.get(0),
            )?;
            let summary = &detail.summary;
            let snapshot = serde_json::to_string(&VersionSnapshot::of(&detail))?;
            tx.execute(
                "INSERT INTO playbook_revisions (id, playbook_id, revision_number, title, snapshot_json, note, author, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    clock::new_id(),
                    id,
                    number,
                    summary.title,
                    snapshot,
                    note,
                    attachments::truncate_chars(&author_name(&tx), 80),
                    now
                ],
            )?;
            tx.execute(
                "UPDATE playbooks SET status = 'published', published_at = ?2, outdated_at = NULL, outdated_note = '',
                        restored_from_revision = NULL, updated_at = ?2
                 WHERE id = ?1",
                params![id, now],
            )?;
        }
        PlaybookStatus::InReview | PlaybookStatus::Draft => {
            tx.execute(
                "UPDATE playbooks SET status = ?2, updated_at = ?3 WHERE id = ?1",
                params![id, status, now],
            )?;
        }
    }
    tx.commit()?;
    get(connection, &id)
}

/// Deletes a playbook with its evidence copies and revisions; returns the folder to remove.
pub fn delete_records(
    connection: &mut Connection,
    id: &str,
) -> AppResult<(PlaybookDeletion, String)> {
    let id = validate::id("id", id)?;
    let title: String = connection
        .query_row("SELECT title FROM playbooks WHERE id = ?1", [&id], |row| {
            row.get(0)
        })
        .optional()?
        .ok_or_else(|| AppError::not_found("Playbook", &id))?;
    let tx = connection.transaction()?;
    tx.execute("DELETE FROM playbooks WHERE id = ?1", [&id])?;
    tx.commit()?;
    Ok((
        PlaybookDeletion {
            id: id.clone(),
            title,
            files: FileCleanup::default(),
        },
        id,
    ))
}

/// Removes a deleted playbook's evidence folder.
pub fn remove_playbook_files(assets_dir: &Path, playbook_id: &str) -> FileCleanup {
    let mut cleanup = FileCleanup::default();
    if let Ok(folder) = storage::resolve_contained(assets_dir, playbook_id) {
        match storage::remove_dir_if_exists(&folder) {
            Ok(true) => cleanup.removed += 1,
            Ok(false) => {}
            Err(error) => {
                eprintln!("DevTrace: could not remove {}: {error}", folder.display());
                cleanup.failed += 1;
            }
        }
    }
    cleanup
}

/// Where an evidence copy lives, for the `evidence` protocol handler.
pub fn locate_asset(connection: &Connection, id: &str) -> AppResult<StoredFile> {
    let id = validate::id("id", id)?;
    connection
        .query_row(
            "SELECT relative_path, media_type FROM playbook_assets WHERE id = ?1",
            [&id],
            |row| {
                Ok(StoredFile {
                    relative_path: row.get(0)?,
                    media_type: row.get(1)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| AppError::not_found("Playbook image", id))
}

/// Evidence copies made from an attachment: `(asset id, relative path, width, height)`.
pub fn copies_of_attachment(
    connection: &Connection,
    attachment_id: &str,
) -> AppResult<Vec<(String, String, u32, u32)>> {
    let mut statement = connection.prepare(
        "SELECT id, relative_path, width, height FROM playbook_assets WHERE source_attachment_id = ?1",
    )?;
    let rows = statement
        .query_map([attachment_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<i64>>(2)?.unwrap_or(0).max(0) as u32,
                row.get::<_, Option<i64>>(3)?.unwrap_or(0).max(0) as u32,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

// ---------------------------------------------------------------------------------------------
// Commands

#[tauri::command]
pub async fn list_playbooks(state: State<'_, AppState>) -> AppResult<Vec<PlaybookSummary>> {
    state.with_db(|connection| list(connection, None, None))
}

#[tauri::command]
pub async fn get_playbook(state: State<'_, AppState>, id: String) -> AppResult<PlaybookDetail> {
    state.with_db(|connection| get(connection, &id))
}

#[tauri::command]
pub async fn create_playbook(
    state: State<'_, AppState>,
    input: PlaybookInput,
) -> AppResult<PlaybookDetail> {
    state.with_db(|connection| create_blank(connection, &input))
}

#[tauri::command]
pub async fn create_playbook_from_session(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<PlaybookDetail> {
    generate_with_state(&state, &session_id)
}

#[tauri::command]
pub async fn save_playbook(
    state: State<'_, AppState>,
    id: String,
    input: PlaybookInput,
    content: PlaybookContent,
) -> AppResult<PlaybookDetail> {
    let (detail, removed) = state.with_db(|connection| save(connection, &id, &input, &content))?;
    if !removed.is_empty() {
        storage::remove_files(&state.paths.assets_dir, &removed);
    }
    Ok(detail)
}

#[tauri::command]
pub async fn set_playbook_status(
    state: State<'_, AppState>,
    id: String,
    status: PlaybookStatus,
    note: Option<String>,
) -> AppResult<PlaybookDetail> {
    state.with_db(|connection| {
        set_status(connection, &id, status, note.as_deref().unwrap_or_default())
    })
}

#[tauri::command]
pub async fn delete_playbook(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<PlaybookDeletion> {
    let (mut deletion, folder) = state.with_db(|connection| delete_records(connection, &id))?;
    deletion.files = remove_playbook_files(&state.paths.assets_dir, &folder);
    Ok(deletion)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::features::attachments::{AttachmentSource, ImportRequest};
    use crate::features::events::{EventInput, EventReviewStatus, EventType};
    use crate::features::playbook_content::{ListItem, Origin, PlaybookStep};
    use crate::features::review;
    use crate::features::sessions::SessionInput;

    struct Fixture {
        _temp: tempfile::TempDir,
        attachments: PathBuf,
        assets: PathBuf,
        connection: Connection,
    }

    fn fixture() -> Fixture {
        let temp = tempfile::tempdir().unwrap();
        let attachments = temp.path().join("attachments");
        let assets = temp.path().join("playbook-assets");
        Fixture {
            attachments,
            assets,
            connection: db::open_in_memory(),
            _temp: temp,
        }
    }

    fn input(title: &str) -> PlaybookInput {
        PlaybookInput {
            title: title.into(),
            ..PlaybookInput::default()
        }
    }

    /// A session with a screenshot step (approved), a command (approved), a rejected step and a
    /// pending step.
    fn reviewed_session(fx: &mut Fixture) -> (String, Vec<String>) {
        let session = sessions::create(
            &fx.connection,
            &SessionInput {
                title: "Rotate VPN certificate".into(),
                project_id: None,
                application: "FortiGate 7.4".into(),
                environment: "Lab".into(),
            },
            "",
        )
        .unwrap()
        .summary
        .id;
        let request = ImportRequest {
            session_id: session.clone(),
            event_id: None,
            title: "Certificate list".into(),
            original_name: "certs.png".into(),
            source: AttachmentSource::Clipboard,
            metadata: "{}".into(),
        };
        let screenshot = crate::capture::screen::encode_png(&image::RgbImage::from_pixel(
            64,
            32,
            image::Rgb([250, 250, 250]),
        ))
        .unwrap();
        let shot = attachments::import(&mut fx.connection, &fx.attachments, &request, &screenshot)
            .unwrap();
        let mut ids = vec![shot.event.id.clone()];
        for (event_type, title, code) in [
            (
                EventType::Command,
                "Check expiry",
                "get vpn certificate local",
            ),
            (EventType::Step, "Wrong turn", ""),
            (EventType::Step, "Not reviewed yet", ""),
        ] {
            let event = events::create(
                &mut fx.connection,
                &session,
                event_type,
                &EventInput {
                    title: title.into(),
                    description: format!("{title} details"),
                    notes: String::new(),
                    code: code.into(),
                },
            )
            .unwrap();
            ids.push(event.id);
        }
        review::set_status(
            &mut fx.connection,
            &session,
            &ids[0..2],
            EventReviewStatus::Approved,
            "",
            "",
        )
        .unwrap();
        review::set_status(
            &mut fx.connection,
            &session,
            &ids[2..3],
            EventReviewStatus::Rejected,
            "",
            "",
        )
        .unwrap();
        (session, ids)
    }

    #[test]
    fn creates_blank_drafts_with_validated_metadata() {
        let mut fx = fixture();
        let created = create_blank(&mut fx.connection, &input("  Reset MFA  ")).unwrap();
        assert_eq!(created.summary.title, "Reset MFA");
        assert_eq!(created.summary.status, PlaybookStatus::Draft);
        assert_eq!(created.content, PlaybookContent::default());
        assert_eq!(created.summary.step_count, 0);
        assert_eq!(
            create_blank(&mut fx.connection, &input(" "))
                .unwrap_err()
                .field(),
            Some("title")
        );
        let mut missing_project = input("X");
        missing_project.project_id = Some(clock::new_id());
        assert_eq!(
            create_blank(&mut fx.connection, &missing_project)
                .unwrap_err()
                .field(),
            Some("projectId")
        );
    }

    #[test]
    fn generates_from_approved_steps_with_copied_evidence() {
        let mut fx = fixture();
        let (session, ids) = reviewed_session(&mut fx);
        let playbook = generate(&mut fx.connection, &fx.attachments, &fx.assets, &session).unwrap();
        assert_eq!(playbook.summary.title, "Rotate VPN certificate");
        assert_eq!(playbook.summary.platform, "FortiGate 7.4");
        assert_eq!(playbook.summary.environment, "Lab");
        assert_eq!(playbook.summary.session_count, 1);
        assert_eq!(playbook.sessions[0].id, session);

        let steps = &playbook.content.steps;
        assert_eq!(steps.len(), 2, "only approved steps");
        assert_eq!(steps[0].source_event_id.as_deref(), Some(ids[0].as_str()));
        assert_eq!(steps[0].origin, Origin::Session);
        assert_eq!(steps[1].command, "get vpn certificate local");
        assert!(
            playbook.content.verification.is_empty(),
            "no invented verification"
        );

        assert_eq!(playbook.assets.len(), 1);
        let asset = &playbook.assets[0];
        assert_eq!(steps[0].asset_ids, std::slice::from_ref(&asset.id));
        let stored = locate_asset(&fx.connection, &asset.id).unwrap();
        let bytes =
            std::fs::read(storage::resolve_contained(&fx.assets, &stored.relative_path).unwrap())
                .unwrap();
        assert_eq!(storage::sha256_hex(&bytes), asset.sha256);
        assert!(stored.relative_path.starts_with(&playbook.summary.id));

        // Deleting the session keeps the playbook and its evidence copy.
        sessions::delete(&mut fx.connection, &fx.attachments, &session).unwrap();
        let after = get(&fx.connection, &playbook.summary.id).unwrap();
        assert!(after.sessions.is_empty());
        assert_eq!(after.assets.len(), 1);
        assert!(after.assets[0].source_attachment_id.is_none());
    }

    #[test]
    fn generation_requires_an_approved_step() {
        let mut fx = fixture();
        let session = sessions::create(
            &fx.connection,
            &SessionInput {
                title: "Empty".into(),
                project_id: None,
                application: String::new(),
                environment: String::new(),
            },
            "",
        )
        .unwrap()
        .summary
        .id;
        let error =
            generate(&mut fx.connection, &fx.attachments, &fx.assets, &session).unwrap_err();
        assert!(error.to_string().contains("Approve at least one step"));
        assert!(list(&fx.connection, None, None).unwrap().is_empty());
    }

    fn authored_step(id: &str, title: &str) -> PlaybookStep {
        PlaybookStep {
            id: id.into(),
            title: title.into(),
            instruction: String::new(),
            command: String::new(),
            expected_result: String::new(),
            note: String::new(),
            asset_ids: Vec::new(),
            origin: Origin::Authored,
            source_session_id: None,
            source_event_id: None,
            source_kind: None,
        }
    }

    #[test]
    fn saves_drafts_and_removes_evidence_no_longer_used() {
        let mut fx = fixture();
        let (session, _) = reviewed_session(&mut fx);
        let playbook = generate(&mut fx.connection, &fx.attachments, &fx.assets, &session).unwrap();
        let id = playbook.summary.id.clone();
        let asset_path = locate_asset(&fx.connection, &playbook.assets[0].id)
            .unwrap()
            .relative_path;

        let mut content = playbook.content.clone();
        content.purpose = "Renew before expiry".into();
        content.steps[0].asset_ids.clear();
        content.steps[0].origin = Origin::Edited;
        content.verification.push(ListItem {
            id: clock::new_id(),
            text: "VPN clients reconnect".into(),
            origin: Origin::Authored,
        });
        let mut metadata = input("Rotate the VPN certificate");
        metadata.product_version = "7.4.3".into();
        let (saved, removed) = save(&mut fx.connection, &id, &metadata, &content).unwrap();
        assert_eq!(saved.summary.title, "Rotate the VPN certificate");
        assert_eq!(saved.summary.product_version, "7.4.3");
        assert_eq!(saved.content.purpose, "Renew before expiry");
        assert_eq!(saved.content.steps[0].origin, Origin::Edited);
        assert!(saved.assets.is_empty());
        assert_eq!(removed, [asset_path]);

        let mut invalid = saved.content.clone();
        invalid.steps.push(authored_step("bad id!", "x"));
        assert!(save(&mut fx.connection, &id, &metadata, &invalid).is_err());
    }

    #[test]
    fn publishing_records_immutable_revisions_and_locks_editing() {
        let mut fx = fixture();
        let created = create_blank(&mut fx.connection, &input("Patch web servers")).unwrap();
        let id = created.summary.id.clone();
        let blocked =
            set_status(&mut fx.connection, &id, PlaybookStatus::Published, "").unwrap_err();
        assert!(blocked.to_string().contains("Add at least one step"));

        let content = PlaybookContent {
            steps: vec![authored_step("s1", "Drain the node")],
            ..PlaybookContent::default()
        };
        save(
            &mut fx.connection,
            &id,
            &input("Patch web servers"),
            &content,
        )
        .unwrap();
        let review = set_status(&mut fx.connection, &id, PlaybookStatus::InReview, "").unwrap();
        assert_eq!(review.summary.status, PlaybookStatus::InReview);
        assert_eq!(
            save(&mut fx.connection, &id, &input("Edited"), &content)
                .unwrap_err()
                .kind(),
            "conflict"
        );

        let published = set_status(
            &mut fx.connection,
            &id,
            PlaybookStatus::Published,
            "First release",
        )
        .unwrap();
        assert_eq!(published.summary.status, PlaybookStatus::Published);
        assert!(published.summary.published_at.is_some());
        assert_eq!(published.revisions.len(), 1);
        assert_eq!(published.revisions[0].revision_number, 1);
        assert_eq!(published.revisions[0].note, "First release");

        // A new version starts as a draft; the published revision stays unchanged.
        set_status(&mut fx.connection, &id, PlaybookStatus::Draft, "").unwrap();
        let mut next = content.clone();
        next.steps.push(authored_step("s2", "Patch"));
        save(&mut fx.connection, &id, &input("Patch web servers"), &next).unwrap();
        let second = set_status(&mut fx.connection, &id, PlaybookStatus::Published, "").unwrap();
        assert_eq!(second.revisions.len(), 2);
        assert_eq!(second.summary.revision_count, 2);
        let first_snapshot: String = fx
            .connection
            .query_row(
                "SELECT snapshot_json FROM playbook_revisions WHERE playbook_id = ?1 AND revision_number = 1",
                [&id],
                |row| row.get(0),
            )
            .unwrap();
        let snapshot: serde_json::Value = serde_json::from_str(&first_snapshot).unwrap();
        assert_eq!(snapshot["content"]["steps"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn evidence_used_by_a_revision_is_kept() {
        let mut fx = fixture();
        let (session, _) = reviewed_session(&mut fx);
        let playbook = generate(&mut fx.connection, &fx.attachments, &fx.assets, &session).unwrap();
        let id = playbook.summary.id.clone();
        set_status(&mut fx.connection, &id, PlaybookStatus::Published, "").unwrap();
        set_status(&mut fx.connection, &id, PlaybookStatus::Draft, "").unwrap();
        let mut content = playbook.content.clone();
        content.steps[0].asset_ids.clear();
        let (saved, removed) = save(
            &mut fx.connection,
            &id,
            &input("Rotate VPN certificate"),
            &content,
        )
        .unwrap();
        assert!(removed.is_empty());
        assert_eq!(saved.assets.len(), 1);
    }

    #[test]
    fn deleting_a_playbook_removes_its_evidence_folder() {
        let mut fx = fixture();
        let (session, _) = reviewed_session(&mut fx);
        let playbook = generate(&mut fx.connection, &fx.attachments, &fx.assets, &session).unwrap();
        let id = playbook.summary.id.clone();
        let (deletion, folder) = delete_records(&mut fx.connection, &id).unwrap();
        assert_eq!(deletion.title, "Rotate VPN certificate");
        let cleanup = remove_playbook_files(&fx.assets, &folder);
        assert_eq!(cleanup.removed, 1);
        assert!(!fx.assets.join(&id).exists());
        assert_eq!(get(&fx.connection, &id).unwrap_err().kind(), "not_found");
        assert_eq!(
            locate_asset(&fx.connection, &playbook.assets[0].id)
                .unwrap_err()
                .kind(),
            "not_found"
        );
    }

    #[test]
    fn copies_of_redacted_screenshots_are_marked_redacted() {
        let mut fx = fixture();
        let (session, ids) = reviewed_session(&mut fx);
        let attachment_id = events::get(&fx.connection, &ids[0]).unwrap().attachments[0]
            .id
            .clone();
        let regions = [review::Region {
            x: 0,
            y: 0,
            width: 8,
            height: 8,
        }];
        review::redact(
            &mut fx.connection,
            &fx.attachments,
            &fx.assets,
            &attachment_id,
            &regions,
            "",
        )
        .unwrap();
        let playbook = generate(&mut fx.connection, &fx.attachments, &fx.assets, &session).unwrap();
        assert!(playbook.assets[0].redacted_at.is_some());
    }

    #[test]
    fn redacting_a_screenshot_also_redacts_its_playbook_copies() {
        let mut fx = fixture();
        let (session, ids) = reviewed_session(&mut fx);
        let playbook = generate(&mut fx.connection, &fx.attachments, &fx.assets, &session).unwrap();
        let before = playbook.assets[0].clone();
        let attachment_id = events::get(&fx.connection, &ids[0]).unwrap().attachments[0]
            .id
            .clone();
        let regions = [review::Region {
            x: 0,
            y: 0,
            width: 10,
            height: 10,
        }];
        let result = review::redact(
            &mut fx.connection,
            &fx.attachments,
            &fx.assets,
            &attachment_id,
            &regions,
            "",
        )
        .unwrap();
        assert_eq!((result.playbook_copies, result.copy_failures), (1, 0));
        let after = get(&fx.connection, &playbook.summary.id)
            .unwrap()
            .assets
            .remove(0);
        assert_eq!(after.id, before.id, "the copy keeps its identity");
        assert_ne!(after.sha256, before.sha256);
        assert!(after.redacted_at.is_some());
        let stored = locate_asset(&fx.connection, &after.id).unwrap();
        let bytes =
            std::fs::read(storage::resolve_contained(&fx.assets, &stored.relative_path).unwrap())
                .unwrap();
        let image = review::decode_image(&bytes).unwrap();
        assert_eq!(image.get_pixel(5, 5).0, [0, 0, 0, 255]);
        // Only the redacted copy remains in the playbook folder.
        let files = std::fs::read_dir(fx.assets.join(&playbook.summary.id))
            .unwrap()
            .count();
        assert_eq!(files, 1);
    }
}
