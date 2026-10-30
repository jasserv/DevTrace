//! Version history (Milestone 7): read published revisions and restore points, restore one of
//! them into the working copy without losing unpublished work, mark a published procedure out
//! of date, and duplicate a playbook (or one of its revisions) for reuse.
//!
//! Published revisions are never changed. Restoring replaces only the working copy; if that copy
//! held unpublished changes, it is first kept as a restore point.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::clock;
use crate::error::{AppError, AppResult};
use crate::features::attachments;
use crate::features::playbook_content;
use crate::features::playbooks::{
    self, PlaybookDetail, PlaybookStatus, RevisionSummary, VersionSnapshot,
};
use crate::state::AppState;
use crate::storage;
use crate::validate::{self, TextRule};

/// A published revision with its stored metadata and content.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionDetail {
    pub revision: RevisionSummary,
    pub snapshot: VersionSnapshot,
    /// Number of the newest revision of the playbook.
    pub latest_revision_number: i64,
}

/// A working copy kept when a restore replaced it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePointDetail {
    pub restore_point: playbooks::RestorePointSummary,
    pub snapshot: VersionSnapshot,
}

/// What to restore into the working copy.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "id")]
pub enum VersionRef {
    Revision(String),
    RestorePoint(String),
}

const OUTDATED_NOTE_RULE: TextRule = TextRule {
    field: "note",
    label: "Note",
    max_chars: 2_000,
    required: false,
    multiline: true,
};

fn revision_row(
    connection: &Connection,
    playbook_id: &str,
    revision_id: &str,
) -> AppResult<(RevisionSummary, String)> {
    connection
        .query_row(
            "SELECT id, revision_number, title, note, author, created_at, snapshot_json
             FROM playbook_revisions WHERE id = ?1 AND playbook_id = ?2",
            [revision_id, playbook_id],
            |row| {
                Ok((
                    RevisionSummary {
                        id: row.get(0)?,
                        revision_number: row.get(1)?,
                        title: row.get(2)?,
                        note: row.get(3)?,
                        author: row.get(4)?,
                        created_at: row.get(5)?,
                    },
                    row.get(6)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| AppError::not_found("Revision", revision_id))
}

fn latest_revision(connection: &Connection, playbook_id: &str) -> AppResult<Option<(i64, String)>> {
    Ok(connection
        .query_row(
            "SELECT revision_number, snapshot_json FROM playbook_revisions
             WHERE playbook_id = ?1 ORDER BY revision_number DESC LIMIT 1",
            [playbook_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?)
}

/// A published revision of a playbook.
pub fn get_revision(
    connection: &Connection,
    playbook_id: &str,
    revision_id: &str,
) -> AppResult<RevisionDetail> {
    let playbook_id = validate::id("id", playbook_id)?;
    let revision_id = validate::id("revisionId", revision_id)?;
    playbooks::status_of(connection, &playbook_id)?;
    let (revision, raw) = revision_row(connection, &playbook_id, &revision_id)?;
    let latest = latest_revision(connection, &playbook_id)?
        .map_or(revision.revision_number, |(number, _)| number);
    Ok(RevisionDetail {
        snapshot: VersionSnapshot::from_json(&raw)?,
        latest_revision_number: latest,
        revision,
    })
}

/// A restore point of a playbook.
pub fn get_restore_point(
    connection: &Connection,
    playbook_id: &str,
    restore_point_id: &str,
) -> AppResult<RestorePointDetail> {
    let playbook_id = validate::id("id", playbook_id)?;
    let restore_point_id = validate::id("restorePointId", restore_point_id)?;
    let (restore_point, raw) = connection
        .query_row(
            "SELECT id, title, replaced_by, created_at, snapshot_json FROM playbook_restore_points
             WHERE id = ?1 AND playbook_id = ?2",
            [&restore_point_id, &playbook_id],
            |row| {
                Ok((
                    playbooks::RestorePointSummary {
                        id: row.get(0)?,
                        title: row.get(1)?,
                        replaced_by: row.get(2)?,
                        created_at: row.get(3)?,
                    },
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| AppError::not_found("Saved draft", &restore_point_id))?;
    Ok(RestorePointDetail {
        restore_point,
        snapshot: VersionSnapshot::from_json(&raw)?,
    })
}

/// Replaces the working copy with a revision or restore point. The playbook must be a draft or
/// published (a published playbook becomes a draft). Unpublished changes in the working copy are
/// kept as a restore point first; published revisions are never changed.
pub fn restore(
    connection: &mut Connection,
    playbook_id: &str,
    source: &VersionRef,
) -> AppResult<PlaybookDetail> {
    let playbook_id = validate::id("id", playbook_id)?;
    let status = playbooks::status_of(connection, &playbook_id)?;
    if status == PlaybookStatus::InReview {
        return Err(AppError::conflict(
            "status",
            "This playbook is in review. Return it to draft before restoring another version.",
        ));
    }
    let (snapshot, replaced_by, restored_revision) = match source {
        VersionRef::Revision(id) => {
            let revision_id = validate::id("revisionId", id)?;
            let (revision, raw) = revision_row(connection, &playbook_id, &revision_id)?;
            (
                VersionSnapshot::from_json(&raw)?,
                format!("revision:{}", revision.revision_number),
                Some(revision.revision_number),
            )
        }
        VersionRef::RestorePoint(id) => {
            let detail = get_restore_point(connection, &playbook_id, id)?;
            (
                detail.snapshot,
                format!("restore-point:{}", detail.restore_point.id),
                None,
            )
        }
    };

    let current = VersionSnapshot::of(&playbooks::get(connection, &playbook_id)?);
    if current.same_document(&snapshot) {
        return Err(AppError::conflict(
            "version",
            "The working copy already matches this version.",
        ));
    }
    // Unpublished work is kept unless it is identical to the newest published revision.
    let latest = latest_revision(connection, &playbook_id)?
        .map(|(_, raw)| VersionSnapshot::from_json(&raw))
        .transpose()?;
    let keep_current = !latest.is_some_and(|published| published.same_document(&current));

    // Evidence of every version stays in the playbook folder, so references remain valid.
    let asset_ids: HashSet<String> = playbooks::assets(connection, &playbook_id)?
        .into_iter()
        .map(|asset| asset.id)
        .collect();
    let content = playbook_content::validate_content(&snapshot.content, &asset_ids)?;
    let project_id = match snapshot.project_id.as_deref() {
        Some(project) => connection
            .query_row("SELECT id FROM projects WHERE id = ?1", [project], |row| {
                row.get::<_, String>(0)
            })
            .optional()?,
        None => None,
    };

    let tx = connection.transaction()?;
    let now = clock::now();
    if keep_current {
        tx.execute(
            "INSERT INTO playbook_restore_points (id, playbook_id, replaced_by, title, snapshot_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                clock::new_id(),
                playbook_id,
                replaced_by,
                current.title,
                serde_json::to_string(&current)?,
                now
            ],
        )?;
    }
    tx.execute(
        "UPDATE playbooks SET project_id = ?2, title = ?3, summary = ?4, platform = ?5, product = ?6,
                product_version = ?7, environment = ?8, task_type = ?9, author = ?10, content_json = ?11,
                status = 'draft', restored_from_revision = ?12, updated_at = ?13
         WHERE id = ?1",
        params![
            playbook_id,
            project_id,
            snapshot.title,
            snapshot.summary,
            snapshot.platform,
            snapshot.product,
            snapshot.product_version,
            snapshot.environment,
            snapshot.task_type,
            snapshot.author,
            serde_json::to_string(&content)?,
            restored_revision,
            now
        ],
    )?;
    tx.commit()?;
    playbooks::get(connection, &playbook_id)
}

/// Marks a published procedure as out of date (with an optional explanation), or as current
/// again. Publishing a new revision also clears it.
pub fn set_outdated(
    connection: &Connection,
    playbook_id: &str,
    outdated: bool,
    note: &str,
) -> AppResult<PlaybookDetail> {
    let playbook_id = validate::id("id", playbook_id)?;
    playbooks::status_of(connection, &playbook_id)?;
    let note = validate::preformatted(&OUTDATED_NOTE_RULE, note)?;
    if latest_revision(connection, &playbook_id)?.is_none() {
        return Err(AppError::conflict(
            "outdated",
            "Only published procedures can be marked out of date.",
        ));
    }
    if outdated {
        connection.execute(
            "UPDATE playbooks SET outdated_at = ?2, outdated_note = ?3 WHERE id = ?1",
            params![playbook_id, clock::now(), note],
        )?;
    } else {
        connection.execute(
            "UPDATE playbooks SET outdated_at = NULL, outdated_note = '' WHERE id = ?1",
            [&playbook_id],
        )?;
    }
    playbooks::get(connection, &playbook_id)
}

/// What a duplicate copies, read under the database lock.
struct DuplicatePlan {
    source_id: String,
    snapshot: VersionSnapshot,
    revision_number: Option<i64>,
    /// Asset rows referenced by the copied content: `(id, relative path)`.
    assets: Vec<(String, String)>,
    sessions: Vec<String>,
    author: String,
}

fn plan_duplicate(
    connection: &Connection,
    playbook_id: &str,
    revision_id: Option<&str>,
) -> AppResult<DuplicatePlan> {
    let playbook_id = validate::id("id", playbook_id)?;
    let detail = playbooks::get(connection, &playbook_id)?;
    let (snapshot, revision_number) = match revision_id {
        Some(id) => {
            let revision = get_revision(connection, &playbook_id, id)?;
            (revision.snapshot, Some(revision.revision.revision_number))
        }
        None => (VersionSnapshot::of(&detail), None),
    };
    let wanted = snapshot.content.asset_ids();
    let mut assets = Vec::new();
    for asset in &detail.assets {
        if wanted.contains(asset.id.as_str()) {
            let stored = playbooks::locate_asset(connection, &asset.id)?;
            assets.push((asset.id.clone(), stored.relative_path));
        }
    }
    Ok(DuplicatePlan {
        source_id: playbook_id,
        snapshot,
        revision_number,
        assets,
        sessions: detail
            .sessions
            .into_iter()
            .map(|session| session.id)
            .collect(),
        author: playbooks::author_name(connection),
    })
}

struct CopiedFile {
    old_id: String,
    new_id: String,
    relative_path: String,
    path: PathBuf,
}

fn copy_files(
    assets_dir: &Path,
    new_playbook: &str,
    plan: &DuplicatePlan,
) -> AppResult<Vec<CopiedFile>> {
    let mut copies: Vec<CopiedFile> = Vec::new();
    for (old_id, relative) in &plan.assets {
        let copied = (|| -> AppResult<CopiedFile> {
            let source = storage::resolve_contained(assets_dir, relative)?;
            let bytes = std::fs::read(&source)?;
            let extension = relative.rsplit('.').next().unwrap_or("png");
            let new_id = clock::new_id();
            let relative_path = format!("{new_playbook}/{new_id}.{extension}");
            let path = storage::resolve_contained(assets_dir, &relative_path)?;
            storage::write_atomic(&path, &bytes)?;
            Ok(CopiedFile {
                old_id: old_id.clone(),
                new_id,
                relative_path,
                path,
            })
        })();
        match copied {
            Ok(copy) => copies.push(copy),
            Err(error) => {
                discard(&copies);
                return Err(AppError::conflict(
                    "assets",
                    format!("A screenshot of this playbook could not be copied: {error}"),
                ));
            }
        }
    }
    Ok(copies)
}

fn discard(copies: &[CopiedFile]) {
    for copy in copies {
        let _ = storage::remove_file_if_exists(&copy.path);
    }
}

fn record_duplicate(
    connection: &mut Connection,
    new_id: &str,
    plan: &DuplicatePlan,
    copies: &[CopiedFile],
) -> AppResult<()> {
    let mapping: HashMap<&str, &str> = copies
        .iter()
        .map(|copy| (copy.old_id.as_str(), copy.new_id.as_str()))
        .collect();
    let mut content = plan.snapshot.content.clone();
    for step in &mut content.steps {
        step.asset_ids = step
            .asset_ids
            .iter()
            .filter_map(|id| mapping.get(id.as_str()).map(|new| (*new).to_string()))
            .collect();
    }
    let title = attachments::truncate_chars(&format!("Copy of {}", plan.snapshot.title), 200);
    let author = if plan.author.trim().is_empty() {
        plan.snapshot.author.clone()
    } else {
        attachments::truncate_chars(&plan.author, 80)
    };
    let tx = connection.transaction()?;
    let now = clock::now();
    let project_id: Option<String> = match plan.snapshot.project_id.as_deref() {
        Some(project) => tx
            .query_row("SELECT id FROM projects WHERE id = ?1", [project], |row| {
                row.get(0)
            })
            .optional()?,
        None => None,
    };
    // The original must still exist when the copy is recorded.
    playbooks::status_of(&tx, &plan.source_id)?;
    tx.execute(
        "INSERT INTO playbooks (id, project_id, title, summary, status, platform, product, product_version,
                                environment, task_type, author, content_json, based_on_playbook_id,
                                based_on_revision, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'draft', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14)",
        params![
            new_id,
            project_id,
            title,
            plan.snapshot.summary,
            plan.snapshot.platform,
            plan.snapshot.product,
            plan.snapshot.product_version,
            plan.snapshot.environment,
            plan.snapshot.task_type,
            author,
            serde_json::to_string(&content)?,
            plan.source_id,
            plan.revision_number,
            now
        ],
    )?;
    for copy in copies {
        tx.execute(
            "INSERT INTO playbook_assets (id, playbook_id, source_attachment_id, source_event_id, relative_path,
                                          media_type, byte_size, sha256, width, height, annotations_json,
                                          redacted_at, created_at)
             SELECT ?1, ?2, source_attachment_id, source_event_id, ?3, media_type, byte_size, sha256, width,
                    height, annotations_json, redacted_at, ?4
             FROM playbook_assets WHERE id = ?5",
            params![copy.new_id, new_id, copy.relative_path, now, copy.old_id],
        )?;
    }
    for session in &plan.sessions {
        tx.execute(
            "INSERT OR IGNORE INTO playbook_sessions (playbook_id, session_id, linked_at)
             SELECT ?1, id, ?3 FROM sessions WHERE id = ?2",
            params![new_id, session, now],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// Duplicates a playbook (its working copy, or one revision) as a new draft with its own copies
/// of the screenshots (single connection; tests).
#[cfg(test)]
pub fn duplicate(
    connection: &mut Connection,
    assets_dir: &Path,
    playbook_id: &str,
    revision_id: Option<&str>,
) -> AppResult<PlaybookDetail> {
    let plan = plan_duplicate(connection, playbook_id, revision_id)?;
    let new_id = clock::new_id();
    let copies = copy_files(assets_dir, &new_id, &plan)?;
    if let Err(error) = record_duplicate(connection, &new_id, &plan, &copies) {
        discard(&copies);
        return Err(error);
    }
    playbooks::get(connection, &new_id)
}

/// Duplicates a playbook; files are copied without holding the database lock.
pub fn duplicate_with_state(
    state: &AppState,
    playbook_id: &str,
    revision_id: Option<&str>,
) -> AppResult<PlaybookDetail> {
    let plan = state.with_db(|connection| plan_duplicate(connection, playbook_id, revision_id))?;
    let new_id = clock::new_id();
    let copies = copy_files(&state.paths.assets_dir, &new_id, &plan)?;
    if let Err(error) =
        state.with_db(|connection| record_duplicate(connection, &new_id, &plan, &copies))
    {
        discard(&copies);
        if let Ok(folder) = storage::resolve_contained(&state.paths.assets_dir, &new_id) {
            storage::remove_dir_if_empty(&folder);
        }
        return Err(error);
    }
    state.with_db(|connection| playbooks::get(connection, &new_id))
}

// ---------------------------------------------------------------------------------------------
// Commands

#[tauri::command]
pub async fn get_playbook_revision(
    state: State<'_, AppState>,
    id: String,
    revision_id: String,
) -> AppResult<RevisionDetail> {
    state.with_db(|connection| get_revision(connection, &id, &revision_id))
}

#[tauri::command]
pub async fn get_playbook_restore_point(
    state: State<'_, AppState>,
    id: String,
    restore_point_id: String,
) -> AppResult<RestorePointDetail> {
    state.with_db(|connection| get_restore_point(connection, &id, &restore_point_id))
}

#[tauri::command]
pub async fn restore_playbook_version(
    state: State<'_, AppState>,
    id: String,
    source: VersionRef,
) -> AppResult<PlaybookDetail> {
    state.with_db(|connection| restore(connection, &id, &source))
}

#[tauri::command]
pub async fn set_playbook_outdated(
    state: State<'_, AppState>,
    id: String,
    outdated: bool,
    note: Option<String>,
) -> AppResult<PlaybookDetail> {
    state.with_db(|connection| {
        set_outdated(
            connection,
            &id,
            outdated,
            note.as_deref().unwrap_or_default(),
        )
    })
}

#[tauri::command]
pub async fn duplicate_playbook(
    state: State<'_, AppState>,
    id: String,
    revision_id: Option<String>,
) -> AppResult<PlaybookDetail> {
    duplicate_with_state(&state, &id, revision_id.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::features::attachments::{AttachmentSource, ImportRequest};
    use crate::features::events::EventReviewStatus;
    use crate::features::playbook_content::{ListItem, Origin, PlaybookContent};
    use crate::features::playbooks::PlaybookInput;
    use crate::features::review;
    use crate::features::sessions::{self, SessionInput};

    struct Fixture {
        _temp: tempfile::TempDir,
        attachments: PathBuf,
        assets: PathBuf,
        connection: Connection,
    }

    fn fixture() -> Fixture {
        let temp = tempfile::tempdir().unwrap();
        Fixture {
            attachments: temp.path().join("attachments"),
            assets: temp.path().join("playbook-assets"),
            connection: db::open_in_memory(),
            _temp: temp,
        }
    }

    /// A generated playbook with one screenshot step, published as revision 1.
    fn published(fx: &mut Fixture) -> PlaybookDetail {
        let session = sessions::create(
            &fx.connection,
            &SessionInput {
                title: "Patch the web tier".into(),
                project_id: None,
                application: "Ubuntu 24.04".into(),
                environment: "Staging".into(),
            },
            "",
        )
        .unwrap()
        .summary
        .id;
        let png = crate::capture::screen::encode_png(&image::RgbImage::from_pixel(
            32,
            16,
            image::Rgb([200, 200, 200]),
        ))
        .unwrap();
        let shot = attachments::import(
            &mut fx.connection,
            &fx.attachments,
            &ImportRequest {
                session_id: session.clone(),
                event_id: None,
                title: "Package list".into(),
                original_name: "apt.png".into(),
                source: AttachmentSource::Clipboard,
                metadata: "{}".into(),
            },
            &png,
        )
        .unwrap();
        review::set_status(
            &mut fx.connection,
            &session,
            std::slice::from_ref(&shot.event.id),
            EventReviewStatus::Approved,
            "",
            "",
        )
        .unwrap();
        let playbook =
            playbooks::generate(&mut fx.connection, &fx.attachments, &fx.assets, &session).unwrap();
        playbooks::set_status(
            &mut fx.connection,
            &playbook.summary.id,
            PlaybookStatus::Published,
            "First",
        )
        .unwrap()
    }

    fn input(title: &str) -> PlaybookInput {
        PlaybookInput {
            title: title.into(),
            ..PlaybookInput::default()
        }
    }

    fn item(text: &str) -> ListItem {
        ListItem {
            id: clock::new_id(),
            text: text.into(),
            origin: Origin::Authored,
        }
    }

    /// Starts a draft after revision 1 that drops the screenshot and adds verification.
    fn edit_draft(fx: &mut Fixture, playbook: &PlaybookDetail, title: &str) -> PlaybookContent {
        let id = &playbook.summary.id;
        playbooks::set_status(&mut fx.connection, id, PlaybookStatus::Draft, "").unwrap();
        let mut content = playbook.content.clone();
        content.steps[0].asset_ids.clear();
        content.verification.push(item("Health checks pass"));
        playbooks::save(&mut fx.connection, id, &input(title), &content).unwrap();
        content
    }

    #[test]
    fn reads_revisions_with_their_snapshot() {
        let mut fx = fixture();
        let playbook = published(&mut fx);
        let id = playbook.summary.id.clone();
        edit_draft(&mut fx, &playbook, "Patch the web tier v2");
        let revision = get_revision(&fx.connection, &id, &playbook.revisions[0].id).unwrap();
        assert_eq!(revision.revision.revision_number, 1);
        assert_eq!(revision.snapshot.title, "Patch the web tier");
        assert_eq!(revision.snapshot.platform, "Ubuntu 24.04");
        assert_eq!(revision.snapshot.content.steps[0].asset_ids.len(), 1);
        assert_eq!(revision.latest_revision_number, 1);
        assert_eq!(
            get_revision(&fx.connection, &id, &clock::new_id())
                .unwrap_err()
                .kind(),
            "not_found"
        );
    }

    #[test]
    fn restoring_keeps_unpublished_work_as_a_restore_point() {
        let mut fx = fixture();
        let playbook = published(&mut fx);
        let id = playbook.summary.id.clone();
        let draft_content = edit_draft(&mut fx, &playbook, "Patch the web tier v2");

        let restored = restore(
            &mut fx.connection,
            &id,
            &VersionRef::Revision(playbook.revisions[0].id.clone()),
        )
        .unwrap();
        assert_eq!(restored.summary.status, PlaybookStatus::Draft);
        assert_eq!(restored.summary.title, "Patch the web tier");
        assert_eq!(
            restored.content, playbook.content,
            "revision content is back"
        );
        assert_eq!(restored.restored_from_revision, Some(1));
        assert_eq!(restored.revisions.len(), 1, "history is unchanged");
        assert_eq!(restored.restore_points.len(), 1);
        let point = &restored.restore_points[0];
        assert_eq!(point.title, "Patch the web tier v2");
        assert_eq!(point.replaced_by, "revision:1");

        // The unpublished draft can be brought back from the restore point, after more edits
        // to the restored draft: those edits are kept as a restore point too.
        let saved = get_restore_point(&fx.connection, &id, &point.id).unwrap();
        assert_eq!(
            saved.snapshot.content.verification,
            draft_content.verification
        );
        let mut interim = restored.content.clone();
        interim.purpose = "Interim edit".into();
        playbooks::save(&mut fx.connection, &id, &input("Interim"), &interim).unwrap();
        let back = restore(
            &mut fx.connection,
            &id,
            &VersionRef::RestorePoint(point.id.clone()),
        )
        .unwrap();
        assert_eq!(back.summary.title, "Patch the web tier v2");
        assert_eq!(back.restored_from_revision, None);
        assert_eq!(back.restore_points.len(), 2);
        assert_eq!(back.restore_points[0].title, "Interim");
        assert!(
            back.restore_points[0]
                .replaced_by
                .starts_with("restore-point:")
        );

        // Restoring the same content again changes nothing.
        let again = restore(
            &mut fx.connection,
            &id,
            &VersionRef::RestorePoint(point.id.clone()),
        )
        .unwrap_err();
        assert_eq!(again.kind(), "conflict");
    }

    #[test]
    fn evidence_of_restore_points_and_revisions_is_kept() {
        let mut fx = fixture();
        let playbook = published(&mut fx);
        let id = playbook.summary.id.clone();
        edit_draft(&mut fx, &playbook, "Draft without screenshot");
        restore(
            &mut fx.connection,
            &id,
            &VersionRef::Revision(playbook.revisions[0].id.clone()),
        )
        .unwrap();
        // Dropping the screenshot from the draft keeps the file: revision 1 still uses it.
        let mut content = playbooks::get(&fx.connection, &id).unwrap().content;
        content.steps[0].asset_ids.clear();
        let (_, removed) =
            playbooks::save(&mut fx.connection, &id, &input("Again"), &content).unwrap();
        assert!(removed.is_empty());
        assert_eq!(playbooks::get(&fx.connection, &id).unwrap().assets.len(), 1);
    }

    #[test]
    fn restoring_a_published_playbook_without_changes_needs_no_restore_point() {
        let mut fx = fixture();
        let playbook = published(&mut fx);
        let id = playbook.summary.id.clone();
        playbooks::set_status(&mut fx.connection, &id, PlaybookStatus::Draft, "").unwrap();
        let mut content = playbook.content.clone();
        content.purpose = "Second version".into();
        playbooks::save(
            &mut fx.connection,
            &id,
            &input("Patch the web tier"),
            &content,
        )
        .unwrap();
        let second =
            playbooks::set_status(&mut fx.connection, &id, PlaybookStatus::Published, "").unwrap();
        assert_eq!(second.revisions.len(), 2);
        let restored = restore(
            &mut fx.connection,
            &id,
            &VersionRef::Revision(second.revisions[1].id.clone()),
        )
        .unwrap();
        assert_eq!(restored.summary.status, PlaybookStatus::Draft);
        assert_eq!(restored.content.purpose, "");
        assert!(
            restored.restore_points.is_empty(),
            "the replaced copy equals revision 2"
        );
    }

    #[test]
    fn restoring_is_refused_while_in_review() {
        let mut fx = fixture();
        let playbook = published(&mut fx);
        let id = playbook.summary.id.clone();
        edit_draft(&mut fx, &playbook, "Changed");
        playbooks::set_status(&mut fx.connection, &id, PlaybookStatus::InReview, "").unwrap();
        let error = restore(
            &mut fx.connection,
            &id,
            &VersionRef::Revision(playbook.revisions[0].id.clone()),
        )
        .unwrap_err();
        assert!(error.to_string().contains("Return it to draft"));
    }

    #[test]
    fn only_published_procedures_can_be_marked_out_of_date() {
        let mut fx = fixture();
        let playbook = published(&mut fx);
        let id = playbook.summary.id.clone();
        let marked =
            set_outdated(&fx.connection, &id, true, "Ubuntu 26.04 changed the steps").unwrap();
        assert!(marked.summary.outdated_at.is_some());
        assert_eq!(marked.outdated_note, "Ubuntu 26.04 changed the steps");
        let cleared = set_outdated(&fx.connection, &id, false, "").unwrap();
        assert!(cleared.summary.outdated_at.is_none());
        assert_eq!(cleared.outdated_note, "");

        set_outdated(&fx.connection, &id, true, "old").unwrap();
        playbooks::set_status(&mut fx.connection, &id, PlaybookStatus::Draft, "").unwrap();
        let republished =
            playbooks::set_status(&mut fx.connection, &id, PlaybookStatus::Published, "").unwrap();
        assert!(
            republished.summary.outdated_at.is_none(),
            "publishing clears it"
        );

        let draft = playbooks::create_blank(&mut fx.connection, &input("Never published")).unwrap();
        assert_eq!(
            set_outdated(&fx.connection, &draft.summary.id, true, "")
                .unwrap_err()
                .kind(),
            "conflict"
        );
    }

    #[test]
    fn duplicates_get_their_own_evidence_and_remember_the_original() {
        let mut fx = fixture();
        let playbook = published(&mut fx);
        let id = playbook.summary.id.clone();
        edit_draft(&mut fx, &playbook, "Patch the web tier v2");

        let from_revision = duplicate(
            &mut fx.connection,
            &fx.assets,
            &id,
            Some(&playbook.revisions[0].id),
        )
        .unwrap();
        assert_eq!(from_revision.summary.title, "Copy of Patch the web tier");
        assert_eq!(from_revision.summary.status, PlaybookStatus::Draft);
        assert!(from_revision.revisions.is_empty());
        assert_eq!(
            from_revision.sessions.len(),
            1,
            "source sessions stay linked"
        );
        let based_on = from_revision.based_on.clone().unwrap();
        assert_eq!(based_on.playbook_id.as_deref(), Some(id.as_str()));
        assert_eq!(based_on.revision_number, Some(1));
        assert_eq!(from_revision.assets.len(), 1);
        let copy = &from_revision.assets[0];
        assert_ne!(copy.id, playbook.assets[0].id);
        assert_eq!(copy.sha256, playbook.assets[0].sha256);
        assert_eq!(
            from_revision.content.steps[0].asset_ids,
            std::slice::from_ref(&copy.id)
        );
        assert_eq!(from_revision.content.steps[0].origin, Origin::Session);
        let stored = playbooks::locate_asset(&fx.connection, &copy.id).unwrap();
        assert!(stored.relative_path.starts_with(&from_revision.summary.id));
        assert!(
            storage::resolve_contained(&fx.assets, &stored.relative_path)
                .unwrap()
                .is_file()
        );

        let from_draft = duplicate(&mut fx.connection, &fx.assets, &id, None).unwrap();
        assert_eq!(from_draft.summary.title, "Copy of Patch the web tier v2");
        assert!(from_draft.assets.is_empty(), "the draft has no screenshot");
        assert_eq!(from_draft.based_on.unwrap().revision_number, None);

        // Deleting the original keeps the duplicate and its evidence.
        playbooks::delete_records(&mut fx.connection, &id).unwrap();
        let orphan = playbooks::get(&fx.connection, &from_revision.summary.id).unwrap();
        assert_eq!(orphan.assets.len(), 1);
        assert_eq!(orphan.based_on.unwrap().playbook_id, None);
    }
}
