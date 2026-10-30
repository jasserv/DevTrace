//! The document model shared by every export format: one version of a playbook (its unpublished
//! working copy or an immutable published revision) with metadata, content and evidence
//! references, read from the database in one go.

use std::collections::HashMap;

use chrono::{DateTime, Local};
use rusqlite::{Connection, OptionalExtension};

use crate::error::{AppError, AppResult};
use crate::features::attachments::Annotation;
use crate::features::events::EventSource;
use crate::features::playbook_content::{Origin, PlaybookContent, PlaybookStep};
use crate::features::playbooks::{self, PlaybookStatus, VersionSnapshot};
use crate::validate;

/// Which version of a playbook a document shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Version {
    /// The unpublished working copy (draft or in review).
    Working {
        status: PlaybookStatus,
        /// The newest published revision, when this draft continues from one.
        after_revision: Option<i64>,
    },
    /// An immutable published revision.
    Revision {
        number: i64,
        published_at: String,
        author: String,
        note: String,
        /// Number of the newest revision of the playbook.
        latest: i64,
    },
}

impl Version {
    /// Short label used in file names: `draft`, `review` or `r3`.
    pub fn file_label(&self) -> String {
        match self {
            Self::Working {
                status: PlaybookStatus::InReview,
                ..
            } => "review".into(),
            Self::Working { .. } => "draft".into(),
            Self::Revision { number, .. } => format!("r{number}"),
        }
    }

    /// Human label: `Draft`, `In review` or `Revision 3`.
    pub fn label(&self) -> String {
        match self {
            Self::Working {
                status: PlaybookStatus::InReview,
                ..
            } => "In review".into(),
            Self::Working { .. } => "Draft".into(),
            Self::Revision { number, .. } => format!("Revision {number}"),
        }
    }

    /// One-line status shown under the title.
    pub fn status_line(&self) -> String {
        match self {
            Self::Working {
                status: PlaybookStatus::InReview,
                ..
            } => "In review \u{2014} not published".into(),
            Self::Working {
                after_revision: Some(number),
                ..
            } => format!("Draft \u{2014} not published (changes after revision {number})"),
            Self::Working { .. } => "Draft \u{2014} not published".into(),
            Self::Revision {
                number,
                published_at,
                author,
                ..
            } => {
                let by = if author.is_empty() {
                    String::new()
                } else {
                    format!(" by {author}")
                };
                format!(
                    "Published \u{2014} revision {number}, {}{by}",
                    local_time(published_at)
                )
            }
        }
    }
}

/// An evidence copy referenced by the document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetRef {
    pub relative_path: String,
    pub annotations: Vec<Annotation>,
    pub redacted: bool,
}

/// A notice shown at the top of the document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Banner {
    pub title: String,
    pub text: String,
    /// Draws attention (out of date, superseded) rather than informing (draft).
    pub caution: bool,
}

#[derive(Debug, Clone)]
pub struct ExportDocument {
    pub playbook_id: String,
    pub title: String,
    pub summary: String,
    pub version: Version,
    /// Non-empty metadata in display order, for example `("Platform", "FortiGate")`.
    pub fields: Vec<(&'static str, String)>,
    pub content: PlaybookContent,
    pub assets: HashMap<String, AssetRef>,
    /// Titles of the source sessions that still exist.
    pub sessions: HashMap<String, String>,
    /// Set when the playbook was marked out of date: `(when, note)`.
    pub outdated: Option<(String, String)>,
}

impl ExportDocument {
    /// Notices for the top of the document, most important first.
    pub fn banners(&self) -> Vec<Banner> {
        let mut banners = Vec::new();
        match &self.version {
            Version::Revision { number, latest, .. } if number < latest => banners.push(Banner {
                title: "Superseded".into(),
                text: format!(
                    "This is revision {number}. Revision {latest} of this playbook is newer."
                ),
                caution: true,
            }),
            Version::Revision { .. } => {}
            Version::Working {
                status: PlaybookStatus::InReview,
                ..
            } => banners.push(Banner {
                title: "In review".into(),
                text: "This version has not been published yet and may change.".into(),
                caution: false,
            }),
            Version::Working { .. } => banners.push(Banner {
                title: "Draft".into(),
                text: "This version has not been published and may change.".into(),
                caution: false,
            }),
        }
        let current = match &self.version {
            Version::Revision { number, latest, .. } => number == latest,
            Version::Working { .. } => true,
        };
        if current && let Some((at, note)) = &self.outdated {
            let mut text = format!("Marked out of date on {}.", local_time(at));
            if !note.is_empty() {
                text.push(' ');
                text.push_str(note);
            }
            banners.push(Banner {
                title: "Out of date".into(),
                text,
                caution: true,
            });
        }
        banners
    }

    /// Where a step came from, in the words the editor uses, for example
    /// `From session “Rotate keys” (captured screenshot), edited after copying`.
    pub fn provenance(&self, step: &PlaybookStep) -> String {
        if step.origin == Origin::Authored || step.source_event_id.is_none() {
            return "Written in the playbook".into();
        }
        let session = step
            .source_session_id
            .as_ref()
            .and_then(|id| self.sessions.get(id))
            .map_or_else(
                || "a session that was later deleted".to_string(),
                |title| format!("session \u{201c}{title}\u{201d}"),
            );
        let kind = step
            .source_kind
            .map(|kind| format!(" ({})", source_kind_label(kind)))
            .unwrap_or_default();
        let edited = if step.origin == Origin::Edited {
            ", edited after copying"
        } else {
            ""
        };
        format!("From {session}{kind}{edited}")
    }
}

pub fn source_kind_label(kind: EventSource) -> &'static str {
    match kind {
        EventSource::Capture => "captured screenshot",
        EventSource::File => "imported image",
        EventSource::Clipboard => "pasted screenshot",
        EventSource::Manual => "written step",
        EventSource::Terminal => "terminal log",
        EventSource::FileWatch => "watched file",
    }
}

/// Short tag for list items that did not originate in the playbook.
pub fn origin_tag(origin: Origin) -> Option<&'static str> {
    match origin {
        Origin::Session => Some("from session"),
        Origin::Edited => Some("edited from session"),
        Origin::Authored => None,
    }
}

/// `2026-10-23 15:20 (UTC+08:00)` in the computer's time zone; unparsable input is returned as is.
pub fn local_time(rfc3339: &str) -> String {
    DateTime::parse_from_rfc3339(rfc3339)
        .map(|time| {
            time.with_timezone(&Local)
                .format("%Y-%m-%d %H:%M (UTC%:z)")
                .to_string()
        })
        .unwrap_or_else(|_| rfc3339.to_string())
}

struct Metadata<'a> {
    project: Option<&'a str>,
    platform: &'a str,
    product: &'a str,
    product_version: &'a str,
    environment: &'a str,
    task_type: &'a str,
    author: &'a str,
}

fn fields(metadata: &Metadata<'_>) -> Vec<(&'static str, String)> {
    [
        ("Project", metadata.project.unwrap_or_default()),
        ("Platform", metadata.platform),
        ("Product", metadata.product),
        ("Version", metadata.product_version),
        ("Environment", metadata.environment),
        ("Task type", metadata.task_type),
        ("Author", metadata.author),
    ]
    .into_iter()
    .filter(|(_, value)| !value.trim().is_empty())
    .map(|(label, value)| (label, value.to_string()))
    .collect()
}

/// Loads a playbook version for export. Without `revision_id`, a published playbook exports its
/// newest revision and an unpublished one its working copy.
pub fn load(
    connection: &Connection,
    playbook_id: &str,
    revision_id: Option<&str>,
) -> AppResult<ExportDocument> {
    let detail = playbooks::get(connection, playbook_id)?;
    let id = detail.summary.id.clone();
    let latest = detail
        .revisions
        .first()
        .map(|revision| revision.revision_number);
    let revision_id = match revision_id.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => Some(validate::id("revisionId", value)?),
        None if detail.summary.status == PlaybookStatus::Published => {
            detail.revisions.first().map(|revision| revision.id.clone())
        }
        None => None,
    };

    let (title, summary, version, fields, content) = match revision_id {
        Some(revision_id) => {
            let row: Option<(i64, String, String, String, String)> = connection
                .query_row(
                    "SELECT revision_number, snapshot_json, note, author, created_at
                     FROM playbook_revisions WHERE id = ?1 AND playbook_id = ?2",
                    [&revision_id, &id],
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
                .optional()?;
            let (number, raw, note, author, published_at) =
                row.ok_or_else(|| AppError::not_found("Revision", &revision_id))?;
            let snapshot = VersionSnapshot::from_json(&raw)?;
            let fields = fields(&Metadata {
                project: snapshot.project_name.as_deref(),
                platform: &snapshot.platform,
                product: &snapshot.product,
                product_version: &snapshot.product_version,
                environment: &snapshot.environment,
                task_type: &snapshot.task_type,
                author: &snapshot.author,
            });
            let version = Version::Revision {
                number,
                published_at,
                author,
                note,
                latest: latest.unwrap_or(number).max(number),
            };
            (
                snapshot.title,
                snapshot.summary,
                version,
                fields,
                snapshot.content,
            )
        }
        None => {
            let summary = &detail.summary;
            let fields = fields(&Metadata {
                project: summary.project_name.as_deref(),
                platform: &summary.platform,
                product: &summary.product,
                product_version: &summary.product_version,
                environment: &summary.environment,
                task_type: &summary.task_type,
                author: &summary.author,
            });
            let version = Version::Working {
                status: summary.status,
                after_revision: latest,
            };
            (
                summary.title.clone(),
                summary.summary.clone(),
                version,
                fields,
                detail.content.clone(),
            )
        }
    };

    let mut assets = HashMap::new();
    {
        let mut statement = connection.prepare(
            "SELECT id, relative_path, annotations_json, redacted_at FROM playbook_assets
             WHERE playbook_id = ?1",
        )?;
        let rows = statement.query_map([&id], |row| {
            let annotations: String = row.get(2)?;
            Ok((
                row.get::<_, String>(0)?,
                AssetRef {
                    relative_path: row.get(1)?,
                    annotations: serde_json::from_str(&annotations).unwrap_or_default(),
                    redacted: row.get::<_, Option<String>>(3)?.is_some(),
                },
            ))
        })?;
        for row in rows {
            let (asset_id, asset) = row?;
            assets.insert(asset_id, asset);
        }
    }

    let mut sessions = HashMap::new();
    for session_id in content
        .steps
        .iter()
        .filter_map(|step| step.source_session_id.as_ref())
    {
        if sessions.contains_key(session_id) {
            continue;
        }
        let title: Option<String> = connection
            .query_row(
                "SELECT title FROM sessions WHERE id = ?1",
                [session_id],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(title) = title {
            sessions.insert(session_id.clone(), title);
        }
    }

    Ok(ExportDocument {
        playbook_id: id,
        title,
        summary,
        version,
        fields,
        content,
        assets,
        sessions,
        outdated: detail
            .summary
            .outdated_at
            .clone()
            .map(|at| (at, detail.outdated_note.clone())),
    })
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::features::playbook_content::ListItem;

    /// A small document with every section filled, for renderer tests.
    pub fn sample() -> ExportDocument {
        let step = |id: &str, title: &str, origin: Origin| PlaybookStep {
            id: id.into(),
            title: title.into(),
            instruction: "Open the console.\nSign in as admin.".into(),
            command: String::new(),
            expected_result: String::new(),
            note: String::new(),
            asset_ids: Vec::new(),
            origin,
            source_session_id: (origin != Origin::Authored).then(|| "s1".to_string()),
            source_event_id: (origin != Origin::Authored).then(|| format!("e-{id}")),
            source_kind: (origin != Origin::Authored).then_some(EventSource::Capture),
        };
        let item = |id: &str, text: &str| ListItem {
            id: id.into(),
            text: text.into(),
            origin: Origin::Authored,
        };
        let mut first = step("a", "Open the certificate list", Origin::Session);
        first.asset_ids = vec!["img1".into()];
        let mut second = step("b", "Check expiry", Origin::Edited);
        second.command = "get vpn certificate local\nshow ```fenced```".into();
        second.expected_result = "The certificate is listed.".into();
        second.note = "Run from the CLI console.".into();
        let third = step("c", "Restart the tunnel", Origin::Authored);
        ExportDocument {
            playbook_id: "p1".into(),
            title: "Rotate the VPN certificate".into(),
            summary: "Renew before expiry.".into(),
            version: Version::Working {
                status: PlaybookStatus::Draft,
                after_revision: None,
            },
            fields: vec![
                ("Platform", "FortiGate".into()),
                ("Version", "7.4.3".into()),
            ],
            content: PlaybookContent {
                purpose: "Keep remote access working.".into(),
                scope: "Lab firewalls only.".into(),
                prerequisites: vec![item("p1", "Admin account")],
                permissions: vec![item("p2", "super_admin profile")],
                steps: vec![first, second, third],
                verification: vec![item("v1", "Clients reconnect")],
                warnings: vec![item("w1", "Tunnels drop briefly")],
                troubleshooting: vec![item("t1", "Check the CA chain")],
                rollback: vec![item("r1", "Re-import the old certificate")],
                ..PlaybookContent::default()
            },
            assets: HashMap::from([(
                "img1".to_string(),
                AssetRef {
                    relative_path: "p1/img1.png".into(),
                    annotations: Vec::new(),
                    redacted: false,
                },
            )]),
            sessions: HashMap::from([("s1".to_string(), "Rotate VPN certificate".to_string())]),
            outdated: None,
        }
    }

    #[test]
    fn provenance_distinguishes_recorded_edited_and_written_steps() {
        let mut document = sample();
        let steps = document.content.steps.clone();
        assert_eq!(
            document.provenance(&steps[0]),
            "From session \u{201c}Rotate VPN certificate\u{201d} (captured screenshot)"
        );
        assert!(
            document
                .provenance(&steps[1])
                .ends_with("edited after copying")
        );
        assert_eq!(document.provenance(&steps[2]), "Written in the playbook");
        document.sessions.clear();
        assert!(
            document
                .provenance(&steps[0])
                .contains("a session that was later deleted")
        );
    }

    #[test]
    fn banners_explain_unpublished_superseded_and_outdated_versions() {
        let mut document = sample();
        assert_eq!(document.banners()[0].title, "Draft");
        document.version = Version::Revision {
            number: 1,
            published_at: "2026-10-23T07:00:00.000Z".into(),
            author: "Jane".into(),
            note: String::new(),
            latest: 2,
        };
        document.outdated = Some(("2026-10-24T07:00:00.000Z".into(), "Firmware 7.6".into()));
        let banners = document.banners();
        assert_eq!(
            banners.len(),
            1,
            "an older revision is superseded, not outdated"
        );
        assert_eq!(banners[0].title, "Superseded");
        document.version = Version::Revision {
            number: 2,
            published_at: "2026-10-23T07:00:00.000Z".into(),
            author: String::new(),
            note: String::new(),
            latest: 2,
        };
        let banners = document.banners();
        assert_eq!(banners[0].title, "Out of date");
        assert!(banners[0].text.ends_with("Firmware 7.6"));
        assert!(document.version.status_line().starts_with("Published"));
        assert_eq!(document.version.file_label(), "r2");
    }

    #[test]
    fn local_time_keeps_unparsable_values() {
        assert_eq!(local_time("not a date"), "not a date");
        assert!(local_time("2026-10-23T07:00:00.000Z").contains("(UTC"));
    }
}
