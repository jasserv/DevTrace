import { useCallback, useState } from "react";
import { Link } from "react-router";
import { Highlighter, MousePointerClick, Paperclip, Pencil, RotateCw, Trash2 } from "lucide-react";

import {
  Button,
  EmptyState,
  Icon,
  IconButton,
  Inspector,
  InspectorSection,
  PropertyList,
  StatusBadge,
  Tabs,
  TextArea,
  tabId,
  tabPanelId,
  useToast,
} from "../../components";
import {
  api,
  evidenceUrl,
  type Annotation,
  type ApiError,
  type Attachment,
  type EventReviewStatus,
  type ReviewDecision,
  type SessionDetail,
  type SessionEvent,
} from "../../lib/api";
import { cx } from "../../lib/cx";
import { formatBytes, formatDateTime, formatTime, pluralize } from "../../lib/format";
import { useAutosave } from "../../lib/hooks";
import { eventReviewStatus, reviewState, sessionStatus } from "../../lib/status";
import { SESSION_NOTES_RULE } from "../../lib/validation";
import { attachmentSources, captureDetails, eventSources, eventTypes, imageFacts, MAX_ANNOTATIONS, newAnnotationId, terminalDetails } from "./eventTypes";
import { SessionIntegrations } from "./SessionIntegrations";
import integrationStyles from "./SessionIntegrations.module.css";
import type { ReviewCounts } from "./review";
import { SessionReview, StepReview } from "./ReviewPanel";
import styles from "./SessionPage.module.css";

export type InspectorTab = "step" | "session";

const TABS_ID = "session-inspector";

interface SessionInspectorProps {
  session: SessionDetail;
  event: SessionEvent | null;
  /** 1-based position of the event in the timeline. */
  eventIndex: number;
  eventTotal: number;
  /** Attachment currently shown in the viewer. */
  attachmentId: string | null;
  tab: InspectorTab;
  onTabChange: (tab: InspectorTab) => void;
  editable: boolean;
  readOnlyReason: string;
  onEditEvent: (event: SessionEvent) => void;
  onDeleteEvent: (event: SessionEvent) => void;
  onAttach: (event: SessionEvent) => void;
  onSelectAttachment: (event: SessionEvent, attachment: Attachment) => void;
  onRemoveAttachment: (event: SessionEvent, attachment: Attachment) => void;
  onAnnotationsChange: (attachment: Attachment, annotations: Annotation[]) => void;
  onEditDetails: () => void;
  /** Review (Milestone 4). */
  decisions: ReviewDecision[];
  reviewCounts: ReviewCounts;
  reviewBusy: boolean;
  onReview: (event: SessionEvent, status: EventReviewStatus, comment: string) => Promise<boolean>;
  onMove: (event: SessionEvent, delta: -1 | 1) => void;
  onMarkReviewed: () => void;
  onReopenReview: () => void;
}

/**
 * Right-hand inspector. Both tab panels stay mounted so unsaved session notes are never lost
 * when switching tabs.
 */
export function SessionInspector(props: SessionInspectorProps) {
  const { session, event, tab, onTabChange } = props;
  return (
    <Inspector
      label="Session inspector"
      className={styles.inspector}
      header={
        <div className={styles.inspectorTabs}>
          <Tabs<InspectorTab>
            label="Inspector"
            idPrefix={TABS_ID}
            value={tab}
            onChange={onTabChange}
            options={[
              { value: "step", label: event ? eventTypes[event.eventType].label : "Step" },
              { value: "session", label: "Session" },
            ]}
          />
        </div>
      }
    >
      <div role="tabpanel" id={tabPanelId(TABS_ID, "step")} aria-labelledby={tabId(TABS_ID, "step")} hidden={tab !== "step"}>
        <StepPanel {...props} />
      </div>
      <div role="tabpanel" id={tabPanelId(TABS_ID, "session")} aria-labelledby={tabId(TABS_ID, "session")} hidden={tab !== "session"}>
        <SessionNotes key={session.id} session={session} />
        <SessionReview
          session={session}
          counts={props.reviewCounts}
          decisions={props.decisions}
          busy={props.reviewBusy}
          onMarkReviewed={props.onMarkReviewed}
          onReopen={props.onReopenReview}
        />
        <SessionIntegrations session={session} lockedReason={props.editable ? undefined : props.readOnlyReason} />
        <SessionDetails session={session} onEditDetails={props.onEditDetails} />
      </div>
    </Inspector>
  );
}

function StepPanel({
  event,
  eventIndex,
  eventTotal,
  attachmentId,
  editable,
  readOnlyReason,
  onEditEvent,
  onDeleteEvent,
  onAttach,
  onSelectAttachment,
  onRemoveAttachment,
  onAnnotationsChange,
  decisions,
  onReview,
  onMove,
}: SessionInspectorProps) {
  if (!event) {
    return (
      <InspectorSection>
        <EmptyState
          compact
          headingLevel={3}
          icon={MousePointerClick}
          title="No step selected"
          description="Add a step, note, command or screenshot, then select it to see its details here."
        />
      </InspectorSection>
    );
  }

  const info = eventTypes[event.eventType];
  const source = eventSources[event.source];
  const lockedReason = editable ? undefined : readOnlyReason;
  const current = event.attachments.find((attachment) => attachment.id === attachmentId) ?? event.attachments[0] ?? null;
  const captured = captureDetails(event);
  const terminal = terminalDetails(event);

  return (
    <>
      <InspectorSection>
        <div className={styles.inspectorTitle}>
          <span className={styles.inspectorEyebrow}>
            <Icon icon={info.icon} size={13} />
            {info.label} {eventIndex} of {eventTotal}
          </span>
          <h3 className={styles.inspectorHeading}>{event.title}</h3>
        </div>
        <div className={styles.inspectorActions}>
          <Button size="sm" icon={Pencil} onClick={() => onEditEvent(event)} disabledReason={lockedReason}>
            Edit…
          </Button>
          <Button size="sm" icon={Paperclip} onClick={() => onAttach(event)} disabledReason={lockedReason}>
            Attach screenshot…
          </Button>
          <IconButton
            size="sm"
            icon={Trash2}
            label={`Delete ${info.label.toLowerCase()}`}
            onClick={() => onDeleteEvent(event)}
            disabledReason={lockedReason}
          />
        </div>
      </InspectorSection>

      {event.attachments.length > 0 && (event.description || event.notes) && (
        <InspectorSection title="Content">
          {event.description && <p className={styles.inspectorText}>{event.description}</p>}
          {event.notes && (
            <p className={styles.inspectorText}>
              <span className={styles.metaLabel}>Notes: </span>
              {event.notes}
            </p>
          )}
        </InspectorSection>
      )}

      <InspectorSection title="Details">
        <PropertyList
          items={[
            { label: "Type", value: info.label },
            { label: "Source", value: <span title={source.description}>{source.label}</span> },
            { label: "Added", value: formatDateTime(event.occurredAt) },
            { label: "Edited", value: event.updatedAt !== event.createdAt ? formatDateTime(event.updatedAt) : null },
            { label: "Review", value: <StatusBadge status={eventReviewStatus[event.reviewStatus]} plain /> },
          ]}
        />
      </InspectorSection>

      <StepReview
        key={event.id}
        event={event}
        decisions={decisions}
        onReview={(status, comment) => onReview(event, status, comment)}
        canMoveUp={eventIndex > 1}
        canMoveDown={eventIndex < eventTotal}
        moveLockedReason={lockedReason}
        onMove={(delta) => onMove(event, delta)}
      />

      {captured && (
        <InspectorSection title="Capture">
          <PropertyList
            items={[
              { label: "Taken with", value: captured.trigger },
              { label: "Target", value: captured.target },
              { label: "Target size", value: captured.size },
            ]}
          />
        </InspectorSection>
      )}

      {terminal && (
        <InspectorSection title="Terminal log">
          <PropertyList
            items={[
              { label: "Format", value: terminal.format },
              { label: "Masking", value: terminal.masked ? "Values that looked like secrets were masked" : "Nothing was masked" },
            ]}
          />
          {terminal.output && (
            <>
              <span className={styles.metaLabel}>Recorded output</span>
              {/* Focusable so long output can be scrolled with the keyboard. */}
              <pre className={integrationStyles.output} role="group" aria-label="Recorded output" tabIndex={0}>
                {terminal.output}
              </pre>
            </>
          )}
        </InspectorSection>
      )}

      {event.metadata.fileWatch?.path && (
        <InspectorSection title="Watched file">
          <PropertyList
            items={[
              { label: "File", value: event.metadata.fileWatch.path, mono: true },
              { label: "Lines added", value: event.metadata.fileWatch.linesAdded ?? null },
              { label: "Lines removed", value: event.metadata.fileWatch.linesRemoved ?? null },
            ]}
          />
          <p className={styles.inspectorText}>The full values before and after are in Change History as an observed change.</p>
        </InspectorSection>
      )}

      <InspectorSection title={`Screenshots (${event.attachments.length})`}>
        {event.attachments.length === 0 ? (
          <p className={styles.inspectorHint}>
            {event.eventType === "screenshot"
              ? "This step's image was removed. Attach another screenshot or delete the step."
              : `No screenshot is attached to this ${info.label.toLowerCase()}.`}
          </p>
        ) : (
          <ul className={styles.attachmentList} aria-label="Attached screenshots">
            {event.attachments.map((attachment, index) => (
              <li
                key={attachment.id}
                className={cx(styles.attachmentRow, current?.id === attachment.id && styles.attachmentRowSelected)}
              >
                <button
                  type="button"
                  className={styles.attachmentSelect}
                  aria-current={current?.id === attachment.id ? "true" : undefined}
                  onClick={() => onSelectAttachment(event, attachment)}
                >
                  <img className={styles.thumb} src={evidenceUrl(attachment.id, attachment.sha256)} alt="" loading="lazy" draggable={false} />
                  <span className={styles.attachmentText}>
                    <span className={styles.attachmentName}>
                      {attachment.originalName || `${attachmentSources[attachment.source].label} ${index + 1}`}
                    </span>
                    <span className={styles.attachmentMeta}>{imageFacts(attachment)}</span>
                  </span>
                </button>
                <IconButton
                  icon={Trash2}
                  label="Remove screenshot"
                  size="sm"
                  onClick={() => onRemoveAttachment(event, attachment)}
                  disabledReason={lockedReason}
                />
              </li>
            ))}
          </ul>
        )}
        {current && (
          <PropertyList
            items={[
              { label: "Source", value: attachmentSources[current.source].label },
              { label: "Added", value: formatDateTime(current.createdAt) },
              { label: "Redacted", value: current.redactedAt ? formatDateTime(current.redactedAt) : null },
              { label: "SHA-256", value: <span className={styles.digest}>{current.sha256}</span> },
            ]}
          />
        )}
      </InspectorSection>

      {current && (
        <AnnotationList
          key={current.id}
          attachment={current}
          lockedReason={lockedReason}
          onChange={(annotations) => onAnnotationsChange(current, annotations)}
        />
      )}
    </>
  );
}

interface AnnotationListProps {
  attachment: Attachment;
  lockedReason: string | undefined;
  onChange: (annotations: Annotation[]) => void;
}

/** Highlight boxes of the current screenshot. Labels save when the field loses focus. */
function AnnotationList({ attachment, lockedReason, onChange }: AnnotationListProps) {
  const annotations = attachment.annotations;
  const width = attachment.width ?? 0;
  const height = attachment.height ?? 0;

  const addCentered = () => {
    const boxWidth = Math.max(8, Math.round(width / 4));
    const boxHeight = Math.max(8, Math.round(height / 4));
    onChange([
      ...annotations,
      {
        id: newAnnotationId(),
        x: Math.round((width - boxWidth) / 2),
        y: Math.round((height - boxHeight) / 2),
        width: boxWidth,
        height: boxHeight,
        label: "",
      },
    ]);
  };

  return (
    <InspectorSection title={`Annotations (${annotations.length})`}>
      {annotations.length === 0 ? (
        <p className={styles.inspectorHint}>
          No highlight boxes. Use Annotate in the viewer and drag on the image, or add a box here.
        </p>
      ) : (
        <ol className={styles.annotationList} aria-label="Annotations">
          {annotations.map((annotation, index) => (
            <li key={annotation.id} className={styles.annotationRow}>
              <span className={styles.annotationNumber} aria-hidden="true">
                {index + 1}
              </span>
              <input
                className={styles.annotationInput}
                aria-label={`Label for annotation ${index + 1}`}
                placeholder="Label (optional)"
                defaultValue={annotation.label}
                maxLength={120}
                disabled={Boolean(lockedReason)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
                onBlur={(event) => {
                  const label = event.currentTarget.value.trim();
                  if (label === annotation.label) return;
                  onChange(annotations.map((item) => (item.id === annotation.id ? { ...item, label } : item)));
                }}
              />
              <IconButton
                icon={Trash2}
                size="sm"
                label={`Remove annotation ${index + 1}`}
                disabledReason={lockedReason}
                onClick={() => onChange(annotations.filter((item) => item.id !== annotation.id))}
              />
            </li>
          ))}
        </ol>
      )}
      <div className={styles.inspectorActions}>
        <Button
          size="sm"
          icon={Highlighter}
          onClick={addCentered}
          disabledReason={
            lockedReason ??
            (annotations.length >= MAX_ANNOTATIONS
              ? `A screenshot can have at most ${MAX_ANNOTATIONS} annotations.`
              : width && height
                ? undefined
                : "The image size is unknown.")
          }
        >
          Add box
        </Button>
      </div>
    </InspectorSection>
  );
}

function SessionNotes({ session }: { session: SessionDetail }) {
  const toast = useToast();
  const [notes, setNotes] = useState(session.notes);
  const save = useCallback((value: string) => api.sessions.updateNotes(session.id, value).then((result) => result.updatedAt), [session.id]);
  const onBackgroundError = useCallback(
    (error: ApiError) => toast.error("Session notes were not saved", error.message),
    [toast],
  );
  const autosave = useAutosave(notes, session.notes, save, { onBackgroundError });

  const hint =
    autosave.state === "saving"
      ? "Saving\u2026"
      : autosave.state === "saved" && autosave.savedAt
        ? `Saved at ${formatTime(autosave.savedAt)}`
        : "Notes are saved automatically.";

  return (
    <InspectorSection>
      <TextArea
        label="Session notes"
        rows={8}
        className={styles.notes}
        placeholder="Goal, context, decisions, follow-ups"
        value={notes}
        maxLength={SESSION_NOTES_RULE.maxChars}
        hint={hint}
        error={autosave.state === "error" ? `Not saved: ${autosave.error?.message ?? "unknown error"}` : undefined}
        onChange={(event) => setNotes(event.target.value)}
        onBlur={autosave.flush}
      />
      {autosave.state === "error" && (
        <div>
          <Button size="sm" icon={RotateCw} onClick={autosave.flush}>
            Retry saving
          </Button>
        </div>
      )}
    </InspectorSection>
  );
}

function SessionDetails({ session, onEditDetails }: { session: SessionDetail; onEditDetails: () => void }) {
  return (
    <InspectorSection title="Details">
      <PropertyList
        items={[
          { label: "Status", value: <StatusBadge status={sessionStatus[session.status]} plain /> },
          { label: "Review", value: <StatusBadge status={reviewState[session.reviewState]} plain /> },
          {
            label: "Project",
            value: session.projectId ? <Link to={`/projects/${session.projectId}`}>{session.projectName}</Link> : "Unassigned",
          },
          { label: "Application", value: session.application },
          { label: "Environment", value: session.environment },
          { label: "Steps", value: session.eventCount },
          {
            label: "Screenshots",
            value: `${session.attachmentCount}${session.attachmentCount > 0 ? ` \u00b7 ${formatBytes(session.attachmentBytes)}` : ""}`,
          },
          { label: "Playbooks", value: session.playbookCount > 0 ? pluralize(session.playbookCount, "linked playbook") : "None linked" },
          { label: "Created", value: formatDateTime(session.createdAt) },
          { label: "Updated", value: formatDateTime(session.updatedAt) },
          { label: "Completed", value: session.endedAt ? formatDateTime(session.endedAt) : null },
          { label: "Identifier", value: session.id, mono: true },
        ]}
      />
      <div className={styles.inspectorActions}>
        <Button size="sm" icon={Pencil} onClick={onEditDetails}>
          Edit details…
        </Button>
      </div>
    </InspectorSection>
  );
}
