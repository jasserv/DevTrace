//! Event review (Milestone 4): a decision on every step (approve, reject, exclude, or back to
//! pending), reordering, permanent redaction of screenshot regions, and the session review
//! state. Every decision is appended to `review_decisions`, the audit trail.
//!
//! Decisions do not change evidence, so they stay possible after a session is completed.
//! Reordering and redaction change the session's content and require an open (draft) session.

use std::io::Cursor;
use std::path::Path;

use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{ExtendedColorType, ImageEncoder, ImageReader, Limits, Rgba, RgbaImage};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::State;

use crate::clock;
use crate::error::{AppError, AppResult};
use crate::features::attachments::{self, Attachment};
use crate::features::events::{self, Event, EventReviewStatus};
use crate::features::playbooks;
use crate::features::sessions::{self, ReviewState, SessionDetail};
use crate::features::settings;
use crate::state::AppState;
use crate::storage::{self, FileCleanup};
use crate::validate::{self, TextRule};

text_enum! {
    /// What a review decision did. Stored in `review_decisions.decision`.
    pub enum DecisionKind {
        Approve => "approve",
        Reject => "reject",
        Exclude => "exclude",
        /// Back to pending.
        Reset => "reset",
        Reorder => "reorder",
        Redact => "redact",
        MarkReviewed => "mark_reviewed",
        ReopenReview => "reopen_review",
    }
}

impl DecisionKind {
    fn for_status(status: EventReviewStatus) -> Self {
        match status {
            EventReviewStatus::Pending => Self::Reset,
            EventReviewStatus::Approved => Self::Approve,
            EventReviewStatus::Rejected => Self::Reject,
            EventReviewStatus::Excluded => Self::Exclude,
        }
    }
}

/// One entry of the audit trail.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewDecision {
    pub id: String,
    pub session_id: String,
    pub event_id: Option<String>,
    /// Title of the step at the time of reading; `None` when the step was deleted.
    pub event_title: Option<String>,
    pub decision: DecisionKind,
    pub comment: String,
    pub reviewer: String,
    pub details: Value,
    pub created_at: String,
}

/// How far the review of a session has progressed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSummary {
    pub session_id: String,
    pub review_state: ReviewState,
    pub total: i64,
    pub pending: i64,
    pub approved: i64,
    pub rejected: i64,
    pub excluded: i64,
}

/// A rectangle to black out, in image pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Region {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Redaction {
    pub attachment: Attachment,
    /// Removal of the original, unredacted file. `failed > 0` means it is still on disk.
    pub original_file: FileCleanup,
    /// Playbook copies of this screenshot that were redacted the same way.
    pub playbook_copies: u32,
    /// Playbook copies that could not be redacted (they still show the original content).
    pub copy_failures: u32,
}

pub const COMMENT_RULE: TextRule = TextRule {
    field: "comment",
    label: "Comment",
    max_chars: 2000,
    required: false,
    multiline: true,
};

pub const MAX_REDACTION_REGIONS: usize = 50;
/// Decoding is refused above this many bytes of pixels (protects against decompression bombs).
const MAX_DECODE_BYTES: u64 = 512 * 1024 * 1024;

/// A decision about to be appended to the audit trail.
struct NewDecision<'a> {
    session_id: &'a str,
    event_id: Option<&'a str>,
    decision: DecisionKind,
    comment: &'a str,
    reviewer: &'a str,
    details: Value,
}

fn record(tx: &Transaction<'_>, decision: NewDecision<'_>, now: &str) -> AppResult<()> {
    tx.execute(
        "INSERT INTO review_decisions (id, session_id, event_id, decision, comment, reviewer, details_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            clock::new_id(),
            decision.session_id,
            decision.event_id,
            decision.decision,
            decision.comment,
            decision.reviewer,
            decision.details.to_string(),
            now
        ],
    )?;
    Ok(())
}

fn review_state(connection: &Connection, session_id: &str) -> AppResult<ReviewState> {
    connection
        .query_row(
            "SELECT review_state FROM sessions WHERE id = ?1",
            [session_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| AppError::not_found("Session", session_id))
}

/// Starts the review on the first decision and reopens a finished review when a step becomes
/// pending again.
fn refresh_review_state(tx: &Transaction<'_>, session_id: &str, now: &str) -> AppResult<()> {
    let current = review_state(tx, session_id)?;
    let pending: i64 = tx.query_row(
        "SELECT COUNT(*) FROM events WHERE session_id = ?1 AND review_status = 'pending'",
        [session_id],
        |row| row.get(0),
    )?;
    let next = match current {
        ReviewState::Unreviewed => ReviewState::InReview,
        ReviewState::Reviewed if pending > 0 => ReviewState::InReview,
        other => other,
    };
    if next != current {
        tx.execute(
            "UPDATE sessions SET review_state = ?2, updated_at = ?3 WHERE id = ?1",
            params![session_id, next, now],
        )?;
    }
    Ok(())
}

fn valid_comment(comment: &str) -> AppResult<String> {
    validate::preformatted(&COMMENT_RULE, comment)
}

/// Sets the review status of one or more steps of a session in one transaction.
pub fn set_status(
    connection: &mut Connection,
    session_id: &str,
    event_ids: &[String],
    status: EventReviewStatus,
    comment: &str,
    reviewer: &str,
) -> AppResult<Vec<Event>> {
    let session_id = validate::id("sessionId", session_id)?;
    if event_ids.is_empty() {
        return Err(AppError::validation(
            "eventIds",
            "Select at least one step.",
        ));
    }
    let comment = valid_comment(comment)?;
    let ids = event_ids
        .iter()
        .map(|id| validate::id("eventIds", id))
        .collect::<AppResult<Vec<_>>>()?;
    let tx = connection.transaction()?;
    sessions::ensure_exists(&tx, &session_id)?;
    let now = clock::now();
    for id in &ids {
        let current: Option<(String, EventReviewStatus)> = tx
            .query_row(
                "SELECT session_id, review_status FROM events WHERE id = ?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((owner, previous)) = current else {
            return Err(AppError::not_found("Event", id));
        };
        if owner != session_id {
            return Err(AppError::validation(
                "eventIds",
                "A step belongs to a different session.",
            ));
        }
        if previous == status && comment.is_empty() {
            continue;
        }
        tx.execute(
            "UPDATE events SET review_status = ?2 WHERE id = ?1",
            params![id, status],
        )?;
        record(
            &tx,
            NewDecision {
                session_id: &session_id,
                event_id: Some(id),
                decision: DecisionKind::for_status(status),
                comment: &comment,
                reviewer,
                details: json!({ "from": previous, "to": status }),
            },
            &now,
        )?;
    }
    refresh_review_state(&tx, &session_id, &now)?;
    sessions::touch(&tx, &session_id, &now)?;
    tx.commit()?;
    ids.iter().map(|id| events::get(connection, id)).collect()
}

/// Puts a session's steps in the given order. `ordered_ids` must list every step exactly once.
pub fn reorder(
    connection: &mut Connection,
    session_id: &str,
    ordered_ids: &[String],
    reviewer: &str,
) -> AppResult<Vec<Event>> {
    let session_id = validate::id("sessionId", session_id)?;
    let tx = connection.transaction()?;
    sessions::ensure_editable(&tx, &session_id)?;
    let mut current: Vec<String> = {
        let mut statement = tx.prepare(
            "SELECT id FROM events WHERE session_id = ?1 ORDER BY position, created_at, id",
        )?;
        statement
            .query_map([&session_id], |row| row.get(0))?
            .collect::<Result<_, _>>()?
    };
    let mut requested: Vec<String> = ordered_ids.to_vec();
    let unchanged = requested == current;
    requested.sort();
    current.sort();
    if requested != current {
        return Err(AppError::conflict(
            "eventIds",
            "The steps of this session changed. Refresh and try again.",
        ));
    }
    if unchanged {
        tx.commit()?;
        return events::list(connection, &session_id);
    }
    let now = clock::now();
    for (position, id) in ordered_ids.iter().enumerate() {
        tx.execute(
            "UPDATE events SET position = ?2 WHERE id = ?1",
            params![id, position as i64],
        )?;
    }
    record(
        &tx,
        NewDecision {
            session_id: &session_id,
            event_id: None,
            decision: DecisionKind::Reorder,
            comment: "",
            reviewer,
            details: json!({ "order": ordered_ids }),
        },
        &now,
    )?;
    refresh_review_state(&tx, &session_id, &now)?;
    sessions::touch(&tx, &session_id, &now)?;
    tx.commit()?;
    events::list(connection, &session_id)
}

pub fn summary(connection: &Connection, session_id: &str) -> AppResult<ReviewSummary> {
    let session_id = validate::id("sessionId", session_id)?;
    let review_state = review_state(connection, &session_id)?;
    let count = |status: &str| -> AppResult<i64> {
        Ok(connection.query_row(
            "SELECT COUNT(*) FROM events WHERE session_id = ?1 AND (?2 = '' OR review_status = ?2)",
            params![session_id, status],
            |row| row.get(0),
        )?)
    };
    Ok(ReviewSummary {
        total: count("")?,
        pending: count("pending")?,
        approved: count("approved")?,
        rejected: count("rejected")?,
        excluded: count("excluded")?,
        session_id,
        review_state,
    })
}

/// Marks the review finished. Every step needs a decision first.
pub fn mark_reviewed(
    connection: &mut Connection,
    session_id: &str,
    comment: &str,
    reviewer: &str,
) -> AppResult<SessionDetail> {
    let session_id = validate::id("sessionId", session_id)?;
    let comment = valid_comment(comment)?;
    let progress = summary(connection, &session_id)?;
    if progress.total == 0 {
        return Err(AppError::conflict(
            "reviewState",
            "Add steps before reviewing this session.",
        ));
    }
    if progress.pending > 0 {
        return Err(AppError::conflict(
            "reviewState",
            format!(
                "{} {} still need a decision.",
                progress.pending,
                if progress.pending == 1 {
                    "step"
                } else {
                    "steps"
                }
            ),
        ));
    }
    let tx = connection.transaction()?;
    let now = clock::now();
    tx.execute(
        "UPDATE sessions SET review_state = 'reviewed', updated_at = ?2 WHERE id = ?1",
        params![session_id, now],
    )?;
    record(
        &tx,
        NewDecision {
            session_id: &session_id,
            event_id: None,
            decision: DecisionKind::MarkReviewed,
            comment: &comment,
            reviewer,
            details: json!({ "approved": progress.approved, "rejected": progress.rejected, "excluded": progress.excluded }),
        },
        &now,
    )?;
    tx.commit()?;
    sessions::get(connection, &session_id)
}

pub fn reopen_review(
    connection: &mut Connection,
    session_id: &str,
    reviewer: &str,
) -> AppResult<SessionDetail> {
    let session_id = validate::id("sessionId", session_id)?;
    if review_state(connection, &session_id)? != ReviewState::Reviewed {
        return Err(AppError::conflict(
            "reviewState",
            "Only a finished review can be reopened.",
        ));
    }
    let tx = connection.transaction()?;
    let now = clock::now();
    tx.execute(
        "UPDATE sessions SET review_state = 'in_review', updated_at = ?2 WHERE id = ?1",
        params![session_id, now],
    )?;
    record(
        &tx,
        NewDecision {
            session_id: &session_id,
            event_id: None,
            decision: DecisionKind::ReopenReview,
            comment: "",
            reviewer,
            details: json!({}),
        },
        &now,
    )?;
    tx.commit()?;
    sessions::get(connection, &session_id)
}

pub fn list_decisions(connection: &Connection, session_id: &str) -> AppResult<Vec<ReviewDecision>> {
    let session_id = validate::id("sessionId", session_id)?;
    sessions::ensure_exists(connection, &session_id)?;
    let mut statement = connection.prepare(
        "SELECT d.id, d.session_id, d.event_id, e.title, d.decision, d.comment, d.reviewer, d.details_json, d.created_at
         FROM review_decisions d LEFT JOIN events e ON e.id = d.event_id
         WHERE d.session_id = ?1
         ORDER BY d.created_at DESC, d.rowid DESC",
    )?;
    let decisions = statement
        .query_map([&session_id], |row| {
            let details: String = row.get(7)?;
            Ok(ReviewDecision {
                id: row.get(0)?,
                session_id: row.get(1)?,
                event_id: row.get(2)?,
                event_title: row.get(3)?,
                decision: row.get(4)?,
                comment: row.get(5)?,
                reviewer: row.get(6)?,
                details: serde_json::from_str(&details).unwrap_or_else(|_| json!({})),
                created_at: row.get(8)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(decisions)
}

// ---------------------------------------------------------------------------------------------
// Redaction

/// The attachment facts needed to redact it.
struct RedactionTarget {
    session_id: String,
    event_id: Option<String>,
    relative_path: String,
    width: u32,
    height: u32,
}

fn redaction_target(connection: &Connection, id: &str) -> AppResult<RedactionTarget> {
    let target = connection
        .query_row(
            "SELECT session_id, event_id, relative_path, width, height FROM attachments WHERE id = ?1",
            [id],
            |row| {
                Ok(RedactionTarget {
                    session_id: row.get(0)?,
                    event_id: row.get(1)?,
                    relative_path: row.get(2)?,
                    width: row.get::<_, Option<i64>>(3)?.unwrap_or(0).max(0) as u32,
                    height: row.get::<_, Option<i64>>(4)?.unwrap_or(0).max(0) as u32,
                })
            },
        )
        .optional()?
        .ok_or_else(|| AppError::not_found("Attachment", id))?;
    sessions::ensure_editable(connection, &target.session_id)?;
    Ok(target)
}

fn validate_regions(regions: &[Region], width: u32, height: u32) -> AppResult<()> {
    if regions.is_empty() {
        return Err(AppError::validation(
            "regions",
            "Mark at least one area to redact.",
        ));
    }
    if regions.len() > MAX_REDACTION_REGIONS {
        return Err(AppError::validation(
            "regions",
            format!("At most {MAX_REDACTION_REGIONS} areas can be redacted at once."),
        ));
    }
    for region in regions {
        let right = u64::from(region.x) + u64::from(region.width);
        let bottom = u64::from(region.y) + u64::from(region.height);
        if region.width == 0
            || region.height == 0
            || right > u64::from(width)
            || bottom > u64::from(height)
        {
            return Err(AppError::validation(
                "regions",
                "An area to redact lies outside the image.",
            ));
        }
    }
    Ok(())
}

/// Decodes an image (first frame of animations) with allocation limits.
pub fn decode_image(bytes: &[u8]) -> AppResult<RgbaImage> {
    let unreadable = || AppError::validation("file", "The image could not be read for redaction.");
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| unreadable())?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(storage::MAX_IMAGE_SIDE as u32);
    limits.max_image_height = Some(storage::MAX_IMAGE_SIDE as u32);
    limits.max_alloc = Some(MAX_DECODE_BYTES);
    reader.limits(limits);
    Ok(reader.decode().map_err(|_| unreadable())?.into_rgba8())
}

/// Fills every region with opaque black. The pixels underneath are gone from the result.
pub fn burn_in(image: &mut RgbaImage, regions: &[Region]) {
    let (width, height) = image.dimensions();
    for region in regions {
        let right = region.x.saturating_add(region.width).min(width);
        let bottom = region.y.saturating_add(region.height).min(height);
        for y in region.y.min(height)..bottom {
            for x in region.x.min(width)..right {
                image.put_pixel(x, y, Rgba([0, 0, 0, 255]));
            }
        }
    }
}

fn encode_png(image: &RgbaImage) -> AppResult<Vec<u8>> {
    let mut bytes = Vec::new();
    PngEncoder::new_with_quality(&mut bytes, CompressionType::Fast, FilterType::Adaptive)
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            ExtendedColorType::Rgba8,
        )
        .map_err(|error| {
            AppError::internal(format!("Could not encode the redacted image: {error}"))
        })?;
    Ok(bytes)
}

/// The redacted copy: a new PNG next to the original, never overwriting it.
struct RedactedFile {
    relative_path: String,
    inspected: storage::InspectedImage,
    path: std::path::PathBuf,
}

fn write_redacted(
    attachments_dir: &Path,
    attachment_id: &str,
    target: &RedactionTarget,
    regions: &[Region],
) -> AppResult<RedactedFile> {
    let original = storage::resolve_contained(attachments_dir, &target.relative_path)?;
    let bytes = std::fs::read(&original).map_err(|error| {
        AppError::conflict(
            "file",
            format!("The screenshot file could not be read ({error})."),
        )
    })?;
    let mut image = decode_image(&bytes)?;
    if image.dimensions() != (target.width, target.height) {
        return Err(AppError::conflict(
            "file",
            "The screenshot file does not match its recorded size, so it was not changed.",
        ));
    }
    burn_in(&mut image, regions);
    let encoded = encode_png(&image)?;
    let inspected = storage::inspect_image(&encoded)?;
    let relative_path = format!(
        "{}/{}-redacted-{}.png",
        target.session_id,
        attachment_id,
        clock::new_id()
    );
    let path = storage::resolve_contained(attachments_dir, &relative_path)?;
    storage::write_atomic(&path, &encoded)?;
    Ok(RedactedFile {
        relative_path,
        inspected,
        path,
    })
}

fn record_redaction(
    connection: &mut Connection,
    attachment_id: &str,
    target: &RedactionTarget,
    file: &RedactedFile,
    regions: &[Region],
    comment: &str,
    reviewer: &str,
) -> AppResult<()> {
    let tx = connection.transaction()?;
    // The attachment must be unchanged since the file was read.
    let still: Option<String> = tx
        .query_row(
            "SELECT relative_path FROM attachments WHERE id = ?1",
            [attachment_id],
            |row| row.get(0),
        )
        .optional()?;
    if still.as_deref() != Some(target.relative_path.as_str()) {
        return Err(AppError::conflict(
            "file",
            "The screenshot changed while it was being redacted. Try again.",
        ));
    }
    sessions::ensure_editable(&tx, &target.session_id)?;
    let previous_sha: String = tx.query_row(
        "SELECT sha256 FROM attachments WHERE id = ?1",
        [attachment_id],
        |row| row.get(0),
    )?;
    let now = clock::now();
    tx.execute(
        "UPDATE attachments SET relative_path = ?2, media_type = ?3, byte_size = ?4, sha256 = ?5, redacted_at = ?6
         WHERE id = ?1",
        params![
            attachment_id,
            file.relative_path,
            file.inspected.format.media_type(),
            file.inspected.byte_size as i64,
            file.inspected.sha256,
            now
        ],
    )?;
    if let Some(event_id) = &target.event_id {
        tx.execute(
            "UPDATE events SET updated_at = ?2 WHERE id = ?1",
            params![event_id, now],
        )?;
    }
    record(
        &tx,
        NewDecision {
            session_id: &target.session_id,
            event_id: target.event_id.as_deref(),
            decision: DecisionKind::Redact,
            comment,
            reviewer,
            details: json!({
                "attachmentId": attachment_id,
                "regions": regions,
                "previousSha256": previous_sha,
                "sha256": file.inspected.sha256,
            }),
        },
        &now,
    )?;
    refresh_review_state(&tx, &target.session_id, &now)?;
    sessions::touch(&tx, &target.session_id, &now)?;
    tx.commit()?;
    Ok(())
}

/// Redacts the playbook copies of an attachment's evidence: same regions, new file, original
/// deleted. Returns `(redacted, failed)`; failures are logged and reported to the user.
fn redact_copies(
    assets_dir: &Path,
    copies: Vec<(String, String, u32, u32)>,
    regions: &[Region],
    mut record: impl FnMut(&str, &str, &str, &storage::InspectedImage) -> AppResult<bool>,
) -> (u32, u32) {
    let (mut redacted, mut failed) = (0, 0);
    for (asset_id, relative_path, width, height) in copies {
        let result = (|| -> AppResult<()> {
            let target = RedactionTarget {
                session_id: relative_path
                    .split('/')
                    .next()
                    .unwrap_or_default()
                    .to_string(),
                event_id: None,
                relative_path: relative_path.clone(),
                width,
                height,
            };
            let file = write_redacted(assets_dir, &asset_id, &target, regions)?;
            match record(
                &asset_id,
                &relative_path,
                &file.relative_path,
                &file.inspected,
            ) {
                Ok(true) => {
                    storage::remove_files(assets_dir, std::slice::from_ref(&relative_path));
                    Ok(())
                }
                Ok(false) => {
                    let _ = storage::remove_file_if_exists(&file.path);
                    Err(AppError::conflict(
                        "file",
                        "The playbook image changed while it was redacted.",
                    ))
                }
                Err(error) => {
                    let _ = storage::remove_file_if_exists(&file.path);
                    Err(error)
                }
            }
        })();
        match result {
            Ok(()) => redacted += 1,
            Err(error) => {
                eprintln!("DevTrace: could not redact playbook image {asset_id}: {error}");
                failed += 1;
            }
        }
    }
    (redacted, failed)
}

/// Points an evidence copy at its redacted file, if it still uses the file that was read.
fn record_copy(
    connection: &Connection,
    asset_id: &str,
    old_path: &str,
    new_path: &str,
    inspected: &storage::InspectedImage,
) -> AppResult<bool> {
    let changed = connection.execute(
        "UPDATE playbook_assets SET relative_path = ?3, media_type = ?4, byte_size = ?5, sha256 = ?6, redacted_at = ?7
         WHERE id = ?1 AND relative_path = ?2",
        params![
            asset_id,
            old_path,
            new_path,
            inspected.format.media_type(),
            inspected.byte_size as i64,
            inspected.sha256,
            clock::now()
        ],
    )?;
    Ok(changed == 1)
}

/// Permanently blacks out regions of a screenshot: the redacted image replaces the original,
/// which is deleted, and every playbook copy of it is redacted the same way. Runs the file work
/// without holding the database lock.
pub fn redact_with_state(
    state: &AppState,
    attachment_id: &str,
    regions: &[Region],
    comment: &str,
    reviewer: &str,
) -> AppResult<Redaction> {
    let attachment_id = validate::id("id", attachment_id)?;
    let comment = valid_comment(comment)?;
    let target = state.with_db(|connection| redaction_target(connection, &attachment_id))?;
    validate_regions(regions, target.width, target.height)?;
    let file = write_redacted(
        &state.paths.attachments_dir,
        &attachment_id,
        &target,
        regions,
    )?;
    let recorded = state.with_db(|connection| {
        record_redaction(
            connection,
            &attachment_id,
            &target,
            &file,
            regions,
            &comment,
            reviewer,
        )
    });
    if let Err(error) = recorded {
        let _ = storage::remove_file_if_exists(&file.path);
        return Err(error);
    }
    let original_file = storage::remove_files(
        &state.paths.attachments_dir,
        std::slice::from_ref(&target.relative_path),
    );
    let copies = state
        .with_db(|connection| playbooks::copies_of_attachment(connection, &attachment_id))
        .unwrap_or_default();
    let (playbook_copies, copy_failures) = redact_copies(
        &state.paths.assets_dir,
        copies,
        regions,
        |id, old, new, inspected| {
            state.with_db(|connection| record_copy(connection, id, old, new, inspected))
        },
    );
    let attachment = state.with_db(|connection| attachments::get(connection, &attachment_id))?;
    Ok(Redaction {
        attachment,
        original_file,
        playbook_copies,
        copy_failures,
    })
}

/// Single-connection variant used by tests.
#[cfg(test)]
pub fn redact(
    connection: &mut Connection,
    attachments_dir: &Path,
    assets_dir: &Path,
    attachment_id: &str,
    regions: &[Region],
    reviewer: &str,
) -> AppResult<Redaction> {
    let target = redaction_target(connection, attachment_id)?;
    validate_regions(regions, target.width, target.height)?;
    let file = write_redacted(attachments_dir, attachment_id, &target, regions)?;
    if let Err(error) = record_redaction(
        connection,
        attachment_id,
        &target,
        &file,
        regions,
        "",
        reviewer,
    ) {
        let _ = storage::remove_file_if_exists(&file.path);
        return Err(error);
    }
    let original_file =
        storage::remove_files(attachments_dir, std::slice::from_ref(&target.relative_path));
    let copies = playbooks::copies_of_attachment(connection, attachment_id)?;
    let (playbook_copies, copy_failures) =
        redact_copies(assets_dir, copies, regions, |id, old, new, inspected| {
            record_copy(connection, id, old, new, inspected)
        });
    Ok(Redaction {
        attachment: attachments::get(connection, attachment_id)?,
        original_file,
        playbook_copies,
        copy_failures,
    })
}

fn reviewer(connection: &Connection) -> String {
    settings::load(connection)
        .map(|loaded| loaded.author_name)
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------------------------
// Commands

#[tauri::command]
pub async fn review_events(
    state: State<'_, AppState>,
    session_id: String,
    event_ids: Vec<String>,
    status: EventReviewStatus,
    comment: Option<String>,
) -> AppResult<Vec<Event>> {
    state.with_db(|connection| {
        let reviewer = reviewer(connection);
        set_status(
            connection,
            &session_id,
            &event_ids,
            status,
            comment.as_deref().unwrap_or_default(),
            &reviewer,
        )
    })
}

#[tauri::command]
pub async fn reorder_events(
    state: State<'_, AppState>,
    session_id: String,
    event_ids: Vec<String>,
) -> AppResult<Vec<Event>> {
    state.with_db(|connection| {
        let reviewer = reviewer(connection);
        reorder(connection, &session_id, &event_ids, &reviewer)
    })
}

#[tauri::command]
pub async fn redact_attachment(
    state: State<'_, AppState>,
    id: String,
    regions: Vec<Region>,
    comment: Option<String>,
) -> AppResult<Redaction> {
    let reviewer = state.with_db(|connection| Ok(reviewer(connection)))?;
    let state = state.inner();
    redact_with_state(
        state,
        &id,
        &regions,
        comment.as_deref().unwrap_or_default(),
        &reviewer,
    )
}

#[tauri::command]
pub async fn get_review_summary(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<ReviewSummary> {
    state.with_db(|connection| summary(connection, &session_id))
}

#[tauri::command]
pub async fn list_review_decisions(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<Vec<ReviewDecision>> {
    state.with_db(|connection| list_decisions(connection, &session_id))
}

#[tauri::command]
pub async fn mark_session_reviewed(
    state: State<'_, AppState>,
    id: String,
    comment: Option<String>,
) -> AppResult<SessionDetail> {
    state.with_db(|connection| {
        let reviewer = reviewer(connection);
        mark_reviewed(
            connection,
            &id,
            comment.as_deref().unwrap_or_default(),
            &reviewer,
        )
    })
}

#[tauri::command]
pub async fn reopen_session_review(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<SessionDetail> {
    state.with_db(|connection| {
        let reviewer = reviewer(connection);
        reopen_review(connection, &id, &reviewer)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::features::attachments::{AttachmentSource, ImportRequest};
    use crate::features::events::{EventInput, EventType};
    use crate::features::sessions::{SessionInput, SessionStatus};

    fn session(connection: &Connection) -> String {
        sessions::create(
            connection,
            &SessionInput {
                title: "Review me".into(),
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

    fn step(connection: &mut Connection, session_id: &str, title: &str) -> String {
        events::create(
            connection,
            session_id,
            EventType::Step,
            &EventInput {
                title: title.into(),
                ..EventInput::default()
            },
        )
        .unwrap()
        .id
    }

    fn statuses(connection: &Connection, session_id: &str) -> Vec<EventReviewStatus> {
        events::list(connection, session_id)
            .unwrap()
            .into_iter()
            .map(|event| event.review_status)
            .collect()
    }

    #[test]
    fn decisions_change_status_and_are_audited() {
        let mut connection = db::open_in_memory();
        let id = session(&connection);
        let first = step(&mut connection, &id, "Open console");
        let second = step(&mut connection, &id, "Unrelated browsing");
        assert_eq!(
            summary(&connection, &id).unwrap().review_state,
            ReviewState::Unreviewed
        );

        let approved = set_status(
            &mut connection,
            &id,
            std::slice::from_ref(&first),
            EventReviewStatus::Approved,
            "",
            "Ana",
        )
        .unwrap();
        assert_eq!(approved[0].review_status, EventReviewStatus::Approved);
        set_status(
            &mut connection,
            &id,
            std::slice::from_ref(&second),
            EventReviewStatus::Excluded,
            "  Not part of the task \n",
            "Ana",
        )
        .unwrap();
        assert_eq!(
            statuses(&connection, &id),
            vec![EventReviewStatus::Approved, EventReviewStatus::Excluded]
        );

        let progress = summary(&connection, &id).unwrap();
        assert_eq!(
            (
                progress.total,
                progress.pending,
                progress.approved,
                progress.excluded
            ),
            (2, 0, 1, 1)
        );
        assert_eq!(progress.review_state, ReviewState::InReview);

        let decisions = list_decisions(&connection, &id).unwrap();
        assert_eq!(decisions.len(), 2);
        assert_eq!(decisions[0].decision, DecisionKind::Exclude);
        assert_eq!(decisions[0].comment, "  Not part of the task");
        assert_eq!(decisions[0].reviewer, "Ana");
        assert_eq!(
            decisions[0].event_title.as_deref(),
            Some("Unrelated browsing")
        );
        assert_eq!(decisions[0].details["from"], "pending");
        assert_eq!(decisions[1].decision, DecisionKind::Approve);

        // Re-applying the same status without a comment records nothing.
        set_status(
            &mut connection,
            &id,
            std::slice::from_ref(&first),
            EventReviewStatus::Approved,
            "",
            "Ana",
        )
        .unwrap();
        assert_eq!(list_decisions(&connection, &id).unwrap().len(), 2);
    }

    #[test]
    fn bulk_decisions_are_all_or_nothing() {
        let mut connection = db::open_in_memory();
        let id = session(&connection);
        let other = session(&connection);
        let mine = step(&mut connection, &id, "Mine");
        let foreign = step(&mut connection, &other, "Foreign");
        let error = set_status(
            &mut connection,
            &id,
            &[mine.clone(), foreign],
            EventReviewStatus::Rejected,
            "",
            "",
        )
        .unwrap_err();
        assert_eq!(error.field(), Some("eventIds"));
        assert_eq!(statuses(&connection, &id), vec![EventReviewStatus::Pending]);
        assert!(list_decisions(&connection, &id).unwrap().is_empty());
        assert_eq!(
            set_status(
                &mut connection,
                &id,
                &[],
                EventReviewStatus::Approved,
                "",
                ""
            )
            .unwrap_err()
            .field(),
            Some("eventIds")
        );
        let long = "x".repeat(2001);
        assert_eq!(
            set_status(
                &mut connection,
                &id,
                &[mine],
                EventReviewStatus::Approved,
                &long,
                ""
            )
            .unwrap_err()
            .field(),
            Some("comment")
        );
    }

    #[test]
    fn marking_reviewed_requires_a_decision_on_every_step() {
        let mut connection = db::open_in_memory();
        let id = session(&connection);
        assert!(
            mark_reviewed(&mut connection, &id, "", "").is_err(),
            "no steps"
        );
        let first = step(&mut connection, &id, "One");
        let second = step(&mut connection, &id, "Two");
        set_status(
            &mut connection,
            &id,
            std::slice::from_ref(&first),
            EventReviewStatus::Approved,
            "",
            "",
        )
        .unwrap();
        let blocked = mark_reviewed(&mut connection, &id, "", "").unwrap_err();
        assert!(blocked.to_string().contains("1 step still need"));

        set_status(
            &mut connection,
            &id,
            std::slice::from_ref(&second),
            EventReviewStatus::Rejected,
            "Wrong server",
            "",
        )
        .unwrap();
        let reviewed = mark_reviewed(&mut connection, &id, "Looks good", "Ana").unwrap();
        assert_eq!(reviewed.summary.review_state, ReviewState::Reviewed);

        // A step back to pending reopens the review; so does new evidence.
        set_status(
            &mut connection,
            &id,
            std::slice::from_ref(&second),
            EventReviewStatus::Pending,
            "",
            "",
        )
        .unwrap();
        assert_eq!(
            summary(&connection, &id).unwrap().review_state,
            ReviewState::InReview
        );
        set_status(
            &mut connection,
            &id,
            std::slice::from_ref(&second),
            EventReviewStatus::Approved,
            "",
            "",
        )
        .unwrap();
        mark_reviewed(&mut connection, &id, "", "").unwrap();
        step(&mut connection, &id, "Late addition");
        assert_eq!(
            summary(&connection, &id).unwrap().review_state,
            ReviewState::InReview
        );

        // Explicit reopen only from a finished review.
        assert!(reopen_review(&mut connection, &id, "").is_err());
        let last = events::list(&connection, &id)
            .unwrap()
            .last()
            .unwrap()
            .id
            .clone();
        set_status(
            &mut connection,
            &id,
            &[last],
            EventReviewStatus::Approved,
            "",
            "",
        )
        .unwrap();
        mark_reviewed(&mut connection, &id, "", "").unwrap();
        assert_eq!(
            reopen_review(&mut connection, &id, "")
                .unwrap()
                .summary
                .review_state,
            ReviewState::InReview
        );
        let kinds: Vec<DecisionKind> = list_decisions(&connection, &id)
            .unwrap()
            .iter()
            .map(|decision| decision.decision)
            .collect();
        assert_eq!(kinds[0], DecisionKind::ReopenReview);
        assert!(kinds.contains(&DecisionKind::MarkReviewed));
    }

    #[test]
    fn decisions_are_allowed_after_completion_but_reordering_is_not() {
        let mut connection = db::open_in_memory();
        let id = session(&connection);
        let first = step(&mut connection, &id, "One");
        let second = step(&mut connection, &id, "Two");
        sessions::set_status(&connection, &id, SessionStatus::Completed).unwrap();
        set_status(
            &mut connection,
            &id,
            std::slice::from_ref(&first),
            EventReviewStatus::Approved,
            "",
            "",
        )
        .unwrap();
        let locked = reorder(&mut connection, &id, &[second, first], "").unwrap_err();
        assert_eq!(locked.kind(), "conflict");
    }

    #[test]
    fn reorders_only_with_the_complete_list_of_steps() {
        let mut connection = db::open_in_memory();
        let id = session(&connection);
        let a = step(&mut connection, &id, "A");
        let b = step(&mut connection, &id, "B");
        let c = step(&mut connection, &id, "C");
        let reordered = reorder(
            &mut connection,
            &id,
            &[c.clone(), a.clone(), b.clone()],
            "Ana",
        )
        .unwrap();
        let titles: Vec<&str> = reordered.iter().map(|event| event.title.as_str()).collect();
        assert_eq!(titles, ["C", "A", "B"]);
        assert_eq!(
            list_decisions(&connection, &id).unwrap()[0].decision,
            DecisionKind::Reorder
        );

        assert_eq!(
            reorder(&mut connection, &id, &[a.clone(), b.clone()], "")
                .unwrap_err()
                .kind(),
            "conflict"
        );
        assert_eq!(
            reorder(&mut connection, &id, &[a.clone(), b.clone(), b.clone()], "")
                .unwrap_err()
                .kind(),
            "conflict"
        );
        // The same order is accepted and records nothing.
        reorder(&mut connection, &id, &[c, a, b], "").unwrap();
        assert_eq!(list_decisions(&connection, &id).unwrap().len(), 1);
        // New steps still go to the end.
        step(&mut connection, &id, "D");
        let titles: Vec<String> = events::list(&connection, &id)
            .unwrap()
            .into_iter()
            .map(|event| event.title)
            .collect();
        assert_eq!(titles, ["C", "A", "B", "D"]);
    }

    fn png_with_secret() -> Vec<u8> {
        let mut image = RgbaImage::from_pixel(40, 20, Rgba([255, 255, 255, 255]));
        for x in 10..20 {
            for y in 5..10 {
                image.put_pixel(x, y, Rgba([200, 30, 30, 255]));
            }
        }
        encode_png(&image).unwrap()
    }

    fn import_png(
        connection: &mut Connection,
        dir: &Path,
        session_id: &str,
        bytes: &[u8],
    ) -> Attachment {
        let request = ImportRequest {
            session_id: session_id.into(),
            event_id: None,
            title: "Secret".into(),
            original_name: "secret.png".into(),
            source: AttachmentSource::File,
            metadata: "{}".into(),
        };
        attachments::import(connection, dir, &request, bytes)
            .unwrap()
            .event
            .attachments
            .remove(0)
    }

    #[test]
    fn redaction_burns_regions_into_a_new_file_and_deletes_the_original() {
        let temp = tempfile::tempdir().unwrap();
        let mut connection = db::open_in_memory();
        let id = session(&connection);
        let original = import_png(&mut connection, temp.path(), &id, &png_with_secret());
        let original_path = attachments::locate(&connection, &original.id)
            .unwrap()
            .relative_path;

        let regions = [Region {
            x: 8,
            y: 4,
            width: 14,
            height: 8,
        }];
        let result = redact(
            &mut connection,
            temp.path(),
            &temp.path().join("assets"),
            &original.id,
            &regions,
            "Ana",
        )
        .unwrap();
        assert_eq!(result.original_file.removed, 1);
        let redacted = result.attachment;
        assert!(redacted.redacted_at.is_some());
        assert_ne!(redacted.sha256, original.sha256);
        assert_eq!((redacted.width, redacted.height), (Some(40), Some(20)));
        assert_eq!(redacted.media_type, "image/png");

        let stored = attachments::locate(&connection, &original.id)
            .unwrap()
            .relative_path;
        assert_ne!(stored, original_path);
        assert!(
            !storage::resolve_contained(temp.path(), &original_path)
                .unwrap()
                .exists()
        );
        let bytes =
            std::fs::read(storage::resolve_contained(temp.path(), &stored).unwrap()).unwrap();
        assert_eq!(storage::sha256_hex(&bytes), redacted.sha256);
        let image = decode_image(&bytes).unwrap();
        // No red pixel of the secret survives; pixels outside the region are untouched.
        assert!(image.pixels().all(|pixel| pixel.0 != [200, 30, 30, 255]));
        assert_eq!(image.get_pixel(15, 7).0, [0, 0, 0, 255]);
        assert_eq!(image.get_pixel(30, 15).0, [255, 255, 255, 255]);

        let decision = &list_decisions(&connection, &id).unwrap()[0];
        assert_eq!(decision.decision, DecisionKind::Redact);
        assert_eq!(decision.details["previousSha256"], original.sha256.as_str());
        assert_eq!(decision.details["regions"][0]["width"], 14);
    }

    #[test]
    fn redaction_validates_regions_and_respects_the_completed_lock() {
        let temp = tempfile::tempdir().unwrap();
        let mut connection = db::open_in_memory();
        let id = session(&connection);
        let attachment = import_png(&mut connection, temp.path(), &id, &png_with_secret());
        for regions in [
            vec![],
            vec![Region {
                x: 35,
                y: 0,
                width: 10,
                height: 5,
            }],
            vec![Region {
                x: 0,
                y: 0,
                width: 0,
                height: 5,
            }],
        ] {
            let error = redact(
                &mut connection,
                temp.path(),
                &temp.path().join("assets"),
                &attachment.id,
                &regions,
                "",
            )
            .unwrap_err();
            assert_eq!(error.field(), Some("regions"), "{regions:?}");
        }
        let too_many = vec![
            Region {
                x: 0,
                y: 0,
                width: 1,
                height: 1
            };
            MAX_REDACTION_REGIONS + 1
        ];
        assert!(
            redact(
                &mut connection,
                temp.path(),
                &temp.path().join("assets"),
                &attachment.id,
                &too_many,
                ""
            )
            .is_err()
        );

        sessions::set_status(&connection, &id, SessionStatus::Completed).unwrap();
        let locked = redact(
            &mut connection,
            temp.path(),
            &temp.path().join("assets"),
            &attachment.id,
            &[Region {
                x: 0,
                y: 0,
                width: 2,
                height: 2,
            }],
            "",
        )
        .unwrap_err();
        assert_eq!(locked.kind(), "conflict");
        // Nothing changed on disk or in the row.
        assert_eq!(
            attachments::get(&connection, &attachment.id)
                .unwrap()
                .sha256,
            attachment.sha256
        );
    }

    #[test]
    fn burn_in_clamps_to_the_image() {
        let mut image = RgbaImage::from_pixel(4, 4, Rgba([9, 9, 9, 255]));
        burn_in(
            &mut image,
            &[Region {
                x: 2,
                y: 2,
                width: 10,
                height: 10,
            }],
        );
        assert_eq!(image.get_pixel(3, 3).0, [0, 0, 0, 255]);
        assert_eq!(image.get_pixel(1, 1).0, [9, 9, 9, 255]);
    }

    #[test]
    fn decoding_refuses_non_images() {
        assert!(decode_image(b"not an image").is_err());
    }
}
