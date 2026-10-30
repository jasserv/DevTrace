//! SQLite connection setup.

pub mod migrations;

use rusqlite::Connection;

use crate::error::AppResult;
use crate::paths::AppPaths;

/// Opens (or creates) the workspace database, applies connection settings and migrations.
pub fn open(paths: &AppPaths) -> AppResult<Connection> {
    let mut connection = Connection::open(&paths.database_file)?;
    configure(&connection)?;
    migrations::migrate(&mut connection, Some(&paths.backups_dir))?;
    Ok(connection)
}

/// Connection-level settings. Foreign keys are off by default in SQLite and must be enabled
/// on every connection.
pub fn configure(connection: &Connection) -> AppResult<()> {
    connection.execute_batch(
        "PRAGMA foreign_keys = ON;
         PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA busy_timeout = 5000;",
    )?;
    Ok(())
}

/// In-memory database with the full schema, for unit tests.
#[cfg(test)]
pub fn open_in_memory() -> Connection {
    let mut connection = Connection::open_in_memory().expect("open in-memory database");
    configure(&connection).expect("configure");
    migrations::migrate(&mut connection, None).expect("migrate");
    connection
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_creates_database_file_with_foreign_keys_enabled() {
        let temp = tempfile::tempdir().unwrap();
        let paths = AppPaths::from_root(temp.path());
        paths.ensure_dirs().unwrap();
        let connection = open(&paths).unwrap();
        assert!(paths.database_file.is_file());
        let foreign_keys: i64 = connection
            .pragma_query_value(None, "foreign_keys", |row| row.get(0))
            .unwrap();
        assert_eq!(foreign_keys, 1);
        let mode: String = connection
            .pragma_query_value(None, "journal_mode", |row| row.get(0))
            .unwrap();
        assert_eq!(mode.to_lowercase(), "wal");
    }

    #[test]
    fn reopening_preserves_data() {
        let temp = tempfile::tempdir().unwrap();
        let paths = AppPaths::from_root(temp.path());
        paths.ensure_dirs().unwrap();
        {
            let connection = open(&paths).unwrap();
            connection
                .execute(
                    "INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1', 'Lab', 't', 't')",
                    [],
                )
                .unwrap();
        }
        let connection = open(&paths).unwrap();
        let name: String = connection
            .query_row("SELECT name FROM projects WHERE id = 'p1'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(name, "Lab");
    }
}
