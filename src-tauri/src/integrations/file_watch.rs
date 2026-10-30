//! Configuration file watching (Milestone 8, opt-in per session).
//!
//! The user picks a file in the system's file dialog (the webview can only ask for the dialog;
//! it never supplies a path). DevTrace then checks the file about once a second. When its content
//! changes and the write has settled, DevTrace records a session step with the changed lines and
//! an *observed* change record with the full before and after text, both pending review. Only
//! text files up to 1 MB are accepted, and nothing else on the computer is read.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, SystemTime};

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::clock;
use crate::dialogs;
use crate::error::{AppError, AppResult};
use crate::features::changes::{self, ChangeSource, ObservedChange};
use crate::features::events::{self, EventSource, EventType, RecordedEvent};
use crate::features::sessions;
use crate::state::AppState;
use crate::validate;

/// Broadcast with a `FileWatchStatus` when a watch starts, records a change or stops.
pub const WATCH_EVENT: &str = "file-watch";

const POLL: Duration = Duration::from_millis(1000);
const MAX_FILE_BYTES: u64 = 1024 * 1024;
const MAX_WATCHES_PER_SESSION: usize = 5;
/// Changed lines listed in the session step (the change record keeps the full text).
const MAX_DIFF_LINES: usize = 400;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileWatchStatus {
    pub id: String,
    pub session_id: String,
    pub path: String,
    pub file_name: String,
    pub started_at: String,
    pub active: bool,
    pub changes_recorded: u32,
    pub last_change_at: Option<String>,
    pub last_error: Option<String>,
}

struct ActiveWatch {
    status: Arc<Mutex<FileWatchStatus>>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

/// Managed state: the watched files of every session.
#[derive(Default)]
pub struct FileWatches {
    active: Mutex<HashMap<String, ActiveWatch>>,
}

fn snapshot(status: &Arc<Mutex<FileWatchStatus>>) -> FileWatchStatus {
    status
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone()
}

impl FileWatches {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, ActiveWatch>> {
        self.active.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn list(&self, session_id: &str) -> Vec<FileWatchStatus> {
        let mut watches: Vec<FileWatchStatus> = self
            .lock()
            .values()
            .map(|watch| snapshot(&watch.status))
            .filter(|status| status.session_id == session_id)
            .collect();
        watches.sort_by(|a, b| a.started_at.cmp(&b.started_at));
        watches
    }

    pub fn stop(&self, watch_id: &str) -> Option<FileWatchStatus> {
        let watch = self.lock().remove(watch_id)?;
        watch.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = watch.thread {
            let _ = thread.join();
        }
        let mut status = snapshot(&watch.status);
        status.active = false;
        Some(status)
    }

    /// Stops the watches of one session (deleted or completed session).
    pub fn stop_session(&self, session_id: &str) {
        for watch in self.list(session_id) {
            self.stop(&watch.id);
        }
    }

    pub fn stop_all(&self) {
        let ids: Vec<String> = self.lock().keys().cloned().collect();
        for id in ids {
            self.stop(&id);
        }
    }
}

/// Reads a text file of at most 1 MB (UTF-8, or UTF-16 with a byte order mark).
pub fn read_text(path: &Path) -> Result<String, String> {
    let metadata = std::fs::metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("it is not a file".into());
    }
    if metadata.len() > MAX_FILE_BYTES {
        return Err("it is larger than 1 MB".into());
    }
    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    let text = match bytes.as_slice() {
        [0xFF, 0xFE, rest @ ..] => {
            let (units, _) = rest.as_chunks::<2>();
            String::from_utf16_lossy(
                &units
                    .iter()
                    .map(|pair| u16::from_le_bytes(*pair))
                    .collect::<Vec<_>>(),
            )
        }
        [0xFE, 0xFF, rest @ ..] => {
            let (units, _) = rest.as_chunks::<2>();
            String::from_utf16_lossy(
                &units
                    .iter()
                    .map(|pair| u16::from_be_bytes(*pair))
                    .collect::<Vec<_>>(),
            )
        }
        [0xEF, 0xBB, 0xBF, rest @ ..] => {
            String::from_utf8(rest.to_vec()).map_err(|_| "it is not a text file".to_string())?
        }
        _ => String::from_utf8(bytes).map_err(|_| "it is not a text file".to_string())?,
    };
    if text.contains('\0') {
        return Err("it is not a text file".into());
    }
    Ok(text.replace("\r\n", "\n"))
}

/// Lines removed (`- `) and added (`+ `) between two texts, with counts. Very large files are
/// summarized without a line list.
pub fn changed_lines(before: &str, after: &str) -> (usize, usize, Vec<String>) {
    let old: Vec<&str> = before.lines().collect();
    let new: Vec<&str> = after.lines().collect();
    let (n, m) = (old.len(), new.len());
    if n.saturating_mul(m) > 4_000_000 {
        return (m, n, Vec::new());
    }
    let width = m + 1;
    let mut lcs = vec![0u32; (n + 1) * width];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lcs[i * width + j] = if old[i] == new[j] {
                lcs[(i + 1) * width + j + 1] + 1
            } else {
                lcs[(i + 1) * width + j].max(lcs[i * width + j + 1])
            };
        }
    }
    let (mut i, mut j) = (0, 0);
    let (mut added, mut removed) = (0, 0);
    let mut lines = Vec::new();
    while i < n || j < m {
        if i < n && j < m && old[i] == new[j] {
            i += 1;
            j += 1;
        } else if i < n && (j == m || lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
            // On a tie the removed line comes first, as in a conventional diff.
            removed += 1;
            lines.push(format!("- {}", old[i]));
            i += 1;
        } else {
            added += 1;
            lines.push(format!("+ {}", new[j]));
            j += 1;
        }
    }
    (added, removed, lines)
}

fn plural(count: usize, word: &str) -> String {
    format!("{count} {word}{}", if count == 1 { "" } else { "s" })
}

/// Records one observed change: a session step and a change record linked to it.
fn record_change(
    app: &AppHandle,
    status: &FileWatchStatus,
    before: &str,
    after: &str,
) -> AppResult<()> {
    let (added, removed, lines) = changed_lines(before, after);
    let summary = if lines.is_empty() && (added > 0 || removed > 0) {
        "The file changed; it is too large to list the changed lines.".to_string()
    } else {
        format!(
            "{} added, {} removed.",
            plural(added, "line"),
            plural(removed, "line")
        )
    };
    let mut listed: Vec<String> = lines.iter().take(MAX_DIFF_LINES).cloned().collect();
    if lines.len() > MAX_DIFF_LINES {
        listed.push(format!(
            "\u{2026} {} more changed lines in Change History",
            lines.len() - MAX_DIFF_LINES
        ));
    }
    let state = app.state::<AppState>();
    let title = format!("Changed: {}", status.file_name);
    state.with_db(|connection| {
        // The step and the change record are stored together or not at all.
        connection.execute_batch("SAVEPOINT observed_change")?;
        let recorded = (|| -> AppResult<()> {
            let event = events::record(
                connection,
                &status.session_id,
                &RecordedEvent {
                    event_type: EventType::Change,
                    source: EventSource::FileWatch,
                    title: &title,
                    description: &summary,
                    code: &listed.join("\n"),
                    metadata: json!({
                        "fileWatch": {
                            "watchId": status.id,
                            "path": status.path,
                            "linesAdded": added,
                            "linesRemoved": removed,
                        }
                    }),
                },
            )?;
            changes::record_observed(
                connection,
                &ObservedChange {
                    session_id: Some(status.session_id.clone()),
                    event_id: Some(event.id),
                    target: status.path.clone(),
                    summary: summary.clone(),
                    before_value: Some(before.chars().take(100_000).collect()),
                    after_value: Some(after.chars().take(100_000).collect()),
                    source: ChangeSource::FileWatch,
                },
            )?;
            Ok(())
        })();
        match recorded {
            Ok(()) => {
                connection.execute_batch("RELEASE observed_change")?;
                Ok(())
            }
            Err(error) => {
                let _ = connection
                    .execute_batch("ROLLBACK TO observed_change; RELEASE observed_change");
                Err(error)
            }
        }
    })
}

fn stamp(path: &Path) -> Option<(u64, SystemTime)> {
    let metadata = std::fs::metadata(path).ok()?;
    Some((metadata.len(), metadata.modified().ok()?))
}

/// Updates the problem shown for a watch; broadcasts only when it changed.
fn set_error(app: &AppHandle, status: &Arc<Mutex<FileWatchStatus>>, error: Option<String>) {
    let changed = {
        let mut current = status.lock().unwrap_or_else(PoisonError::into_inner);
        let changed = current.last_error != error;
        current.last_error = error;
        changed
    };
    if changed {
        let _ = app.emit(WATCH_EVENT, snapshot(status));
    }
}

fn watch(
    app: AppHandle,
    path: PathBuf,
    mut baseline: String,
    status: Arc<Mutex<FileWatchStatus>>,
    stop: Arc<AtomicBool>,
) {
    let mut seen = stamp(&path);
    let mut pending = false;
    while !stop.load(Ordering::SeqCst) {
        std::thread::sleep(POLL);
        let current = stamp(&path);
        if current.is_none() {
            // Forget the stamp so the file is read again as soon as it is back.
            seen = None;
            set_error(
                &app,
                &status,
                Some("The file is missing or cannot be read; DevTrace keeps checking.".into()),
            );
            continue;
        }
        if current != seen {
            // Wait one more check so a write in progress can finish.
            seen = current;
            pending = true;
            continue;
        }
        if !pending {
            continue;
        }
        pending = false;
        let text = match read_text(&path) {
            Ok(text) => text,
            Err(reason) => {
                set_error(
                    &app,
                    &status,
                    Some(format!("The file could not be read ({reason}).")),
                );
                continue;
            }
        };
        if text == baseline {
            set_error(&app, &status, None);
            continue;
        }
        let current_status = snapshot(&status);
        match record_change(&app, &current_status, &baseline, &text) {
            Ok(()) => {
                baseline = text;
                let mut current = status.lock().unwrap_or_else(PoisonError::into_inner);
                current.changes_recorded += 1;
                current.last_change_at = Some(clock::now());
                current.last_error = None;
            }
            Err(error) => {
                let mut current = status.lock().unwrap_or_else(PoisonError::into_inner);
                current.last_error = Some(format!("Watching stopped: {error}"));
                current.active = false;
                drop(current);
                let _ = app.emit(WATCH_EVENT, snapshot(&status));
                return;
            }
        }
        let _ = app.emit(WATCH_EVENT, snapshot(&status));
    }
}

fn pick(app: &AppHandle) -> Option<PathBuf> {
    dialogs::pick_file(
        app,
        "Choose a configuration file to watch",
        None,
        dialogs::PICK_WATCH_FILE_ENV,
    )
}

/// Lets the user pick a file and starts watching it for the session. `None` when cancelled.
pub fn start(
    app: &AppHandle,
    watches: &FileWatches,
    session_id: &str,
) -> AppResult<Option<FileWatchStatus>> {
    let session_id = validate::id("sessionId", session_id)?;
    let state = app.state::<AppState>();
    state.with_db(|connection| sessions::ensure_editable(connection, &session_id))?;
    if watches.list(&session_id).len() >= MAX_WATCHES_PER_SESSION {
        return Err(AppError::conflict(
            "fileWatch",
            "A session can watch at most 5 files. Stop watching one first.",
        ));
    }
    let Some(path) = pick(app) else {
        return Ok(None);
    };
    let path = std::path::absolute(&path)?;
    let baseline = read_text(&path).map_err(|reason| {
        AppError::validation(
            "file",
            format!("This file cannot be watched because {reason}."),
        )
    })?;
    let display = path.display().to_string();
    if watches
        .list(&session_id)
        .iter()
        .any(|watch| watch.path == display)
    {
        return Err(AppError::conflict(
            "fileWatch",
            "This file is already being watched for this session.",
        ));
    }
    let status = Arc::new(Mutex::new(FileWatchStatus {
        id: clock::new_id(),
        session_id: session_id.clone(),
        file_name: path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| display.clone()),
        path: display,
        started_at: clock::now(),
        active: true,
        changes_recorded: 0,
        last_change_at: None,
        last_error: None,
    }));
    let stop = Arc::new(AtomicBool::new(false));
    let thread = {
        let (app, path, status, stop) = (app.clone(), path.clone(), status.clone(), stop.clone());
        std::thread::spawn(move || watch(app, path, baseline, status, stop))
    };
    let current = snapshot(&status);
    watches.lock().insert(
        current.id.clone(),
        ActiveWatch {
            status,
            stop,
            thread: Some(thread),
        },
    );
    let _ = app.emit(WATCH_EVENT, &current);
    Ok(Some(current))
}

// ---------------------------------------------------------------------------------------------
// Commands

#[tauri::command]
pub async fn watch_config_file(
    app: AppHandle,
    watches: State<'_, FileWatches>,
    session_id: String,
) -> AppResult<Option<FileWatchStatus>> {
    start(&app, &watches, &session_id)
}

#[tauri::command]
pub async fn stop_config_watch(
    app: AppHandle,
    watches: State<'_, FileWatches>,
    watch_id: String,
) -> AppResult<Option<FileWatchStatus>> {
    let watch_id = validate::id("watchId", &watch_id)?;
    let stopped = watches.stop(&watch_id);
    if let Some(status) = &stopped {
        let _ = app.emit(WATCH_EVENT, status);
    }
    Ok(stopped)
}

#[tauri::command]
pub async fn list_config_watches(
    watches: State<'_, FileWatches>,
    session_id: String,
) -> AppResult<Vec<FileWatchStatus>> {
    let session_id = validate::id("sessionId", &session_id)?;
    Ok(watches.list(&session_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_added_and_removed_lines() {
        let (added, removed, lines) = changed_lines(
            "listen 80;\nroot /var/www;\n",
            "listen 8080;\nroot /var/www;\ngzip on;\n",
        );
        assert_eq!((added, removed), (2, 1));
        assert_eq!(lines, ["- listen 80;", "+ listen 8080;", "+ gzip on;"]);
        assert_eq!(changed_lines("a\nb", "a\nb"), (0, 0, Vec::new()));
    }

    #[test]
    fn reads_text_files_and_refuses_binary_or_large_ones() {
        let temp = tempfile::tempdir().unwrap();
        let text = temp.path().join("app.conf");
        std::fs::write(&text, b"\xEF\xBB\xBFkey = value\r\n").unwrap();
        assert_eq!(read_text(&text).unwrap(), "key = value\n");

        let utf16 = temp.path().join("utf16.ini");
        let mut bytes = vec![0xFF, 0xFE];
        for unit in "[core]\r\n".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        std::fs::write(&utf16, bytes).unwrap();
        assert_eq!(read_text(&utf16).unwrap(), "[core]\n");

        let binary = temp.path().join("image.bin");
        std::fs::write(&binary, [0x89, b'P', 0, 0xFF]).unwrap();
        assert!(read_text(&binary).unwrap_err().contains("not a text file"));

        let large = temp.path().join("large.log");
        std::fs::write(&large, vec![b'a'; (MAX_FILE_BYTES + 1) as usize]).unwrap();
        assert!(read_text(&large).unwrap_err().contains("1 MB"));
        assert!(read_text(temp.path()).unwrap_err().contains("not a file"));
    }
}
