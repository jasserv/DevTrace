//! Ordered, forward-only schema migrations tracked with `PRAGMA user_version`.
//!
//! Rules:
//! * Each migration runs in its own transaction together with the version bump, so a failed
//!   migration leaves the database at the previous version.
//! * Before migrating an existing database, a full copy is written to the backups folder.
//! * A database created by a newer DevTrace (higher version) is refused rather than modified.
//! * Released migrations are never edited; changes always ship as a new migration.

use std::path::{Path, PathBuf};

use rusqlite::Connection;

use crate::error::{AppError, AppResult};

pub struct Migration {
    pub version: u32,
    pub name: &'static str,
    pub sql: &'static str,
}

pub const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "foundation",
        sql: include_str!("sql/0001_foundation.sql"),
    },
    Migration {
        version: 2,
        name: "events_attachments",
        sql: include_str!("sql/0002_events_attachments.sql"),
    },
    Migration {
        version: 3,
        name: "capture_review",
        sql: include_str!("sql/0003_capture_review.sql"),
    },
    Migration {
        version: 4,
        name: "playbook_authoring",
        sql: include_str!("sql/0004_playbook_authoring.sql"),
    },
    Migration {
        version: 5,
        name: "version_history",
        sql: include_str!("sql/0005_version_history.sql"),
    },
    Migration {
        version: 6,
        name: "change_tracking",
        sql: include_str!("sql/0006_change_tracking.sql"),
    },
];

pub fn latest_version() -> u32 {
    MIGRATIONS.last().map_or(0, |migration| migration.version)
}

pub fn current_version(connection: &Connection) -> AppResult<u32> {
    Ok(connection.pragma_query_value(None, "user_version", |row| row.get(0))?)
}

/// Brings the database to the latest schema version and returns that version.
pub fn migrate(connection: &mut Connection, backup_dir: Option<&Path>) -> AppResult<u32> {
    let current = current_version(connection)?;
    let latest = latest_version();

    if current > latest {
        return Err(AppError::internal(format!(
            "This workspace uses database schema version {current}, but this version of DevTrace \
             supports up to version {latest}. Update DevTrace to open it; the data has not been modified."
        )));
    }
    if current == latest {
        return Ok(current);
    }
    if current > 0
        && let Some(dir) = backup_dir
    {
        backup_database(connection, dir, current)?;
    }

    for migration in MIGRATIONS
        .iter()
        .filter(|migration| migration.version > current)
    {
        let transaction = connection.transaction()?;
        transaction.execute_batch(migration.sql).map_err(|error| {
            AppError::internal(format!(
                "Database migration {} ({}) failed: {error}",
                migration.version, migration.name
            ))
        })?;
        transaction.pragma_update(None, "user_version", migration.version)?;
        transaction.commit()?;
    }
    Ok(latest)
}

/// Writes a consistent copy of the database using `VACUUM INTO`.
pub fn backup_database(connection: &Connection, dir: &Path, version: u32) -> AppResult<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%SZ");
    let target = dir.join(format!("devtrace-schema-v{version}-{stamp}.sqlite3"));
    if target.exists() {
        return Err(AppError::internal(format!(
            "Backup file already exists: {}",
            target.display()
        )));
    }
    connection.execute("VACUUM INTO ?1", [target.to_string_lossy().as_ref()])?;
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table_names(connection: &Connection) -> Vec<String> {
        let mut statement = connection
            .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
            .unwrap();
        statement
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    #[test]
    fn versions_are_strictly_increasing() {
        let versions: Vec<u32> = MIGRATIONS
            .iter()
            .map(|migration| migration.version)
            .collect();
        assert!(versions.windows(2).all(|pair| pair[0] < pair[1]));
        assert_eq!(versions.first(), Some(&1));
    }

    #[test]
    fn migrates_fresh_database_to_latest() {
        let mut connection = Connection::open_in_memory().unwrap();
        let version = migrate(&mut connection, None).unwrap();
        assert_eq!(version, latest_version());
        assert_eq!(current_version(&connection).unwrap(), latest_version());
        let tables = table_names(&connection);
        for expected in [
            "app_settings",
            "attachments",
            "change_records",
            "events",
            "playbook_assets",
            "playbook_restore_points",
            "playbook_revisions",
            "playbook_sessions",
            "playbooks",
            "projects",
            "review_decisions",
            "sessions",
        ] {
            assert!(
                tables.iter().any(|name| name == expected),
                "missing table {expected}"
            );
        }
    }

    #[test]
    fn upgrades_a_version_1_workspace_with_a_backup() {
        let temp = tempfile::tempdir().unwrap();
        let backups = temp.path().join("backups");
        let mut connection = Connection::open(temp.path().join("devtrace.sqlite3")).unwrap();
        crate::db::configure(&connection).unwrap();
        {
            let transaction = connection.transaction().unwrap();
            transaction.execute_batch(MIGRATIONS[0].sql).unwrap();
            transaction.pragma_update(None, "user_version", 1).unwrap();
            transaction
                .execute_batch(
                    "INSERT INTO sessions (id, title, created_at, updated_at) VALUES ('s1', 'Existing', 't', 't');",
                )
                .unwrap();
            transaction.commit().unwrap();
        }

        assert_eq!(
            migrate(&mut connection, Some(&backups)).unwrap(),
            latest_version()
        );

        let backup_files: Vec<_> = std::fs::read_dir(&backups)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        assert_eq!(backup_files.len(), 1);
        let backup = Connection::open(&backup_files[0]).unwrap();
        assert_eq!(current_version(&backup).unwrap(), 1);
        assert!(!table_names(&backup).iter().any(|name| name == "events"));

        connection
            .execute_batch(
                "INSERT INTO events (id, session_id, position, occurred_at, event_type, source, title, created_at, updated_at)
                   VALUES ('e1', 's1', 0, 't', 'step', 'manual', 'Step', 't', 't');
                 INSERT INTO attachments (id, session_id, event_id, kind, source, relative_path, media_type, byte_size, sha256, created_at)
                   VALUES ('a1', 's1', 'e1', 'screenshot', 'file', 's1/a1.png', 'image/png', 1, printf('%064d', 0), 't');
                 DELETE FROM sessions WHERE id = 's1';",
            )
            .unwrap();
        let remaining: (i64, i64) = connection
            .query_row(
                "SELECT (SELECT COUNT(*) FROM events), (SELECT COUNT(*) FROM attachments)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(remaining, (0, 0));
    }

    #[test]
    fn schema_rejects_structurally_invalid_events_and_attachments() {
        let mut connection = Connection::open_in_memory().unwrap();
        crate::db::configure(&connection).unwrap();
        migrate(&mut connection, None).unwrap();
        connection
            .execute_batch(
                "INSERT INTO sessions (id, title, created_at, updated_at) VALUES ('s1', 'S', 't', 't');",
            )
            .unwrap();
        for statement in [
            // Event for a session that does not exist.
            "INSERT INTO events (id, session_id, position, occurred_at, event_type, source, title, created_at, updated_at)
               VALUES ('e1', 'missing', 0, 't', 'step', 'manual', 'Step', 't', 't')",
            // Blank title.
            "INSERT INTO events (id, session_id, position, occurred_at, event_type, source, title, created_at, updated_at)
               VALUES ('e2', 's1', 0, 't', 'step', 'manual', '   ', 't', 't')",
            // Empty file.
            "INSERT INTO attachments (id, session_id, kind, source, relative_path, media_type, byte_size, sha256, created_at)
               VALUES ('a1', 's1', 'screenshot', 'file', 's1/a1.png', 'image/png', 0, printf('%064d', 0), 't')",
            // Malformed digest.
            "INSERT INTO attachments (id, session_id, kind, source, relative_path, media_type, byte_size, sha256, created_at)
               VALUES ('a2', 's1', 'screenshot', 'file', 's1/a2.png', 'image/png', 1, 'abc', 't')",
        ] {
            assert!(connection.execute(statement, []).is_err(), "accepted: {statement}");
        }
    }

    #[test]
    fn migrate_is_idempotent() {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate(&mut connection, None).unwrap();
        assert_eq!(migrate(&mut connection, None).unwrap(), latest_version());
    }

    #[test]
    fn refuses_database_from_newer_version() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .pragma_update(None, "user_version", latest_version() + 1)
            .unwrap();
        let error = migrate(&mut connection, None).unwrap_err();
        assert!(error.to_string().contains("Update DevTrace"));
        assert_eq!(current_version(&connection).unwrap(), latest_version() + 1);
    }

    #[test]
    fn backup_writes_a_readable_copy() {
        let temp = tempfile::tempdir().unwrap();
        let mut connection = Connection::open(temp.path().join("source.sqlite3")).unwrap();
        migrate(&mut connection, None).unwrap();
        connection
            .execute(
                "INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1', 'Lab', 't', 't')",
                [],
            )
            .unwrap();
        let backup = backup_database(&connection, &temp.path().join("backups"), 1).unwrap();
        let copy = Connection::open(backup).unwrap();
        let count: i64 = copy
            .query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }
}
