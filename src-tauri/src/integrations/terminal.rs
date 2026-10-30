//! Terminal logging (Milestone 8, opt-in per session).
//!
//! DevTrace creates an empty log file inside the workspace and shows how to make a terminal
//! write to it (for example PowerShell's `Start-Transcript`). The user starts and stops that in
//! their own terminal; DevTrace never runs commands. While logging is on, a background thread
//! reads what was appended about twice a second and records commands and output as session steps
//! (pending review). Logging stops when the user stops it, when the session can no longer be
//! changed, or when DevTrace exits.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::clock;
use crate::error::{AppError, AppResult};
use crate::features::events::{self, EventSource, EventType, RecordedEvent};
use crate::features::sessions;
use crate::integrations::tail::TailReader;
use crate::integrations::transcript::{LogEntry, PlainLog, PowerShellTranscript, TranscriptParser};
use crate::state::AppState;
use crate::storage;
use crate::validate;

/// Broadcast with a `TerminalLogStatus` whenever a log starts, records steps or stops.
pub const LOG_EVENT: &str = "terminal-log";

const POLL: Duration = Duration::from_millis(500);
/// Buffered output is recorded after this long without new lines.
const QUIET: Duration = Duration::from_millis(2500);

text_enum! {
    /// How the log file is interpreted (one parser adapter per format).
    pub enum LogFormat {
        /// PowerShell `Start-Transcript` output: commands paired with their output.
        Powershell => "powershell",
        /// Any other text log (PuTTY, `tee`…): output grouped between quiet periods.
        Plain => "plain",
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalLogStatus {
    pub session_id: String,
    pub log_id: String,
    pub format: LogFormat,
    /// Absolute path of the log file to write to (inside the workspace).
    pub path: String,
    pub started_at: String,
    pub active: bool,
    pub steps_recorded: u32,
    pub bytes_read: u64,
    pub last_error: Option<String>,
}

struct ActiveLog {
    status: Arc<Mutex<TerminalLogStatus>>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

/// Managed state: at most one terminal log per session.
#[derive(Default)]
pub struct TerminalLogs {
    active: Mutex<HashMap<String, ActiveLog>>,
}

fn snapshot(status: &Arc<Mutex<TerminalLogStatus>>) -> TerminalLogStatus {
    status
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone()
}

impl TerminalLogs {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, ActiveLog>> {
        self.active.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn status(&self, session_id: &str) -> Option<TerminalLogStatus> {
        self.lock().get(session_id).map(|log| snapshot(&log.status))
    }

    /// Stops the log of a session (if any) and waits for its last steps to be recorded.
    pub fn stop(&self, session_id: &str) -> Option<TerminalLogStatus> {
        let log = self.lock().remove(session_id)?;
        log.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = log.thread {
            let _ = thread.join();
        }
        let mut status = snapshot(&log.status);
        status.active = false;
        Some(status)
    }

    /// Stops every log (application exit).
    pub fn stop_all(&self) {
        let sessions: Vec<String> = self.lock().keys().cloned().collect();
        for session in sessions {
            self.stop(&session);
        }
    }
}

/// Folder holding the log files of one session.
pub fn session_folder(logs_dir: &Path, session_id: &str) -> AppResult<PathBuf> {
    storage::resolve_contained(logs_dir, session_id)
}

/// The step recorded for one log entry.
fn recorded(
    entry: &LogEntry,
    log: &TerminalLogStatus,
) -> (EventType, String, String, serde_json::Value) {
    let masked = |text: &str| text.contains("********");
    match entry {
        LogEntry::Command { command, output } => {
            let output_text = output.join("\n");
            let metadata = json!({
                "terminal": {
                    "logId": log.log_id,
                    "format": log.format,
                    "output": output_text.chars().take(20_000).collect::<String>(),
                    "outputLines": output.len(),
                    "masked": masked(command) || masked(&output_text),
                }
            });
            (
                EventType::Command,
                command.clone(),
                command.clone(),
                metadata,
            )
        }
        LogEntry::Output { lines } => {
            let text = lines.join("\n");
            let title = format!(
                "Terminal output ({} line{})",
                lines.len(),
                if lines.len() == 1 { "" } else { "s" }
            );
            let metadata = json!({
                "terminal": {
                    "logId": log.log_id,
                    "format": log.format,
                    "outputLines": lines.len(),
                    "masked": masked(&text),
                }
            });
            (EventType::Log, title, text, metadata)
        }
    }
}

/// Records entries as session steps. Returns an error message when the session can no longer
/// be changed (logging then stops).
fn record_entries(
    app: &AppHandle,
    status: &Arc<Mutex<TerminalLogStatus>>,
    entries: Vec<LogEntry>,
) -> Result<(), String> {
    if entries.is_empty() {
        return Ok(());
    }
    let current = snapshot(status);
    let state = app.state::<AppState>();
    for entry in entries {
        let (event_type, title, code, metadata) = recorded(&entry, &current);
        let result = state.with_db(|connection| {
            events::record(
                connection,
                &current.session_id,
                &RecordedEvent {
                    event_type,
                    source: EventSource::Terminal,
                    title: &title,
                    description: "",
                    code: &code,
                    metadata,
                },
            )
        });
        match result {
            Ok(_) => {
                status
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .steps_recorded += 1;
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    let _ = app.emit(LOG_EVENT, snapshot(status));
    Ok(())
}

fn watch(
    app: AppHandle,
    path: PathBuf,
    status: Arc<Mutex<TerminalLogStatus>>,
    stop: Arc<AtomicBool>,
) {
    let format = snapshot(&status).format;
    let mut parser: Box<dyn TranscriptParser> = match format {
        LogFormat::Powershell => Box::new(PowerShellTranscript::default()),
        LogFormat::Plain => Box::new(PlainLog::default()),
    };
    let mut reader = TailReader::new(&path);
    let mut last_line = Instant::now();
    let mut buffered = false;
    loop {
        let stopping = stop.load(Ordering::SeqCst);
        let mut entries = Vec::new();
        match reader.read_lines() {
            Ok(lines) => {
                if !lines.is_empty() {
                    last_line = Instant::now();
                    buffered = true;
                }
                for line in &lines {
                    entries.extend(parser.push_line(line));
                }
                let mut current = status.lock().unwrap_or_else(PoisonError::into_inner);
                current.bytes_read = reader.offset();
                current.last_error = None;
            }
            Err(error) => {
                status
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .last_error = Some(format!("The log file could not be read: {error}"));
            }
        }
        if stopping {
            if let Some(rest) = reader.take_partial() {
                entries.extend(parser.push_line(&rest));
            }
            entries.extend(parser.flush());
        } else if buffered && last_line.elapsed() >= QUIET {
            entries.extend(parser.flush());
            buffered = false;
        }
        if let Err(message) = record_entries(&app, &status, entries) {
            let mut current = status.lock().unwrap_or_else(PoisonError::into_inner);
            current.last_error = Some(format!("Terminal logging stopped: {message}"));
            current.active = false;
            drop(current);
            let _ = app.emit(LOG_EVENT, snapshot(&status));
            return;
        }
        if stopping {
            return;
        }
        std::thread::sleep(POLL);
    }
}

/// Creates the log file and starts reading it.
pub fn start(
    app: &AppHandle,
    logs: &TerminalLogs,
    session_id: &str,
    format: LogFormat,
) -> AppResult<TerminalLogStatus> {
    let session_id = validate::id("sessionId", session_id)?;
    let state = app.state::<AppState>();
    state.with_db(|connection| sessions::ensure_editable(connection, &session_id))?;
    if let Some(existing) = logs.status(&session_id)
        && existing.active
    {
        return Err(AppError::conflict(
            "terminalLog",
            "Terminal logging is already on for this session.",
        ));
    }
    logs.stop(&session_id);
    let log_id = clock::new_id();
    let folder = session_folder(&state.paths.terminal_logs_dir, &session_id)?;
    std::fs::create_dir_all(&folder)?;
    let path = std::path::absolute(folder.join(format!("{log_id}.log")))?;
    std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&path)?;
    let status = Arc::new(Mutex::new(TerminalLogStatus {
        session_id: session_id.clone(),
        log_id,
        format,
        path: path.display().to_string(),
        started_at: clock::now(),
        active: true,
        steps_recorded: 0,
        bytes_read: 0,
        last_error: None,
    }));
    let stop = Arc::new(AtomicBool::new(false));
    let thread = {
        let (app, path, status, stop) = (app.clone(), path.clone(), status.clone(), stop.clone());
        std::thread::spawn(move || watch(app, path, status, stop))
    };
    let current = snapshot(&status);
    logs.lock().insert(
        session_id,
        ActiveLog {
            status,
            stop,
            thread: Some(thread),
        },
    );
    let _ = app.emit(LOG_EVENT, &current);
    Ok(current)
}

// ---------------------------------------------------------------------------------------------
// Commands

#[tauri::command]
pub async fn start_terminal_log(
    app: AppHandle,
    logs: State<'_, TerminalLogs>,
    session_id: String,
    format: LogFormat,
) -> AppResult<TerminalLogStatus> {
    start(&app, &logs, &session_id, format)
}

#[tauri::command]
pub async fn stop_terminal_log(
    app: AppHandle,
    logs: State<'_, TerminalLogs>,
    session_id: String,
) -> AppResult<Option<TerminalLogStatus>> {
    let session_id = validate::id("sessionId", &session_id)?;
    let stopped = logs.stop(&session_id);
    if let Some(status) = &stopped {
        let _ = app.emit(LOG_EVENT, status);
    }
    Ok(stopped)
}

#[tauri::command]
pub async fn get_terminal_log(
    logs: State<'_, TerminalLogs>,
    session_id: String,
) -> AppResult<Option<TerminalLogStatus>> {
    let session_id = validate::id("sessionId", &session_id)?;
    Ok(logs.status(&session_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(format: LogFormat) -> TerminalLogStatus {
        TerminalLogStatus {
            session_id: "s".into(),
            log_id: "l".into(),
            format,
            path: "p".into(),
            started_at: "t".into(),
            active: true,
            steps_recorded: 0,
            bytes_read: 0,
            last_error: None,
        }
    }

    #[test]
    fn commands_become_command_steps_with_their_output_as_metadata() {
        let (event_type, title, code, metadata) = recorded(
            &LogEntry::Command {
                command: "Get-Service sshd".into(),
                output: vec!["Running  sshd".into()],
            },
            &status(LogFormat::Powershell),
        );
        assert_eq!(event_type, EventType::Command);
        assert_eq!(
            (title.as_str(), code.as_str()),
            ("Get-Service sshd", "Get-Service sshd")
        );
        assert_eq!(metadata["terminal"]["output"], "Running  sshd");
        assert_eq!(metadata["terminal"]["format"], "powershell");
        assert_eq!(metadata["terminal"]["masked"], false);
    }

    #[test]
    fn output_becomes_log_steps_and_masking_is_flagged() {
        let (event_type, title, code, metadata) = recorded(
            &LogEntry::Output {
                lines: vec!["password=********".into(), "ok".into()],
            },
            &status(LogFormat::Plain),
        );
        assert_eq!(event_type, EventType::Log);
        assert_eq!(title, "Terminal output (2 lines)");
        assert_eq!(code, "password=********\nok");
        assert_eq!(metadata["terminal"]["masked"], true);
    }
}
