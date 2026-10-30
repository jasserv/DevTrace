//! Native capture: explicit, visible, user-controlled screenshots of one display or window.
//!
//! * The user starts a capture for a draft session and a chosen target. Nothing is captured
//!   until the user presses Capture now, the global shortcut, or the tray menu item.
//! * While a capture is active, the state is always visible: sidebar and capture bar in the
//!   app, a tray icon with a status dot outside it.
//! * No keystrokes, clicks or other input are monitored.
//!
//! The controller keeps the live state in memory; the session row records `recording` /
//! `paused` so other screens show it, and sessions left in those states by a crash are returned
//! to draft at startup (`sessions::recover_interrupted_captures`).

pub mod auto;
pub mod indicator;
pub mod screen;
#[cfg(windows)]
mod win_window;

use std::sync::{Mutex, MutexGuard, PoisonError};

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

use crate::clock;
use crate::error::{AppError, AppResult};
use crate::features::attachments::{self, AttachmentSource, ImportRequest};
use crate::features::events;
use crate::features::sessions::{self, SessionStatus};
use crate::state::AppState;
use crate::validate;

/// Broadcast with a `CaptureStatus` payload after every state change.
pub const STATUS_EVENT: &str = "capture-status";
/// Broadcast with a `CapturedShot` payload after each stored screenshot.
pub const CAPTURED_EVENT: &str = "capture-captured";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureState {
    Idle,
    Recording,
    Paused,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureTargetKind {
    Monitor,
    Window,
}

/// What asked for a screenshot. Recorded on the event so evidence stays traceable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureTrigger {
    Button,
    Shortcut,
    Tray,
    /// Automatic capture after the screen changed and settled (opt-in).
    Auto,
}

/// A display or an application window that can be captured.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureTarget {
    /// `monitor:<id>` or `window:<id>`; only valid while the display or window exists.
    pub id: String,
    pub kind: CaptureTargetKind,
    pub title: String,
    /// Application name for windows, monitor model for displays.
    pub app_name: String,
    pub width: u32,
    pub height: u32,
    pub primary: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStatus {
    pub state: CaptureState,
    pub session_id: Option<String>,
    pub session_title: Option<String>,
    pub target: Option<CaptureTarget>,
    pub started_at: Option<String>,
    pub capture_count: u32,
    pub last_capture_at: Option<String>,
    pub shortcut: String,
    pub shortcut_active: bool,
    pub shortcut_error: Option<String>,
    pub supported: bool,
    pub unsupported_reason: Option<String>,
    pub last_error: Option<String>,
    /// Automatic capture after screen changes is on for this capture.
    pub auto_capture: bool,
}

impl CaptureStatus {
    pub fn idle(shortcut: String) -> Self {
        Self {
            state: CaptureState::Idle,
            session_id: None,
            session_title: None,
            target: None,
            started_at: None,
            capture_count: 0,
            last_capture_at: None,
            shortcut,
            shortcut_active: false,
            shortcut_error: None,
            supported: screen::SUPPORTED,
            unsupported_reason: (!screen::SUPPORTED)
                .then(|| screen::UNSUPPORTED_REASON.to_string()),
            last_error: None,
            auto_capture: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturedShot {
    pub session_id: String,
    pub event_id: String,
    pub attachment_id: String,
    pub trigger: CaptureTrigger,
}

/// A rectangle inside an image, in pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Crop {
    pub left: u32,
    pub top: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone)]
struct ActiveCapture {
    session_id: String,
    session_title: String,
    target: CaptureTarget,
    paused: bool,
    started_at: String,
    capture_count: u32,
    last_capture_at: Option<String>,
    auto: bool,
    /// Distinguishes captures, so a sampler from an earlier capture never acts on a new one.
    generation: u64,
}

/// The capture state machine. Pure data, so every transition is unit-tested without a window.
#[derive(Debug, Default)]
struct Inner {
    active: Option<ActiveCapture>,
    /// Configured shortcut (from settings).
    shortcut: String,
    /// The shortcut currently registered with the operating system, if any.
    registered_shortcut: Option<String>,
    shortcut_error: Option<String>,
    last_error: Option<String>,
    taking_screenshot: bool,
    generations: u64,
}

fn no_capture() -> AppError {
    AppError::conflict("capture", "No capture is running. Start a capture first.")
}

impl Inner {
    fn status(&self) -> CaptureStatus {
        let mut status = CaptureStatus::idle(self.shortcut.clone());
        status.shortcut_error = self.shortcut_error.clone();
        status.last_error = self.last_error.clone();
        if let Some(active) = &self.active {
            status.state = if active.paused {
                CaptureState::Paused
            } else {
                CaptureState::Recording
            };
            status.session_id = Some(active.session_id.clone());
            status.session_title = Some(active.session_title.clone());
            status.target = Some(active.target.clone());
            status.started_at = Some(active.started_at.clone());
            status.capture_count = active.capture_count;
            status.last_capture_at = active.last_capture_at.clone();
            status.shortcut_active = self.registered_shortcut.is_some();
            status.auto_capture = active.auto;
        }
        status
    }

    fn ensure_idle(&self) -> AppResult<()> {
        match &self.active {
            Some(active) => Err(AppError::conflict(
                "capture",
                format!(
                    "A capture is already running for \"{}\". Stop it before starting another.",
                    active.session_title
                ),
            )),
            None => Ok(()),
        }
    }

    fn begin(
        &mut self,
        session_id: String,
        session_title: String,
        target: CaptureTarget,
        now: String,
    ) -> AppResult<u64> {
        self.ensure_idle()?;
        self.generations += 1;
        self.active = Some(ActiveCapture {
            session_id,
            session_title,
            target,
            paused: false,
            started_at: now,
            capture_count: 0,
            last_capture_at: None,
            auto: false,
            generation: self.generations,
        });
        self.last_error = None;
        Ok(self.generations)
    }

    /// Switches automatic capture on or off for the active capture.
    fn set_auto(&mut self, enabled: bool) -> AppResult<()> {
        let active = self.active.as_mut().ok_or_else(no_capture)?;
        active.auto = enabled;
        Ok(())
    }

    /// What the automatic sampler should do for capture `generation`: `None` when that capture
    /// ended, otherwise whether to sample now (recording with automatic capture on) and the target.
    fn sampling(&self, generation: u64) -> Option<(bool, CaptureTarget)> {
        let active = self
            .active
            .as_ref()
            .filter(|active| active.generation == generation)?;
        Some((
            active.auto && !active.paused && !self.taking_screenshot,
            active.target.clone(),
        ))
    }

    /// Returns the session whose capture would change, without changing anything yet.
    fn check_pause(&self, paused: bool) -> AppResult<String> {
        let active = self.active.as_ref().ok_or_else(no_capture)?;
        if active.paused == paused {
            return Err(AppError::conflict(
                "capture",
                if paused {
                    "The capture is already paused."
                } else {
                    "The capture is already recording."
                },
            ));
        }
        Ok(active.session_id.clone())
    }

    fn set_paused(&mut self, paused: bool) -> AppResult<()> {
        self.check_pause(paused)?;
        if let Some(active) = self.active.as_mut() {
            active.paused = paused;
        }
        self.last_error = None;
        Ok(())
    }

    fn end(&mut self) -> AppResult<ActiveCapture> {
        let active = self.active.take().ok_or_else(no_capture)?;
        self.last_error = None;
        Ok(active)
    }

    /// Reserves the right to take one screenshot. Screenshots never overlap.
    fn claim_shot(&mut self) -> AppResult<(String, CaptureTarget)> {
        let active = self.active.as_ref().ok_or_else(no_capture)?;
        if active.paused {
            return Err(AppError::conflict(
                "capture",
                "Capture is paused. Resume to take screenshots.",
            ));
        }
        if self.taking_screenshot {
            return Err(AppError::conflict(
                "capture",
                "A screenshot is already being taken.",
            ));
        }
        self.taking_screenshot = true;
        Ok((active.session_id.clone(), active.target.clone()))
    }

    /// Records the outcome of a claimed screenshot. A capture stopped in the meantime is left
    /// alone; the screenshot itself was still stored in its session.
    fn finish_shot(&mut self, session_id: &str, outcome: Result<String, String>) {
        self.taking_screenshot = false;
        match outcome {
            Ok(now) => {
                self.last_error = None;
                if let Some(active) = self
                    .active
                    .as_mut()
                    .filter(|active| active.session_id == session_id)
                {
                    active.capture_count += 1;
                    active.last_capture_at = Some(now);
                }
            }
            Err(message) => self.last_error = Some(message),
        }
    }
}

/// Managed state for native capture.
pub struct CaptureController {
    inner: Mutex<Inner>,
    /// Serializes start, pause, resume and stop so their database and OS side effects never
    /// interleave.
    control: tauri::async_runtime::Mutex<()>,
    tray: Mutex<Option<indicator::TrayItems>>,
}

impl CaptureController {
    pub fn new(shortcut: String) -> Self {
        Self {
            inner: Mutex::new(Inner {
                shortcut,
                ..Inner::default()
            }),
            control: tauri::async_runtime::Mutex::new(()),
            tray: Mutex::new(None),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        // The state stays consistent even if a holder panicked: every update is a single step.
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn status(&self) -> CaptureStatus {
        self.lock().status()
    }
}

fn controller(app: &AppHandle) -> tauri::State<'_, CaptureController> {
    app.state::<CaptureController>()
}

/// Updates the tray, broadcasts the status to the webview and returns it.
fn publish(app: &AppHandle) -> CaptureStatus {
    let controller = controller(app);
    let status = controller.status();
    {
        let mut tray = controller
            .tray
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        indicator::sync_tray(app, &mut tray, &status);
    }
    if let Err(error) = app.emit(STATUS_EVENT, &status) {
        eprintln!("DevTrace: could not broadcast the capture status: {error}");
    }
    status
}

/// Registers `desired` as the capture shortcut (or none), replacing any previous one.
/// Never called while holding the state lock: registration runs on the main thread.
fn apply_shortcut(app: &AppHandle, desired: Option<String>) {
    let controller = controller(app);
    let previous = controller.lock().registered_shortcut.take();
    if let Some(previous) = previous {
        indicator::unregister_shortcut(app, &previous);
    }
    let (registered, error) = match desired {
        None => (None, None),
        Some(shortcut) => match indicator::register_shortcut(app, &shortcut) {
            Ok(()) => (Some(shortcut), None),
            Err(message) => (None, Some(message)),
        },
    };
    let mut inner = controller.lock();
    inner.registered_shortcut = registered;
    inner.shortcut_error = error;
}

async fn blocking<T: Send + 'static>(
    task: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| AppError::internal(format!("A background capture task failed: {error}")))?
}

pub(crate) async fn start(
    app: &AppHandle,
    session_id: &str,
    target_id: String,
    auto: bool,
) -> AppResult<CaptureStatus> {
    let session_id = validate::id("sessionId", session_id)?;
    let controller = controller(app);
    let _control = controller.control.lock().await;
    controller.lock().ensure_idle()?;
    let target = blocking(move || screen::find_target(&target_id)).await?;
    let title = app.state::<AppState>().with_db(|connection| {
        sessions::set_capture_status(connection, &session_id, SessionStatus::Recording)?;
        Ok(sessions::get(connection, &session_id)?.summary.title)
    })?;
    let (shortcut, generation) = {
        let mut inner = controller.lock();
        let generation = inner.begin(session_id, title, target, clock::now())?;
        inner.set_auto(auto)?;
        (inner.shortcut.clone(), generation)
    };
    apply_shortcut(app, Some(shortcut));
    indicator::exclude_main_window_from_capture(app, true);
    spawn_sampler(app.clone(), generation);
    Ok(publish(app))
}

/// Switches automatic capture after screen changes on or off for the running capture.
pub(crate) async fn set_auto_capture(app: &AppHandle, enabled: bool) -> AppResult<CaptureStatus> {
    let controller = controller(app);
    let _control = controller.control.lock().await;
    {
        let mut inner = controller.lock();
        inner.set_auto(enabled)?;
        inner.last_error = None;
    }
    Ok(publish(app))
}

/// Automatic screenshots that may fail in a row before automatic capture switches itself off.
const AUTO_FAILURE_LIMIT: u32 = 3;

/// Samples the target while capture `generation` runs with automatic capture on, and takes a
/// screenshot when the screen changed and settled. Ends with the capture.
fn spawn_sampler(app: AppHandle, generation: u64) {
    std::thread::spawn(move || {
        let mut detector = auto::ChangeDetector::default();
        let mut failures = 0u32;
        loop {
            std::thread::sleep(auto::SAMPLE_INTERVAL);
            let Some(state) = app.try_state::<CaptureController>() else {
                return;
            };
            let Some((sample_now, target)) = state.lock().sampling(generation) else {
                return;
            };
            if !sample_now {
                // Paused or switched off: start from a fresh baseline afterwards.
                detector.reset();
                failures = 0;
                continue;
            }
            let outcome = screen::capture_sample(&target).and_then(|sample| {
                let now = std::time::Instant::now();
                if !detector.observe(&sample, now) {
                    return Ok(());
                }
                tauri::async_runtime::block_on(take_screenshot(&app, CaptureTrigger::Auto))?;
                detector.taken(&sample, now);
                Ok(())
            });
            match outcome {
                Ok(()) => failures = 0,
                Err(error) => {
                    failures += 1;
                    if failures >= AUTO_FAILURE_LIMIT {
                        {
                            let mut inner = state.lock();
                            if inner.sampling(generation).is_none() {
                                return;
                            }
                            let _ = inner.set_auto(false);
                            inner.last_error = Some(format!(
                                "Automatic capture was switched off after repeated failures: {error}"
                            ));
                        }
                        publish(&app);
                        detector.reset();
                        failures = 0;
                    }
                }
            }
        }
    });
}

pub(crate) async fn set_paused(app: &AppHandle, paused: bool) -> AppResult<CaptureStatus> {
    let controller = controller(app);
    let _control = controller.control.lock().await;
    let session_id = controller.lock().check_pause(paused)?;
    let status = if paused {
        SessionStatus::Paused
    } else {
        SessionStatus::Recording
    };
    app.state::<AppState>()
        .with_db(|connection| sessions::set_capture_status(connection, &session_id, status))?;
    controller.lock().set_paused(paused)?;
    Ok(publish(app))
}

pub(crate) async fn toggle_pause(app: &AppHandle) -> AppResult<CaptureStatus> {
    let paused = controller(app).status().state == CaptureState::Paused;
    set_paused(app, !paused).await
}

pub(crate) async fn stop(app: &AppHandle) -> AppResult<CaptureStatus> {
    let controller = controller(app);
    let _control = controller.control.lock().await;
    let ended = controller.lock().end()?;
    // The capture ends even if the session row cannot be updated; startup recovery repairs it.
    if let Err(error) = app.state::<AppState>().with_db(|connection| {
        sessions::set_capture_status(connection, &ended.session_id, SessionStatus::Draft)
    }) {
        eprintln!("DevTrace: could not return the captured session to draft: {error}");
    }
    apply_shortcut(app, None);
    indicator::exclude_main_window_from_capture(app, false);
    Ok(publish(app))
}

/// Ends an active capture when the application exits.
pub fn shutdown(app: &AppHandle) {
    let Some(controller) = app.try_state::<CaptureController>() else {
        return;
    };
    let ended = controller.lock().end();
    if let (Ok(ended), Some(state)) = (ended, app.try_state::<AppState>()) {
        let _ = state.with_db(|connection| {
            sessions::set_capture_status(connection, &ended.session_id, SessionStatus::Draft)
        });
    }
}

/// Applies a changed shortcut setting; re-registers it immediately if a capture is active.
pub(crate) fn shortcut_changed(app: &AppHandle, shortcut: &str) {
    let controller = controller(app);
    let active = {
        let mut inner = controller.lock();
        if inner.shortcut == shortcut {
            return;
        }
        inner.shortcut = shortcut.to_string();
        inner.active.is_some()
    };
    if active {
        apply_shortcut(app, Some(shortcut.to_string()));
    }
    publish(app);
}

fn file_stamp(now: &str) -> String {
    now.chars().filter(char::is_ascii_digit).take(14).collect()
}

/// The import request for a captured screenshot, with the target and trigger as metadata.
fn capture_request(
    session_id: &str,
    target: &CaptureTarget,
    trigger: CaptureTrigger,
    now: &str,
) -> ImportRequest {
    let title = attachments::truncate_chars(
        &attachments::clean_line(&format!("Screenshot of {}", target.title)),
        events::TITLE_RULE.max_chars,
    );
    let metadata = json!({
        "capture": {
            "trigger": trigger,
            "capturedAt": now,
            "target": {
                "kind": target.kind,
                "title": target.title,
                "appName": target.app_name,
                "width": target.width,
                "height": target.height,
            }
        }
    });
    ImportRequest {
        session_id: session_id.to_string(),
        event_id: None,
        title,
        original_name: format!("capture-{}.png", file_stamp(now)),
        source: AttachmentSource::Capture,
        metadata: metadata.to_string(),
    }
}

fn store_screenshot(
    app: &AppHandle,
    session_id: &str,
    target: &CaptureTarget,
    trigger: CaptureTrigger,
) -> AppResult<CapturedShot> {
    let png = screen::capture_png(target)?;
    let request = capture_request(session_id, target, trigger, &clock::now());
    let imported = attachments::import_with_state(&app.state::<AppState>(), &request, &png)?;
    Ok(CapturedShot {
        session_id: session_id.to_string(),
        event_id: imported.event.id,
        attachment_id: imported.attachment_id,
        trigger,
    })
}

/// Takes one screenshot of the active target and stores it as a new screenshot event.
/// Failures from the shortcut or tray are shown through `last_error`, since no dialog is open.
pub(crate) async fn take_screenshot(
    app: &AppHandle,
    trigger: CaptureTrigger,
) -> AppResult<CapturedShot> {
    let controller = controller(app);
    let claimed = controller.lock().claim_shot();
    let (session_id, target) = match claimed {
        Ok(claimed) => claimed,
        Err(error) => {
            // Automatic screenshots report repeated failures themselves (see `spawn_sampler`);
            // one refused because the capture was just paused or stopped is not a problem.
            if !matches!(trigger, CaptureTrigger::Button | CaptureTrigger::Auto)
                && controller.lock().active.is_some()
            {
                controller.lock().last_error = Some(error.to_string());
                publish(app);
            }
            return Err(error);
        }
    };
    let handle = app.clone();
    let owner = session_id.clone();
    let result = blocking(move || store_screenshot(&handle, &owner, &target, trigger)).await;
    let outcome = match &result {
        Ok(_) => Ok(clock::now()),
        Err(error) => Err(error.to_string()),
    };
    controller.lock().finish_shot(&session_id, outcome);
    publish(app);
    if let Ok(shot) = &result
        && let Err(error) = app.emit(CAPTURED_EVENT, shot)
    {
        eprintln!("DevTrace: could not broadcast the captured screenshot: {error}");
    }
    result
}

#[tauri::command]
pub async fn get_capture_status(app: AppHandle) -> AppResult<CaptureStatus> {
    Ok(controller(&app).status())
}

#[tauri::command]
pub async fn list_capture_targets() -> AppResult<Vec<CaptureTarget>> {
    blocking(screen::list_targets).await
}

#[tauri::command]
pub async fn start_capture(
    app: AppHandle,
    session_id: String,
    target_id: String,
    auto_capture: Option<bool>,
) -> AppResult<CaptureStatus> {
    start(&app, &session_id, target_id, auto_capture.unwrap_or(false)).await
}

#[tauri::command]
pub async fn set_auto_capture_enabled(app: AppHandle, enabled: bool) -> AppResult<CaptureStatus> {
    set_auto_capture(&app, enabled).await
}

#[tauri::command]
pub async fn pause_capture(app: AppHandle) -> AppResult<CaptureStatus> {
    set_paused(&app, true).await
}

#[tauri::command]
pub async fn resume_capture(app: AppHandle) -> AppResult<CaptureStatus> {
    set_paused(&app, false).await
}

#[tauri::command]
pub async fn stop_capture(app: AppHandle) -> AppResult<CaptureStatus> {
    stop(&app).await
}

#[tauri::command]
pub async fn capture_now(app: AppHandle) -> AppResult<CapturedShot> {
    take_screenshot(&app, CaptureTrigger::Button).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::features::events::EventSource;
    use crate::features::sessions::SessionInput;
    use crate::storage::test_images;

    fn target() -> CaptureTarget {
        CaptureTarget {
            id: "window:42".into(),
            kind: CaptureTargetKind::Window,
            title: "Router admin\n- Edge".into(),
            app_name: "Microsoft Edge".into(),
            width: 1280,
            height: 800,
            primary: false,
        }
    }

    fn recording() -> Inner {
        let mut inner = Inner {
            shortcut: "Ctrl+Alt+Shift+S".into(),
            ..Inner::default()
        };
        inner
            .begin(
                "s1".into(),
                "Firewall change".into(),
                target(),
                "2026-10-23T05:00:00.000Z".into(),
            )
            .unwrap();
        inner
    }

    #[test]
    fn idle_status_reports_support_and_shortcut() {
        let status = Inner {
            shortcut: "Pause".into(),
            ..Inner::default()
        }
        .status();
        assert_eq!(status.state, CaptureState::Idle);
        assert_eq!(status.shortcut, "Pause");
        assert!(!status.shortcut_active);
        assert_eq!(status.supported, screen::SUPPORTED);
        assert_eq!(status.unsupported_reason.is_none(), screen::SUPPORTED);
        assert!(status.session_id.is_none() && status.target.is_none());
    }

    #[test]
    fn walks_through_start_pause_resume_and_stop() {
        let mut inner = recording();
        let status = inner.status();
        assert_eq!(status.state, CaptureState::Recording);
        assert_eq!(status.session_id.as_deref(), Some("s1"));
        assert_eq!(
            status.started_at.as_deref(),
            Some("2026-10-23T05:00:00.000Z")
        );

        let second = inner.begin("s2".into(), "Other".into(), target(), "now".into());
        assert!(
            second
                .unwrap_err()
                .to_string()
                .contains("already running for \"Firewall change\"")
        );

        assert_eq!(inner.check_pause(true).unwrap(), "s1");
        inner.set_paused(true).unwrap();
        assert_eq!(inner.status().state, CaptureState::Paused);
        assert!(inner.set_paused(true).is_err());
        inner.set_paused(false).unwrap();
        assert_eq!(inner.status().state, CaptureState::Recording);

        let ended = inner.end().unwrap();
        assert_eq!(ended.session_id, "s1");
        assert_eq!(inner.status().state, CaptureState::Idle);
        assert!(inner.end().is_err());
        assert!(inner.check_pause(true).is_err());
    }

    #[test]
    fn screenshots_require_recording_and_never_overlap() {
        let mut idle = Inner::default();
        assert!(
            idle.claim_shot()
                .unwrap_err()
                .to_string()
                .contains("No capture is running")
        );

        let mut inner = recording();
        inner.set_paused(true).unwrap();
        assert!(
            inner
                .claim_shot()
                .unwrap_err()
                .to_string()
                .contains("paused")
        );
        inner.set_paused(false).unwrap();

        let (session, claimed) = inner.claim_shot().unwrap();
        assert_eq!((session.as_str(), claimed.id.as_str()), ("s1", "window:42"));
        assert!(
            inner
                .claim_shot()
                .unwrap_err()
                .to_string()
                .contains("already being taken")
        );

        inner.finish_shot("s1", Ok("t1".into()));
        let status = inner.status();
        assert_eq!(status.capture_count, 1);
        assert_eq!(status.last_capture_at.as_deref(), Some("t1"));

        inner.claim_shot().unwrap();
        inner.finish_shot("s1", Err("The window is minimized.".into()));
        let status = inner.status();
        assert_eq!(status.capture_count, 1);
        assert_eq!(
            status.last_error.as_deref(),
            Some("The window is minimized.")
        );

        // A successful screenshot clears the previous error.
        inner.claim_shot().unwrap();
        inner.finish_shot("s1", Ok("t2".into()));
        assert!(inner.status().last_error.is_none());
    }

    #[test]
    fn a_screenshot_finishing_after_stop_does_not_change_a_new_capture() {
        let mut inner = recording();
        inner.claim_shot().unwrap();
        inner.end().unwrap();
        inner
            .begin("s2".into(), "Next".into(), target(), "t".into())
            .unwrap();
        inner.finish_shot("s1", Ok("t3".into()));
        assert_eq!(inner.status().capture_count, 0);
        assert!(
            inner.claim_shot().is_ok(),
            "the screenshot lock is released"
        );
    }

    #[test]
    fn shortcut_is_active_only_while_capturing_with_a_registration() {
        let mut inner = recording();
        assert!(!inner.status().shortcut_active);
        inner.registered_shortcut = Some("Ctrl+Alt+Shift+S".into());
        assert!(inner.status().shortcut_active);
        inner.end().unwrap();
        assert!(!inner.status().shortcut_active);
    }

    #[test]
    fn automatic_capture_samples_only_while_recording_with_it_switched_on() {
        let mut inner = Inner::default();
        assert!(inner.set_auto(true).is_err(), "needs a running capture");
        let generation = inner
            .begin("s1".into(), "Change".into(), target(), "t".into())
            .unwrap();
        assert_eq!(inner.sampling(generation).map(|(now, _)| now), Some(false));
        inner.set_auto(true).unwrap();
        assert!(inner.status().auto_capture);
        assert_eq!(inner.sampling(generation).map(|(now, _)| now), Some(true));
        inner.set_paused(true).unwrap();
        assert_eq!(
            inner.sampling(generation).map(|(now, _)| now),
            Some(false),
            "nothing is sampled while paused"
        );
        inner.set_paused(false).unwrap();
        inner.claim_shot().unwrap();
        assert_eq!(inner.sampling(generation).map(|(now, _)| now), Some(false));
        inner.finish_shot("s1", Ok("t1".into()));
        inner.end().unwrap();
        assert!(inner.sampling(generation).is_none(), "the sampler ends");
        let next = inner
            .begin("s2".into(), "Next".into(), target(), "t".into())
            .unwrap();
        assert_ne!(next, generation);
        assert!(
            inner.sampling(generation).is_none(),
            "an old sampler never acts"
        );
        assert!(!inner.status().auto_capture, "off by default");
    }

    #[test]
    fn capture_requests_record_target_and_trigger_without_control_characters() {
        let request = capture_request(
            "s1",
            &target(),
            CaptureTrigger::Shortcut,
            "2026-10-23T05:06:07.890Z",
        );
        assert_eq!(request.title, "Screenshot of Router admin - Edge");
        assert_eq!(request.original_name, "capture-20261023050607.png");
        assert_eq!(request.source, AttachmentSource::Capture);
        assert!(request.event_id.is_none());
        let metadata: serde_json::Value = serde_json::from_str(&request.metadata).unwrap();
        assert_eq!(metadata["capture"]["trigger"], "shortcut");
        assert_eq!(metadata["capture"]["target"]["kind"], "window");
        assert_eq!(metadata["capture"]["target"]["appName"], "Microsoft Edge");
        assert_eq!(metadata["capture"]["target"]["width"], 1280);

        let long = CaptureTarget {
            title: "x".repeat(500),
            ..target()
        };
        let request = capture_request("s1", &long, CaptureTrigger::Button, "now");
        assert_eq!(request.title.chars().count(), events::TITLE_RULE.max_chars);
    }

    #[test]
    fn captured_images_become_capture_events_with_metadata() {
        let mut connection = db::open_in_memory();
        let dir = tempfile::tempdir().unwrap();
        let session = sessions::create(
            &connection,
            &SessionInput {
                title: "Capture test".into(),
                project_id: None,
                application: String::new(),
                environment: String::new(),
            },
            "",
        )
        .unwrap();
        let id = session.summary.id;
        sessions::set_capture_status(&connection, &id, SessionStatus::Recording).unwrap();
        let request = capture_request(
            &id,
            &target(),
            CaptureTrigger::Tray,
            "2026-10-23T05:06:07.890Z",
        );
        let imported = attachments::import(
            &mut connection,
            dir.path(),
            &request,
            &test_images::png(64, 48),
        )
        .unwrap();
        assert!(imported.event_created);
        assert_eq!(imported.event.source, EventSource::Capture);
        assert_eq!(imported.event.title, "Screenshot of Router admin - Edge");
        assert_eq!(imported.event.metadata["capture"]["trigger"], "tray");
        assert_eq!(
            imported.event.attachments[0].source,
            AttachmentSource::Capture
        );
    }

    #[test]
    fn file_stamps_keep_only_digits() {
        assert_eq!(file_stamp("2026-10-23T05:06:07.890Z"), "20261023050607");
    }
}
