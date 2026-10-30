//! PDF export. The exported HTML document is printed by WebView2, the engine that already renders
//! DevTrace, in a hidden window that is destroyed afterwards. That window shows a local file,
//! which Tauri treats as a remote origin: it cannot call any DevTrace command, and the
//! document's Content-Security-Policy blocks scripts and remote content.

use std::path::Path;

use tauri::{AppHandle, Runtime};

use crate::error::AppResult;

/// Whether this build can produce PDF files.
pub const SUPPORTED: bool = cfg!(windows);

/// Paper size in inches: US Letter where Windows' regional settings use it, A4 elsewhere.
#[cfg_attr(not(windows), allow(dead_code))]
fn paper_size() -> (f64, f64) {
    #[cfg(windows)]
    {
        use windows::Win32::Globalization::{
            GetLocaleInfoEx, LOCALE_IPAPERSIZE, LOCALE_RETURN_NUMBER,
        };
        use windows::core::PCWSTR;
        let mut value = [0u16; 2];
        // SAFETY: a null locale name means the user default; the buffer holds the DWORD result.
        let written = unsafe {
            GetLocaleInfoEx(
                PCWSTR::null(),
                LOCALE_IPAPERSIZE | LOCALE_RETURN_NUMBER,
                Some(&mut value),
            )
        };
        let size = u32::from(value[0]) | (u32::from(value[1]) << 16);
        // 1 = Letter, 5 = Legal (both US). Everything else prints on A4.
        if written > 0 && matches!(size, 1 | 5) {
            return (8.5, 11.0);
        }
    }
    (8.27, 11.69)
}

/// Prints `html` (an absolute path to a self-contained document) to `pdf`.
#[cfg(windows)]
pub async fn print<R: Runtime>(
    app: &AppHandle<R>,
    html: &Path,
    pdf: &Path,
    header_title: &str,
) -> AppResult<()> {
    windows_print::print(app, html, pdf, header_title).await
}

#[cfg(not(windows))]
pub async fn print<R: Runtime>(
    _app: &AppHandle<R>,
    _html: &Path,
    _pdf: &Path,
    _header_title: &str,
) -> AppResult<()> {
    Err(crate::error::AppError::conflict(
        "format",
        "PDF export is only available on Windows in this version. Export HTML and print it from a browser instead.",
    ))
}

#[cfg(windows)]
mod windows_print {
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc::RecvTimeoutError;
    use std::time::Duration;

    use tauri::async_runtime::{Sender, channel};
    use tauri::webview::{PageLoadEvent, PlatformWebview};
    use tauri::{AppHandle, Runtime, Url, WebviewUrl, WebviewWindowBuilder};
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT, ICoreWebView2_7, ICoreWebView2Environment6,
    };
    use webview2_com::PrintToPdfCompletedHandler;
    use windows::core::{HSTRING, Interface};

    use super::paper_size;
    use crate::error::{AppError, AppResult};

    /// Large documents with many screenshots take a few seconds; give up well after that.
    const TIMEOUT: Duration = Duration::from_secs(120);
    /// Margins in inches. The header (date, title) and footer (page numbers) print inside them.
    const MARGIN: f64 = 0.55;

    type Outcome = Result<(), String>;

    pub async fn print<R: Runtime>(
        app: &AppHandle<R>,
        html: &Path,
        pdf: &Path,
        header_title: &str,
    ) -> AppResult<()> {
        let url = Url::from_file_path(html)
            .map_err(|()| AppError::internal("The export file path must be absolute."))?;
        let (sender, mut receiver) = channel::<Outcome>(4);
        let label = format!("pdf-export-{}", uuid::Uuid::now_v7().simple());
        let started = Arc::new(AtomicBool::new(false));
        let on_load = {
            let sender = sender.clone();
            let pdf = pdf.to_path_buf();
            let header_title = header_title.to_string();
            move |window: tauri::WebviewWindow<R>, payload: tauri::webview::PageLoadPayload<'_>| {
                if payload.event() != PageLoadEvent::Finished
                    || started.swap(true, Ordering::SeqCst)
                {
                    return;
                }
                let job = PrintJob {
                    pdf: pdf.clone(),
                    header_title: header_title.clone(),
                    sender: sender.clone(),
                };
                let failed = sender.clone();
                if let Err(error) = window.with_webview(move |webview| job.start(&webview)) {
                    let _ = failed.try_send(Err(error.to_string()));
                }
            }
        };
        // Window creation must not happen on the main thread from a synchronous command; this
        // runs in an async command on the Tauri runtime.
        let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::CustomProtocol(url))
            .title("DevTrace PDF export")
            .visible(false)
            .focused(false)
            .skip_taskbar(true)
            .inner_size(900.0, 1200.0)
            .on_page_load(on_load)
            .build()
            .map_err(|error| {
                AppError::internal(format!("The PDF renderer could not be started: {error}"))
            })?;

        // Fails the export if WebView2 never reports back; stops early once the export ends.
        let (finished, cancelled) = std::sync::mpsc::channel::<()>();
        let timeout = sender.clone();
        std::thread::spawn(move || {
            if let Err(RecvTimeoutError::Timeout) = cancelled.recv_timeout(TIMEOUT) {
                let _ = timeout.try_send(Err(
                    "Rendering the PDF took too long. Try again, or export HTML instead.".into(),
                ));
            }
        });
        drop(sender);

        let outcome = receiver
            .recv()
            .await
            .unwrap_or_else(|| Err("The PDF renderer closed unexpectedly.".into()));
        drop(finished);
        let _ = window.destroy();
        outcome.map_err(|message| {
            AppError::internal(format!("The PDF could not be created: {message}"))
        })
    }

    struct PrintJob {
        pdf: PathBuf,
        header_title: String,
        sender: Sender<Outcome>,
    }

    impl PrintJob {
        /// Runs on the main thread inside `with_webview`.
        fn start(self, webview: &PlatformWebview) {
            let sender = self.sender.clone();
            // SAFETY: WebView2 COM calls on the UI thread with interfaces owned by the webview.
            if let Err(error) = unsafe { self.print(webview) } {
                let _ = sender.try_send(Err(error.to_string()));
            }
        }

        unsafe fn print(self, webview: &PlatformWebview) -> windows::core::Result<()> {
            let (width, height) = paper_size();
            unsafe {
                let core: ICoreWebView2_7 = webview.controller().CoreWebView2()?.cast()?;
                let settings = webview
                    .environment()
                    .cast::<ICoreWebView2Environment6>()?
                    .CreatePrintSettings()?;
                settings.SetOrientation(COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT)?;
                settings.SetPageWidth(width)?;
                settings.SetPageHeight(height)?;
                settings.SetMarginTop(MARGIN)?;
                settings.SetMarginBottom(MARGIN)?;
                settings.SetMarginLeft(MARGIN)?;
                settings.SetMarginRight(MARGIN)?;
                settings.SetShouldPrintBackgrounds(true)?;
                // Header: print date and the playbook title. Footer: page numbers, without the
                // local file address (an empty footer URI hides it).
                settings.SetShouldPrintHeaderAndFooter(true)?;
                settings.SetHeaderTitle(&HSTRING::from(self.header_title.as_str()))?;
                settings.SetFooterUri(&HSTRING::new())?;
                let sender = self.sender;
                let handler = PrintToPdfCompletedHandler::create(Box::new(move |result, ok| {
                    let _ = sender.try_send(match (result, ok) {
                        (Ok(()), true) => Ok(()),
                        (Ok(()), false) => {
                            Err("WebView2 reported that printing failed.".to_string())
                        }
                        (Err(error), _) => Err(error.to_string()),
                    });
                    Ok(())
                }));
                core.PrintToPdf(&HSTRING::from(self.pdf.as_path()), &settings, &handler)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn paper_is_a4_or_letter() {
        let (width, height) = super::paper_size();
        assert!(matches!((width, height), (8.27, 11.69) | (8.5, 11.0)));
    }
}
