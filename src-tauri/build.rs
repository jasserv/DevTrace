//! Build script: Tauri code generation plus the application's command permissions.
//!
//! Listing every command in the app manifest makes Tauri generate an `allow-<command>`
//! permission for each one and deny any command that no capability allows. The `main-window`
//! capability (`capabilities/default.json`) allows exactly these commands for the main window
//! only; other windows (the hidden PDF printing window) get none. `npm run lint` checks that this
//! list, the handlers registered in `src/lib.rs` and the capability stay identical
//! (`scripts/check-permissions.mjs`).

const COMMANDS: &[&str] = &[
    "get_app_info",
    "reveal_data_directory",
    "get_settings",
    "update_settings",
    "get_overview",
    "list_projects",
    "get_project",
    "create_project",
    "update_project",
    "delete_project",
    "list_sessions",
    "get_session",
    "create_session",
    "update_session",
    "update_session_notes",
    "set_session_status",
    "delete_session",
    "list_events",
    "create_event",
    "update_event",
    "delete_event",
    "import_image",
    "update_annotations",
    "delete_attachment",
    "review_events",
    "reorder_events",
    "redact_attachment",
    "get_review_summary",
    "list_review_decisions",
    "mark_session_reviewed",
    "reopen_session_review",
    "get_capture_status",
    "list_capture_targets",
    "start_capture",
    "set_auto_capture_enabled",
    "pause_capture",
    "resume_capture",
    "stop_capture",
    "capture_now",
    "list_playbooks",
    "get_playbook",
    "create_playbook",
    "create_playbook_from_session",
    "save_playbook",
    "set_playbook_status",
    "delete_playbook",
    "get_playbook_revision",
    "get_playbook_restore_point",
    "restore_playbook_version",
    "set_playbook_outdated",
    "duplicate_playbook",
    "export_playbook",
    "reveal_export",
    "list_changes",
    "declare_change",
    "update_change",
    "review_change",
    "verify_change",
    "delete_change",
    "start_terminal_log",
    "stop_terminal_log",
    "get_terminal_log",
    "watch_config_file",
    "stop_config_watch",
    "list_config_watches",
    "list_integrations",
    "create_backup",
    "reveal_backup",
    "choose_backup",
    "restore_backup",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
