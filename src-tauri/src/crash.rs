//! Crash reports that stay on this computer.
//!
//! Release builds abort on panic and have no console, so a panic would otherwise end DevTrace
//! without a trace. The hook installed here writes the message, the source location and a
//! backtrace to `<workspace>/logs/crash-<time>.txt` before the process ends. Nothing is sent
//! anywhere; the user can open the folder from Settings and share a report if they choose.

use std::fs;
use std::io;
use std::panic::PanicHookInfo;
use std::path::{Path, PathBuf};

/// Installs the hook. Earlier hooks (for example the default one that prints to the console in
/// development builds) still run afterwards.
pub fn install(logs_dir: PathBuf, version: String) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = write_report(&logs_dir, &version, info);
        previous(info);
    }));
}

fn message(info: &PanicHookInfo<'_>) -> String {
    let payload = info.payload();
    if let Some(text) = payload.downcast_ref::<&str>() {
        (*text).to_string()
    } else if let Some(text) = payload.downcast_ref::<String>() {
        text.clone()
    } else {
        "(no message)".to_string()
    }
}

/// Text of a crash report (separate from the hook so it can be tested without panicking).
fn report(version: &str, thread: &str, message: &str, location: &str, backtrace: &str) -> String {
    format!(
        "DevTrace {version} stopped because of an internal error.\n\
         Time: {}\n\
         Thread: {thread}\n\
         Message: {message}\n\
         Location: {location}\n\
         \n\
         Backtrace:\n{backtrace}\n",
        chrono::Utc::now().to_rfc3339()
    )
}

fn write_report(dir: &Path, version: &str, info: &PanicHookInfo<'_>) -> io::Result<PathBuf> {
    fs::create_dir_all(dir)?;
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%S%.3fZ");
    let path = dir.join(format!("crash-{stamp}.txt"));
    let thread = std::thread::current();
    let location = info
        .location()
        .map(|location| format!("{}:{}", location.file(), location.line()))
        .unwrap_or_else(|| "unknown".into());
    let backtrace = std::backtrace::Backtrace::force_capture().to_string();
    fs::write(
        &path,
        report(
            version,
            thread.name().unwrap_or("unnamed"),
            &message(info),
            &location,
            &backtrace,
        ),
    )?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_report_names_the_version_message_and_location() {
        let text = report("0.1.0", "main", "boom", "src/lib.rs:10", "0: frame");
        assert!(text.starts_with("DevTrace 0.1.0 stopped"));
        assert!(text.contains("Message: boom"));
        assert!(text.contains("Location: src/lib.rs:10"));
        assert!(text.contains("Backtrace:\n0: frame"));
    }
}
