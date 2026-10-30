/**
 * In-memory stand-in for the Rust backend, used only by tests. It mimics the command names,
 * payload shapes and error format ({ kind, message, field }) of src-tauri/src/features.
 */
import type {
  Annotation,
  AppInfo,
  AppSettings,
  ApprovalState,
  Attachment,
  BackupInfo,
  BackupResult,
  CaptureStatus,
  CaptureTarget,
  ChangeInput,
  ChangeRecord,
  DecisionKind,
  EventInput,
  EventReviewStatus,
  EventType,
  ExportFormat,
  ExportResult,
  FileWatchStatus,
  LogFormat,
  Overview,
  PlaybookContent,
  PlaybookDetail,
  PlaybookInput,
  PlaybookStatus,
  Project,
  ProjectDeletion,
  ProjectInput,
  Region,
  ReviewDecision,
  ReviewState,
  SessionDetail,
  SessionEvent,
  SessionInput,
  SessionStatus,
  SessionSummary,
  SettingsPatch,
  TerminalLogStatus,
  VersionRef,
  VersionSnapshot,
} from "../lib/api";
import { CAPTURE_SHORTCUTS } from "../features/capture/shortcuts";

interface BackendError {
  kind: string;
  message: string;
  field: string | null;
}

const fail = (kind: string, message: string, field: string | null = null): never => {
  const error: BackendError = { kind, message, field };
  throw error;
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

interface StoredSession {
  id: string;
  title: string;
  projectId: string | null;
  application: string;
  environment: string;
  status: SessionStatus;
  reviewState: ReviewState;
  notes: string;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InvokeOptions {
  headers?: Record<string, string>;
}

export function createFakeBackend() {
  let settings: AppSettings = {
    theme: "system",
    reduceMotion: false,
    sidebarCollapsed: false,
    workspaceName: "Local Workspace",
    authorName: "",
    captureShortcut: "Ctrl+Alt+Shift+S",
  };
  let projects: Project[] = [];
  let sessions: StoredSession[] = [];
  let events: SessionEvent[] = [];
  let attachments: Attachment[] = [];
  /** Image files "on disk", keyed by attachment id. */
  const files = new Map<string, Uint8Array>();
  let sequence = 0;
  const calls: string[] = [];

  const IDLE_STATUS: CaptureStatus = {
    state: "idle",
    sessionId: null,
    sessionTitle: null,
    target: null,
    startedAt: null,
    captureCount: 0,
    lastCaptureAt: null,
    shortcut: "Ctrl+Alt+Shift+S",
    shortcutActive: false,
    shortcutError: null,
    supported: true,
    unsupportedReason: null,
    lastError: null,
    autoCapture: false,
  };
  let capture: CaptureStatus = { ...IDLE_STATUS };
  const captureTargets: CaptureTarget[] = [
    { id: "monitor:1", kind: "monitor", title: "Display 1", appName: "", width: 1920, height: 1080, primary: true },
    { id: "window:42", kind: "window", title: "FortiGate - System Settings", appName: "Browser", width: 1280, height: 800, primary: false },
  ];

  const appInfo: AppInfo = {
    name: "devtrace",
    version: "0.1.0",
    identifier: "com.devtrace.desktop",
    os: "windows",
    arch: "x86_64",
    debugBuild: true,
    tauriVersion: "2.0.0",
    sqliteVersion: "3.0.0",
    dataDir: "C:/test/workspace",
    databaseFile: "C:/test/workspace/devtrace.sqlite3",
    attachmentsDir: "C:/test/workspace/attachments",
    exportsDir: "C:/test/workspace/exports",
    backupsDir: "C:/test/workspace/backups",
    schemaVersion: 3,
    latestSchemaVersion: 3,
    storageReady: true,
    storageError: null,
    pdfExportSupported: true,
  };
  const exportsWritten: ExportResult[] = [];
  /** Relative paths passed to `reveal_export`. */
  const revealed: string[] = [];
  let changes: ChangeRecord[] = [];
  const findChange = (id: unknown) => changes.find((change) => change.id === id) ?? fail("not_found", "Change was not found. It may have been deleted.");
  const terminalLogs = new Map<string, TerminalLogStatus>();
  let fileWatches: FileWatchStatus[] = [];
  /** The path the next `watch_config_file` "picks"; null simulates a cancelled dialog. */
  let nextPickedFile: string | null = null;
  /** Where the next `create_backup` "saves"; null simulates a cancelled dialog. */
  let nextBackupTarget: string | null = null;
  /** The backup the next `choose_backup` "picks": a file name, "damaged", or null (cancelled). */
  let nextBackupToRestore: string | null = null;
  let lastBackup: BackupResult | null = null;
  let pendingRestoreToken: string | null = null;
  const restores: string[] = [];

  const next = () => {
    sequence += 1;
    return new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString();
  };
  const newId = (prefix: string) => `${prefix}-${sequence + 1}-${Math.random().toString(36).slice(2, 8)}`;

  const validateName = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) fail("validation", "Project name is required.", "name");
    return trimmed;
  };

  const ensureUnique = (name: string, exceptId?: string) => {
    if (projects.some((project) => project.id !== exceptId && project.name.toLowerCase() === name.toLowerCase())) {
      fail("conflict", `A project named \u201c${name}\u201d already exists.`, "name");
    }
  };

  const projectWithCounts = (project: Project): Project => ({
    ...project,
    sessionCount: sessions.filter((session) => session.projectId === project.id).length,
  });
  const byUpdated = () => [...projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(projectWithCounts);

  const findSession = (id: unknown) => sessions.find((session) => session.id === id) ?? fail("not_found", "Session was not found. It may have been deleted.");
  const findEvent = (id: unknown) => events.find((event) => event.id === id) ?? fail("not_found", "Event was not found. It may have been deleted.");

  const summary = (session: StoredSession): SessionSummary => ({
    id: session.id,
    title: session.title,
    projectId: session.projectId,
    projectName: projects.find((project) => project.id === session.projectId)?.name ?? null,
    application: session.application,
    environment: session.environment,
    status: session.status,
    reviewState: session.reviewState,
    startedAt: null,
    endedAt: session.endedAt,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    playbookCount: 0,
    eventCount: events.filter((event) => event.sessionId === session.id).length,
    attachmentCount: attachments.filter((attachment) => attachment.sessionId === session.id).length,
  });

  const detail = (session: StoredSession): SessionDetail => ({
    ...summary(session),
    notes: session.notes,
    attachmentBytes: attachments.filter((item) => item.sessionId === session.id).reduce((total, item) => total + item.byteSize, 0),
    changeCount: 0,
  });

  const sessionList = () => [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(summary);

  const withAttachments = (event: SessionEvent): SessionEvent => ({
    ...event,
    attachments: attachments.filter((attachment) => attachment.eventId === event.id),
  });

  const validSessionInput = (input: SessionInput) => {
    const title = input.title.trim();
    if (!title) fail("validation", "Session title is required.", "title");
    if (input.projectId && !projects.some((project) => project.id === input.projectId)) {
      fail("validation", "The selected project no longer exists. Choose another project.", "projectId");
    }
    return { title, projectId: input.projectId || null, application: input.application.trim(), environment: input.environment.trim() };
  };

  const ensureEditable = (session: StoredSession) => {
    if (session.status === "completed") fail("conflict", "This session is completed. Reopen it to change its steps or evidence.", "status");
  };

  const validEventInput = (eventType: EventType, input: EventInput) => {
    const title = input.title.trim();
    if (!title) fail("validation", "Title is required.", "title");
    if (eventType === "command" && !input.code.trim()) fail("validation", "Command is required.", "code");
    return { title, description: input.description, notes: input.notes, code: eventType === "command" ? input.code : "" };
  };

  const touch = (session: StoredSession, now: string) => {
    session.updatedAt = now;
  };

  const insertEvent = (session: StoredSession, eventType: EventType, source: SessionEvent["source"], text: ReturnType<typeof validEventInput>) => {
    const now = next();
    const positions = events.filter((event) => event.sessionId === session.id).map((event) => event.position);
    const event: SessionEvent = {
      id: newId("event"),
      sessionId: session.id,
      position: positions.length ? Math.max(...positions) + 1 : 0,
      occurredAt: now,
      eventType,
      source,
      ...text,
      reviewStatus: "pending",
      createdAt: now,
      updatedAt: now,
      metadata: {},
      attachments: [],
    };
    events.push(event);
    if (session.reviewState === "reviewed") session.reviewState = "in_review";
    touch(session, now);
    return event;
  };

  const decisions: ReviewDecision[] = [];
  const decide = (session: StoredSession, eventId: string | null, decision: DecisionKind, comment: string, details: Record<string, unknown>) => {
    decisions.unshift({
      id: newId("decision"),
      sessionId: session.id,
      eventId,
      eventTitle: eventId ? (events.find((event) => event.id === eventId)?.title ?? null) : null,
      decision,
      comment: comment.trim(),
      reviewer: settings.authorName,
      details,
      createdAt: next(),
    });
  };
  const refreshReviewState = (session: StoredSession) => {
    const pending = events.some((event) => event.sessionId === session.id && event.reviewStatus === "pending");
    if (session.reviewState === "unreviewed" || (session.reviewState === "reviewed" && pending)) session.reviewState = "in_review";
  };
  let playbooks: PlaybookDetail[] = [];
  const EMPTY_CONTENT: PlaybookContent = {
    schemaVersion: 1,
    purpose: "",
    scope: "",
    prerequisites: [],
    permissions: [],
    steps: [],
    verification: [],
    warnings: [],
    troubleshooting: [],
    rollback: [],
  };
  const findPlaybook = (id: unknown) => playbooks.find((playbook) => playbook.id === id) ?? fail("not_found", "Playbook was not found. It may have been deleted.");
  /** Stored snapshots of revisions and restore points, by id. */
  const snapshots = new Map<string, VersionSnapshot>();
  const snapshotOf = (playbook: PlaybookDetail): VersionSnapshot =>
    structuredClone({
      title: playbook.title,
      summary: playbook.summary,
      projectId: playbook.projectId,
      projectName: playbook.projectName,
      platform: playbook.platform,
      product: playbook.product,
      productVersion: playbook.productVersion,
      environment: playbook.environment,
      taskType: playbook.taskType,
      author: playbook.author,
      content: playbook.content,
    });
  const sameDocument = (a: VersionSnapshot, b: VersionSnapshot) =>
    JSON.stringify({ ...a, projectName: null }) === JSON.stringify({ ...b, projectName: null });
  const refreshPlaybook = (playbook: PlaybookDetail) => {
    playbook.stepCount = playbook.content.steps.length;
    playbook.revisionCount = playbook.revisions.length;
    playbook.sessionCount = playbook.sessions.length;
    playbook.projectName = projects.find((project) => project.id === playbook.projectId)?.name ?? null;
  };
  const newPlaybook = (input: PlaybookInput, content: PlaybookContent): PlaybookDetail => {
    const title = input.title.trim();
    if (!title) fail("validation", "Playbook title is required.", "title");
    const now = next();
    const playbook: PlaybookDetail = {
      id: newId("playbook"),
      title,
      summary: input.summary,
      projectId: input.projectId,
      projectName: null,
      status: "draft",
      platform: input.platform,
      product: input.product,
      productVersion: input.productVersion,
      environment: input.environment,
      taskType: input.taskType,
      author: input.author || settings.authorName,
      createdAt: now,
      updatedAt: now,
      publishedAt: null,
      sessionCount: 0,
      stepCount: 0,
      revisionCount: 0,
      outdatedAt: null,
      content,
      assets: [],
      sessions: [],
      revisions: [],
      restorePoints: [],
      outdatedNote: "",
      restoredFromRevision: null,
      basedOn: null,
    };
    playbooks.push(playbook);
    refreshPlaybook(playbook);
    return playbook;
  };
  const DECISION_FOR: Record<EventReviewStatus, DecisionKind> = { pending: "reset", approved: "approve", rejected: "reject", excluded: "exclude" };

  type Handler = (args: Record<string, unknown> & { body?: Uint8Array }, options: InvokeOptions) => unknown;

  const handlers: Record<string, Handler> = {
    get_app_info: () => appInfo,
    reveal_data_directory: () => null,
    get_settings: () => settings,
    update_settings: (args) => {
      const patch = args.patch as SettingsPatch;
      if (patch.workspaceName !== undefined && !patch.workspaceName.trim()) {
        fail("validation", "Workspace name is required.", "workspaceName");
      }
      if (patch.captureShortcut !== undefined && !CAPTURE_SHORTCUTS.includes(patch.captureShortcut as (typeof CAPTURE_SHORTCUTS)[number])) {
        fail("validation", "Choose one of the offered capture shortcuts.", "captureShortcut");
      }
      settings = { ...settings, ...patch };
      capture = { ...capture, shortcut: settings.captureShortcut };
      return settings;
    },
    get_overview: (): Overview => ({
      counts: {
        projects: projects.length,
        sessions: sessions.length,
        sessionsAwaitingReview: sessions.filter((session) => session.status === "completed").length,
        playbooksDraft: playbooks.filter((playbook) => playbook.status === "draft").length,
        playbooksInReview: playbooks.filter((playbook) => playbook.status === "in_review").length,
        playbooksPublished: playbooks.filter((playbook) => playbook.status === "published").length,
        changes: 0,
        changesPending: 0,
      },
      recentSessions: sessionList().slice(0, 5),
      draftPlaybooks: playbooks.filter((playbook) => playbook.status !== "published"),
      publishedPlaybooks: playbooks.filter((playbook) => playbook.status === "published"),
      awaitingReview: [],
      recentProjects: byUpdated().slice(0, 5),
      recentChanges: [],
    }),
    list_projects: () => byUpdated(),
    get_project: (args) => {
      const project = projects.find((item) => item.id === args.id) ?? fail("not_found", "Project was not found.");
      return projectWithCounts(project);
    },
    create_project: (args) => {
      const input = args.input as ProjectInput;
      const name = validateName(input.name);
      ensureUnique(name);
      const now = next();
      const project: Project = {
        id: `project-${sequence}`,
        name,
        description: input.description.trim(),
        createdAt: now,
        updatedAt: now,
        sessionCount: 0,
        playbookCount: 0,
        changeCount: 0,
      };
      projects.push(project);
      return project;
    },
    update_project: (args) => {
      const input = args.input as ProjectInput;
      const existing = projects.find((project) => project.id === args.id) ?? fail("not_found", "Project was not found.");
      const name = validateName(input.name);
      ensureUnique(name, existing.id);
      const updated = { ...existing, name, description: input.description.trim(), updatedAt: next() };
      projects = projects.map((project) => (project.id === existing.id ? updated : project));
      return projectWithCounts(updated);
    },
    delete_project: (args): ProjectDeletion => {
      const existing = projects.find((project) => project.id === args.id) ?? fail("not_found", "Project was not found.");
      const unassignedSessions = sessions.filter((session) => session.projectId === existing.id).length;
      sessions = sessions.map((session) => (session.projectId === existing.id ? { ...session, projectId: null } : session));
      projects = projects.filter((project) => project.id !== existing.id);
      return { id: existing.id, unassignedSessions, unassignedPlaybooks: 0, unassignedChanges: 0 };
    },
    list_sessions: () => sessionList(),
    get_session: (args) => detail(findSession(args.id)),
    create_session: (args) => {
      const input = validSessionInput(args.input as SessionInput);
      const now = next();
      const session: StoredSession = {
        id: newId("session"),
        ...input,
        status: "draft",
        reviewState: "unreviewed",
        notes: typeof args.notes === "string" ? args.notes : "",
        endedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      sessions.push(session);
      return detail(session);
    },
    update_session: (args) => {
      const session = findSession(args.id);
      Object.assign(session, validSessionInput(args.input as SessionInput), { updatedAt: next() });
      return detail(session);
    },
    update_session_notes: (args) => {
      const session = findSession(args.id);
      session.notes = String(args.notes);
      session.updatedAt = next();
      return { updatedAt: session.updatedAt };
    },
    set_session_status: (args) => {
      const session = findSession(args.id);
      const status = args.status as SessionStatus;
      if (session.status === "recording" || session.status === "paused") {
        fail("conflict", "This session is being captured. Stop the capture first.", "status");
      }
      if (status === "completed" && session.status !== "completed") {
        if (!events.some((event) => event.sessionId === session.id)) {
          fail("conflict", "Add at least one step before completing the session.", "status");
        }
        session.status = "completed";
        session.endedAt = next();
        session.updatedAt = session.endedAt;
      } else if (status === "draft" && session.status === "completed") {
        session.status = "draft";
        session.endedAt = null;
        session.updatedAt = next();
      } else if (status !== session.status) {
        fail("validation", "Recording and pausing are controlled from the Capture workspace.", "status");
      }
      return detail(session);
    },
    delete_session: (args) => {
      const session = findSession(args.id);
      if (session.status === "recording" || session.status === "paused") {
        fail("conflict", "This session is being captured. Stop the capture before deleting it.", "status");
      }
      const sessionAttachments = attachments.filter((attachment) => attachment.sessionId === session.id);
      const eventCount = events.filter((event) => event.sessionId === session.id).length;
      for (const attachment of sessionAttachments) files.delete(attachment.id);
      events = events.filter((event) => event.sessionId !== session.id);
      attachments = attachments.filter((attachment) => attachment.sessionId !== session.id);
      sessions = sessions.filter((item) => item.id !== session.id);
      return {
        id: session.id,
        title: session.title,
        eventCount,
        attachmentCount: sessionAttachments.length,
        unlinkedPlaybooks: 0,
        unlinkedChanges: 0,
        files: { removed: sessionAttachments.length, missing: 0, failed: 0 },
      };
    },
    list_events: (args) => {
      findSession(args.sessionId);
      return events
        .filter((event) => event.sessionId === args.sessionId)
        .sort((a, b) => a.position - b.position)
        .map(withAttachments);
    },
    create_event: (args) => {
      const session = findSession(args.sessionId);
      const eventType = args.eventType as EventType;
      if (eventType === "screenshot") fail("validation", "Screenshot steps are created by adding an image.", "eventType");
      ensureEditable(session);
      return withAttachments(insertEvent(session, eventType, "manual", validEventInput(eventType, args.input as EventInput)));
    },
    update_event: (args) => {
      const event = findEvent(args.id);
      ensureEditable(findSession(event.sessionId));
      Object.assign(event, validEventInput(event.eventType, args.input as EventInput), { updatedAt: next() });
      return withAttachments(event);
    },
    delete_event: (args) => {
      const event = findEvent(args.id);
      ensureEditable(findSession(event.sessionId));
      const removed = attachments.filter((attachment) => attachment.eventId === event.id);
      for (const attachment of removed) files.delete(attachment.id);
      attachments = attachments.filter((attachment) => attachment.eventId !== event.id);
      events = events.filter((item) => item.id !== event.id);
      return { id: event.id, sessionId: event.sessionId, attachmentCount: removed.length, files: { removed: removed.length, missing: 0, failed: 0 } };
    },
    import_image: (args, options) => {
      const bytes = args.body;
      const headers = options.headers ?? {};
      if (!(bytes instanceof Uint8Array)) return fail("validation", "The image must be sent as raw bytes.", "file");
      const session = findSession(headers["x-session-id"]);
      ensureEditable(session);
      if (!PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
        fail("validation", "This file is not a supported image. Use a PNG, JPEG, GIF or WebP file.", "file");
      }
      const source = headers["x-source"] === "clipboard" ? "clipboard" : "file";
      const fileName = headers["x-file-name"] ? decodeURIComponent(headers["x-file-name"]) : "";
      let event: SessionEvent;
      if (headers["x-event-id"]) {
        event = findEvent(headers["x-event-id"]);
        if (event.sessionId !== session.id) fail("validation", "The step belongs to a different session.", "eventId");
      } else {
        const title = headers["x-title"]
          ? decodeURIComponent(headers["x-title"])
          : source === "clipboard"
            ? "Pasted screenshot"
            : fileName.replace(/\.[^.]+$/, "") || "Screenshot";
        event = insertEvent(session, "screenshot", source, { title, description: "", notes: "", code: "" });
      }
      const attachment: Attachment = {
        id: newId("attachment"),
        sessionId: session.id,
        eventId: event.id,
        kind: "screenshot",
        source,
        originalName: fileName,
        mediaType: "image/png",
        byteSize: bytes.length,
        sha256: "0".repeat(64),
        width: 640,
        height: 400,
        createdAt: next(),
        annotations: [],
        redactedAt: null,
      };
      attachments.push(attachment);
      files.set(attachment.id, bytes);
      touch(session, attachment.createdAt);
      return { event: withAttachments(event), attachmentId: attachment.id, eventCreated: !headers["x-event-id"] };
    },
    delete_attachment: (args) => {
      const attachment = attachments.find((item) => item.id === args.id) ?? fail("not_found", "Attachment was not found.");
      ensureEditable(findSession(attachment.sessionId));
      attachments = attachments.filter((item) => item.id !== attachment.id);
      files.delete(attachment.id);
      return { id: attachment.id, sessionId: attachment.sessionId, eventId: attachment.eventId, files: { removed: 1, missing: 0, failed: 0 } };
    },
    update_annotations: (args) => {
      const attachment = attachments.find((item) => item.id === args.id) ?? fail("not_found", "Attachment was not found.");
      ensureEditable(findSession(attachment.sessionId));
      attachment.annotations = structuredClone(args.annotations as Annotation[]);
      return attachment;
    },
    get_capture_status: () => capture,
    list_capture_targets: () => captureTargets,
    start_capture: (args) => {
      if (capture.state !== "idle") fail("conflict", "A capture is already active. Stop it first.", null);
      const session = findSession(args.sessionId);
      ensureEditable(session);
      if (session.status !== "draft") fail("conflict", "The capture state of this session changed. Refresh and try again.", "status");
      const target =
        captureTargets.find((item) => item.id === args.targetId) ?? fail("validation", "That display or window is no longer available.", "targetId");
      session.status = "recording";
      capture = {
        ...IDLE_STATUS,
        state: "recording",
        sessionId: session.id,
        sessionTitle: session.title,
        target,
        startedAt: next(),
        shortcut: settings.captureShortcut,
        shortcutActive: true,
        autoCapture: args.autoCapture === true,
      };
      return capture;
    },
    set_auto_capture_enabled: (args) => {
      if (capture.state === "idle") fail("conflict", "No capture is running. Start a capture first.", "capture");
      capture = { ...capture, autoCapture: args.enabled === true, lastError: null };
      return capture;
    },
    pause_capture: () => {
      if (capture.state !== "recording") fail("conflict", "No capture is recording.", null);
      findSession(capture.sessionId).status = "paused";
      capture = { ...capture, state: "paused" };
      return capture;
    },
    resume_capture: () => {
      if (capture.state !== "paused") fail("conflict", "No capture is paused.", null);
      findSession(capture.sessionId).status = "recording";
      capture = { ...capture, state: "recording" };
      return capture;
    },
    stop_capture: () => {
      if (capture.state === "idle") fail("conflict", "No capture is active.", null);
      findSession(capture.sessionId).status = "draft";
      capture = { ...IDLE_STATUS, shortcut: settings.captureShortcut };
      return capture;
    },
    capture_now: () => {
      if (capture.state !== "recording") fail("conflict", "Capture is paused. Resume to take screenshots.", null);
      const session = findSession(capture.sessionId);
      const target = capture.target!;
      const event = insertEvent(session, "screenshot", "capture", { title: `Screenshot of ${target.title}`, description: "", notes: "", code: "" });
      event.metadata = { capture: { trigger: "button", target: { kind: target.kind, title: target.title, appName: target.appName } } };
      const attachment: Attachment = {
        id: newId("attachment"),
        sessionId: session.id,
        eventId: event.id,
        kind: "screenshot",
        source: "capture",
        originalName: "",
        mediaType: "image/png",
        byteSize: 2048,
        sha256: "1".repeat(64),
        width: target.width,
        height: target.height,
        createdAt: next(),
        annotations: [],
        redactedAt: null,
      };
      attachments.push(attachment);
      files.set(attachment.id, pngBytes());
      capture = { ...capture, captureCount: capture.captureCount + 1, lastCaptureAt: attachment.createdAt };
      return { sessionId: session.id, eventId: event.id, attachmentId: attachment.id, trigger: "button" };
    },
    list_playbooks: () =>
      [...playbooks]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map(
          ({
            content: _content,
            assets: _assets,
            sessions: _sessions,
            revisions: _revisions,
            restorePoints: _points,
            outdatedNote: _note,
            restoredFromRevision: _restored,
            basedOn: _basedOn,
            ...summary
          }) => summary,
        ),
    get_playbook: (args) => findPlaybook(args.id),
    create_playbook: (args) => newPlaybook(args.input as PlaybookInput, structuredClone(EMPTY_CONTENT)),
    create_playbook_from_session: (args) => {
      const session = findSession(args.sessionId);
      const approved = events
        .filter((event) => event.sessionId === session.id && event.reviewStatus === "approved")
        .sort((a, b) => a.position - b.position);
      if (approved.length === 0) fail("conflict", "Approve at least one step of this session before creating a playbook from it.", "sessionId");
      const playbook = newPlaybook(
        { title: session.title, summary: "", projectId: session.projectId, platform: session.application, product: "", productVersion: "", environment: session.environment, taskType: "", author: "" },
        structuredClone(EMPTY_CONTENT),
      );
      for (const event of approved) {
        const assetIds: string[] = [];
        for (const attachment of attachments.filter((item) => item.eventId === event.id)) {
          const asset = { ...attachment, id: newId("asset"), playbookId: playbook.id, sourceAttachmentId: attachment.id, sourceEventId: event.id };
          playbook.assets.push({
            id: asset.id,
            playbookId: playbook.id,
            sourceAttachmentId: attachment.id,
            sourceEventId: event.id,
            mediaType: attachment.mediaType,
            byteSize: attachment.byteSize,
            sha256: attachment.sha256,
            width: attachment.width,
            height: attachment.height,
            annotations: structuredClone(attachment.annotations),
            redactedAt: attachment.redactedAt,
            createdAt: next(),
          });
          assetIds.push(asset.id);
        }
        playbook.content.steps.push({
          id: newId("step"),
          title: event.title,
          instruction: event.description,
          command: event.eventType === "command" ? event.code : "",
          expectedResult: "",
          note: event.notes,
          assetIds,
          origin: "session",
          sourceSessionId: session.id,
          sourceEventId: event.id,
          sourceKind: event.source,
        });
      }
      playbook.sessions.push({ id: session.id, title: session.title, status: session.status, reviewState: session.reviewState });
      refreshPlaybook(playbook);
      return playbook;
    },
    save_playbook: (args) => {
      const playbook = findPlaybook(args.id);
      if (playbook.status !== "draft") fail("conflict", "Only drafts can be edited. Return the playbook to draft first.", "status");
      const input = args.input as PlaybookInput;
      const content = structuredClone(args.content as PlaybookContent);
      if (!input.title.trim()) fail("validation", "Playbook title is required.", "title");
      const untitled = content.steps.findIndex((step) => !step.title.trim());
      if (untitled >= 0) fail("validation", `Step ${untitled + 1} needs a title of at most 200 characters.`, "steps");
      Object.assign(playbook, { ...input, title: input.title.trim(), content, updatedAt: next() });
      refreshPlaybook(playbook);
      return playbook;
    },
    set_playbook_status: (args) => {
      const playbook = findPlaybook(args.id);
      const status = args.status as PlaybookStatus;
      if (status === playbook.status) return playbook;
      if (status !== "draft" && playbook.content.steps.length === 0) fail("conflict", "Add at least one step before submitting or publishing this playbook.", "status");
      const now = next();
      if (status === "published") {
        const revisionId = newId("revision");
        playbook.revisions.unshift({
          id: revisionId,
          revisionNumber: playbook.revisions.length + 1,
          title: playbook.title,
          note: typeof args.note === "string" ? args.note : "",
          author: settings.authorName,
          createdAt: now,
        });
        snapshots.set(revisionId, snapshotOf(playbook));
        playbook.publishedAt = now;
        playbook.outdatedAt = null;
        playbook.outdatedNote = "";
        playbook.restoredFromRevision = null;
      }
      playbook.status = status;
      playbook.updatedAt = now;
      refreshPlaybook(playbook);
      return playbook;
    },
    get_playbook_revision: (args) => {
      const playbook = findPlaybook(args.id);
      const revision = playbook.revisions.find((item) => item.id === args.revisionId) ?? fail("not_found", "Revision was not found. It may have been deleted.");
      return { revision, snapshot: snapshots.get(revision.id)!, latestRevisionNumber: playbook.revisions[0]!.revisionNumber };
    },
    get_playbook_restore_point: (args) => {
      const playbook = findPlaybook(args.id);
      const restorePoint =
        playbook.restorePoints.find((item) => item.id === args.restorePointId) ?? fail("not_found", "Saved draft was not found. It may have been deleted.");
      return { restorePoint, snapshot: snapshots.get(restorePoint.id)! };
    },
    restore_playbook_version: (args) => {
      const playbook = findPlaybook(args.id);
      if (playbook.status === "in_review") fail("conflict", "This playbook is in review. Return it to draft before restoring another version.", "status");
      const source = args.source as VersionRef;
      const revision = source.kind === "revision" ? playbook.revisions.find((item) => item.id === source.id) : undefined;
      const point = source.kind === "restorePoint" ? playbook.restorePoints.find((item) => item.id === source.id) : undefined;
      if (!revision && !point) fail("not_found", "Revision was not found. It may have been deleted.");
      const snapshot = snapshots.get(source.id)!;
      const current = snapshotOf(playbook);
      if (sameDocument(current, snapshot)) fail("conflict", "The working copy already matches this version.", "version");
      const latest = playbook.revisions[0] ? snapshots.get(playbook.revisions[0].id) : undefined;
      if (!latest || !sameDocument(latest, current)) {
        const id = newId("restore");
        snapshots.set(id, current);
        playbook.restorePoints.unshift({
          id,
          title: current.title,
          replacedBy: revision ? `revision:${revision.revisionNumber}` : `restore-point:${point!.id}`,
          createdAt: next(),
        });
      }
      Object.assign(playbook, structuredClone({ ...snapshot, projectName: undefined }), {
        status: "draft",
        restoredFromRevision: revision?.revisionNumber ?? null,
        updatedAt: next(),
      });
      refreshPlaybook(playbook);
      return playbook;
    },
    set_playbook_outdated: (args) => {
      const playbook = findPlaybook(args.id);
      if (playbook.revisions.length === 0) fail("conflict", "Only published procedures can be marked out of date.", "outdated");
      playbook.outdatedAt = args.outdated ? next() : null;
      playbook.outdatedNote = args.outdated && typeof args.note === "string" ? args.note.trim() : "";
      refreshPlaybook(playbook);
      return playbook;
    },
    duplicate_playbook: (args) => {
      const source = findPlaybook(args.id);
      const revision = typeof args.revisionId === "string" ? source.revisions.find((item) => item.id === args.revisionId) : undefined;
      if (typeof args.revisionId === "string" && !revision) fail("not_found", "Revision was not found. It may have been deleted.");
      const snapshot = revision ? snapshots.get(revision.id)! : snapshotOf(source);
      const copy = newPlaybook({ ...snapshot, title: `Copy of ${snapshot.title}`.slice(0, 200), author: settings.authorName || snapshot.author }, structuredClone(snapshot.content));
      const mapping = new Map<string, string>();
      for (const asset of source.assets.filter((item) => snapshot.content.steps.some((step) => step.assetIds.includes(item.id)))) {
        const id = newId("asset");
        mapping.set(asset.id, id);
        copy.assets.push({ ...structuredClone(asset), id, playbookId: copy.id });
      }
      copy.content.steps = copy.content.steps.map((step) => ({ ...step, assetIds: step.assetIds.map((id) => mapping.get(id)!).filter(Boolean) }));
      copy.sessions = structuredClone(source.sessions);
      copy.basedOn = { playbookId: source.id, title: source.title, revisionNumber: revision?.revisionNumber ?? null };
      refreshPlaybook(copy);
      return copy;
    },
    delete_playbook: (args) => {
      const playbook = findPlaybook(args.id);
      playbooks = playbooks.filter((item) => item.id !== playbook.id);
      return { id: playbook.id, title: playbook.title, files: { removed: 1, missing: 0, failed: 0 } };
    },
    export_playbook: (args) => {
      const playbook = findPlaybook(args.id);
      const format = args.format as ExportFormat;
      const revisionId = typeof args.revisionId === "string" ? args.revisionId : null;
      const revision = revisionId
        ? (playbook.revisions.find((item) => item.id === revisionId) ?? fail("not_found", "Revision was not found. It may have been deleted."))
        : playbook.status === "published"
          ? playbook.revisions[0]
          : undefined;
      const versionLabel = revision ? `Revision ${revision.revisionNumber}` : playbook.status === "in_review" ? "In review" : "Draft";
      const slug =
        playbook.title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "") || "playbook";
      const base = `${slug}-${revision ? `r${revision.revisionNumber}` : playbook.status === "in_review" ? "review" : "draft"}-20260101-000000`;
      const relativePath = format === "markdown" ? `${base}/${slug}.md` : `${base}.${format}`;
      const result: ExportResult = {
        format,
        fileName: relativePath.split("/").pop()!,
        relativePath,
        path: `${appInfo.exportsDir}/${relativePath}`,
        byteSize: 2048,
        imageCount: playbook.content.steps.reduce((count, step) => count + step.assetIds.length, 0),
        missingImages: 0,
        versionLabel,
      };
      exportsWritten.push(result);
      return result;
    },
    reveal_export: (args) => {
      const relativePath = String(args.relativePath ?? "");
      if (!exportsWritten.some((item) => item.relativePath === relativePath)) fail("not_found", "Export was not found. It may have been deleted.");
      revealed.push(relativePath);
      return null;
    },
    list_changes: () => [...changes].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)),
    declare_change: (args) => {
      const input = args.input as ChangeInput;
      if (!input.target.trim()) fail("validation", "What changed is required.", "target");
      if (!input.beforeValue && !input.afterValue) fail("validation", "Enter the value before or after the change (or both).", "values");
      const now = next();
      const change: ChangeRecord = {
        id: newId("change"),
        projectId: input.projectId,
        projectName: projects.find((project) => project.id === input.projectId)?.name ?? null,
        sessionId: input.sessionId,
        sessionTitle: sessions.find((session) => session.id === input.sessionId)?.title ?? null,
        eventId: null,
        eventTitle: null,
        occurredAt: input.occurredAt ?? now,
        target: input.target.trim(),
        summary: input.summary,
        environment: input.environment,
        platform: input.platform,
        version: input.version,
        beforeValue: input.beforeValue,
        afterValue: input.afterValue,
        assertion: "declared",
        approvalState: "pending",
        source: "manual",
        reviewComment: "",
        reviewer: "",
        reviewedAt: null,
        verificationNote: "",
        verifiedBy: "",
        verifiedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      changes.push(change);
      return change;
    },
    update_change: (args) => {
      const change = findChange(args.id);
      if (change.assertion !== "declared" || change.approvalState !== "pending") fail("conflict", "This change can no longer be edited.", "assertion");
      const input = args.input as ChangeInput;
      Object.assign(change, { ...input, target: input.target.trim(), occurredAt: input.occurredAt ?? change.occurredAt, updatedAt: next() });
      return change;
    },
    review_change: (args) => {
      const change = findChange(args.id);
      const state = args.approvalState as ApprovalState;
      if (state === "rejected" && change.assertion === "verified") fail("conflict", "A verified change cannot be rejected.", "approvalState");
      const now = next();
      Object.assign(change, {
        approvalState: state,
        reviewComment: typeof args.comment === "string" ? args.comment.trim() : "",
        reviewer: state === "pending" ? "" : settings.authorName,
        reviewedAt: state === "pending" ? null : now,
        updatedAt: now,
      });
      return change;
    },
    verify_change: (args) => {
      const change = findChange(args.id);
      const note = typeof args.note === "string" ? args.note.trim() : "";
      if (!note) fail("validation", "How the outcome was verified is required.", "note");
      if (change.approvalState === "rejected") fail("conflict", "A rejected change cannot be verified.", "approvalState");
      const now = next();
      Object.assign(change, { assertion: "verified", verificationNote: note, verifiedBy: settings.authorName, verifiedAt: now, updatedAt: now });
      return change;
    },
    delete_change: (args) => {
      const change = findChange(args.id);
      changes = changes.filter((item) => item.id !== change.id);
      return change.target;
    },
    list_integrations: () => [
      { id: "auto-capture", name: "Automatic capture after screen changes", description: "Samples the target.", location: "Capture", available: true, unavailableReason: null },
      { id: "powershell-transcript", name: "PowerShell transcript", description: "Reads a transcript.", location: "Session", available: true, unavailableReason: null },
      { id: "plain-log", name: "Plain terminal log", description: "Reads a text log.", location: "Session", available: true, unavailableReason: null },
      { id: "config-file", name: "Configuration file watch", description: "Watches a file.", location: "Session", available: true, unavailableReason: null },
    ],
    start_terminal_log: (args) => {
      const session = findSession(args.sessionId);
      ensureEditable(session);
      if (terminalLogs.get(session.id)?.active) fail("conflict", "Terminal logging is already on for this session.", "terminalLog");
      const log: TerminalLogStatus = {
        sessionId: session.id,
        logId: newId("log"),
        format: args.format as LogFormat,
        path: `C:/test/workspace/terminal-logs/${session.id}/log.log`,
        startedAt: next(),
        active: true,
        stepsRecorded: 0,
        bytesRead: 0,
        lastError: null,
      };
      terminalLogs.set(session.id, log);
      return log;
    },
    stop_terminal_log: (args) => {
      const log = terminalLogs.get(String(args.sessionId));
      if (!log) return null;
      terminalLogs.delete(log.sessionId);
      return { ...log, active: false };
    },
    get_terminal_log: (args) => terminalLogs.get(String(args.sessionId)) ?? null,
    watch_config_file: (args) => {
      const session = findSession(args.sessionId);
      ensureEditable(session);
      if (!nextPickedFile) return null;
      const watch: FileWatchStatus = {
        id: newId("watch"),
        sessionId: session.id,
        path: nextPickedFile,
        fileName: nextPickedFile.split(/[\\/]/).pop() ?? nextPickedFile,
        startedAt: next(),
        active: true,
        changesRecorded: 0,
        lastChangeAt: null,
        lastError: null,
      };
      fileWatches.push(watch);
      return watch;
    },
    stop_config_watch: (args) => {
      const watch = fileWatches.find((item) => item.id === args.watchId);
      if (!watch) return null;
      fileWatches = fileWatches.filter((item) => item.id !== watch.id);
      return { ...watch, active: false };
    },
    list_config_watches: (args) => fileWatches.filter((watch) => watch.sessionId === args.sessionId),
    create_backup: () => {
      if (capture.state !== "idle") fail("conflict", "Stop the capture before backing up, so every screenshot is included.", "capture");
      if (!nextBackupTarget) return null;
      lastBackup = {
        fileName: nextBackupTarget.split(/[\\/]/).pop() ?? nextBackupTarget,
        path: nextBackupTarget,
        sizeBytes: 48_213,
        fileCount: 1 + attachments.length,
        createdAt: next(),
      };
      return lastBackup;
    },
    reveal_backup: () => {
      if (!lastBackup) fail("not_found", "Backup was not found. It may have been deleted.");
      revealed.push(lastBackup!.path);
      return null;
    },
    choose_backup: () => {
      if (!nextBackupToRestore) return null;
      if (nextBackupToRestore === "damaged") fail("validation", "This file is not a usable DevTrace backup (it has no DevTrace manifest).", "backup");
      pendingRestoreToken = newId("token");
      const info: BackupInfo = {
        token: pendingRestoreToken,
        fileName: nextBackupToRestore,
        sizeBytes: 48_213,
        createdAt: "2026-10-20T09:30:00.000Z",
        appVersion: "0.1.0",
        schemaVersion: 2,
        workspaceName: "Network Lab",
        counts: { projects: 2, sessions: 5, playbooks: 3, changes: 4 },
        fileCount: 12,
        totalBytes: 2_400_000,
      };
      return info;
    },
    restore_backup: (args) => {
      if (capture.state !== "idle") fail("conflict", "Stop the capture before restoring a backup.", "capture");
      if (!pendingRestoreToken || args.token !== pendingRestoreToken) fail("conflict", "Choose the backup again; the selection has expired.", "token");
      pendingRestoreToken = null;
      restores.push(String(args.token));
      return { previousData: "backups/before-restore-20261023T090000Z", schemaVersion: 6 };
    },
    review_events: (args) => {
      const session = findSession(args.sessionId);
      const ids = args.eventIds as string[];
      const status = args.status as EventReviewStatus;
      const comment = typeof args.comment === "string" ? args.comment : "";
      if (ids.length === 0) fail("validation", "Select at least one step.", "eventIds");
      const targets = ids.map(findEvent);
      if (targets.some((event) => event.sessionId !== session.id)) fail("validation", "A step belongs to a different session.", "eventIds");
      for (const event of targets) {
        if (event.reviewStatus === status && !comment.trim()) continue;
        const from = event.reviewStatus;
        event.reviewStatus = status;
        decide(session, event.id, DECISION_FOR[status], comment, { from, to: status });
      }
      refreshReviewState(session);
      touch(session, next());
      return targets.map(withAttachments);
    },
    reorder_events: (args) => {
      const session = findSession(args.sessionId);
      ensureEditable(session);
      const ids = args.eventIds as string[];
      const current = events.filter((event) => event.sessionId === session.id).sort((a, b) => a.position - b.position);
      if (ids.length !== current.length || [...ids].sort().join() !== current.map((event) => event.id).sort().join()) {
        fail("conflict", "The steps of this session changed. Refresh and try again.", "eventIds");
      }
      ids.forEach((id, position) => {
        findEvent(id).position = position;
      });
      decide(session, null, "reorder", "", { order: ids });
      refreshReviewState(session);
      return events
        .filter((event) => event.sessionId === session.id)
        .sort((a, b) => a.position - b.position)
        .map(withAttachments);
    },
    redact_attachment: (args) => {
      const attachment = attachments.find((item) => item.id === args.id) ?? fail("not_found", "Attachment was not found.");
      const session = findSession(attachment.sessionId);
      ensureEditable(session);
      const regions = args.regions as Region[];
      if (regions.length === 0) fail("validation", "Mark at least one area to redact.", "regions");
      for (const region of regions) {
        if (region.width <= 0 || region.height <= 0 || region.x + region.width > (attachment.width ?? 0) || region.y + region.height > (attachment.height ?? 0)) {
          fail("validation", "An area to redact lies outside the image.", "regions");
        }
      }
      const previous = attachment.sha256;
      attachment.sha256 = (sequence++).toString(16).padStart(64, "a");
      attachment.mediaType = "image/png";
      attachment.redactedAt = next();
      decide(session, attachment.eventId, "redact", "", { attachmentId: attachment.id, regions, previousSha256: previous });
      refreshReviewState(session);
      return { attachment, originalFile: { removed: 1, missing: 0, failed: 0 } };
    },
    get_review_summary: (args) => {
      const session = findSession(args.sessionId);
      const own = events.filter((event) => event.sessionId === session.id);
      const count = (status: EventReviewStatus) => own.filter((event) => event.reviewStatus === status).length;
      return {
        sessionId: session.id,
        reviewState: session.reviewState,
        total: own.length,
        pending: count("pending"),
        approved: count("approved"),
        rejected: count("rejected"),
        excluded: count("excluded"),
      };
    },
    list_review_decisions: (args) => decisions.filter((decision) => decision.sessionId === findSession(args.sessionId).id),
    mark_session_reviewed: (args) => {
      const session = findSession(args.id);
      const own = events.filter((event) => event.sessionId === session.id);
      if (own.length === 0) fail("conflict", "Add steps before reviewing this session.", "reviewState");
      const pending = own.filter((event) => event.reviewStatus === "pending").length;
      if (pending > 0) fail("conflict", `${pending} ${pending === 1 ? "step" : "steps"} still need a decision.`, "reviewState");
      session.reviewState = "reviewed";
      decide(session, null, "mark_reviewed", typeof args.comment === "string" ? args.comment : "", {});
      return detail(session);
    },
    reopen_session_review: (args) => {
      const session = findSession(args.id);
      if (session.reviewState !== "reviewed") fail("conflict", "Only a finished review can be reopened.", "reviewState");
      session.reviewState = "in_review";
      decide(session, null, "reopen_review", "", {});
      return detail(session);
    },
  };

  return {
    calls,
    get settings() {
      return settings;
    },
    get projects() {
      return projects;
    },
    get sessions() {
      return sessions;
    },
    get events() {
      return events;
    },
    get attachments() {
      return attachments;
    },
    get capture() {
      return capture;
    },
    get decisions() {
      return decisions;
    },
    get playbooks() {
      return playbooks;
    },
    exports: exportsWritten,
    revealed,
    get changes() {
      return changes;
    },
    get terminalLogs() {
      return terminalLogs;
    },
    get fileWatches() {
      return fileWatches;
    },
    /** Sets the file the next "Watch a file…" dialog returns (null = cancelled). */
    pickFile(path: string | null) {
      nextPickedFile = path;
    },
    /** Sets where the next backup is saved (null = the save dialog is cancelled). */
    saveBackupTo(path: string | null) {
      nextBackupTarget = path;
    },
    /** Sets the backup the next "Restore from backup…" picks ("damaged" fails validation, null cancels). */
    pickBackup(name: string | null) {
      nextBackupToRestore = name;
    },
    restores,
    files,
    async invoke(command: string, args?: Record<string, unknown> | Uint8Array, options?: InvokeOptions) {
      calls.push(command);
      const handler = handlers[command];
      if (!handler) fail("internal", `Unknown command ${command}`);
      const payload = args instanceof Uint8Array ? { body: args } : (args ?? {});
      return structuredClone(handler!(payload, options ?? {}));
    },
  };
}

export type FakeBackend = ReturnType<typeof createFakeBackend>;

/** Minimal PNG header bytes accepted by the fake (and real) backend's signature check. */
export function pngBytes(): Uint8Array<ArrayBuffer> {
  return new Uint8Array([...PNG_SIGNATURE, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 2, 128, 0, 0, 1, 144, 8, 6, 0, 0, 0]);
}
