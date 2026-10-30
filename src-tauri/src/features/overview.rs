//! Aggregated, read-only data for the Overview workspace. Everything returned here comes
//! from the database; nothing is synthesized.

use rusqlite::Connection;
use serde::Serialize;
use tauri::State;

use crate::error::AppResult;
use crate::features::changes::{self, ChangeRecord};
use crate::features::playbooks::{self, PlaybookStatus, PlaybookSummary};
use crate::features::projects::{self, Project};
use crate::features::sessions::{self, SessionSummary};
use crate::state::AppState;

text_enum! {
    pub enum ReviewItemKind {
        Session => "session",
        Playbook => "playbook",
        Change => "change",
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewCounts {
    pub projects: i64,
    pub sessions: i64,
    pub sessions_awaiting_review: i64,
    pub playbooks_draft: i64,
    pub playbooks_in_review: i64,
    pub playbooks_published: i64,
    pub changes: i64,
    pub changes_pending: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewItem {
    pub kind: ReviewItemKind,
    pub id: String,
    pub title: String,
    pub project_name: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub counts: OverviewCounts,
    pub recent_sessions: Vec<SessionSummary>,
    pub draft_playbooks: Vec<PlaybookSummary>,
    pub published_playbooks: Vec<PlaybookSummary>,
    pub awaiting_review: Vec<ReviewItem>,
    pub recent_projects: Vec<Project>,
    pub recent_changes: Vec<ChangeRecord>,
}

const RECENT_LIMIT: u32 = 5;
const REVIEW_LIMIT: u32 = 8;

fn counts(connection: &Connection) -> AppResult<OverviewCounts> {
    Ok(connection.query_row(
        "SELECT
            (SELECT COUNT(*) FROM projects),
            (SELECT COUNT(*) FROM sessions),
            (SELECT COUNT(*) FROM sessions WHERE status = 'completed' AND review_state <> 'reviewed'),
            (SELECT COUNT(*) FROM playbooks WHERE status = 'draft'),
            (SELECT COUNT(*) FROM playbooks WHERE status = 'in_review'),
            (SELECT COUNT(*) FROM playbooks WHERE status = 'published'),
            (SELECT COUNT(*) FROM change_records),
            (SELECT COUNT(*) FROM change_records WHERE approval_state = 'pending')",
        [],
        |row| {
            Ok(OverviewCounts {
                projects: row.get(0)?,
                sessions: row.get(1)?,
                sessions_awaiting_review: row.get(2)?,
                playbooks_draft: row.get(3)?,
                playbooks_in_review: row.get(4)?,
                playbooks_published: row.get(5)?,
                changes: row.get(6)?,
                changes_pending: row.get(7)?,
            })
        },
    )?)
}

/// Completed sessions not yet reviewed, playbooks in review, and pending change records.
fn awaiting_review(connection: &Connection) -> AppResult<Vec<ReviewItem>> {
    let mut statement = connection.prepare(
        "SELECT 'session', s.id, s.title, p.name, s.updated_at
           FROM sessions s LEFT JOIN projects p ON p.id = s.project_id
          WHERE s.status = 'completed' AND s.review_state <> 'reviewed'
         UNION ALL
         SELECT 'playbook', b.id, b.title, p.name, b.updated_at
           FROM playbooks b LEFT JOIN projects p ON p.id = b.project_id
          WHERE b.status = 'in_review'
         UNION ALL
         SELECT 'change', c.id, c.target, p.name, c.updated_at
           FROM change_records c LEFT JOIN projects p ON p.id = c.project_id
          WHERE c.approval_state = 'pending'
         ORDER BY 5 DESC
         LIMIT ?1",
    )?;
    let items = statement
        .query_map([REVIEW_LIMIT], |row| {
            Ok(ReviewItem {
                kind: row.get(0)?,
                id: row.get(1)?,
                title: row.get(2)?,
                project_name: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(items)
}

pub fn load(connection: &Connection) -> AppResult<Overview> {
    Ok(Overview {
        counts: counts(connection)?,
        recent_sessions: sessions::list(connection, Some(RECENT_LIMIT))?,
        draft_playbooks: playbooks::list(
            connection,
            Some(PlaybookStatus::Draft),
            Some(RECENT_LIMIT),
        )?,
        published_playbooks: playbooks::list(
            connection,
            Some(PlaybookStatus::Published),
            Some(RECENT_LIMIT),
        )?,
        awaiting_review: awaiting_review(connection)?,
        recent_projects: projects::list(connection, Some(RECENT_LIMIT))?,
        recent_changes: changes::list(connection, Some(RECENT_LIMIT))?,
    })
}

#[tauri::command]
pub async fn get_overview(state: State<'_, AppState>) -> AppResult<Overview> {
    state.with_db(|connection| load(connection))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    #[test]
    fn empty_workspace_reports_nothing() {
        let connection = db::open_in_memory();
        let overview = load(&connection).unwrap();
        assert_eq!(overview.counts, OverviewCounts::default());
        assert!(overview.recent_sessions.is_empty());
        assert!(overview.awaiting_review.is_empty());
        assert!(overview.recent_projects.is_empty());
    }

    #[test]
    fn collects_items_awaiting_review_from_all_sources() {
        let connection = db::open_in_memory();
        connection
            .execute_batch(
                "INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1', 'Lab', 't', '2026-01-01T00:00:00.000Z');
                 INSERT INTO sessions (id, project_id, title, status, review_state, created_at, updated_at)
                   VALUES ('s1', 'p1', 'Completed capture', 'completed', 'unreviewed', 't', '2026-01-03T00:00:00.000Z');
                 INSERT INTO sessions (id, title, status, review_state, created_at, updated_at)
                   VALUES ('s2', 'Reviewed capture', 'completed', 'reviewed', 't', '2026-01-04T00:00:00.000Z');
                 INSERT INTO playbooks (id, title, status, created_at, updated_at)
                   VALUES ('b1', 'In review', 'in_review', 't', '2026-01-02T00:00:00.000Z');
                 INSERT INTO change_records (id, occurred_at, target, created_at, updated_at)
                   VALUES ('c1', 't', 'ntp server', 't', '2026-01-05T00:00:00.000Z');",
            )
            .unwrap();
        let overview = load(&connection).unwrap();
        assert_eq!(overview.counts.projects, 1);
        assert_eq!(overview.counts.sessions, 2);
        assert_eq!(overview.counts.sessions_awaiting_review, 1);
        assert_eq!(overview.counts.playbooks_in_review, 1);
        assert_eq!(overview.counts.changes_pending, 1);
        let kinds: Vec<ReviewItemKind> = overview
            .awaiting_review
            .iter()
            .map(|item| item.kind)
            .collect();
        assert_eq!(
            kinds,
            vec![
                ReviewItemKind::Change,
                ReviewItemKind::Session,
                ReviewItemKind::Playbook
            ]
        );
        assert_eq!(
            overview.awaiting_review[1].project_name.as_deref(),
            Some("Lab")
        );
    }
}
