//! Workspace backup and restore (Milestone 9).
//!
//! A backup is one zip file saved where the user chooses (system save dialog). It contains a
//! consistent copy of the database (`VACUUM INTO`), the evidence folders (`attachments/`,
//! `playbook-assets/`) and the terminal logs (`terminal-logs/`), plus `manifest.json` with the
//! format, app and schema versions, counts, and the size and SHA-256 of every file. Exports
//! (generated output) and earlier backups are not included.
//!
//! Restoring never overwrites data in place. The chosen archive is validated (format, schema
//! version, entry names, sizes) and extracted into a staging folder inside the workspace, where
//! every file is checked against its SHA-256 and the database against `PRAGMA integrity_check`.
//! Only then is the open database closed, the current data moved aside to
//! `backups/before-restore-<time>/` (kept, never deleted) and the staged data moved into place.
//! If the restored database cannot be opened, everything is moved back.

use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, PoisonError};

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::capture::{self, CaptureController, CaptureState};
use crate::clock;
use crate::db::{self, migrations};
use crate::dialogs;
use crate::error::{AppError, AppResult};
use crate::features::settings;
use crate::integrations::file_watch::FileWatches;
use crate::integrations::terminal::TerminalLogs;
use crate::paths::{AppPaths, DATABASE_FILE_NAME};
use crate::state::AppState;

const FORMAT: &str = "devtrace-backup";
const FORMAT_VERSION: u32 = 1;
const MANIFEST_NAME: &str = "manifest.json";
const MANIFEST_MAX_BYTES: u64 = 32 * 1024 * 1024;
/// Workspace folders included in a backup.
const FOLDERS: [&str; 3] = ["attachments", "playbook-assets", "terminal-logs"];
/// Already-compressed formats are stored without compressing them again.
const STORED_EXTENSIONS: [&str; 5] = ["png", "jpg", "jpeg", "gif", "webp"];
/// Entries this large need ZIP64 headers.
const LARGE_FILE: u64 = 0xFFFF_0000;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupCounts {
    pub projects: u64,
    pub sessions: u64,
    pub playbooks: u64,
    pub changes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupFile {
    /// Path inside the archive and the workspace, with `/` separators.
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

/// `manifest.json`: what the backup contains.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub format: String,
    pub format_version: u32,
    pub app_version: String,
    pub schema_version: u32,
    pub created_at: String,
    pub workspace_name: String,
    pub counts: BackupCounts,
    /// The database copy and every included file.
    pub files: Vec<BackupFile>,
}

impl Manifest {
    fn total_bytes(&self) -> u64 {
        self.files.iter().map(|file| file.size).sum()
    }
}

/// Facts about the workspace read while the database copy is made.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    pub schema_version: u32,
    pub workspace_name: String,
    pub counts: BackupCounts,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupResult {
    pub file_name: String,
    /// Where the backup was saved (shown to the user, who chose it).
    pub path: String,
    pub size_bytes: u64,
    pub file_count: usize,
    pub created_at: String,
}

/// A validated backup waiting for the user's confirmation.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    /// Confirms this backup in `restore_backup`; the path itself stays in the backend.
    pub token: String,
    pub file_name: String,
    pub size_bytes: u64,
    pub created_at: String,
    pub app_version: String,
    pub schema_version: u32,
    pub workspace_name: String,
    pub counts: BackupCounts,
    pub file_count: usize,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    /// Where the replaced data was kept, relative to the workspace.
    pub previous_data: String,
    pub schema_version: u32,
}

struct PendingRestore {
    token: String,
    path: PathBuf,
    manifest: Manifest,
}

/// Managed state: the backup chosen for restoring, the last backup written, and a flag so only
/// one backup or restore runs at a time.
#[derive(Default)]
pub struct BackupState {
    pending: Mutex<Option<PendingRestore>>,
    last_backup: Mutex<Option<PathBuf>>,
    running: AtomicBool,
}

/// Clears the running flag when the backup or restore ends.
struct Running<'a>(&'a AtomicBool);

impl Drop for Running<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl BackupState {
    fn begin(&self) -> AppResult<Running<'_>> {
        if self.running.swap(true, Ordering::SeqCst) {
            return Err(AppError::conflict(
                "backup",
                "A backup or restore is already running.",
            ));
        }
        Ok(Running(&self.running))
    }
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::validation("backup", message)
}

fn damaged(detail: impl std::fmt::Display) -> AppError {
    invalid(format!(
        "This file is not a usable DevTrace backup ({detail})."
    ))
}

/// Copies everything written through it into a SHA-256 hash.
struct Hashing<W> {
    inner: W,
    hasher: Sha256,
    written: u64,
}

impl<W: Write> Hashing<W> {
    fn new(inner: W) -> Self {
        Self {
            inner,
            hasher: Sha256::new(),
            written: 0,
        }
    }

    fn finish(self) -> (W, String, u64) {
        let digest = self.hasher.finalize();
        let hex = digest.iter().map(|byte| format!("{byte:02x}")).collect();
        (self.inner, hex, self.written)
    }
}

impl<W: Write> Write for Hashing<W> {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let count = self.inner.write(buffer)?;
        self.hasher.update(&buffer[..count]);
        self.written += count as u64;
        Ok(count)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

fn count(connection: &Connection, table: &str) -> AppResult<u64> {
    let total: i64 = connection.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
        row.get(0)
    })?;
    Ok(u64::try_from(total).unwrap_or_default())
}

/// Writes a consistent copy of the database to `target` and reads what the manifest needs.
pub fn snapshot(connection: &Connection, target: &Path) -> AppResult<Snapshot> {
    if target.exists() {
        return Err(AppError::internal(format!(
            "A temporary backup file already exists: {}",
            target.display()
        )));
    }
    connection.execute("VACUUM INTO ?1", [target.to_string_lossy().as_ref()])?;
    Ok(Snapshot {
        schema_version: migrations::current_version(connection)?,
        workspace_name: settings::load(connection)?.workspace_name,
        counts: BackupCounts {
            projects: count(connection, "projects")?,
            sessions: count(connection, "sessions")?,
            playbooks: count(connection, "playbooks")?,
            changes: count(connection, "change_records")?,
        },
    })
}

/// Files below `dir` (recursively, sorted), as paths relative to `dir`. Symbolic links are not
/// followed or included.
fn files_below(dir: &Path) -> io::Result<Vec<PathBuf>> {
    let mut found = Vec::new();
    if !dir.is_dir() {
        return Ok(found);
    }
    let mut pending = vec![PathBuf::new()];
    while let Some(relative) = pending.pop() {
        let mut entries: Vec<_> = fs::read_dir(dir.join(&relative))?.collect::<Result<_, _>>()?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let kind = entry.file_type()?;
            let path = relative.join(entry.file_name());
            if kind.is_dir() {
                pending.push(path);
            } else if kind.is_file() {
                found.push(path);
            }
        }
    }
    found.sort();
    Ok(found)
}

fn archive_name(folder: &str, relative: &Path) -> AppResult<String> {
    let mut name = folder.to_string();
    for component in relative.components() {
        let std::path::Component::Normal(part) = component else {
            return Err(AppError::internal("Unexpected path in the workspace."));
        };
        let part = part
            .to_str()
            .ok_or_else(|| AppError::internal("A workspace file name is not valid Unicode."))?;
        name.push('/');
        name.push_str(part);
    }
    Ok(name)
}

fn options_for(name: &str, size: u64) -> SimpleFileOptions {
    let extension = name
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let method = if STORED_EXTENSIONS.contains(&extension.as_str()) {
        CompressionMethod::Stored
    } else {
        CompressionMethod::Deflated
    };
    SimpleFileOptions::default()
        .compression_method(method)
        .large_file(size >= LARGE_FILE)
}

fn add_file<W: Write + io::Seek>(
    zip: &mut ZipWriter<W>,
    name: &str,
    source: &Path,
) -> AppResult<BackupFile> {
    let size = fs::metadata(source)?.len();
    zip.start_file(name, options_for(name, size))
        .map_err(|error| AppError::internal(format!("Could not write the backup: {error}")))?;
    let mut hashing = Hashing::new(&mut *zip);
    io::copy(&mut BufReader::new(File::open(source)?), &mut hashing)?;
    let (_, sha256, written) = hashing.finish();
    Ok(BackupFile {
        path: name.to_string(),
        size: written,
        sha256,
    })
}

/// Writes the backup archive to `target` (through a temporary file next to it).
pub fn write_archive(
    paths: &AppPaths,
    database_copy: &Path,
    snapshot: &Snapshot,
    target: &Path,
    app_version: &str,
) -> AppResult<BackupResult> {
    let file_name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .ok_or_else(|| invalid("Choose a file name for the backup."))?;
    let partial = target.with_file_name(format!("{file_name}.partial"));
    let created_at = clock::now();
    let written = (|| -> AppResult<Manifest> {
        let mut zip = ZipWriter::new(BufWriter::new(File::create(&partial)?));
        let mut files = vec![add_file(&mut zip, DATABASE_FILE_NAME, database_copy)?];
        for folder in FOLDERS {
            let root = paths.data_dir.join(folder);
            for relative in files_below(&root)? {
                let name = archive_name(folder, &relative)?;
                files.push(add_file(&mut zip, &name, &root.join(&relative))?);
            }
        }
        let manifest = Manifest {
            format: FORMAT.into(),
            format_version: FORMAT_VERSION,
            app_version: app_version.into(),
            schema_version: snapshot.schema_version,
            created_at: created_at.clone(),
            workspace_name: snapshot.workspace_name.clone(),
            counts: snapshot.counts.clone(),
            files,
        };
        let json = serde_json::to_vec_pretty(&manifest)
            .map_err(|error| AppError::internal(error.to_string()))?;
        zip.start_file(MANIFEST_NAME, options_for(MANIFEST_NAME, json.len() as u64))
            .map_err(|error| AppError::internal(format!("Could not write the backup: {error}")))?;
        zip.write_all(&json)?;
        let writer = zip
            .finish()
            .map_err(|error| AppError::internal(format!("Could not write the backup: {error}")))?;
        let file = writer
            .into_inner()
            .map_err(|error| AppError::internal(format!("Could not write the backup: {error}")))?;
        file.sync_all()?;
        Ok(manifest)
    })();
    let manifest = match written {
        Ok(manifest) => manifest,
        Err(error) => {
            let _ = fs::remove_file(&partial);
            return Err(error);
        }
    };
    if let Err(error) = fs::rename(&partial, target) {
        let _ = fs::remove_file(&partial);
        return Err(error.into());
    }
    Ok(BackupResult {
        file_name,
        path: target.display().to_string(),
        size_bytes: fs::metadata(target)?.len(),
        file_count: manifest.files.len(),
        created_at,
    })
}

/// True for `devtrace.sqlite3` and `<folder>/<name>[/<name>…]` with plain names only.
fn safe_entry_path(path: &str) -> bool {
    if path == DATABASE_FILE_NAME {
        return true;
    }
    let mut parts = path.split('/');
    let Some(first) = parts.next() else {
        return false;
    };
    if !FOLDERS.contains(&first) {
        return false;
    }
    let mut rest = 0;
    for part in parts {
        rest += 1;
        let plain = !part.is_empty()
            && part != "."
            && part != ".."
            && part.len() <= 255
            && !part
                .chars()
                .any(|character| matches!(character, '\\' | ':' | '\0') || character.is_control());
        if !plain {
            return false;
        }
    }
    rest > 0
}

fn is_sha256(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn validate_manifest(manifest: &Manifest) -> AppResult<()> {
    if manifest.format != FORMAT {
        return Err(damaged("it has no DevTrace manifest"));
    }
    if manifest.format_version > FORMAT_VERSION {
        return Err(invalid(
            "This backup was made by a newer version of DevTrace. Update DevTrace to restore it.",
        ));
    }
    if manifest.format_version == 0 {
        return Err(damaged("unknown format version"));
    }
    let latest = migrations::latest_version();
    if manifest.schema_version > latest {
        return Err(invalid(format!(
            "This backup uses database schema version {}, but this version of DevTrace supports up to version {latest}. Update DevTrace to restore it.",
            manifest.schema_version
        )));
    }
    if manifest.schema_version == 0 {
        return Err(damaged("unknown database version"));
    }
    let mut seen = HashSet::new();
    for file in &manifest.files {
        if !safe_entry_path(&file.path) || !is_sha256(&file.sha256) {
            return Err(damaged(format!("unexpected entry {:?}", file.path)));
        }
        if !seen.insert(file.path.to_ascii_lowercase()) {
            return Err(damaged(format!("duplicate entry {:?}", file.path)));
        }
    }
    if !seen.contains(DATABASE_FILE_NAME) {
        return Err(damaged("it contains no database"));
    }
    Ok(())
}

/// Reads and validates the manifest, and checks that the archive holds exactly the listed files.
pub fn read_manifest(path: &Path) -> AppResult<Manifest> {
    let file = File::open(path)
        .map_err(|error| invalid(format!("The backup cannot be opened: {error}.")))?;
    let mut archive = ZipArchive::new(BufReader::new(file)).map_err(damaged)?;
    let manifest: Manifest = {
        let entry = archive
            .by_name(MANIFEST_NAME)
            .map_err(|_| damaged("it has no DevTrace manifest"))?;
        let mut json = Vec::new();
        entry.take(MANIFEST_MAX_BYTES + 1).read_to_end(&mut json)?;
        if json.len() as u64 > MANIFEST_MAX_BYTES {
            return Err(damaged("the manifest is too large"));
        }
        serde_json::from_slice(&json).map_err(|error| damaged(format!("manifest: {error}")))?
    };
    validate_manifest(&manifest)?;
    let listed: std::collections::HashMap<&str, &BackupFile> = manifest
        .files
        .iter()
        .map(|file| (file.path.as_str(), file))
        .collect();
    let mut present = HashSet::new();
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(damaged)?;
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().map_err(damaged)?.into_owned();
        if name == MANIFEST_NAME {
            continue;
        }
        let Some(expected) = listed.get(name.as_str()) else {
            return Err(damaged(format!("unlisted entry {name:?}")));
        };
        if entry.enclosed_name().is_none() || entry.is_symlink() || entry.encrypted() {
            return Err(damaged(format!("unsafe entry {name:?}")));
        }
        if entry.size() != expected.size {
            return Err(damaged(format!("{name} has an unexpected size")));
        }
        present.insert(name);
    }
    if let Some(missing) = manifest
        .files
        .iter()
        .find(|file| !present.contains(&file.path))
    {
        return Err(damaged(format!("{} is missing", missing.path)));
    }
    Ok(manifest)
}

fn workspace_path(root: &Path, entry: &str) -> PathBuf {
    entry
        .split('/')
        .fold(root.to_path_buf(), |path, part| path.join(part))
}

/// Extracts every listed file into `staging` (which must not exist yet), verifying sizes and
/// checksums, then checks the database copy.
pub fn extract(path: &Path, manifest: &Manifest, staging: &Path) -> AppResult<()> {
    if staging.exists() {
        return Err(AppError::internal(format!(
            "The restore folder already exists: {}",
            staging.display()
        )));
    }
    fs::create_dir_all(staging)?;
    for folder in FOLDERS {
        fs::create_dir_all(staging.join(folder))?;
    }
    let mut archive = ZipArchive::new(BufReader::new(File::open(path)?)).map_err(damaged)?;
    for file in &manifest.files {
        let target = workspace_path(staging, &file.path);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        let entry = archive.by_name(&file.path).map_err(damaged)?;
        let mut hashing = Hashing::new(BufWriter::new(File::create(&target)?));
        io::copy(&mut entry.take(file.size + 1), &mut hashing)
            .map_err(|error| damaged(format!("{}: {error}", file.path)))?;
        let (writer, sha256, written) = hashing.finish();
        writer
            .into_inner()
            .map_err(|error| AppError::internal(error.to_string()))?
            .sync_all()?;
        if written != file.size || sha256 != file.sha256 {
            return Err(damaged(format!(
                "{} does not match its checksum",
                file.path
            )));
        }
    }
    let database = staging.join(DATABASE_FILE_NAME);
    let connection = Connection::open_with_flags(&database, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| damaged(format!("database: {error}")))?;
    let integrity: String = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|error| damaged(format!("database: {error}")))?;
    if integrity != "ok" {
        return Err(damaged(format!("database: {integrity}")));
    }
    if migrations::current_version(&connection)? != manifest.schema_version {
        return Err(damaged("the database version does not match the manifest"));
    }
    Ok(())
}

/// Record of the moves made by `swap_in`, so they can be undone.
#[derive(Debug, Default)]
pub struct Swap {
    /// (original location, where it was moved aside)
    moved_aside: Vec<(PathBuf, PathBuf)>,
    /// (staged location, where it was placed)
    placed: Vec<(PathBuf, PathBuf)>,
}

impl Swap {
    /// Puts everything back where it was. Best effort: continues after a failed move and
    /// reports the first error.
    pub fn undo(self) -> io::Result<()> {
        let mut first_error = None;
        for (staged, placed) in self.placed.into_iter().rev() {
            if let Err(error) = fs::rename(&placed, &staged) {
                first_error.get_or_insert(error);
            }
        }
        for (original, aside) in self.moved_aside.into_iter().rev() {
            if let Err(error) = fs::rename(&aside, &original) {
                first_error.get_or_insert(error);
            }
        }
        first_error.map_or(Ok(()), Err)
    }
}

/// Moves the current database and folders into `previous` and the staged ones into place.
/// The database must be closed. On failure, the moves made so far are undone.
pub fn swap_in(paths: &AppPaths, staging: &Path, previous: &Path) -> AppResult<Swap> {
    let mut swap = Swap::default();
    let result = (|| -> io::Result<()> {
        fs::create_dir_all(previous)?;
        let database_name = DATABASE_FILE_NAME.to_string();
        let mut current = vec![
            database_name.clone(),
            format!("{database_name}-wal"),
            format!("{database_name}-shm"),
        ];
        current.extend(FOLDERS.iter().map(|folder| folder.to_string()));
        for name in &current {
            let original = paths.data_dir.join(name);
            if original.exists() {
                let aside = previous.join(name);
                fs::rename(&original, &aside)?;
                swap.moved_aside.push((original, aside));
            }
        }
        let mut staged = vec![database_name];
        staged.extend(FOLDERS.iter().map(|folder| folder.to_string()));
        for name in staged {
            let from = staging.join(&name);
            let to = paths.data_dir.join(&name);
            fs::rename(&from, &to)?;
            swap.placed.push((from, to));
        }
        Ok(())
    })();
    match result {
        Ok(()) => Ok(swap),
        Err(error) => {
            let undo = std::mem::take(&mut swap).undo();
            Err(AppError::internal(match undo {
                Ok(()) => {
                    format!("The backup could not be put in place; nothing was changed ({error}).")
                }
                Err(undo_error) => format!(
                    "The backup could not be put in place ({error}), and moving the previous data back failed ({undo_error}). Your previous data is in {}.",
                    previous.display()
                ),
            }))
        }
    }
}

fn unique_folder(parent: &Path, base: &str) -> PathBuf {
    let mut candidate = parent.join(base);
    let mut number = 2;
    while candidate.exists() {
        candidate = parent.join(format!("{base}-{number}"));
        number += 1;
    }
    candidate
}

fn time_stamp() -> String {
    chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string()
}

/// Replaces the workspace with the validated backup. Runs with the database lock held: the
/// connection is closed, data swapped, and the restored database opened (and migrated) again.
pub fn restore(state: &AppState, path: &Path, manifest: &Manifest) -> AppResult<RestoreResult> {
    let paths = state.paths.clone();
    let stamp = time_stamp();
    let staging = unique_folder(&paths.backups_dir, &format!("restore-staging-{stamp}"));
    if let Err(error) = extract(path, manifest, &staging) {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    let previous = unique_folder(&paths.backups_dir, &format!("before-restore-{stamp}"));
    let outcome = state.replace_database(|connection| {
        // Closing the connection checkpoints and removes the write-ahead log.
        drop(connection);
        let swap = match swap_in(&paths, &staging, &previous) {
            Ok(swap) => swap,
            Err(error) => return (db::open(&paths).ok(), Err(error)),
        };
        match db::open(&paths) {
            Ok(connection) => {
                let version = migrations::current_version(&connection).unwrap_or_default();
                (Some(connection), Ok(version))
            }
            Err(error) => {
                let undo = swap.undo();
                let message = match undo {
                    Ok(()) => format!(
                        "The restored database could not be opened; your previous data was put back ({error})."
                    ),
                    Err(undo_error) => format!(
                        "The restored database could not be opened ({error}) and moving the previous data back failed ({undo_error}). Your previous data is in {}.",
                        previous.display()
                    ),
                };
                (db::open(&paths).ok(), Err(AppError::internal(message)))
            }
        }
    });
    // The staging folder only ever holds copies extracted from the backup.
    let _ = fs::remove_dir_all(&staging);
    let schema_version = outcome?;
    let name = previous
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(RestoreResult {
        previous_data: format!("backups/{name}"),
        schema_version,
    })
}

fn ensure_no_capture(app: &AppHandle, action: &str) -> AppResult<()> {
    if app.state::<CaptureController>().status().state == CaptureState::Idle {
        Ok(())
    } else {
        Err(AppError::conflict(
            "capture",
            format!("Stop the capture before {action}."),
        ))
    }
}

fn default_file_name() -> String {
    format!(
        "DevTrace backup {}.zip",
        chrono::Local::now().format("%Y-%m-%d %H%M")
    )
}

async fn blocking<T: Send + 'static>(
    task: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| AppError::internal(format!("A background backup task failed: {error}")))?
}

// ---------------------------------------------------------------------------------------------
// Commands

/// Saves a backup of the workspace where the user chooses. `None` when the dialog was cancelled.
#[tauri::command]
pub async fn create_backup(
    app: AppHandle,
    backups: State<'_, BackupState>,
) -> AppResult<Option<BackupResult>> {
    ensure_no_capture(&app, "backing up, so every screenshot is included")?;
    let _running = backups.begin()?;
    let handle = app.clone();
    let Some(chosen) = blocking(move || {
        Ok(dialogs::save_file(
            &handle,
            "Save a backup of the DevTrace workspace",
            &default_file_name(),
            ("DevTrace backup", &["zip"]),
            dialogs::SAVE_BACKUP_ENV,
        ))
    })
    .await?
    else {
        return Ok(None);
    };
    let target = if chosen
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
    {
        chosen
    } else {
        PathBuf::from(format!("{}.zip", chosen.display()))
    };
    let state = app.state::<AppState>();
    let paths = state.paths.clone();
    let target = std::path::absolute(&target)?;
    if FOLDERS
        .iter()
        .any(|folder| target.starts_with(paths.data_dir.join(folder)))
    {
        return Err(invalid(
            "Save the backup outside the workspace's evidence folders, for example on another drive.",
        ));
    }
    let app_version = app.package_info().version.to_string();
    let handle = app.clone();
    let saved_to = target.clone();
    let result = blocking(move || {
        let state = handle.state::<AppState>();
        let copy = paths
            .backups_dir
            .join(format!(".backup-{}.sqlite3", clock::new_id()));
        fs::create_dir_all(&paths.backups_dir)?;
        let written = state
            .with_db(|connection| snapshot(connection, &copy))
            .and_then(|snapshot| write_archive(&paths, &copy, &snapshot, &target, &app_version));
        let _ = fs::remove_file(&copy);
        written
    })
    .await?;
    *backups
        .last_backup
        .lock()
        .unwrap_or_else(PoisonError::into_inner) = Some(saved_to);
    Ok(Some(result))
}

/// Shows the last backup in the system file manager.
#[tauri::command]
pub async fn reveal_backup(app: AppHandle, backups: State<'_, BackupState>) -> AppResult<()> {
    let path = backups
        .last_backup
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone()
        .filter(|path| path.is_file())
        .ok_or_else(|| AppError::not_found("Backup", ""))?;
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|error| AppError::internal(format!("Could not show the backup: {error}")))
}

/// Lets the user pick a backup and validates it. Nothing changes until `restore_backup`.
#[tauri::command]
pub async fn choose_backup(
    app: AppHandle,
    backups: State<'_, BackupState>,
) -> AppResult<Option<BackupInfo>> {
    let handle = app.clone();
    let Some(path) = blocking(move || {
        Ok(dialogs::pick_file(
            &handle,
            "Choose a DevTrace backup to restore",
            Some(("DevTrace backup", &["zip"])),
            dialogs::PICK_BACKUP_ENV,
        ))
    })
    .await?
    else {
        return Ok(None);
    };
    let checked = path.clone();
    let manifest = blocking(move || read_manifest(&checked)).await?;
    let token = clock::new_id();
    let info = BackupInfo {
        token: token.clone(),
        file_name: path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        size_bytes: fs::metadata(&path)
            .map(|metadata| metadata.len())
            .unwrap_or_default(),
        created_at: manifest.created_at.clone(),
        app_version: manifest.app_version.clone(),
        schema_version: manifest.schema_version,
        workspace_name: manifest.workspace_name.clone(),
        counts: manifest.counts.clone(),
        file_count: manifest.files.len(),
        total_bytes: manifest.total_bytes(),
    };
    *backups
        .pending
        .lock()
        .unwrap_or_else(PoisonError::into_inner) = Some(PendingRestore {
        token,
        path,
        manifest,
    });
    Ok(Some(info))
}

/// Restores the backup confirmed by `token`. The current data is kept in `backups/`.
#[tauri::command]
pub async fn restore_backup(
    app: AppHandle,
    backups: State<'_, BackupState>,
    token: String,
) -> AppResult<RestoreResult> {
    ensure_no_capture(&app, "restoring a backup")?;
    let pending = {
        let mut pending = backups
            .pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        match pending.take() {
            Some(chosen) if chosen.token == token => chosen,
            other => {
                *pending = other;
                return Err(AppError::conflict(
                    "token",
                    "Choose the backup again; the selection has expired.",
                ));
            }
        }
    };
    let _running = backups.begin()?;
    // Integrations write into the workspace; stop them before its data is replaced.
    app.state::<TerminalLogs>().stop_all();
    app.state::<FileWatches>().stop_all();
    let handle = app.clone();
    let result = blocking(move || {
        let state = handle.state::<AppState>();
        restore(&state, &pending.path, &pending.manifest)
    })
    .await?;
    if let Ok(loaded) = app
        .state::<AppState>()
        .with_db(|connection| settings::load(connection))
    {
        capture::shortcut_changed(&app, &loaded.capture_shortcut);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn workspace(root: &Path) -> (AppPaths, Connection) {
        let paths = AppPaths::from_root(root);
        paths.ensure_dirs().unwrap();
        let connection = db::open(&paths).unwrap();
        connection
            .execute(
                "INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1', 'Core network', 't', 't')",
                [],
            )
            .unwrap();
        fs::create_dir_all(paths.attachments_dir.join("s1")).unwrap();
        fs::write(
            paths.attachments_dir.join("s1").join("a1.png"),
            b"\x89PNG fake",
        )
        .unwrap();
        fs::create_dir_all(paths.terminal_logs_dir.join("s1")).unwrap();
        fs::write(
            paths.terminal_logs_dir.join("s1").join("l1.log"),
            "PS C:\\> Get-Date\r\n",
        )
        .unwrap();
        fs::write(paths.exports_dir.join("guide.html"), "<html></html>").unwrap();
        (paths, connection)
    }

    fn backup(paths: &AppPaths, connection: &Connection, target: &Path) -> BackupResult {
        let copy = paths.backups_dir.join(".copy.sqlite3");
        let snapshot = snapshot(connection, &copy).unwrap();
        let result = write_archive(paths, &copy, &snapshot, target, "0.1.0").unwrap();
        fs::remove_file(copy).unwrap();
        result
    }

    /// Rewrites an archive, letting `edit` change the manifest and add raw entries.
    fn rewrite(
        source: &Path,
        target: &Path,
        edit: impl FnOnce(&mut Manifest),
        extra: &[(&str, &[u8])],
    ) {
        let mut manifest = read_manifest(source).unwrap();
        edit(&mut manifest);
        let mut archive = ZipArchive::new(File::open(source).unwrap()).unwrap();
        let mut zip = ZipWriter::new(File::create(target).unwrap());
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).unwrap();
            let name = entry.name().unwrap().into_owned();
            if name == MANIFEST_NAME {
                continue;
            }
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).unwrap();
            zip.start_file(name, SimpleFileOptions::default()).unwrap();
            zip.write_all(&bytes).unwrap();
        }
        for (name, bytes) in extra {
            zip.start_file(*name, SimpleFileOptions::default()).unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.start_file(MANIFEST_NAME, SimpleFileOptions::default())
            .unwrap();
        zip.write_all(&serde_json::to_vec(&manifest).unwrap())
            .unwrap();
        zip.finish().unwrap();
    }

    #[test]
    fn a_backup_contains_the_database_evidence_and_logs_but_not_exports() {
        let temp = tempfile::tempdir().unwrap();
        let (paths, connection) = workspace(&temp.path().join("workspace"));
        let target = temp.path().join("backup.zip");
        let result = backup(&paths, &connection, &target);
        assert!(target.is_file());
        assert!(!temp.path().join("backup.zip.partial").exists());
        assert_eq!(result.file_count, 3);

        let manifest = read_manifest(&target).unwrap();
        assert_eq!(manifest.format, FORMAT);
        assert_eq!(manifest.schema_version, migrations::latest_version());
        assert_eq!(manifest.counts.projects, 1);
        let names: Vec<&str> = manifest
            .files
            .iter()
            .map(|file| file.path.as_str())
            .collect();
        assert_eq!(
            names,
            [
                DATABASE_FILE_NAME,
                "attachments/s1/a1.png",
                "terminal-logs/s1/l1.log"
            ]
        );
        let png = manifest
            .files
            .iter()
            .find(|file| file.path.ends_with(".png"))
            .unwrap();
        assert_eq!(png.size, 9);
        assert!(is_sha256(&png.sha256));
    }

    #[test]
    fn restoring_replaces_the_workspace_and_keeps_the_previous_data() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("workspace");
        let (paths, connection) = workspace(&root);
        let target = temp.path().join("backup.zip");
        backup(&paths, &connection, &target);

        // Work continues after the backup.
        connection
            .execute(
                "INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p2', 'Later', 't', 't')",
                [],
            )
            .unwrap();
        fs::write(paths.attachments_dir.join("s1").join("a2.png"), b"later").unwrap();
        let state = AppState::ready(connection, paths.clone());

        let manifest = read_manifest(&target).unwrap();
        let result = restore(&state, &target, &manifest).unwrap();
        assert_eq!(result.schema_version, migrations::latest_version());
        let names: Vec<String> = state
            .with_db(|connection| {
                let mut statement =
                    connection.prepare("SELECT name FROM projects ORDER BY name")?;
                let rows = statement.query_map([], |row| row.get(0))?;
                Ok(rows.collect::<Result<Vec<String>, _>>()?)
            })
            .unwrap();
        assert_eq!(names, ["Core network"]);
        assert!(paths.attachments_dir.join("s1").join("a1.png").is_file());
        assert!(!paths.attachments_dir.join("s1").join("a2.png").exists());
        assert!(paths.terminal_logs_dir.join("s1").join("l1.log").is_file());

        // The replaced data is kept, and nothing is left in staging.
        let previous = root.join(&result.previous_data);
        assert!(previous.join(DATABASE_FILE_NAME).is_file());
        assert!(
            previous
                .join("attachments")
                .join("s1")
                .join("a2.png")
                .is_file()
        );
        let leftovers: Vec<_> = fs::read_dir(&paths.backups_dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("restore-staging")
            })
            .collect();
        assert!(leftovers.is_empty());
        // Exports are not part of a backup and stay where they were.
        assert!(paths.exports_dir.join("guide.html").is_file());
    }

    #[test]
    fn damaged_or_unsafe_backups_are_refused_before_anything_changes() {
        let temp = tempfile::tempdir().unwrap();
        let (paths, connection) = workspace(&temp.path().join("workspace"));
        let good = temp.path().join("good.zip");
        backup(&paths, &connection, &good);

        // A file that does not match its checksum is refused while extracting.
        let tampered = temp.path().join("tampered.zip");
        rewrite(
            &good,
            &tampered,
            |manifest| {
                let png = manifest
                    .files
                    .iter_mut()
                    .find(|file| file.path.ends_with(".png"))
                    .unwrap();
                png.sha256 = "0".repeat(64);
            },
            &[],
        );
        let manifest = read_manifest(&tampered).unwrap();
        let staging = temp.path().join("staging");
        let error = extract(&tampered, &manifest, &staging).unwrap_err();
        assert!(error.to_string().contains("checksum"), "{error}");

        // Entries outside the expected folders, or not listed, are refused.
        let escaping = temp.path().join("escaping.zip");
        rewrite(&good, &escaping, |_| {}, &[("../outside.txt", b"x")]);
        assert!(read_manifest(&escaping).is_err());
        let unlisted = temp.path().join("unlisted.zip");
        rewrite(&good, &unlisted, |_| {}, &[("attachments/extra.png", b"x")]);
        assert!(
            read_manifest(&unlisted)
                .unwrap_err()
                .to_string()
                .contains("unlisted")
        );

        // A backup from a newer schema is refused with an explanation.
        let newer = temp.path().join("newer.zip");
        rewrite(&good, &newer, |manifest| manifest.schema_version += 1, &[]);
        assert!(
            read_manifest(&newer)
                .unwrap_err()
                .to_string()
                .contains("Update DevTrace")
        );

        // Not a zip at all.
        let text = temp.path().join("notes.zip");
        fs::write(&text, "not a zip").unwrap();
        assert!(read_manifest(&text).is_err());
        assert!(ZipArchive::new(Cursor::new(b"nope".to_vec())).is_err());
    }

    #[test]
    fn entry_paths_must_stay_inside_the_backed_up_folders() {
        assert!(safe_entry_path(DATABASE_FILE_NAME));
        assert!(safe_entry_path("attachments/s1/a1.png"));
        assert!(safe_entry_path("terminal-logs/s1/l1.log"));
        assert!(!safe_entry_path("attachments"));
        assert!(!safe_entry_path("attachments/"));
        assert!(!safe_entry_path("exports/guide.html"));
        assert!(!safe_entry_path("attachments/../devtrace.sqlite3"));
        assert!(!safe_entry_path("/attachments/a.png"));
        assert!(!safe_entry_path("attachments/C:/a.png"));
        assert!(!safe_entry_path("attachments/a\\b.png"));
    }

    #[test]
    fn a_failed_swap_puts_everything_back() {
        let temp = tempfile::tempdir().unwrap();
        let (paths, connection) = workspace(&temp.path().join("workspace"));
        drop(connection);
        // The staging folder lacks the database, so placing it fails after the current data
        // was moved aside.
        let staging = temp.path().join("staging");
        fs::create_dir_all(staging.join("attachments")).unwrap();
        let previous = temp.path().join("previous");
        let error = swap_in(&paths, &staging, &previous).unwrap_err();
        assert!(error.to_string().contains("nothing was changed"), "{error}");
        assert!(paths.database_file.is_file());
        assert!(paths.attachments_dir.join("s1").join("a1.png").is_file());
        assert!(paths.terminal_logs_dir.join("s1").join("l1.log").is_file());
    }
}
