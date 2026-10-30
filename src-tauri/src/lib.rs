//! DevTrace desktop backend.
//!
//! Layering: `features::*` expose thin Tauri commands that validate input and call plain
//! functions taking a `rusqlite::Connection`, which keeps every data operation unit-testable
//! without a running application. `storage` owns managed evidence files and `protocol` serves
//! them to the webview through the `evidence` URI scheme. `capture` owns native screen capture
//! and its visible indicators (tray icon, global shortcut). `export` renders playbooks as
//! Markdown, HTML and PDF. `integrations` holds the opt-in evidence sources (terminal logs,
//! watched configuration files). `backup` writes and restores whole-workspace backups, and
//! `dialogs` shows the system file dialogs from Rust.

#[macro_use]
mod macros;

mod backup;
mod capture;
mod clock;
mod crash;
mod db;
mod dialogs;
mod error;
mod export;
mod features;
mod integrations;
mod paths;
mod protocol;
mod state;
mod storage;
mod validate;

use std::time::Duration;

use tauri::Manager;

use crate::backup::BackupState;
use crate::capture::CaptureController;
use crate::export::ExportState;
use crate::features::{
    attachments, changes, events, overview, playbooks, projects, review, revisions, sessions,
    settings, system,
};
use crate::integrations::file_watch::{self, FileWatches};
use crate::integrations::terminal::{self, TerminalLogs};
use crate::paths::AppPaths;
use crate::state::AppState;

/// The main window starts hidden so the frontend can apply the saved theme before the first
/// paint. If the frontend fails to boot, show the window anyway after this delay.
const SHOW_WINDOW_FALLBACK: Duration = Duration::from_secs(4);

fn init_state(paths: AppPaths) -> AppState {
    let opened = paths.ensure_dirs().and_then(|()| db::open(&paths));
    match opened {
        Ok(connection) => {
            // A capture cannot survive a restart; sessions left recording return to draft.
            match sessions::recover_interrupted_captures(&connection) {
                Ok(0) => {}
                Ok(count) => {
                    eprintln!("DevTrace: {count} interrupted capture session(s) returned to draft")
                }
                Err(error) => {
                    eprintln!("DevTrace: could not recover interrupted captures: {error}")
                }
            }
            AppState::ready(connection, paths)
        }
        Err(error) => {
            eprintln!("DevTrace: local storage unavailable: {error}");
            AppState::unavailable(error.to_string(), paths)
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .register_asynchronous_uri_scheme_protocol(protocol::SCHEME, protocol::handle)
        .setup(|app| {
            let paths = AppPaths::resolve(app.handle())?;
            crash::install(
                paths.logs_dir.clone(),
                app.package_info().version.to_string(),
            );
            let state = init_state(paths);
            let shortcut = state
                .with_db(|connection| settings::load(connection))
                .map(|loaded| loaded.capture_shortcut)
                .unwrap_or_else(|_| settings::CAPTURE_SHORTCUTS[0].to_string());
            app.manage(state);
            app.manage(CaptureController::new(shortcut));
            app.manage(ExportState::default());
            app.manage(TerminalLogs::default());
            app.manage(FileWatches::default());
            app.manage(BackupState::default());

            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(SHOW_WINDOW_FALLBACK);
                if let Some(window) = handle.get_webview_window("main")
                    && !window.is_visible().unwrap_or(true)
                {
                    let _ = window.show();
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            system::get_app_info,
            system::reveal_data_directory,
            settings::get_settings,
            settings::update_settings,
            overview::get_overview,
            projects::list_projects,
            projects::get_project,
            projects::create_project,
            projects::update_project,
            projects::delete_project,
            sessions::list_sessions,
            sessions::get_session,
            sessions::create_session,
            sessions::update_session,
            sessions::update_session_notes,
            sessions::set_session_status,
            sessions::delete_session,
            events::list_events,
            events::create_event,
            events::update_event,
            events::delete_event,
            attachments::import_image,
            attachments::update_annotations,
            attachments::delete_attachment,
            review::review_events,
            review::reorder_events,
            review::redact_attachment,
            review::get_review_summary,
            review::list_review_decisions,
            review::mark_session_reviewed,
            review::reopen_session_review,
            capture::get_capture_status,
            capture::list_capture_targets,
            capture::start_capture,
            capture::set_auto_capture_enabled,
            capture::pause_capture,
            capture::resume_capture,
            capture::stop_capture,
            capture::capture_now,
            playbooks::list_playbooks,
            playbooks::get_playbook,
            playbooks::create_playbook,
            playbooks::create_playbook_from_session,
            playbooks::save_playbook,
            playbooks::set_playbook_status,
            playbooks::delete_playbook,
            revisions::get_playbook_revision,
            revisions::get_playbook_restore_point,
            revisions::restore_playbook_version,
            revisions::set_playbook_outdated,
            revisions::duplicate_playbook,
            export::export_playbook,
            export::reveal_export,
            changes::list_changes,
            changes::declare_change,
            changes::update_change,
            changes::review_change,
            changes::verify_change,
            changes::delete_change,
            terminal::start_terminal_log,
            terminal::stop_terminal_log,
            terminal::get_terminal_log,
            file_watch::watch_config_file,
            file_watch::stop_config_watch,
            file_watch::list_config_watches,
            integrations::list_integrations,
            backup::create_backup,
            backup::reveal_backup,
            backup::choose_backup,
            backup::restore_backup,
        ])
        .build(tauri::generate_context!())
        .expect("error while building DevTrace");

    app.run(|handle, event| {
        if let tauri::RunEvent::Exit = event {
            capture::shutdown(handle);
            if let Some(logs) = handle.try_state::<TerminalLogs>() {
                logs.stop_all();
            }
            if let Some(watches) = handle.try_state::<FileWatches>() {
                watches.stop_all();
            }
        }
    });
}
