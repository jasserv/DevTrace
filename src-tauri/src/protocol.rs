//! `evidence` URI scheme: serves stored attachment images to the webview by attachment id.
//!
//! URLs look like `evidence://localhost/<attachment-id>` (macOS/Linux) or
//! `http://evidence.localhost/<attachment-id>` (Windows). The id is resolved through the
//! database to a file inside the workspace attachments folder; no path is ever taken from the
//! URL. Responses carry the stored media type, `nosniff`, and `no-store` so evidence is not
//! copied into the webview's disk cache.

use std::borrow::Cow;

use tauri::http::{Method, Request, Response, StatusCode, header};
use tauri::{AppHandle, Manager, Runtime, UriSchemeContext, UriSchemeResponder};

use crate::error::AppError;
use crate::features::{attachments, playbooks};
use crate::state::AppState;
use crate::storage;
use crate::validate;

pub const SCHEME: &str = "evidence";

const SERVABLE_MEDIA_TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

type Body = Cow<'static, [u8]>;

/// Handles a request on a worker thread so file reads never block the event loop.
pub fn handle<R: Runtime>(
    context: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = context.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        responder.respond(respond(&app, &request));
    });
}

fn respond<R: Runtime>(app: &AppHandle<R>, request: &Request<Vec<u8>>) -> Response<Body> {
    let head_only = request.method() == Method::HEAD;
    if request.method() != Method::GET && !head_only {
        return status(
            StatusCode::METHOD_NOT_ALLOWED,
            "Only GET and HEAD are supported.",
        );
    }
    let raw_id = request.uri().path().trim_start_matches('/');
    let Ok(id) = validate::id("id", raw_id) else {
        return status(StatusCode::BAD_REQUEST, "Invalid attachment id.");
    };
    let Some(state) = app.try_state::<AppState>() else {
        return status(StatusCode::SERVICE_UNAVAILABLE, "DevTrace is starting.");
    };

    let located = state.with_db(|connection| match attachments::locate(connection, &id) {
        Ok(stored) => Ok((stored, false)),
        // Playbook evidence copies share the same id space and URL scheme.
        Err(AppError::NotFound { .. }) => {
            playbooks::locate_asset(connection, &id).map(|stored| (stored, true))
        }
        Err(error) => Err(error),
    });
    let (stored, is_asset) = match located {
        Ok(found) => found,
        Err(AppError::NotFound { .. }) => {
            return status(StatusCode::NOT_FOUND, "Attachment not found.");
        }
        Err(AppError::StorageUnavailable(_)) => {
            return status(
                StatusCode::SERVICE_UNAVAILABLE,
                "Local storage is unavailable.",
            );
        }
        Err(error) => {
            eprintln!("DevTrace: evidence lookup failed: {error}");
            return status(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Attachment lookup failed.",
            );
        }
    };
    let root = if is_asset {
        &state.paths.assets_dir
    } else {
        &state.paths.attachments_dir
    };
    let path = match storage::resolve_contained(root, &stored.relative_path) {
        Ok(path) => path,
        Err(error) => {
            eprintln!("DevTrace: {error}");
            return status(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Attachment path is not valid.",
            );
        }
    };
    // Only the image types DevTrace itself stores are ever served, whatever the row says.
    if !SERVABLE_MEDIA_TYPES.contains(&stored.media_type.as_str()) {
        return status(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Unsupported attachment type.",
        );
    }
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return status(
                StatusCode::NOT_FOUND,
                "The attachment file is missing from the workspace.",
            );
        }
        Err(error) => {
            eprintln!("DevTrace: could not read {}: {error}", path.display());
            return status(
                StatusCode::INTERNAL_SERVER_ERROR,
                "The attachment file could not be read.",
            );
        }
    };

    let length = bytes.len();
    let body: Body = if head_only {
        Cow::Borrowed(&[])
    } else {
        Cow::Owned(bytes)
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, stored.media_type)
        .header(header::CONTENT_LENGTH, length)
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CACHE_CONTROL, "no-store")
        .body(body)
        .unwrap_or_else(|_| {
            status(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Response could not be built.",
            )
        })
}

fn status(code: StatusCode, message: &'static str) -> Response<Body> {
    let mut response = Response::new(Cow::Borrowed(message.as_bytes()));
    *response.status_mut() = code;
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        header::HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    response
}
