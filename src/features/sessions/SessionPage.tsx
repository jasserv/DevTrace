import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import {
  BadgeCheck,
  ChevronDown,
  CircleCheck,
  CircleDot,
  Ellipsis,
  ExternalLink,
  FilePlus2,
  ImagePlus,
  ListFilter,
  Lock,
  Pencil,
  Plus,
  RotateCcw,
  SearchX,
  Trash2,
  Upload,
} from "lucide-react";

import { useCapture } from "../../app/contexts";
import {
  Button,
  ConfirmDialog,
  EmptyState,
  Icon,
  IconButton,
  Menu,
  Notice,
  Select,
  Spinner,
  StatusBadge,
  Timeline,
  useToast,
  type MenuEntry,
  type SelectOption,
  type TimelineEvent,
} from "../../components";
import { Page } from "../../layout/Page";
import {
  api,
  toApiError,
  type Annotation,
  type Attachment,
  type CapturedShot,
  type CaptureStatus,
  type FileWatchStatus,
  type TerminalLogStatus,
  type EventReviewStatus,
  type FileCleanup,
  type ImportedImage,
  type Region,
  type SessionDetail,
  type SessionEvent,
  type SessionStatus,
} from "../../lib/api";
import { BACKEND_EVENTS, listenBackend } from "../../lib/events";
import { formatBytes, formatDateTime, pluralize } from "../../lib/format";
import { useHotkeys, useResource, type Resource } from "../../lib/hooks";
import { formatShortcut } from "../../lib/platform";
import { eventReviewStatus, reviewState, sessionStatus } from "../../lib/status";
import { CaptureAlerts, CaptureControls } from "../capture/CaptureControls";
import { EventFormDialog, type EventFormMode } from "./EventFormDialog";
import { EvidencePane } from "./EvidencePane";
import { eventTypes, manualEventTypes } from "./eventTypes";
import { markReviewedBlocker, moveInOrder, REVIEW_KEYS, reviewCounts } from "./review";
import { SessionFormDialog } from "./SessionFormDialog";
import { SessionInspector, type InspectorTab } from "./SessionInspector";
import styles from "./SessionPage.module.css";
import { useImageImport } from "./useImageImport";

const READ_ONLY_REASON = "This session is completed. Reopen it to change its steps or evidence.";
const SESSIONS_CRUMB = [{ label: "Sessions", to: "/sessions" }];

type ReviewFilter = "all" | EventReviewStatus;

export type SessionVariant = "session" | "capture";

interface SessionPageProps {
  /** Shows this session instead of the one in the URL (used by the Capture workspace). */
  sessionIdOverride?: string;
  /** "capture" titles the page "Capture" and adds the capture controls. */
  variant?: SessionVariant;
}

/** `/sessions/:sessionId` - remounts per session so no state leaks between sessions. */
export function SessionPage({ sessionIdOverride, variant = "session" }: SessionPageProps) {
  const { sessionId: routeId = "" } = useParams();
  const sessionId = sessionIdOverride ?? routeId;
  return <SessionLoader key={sessionId} sessionId={sessionId} variant={variant} />;
}

function SessionLoader({ sessionId, variant }: { sessionId: string; variant: SessionVariant }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const initialStepId = params.get("step");
  const fetchSession = useCallback(() => api.sessions.get(sessionId), [sessionId]);
  const fetchEvents = useCallback(() => api.events.list(sessionId), [sessionId]);
  const session = useResource(fetchSession);
  const events = useResource(fetchEvents);

  if (session.data) {
    return <SessionWorkspace session={session.data} sessionResource={session} events={events} variant={variant} initialStepId={initialStepId} />;
  }

  const missing = session.error?.kind === "not_found" || session.error?.kind === "validation";
  return (
    <Page title={missing ? "Session not found" : session.error ? "Session unavailable" : "Loading session\u2026"} breadcrumbs={SESSIONS_CRUMB}>
      <div className={styles.centered}>
        {missing ? (
          <EmptyState
            icon={SearchX}
            title="Session not found"
            description="It may have been deleted."
            actions={<Button onClick={() => navigate("/sessions")}>Show all sessions</Button>}
          />
        ) : session.error ? (
          <Notice
            tone="danger"
            role="alert"
            title="The session could not be loaded"
            action={
              <Button size="sm" onClick={session.reload}>
                Retry
              </Button>
            }
          >
            {session.error.message}
          </Notice>
        ) : (
          <Spinner size={18} />
        )}
      </div>
    </Page>
  );
}

type Confirmation =
  | { kind: "session" }
  | { kind: "event"; event: SessionEvent }
  | { kind: "attachment"; event: SessionEvent; attachment: Attachment };

interface SessionWorkspaceProps {
  session: SessionDetail;
  sessionResource: Resource<SessionDetail>;
  events: Resource<SessionEvent[]>;
  variant: SessionVariant;
  /** Step to select first (from a link). */
  initialStepId?: string | null;
}

function SessionWorkspace({ session, sessionResource, events: eventsResource, variant, initialStepId = null }: SessionWorkspaceProps) {
  const navigate = useNavigate();
  const toast = useToast();
  const capture = useCapture();
  const timelineHeadingId = useId();
  const events = useMemo(() => eventsResource.data ?? [], [eventsResource.data]);
  const editable = session.status !== "completed";
  const capturing = capture.status.state !== "idle" && capture.status.sessionId === session.id;
  const reloadSession = sessionResource.reload;
  const reloadEvents = eventsResource.reload;

  const [selectedId, setSelectedId] = useState<string | null>(initialStepId);
  const [selectedAttachmentId, setSelectedAttachmentId] = useState<string | null>(null);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("step");
  const [eventDialog, setEventDialog] = useState<EventFormMode | null>(null);
  const [editingDetails, setEditingDetails] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>("all");
  const [reviewBusy, setReviewBusy] = useState(false);

  const fetchDecisions = useCallback(() => api.review.decisions(session.id), [session.id]);
  const decisionsResource = useResource(fetchDecisions);
  const decisions = useMemo(() => decisionsResource.data ?? [], [decisionsResource.data]);
  const reloadDecisions = decisionsResource.reload;
  const counts = useMemo(() => reviewCounts(events), [events]);

  const refresh = useCallback(() => {
    reloadSession();
    reloadEvents();
    reloadDecisions();
  }, [reloadSession, reloadEvents, reloadDecisions]);

  const select = useCallback((eventId: string | null, attachmentId: string | null = null) => {
    setSelectedId(eventId);
    setSelectedAttachmentId(attachmentId);
  }, []);

  // Screenshots appear immediately and are selected, whether taken with Capture now (published
  // locally) or in the background with the shortcut or tray menu (backend event). The same shot
  // can arrive through both channels; it is handled once. Automatic screenshots only appear in
  // the list: selecting them would pull the user away from the step they are working on.
  const handledShot = useRef<string | null>(null);
  useEffect(
    () =>
      listenBackend<CapturedShot>(BACKEND_EVENTS.captureCaptured, (shot) => {
        if (shot.sessionId !== session.id || handledShot.current === shot.attachmentId) return;
        handledShot.current = shot.attachmentId;
        if (shot.trigger !== "auto") {
          select(shot.eventId, shot.attachmentId);
          setInspectorTab("step");
        }
        refresh();
      }),
    [session.id, select, refresh],
  );

  // Capture state changes (start, pause, stop) change the session status shown here.
  useEffect(
    () =>
      listenBackend<CaptureStatus>(BACKEND_EVENTS.captureStatus, (status) => {
        if (status.sessionId === session.id || status.state === "idle") reloadSession();
      }),
    [session.id, reloadSession],
  );

  // Terminal logs and watched files add recorded steps in the background.
  useEffect(() => {
    const onRecorded = (payload: { sessionId: string }) => {
      if (payload.sessionId === session.id) refresh();
    };
    const stopLogs = listenBackend<TerminalLogStatus>(BACKEND_EVENTS.terminalLog, onRecorded);
    const stopWatches = listenBackend<FileWatchStatus>(BACKEND_EVENTS.fileWatch, onRecorded);
    return () => {
      stopLogs();
      stopWatches();
    };
  }, [session.id, refresh]);

  // The review filter narrows the step list; selection falls back to the first visible step, so
  // something is shown whenever possible.
  const visibleEvents = useMemo(
    () => (reviewFilter === "all" ? events : events.filter((event) => event.reviewStatus === reviewFilter)),
    [events, reviewFilter],
  );
  const selected = visibleEvents.find((event) => event.id === selectedId) ?? visibleEvents[0] ?? null;
  const selectedIndex = selected ? events.findIndex((event) => event.id === selected.id) : 0;
  const currentAttachment = selected
    ? (selected.attachments.find((attachment) => attachment.id === selectedAttachmentId) ?? selected.attachments[0] ?? null)
    : null;

  const screenshots = useMemo(
    () => visibleEvents.flatMap((event) => event.attachments.map((attachment) => ({ eventId: event.id, attachmentId: attachment.id }))),
    [visibleEvents],
  );
  const screenshotIndex = currentAttachment ? screenshots.findIndex((item) => item.attachmentId === currentAttachment.id) : -1;
  const goToScreenshot = (offset: number) => {
    const target = screenshots[screenshotIndex + offset];
    if (target) select(target.eventId, target.attachmentId);
  };

  const onImported = useCallback(
    (result: ImportedImage) => {
      select(result.event.id, result.attachmentId);
      setInspectorTab("step");
      refresh();
    },
    [select, refresh],
  );

  const saveAnnotations = useCallback(
    async (attachment: Attachment, annotations: Annotation[]) => {
      try {
        await api.attachments.updateAnnotations(attachment.id, annotations);
        reloadEvents();
      } catch (raw) {
        toast.error("Annotations were not saved", toApiError(raw).message);
      }
    },
    [reloadEvents, toast],
  );
  const imageImport = useImageImport({ sessionId: session.id, editable, readOnlyReason: READ_ONLY_REASON, onImported });

  const openEventDialog = useCallback(
    (mode: EventFormMode) => {
      if (document.querySelector("dialog[open]")) return;
      if (mode.kind === "create" && !editable) return;
      setEventDialog(mode);
    },
    [editable],
  );

  useHotkeys(
    useMemo(() => [{ key: "n", mod: true, handler: () => openEventDialog({ kind: "create", eventType: "step" }) }], [openEventDialog]),
  );

  const reportFiles = (files: FileCleanup) => {
    if (files.failed > 0) {
      toast.error(
        `${pluralize(files.failed, "file")} could not be removed`,
        "The records were deleted, but the files remain in the workspace attachments folder. You can delete them manually.",
      );
    }
  };

  const changeStatus = async (status: SessionStatus) => {
    setStatusBusy(true);
    try {
      await api.sessions.setStatus(session.id, status);
      if (status === "completed") toast.success("Session completed", "Steps and evidence are now read-only.");
      else toast.success("Session reopened", "Steps and evidence can be changed again.");
      refresh();
    } catch (raw) {
      toast.error(status === "completed" ? "The session could not be completed" : "The session could not be reopened", toApiError(raw).message);
    } finally {
      setStatusBusy(false);
    }
  };

  const review = useCallback(
    async (event: SessionEvent, status: EventReviewStatus, comment: string): Promise<boolean> => {
      try {
        await api.review.setStatus(session.id, [event.id], status, comment);
        refresh();
        return true;
      } catch (raw) {
        toast.error("The review decision was not saved", toApiError(raw).message);
        return false;
      }
    },
    [session.id, refresh, toast],
  );

  const move = useCallback(
    async (event: SessionEvent, delta: -1 | 1) => {
      if (!editable) {
        toast.error("Steps cannot be reordered", READ_ONLY_REASON);
        return;
      }
      const order = moveInOrder(
        events.map((item) => item.id),
        event.id,
        delta,
      );
      if (!order) return;
      try {
        await api.review.reorder(session.id, order);
        select(event.id);
        refresh();
      } catch (raw) {
        toast.error("The steps were not reordered", toApiError(raw).message);
      }
    },
    [editable, events, session.id, select, refresh, toast],
  );

  const markReviewed = async () => {
    setReviewBusy(true);
    try {
      await api.review.markReviewed(session.id);
      toast.success("Review finished", `${pluralize(counts.approved, "approved step")} can be used for documentation.`);
      refresh();
    } catch (raw) {
      toast.error("The review could not be finished", toApiError(raw).message);
    } finally {
      setReviewBusy(false);
    }
  };

  const [creatingPlaybook, setCreatingPlaybook] = useState(false);
  const createPlaybook = async () => {
    setCreatingPlaybook(true);
    try {
      const playbook = await api.playbooks.createFromSession(session.id);
      toast.success("Playbook created", `${pluralize(playbook.content.steps.length, "approved step")} copied into a new draft.`);
      navigate(`/playbooks/${playbook.id}`);
    } catch (raw) {
      toast.error("The playbook could not be created", toApiError(raw).message);
    } finally {
      setCreatingPlaybook(false);
    }
  };
  const playbookBlocker = counts.approved === 0 ? "Approve at least one step first. Only approved steps become playbook content." : undefined;

  const reopenReview = async () => {
    setReviewBusy(true);
    try {
      await api.review.reopen(session.id);
      toast.success("Review reopened");
      refresh();
    } catch (raw) {
      toast.error("The review could not be reopened", toApiError(raw).message);
    } finally {
      setReviewBusy(false);
    }
  };

  /** Errors propagate to the confirmation dialog, which shows them and stays open. */
  const redact = async (attachment: Attachment, regions: Region[]): Promise<void> => {
    const result = await api.review.redact(attachment.id, regions);
    if (result.originalFile.failed > 0) {
      toast.error(
        "The original image could not be deleted",
        "The redacted image is in use, but the unredacted file remains in the workspace attachments folder. Delete it manually.",
      );
    } else {
      toast.success("Screenshot redacted", `${pluralize(regions.length, "area")} permanently blacked out. The original image was deleted.`);
    }
    refresh();
  };

  const onTimelineKey = (keyboardEvent: KeyboardEvent<HTMLLIElement>, id: string) => {
    const event = events.find((item) => item.id === id);
    if (!event) return;
    if (keyboardEvent.altKey && (keyboardEvent.key === "ArrowUp" || keyboardEvent.key === "ArrowDown")) {
      keyboardEvent.preventDefault();
      void move(event, keyboardEvent.key === "ArrowUp" ? -1 : 1);
      return;
    }
    const status = REVIEW_KEYS[keyboardEvent.key.toLowerCase()];
    if (status && !keyboardEvent.altKey && !keyboardEvent.ctrlKey && !keyboardEvent.metaKey) {
      keyboardEvent.preventDefault();
      if (status !== event.reviewStatus) void review(event, status, "");
    }
  };

  const confirm = async () => {
    if (!confirmation) return;
    if (confirmation.kind === "session") {
      const result = await api.sessions.remove(session.id);
      toast.success(
        "Session deleted",
        `\u201c${result.title}\u201d, ${pluralize(result.eventCount, "step")} and ${pluralize(result.files.removed, "screenshot file")} were removed.`,
      );
      reportFiles(result.files);
      navigate("/sessions", { replace: true });
      return;
    }
    if (confirmation.kind === "event") {
      const { event } = confirmation;
      const result = await api.events.remove(event.id);
      const index = events.findIndex((item) => item.id === event.id);
      const neighbor = events[index + 1] ?? events[index - 1] ?? null;
      select(neighbor?.id ?? null);
      toast.success(`${eventTypes[event.eventType].label} deleted`, event.title);
      reportFiles(result.files);
      refresh();
      return;
    }
    const { event, attachment } = confirmation;
    const result = await api.attachments.remove(attachment.id);
    select(event.id);
    toast.success("Screenshot removed", event.title);
    reportFiles(result.files);
    refresh();
  };

  const timelineEvents: TimelineEvent[] = visibleEvents.map((event) => {
    const info = eventTypes[event.eventType];
    const images = event.attachments.length;
    const redundant = event.eventType === "screenshot" && images === 1;
    return {
      id: event.id,
      occurredAt: event.occurredAt,
      title: event.title,
      typeLabel: info.label,
      icon: info.icon,
      detail: images > 0 && !redundant ? pluralize(images, "image") : undefined,
      status: event.reviewStatus === "pending" ? undefined : eventReviewStatus[event.reviewStatus],
      excluded: event.reviewStatus === "rejected" || event.reviewStatus === "excluded",
    };
  });

  const filterOptions: SelectOption[] = [
    { value: "all", label: `All steps (${counts.total})` },
    { value: "pending", label: `Pending (${counts.pending})` },
    { value: "approved", label: `Approved (${counts.approved})` },
    { value: "rejected", label: `Rejected (${counts.rejected})` },
    { value: "excluded", label: `Excluded (${counts.excluded})` },
  ];

  const addEntries: MenuEntry[] = [
    ...manualEventTypes.map((type) => ({
      id: type,
      label: `${eventTypes[type].label}\u2026`,
      icon: eventTypes[type].icon,
      description: eventTypes[type].description,
      onSelect: () => openEventDialog({ kind: "create", eventType: type }),
    })),
    { type: "separator", id: "separator" },
    {
      id: "screenshot",
      label: "Screenshot from file\u2026",
      icon: ImagePlus,
      description: `PNG, JPEG, GIF or WebP \u00b7 or paste with ${formatShortcut("V")}`,
      onSelect: () => imageImport.chooseFiles(),
    },
  ];

  const actions = (
    <>
      {variant === "capture" && capturing && <CaptureControls />}
      {editable ? (
        <Menu
          label="Add to session"
          align="end"
          entries={addEntries}
          renderTrigger={(props) => (
            <Button {...props} variant={variant === "capture" ? "secondary" : "primary"} icon={Plus} iconEnd={ChevronDown}>
              Add
            </Button>
          )}
        />
      ) : (
        <Button variant="primary" icon={Plus} iconEnd={ChevronDown} disabledReason={READ_ONLY_REASON}>
          Add
        </Button>
      )}
      {variant === "session" && session.reviewState === "reviewed" && (
        <Button
          icon={FilePlus2}
          loading={creatingPlaybook}
          onClick={() => void createPlaybook()}
          tooltip="Copy the approved steps and their evidence into a new draft playbook"
          disabledReason={playbookBlocker}
        >
          Create playbook
        </Button>
      )}
      {variant === "session" && session.reviewState !== "reviewed" && (
        <Button
          icon={BadgeCheck}
          loading={reviewBusy}
          onClick={() => void markReviewed()}
          tooltip="Finish the review once every step is approved, rejected or excluded"
          disabledReason={markReviewedBlocker(counts)}
        >
          Mark reviewed
        </Button>
      )}
      {variant === "session" &&
        (editable ? (
          <Button
            icon={CircleCheck}
            loading={statusBusy}
            onClick={() => void changeStatus("completed")}
            tooltip="Finish documenting. Steps and evidence become read-only until reopened."
            disabledReason={
              capturing
                ? "This session is being captured. Stop the capture first."
                : events.length === 0
                  ? "Add at least one step before completing this session."
                  : undefined
            }
          >
            Complete
          </Button>
        ) : (
          <Button icon={RotateCcw} loading={statusBusy} onClick={() => void changeStatus("draft")} tooltip="Allow changes to steps and evidence again">
            Reopen
          </Button>
        ))}
      <Menu
        label="Session actions"
        align="end"
        entries={[
          ...(variant === "capture"
            ? [{ id: "open", label: "Open session page", icon: ExternalLink, onSelect: () => navigate(`/sessions/${session.id}`) }]
            : []),
          { id: "edit", label: "Edit details\u2026", icon: Pencil, onSelect: () => setEditingDetails(true) },
          {
            id: "playbook",
            label: "Create playbook from approved steps",
            icon: FilePlus2,
            disabled: counts.approved === 0,
            description: playbookBlocker,
            onSelect: () => void createPlaybook(),
          },
          ...(session.reviewState === "reviewed"
            ? [{ id: "reopen-review", label: "Reopen review", icon: RotateCcw, onSelect: () => void reopenReview() }]
            : []),
          { type: "separator", id: "separator" },
          {
            id: "delete",
            label: "Delete session\u2026",
            icon: Trash2,
            tone: "danger",
            disabled: capturing,
            description: capturing ? "Stop the capture before deleting this session." : undefined,
            onSelect: () => setConfirmation({ kind: "session" }),
          },
        ]}
        renderTrigger={(props) => <IconButton {...props} icon={Ellipsis} label="More session actions" />}
      />
    </>
  );

  return (
    <Page
      title={variant === "capture" ? "Capture" : session.title}
      breadcrumbs={variant === "capture" ? [] : SESSIONS_CRUMB}
      layout="fill"
      actions={actions}
    >
      <div className={styles.workspace}>
        <div className={styles.meta}>
          {variant === "capture" && <span className={styles.metaSession}>{session.title}</span>}
          <StatusBadge status={sessionStatus[session.status]} />
          <StatusBadge status={reviewState[session.reviewState]} />
          <MetaItem label="Project">
            {session.projectId ? <Link to={`/projects/${session.projectId}`}>{session.projectName}</Link> : "Unassigned"}
          </MetaItem>
          {session.application && <MetaItem label="Application">{session.application}</MetaItem>}
          {session.environment && <MetaItem label="Environment">{session.environment}</MetaItem>}
          <MetaItem label="Created">{formatDateTime(session.createdAt)}</MetaItem>
          {session.endedAt && <MetaItem label="Completed">{formatDateTime(session.endedAt)}</MetaItem>}
          <span className={styles.metaSpacer} />
          <span className={styles.metaCounts}>
            {pluralize(session.eventCount, "step")} · {pluralize(session.attachmentCount, "screenshot")}
            {session.attachmentCount > 0 && ` \u00b7 ${formatBytes(session.attachmentBytes)}`}
            {counts.total > 0 && ` \u00b7 ${counts.decided} of ${counts.total} reviewed`}
          </span>
        </div>

        {!editable && (
          <Notice tone="neutral" icon={Lock} className={styles.banner} title="Completed">
            Steps and evidence are read-only. Session notes and details can still be edited. Reopen the session to make other
            changes.
          </Notice>
        )}
        {variant === "capture" && capturing && <CaptureAlerts className={styles.banner} />}
        {variant === "session" && capturing && (
          <Notice
            tone="info"
            icon={CircleDot}
            className={styles.banner}
            title={capture.status.state === "paused" ? "Capture paused" : "Recording"}
            action={
              <Button size="sm" onClick={() => navigate("/capture")}>
                Open Capture
              </Button>
            }
          >
            Screenshots of {capture.status.target?.title ?? "the selected target"} are added to this session as you capture them.
          </Notice>
        )}

        <div className={styles.panes} {...imageImport.dropZoneProps}>
          <section className={styles.timelinePane} aria-labelledby={timelineHeadingId}>
            <header className={styles.paneHeader}>
              <h2 id={timelineHeadingId} className={styles.paneTitle}>
                Steps
              </h2>
              <span className={styles.paneCount}>{events.length}</span>
              {imageImport.pending > 0 && (
                <span className={styles.pending} role="status">
                  <Spinner size={12} />
                  Adding {pluralize(imageImport.pending, "image")}…
                </span>
              )}
              <span className={styles.metaSpacer} />
              {events.length > 0 && (
                <Select
                  size="sm"
                  aria-label="Show steps"
                  options={filterOptions}
                  value={reviewFilter}
                  onChange={(change) => setReviewFilter(change.target.value as ReviewFilter)}
                />
              )}
            </header>
            <div className={styles.paneBody}>
              {eventsResource.error ? (
                <div className={styles.paneEmpty}>
                  <Notice
                    tone="danger"
                    role="alert"
                    title="Steps could not be loaded"
                    action={
                      <Button size="sm" onClick={reloadEvents}>
                        Retry
                      </Button>
                    }
                  >
                    {eventsResource.error.message}
                  </Notice>
                </div>
              ) : (
                <Timeline
                  label="Session steps"
                  events={timelineEvents}
                  selectedId={selected?.id ?? null}
                  onSelect={(id) => {
                    // Choosing a step shows its details, even when the Session tab was open.
                    select(id);
                    setInspectorTab("step");
                  }}
                  onActivate={(id) => {
                    const event = events.find((item) => item.id === id);
                    if (event && editable) openEventDialog({ kind: "edit", event });
                  }}
                  onItemKeyDown={onTimelineKey}
                  empty={
                    eventsResource.loading && !eventsResource.data ? null : events.length > 0 ? (
                      <div className={styles.paneEmpty}>
                        <EmptyState
                          compact
                          headingLevel={3}
                          icon={ListFilter}
                          title="No matching steps"
                          description={`No step is ${filterOptions.find((option) => option.value === reviewFilter)?.label.replace(/ \(\d+\)$/, "").toLowerCase() ?? "in this view"}.`}
                          actions={
                            <Button size="sm" onClick={() => setReviewFilter("all")}>
                              Show all steps
                            </Button>
                          }
                        />
                      </div>
                    ) : (
                      <div className={styles.paneEmpty}>
                        <EmptyState
                          compact
                          headingLevel={3}
                          icon={eventTypes.step.icon}
                          title="No steps yet"
                          description={
                            editable
                              ? "Document the task as you work: add steps, notes and commands, or add screenshots."
                              : "This session has no steps."
                          }
                          actions={
                            editable ? (
                              <>
                                <Button size="sm" icon={Plus} onClick={() => openEventDialog({ kind: "create", eventType: "step" })}>
                                  Add step
                                </Button>
                                <Button size="sm" icon={ImagePlus} onClick={() => imageImport.chooseFiles()}>
                                  Add screenshot
                                </Button>
                              </>
                            ) : undefined
                          }
                        />
                      </div>
                    )
                  }
                />
              )}
            </div>
            {editable && (
              <p className={styles.paneFooter}>
                {capturing
                  ? `Capture now${capture.status.shortcutActive ? ` or ${capture.status.shortcut}` : ""} adds a screenshot of ${capture.status.target?.title ?? "the selected target"}. You can also paste or drop images.`
                  : `Paste a screenshot with ${formatShortcut("V")} or drop image files anywhere in this session. To take screenshots, start a capture.`}
              </p>
            )}
          </section>

          <EvidencePane
            event={selected}
            attachment={currentAttachment}
            position={{ index: screenshotIndex + 1, total: screenshots.length }}
            onPrevious={() => goToScreenshot(-1)}
            onNext={() => goToScreenshot(1)}
            editable={editable}
            readOnlyReason={READ_ONLY_REASON}
            onChooseFiles={imageImport.chooseFiles}
            onAnnotationsChange={(attachment, annotations) => void saveAnnotations(attachment, annotations)}
            onRedact={redact}
          />

          <SessionInspector
            session={session}
            event={selected}
            eventIndex={selectedIndex + 1}
            eventTotal={events.length}
            attachmentId={currentAttachment?.id ?? null}
            tab={inspectorTab}
            onTabChange={setInspectorTab}
            editable={editable}
            readOnlyReason={READ_ONLY_REASON}
            onEditEvent={(event) => openEventDialog({ kind: "edit", event })}
            onDeleteEvent={(event) => setConfirmation({ kind: "event", event })}
            onAttach={(event) => imageImport.chooseFiles(event.id)}
            onSelectAttachment={(event, attachment) => select(event.id, attachment.id)}
            onRemoveAttachment={(event, attachment) => setConfirmation({ kind: "attachment", event, attachment })}
            onAnnotationsChange={(attachment, annotations) => void saveAnnotations(attachment, annotations)}
            onEditDetails={() => setEditingDetails(true)}
            decisions={decisions}
            reviewCounts={counts}
            reviewBusy={reviewBusy}
            onReview={review}
            onMove={(event, delta) => void move(event, delta)}
            onMarkReviewed={() => void markReviewed()}
            onReopenReview={() => void reopenReview()}
          />

          {imageImport.dragging && (
            <div className={styles.dropOverlay} aria-hidden="true">
              <div className={styles.dropMessage}>
                <Icon icon={editable ? Upload : Lock} size={20} />
                <span className={styles.dropTitle}>{editable ? "Drop images to add screenshots" : "This session is completed"}</span>
                <span className={styles.dropText}>
                  {editable ? "Each image becomes a screenshot step. PNG, JPEG, GIF or WebP, up to 25 MB." : "Reopen it to add screenshots."}
                </span>
              </div>
            </div>
          )}
        </div>
        <input {...imageImport.inputProps} />
      </div>

      {eventDialog && (
        <EventFormDialog
          sessionId={session.id}
          mode={eventDialog}
          onClose={() => setEventDialog(null)}
          onSaved={(event, created) => {
            setEventDialog(null);
            toast.success(created ? `${eventTypes[event.eventType].label} added` : "Changes saved", event.title);
            select(event.id);
            setInspectorTab("step");
            refresh();
          }}
        />
      )}
      {editingDetails && (
        <SessionFormDialog
          session={session}
          onClose={() => setEditingDetails(false)}
          onSaved={(saved) => {
            setEditingDetails(false);
            toast.success("Session updated", saved.title);
            refresh();
          }}
        />
      )}
      <ConfirmDialog
        open={confirmation !== null}
        onClose={() => setConfirmation(null)}
        title={confirmationTitle(confirmation, session)}
        confirmLabel={confirmation?.kind === "session" ? "Delete session" : confirmation?.kind === "event" ? "Delete" : "Remove screenshot"}
        tone="danger"
        onConfirm={confirm}
      >
        {confirmation && <ConfirmationMessage confirmation={confirmation} session={session} />}
      </ConfirmDialog>
    </Page>
  );
}

function MetaItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className={styles.metaItem}>
      <span className={styles.metaLabel}>{label}</span>
      <span className={styles.metaValue}>{children}</span>
    </span>
  );
}

function confirmationTitle(confirmation: Confirmation | null, session: SessionDetail): string {
  if (!confirmation) return "Confirm";
  if (confirmation.kind === "session") return `Delete \u201c${session.title}\u201d?`;
  if (confirmation.kind === "event") return `Delete this ${eventTypes[confirmation.event.eventType].label.toLowerCase()}?`;
  return "Remove this screenshot?";
}

function ConfirmationMessage({ confirmation, session }: { confirmation: Confirmation; session: SessionDetail }) {
  if (confirmation.kind === "session") {
    return (
      <>
        <p>The session and everything recorded in it will be permanently deleted from this workspace:</p>
        <ul>
          <li>{pluralize(session.eventCount, "step")}</li>
          <li>
            {pluralize(session.attachmentCount, "screenshot")}
            {session.attachmentCount > 0 && ` (${formatBytes(session.attachmentBytes)}), including the image files`}
          </li>
          <li>Session notes and details</li>
        </ul>
        {session.playbookCount > 0 && <p>{pluralize(session.playbookCount, "linked playbook")} will be kept but lose the link to this session.</p>}
        {session.changeCount > 0 && <p>{pluralize(session.changeCount, "change record")} will be kept without a session reference.</p>}
        <p>This cannot be undone.</p>
      </>
    );
  }
  if (confirmation.kind === "event") {
    const { event } = confirmation;
    return (
      <>
        <p>
          {"\u201c"}
          {event.title}
          {"\u201d"} will be permanently deleted from this session.
        </p>
        {event.attachments.length > 0 && (
          <p>Its {pluralize(event.attachments.length, "screenshot")} will also be deleted, including the image files.</p>
        )}
      </>
    );
  }
  return (
    <p>
      The screenshot will be removed from {"\u201c"}
      {confirmation.event.title}
      {"\u201d"} and its image file deleted from the workspace. The step itself is kept.
    </p>
  );
}
