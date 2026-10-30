import { convertFileSrc } from "@tauri-apps/api/core";

import { call } from "./client";
import type {
  Annotation,
  AppInfo,
  AppSettings,
  ApprovalState,
  Attachment,
  AttachmentDeletion,
  BackupInfo,
  BackupResult,
  CapturedShot,
  CaptureStatus,
  CaptureTarget,
  ChangeInput,
  ChangeRecord,
  EventDeletion,
  EventInput,
  EventReviewStatus,
  EventType,
  ExportFormat,
  ExportResult,
  FileWatchStatus,
  ImageImportOptions,
  ImportedImage,
  Integration,
  LogFormat,
  NotesSaved,
  Overview,
  PlaybookContent,
  PlaybookDeletion,
  PlaybookDetail,
  PlaybookInput,
  PlaybookStatus,
  PlaybookSummary,
  Project,
  ProjectDeletion,
  ProjectInput,
  Redaction,
  Region,
  RestorePointDetail,
  RestoreResult,
  ReviewDecision,
  ReviewSummary,
  RevisionDetail,
  SessionDeletion,
  SessionDetail,
  SessionEvent,
  SessionInput,
  SessionStatus,
  SessionSummary,
  SettingsPatch,
  TerminalLogStatus,
  VersionRef,
} from "./types";

export { ApiError, toApiError, hasDesktopRuntime } from "./client";
export type * from "./types";

/** Header values must be ISO-8859-1; text travels percent-encoded and is decoded in Rust. */
function importHeaders(options: ImageImportOptions): Record<string, string> {
  const headers: Record<string, string> = {
    "x-session-id": options.sessionId,
    "x-source": options.source,
  };
  if (options.eventId) headers["x-event-id"] = options.eventId;
  if (options.title) headers["x-title"] = encodeURIComponent(options.title);
  if (options.fileName) headers["x-file-name"] = encodeURIComponent(options.fileName);
  return headers;
}

/**
 * URL of a stored attachment image, served by the `evidence` URI scheme. The backend resolves
 * the id through the database; no file path is exposed to the webview. `version` (the file's
 * SHA-256) changes when the image is replaced, for example after redaction.
 */
export function evidenceUrl(attachmentId: string, version?: string): string {
  const url = convertFileSrc(attachmentId, "evidence");
  return version ? `${url}?v=${encodeURIComponent(version.slice(0, 16))}` : url;
}

/**
 * Typed backend API. Each function maps 1:1 to a Tauri command in src-tauri/src/features.
 * Functions are module-level constants, so they are referentially stable for hooks.
 */
export const api = {
  app: {
    info: () => call<AppInfo>("get_app_info"),
    revealDataDirectory: () => call<void>("reveal_data_directory"),
  },
  settings: {
    get: () => call<AppSettings>("get_settings"),
    update: (patch: SettingsPatch) => call<AppSettings>("update_settings", { patch }),
  },
  overview: {
    get: () => call<Overview>("get_overview"),
  },
  projects: {
    list: () => call<Project[]>("list_projects"),
    get: (id: string) => call<Project>("get_project", { id }),
    create: (input: ProjectInput) => call<Project>("create_project", { input }),
    update: (id: string, input: ProjectInput) => call<Project>("update_project", { id, input }),
    remove: (id: string) => call<ProjectDeletion>("delete_project", { id }),
  },
  sessions: {
    list: () => call<SessionSummary[]>("list_sessions"),
    get: (id: string) => call<SessionDetail>("get_session", { id }),
    create: (input: SessionInput, notes?: string) => call<SessionDetail>("create_session", { input, notes: notes ?? null }),
    update: (id: string, input: SessionInput) => call<SessionDetail>("update_session", { id, input }),
    updateNotes: (id: string, notes: string) => call<NotesSaved>("update_session_notes", { id, notes }),
    setStatus: (id: string, status: SessionStatus) => call<SessionDetail>("set_session_status", { id, status }),
    remove: (id: string) => call<SessionDeletion>("delete_session", { id }),
  },
  events: {
    list: (sessionId: string) => call<SessionEvent[]>("list_events", { sessionId }),
    create: (sessionId: string, eventType: EventType, input: EventInput) =>
      call<SessionEvent>("create_event", { sessionId, eventType, input }),
    update: (id: string, input: EventInput) => call<SessionEvent>("update_event", { id, input }),
    remove: (id: string) => call<EventDeletion>("delete_event", { id }),
  },
  attachments: {
    /** Sends the image bytes as the raw request body (no file paths cross the IPC boundary). */
    importImage: (bytes: Uint8Array, options: ImageImportOptions) =>
      call<ImportedImage>("import_image", bytes, { headers: importHeaders(options) }),
    remove: (id: string) => call<AttachmentDeletion>("delete_attachment", { id }),
    updateAnnotations: (id: string, annotations: Annotation[]) => call<Attachment>("update_annotations", { id, annotations }),
  },
  capture: {
    status: () => call<CaptureStatus>("get_capture_status"),
    targets: () => call<CaptureTarget[]>("list_capture_targets"),
    start: (sessionId: string, targetId: string, autoCapture = false) => call<CaptureStatus>("start_capture", { sessionId, targetId, autoCapture }),
    pause: () => call<CaptureStatus>("pause_capture"),
    resume: () => call<CaptureStatus>("resume_capture"),
    stop: () => call<CaptureStatus>("stop_capture"),
    captureNow: () => call<CapturedShot>("capture_now"),
    /** Switches automatic capture after screen changes on or off while recording. */
    setAutoCapture: (enabled: boolean) => call<CaptureStatus>("set_auto_capture_enabled", { enabled }),
  },
  review: {
    setStatus: (sessionId: string, eventIds: string[], status: EventReviewStatus, comment?: string) =>
      call<SessionEvent[]>("review_events", { sessionId, eventIds, status, comment: comment ?? null }),
    reorder: (sessionId: string, eventIds: string[]) => call<SessionEvent[]>("reorder_events", { sessionId, eventIds }),
    /** Permanently blacks out regions; the original file is deleted. */
    redact: (id: string, regions: Region[], comment?: string) => call<Redaction>("redact_attachment", { id, regions, comment: comment ?? null }),
    summary: (sessionId: string) => call<ReviewSummary>("get_review_summary", { sessionId }),
    decisions: (sessionId: string) => call<ReviewDecision[]>("list_review_decisions", { sessionId }),
    markReviewed: (id: string, comment?: string) => call<SessionDetail>("mark_session_reviewed", { id, comment: comment ?? null }),
    reopen: (id: string) => call<SessionDetail>("reopen_session_review", { id }),
  },
  playbooks: {
    list: () => call<PlaybookSummary[]>("list_playbooks"),
    get: (id: string) => call<PlaybookDetail>("get_playbook", { id }),
    create: (input: PlaybookInput) => call<PlaybookDetail>("create_playbook", { input }),
    /** Generates a draft from the approved steps of a session; evidence is copied. */
    createFromSession: (sessionId: string) => call<PlaybookDetail>("create_playbook_from_session", { sessionId }),
    save: (id: string, input: PlaybookInput, content: PlaybookContent) => call<PlaybookDetail>("save_playbook", { id, input, content }),
    setStatus: (id: string, status: PlaybookStatus, note?: string) => call<PlaybookDetail>("set_playbook_status", { id, status, note: note ?? null }),
    remove: (id: string) => call<PlaybookDeletion>("delete_playbook", { id }),
    /** A published revision with its stored metadata and content. */
    revision: (id: string, revisionId: string) => call<RevisionDetail>("get_playbook_revision", { id, revisionId }),
    /** A working copy kept when a restore replaced it. */
    restorePoint: (id: string, restorePointId: string) => call<RestorePointDetail>("get_playbook_restore_point", { id, restorePointId }),
    /** Replaces the working copy with a revision or restore point; unpublished work is kept as a restore point. */
    restore: (id: string, source: VersionRef) => call<PlaybookDetail>("restore_playbook_version", { id, source }),
    setOutdated: (id: string, outdated: boolean, note?: string) => call<PlaybookDetail>("set_playbook_outdated", { id, outdated, note: note ?? null }),
    /** Copies the working copy (or one revision) into a new draft with its own screenshots. */
    duplicate: (id: string, revisionId?: string | null) => call<PlaybookDetail>("duplicate_playbook", { id, revisionId: revisionId ?? null }),
  },
  exports: {
    /**
     * Writes a playbook to the workspace exports folder. Without `revisionId`, a published playbook
     * exports its newest revision and an unpublished one its saved working copy.
     */
    playbook: (id: string, format: ExportFormat, revisionId?: string | null) =>
      call<ExportResult>("export_playbook", { id, format, revisionId: revisionId ?? null }),
    /** Shows an exported file in the system file manager. */
    reveal: (relativePath: string) => call<void>("reveal_export", { relativePath }),
  },
  changes: {
    list: () => call<ChangeRecord[]>("list_changes"),
    /** Records a change stated by the user (declared, pending review). */
    declare: (input: ChangeInput) => call<ChangeRecord>("declare_change", { input }),
    update: (id: string, input: ChangeInput) => call<ChangeRecord>("update_change", { id, input }),
    review: (id: string, approvalState: ApprovalState, comment?: string) =>
      call<ChangeRecord>("review_change", { id, approvalState, comment: comment ?? null }),
    /** Marks a change verified; the note saying how it was checked is required. */
    verify: (id: string, note: string) => call<ChangeRecord>("verify_change", { id, note }),
    remove: (id: string) => call<string>("delete_change", { id }),
  },
  integrations: {
    list: () => call<Integration[]>("list_integrations"),
    terminal: {
      start: (sessionId: string, format: LogFormat) => call<TerminalLogStatus>("start_terminal_log", { sessionId, format }),
      stop: (sessionId: string) => call<TerminalLogStatus | null>("stop_terminal_log", { sessionId }),
      get: (sessionId: string) => call<TerminalLogStatus | null>("get_terminal_log", { sessionId }),
    },
    files: {
      /** Opens the system file dialog; resolves null when the user cancels. */
      watch: (sessionId: string) => call<FileWatchStatus | null>("watch_config_file", { sessionId }),
      stop: (watchId: string) => call<FileWatchStatus | null>("stop_config_watch", { watchId }),
      list: (sessionId: string) => call<FileWatchStatus[]>("list_config_watches", { sessionId }),
    },
  },
  backup: {
    /** Opens the system save dialog and writes a backup there; resolves null when cancelled. */
    create: () => call<BackupResult | null>("create_backup"),
    /** Shows the last backup written in this run in the system file manager. */
    reveal: () => call<void>("reveal_backup"),
    /** Opens the system file dialog and validates the chosen backup; nothing changes yet. */
    choose: () => call<BackupInfo | null>("choose_backup"),
    /** Restores the chosen backup. The current data is kept in the workspace backups folder. */
    restore: (token: string) => call<RestoreResult>("restore_backup", { token }),
  },
} as const;
