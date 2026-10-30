//! Export (Milestone 6): one playbook version rendered as Markdown with an images folder, as a
//! self-contained HTML file, or as PDF printed from that HTML. Files go to the workspace
//! `exports` folder. Every format is rendered from the same document model (`document`), so
//! the formats always agree, and stored evidence is never modified.

pub mod document;
pub mod html;
pub mod images;
pub mod markdown;
pub mod pdf;

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_opener::OpenerExt;

use crate::clock;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::storage;

text_enum! {
    /// Export file formats.
    pub enum ExportFormat {
        Markdown => "markdown",
        Html => "html",
        Pdf => "pdf",
    }
}

/// Folder next to a Markdown file that holds its screenshots.
pub const IMAGE_DIR: &str = "images";

/// What every renderer needs besides the document.
#[derive(Debug, Clone)]
pub struct RenderContext {
    /// RFC 3339 time of the export.
    pub exported_at: String,
    pub app_version: String,
}

impl RenderContext {
    /// The closing note of every export: where it came from and how to read step sources.
    pub fn footer(&self, playbook_id: &str) -> String {
        format!(
            "Exported from DevTrace {} on {} (playbook {playbook_id}). Step sources: steps \
             \u{201c}from session\u{201d} were copied from approved session steps, steps \
             \u{201c}edited after copying\u{201d} were changed afterwards, and everything else \
             was written by the author. DevTrace never adds verification results: verification \
             items are checks for the reader to perform.",
            self.app_version,
            document::local_time(&self.exported_at)
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub format: ExportFormat,
    /// Name of the main file, for example `rotate-keys.md`.
    pub file_name: String,
    /// Location of the main file relative to the exports folder (for `reveal_export`).
    pub relative_path: String,
    /// Absolute location, shown to the user.
    pub path: String,
    /// Size of everything written (document and images).
    pub byte_size: u64,
    pub image_count: usize,
    pub missing_images: usize,
    /// `Draft`, `In review` or `Revision 3`.
    pub version_label: String,
}

/// Serializes PDF rendering: each PDF export opens one hidden window, one at a time.
#[derive(Default)]
pub struct ExportState {
    pdf: tauri::async_runtime::Mutex<()>,
}

/// A document ready to be rendered: content, screenshots and output names.
pub struct Prepared {
    pub document: document::ExportDocument,
    pub figures: Vec<images::StepFigures>,
    pub context: RenderContext,
    /// File name stem of the main file, for example `rotate-keys`.
    pub slug: String,
    /// Unique per export, for example `rotate-keys-r2-20261023-152000`.
    pub base_name: String,
}

/// Lowercase ASCII letters, digits and single dashes (at most 48 characters); `playbook` when
/// the title has no ASCII letters or digits. Reserved Windows device names get a suffix.
pub fn slug(title: &str) -> String {
    let mut slug = String::new();
    for character in title.chars() {
        if slug.len() >= 48 {
            break;
        }
        if character.is_ascii_alphanumeric() {
            slug.push(character.to_ascii_lowercase());
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.trim_matches('-');
    if slug.is_empty() {
        "playbook".into()
    } else if storage::is_reserved_device_name(slug) {
        format!("{slug}-playbook")
    } else {
        slug.into()
    }
}

/// Adds screenshots and names to a loaded document.
pub fn assemble(
    document: document::ExportDocument,
    assets_dir: &Path,
    app_version: &str,
) -> Prepared {
    let figures = images::prepare(&document, assets_dir);
    let slug = slug(&document.title);
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let base_name = format!("{slug}-{}-{stamp}", document.version.file_label());
    Prepared {
        document,
        figures,
        context: RenderContext {
            exported_at: clock::now(),
            app_version: app_version.into(),
        },
        slug,
        base_name,
    }
}

/// Loads a playbook version (holding the database lock only while reading) and prepares it.
pub fn prepare(
    state: &AppState,
    playbook_id: &str,
    revision_id: Option<&str>,
    app_version: &str,
) -> AppResult<Prepared> {
    let document =
        state.with_db(|connection| document::load(connection, playbook_id, revision_id))?;
    Ok(assemble(document, &state.paths.assets_dir, app_version))
}

/// `<base><extension>` that does not exist yet in `dir`; `-2`, `-3`… are added when needed.
fn unique_name(dir: &Path, base: &str, extension: &str) -> AppResult<String> {
    for attempt in 1..=100 {
        let name = if attempt == 1 {
            format!("{base}{extension}")
        } else {
            format!("{base}-{attempt}{extension}")
        };
        if !dir.join(&name).exists() && !dir.join(format!(".{name}.partial")).exists() {
            return Ok(name);
        }
    }
    Err(AppError::conflict(
        "format",
        "Too many exports with the same name. Try again in a moment.",
    ))
}

fn result(
    format: ExportFormat,
    exports_dir: &Path,
    relative_path: String,
    file_name: String,
    byte_size: u64,
    prepared: &Prepared,
) -> ExportResult {
    let path = relative_path
        .split('/')
        .fold(exports_dir.to_path_buf(), |path, part| path.join(part));
    ExportResult {
        format,
        file_name,
        relative_path,
        path: path.display().to_string(),
        byte_size,
        image_count: images::included(&prepared.figures),
        missing_images: images::missing(&prepared.figures),
        version_label: prepared.document.version.label(),
    }
}

/// Writes `<base>/<slug>.md` with an `images` folder. The folder is assembled under a temporary
/// name and renamed when complete, so a failed export leaves nothing half-written.
pub fn write_markdown(exports_dir: &Path, prepared: &Prepared) -> AppResult<ExportResult> {
    std::fs::create_dir_all(exports_dir)?;
    let folder = unique_name(exports_dir, &prepared.base_name, "")?;
    let staging = exports_dir.join(format!(".{folder}.partial"));
    let file_name = format!("{}.md", prepared.slug);
    let written = (|| -> AppResult<u64> {
        let mut total = 0;
        for figure in prepared.figures.iter().flatten().flatten() {
            storage::write_atomic(
                &staging.join(IMAGE_DIR).join(&figure.file_name),
                &figure.bytes,
            )?;
            total += figure.bytes.len() as u64;
        }
        let markdown = markdown::render(
            &prepared.document,
            &prepared.figures,
            &prepared.context,
            IMAGE_DIR,
        );
        storage::write_atomic(&staging.join(&file_name), markdown.as_bytes())?;
        std::fs::rename(&staging, exports_dir.join(&folder))?;
        Ok(total + markdown.len() as u64)
    })();
    match written {
        Ok(size) => Ok(result(
            ExportFormat::Markdown,
            exports_dir,
            format!("{folder}/{file_name}"),
            file_name,
            size,
            prepared,
        )),
        Err(error) => {
            let _ = storage::remove_dir_if_exists(&staging);
            Err(error)
        }
    }
}

/// Writes `<base>.html`.
pub fn write_html(exports_dir: &Path, prepared: &Prepared) -> AppResult<ExportResult> {
    std::fs::create_dir_all(exports_dir)?;
    let file_name = unique_name(exports_dir, &prepared.base_name, ".html")?;
    let html = html::render(&prepared.document, &prepared.figures, &prepared.context);
    storage::write_atomic(&exports_dir.join(&file_name), html.as_bytes())?;
    Ok(result(
        ExportFormat::Html,
        exports_dir,
        file_name.clone(),
        file_name,
        html.len() as u64,
        prepared,
    ))
}

/// Writes `<base>.pdf`, printed from the HTML export. Temporary files are removed afterwards.
pub async fn write_pdf<R: Runtime>(
    app: &AppHandle<R>,
    exports_dir: &Path,
    prepared: &Prepared,
) -> AppResult<ExportResult> {
    std::fs::create_dir_all(exports_dir)?;
    // WebView2 needs absolute paths.
    let exports_dir = std::path::absolute(exports_dir)?;
    let file_name = unique_name(&exports_dir, &prepared.base_name, ".pdf")?;
    let source = exports_dir.join(format!(".{file_name}.print.html"));
    let partial = exports_dir.join(format!(".{file_name}.partial"));
    let target = exports_dir.join(&file_name);
    let html = html::render(&prepared.document, &prepared.figures, &prepared.context);
    let _ = storage::remove_file_if_exists(&source);
    let _ = storage::remove_file_if_exists(&partial);
    storage::write_atomic(&source, html.as_bytes())?;
    let printed = pdf::print(app, &source, &partial, &prepared.document.title).await;
    let _ = storage::remove_file_if_exists(&source);
    let finished = printed.and_then(|()| finish_pdf(&partial, &target));
    if finished.is_err() {
        let _ = storage::remove_file_if_exists(&partial);
    }
    let size = finished?;
    Ok(result(
        ExportFormat::Pdf,
        &exports_dir,
        file_name.clone(),
        file_name,
        size,
        prepared,
    ))
}

/// Checks that the renderer produced a PDF and moves it into place.
fn finish_pdf(partial: &Path, target: &Path) -> AppResult<u64> {
    let bytes = std::fs::read(partial).map_err(|error| {
        AppError::internal(format!(
            "The PDF renderer did not produce a file ({error})."
        ))
    })?;
    if !bytes.starts_with(b"%PDF-") {
        return Err(AppError::internal(
            "The PDF renderer produced a file that is not a PDF.",
        ));
    }
    if target.exists() {
        return Err(AppError::conflict(
            "format",
            "An export with the same name appeared meanwhile. Export again.",
        ));
    }
    std::fs::rename(partial, target)?;
    Ok(bytes.len() as u64)
}

/// Resolves a file inside the exports folder from a relative path returned by an export.
pub fn locate_export(exports_dir: &Path, relative_path: &str) -> AppResult<PathBuf> {
    let path = storage::resolve_contained(exports_dir, relative_path.trim()).map_err(|_| {
        AppError::validation("relativePath", "This file is not in the exports folder.")
    })?;
    if !path.exists() {
        return Err(AppError::not_found("Export", relative_path));
    }
    Ok(path)
}

// ---------------------------------------------------------------------------------------------
// Commands

/// Exports a playbook. Without `revision_id`, a published playbook exports its newest revision
/// and an unpublished one its saved working copy.
#[tauri::command]
pub async fn export_playbook(
    app: AppHandle,
    state: State<'_, AppState>,
    exports: State<'_, ExportState>,
    id: String,
    format: ExportFormat,
    revision_id: Option<String>,
) -> AppResult<ExportResult> {
    let version = app.package_info().version.to_string();
    let prepared = prepare(&state, &id, revision_id.as_deref(), &version)?;
    let dir = &state.paths.exports_dir;
    match format {
        ExportFormat::Markdown => write_markdown(dir, &prepared),
        ExportFormat::Html => write_html(dir, &prepared),
        ExportFormat::Pdf => {
            let _one_at_a_time = exports.pdf.lock().await;
            write_pdf(&app, dir, &prepared).await
        }
    }
}

/// Shows an exported file in the system file manager. Implemented in Rust so the webview
/// never needs a general "open path" permission; only files inside the exports folder qualify.
#[tauri::command]
pub async fn reveal_export(
    app: AppHandle,
    state: State<'_, AppState>,
    relative_path: String,
) -> AppResult<()> {
    let path = locate_export(&state.paths.exports_dir, &relative_path)?;
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|error| AppError::internal(format!("Could not show the exported file: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::features::attachments::{self, AttachmentSource, ImportRequest};
    use crate::features::events::EventReviewStatus;
    use crate::features::playbooks::{self, PlaybookInput, PlaybookStatus};
    use crate::features::review;
    use crate::features::sessions::{self, SessionInput};
    use rusqlite::Connection;

    struct Workspace {
        _temp: tempfile::TempDir,
        attachments: PathBuf,
        assets: PathBuf,
        exports: PathBuf,
        connection: Connection,
    }

    fn workspace() -> Workspace {
        let temp = tempfile::tempdir().unwrap();
        Workspace {
            attachments: temp.path().join("attachments"),
            assets: temp.path().join("playbook-assets"),
            exports: temp.path().join("exports"),
            connection: db::open_in_memory(),
            _temp: temp,
        }
    }

    /// A playbook generated from a session with one approved, highlighted screenshot step.
    fn playbook(ws: &mut Workspace) -> String {
        let session = sessions::create(
            &ws.connection,
            &SessionInput {
                title: "Rotate VPN certificate".into(),
                project_id: None,
                application: "FortiGate".into(),
                environment: "Lab".into(),
            },
            "",
        )
        .unwrap()
        .summary
        .id;
        let screenshot = crate::capture::screen::encode_png(&image::RgbImage::from_pixel(
            120,
            80,
            image::Rgb([240, 240, 240]),
        ))
        .unwrap();
        let shot = attachments::import(
            &mut ws.connection,
            &ws.attachments,
            &ImportRequest {
                session_id: session.clone(),
                event_id: None,
                title: "Open <Certificates> & check *expiry*".into(),
                original_name: "certs.png".into(),
                source: AttachmentSource::Clipboard,
                metadata: "{}".into(),
            },
            &screenshot,
        )
        .unwrap();
        review::set_status(
            &mut ws.connection,
            &session,
            std::slice::from_ref(&shot.event.id),
            EventReviewStatus::Approved,
            "",
            "",
        )
        .unwrap();
        let generated =
            playbooks::generate(&mut ws.connection, &ws.attachments, &ws.assets, &session).unwrap();
        ws.connection
            .execute(
                "UPDATE playbook_assets SET annotations_json = ?1",
                [r#"[{"id":"a1","x":10,"y":10,"width":30,"height":20,"label":"Expiry column"}]"#],
            )
            .unwrap();
        generated.summary.id
    }

    fn prepared(ws: &Workspace, id: &str, revision: Option<&str>) -> Prepared {
        let document = document::load(&ws.connection, id, revision).unwrap();
        assemble(document, &ws.assets, "test")
    }

    #[test]
    fn slugs_are_safe_file_names() {
        assert_eq!(
            slug("Rotate VPN \u{2014} Certificate!"),
            "rotate-vpn-certificate"
        );
        assert_eq!(slug("  --C++ / .NET 8--  "), "c-net-8");
        assert_eq!(slug("\u{8bc1}\u{4e66}"), "playbook");
        assert!(slug(&"a".repeat(100)).len() <= 48);
        assert_eq!(slug("CON"), "con-playbook");
        assert_eq!(slug("com1"), "com1-playbook");
        assert_eq!(slug("Console"), "console");
    }

    #[test]
    fn exports_markdown_with_highlighted_images_and_escaped_text() {
        let mut ws = workspace();
        let id = playbook(&mut ws);
        let prepared = prepared(&ws, &id, None);
        let exported = write_markdown(&ws.exports, &prepared).unwrap();
        assert_eq!(exported.format, ExportFormat::Markdown);
        assert_eq!(exported.file_name, "rotate-vpn-certificate.md");
        assert_eq!((exported.image_count, exported.missing_images), (1, 0));
        assert_eq!(exported.version_label, "Draft");
        let file = locate_export(&ws.exports, &exported.relative_path).unwrap();
        let markdown = std::fs::read_to_string(&file).unwrap();
        assert!(markdown.starts_with("# Rotate VPN certificate\n"));
        assert!(markdown.contains(r"### 1. Open \<Certificates\> & check \*expiry\*"));
        assert!(markdown.contains("![Step 1, screenshot 1](images/step-01-1.png)"));
        assert!(markdown.contains("1. Expiry column"));
        let image = std::fs::read(file.parent().unwrap().join("images/step-01-1.png")).unwrap();
        let decoded = review::decode_image(&image).unwrap();
        assert_eq!(decoded.dimensions(), (120, 80));
        assert_eq!(
            decoded.get_pixel(41, 20).0,
            [0, 122, 255, 255],
            "highlight drawn"
        );
        // No staging folder is left behind.
        let leftovers: Vec<_> = std::fs::read_dir(&ws.exports)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().starts_with('.'))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn exports_self_contained_html_and_never_overwrites() {
        let mut ws = workspace();
        let id = playbook(&mut ws);
        let prepared = prepared(&ws, &id, None);
        let first = write_html(&ws.exports, &prepared).unwrap();
        let second = write_html(&ws.exports, &prepared).unwrap();
        assert_ne!(first.file_name, second.file_name);
        assert!(second.file_name.ends_with("-2.html"));
        let html =
            std::fs::read_to_string(locate_export(&ws.exports, &first.relative_path).unwrap())
                .unwrap();
        assert!(html.contains("<h1>Rotate VPN certificate</h1>"));
        assert!(html.contains("Open &lt;Certificates&gt; &amp; check *expiry*"));
        assert!(html.contains("data:image/png;base64,"));
        assert!(!html.contains("<script"));
        assert_eq!(first.byte_size, html.len() as u64);
    }

    #[test]
    fn revisions_export_their_snapshot_not_the_current_draft() {
        let mut ws = workspace();
        let id = playbook(&mut ws);
        let published =
            playbooks::set_status(&mut ws.connection, &id, PlaybookStatus::Published, "First")
                .unwrap();
        let revision_id = published.revisions[0].id.clone();
        playbooks::set_status(&mut ws.connection, &id, PlaybookStatus::Draft, "").unwrap();
        let mut content = published.content.clone();
        content.steps.clear();
        playbooks::save(
            &mut ws.connection,
            &id,
            &PlaybookInput {
                title: "Rotate VPN certificate v2".into(),
                ..PlaybookInput::default()
            },
            &content,
        )
        .unwrap();

        let revision = prepared(&ws, &id, Some(&revision_id));
        assert_eq!(revision.document.title, "Rotate VPN certificate");
        assert_eq!(revision.document.content.steps.len(), 1);
        assert_eq!(revision.base_name.split('-').nth(3), Some("r1"));
        let markdown = markdown::render(
            &revision.document,
            &revision.figures,
            &revision.context,
            IMAGE_DIR,
        );
        assert!(markdown.contains("Published \u{2014} revision 1"));
        assert!(markdown.contains("**Revision note:** First"));
        assert_eq!(
            images::included(&revision.figures),
            1,
            "revision evidence is kept"
        );

        let draft = prepared(&ws, &id, None);
        assert_eq!(draft.document.title, "Rotate VPN certificate v2");
        assert!(draft.document.content.steps.is_empty());
        assert!(
            draft
                .document
                .version
                .status_line()
                .contains("changes after revision 1")
        );

        assert_eq!(
            document::load(&ws.connection, &id, Some(&clock::new_id()))
                .unwrap_err()
                .kind(),
            "not_found"
        );
    }

    #[test]
    fn published_playbooks_export_their_newest_revision_by_default() {
        let mut ws = workspace();
        let id = playbook(&mut ws);
        playbooks::set_status(&mut ws.connection, &id, PlaybookStatus::Published, "").unwrap();
        let document = document::load(&ws.connection, &id, None).unwrap();
        assert!(matches!(
            document.version,
            document::Version::Revision {
                number: 1,
                latest: 1,
                ..
            }
        ));
    }

    #[test]
    fn missing_evidence_is_reported_not_fatal() {
        let mut ws = workspace();
        let id = playbook(&mut ws);
        std::fs::remove_dir_all(ws.assets.join(&id)).unwrap();
        let prepared = prepared(&ws, &id, None);
        let exported = write_html(&ws.exports, &prepared).unwrap();
        assert_eq!((exported.image_count, exported.missing_images), (0, 1));
    }

    #[test]
    fn only_existing_files_inside_the_exports_folder_can_be_revealed() {
        let ws = workspace();
        std::fs::create_dir_all(&ws.exports).unwrap();
        std::fs::write(ws.exports.join("a.html"), "x").unwrap();
        assert!(locate_export(&ws.exports, "a.html").is_ok());
        for bad in [
            "../devtrace.sqlite3",
            "C:/Windows/notepad.exe",
            "",
            ".hidden",
            "a/../../b",
        ] {
            assert_eq!(
                locate_export(&ws.exports, bad).unwrap_err().field(),
                Some("relativePath"),
                "{bad}"
            );
        }
        assert_eq!(
            locate_export(&ws.exports, "missing.html")
                .unwrap_err()
                .kind(),
            "not_found"
        );
    }

    #[test]
    fn finishing_a_pdf_checks_the_signature() {
        let temp = tempfile::tempdir().unwrap();
        let partial = temp.path().join(".x.partial");
        std::fs::write(&partial, b"<html>").unwrap();
        assert!(finish_pdf(&partial, &temp.path().join("x.pdf")).is_err());
        std::fs::write(&partial, b"%PDF-1.7\n").unwrap();
        assert_eq!(finish_pdf(&partial, &temp.path().join("x.pdf")).unwrap(), 9);
        assert!(temp.path().join("x.pdf").exists());
    }
}
