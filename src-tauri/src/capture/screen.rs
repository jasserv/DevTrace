//! Screen and window capture through `xcap`.
//!
//! On Windows, displays are captured with GDI `BitBlt` and single windows with `PrintWindow`
//! (`PW_RENDERFULLCONTENT`), which also works when the window is covered by other windows.
//! DevTrace excludes its own window from captures while recording (see `indicator`), and never
//! lists its own windows as targets.

use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{DynamicImage, ExtendedColorType, ImageEncoder, RgbImage, RgbaImage};

use super::{CaptureTarget, CaptureTargetKind};
use crate::error::{AppError, AppResult};

/// Native capture is implemented with a cross-platform crate, but it has only been verified on
/// Windows, so other platforms report it as unavailable instead of claiming it works.
pub const SUPPORTED: bool = cfg!(windows);

pub const UNSUPPORTED_REASON: &str = "Native capture has only been implemented and verified on Windows so far. Import screenshots from files or the clipboard on this platform.";

const MONITOR_PREFIX: &str = "monitor:";
const WINDOW_PREFIX: &str = "window:";

/// Windows smaller than this are toolbars, popups or invisible helpers rather than workspaces.
const MIN_WINDOW_SIDE: u32 = 80;

/// Parsed form of a target id such as `monitor:65537` or `window:131302`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TargetId {
    Monitor(u32),
    Window(u32),
}

impl TargetId {
    pub fn parse(raw: &str) -> AppResult<Self> {
        let invalid = || AppError::validation("targetId", "Choose a display or window to capture.");
        let raw = raw.trim();
        if let Some(rest) = raw.strip_prefix(MONITOR_PREFIX) {
            rest.parse().map(Self::Monitor).map_err(|_| invalid())
        } else if let Some(rest) = raw.strip_prefix(WINDOW_PREFIX) {
            rest.parse().map(Self::Window).map_err(|_| invalid())
        } else {
            Err(invalid())
        }
    }

    pub fn format(self) -> String {
        match self {
            Self::Monitor(id) => format!("{MONITOR_PREFIX}{id}"),
            Self::Window(id) => format!("{WINDOW_PREFIX}{id}"),
        }
    }
}

fn capture_error(error: xcap::XCapError) -> AppError {
    AppError::internal(format!("Screen capture failed: {error}"))
}

/// Windows refuses to read screen pixels while the screen is locked, the session is
/// disconnected, or the process runs on a desktop that is not shown (some automation tools).
fn display_error(error: xcap::XCapError) -> AppError {
    AppError::conflict(
        "capture",
        format!(
            "The screen could not be captured (Windows reported: {error}). This happens while the screen is locked, the remote session is disconnected, or DevTrace runs on a desktop that is not shown. Unlock the screen and try again."
        ),
    )
}

fn ensure_supported() -> AppResult<()> {
    if SUPPORTED {
        Ok(())
    } else {
        Err(AppError::conflict("capture", UNSUPPORTED_REASON))
    }
}

fn monitor_target(index: usize, monitor: &xcap::Monitor) -> Option<CaptureTarget> {
    let id = monitor.id().ok()?;
    let friendly = monitor
        .friendly_name()
        .ok()
        .or_else(|| monitor.name().ok())
        .unwrap_or_default();
    Some(CaptureTarget {
        id: TargetId::Monitor(id).format(),
        kind: CaptureTargetKind::Monitor,
        title: format!("Display {}", index + 1),
        app_name: friendly.trim().to_string(),
        width: monitor.width().unwrap_or(0),
        height: monitor.height().unwrap_or(0),
        primary: monitor.is_primary().unwrap_or(false),
    })
}

fn window_target(window: &xcap::Window, own_pid: u32) -> Option<CaptureTarget> {
    if window.pid().ok()? == own_pid || window.is_minimized().unwrap_or(true) {
        return None;
    }
    let title = window.title().ok()?.trim().to_string();
    let (width, height) = (window.width().ok()?, window.height().ok()?);
    // "Program Manager" is the desktop itself; capture the display instead.
    if title.is_empty()
        || title == "Program Manager"
        || width < MIN_WINDOW_SIDE
        || height < MIN_WINDOW_SIDE
    {
        return None;
    }
    Some(CaptureTarget {
        id: TargetId::Window(window.id().ok()?).format(),
        kind: CaptureTargetKind::Window,
        title,
        app_name: window.app_name().unwrap_or_default().trim().to_string(),
        width,
        height,
        primary: false,
    })
}

/// Lists displays (in system order) followed by visible application windows (front to back).
/// Minimized windows and DevTrace's own windows are left out.
pub fn list_targets() -> AppResult<Vec<CaptureTarget>> {
    ensure_supported()?;
    let monitors = xcap::Monitor::all().map_err(capture_error)?;
    let mut targets: Vec<CaptureTarget> = monitors
        .iter()
        .enumerate()
        .filter_map(|(index, monitor)| monitor_target(index, monitor))
        .collect();
    let own_pid = std::process::id();
    // Window enumeration can fail on locked-down desktops; displays remain usable then.
    if let Ok(windows) = xcap::Window::all() {
        targets.extend(
            windows
                .iter()
                .filter_map(|window| window_target(window, own_pid)),
        );
    }
    Ok(targets)
}

/// Finds a target from the current list, so a stale or forged id cannot be captured.
pub fn find_target(raw_id: &str) -> AppResult<CaptureTarget> {
    let id = TargetId::parse(raw_id)?.format();
    list_targets()?
        .into_iter()
        .find(|target| target.id == id)
        .ok_or_else(|| {
            AppError::conflict(
                "targetId",
                "The selected display or window is no longer available. Refresh the list and choose again.",
            )
        })
}

fn capture_monitor(id: u32) -> AppResult<RgbaImage> {
    let monitor = xcap::Monitor::all()
        .map_err(capture_error)?
        .into_iter()
        .find(|monitor| monitor.id().ok() == Some(id))
        .ok_or_else(|| {
            AppError::conflict(
                "capture",
                "The selected display is no longer connected. Stop the capture and choose another target.",
            )
        })?;
    monitor.capture_image().map_err(display_error)
}

fn capture_window(id: u32, target: &CaptureTarget) -> AppResult<RgbaImage> {
    let closed = || {
        AppError::conflict(
            "capture",
            format!(
                "The window \"{}\" is no longer open. Stop the capture and choose another target.",
                target.title
            ),
        )
    };
    // The application name guards against a closed window whose id was reused.
    let window = xcap::Window::all()
        .map_err(capture_error)?
        .into_iter()
        .find(|window| {
            window.id().ok() == Some(id)
                && window.app_name().unwrap_or_default().trim() == target.app_name
        })
        .ok_or_else(closed)?;
    if window.is_minimized().unwrap_or(false) {
        return Err(AppError::conflict(
            "capture",
            format!(
                "The window \"{}\" is minimized. Restore it, then capture again.",
                target.title
            ),
        ));
    }
    let failed = |reason: String| {
        AppError::conflict(
            "capture",
            format!(
                "The window \"{}\" could not be captured ({reason}). Try capturing the whole display instead.",
                target.title
            ),
        )
    };
    #[cfg(windows)]
    {
        let hwnd = super::win_window::find(id).ok_or_else(closed)?;
        super::win_window::capture(hwnd).map_err(failed)
    }
    #[cfg(not(windows))]
    {
        window
            .capture_image()
            .map_err(|error| failed(error.to_string()))
    }
}

/// Drops the alpha channel. Screens have no meaningful transparency, and an opaque image avoids
/// see-through areas from layered windows. (`into_rgb8` is non-generic, so it runs optimized
/// even in development builds.)
pub fn to_opaque(image: RgbaImage) -> RgbImage {
    DynamicImage::ImageRgba8(image).into_rgb8()
}

/// True when every pixel is black: protected content, a locked screen, or a window that cannot
/// be captured. Storing such an image would look like evidence while showing nothing.
pub fn is_blank(image: &RgbImage) -> bool {
    !image.as_raw().iter().any(|&value| value != 0)
}

/// Encodes an opaque capture as PNG, favoring speed over the last few percent of size.
pub fn encode_png(image: &RgbImage) -> AppResult<Vec<u8>> {
    let (width, height) = image.dimensions();
    if width == 0 || height == 0 {
        return Err(AppError::internal(
            "Screen capture returned an empty image.",
        ));
    }
    let mut bytes = Vec::with_capacity(image.as_raw().len() / 4);
    PngEncoder::new_with_quality(&mut bytes, CompressionType::Fast, FilterType::Adaptive)
        .write_image(image.as_raw(), width, height, ExtendedColorType::Rgb8)
        .map_err(|error| AppError::internal(format!("Could not encode the screenshot: {error}")))?;
    Ok(bytes)
}

/// Captures the target as an opaque image (refusing completely black results).
pub fn capture_rgb(target: &CaptureTarget) -> AppResult<RgbImage> {
    ensure_supported()?;
    let image = match TargetId::parse(&target.id)? {
        TargetId::Monitor(id) => capture_monitor(id)?,
        TargetId::Window(id) => capture_window(id, target)?,
    };
    let image = to_opaque(image);
    if is_blank(&image) {
        return Err(AppError::conflict(
            "capture",
            "The screenshot came back completely black, so it was not saved. Protected content, a locked screen, or some hardware-accelerated windows cannot be captured; try capturing the whole display instead.",
        ));
    }
    Ok(image)
}

/// Captures the target and returns PNG bytes.
pub fn capture_png(target: &CaptureTarget) -> AppResult<Vec<u8>> {
    encode_png(&capture_rgb(target)?)
}

/// Width and height of the grayscale samples used to notice screen changes.
pub const SAMPLE_SIZE: (u32, u32) = (96, 64);

/// A small grayscale sample of the target for change detection. It stays in memory and is never
/// stored.
pub fn capture_sample(target: &CaptureTarget) -> AppResult<Vec<u8>> {
    Ok(sample_of(&capture_rgb(target)?))
}

/// Downscales an image to `SAMPLE_SIZE` grayscale values (0–255): each cell averages a 4×4 grid
/// of points, which is cheap even for large displays and stable against single-pixel noise.
pub fn sample_of(image: &RgbImage) -> Vec<u8> {
    let (columns, rows) = SAMPLE_SIZE;
    let (width, height) = image.dimensions();
    let mut sample = Vec::with_capacity((columns * rows) as usize);
    if width == 0 || height == 0 {
        sample.resize((columns * rows) as usize, 0);
        return sample;
    }
    for row in 0..rows {
        for column in 0..columns {
            let mut total = 0u32;
            for step_y in 0..4 {
                for step_x in 0..4 {
                    let x = ((u64::from(column) * 4 + step_x) * u64::from(width)
                        / (u64::from(columns) * 4)) as u32;
                    let y = ((u64::from(row) * 4 + step_y) * u64::from(height)
                        / (u64::from(rows) * 4)) as u32;
                    let [red, green, blue] = image.get_pixel(x.min(width - 1), y.min(height - 1)).0;
                    total +=
                        (u32::from(red) * 299 + u32::from(green) * 587 + u32::from(blue) * 114)
                            / 1000;
                }
            }
            sample.push((total / 16) as u8);
        }
    }
    sample
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    #[test]
    fn parses_and_formats_target_ids() {
        assert_eq!(
            TargetId::parse("monitor:65537").unwrap(),
            TargetId::Monitor(65537)
        );
        assert_eq!(
            TargetId::parse(" window:42 ").unwrap(),
            TargetId::Window(42)
        );
        assert_eq!(TargetId::Window(42).format(), "window:42");
        for invalid in [
            "",
            "monitor:",
            "window:-1",
            "screen:1",
            "monitor:1x",
            "window:99999999999",
        ] {
            let error = TargetId::parse(invalid).unwrap_err();
            assert_eq!(error.kind(), "validation", "{invalid}");
        }
    }

    #[test]
    fn detects_completely_black_images() {
        let black = to_opaque(RgbaImage::from_pixel(4, 3, Rgba([0, 0, 0, 255])));
        assert!(is_blank(&black));
        // Transparent black from a layered window is still black.
        assert!(is_blank(&to_opaque(RgbaImage::from_pixel(
            2,
            2,
            Rgba([0, 0, 0, 0])
        ))));
        let mut almost = black.clone();
        almost.put_pixel(3, 2, image::Rgb([1, 0, 0]));
        assert!(!is_blank(&almost));
    }

    #[test]
    fn encodes_opaque_png_with_original_dimensions() {
        let mut image = RgbaImage::from_pixel(5, 4, Rgba([10, 20, 30, 0]));
        image.put_pixel(1, 1, Rgba([200, 100, 50, 255]));
        let bytes = encode_png(&to_opaque(image)).unwrap();
        let inspected = crate::storage::inspect_image(&bytes).unwrap();
        assert_eq!((inspected.width, inspected.height), (5, 4));
        let decoded = image::load_from_memory(&bytes).unwrap();
        assert!(!decoded.color().has_alpha());
        let rgb = decoded.to_rgb8();
        // Color is kept as is; transparency is dropped, not blended.
        assert_eq!(rgb.get_pixel(0, 0).0, [10, 20, 30]);
        assert_eq!(rgb.get_pixel(1, 1).0, [200, 100, 50]);
    }

    #[test]
    fn rejects_empty_images() {
        assert!(encode_png(&RgbImage::new(0, 0)).is_err());
    }

    /// Manual check on a real desktop: `cargo test real_capture -- --ignored --nocapture`.
    #[test]
    #[ignore = "captures the real screen"]
    fn real_capture_of_every_target() {
        for target in list_targets().unwrap() {
            let started = std::time::Instant::now();
            let result = capture_png(&target).map(|png| png.len());
            println!(
                "{} {:?}: {:?} in {:?}",
                target.id,
                target.title,
                result.map_err(|error| error.to_string()),
                started.elapsed()
            );
        }
    }
}
