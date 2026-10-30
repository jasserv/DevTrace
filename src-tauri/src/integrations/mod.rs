//! Integrations (Milestone 8): opt-in sources of recorded evidence besides screenshots.
//!
//! Each source is a small adapter with a clear boundary: terminal logs (`terminal`, with one
//! parser per log format in `transcript`), watched configuration files (`file_watch`), and
//! automatic capture after screen changes (in `crate::capture::auto`). Every adapter only runs
//! after the user switched it on for a session or capture, shows its state, records steps that
//! still go through review, and never observes keyboard or mouse input.

pub mod file_watch;
pub mod tail;
pub mod terminal;
pub mod transcript;

use serde::Serialize;

/// An integration this build offers, for Settings and the session workspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Integration {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    /// Where it is switched on.
    pub location: &'static str,
    pub available: bool,
    /// Why it is unavailable, when it is.
    pub unavailable_reason: Option<&'static str>,
}

/// Every integration with its availability on this platform.
pub fn catalog() -> Vec<Integration> {
    let capture = crate::capture::screen::SUPPORTED;
    vec![
        Integration {
            id: "auto-capture",
            name: "Automatic capture after screen changes",
            description: "Samples the capture target about once a second (in memory only) and takes a screenshot after a visible change has settled. Small changes such as a blinking cursor are ignored. It does not detect clicks or keystrokes.",
            location: "Capture: when starting a capture, or with the Auto switch while recording",
            available: capture,
            unavailable_reason: (!capture).then_some(crate::capture::screen::UNSUPPORTED_REASON),
        },
        Integration {
            id: "powershell-transcript",
            name: "PowerShell transcript",
            description: "Reads a transcript that you start in your own PowerShell window with Start-Transcript. Each command becomes a step with its output; obvious secrets are masked.",
            location: "Session: Integrations \u{2192} Terminal log",
            available: true,
            unavailable_reason: None,
        },
        Integration {
            id: "plain-log",
            name: "Plain terminal log",
            description: "Reads a text log written by another program (for example PuTTY session logging). New output becomes a step after each quiet period.",
            location: "Session: Integrations \u{2192} Terminal log",
            available: true,
            unavailable_reason: None,
        },
        Integration {
            id: "config-file",
            name: "Configuration file watch",
            description: "Watches a text file you choose (up to 1 MB). Each change is recorded as a step and as an observed change with before and after values.",
            location: "Session: Integrations \u{2192} Watch a file",
            available: true,
            unavailable_reason: None,
        },
    ]
}

#[tauri::command]
pub async fn list_integrations() -> crate::error::AppResult<Vec<Integration>> {
    Ok(catalog())
}

#[cfg(test)]
mod tests {
    #[test]
    fn every_integration_explains_itself() {
        let catalog = super::catalog();
        assert_eq!(catalog.len(), 4);
        for integration in catalog {
            assert!(!integration.description.is_empty());
            assert_eq!(
                integration.available,
                integration.unavailable_reason.is_none()
            );
        }
    }
}
