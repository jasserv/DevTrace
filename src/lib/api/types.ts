/**
 * Data transfer types returned by the Rust backend. These mirror the serde structs in
 * src-tauri/src/features/*.rs (camelCase field names). Keep both sides in sync.
 */

export type ThemePreference = "system" | "light" | "dark";

export interface AppSettings {
  theme: ThemePreference;
  reduceMotion: boolean;
  sidebarCollapsed: boolean;
  workspaceName: string;
  authorName: string;
  /** Global shortcut that captures a screenshot while recording. */
  captureShortcut: string;
}

export type SettingsPatch = Partial<AppSettings>;

export interface AppInfo {
  name: string;
  version: string;
  identifier: string;
  os: string;
  arch: string;
  debugBuild: boolean;
  tauriVersion: string;
  sqliteVersion: string;
  dataDir: string;
  databaseFile: string;
  attachmentsDir: string;
  exportsDir: string;
  backupsDir: string;
  schemaVersion: number | null;
  latestSchemaVersion: number;
  storageReady: boolean;
  storageError: string | null;
  /** PDF export prints through WebView2 and is available on Windows only. */
  pdfExportSupported: boolean;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  sessionCount: number;
  playbookCount: number;
  changeCount: number;
}

export interface ProjectInput {
  name: string;
  description: string;
}

export interface ProjectDeletion {
  id: string;
  unassignedSessions: number;
  unassignedPlaybooks: number;
  unassignedChanges: number;
}

export type SessionStatus = "draft" | "recording" | "paused" | "completed";
export type ReviewState = "unreviewed" | "in_review" | "reviewed";

export interface SessionSummary {
  id: string;
  title: string;
  projectId: string | null;
  projectName: string | null;
  application: string;
  environment: string;
  status: SessionStatus;
  reviewState: ReviewState;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
  playbookCount: number;
  eventCount: number;
  attachmentCount: number;
}

export interface SessionDetail extends SessionSummary {
  notes: string;
  /** Total size of the session's stored evidence files. */
  attachmentBytes: number;
  /** Change records that reference this session. */
  changeCount: number;
}

export interface SessionInput {
  title: string;
  projectId: string | null;
  application: string;
  environment: string;
}

export interface NotesSaved {
  updatedAt: string;
}

/** Outcome of removing managed files after their records were deleted. */
export interface FileCleanup {
  removed: number;
  missing: number;
  /** Files that could not be deleted and remain in the workspace folder. */
  failed: number;
}

export interface SessionDeletion {
  id: string;
  title: string;
  eventCount: number;
  attachmentCount: number;
  unlinkedPlaybooks: number;
  unlinkedChanges: number;
  files: FileCleanup;
}

export type EventType = "step" | "note" | "command" | "screenshot" | "log" | "change";
/** Where an event's content came from. `capture` = recorded by DevTrace screen capture. */
export type EventSource = "manual" | "file" | "clipboard" | "capture" | "terminal" | "file_watch";
/** The reviewer's decision on a step. Only approved steps can become playbook content. */
export type EventReviewStatus = "pending" | "approved" | "rejected" | "excluded";

/** What a review decision did (`review_decisions.decision`). */
export type DecisionKind = "approve" | "reject" | "exclude" | "reset" | "reorder" | "redact" | "mark_reviewed" | "reopen_review";

/** One entry of a session's review audit trail. */
export interface ReviewDecision {
  id: string;
  sessionId: string;
  eventId: string | null;
  /** Current title of the step; null when the step was deleted. */
  eventTitle: string | null;
  decision: DecisionKind;
  comment: string;
  reviewer: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface ReviewSummary {
  sessionId: string;
  reviewState: ReviewState;
  total: number;
  pending: number;
  approved: number;
  rejected: number;
  excluded: number;
}

/** An area to black out permanently, in image pixels. */
export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Redaction {
  attachment: Attachment;
  /** Removal of the original, unredacted file; `failed > 0` means it is still on disk. */
  originalFile: FileCleanup;
  /** Playbook copies of the screenshot that were redacted the same way. */
  playbookCopies: number;
  /** Playbook copies that could not be redacted. */
  copyFailures: number;
}

export type AttachmentKind = "screenshot";
export type AttachmentSource = "file" | "clipboard" | "capture";

/** A non-destructive highlight box drawn on a screenshot, in image pixel coordinates. */
export interface Annotation {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
}

export interface Attachment {
  id: string;
  sessionId: string;
  eventId: string | null;
  kind: AttachmentKind;
  source: AttachmentSource;
  originalName: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
  width: number | null;
  height: number | null;
  createdAt: string;
  annotations: Annotation[];
  /** Set when regions were permanently redacted (burned into the image). */
  redactedAt: string | null;
}

/** Recorded on events created by native capture: what took the screenshot, and of what. */
export interface CaptureMetadata {
  trigger?: CaptureTrigger;
  capturedAt?: string;
  target?: { kind: CaptureTargetKind; title: string; appName: string; width?: number; height?: number };
}

/** Recorded on events read from a terminal log. */
export interface TerminalMetadata {
  logId?: string;
  format?: LogFormat;
  /** Output that followed a command (commands only). */
  output?: string;
  outputLines?: number;
  /** True when values that looked like secrets were masked. */
  masked?: boolean;
}

/** Recorded on events created by a watched configuration file. */
export interface FileWatchMetadata {
  watchId?: string;
  path?: string;
  linesAdded?: number;
  linesRemoved?: number;
}

export interface SessionEvent {
  id: string;
  sessionId: string;
  position: number;
  occurredAt: string;
  eventType: EventType;
  source: EventSource;
  title: string;
  description: string;
  notes: string;
  code: string;
  reviewStatus: EventReviewStatus;
  createdAt: string;
  updatedAt: string;
  /** Recorded facts (capture target and trigger, terminal output, watched file); empty for manual events. */
  metadata: { capture?: CaptureMetadata; terminal?: TerminalMetadata; fileWatch?: FileWatchMetadata } & Record<string, unknown>;
  attachments: Attachment[];
}

export interface EventInput {
  title: string;
  description: string;
  notes: string;
  code: string;
}

export interface EventDeletion {
  id: string;
  sessionId: string;
  attachmentCount: number;
  files: FileCleanup;
}

export interface ImportedImage {
  event: SessionEvent;
  attachmentId: string;
  eventCreated: boolean;
}

export interface ImageImportOptions {
  sessionId: string;
  /** Attach to this event instead of creating a new screenshot step. */
  eventId?: string;
  /** Title for a new screenshot step (defaults to the file name). */
  title?: string;
  fileName?: string;
  source: "file" | "clipboard";
}

export interface AttachmentDeletion {
  id: string;
  sessionId: string;
  eventId: string | null;
  files: FileCleanup;
}

export type CaptureState = "idle" | "recording" | "paused";
export type CaptureTargetKind = "monitor" | "window";
export type CaptureTrigger = "button" | "shortcut" | "tray" | "auto";

/** A display or an application window that can be captured. */
export interface CaptureTarget {
  id: string;
  kind: CaptureTargetKind;
  title: string;
  appName: string;
  width: number;
  height: number;
  primary: boolean;
}

/** Live capture state, also broadcast as the `capture-status` event. */
export interface CaptureStatus {
  state: CaptureState;
  sessionId: string | null;
  sessionTitle: string | null;
  target: CaptureTarget | null;
  startedAt: string | null;
  captureCount: number;
  lastCaptureAt: string | null;
  /** Global shortcut that captures a screenshot while recording. */
  shortcut: string;
  shortcutActive: boolean;
  shortcutError: string | null;
  /** False on platforms where capture is not available; `unsupportedReason` explains why. */
  supported: boolean;
  unsupportedReason: string | null;
  lastError: string | null;
  /** Automatic capture after screen changes is on for this capture (opt-in). */
  autoCapture: boolean;
}

export type LogFormat = "powershell" | "plain";

/** A terminal log being read for a session. */
export interface TerminalLogStatus {
  sessionId: string;
  logId: string;
  format: LogFormat;
  /** Absolute path of the log file the terminal writes to (inside the workspace). */
  path: string;
  startedAt: string;
  active: boolean;
  stepsRecorded: number;
  bytesRead: number;
  lastError: string | null;
}

/** A configuration file watched for a session. */
export interface FileWatchStatus {
  id: string;
  sessionId: string;
  path: string;
  fileName: string;
  startedAt: string;
  active: boolean;
  changesRecorded: number;
  lastChangeAt: string | null;
  lastError: string | null;
}

/** An opt-in evidence source this build offers. */
export interface Integration {
  id: string;
  name: string;
  description: string;
  location: string;
  available: boolean;
  unavailableReason: string | null;
}

/** Broadcast as the `capture-captured` event after each stored screenshot. */
export interface CapturedShot {
  sessionId: string;
  eventId: string;
  attachmentId: string;
  trigger: CaptureTrigger;
}

export type PlaybookStatus = "draft" | "in_review" | "published";

export interface PlaybookSummary {
  id: string;
  title: string;
  summary: string;
  projectId: string | null;
  projectName: string | null;
  status: PlaybookStatus;
  platform: string;
  product: string;
  productVersion: string;
  environment: string;
  taskType: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  sessionCount: number;
  stepCount: number;
  revisionCount: number;
  /** Set when the playbook was marked out of date. */
  outdatedAt: string | null;
}

/**
 * Where a playbook item came from: copied unchanged from an approved session step, copied and
 * then edited, or written in the playbook.
 */
export type Origin = "session" | "edited" | "authored";

export interface ListItem {
  id: string;
  text: string;
  origin: Origin;
}

export interface PlaybookStep {
  id: string;
  title: string;
  instruction: string;
  /** Command or configuration snippet; shown monospaced, never executed. */
  command: string;
  expectedResult: string;
  note: string;
  assetIds: string[];
  origin: Origin;
  sourceSessionId: string | null;
  sourceEventId: string | null;
  sourceKind: EventSource | null;
}

export interface PlaybookContent {
  schemaVersion: number;
  purpose: string;
  scope: string;
  prerequisites: ListItem[];
  permissions: ListItem[];
  steps: PlaybookStep[];
  verification: ListItem[];
  warnings: ListItem[];
  troubleshooting: ListItem[];
  rollback: ListItem[];
}

/** An evidence copy used by a playbook (served through the `evidence` scheme by id). */
export interface PlaybookAsset {
  id: string;
  playbookId: string;
  sourceAttachmentId: string | null;
  sourceEventId: string | null;
  mediaType: string;
  byteSize: number;
  sha256: string;
  width: number | null;
  height: number | null;
  annotations: Annotation[];
  redactedAt: string | null;
  createdAt: string;
}

export interface LinkedSession {
  id: string;
  title: string;
  status: SessionStatus;
  reviewState: ReviewState;
}

export interface RevisionSummary {
  id: string;
  revisionNumber: number;
  title: string;
  note: string;
  author: string;
  createdAt: string;
}

export interface PlaybookDetail extends PlaybookSummary {
  content: PlaybookContent;
  assets: PlaybookAsset[];
  sessions: LinkedSession[];
  revisions: RevisionSummary[];
  /** Working copies replaced by a restore, newest first. */
  restorePoints: RestorePointSummary[];
  outdatedNote: string;
  /** Set while the draft started from an older revision (cleared when published). */
  restoredFromRevision: number | null;
  /** The playbook (and revision) this one was duplicated from. */
  basedOn: BasedOn | null;
}

/** A working copy that a restore replaced; it can be restored in turn. */
export interface RestorePointSummary {
  id: string;
  title: string;
  /** What replaced it: `revision:<number>` or `restore-point:<id>`. */
  replacedBy: string;
  createdAt: string;
}

export interface BasedOn {
  /** Null when the original playbook was deleted. */
  playbookId: string | null;
  title: string | null;
  revisionNumber: number | null;
}

/** Metadata and content of one version (revision snapshot, restore point or working copy). */
export interface VersionSnapshot {
  title: string;
  summary: string;
  projectId: string | null;
  projectName: string | null;
  platform: string;
  product: string;
  productVersion: string;
  environment: string;
  taskType: string;
  author: string;
  content: PlaybookContent;
}

export interface RevisionDetail {
  revision: RevisionSummary;
  snapshot: VersionSnapshot;
  latestRevisionNumber: number;
}

export interface RestorePointDetail {
  restorePoint: RestorePointSummary;
  snapshot: VersionSnapshot;
}

export type VersionRef = { kind: "revision"; id: string } | { kind: "restorePoint"; id: string };

export interface PlaybookInput {
  title: string;
  summary: string;
  projectId: string | null;
  platform: string;
  product: string;
  productVersion: string;
  environment: string;
  taskType: string;
  author: string;
}

export interface PlaybookDeletion {
  id: string;
  title: string;
  files: FileCleanup;
}

export type ExportFormat = "markdown" | "html" | "pdf";

/** A file written to the workspace exports folder. */
export interface ExportResult {
  format: ExportFormat;
  /** Main file, for example `rotate-keys.md`. */
  fileName: string;
  /** Location relative to the exports folder; pass to `api.exports.reveal`. */
  relativePath: string;
  /** Absolute location, for display. */
  path: string;
  byteSize: number;
  imageCount: number;
  /** Screenshots whose files were missing and could not be included. */
  missingImages: number;
  /** "Draft", "In review" or "Revision 3". */
  versionLabel: string;
}

export type ChangeAssertion = "observed" | "declared" | "verified";
export type ApprovalState = "pending" | "approved" | "rejected";

export type ChangeSource = "manual" | "file_watch";

export interface ChangeRecord {
  id: string;
  projectId: string | null;
  projectName: string | null;
  sessionId: string | null;
  sessionTitle: string | null;
  /** The session step that documents the change. */
  eventId: string | null;
  eventTitle: string | null;
  occurredAt: string;
  target: string;
  summary: string;
  environment: string;
  platform: string;
  version: string;
  beforeValue: string | null;
  afterValue: string | null;
  assertion: ChangeAssertion;
  approvalState: ApprovalState;
  source: ChangeSource;
  reviewComment: string;
  reviewer: string;
  reviewedAt: string | null;
  /** How the outcome was verified (required to mark a change verified). */
  verificationNote: string;
  verifiedBy: string;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A change declared or edited by a user. */
export interface ChangeInput {
  target: string;
  summary: string;
  projectId: string | null;
  sessionId: string | null;
  /** RFC 3339; the backend uses the current time when empty. */
  occurredAt: string | null;
  environment: string;
  platform: string;
  version: string;
  beforeValue: string | null;
  afterValue: string | null;
}

export type ReviewItemKind = "session" | "playbook" | "change";

export interface ReviewItem {
  kind: ReviewItemKind;
  id: string;
  title: string;
  projectName: string | null;
  updatedAt: string;
}

export interface OverviewCounts {
  projects: number;
  sessions: number;
  sessionsAwaitingReview: number;
  playbooksDraft: number;
  playbooksInReview: number;
  playbooksPublished: number;
  changes: number;
  changesPending: number;
}

export interface Overview {
  counts: OverviewCounts;
  recentSessions: SessionSummary[];
  draftPlaybooks: PlaybookSummary[];
  publishedPlaybooks: PlaybookSummary[];
  awaitingReview: ReviewItem[];
  recentProjects: Project[];
  recentChanges: ChangeRecord[];
}

/** What a workspace backup contains (from its manifest). */
export interface BackupCounts {
  projects: number;
  sessions: number;
  playbooks: number;
  changes: number;
}

/** A backup written by `create_backup`. */
export interface BackupResult {
  fileName: string;
  /** Where the user chose to save it. */
  path: string;
  sizeBytes: number;
  /** The database copy plus every evidence and log file. */
  fileCount: number;
  createdAt: string;
}

/** A validated backup waiting for confirmation; pass `token` to `restore_backup`. */
export interface BackupInfo {
  token: string;
  fileName: string;
  sizeBytes: number;
  createdAt: string;
  appVersion: string;
  schemaVersion: number;
  workspaceName: string;
  counts: BackupCounts;
  fileCount: number;
  /** Size of the restored files. */
  totalBytes: number;
}

export interface RestoreResult {
  /** Where the replaced data was kept, relative to the workspace (for example `backups/before-restore-…`). */
  previousData: string;
  schemaVersion: number;
}
