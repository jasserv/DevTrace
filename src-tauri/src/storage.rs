//! Managed evidence files inside the workspace `attachments` folder.
//!
//! Rules enforced here:
//! * Image type is detected from the file *content* (magic bytes), never from its name, and
//!   only PNG, JPEG, GIF and WebP are accepted. Dimensions are read from the header without
//!   decoding pixels.
//! * Files are written atomically (temporary file, flush to disk, rename) so a crash never
//!   leaves a half-written file under its final name.
//! * Every stored relative path is resolved through [`resolve_contained`], which accepts only
//!   plain folder and file names, so a damaged or edited database row cannot point outside the
//!   attachments folder.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::error::{AppError, AppResult};

/// Largest accepted image file.
pub const MAX_IMAGE_BYTES: usize = 25 * 1024 * 1024;
/// Largest accepted width or height, in pixels.
pub const MAX_IMAGE_SIDE: usize = 20_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageFormat {
    Png,
    Jpeg,
    Gif,
    Webp,
}

impl ImageFormat {
    pub fn media_type(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
            Self::Gif => "image/gif",
            Self::Webp => "image/webp",
        }
    }

    pub fn extension(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpeg => "jpg",
            Self::Gif => "gif",
            Self::Webp => "webp",
        }
    }

    /// Strict signature check on the first bytes of the content.
    pub fn detect(bytes: &[u8]) -> Option<Self> {
        if bytes.starts_with(b"\x89PNG\r\n\x1a\n") && bytes.get(12..16) == Some(b"IHDR") {
            Some(Self::Png)
        } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
            Some(Self::Jpeg)
        } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
            Some(Self::Gif)
        } else if bytes.starts_with(b"RIFF")
            && bytes.get(8..12) == Some(b"WEBP")
            && matches!(
                bytes.get(12..16),
                Some(b"VP8 ") | Some(b"VP8L") | Some(b"VP8X")
            )
        {
            Some(Self::Webp)
        } else {
            None
        }
    }
}

/// Facts about an accepted image, derived from its bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InspectedImage {
    pub format: ImageFormat,
    pub width: u32,
    pub height: u32,
    pub byte_size: u64,
    pub sha256: String,
}

/// Validates image bytes and returns their type, dimensions, size and SHA-256 digest.
pub fn inspect_image(bytes: &[u8]) -> AppResult<InspectedImage> {
    if bytes.is_empty() {
        return Err(AppError::validation("file", "The file is empty."));
    }
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(AppError::validation(
            "file",
            format!(
                "The image is {}. Images must be 25 MB or smaller.",
                format_size(bytes.len() as u64)
            ),
        ));
    }
    let format = ImageFormat::detect(bytes).ok_or_else(|| {
        AppError::validation(
            "file",
            "This file is not a supported image. Use a PNG, JPEG, GIF or WebP file.",
        )
    })?;
    let size = imagesize::blob_size(bytes).map_err(|_| {
        AppError::validation(
            "file",
            "The image could not be read. It may be damaged or incomplete.",
        )
    })?;
    if size.width == 0 || size.height == 0 {
        return Err(AppError::validation(
            "file",
            "The image has no visible pixels.",
        ));
    }
    if size.width > MAX_IMAGE_SIDE || size.height > MAX_IMAGE_SIDE {
        return Err(AppError::validation(
            "file",
            format!(
                "The image is {} \u{d7} {} pixels. Images can be at most {MAX_IMAGE_SIDE} pixels wide or tall.",
                size.width, size.height
            ),
        ));
    }
    Ok(InspectedImage {
        format,
        // Both sides are at most MAX_IMAGE_SIDE, so they fit in u32.
        width: size.width as u32,
        height: size.height as u32,
        byte_size: bytes.len() as u64,
        sha256: sha256_hex(bytes),
    })
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for byte in digest.iter() {
        out.push(HEX[usize::from(byte >> 4)] as char);
        out.push(HEX[usize::from(byte & 0x0F)] as char);
    }
    out
}

fn format_size(bytes: u64) -> String {
    let megabytes = bytes as f64 / (1024.0 * 1024.0);
    format!("{megabytes:.1} MB")
}

/// Joins a stored relative path (`/`-separated) onto `root`. Only plain names made of ASCII
/// letters, digits, `-`, `_` and `.` are accepted; each must start with a letter or digit and
/// must not be a reserved Windows device name.
pub fn resolve_contained(root: &Path, relative: &str) -> AppResult<PathBuf> {
    let unsafe_path =
        || AppError::internal(format!("Refusing to use an unsafe file path: {relative:?}"));
    if relative.is_empty() || relative.len() > 255 {
        return Err(unsafe_path());
    }
    let mut path = root.to_path_buf();
    for part in relative.split('/') {
        let plain = part
            .chars()
            .next()
            .is_some_and(|first| first.is_ascii_alphanumeric())
            && part
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
        if !plain || is_reserved_device_name(part) {
            return Err(unsafe_path());
        }
        path.push(part);
    }
    Ok(path)
}

/// True for names Windows reserves for devices (`CON`, `NUL`, `COM1`…), with any extension.
pub fn is_reserved_device_name(part: &str) -> bool {
    let stem = part
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit())
}

/// Writes `bytes` to `target` atomically. Fails if `target` already exists.
pub fn write_atomic(target: &Path, bytes: &[u8]) -> AppResult<()> {
    let parent = target
        .parent()
        .ok_or_else(|| AppError::internal("The target file has no parent folder."))?;
    let name = target
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| AppError::internal("The target file name is not valid."))?;
    fs::create_dir_all(parent)?;
    let temp = parent.join(format!(".{name}.tmp"));

    let result = (|| -> io::Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        if target.exists() {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "a file with this name already exists",
            ));
        }
        fs::rename(&temp, target)
    })();

    if let Err(error) = result {
        let _ = fs::remove_file(&temp);
        return Err(error.into());
    }
    Ok(())
}

/// Removes a file. Returns `Ok(false)` when it was already gone.
pub fn remove_file_if_exists(path: &Path) -> io::Result<bool> {
    match fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

/// Removes a folder and everything in it. Returns `Ok(false)` when it was already gone.
pub fn remove_dir_if_exists(path: &Path) -> io::Result<bool> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

/// Outcome of removing managed files after their database rows were deleted. Failures are
/// reported to the user rather than ignored.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileCleanup {
    /// Files that were deleted.
    pub removed: i64,
    /// Files that were already missing.
    pub missing: i64,
    /// Files that could not be deleted and remain in the workspace folder.
    pub failed: i64,
}

impl FileCleanup {
    fn record(&mut self, path: &Path, result: io::Result<bool>) {
        match result {
            Ok(true) => self.removed += 1,
            Ok(false) => self.missing += 1,
            Err(error) => {
                eprintln!("DevTrace: could not remove {}: {error}", path.display());
                self.failed += 1;
            }
        }
    }
}

/// Removes the files behind deleted attachment rows.
pub fn remove_files(root: &Path, relative_paths: &[String]) -> FileCleanup {
    let mut cleanup = FileCleanup::default();
    for relative in relative_paths {
        match resolve_contained(root, relative) {
            Ok(path) => {
                let result = remove_file_if_exists(&path);
                cleanup.record(&path, result);
            }
            Err(error) => {
                eprintln!("DevTrace: {error}");
                cleanup.failed += 1;
            }
        }
    }
    cleanup
}

/// Removes an attachment folder if it is empty (used after a failed import).
pub fn remove_dir_if_empty(path: &Path) {
    let _ = fs::remove_dir(path);
}

#[cfg(test)]
pub mod test_images {
    //! Minimal image headers for tests. Only the bytes needed for type and size detection.

    pub fn png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR".to_vec();
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend_from_slice(&[8, 6, 0, 0, 0, 0, 0, 0, 0]);
        bytes
    }

    pub fn gif(width: u16, height: u16) -> Vec<u8> {
        let mut bytes = b"GIF89a".to_vec();
        bytes.extend_from_slice(&width.to_le_bytes());
        bytes.extend_from_slice(&height.to_le_bytes());
        bytes.extend_from_slice(&[0, 0, 0, 0, 0, 0]);
        bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_supported_formats_from_content() {
        let png = test_images::png(1280, 720);
        let inspected = inspect_image(&png).unwrap();
        assert_eq!(inspected.format, ImageFormat::Png);
        assert_eq!((inspected.width, inspected.height), (1280, 720));
        assert_eq!(inspected.byte_size, png.len() as u64);
        assert_eq!(inspected.sha256.len(), 64);

        let gif = inspect_image(&test_images::gif(16, 9)).unwrap();
        assert_eq!(gif.format, ImageFormat::Gif);
        assert_eq!(gif.format.media_type(), "image/gif");
        assert_eq!((gif.width, gif.height), (16, 9));
    }

    #[test]
    fn rejects_unsupported_spoofed_and_damaged_content() {
        let html = b"<html><script>alert(1)</script></html>";
        assert_eq!(inspect_image(html).unwrap_err().field(), Some("file"));
        // A bare signature prefix is not enough.
        assert!(inspect_image(b"\x89PNG this is not an image").is_err());
        // Signature without the size fields.
        assert!(inspect_image(b"GIF89a").is_err());
        assert_eq!(
            inspect_image(&[]).unwrap_err().to_string(),
            "The file is empty."
        );
    }

    #[test]
    fn enforces_dimension_and_size_limits() {
        assert!(inspect_image(&test_images::png(20_000, 10)).is_ok());
        let error = inspect_image(&test_images::png(20_001, 10)).unwrap_err();
        assert!(error.to_string().contains("20000 pixels"));
        assert!(inspect_image(&test_images::png(0, 10)).is_err());

        let mut huge = test_images::png(10, 10);
        huge.resize(MAX_IMAGE_BYTES + 1, 0);
        assert!(
            inspect_image(&huge)
                .unwrap_err()
                .to_string()
                .contains("25 MB")
        );
    }

    #[test]
    fn hashes_with_sha256() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn resolves_only_plain_contained_paths() {
        let root = Path::new("C:/workspace/attachments");
        let ok = resolve_contained(root, "0190-aa/0190-bb.png").unwrap();
        assert!(ok.starts_with(root));
        assert!(ok.ends_with("0190-bb.png"));
        for bad in [
            "",
            "../devtrace.sqlite3",
            "a/../../b.png",
            "./a.png",
            "a//b.png",
            "/etc/passwd",
            "C:/Windows/win.ini",
            "a\\b.png",
            ".hidden.png",
            "a/b c.png",
            "s1/CON",
            "s1/nul.png",
            "s1/COM1.jpg",
        ] {
            assert!(resolve_contained(root, bad).is_err(), "accepted {bad:?}");
        }
        assert!(resolve_contained(root, "s1/console.png").is_ok());
    }

    #[test]
    fn writes_atomically_and_never_overwrites() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("session").join("file.png");
        write_atomic(&target, b"first").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"first");
        assert!(write_atomic(&target, b"second").is_err());
        assert_eq!(fs::read(&target).unwrap(), b"first");
        let leftovers: Vec<_> = fs::read_dir(target.parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(leftovers, vec![std::ffi::OsString::from("file.png")]);
    }

    #[test]
    fn removal_reports_removed_missing_and_unsafe_paths() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        write_atomic(&root.join("s1").join("a.png"), b"x").unwrap();
        let cleanup = remove_files(
            root,
            &[
                "s1/a.png".to_string(),
                "s1/gone.png".to_string(),
                "../outside.png".to_string(),
            ],
        );
        assert_eq!(
            cleanup,
            FileCleanup {
                removed: 1,
                missing: 1,
                failed: 1
            }
        );
        assert!(!root.join("s1").join("a.png").exists());
        assert!(remove_dir_if_exists(&root.join("s1")).unwrap());
        assert!(!remove_dir_if_exists(&root.join("s1")).unwrap());
    }
}
