//! Everything that makes an active capture visible and controllable outside the main window:
//! the tray icon and menu, the global capture shortcut, and excluding DevTrace's own window
//! from screenshots. These are side effects only; the capture state lives in `CaptureController`.

use tauri::image::Image;
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use super::{CaptureState, CaptureStatus, CaptureTrigger};

const TRAY_ID: &str = "devtrace-capture";
const MENU_CAPTURE: &str = "capture-now";
const MENU_PAUSE: &str = "capture-pause";
const MENU_STOP: &str = "capture-stop";
const MENU_SHOW: &str = "capture-show";

/// System red and amber, matching the recording and paused colors used in the app.
const RECORDING_RGB: [u8; 3] = [0xFF, 0x3B, 0x30];
const PAUSED_RGB: [u8; 3] = [0xFF, 0x9F, 0x0A];

/// Menu items whose text changes with the capture state.
pub struct TrayItems {
    capture: MenuItem<Wry>,
    pause: MenuItem<Wry>,
}

/// A filled status dot with a light outline, drawn at runtime so no image asset is needed.
fn dot_icon(rgb: [u8; 3]) -> Image<'static> {
    const SIZE: u32 = 32;
    let center = (SIZE as f32 - 1.0) / 2.0;
    let outer = SIZE as f32 * 0.40;
    let inner = outer - 2.0;
    let mut rgba = vec![0u8; (SIZE * SIZE * 4) as usize];
    for y in 0..SIZE {
        for x in 0..SIZE {
            let distance = ((x as f32 - center).powi(2) + (y as f32 - center).powi(2)).sqrt();
            let coverage = (outer + 0.5 - distance).clamp(0.0, 1.0);
            if coverage <= 0.0 {
                continue;
            }
            let fill = (inner + 0.5 - distance).clamp(0.0, 1.0);
            let index = ((y * SIZE + x) * 4) as usize;
            for channel in 0..3 {
                let value = f32::from(rgb[channel]) * fill + 255.0 * (1.0 - fill);
                rgba[index + channel] = value.round() as u8;
            }
            rgba[index + 3] = (coverage * 255.0).round() as u8;
        }
    }
    Image::new_owned(rgba, SIZE, SIZE)
}

fn tooltip(status: &CaptureStatus) -> String {
    let state = match status.state {
        CaptureState::Recording => "Recording",
        CaptureState::Paused => "Paused",
        CaptureState::Idle => "Not recording",
    };
    let shots = match status.capture_count {
        1 => "1 screenshot".to_string(),
        count => format!("{count} screenshots"),
    };
    // Windows truncates tray tooltips at 127 characters.
    let text = format!("DevTrace capture: {state}, {shots}");
    text.chars().take(120).collect()
}

fn capture_label(status: &CaptureStatus) -> String {
    if status.shortcut_active {
        format!("Capture now\t{}", status.shortcut)
    } else {
        "Capture now".to_string()
    }
}

fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    let app = app.clone();
    match event.id().as_ref() {
        MENU_CAPTURE => {
            tauri::async_runtime::spawn(async move {
                let _ = super::take_screenshot(&app, CaptureTrigger::Tray).await;
            });
        }
        MENU_PAUSE => {
            tauri::async_runtime::spawn(async move {
                let _ = super::toggle_pause(&app).await;
            });
        }
        MENU_STOP => {
            tauri::async_runtime::spawn(async move {
                let _ = super::stop(&app).await;
            });
        }
        MENU_SHOW => show_main_window(&app),
        _ => {}
    }
}

pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn build_tray(app: &AppHandle, status: &CaptureStatus) -> tauri::Result<TrayItems> {
    let capture = MenuItem::with_id(app, MENU_CAPTURE, capture_label(status), true, None::<&str>)?;
    let pause = MenuItem::with_id(app, MENU_PAUSE, "Pause capture", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, MENU_STOP, "Stop capture", true, None::<&str>)?;
    let show = MenuItem::with_id(app, MENU_SHOW, "Show DevTrace", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&capture, &pause, &separator, &stop, &show])?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(dot_icon(RECORDING_RGB))
        .tooltip(tooltip(status))
        .menu(&menu)
        .on_menu_event(on_menu_event)
        .build(app)?;
    Ok(TrayItems { capture, pause })
}

/// Creates the tray icon on the first call and updates icon, tooltip and menu afterwards.
/// Removes it when the capture is idle.
pub fn sync_tray(app: &AppHandle, items: &mut Option<TrayItems>, status: &CaptureStatus) {
    if status.state == CaptureState::Idle {
        *items = None;
        // The native icon is destroyed when the last handle drops, which must happen on the
        // main thread that created its window. Wait for it so a new capture cannot race it.
        let handle = app.clone();
        let (done, finished) = std::sync::mpsc::channel();
        let scheduled = app.run_on_main_thread(move || {
            drop(handle.remove_tray_by_id(TRAY_ID));
            let _ = done.send(());
        });
        if scheduled.is_ok() {
            let _ = finished.recv_timeout(std::time::Duration::from_secs(2));
        }
        return;
    }
    if items.is_none() || app.tray_by_id(TRAY_ID).is_none() {
        match build_tray(app, status) {
            Ok(created) => *items = Some(created),
            Err(error) => {
                eprintln!("DevTrace: could not create the capture tray icon: {error}");
                return;
            }
        }
    }
    let paused = status.state == CaptureState::Paused;
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_icon(Some(dot_icon(if paused {
            PAUSED_RGB
        } else {
            RECORDING_RGB
        })));
        let _ = tray.set_tooltip(Some(tooltip(status)));
    }
    if let Some(items) = items {
        let _ = items.capture.set_text(capture_label(status));
        let _ = items.capture.set_enabled(!paused);
        let _ = items.pause.set_text(if paused {
            "Resume capture"
        } else {
            "Pause capture"
        });
    }
}

/// Registers the capture shortcut. The error message explains what to do instead.
pub fn register_shortcut(app: &AppHandle, shortcut: &str) -> Result<(), String> {
    let result = app
        .global_shortcut()
        .on_shortcut(shortcut, |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = super::take_screenshot(&app, CaptureTrigger::Shortcut).await;
                });
            }
        });
    result.map_err(|error| {
        eprintln!("DevTrace: could not register the capture shortcut {shortcut}: {error}");
        format!(
            "{shortcut} could not be registered; another application may be using it. Use Capture now or the tray menu, or choose a different shortcut in Settings."
        )
    })
}

pub fn unregister_shortcut(app: &AppHandle, shortcut: &str) {
    if let Err(error) = app.global_shortcut().unregister(shortcut) {
        eprintln!("DevTrace: could not unregister the capture shortcut {shortcut}: {error}");
    }
}

/// While recording, DevTrace's own window is excluded from every screen capture (Windows
/// `WDA_EXCLUDEFROMCAPTURE`), so screenshots show the work instead of DevTrace.
pub fn exclude_main_window_from_capture(app: &AppHandle, excluded: bool) {
    if let Some(window) = app.get_webview_window("main")
        && let Err(error) = window.set_content_protected(excluded)
    {
        eprintln!("DevTrace: could not change capture exclusion of the main window: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(state: CaptureState, count: u32) -> CaptureStatus {
        CaptureStatus {
            state,
            capture_count: count,
            ..CaptureStatus::idle("Ctrl+Alt+Shift+S".into())
        }
    }

    #[test]
    fn tooltip_reports_state_and_count() {
        assert_eq!(
            tooltip(&status(CaptureState::Recording, 1)),
            "DevTrace capture: Recording, 1 screenshot"
        );
        assert_eq!(
            tooltip(&status(CaptureState::Paused, 3)),
            "DevTrace capture: Paused, 3 screenshots"
        );
    }

    #[test]
    fn capture_menu_shows_the_shortcut_only_when_registered() {
        let mut value = status(CaptureState::Recording, 0);
        assert_eq!(capture_label(&value), "Capture now");
        value.shortcut_active = true;
        assert_eq!(capture_label(&value), "Capture now\tCtrl+Alt+Shift+S");
    }

    #[test]
    fn status_dot_is_opaque_in_the_center_and_transparent_in_the_corners() {
        let icon = dot_icon(RECORDING_RGB);
        let rgba = icon.rgba();
        let pixel = |x: usize, y: usize| &rgba[(y * 32 + x) * 4..(y * 32 + x) * 4 + 4];
        assert_eq!(pixel(16, 16), &[0xFF, 0x3B, 0x30, 0xFF]);
        assert_eq!(pixel(0, 0)[3], 0);
    }
}
