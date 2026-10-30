//! Projects organize related sessions, playbooks, attachments and changes.

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::clock;
use crate::error::{AppError, AppResult, is_unique_violation};
use crate::state::AppState;
use crate::validate::{self, TextRule};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub description: String,
    pub created_at: String,
    pub updated_at: String,
    pub session_count: i64,
    pub playbook_count: i64,
    pub change_count: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectInput {
    pub name: String,
    #[serde(default)]
    pub description: String,
}

/// What happened to records that referenced a deleted project. They are kept, unassigned.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDeletion {
    pub id: String,
    pub unassigned_sessions: i64,
    pub unassigned_playbooks: i64,
    pub unassigned_changes: i64,
}

pub const NAME_RULE: TextRule = TextRule {
    field: "name",
    label: "Project name",
    max_chars: 120,
    required: true,
    multiline: false,
};

pub const DESCRIPTION_RULE: TextRule = TextRule {
    field: "description",
    label: "Description",
    max_chars: 2000,
    required: false,
    multiline: true,
};

const SELECT_PROJECT: &str = "
    SELECT p.id, p.name, p.description, p.created_at, p.updated_at,
           (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id),
           (SELECT COUNT(*) FROM playbooks b WHERE b.project_id = p.id),
           (SELECT COUNT(*) FROM change_records c WHERE c.project_id = p.id)
    FROM projects p";

fn map_project(row: &Row<'_>) -> rusqlite::Result<Project> {
    Ok(Project {
        id: row.get(0)?,
        name: row.get(1)?,
        description: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
        session_count: row.get(5)?,
        playbook_count: row.get(6)?,
        change_count: row.get(7)?,
    })
}

fn duplicate_name(name: &str) -> AppError {
    AppError::conflict(
        "name",
        format!("A project named \u{201c}{name}\u{201d} already exists."),
    )
}

fn validated(input: &ProjectInput) -> AppResult<(String, String)> {
    Ok((
        validate::text(&NAME_RULE, &input.name)?,
        validate::text(&DESCRIPTION_RULE, &input.description)?,
    ))
}

/// Most recently updated first.
pub fn list(connection: &Connection, limit: Option<u32>) -> AppResult<Vec<Project>> {
    let sql = format!(
        "{SELECT_PROJECT} ORDER BY p.updated_at DESC, p.name COLLATE NOCASE LIMIT {}",
        limit.map_or(-1, i64::from)
    );
    let mut statement = connection.prepare(&sql)?;
    let projects = statement
        .query_map([], map_project)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(projects)
}

pub fn get(connection: &Connection, id: &str) -> AppResult<Project> {
    let id = validate::id("id", id)?;
    connection
        .query_row(
            &format!("{SELECT_PROJECT} WHERE p.id = ?1"),
            [&id],
            map_project,
        )
        .optional()?
        .ok_or_else(|| AppError::not_found("Project", id))
}

pub fn create(connection: &Connection, input: &ProjectInput) -> AppResult<Project> {
    let (name, description) = validated(input)?;
    let id = clock::new_id();
    let now = clock::now();
    connection
        .execute(
            "INSERT INTO projects (id, name, description, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
            params![id, name, description, now],
        )
        .map_err(|error| {
            if is_unique_violation(&error) {
                duplicate_name(&name)
            } else {
                error.into()
            }
        })?;
    get(connection, &id)
}

pub fn update(connection: &Connection, id: &str, input: &ProjectInput) -> AppResult<Project> {
    let id = validate::id("id", id)?;
    let (name, description) = validated(input)?;
    let changed = connection
        .execute(
            "UPDATE projects SET name = ?2, description = ?3, updated_at = ?4 WHERE id = ?1",
            params![id, name, description, clock::now()],
        )
        .map_err(|error| {
            if is_unique_violation(&error) {
                duplicate_name(&name)
            } else {
                error.into()
            }
        })?;
    if changed == 0 {
        return Err(AppError::not_found("Project", id));
    }
    get(connection, &id)
}

/// Deletes a project. Its sessions, playbooks and changes are preserved and become unassigned.
pub fn delete(connection: &mut Connection, id: &str) -> AppResult<ProjectDeletion> {
    let project = get(connection, id)?;
    let transaction = connection.transaction()?;
    let deleted = transaction.execute("DELETE FROM projects WHERE id = ?1", [&project.id])?;
    if deleted == 0 {
        return Err(AppError::not_found("Project", project.id));
    }
    transaction.commit()?;
    Ok(ProjectDeletion {
        id: project.id,
        unassigned_sessions: project.session_count,
        unassigned_playbooks: project.playbook_count,
        unassigned_changes: project.change_count,
    })
}

#[tauri::command]
pub async fn list_projects(state: State<'_, AppState>) -> AppResult<Vec<Project>> {
    state.with_db(|connection| list(connection, None))
}

#[tauri::command]
pub async fn get_project(state: State<'_, AppState>, id: String) -> AppResult<Project> {
    state.with_db(|connection| get(connection, &id))
}

#[tauri::command]
pub async fn create_project(state: State<'_, AppState>, input: ProjectInput) -> AppResult<Project> {
    state.with_db(|connection| create(connection, &input))
}

#[tauri::command]
pub async fn update_project(
    state: State<'_, AppState>,
    id: String,
    input: ProjectInput,
) -> AppResult<Project> {
    state.with_db(|connection| update(connection, &id, &input))
}

#[tauri::command]
pub async fn delete_project(state: State<'_, AppState>, id: String) -> AppResult<ProjectDeletion> {
    state.with_db(|connection| delete(connection, &id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn input(name: &str, description: &str) -> ProjectInput {
        ProjectInput {
            name: name.into(),
            description: description.into(),
        }
    }

    #[test]
    fn creates_lists_and_gets_projects() {
        let connection = db::open_in_memory();
        let created = create(
            &connection,
            &input("  Core Network  ", "Routing and switching"),
        )
        .unwrap();
        assert_eq!(created.name, "Core Network");
        assert_eq!(created.description, "Routing and switching");
        assert_eq!(created.created_at, created.updated_at);
        assert_eq!(created.session_count, 0);

        let all = list(&connection, None).unwrap();
        assert_eq!(all, vec![created.clone()]);
        assert_eq!(get(&connection, &created.id).unwrap(), created);
    }

    #[test]
    fn rejects_duplicate_names_case_insensitively() {
        let connection = db::open_in_memory();
        create(&connection, &input("AWS Landing Zone", "")).unwrap();
        let error = create(&connection, &input("aws landing zone", "")).unwrap_err();
        assert_eq!(error.kind(), "conflict");
        assert_eq!(error.field(), Some("name"));
    }

    #[test]
    fn validates_input() {
        let connection = db::open_in_memory();
        assert_eq!(
            create(&connection, &input("  ", "")).unwrap_err().field(),
            Some("name")
        );
        let long = "x".repeat(121);
        assert_eq!(
            create(&connection, &input(&long, "")).unwrap_err().kind(),
            "validation"
        );
        assert_eq!(
            create(&connection, &input("Two\nlines", ""))
                .unwrap_err()
                .kind(),
            "validation"
        );
    }

    #[test]
    fn updates_and_orders_by_recent_change() {
        let connection = db::open_in_memory();
        let first = create(&connection, &input("First", "")).unwrap();
        let second = create(&connection, &input("Second", "")).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let renamed = update(&connection, &first.id, &input("First (renamed)", "Updated")).unwrap();
        assert_eq!(renamed.name, "First (renamed)");
        assert!(renamed.updated_at > renamed.created_at);
        let names: Vec<String> = list(&connection, None)
            .unwrap()
            .into_iter()
            .map(|p| p.name)
            .collect();
        assert_eq!(names, vec!["First (renamed)".to_string(), second.name]);
    }

    #[test]
    fn update_and_delete_report_missing_projects() {
        let mut connection = db::open_in_memory();
        let missing = clock::new_id();
        assert_eq!(
            update(&connection, &missing, &input("X", ""))
                .unwrap_err()
                .kind(),
            "not_found"
        );
        assert_eq!(
            delete(&mut connection, &missing).unwrap_err().kind(),
            "not_found"
        );
    }

    #[test]
    fn delete_keeps_related_records_unassigned() {
        let mut connection = db::open_in_memory();
        let project = create(&connection, &input("Firewall Migration", "")).unwrap();
        connection
            .execute(
                "INSERT INTO sessions (id, project_id, title, created_at, updated_at) VALUES ('s1', ?1, 'Policy export', 't', 't')",
                [&project.id],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO playbooks (id, project_id, title, created_at, updated_at) VALUES ('b1', ?1, 'Export policies', 't', 't')",
                [&project.id],
            )
            .unwrap();

        let result = delete(&mut connection, &project.id).unwrap();
        assert_eq!(result.unassigned_sessions, 1);
        assert_eq!(result.unassigned_playbooks, 1);
        assert_eq!(result.unassigned_changes, 0);

        let (sessions, orphaned): (i64, i64) = connection
            .query_row(
                "SELECT COUNT(*), SUM(project_id IS NULL) FROM sessions",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((sessions, orphaned), (1, 1));
        assert!(list(&connection, None).unwrap().is_empty());
    }
}
