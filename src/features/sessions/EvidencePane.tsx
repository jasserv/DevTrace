import { useMemo, useState } from "react";
import { Copy, EyeOff, Highlighter, ImagePlus, Paperclip } from "lucide-react";

import { Button, ConfirmDialog, EmptyState, Icon, ScreenshotViewer, useToast, type Highlight, type Screenshot } from "../../components";
import { evidenceUrl, type Annotation, type Attachment, type Region, type SessionEvent } from "../../lib/api";
import { cx } from "../../lib/cx";
import { formatDateTime, pluralize } from "../../lib/format";
import { formatShortcut } from "../../lib/platform";
import { annotationHighlights, eventTypes, imageFacts, newAnnotationId } from "./eventTypes";
import styles from "./SessionPage.module.css";

/** Mirrors `MAX_REDACTION_REGIONS` in `src-tauri/src/features/review.rs`. */
const MAX_REDACTION_REGIONS = 50;

interface EvidencePaneProps {
  event: SessionEvent | null;
  attachment: Attachment | null;
  /** Position of the attachment among all screenshots of the session. */
  position: { index: number; total: number };
  onPrevious: () => void;
  onNext: () => void;
  editable: boolean;
  readOnlyReason: string;
  onChooseFiles: (eventId?: string) => void;
  onAnnotationsChange: (attachment: Attachment, annotations: Annotation[]) => void;
  /** Applies a redaction; rejects with the reason when it failed. */
  onRedact: (attachment: Attachment, regions: Region[]) => Promise<void>;
}

/** Center pane: the selected screenshot, or the content of a text step. */
export function EvidencePane({
  event,
  attachment,
  position,
  onPrevious,
  onNext,
  editable,
  readOnlyReason,
  onChooseFiles,
  onAnnotationsChange,
  onRedact,
}: EvidencePaneProps) {
  if (event && attachment) {
    return (
      <AttachmentViewer
        key={attachment.id}
        event={event}
        attachment={attachment}
        position={position}
        onPrevious={onPrevious}
        onNext={onNext}
        editable={editable}
        readOnlyReason={readOnlyReason}
        onAnnotationsChange={onAnnotationsChange}
        onRedact={onRedact}
      />
    );
  }
  if (event) {
    return <EventDocument event={event} editable={editable} readOnlyReason={readOnlyReason} onChooseFiles={onChooseFiles} />;
  }
  return (
    <ScreenshotViewer
      label="Evidence viewer"
      image={null}
      position={position}
      unavailableReason="This session has no screenshots yet."
      empty={
        <EmptyState
          icon={ImagePlus}
          title="No evidence yet"
          description={
            editable
              ? `Paste a screenshot with ${formatShortcut("V")}, drop image files here or choose files. Images are stored in this workspace only.`
              : "This session has no screenshots."
          }
          actions={
            editable ? (
              <Button icon={ImagePlus} onClick={() => onChooseFiles()}>
                Choose images…
              </Button>
            ) : undefined
          }
        />
      }
    />
  );
}

interface AttachmentViewerProps {
  event: SessionEvent;
  attachment: Attachment;
  position: { index: number; total: number };
  onPrevious: () => void;
  onNext: () => void;
  editable: boolean;
  readOnlyReason: string;
  onAnnotationsChange: (attachment: Attachment, annotations: Annotation[]) => void;
  onRedact: (attachment: Attachment, regions: Region[]) => Promise<void>;
}

function AttachmentViewer({ event, attachment, position, onPrevious, onNext, editable, readOnlyReason, onAnnotationsChange, onRedact }: AttachmentViewerProps) {
  const [mode, setMode] = useState<"view" | "annotate" | "redact">("view");
  const [regions, setRegions] = useState<Region[]>([]);
  const [confirming, setConfirming] = useState(false);
  const image: Screenshot = useMemo(
    () => ({
      src: evidenceUrl(attachment.id, attachment.sha256),
      alt: `Screenshot for \u201c${event.title}\u201d`,
      width: attachment.width ?? 1280,
      height: attachment.height ?? 800,
    }),
    [attachment.id, attachment.sha256, attachment.width, attachment.height, event.title],
  );
  const highlights = useMemo<Highlight[]>(
    () => [
      ...annotationHighlights(attachment.annotations),
      ...regions.map((region, index) => ({ id: `redact-${index}`, ...region, label: "Redact", tone: "redact" as const })),
    ],
    [attachment.annotations, regions],
  );
  const toggle = (next: "annotate" | "redact") => {
    setMode((current) => (current === next ? "view" : next));
    setRegions([]);
  };
  const canDraw = editable && (mode === "annotate" || (mode === "redact" && regions.length < MAX_REDACTION_REGIONS));

  return (
    <>
      <ScreenshotViewer
        label="Evidence viewer"
        image={image}
        highlights={highlights}
        position={position}
        onPrevious={onPrevious}
        onNext={onNext}
        drawing={canDraw}
        onDraw={(rect) => {
          if (mode === "redact") setRegions((current) => [...current, rect]);
          else onAnnotationsChange(attachment, [...attachment.annotations, { id: newAnnotationId(), ...rect, label: "" }]);
        }}
        toolbarEnd={
          <>
            {mode === "redact" ? (
              <span className={styles.redactStatus} role="status">
                {regions.length === 0 ? "Drag over sensitive areas" : pluralize(regions.length, "area")}
              </span>
            ) : (
              <span className={styles.imageFacts}>{imageFacts(attachment)}</span>
            )}
            {mode === "redact" && regions.length > 0 && (
              <>
                <Button size="sm" variant="ghost" onClick={() => setRegions([])}>
                  Clear
                </Button>
                <Button size="sm" variant="danger" onClick={() => setConfirming(true)}>
                  Apply redaction…
                </Button>
              </>
            )}
            <Button
              size="sm"
              variant={mode === "annotate" ? "primary" : "ghost"}
              icon={Highlighter}
              aria-pressed={mode === "annotate"}
              disabledReason={editable ? undefined : readOnlyReason}
              tooltip={mode === "annotate" ? "Drag on the image to draw a highlight box. Click again to finish." : "Draw highlight boxes on this screenshot"}
              onClick={() => toggle("annotate")}
            >
              Annotate
            </Button>
            <Button
              size="sm"
              variant={mode === "redact" ? "primary" : "ghost"}
              icon={EyeOff}
              aria-pressed={mode === "redact"}
              disabledReason={editable ? undefined : readOnlyReason}
              tooltip={
                mode === "redact"
                  ? "Drag over each sensitive area, then apply. Click again to cancel."
                  : "Permanently black out passwords, tokens or personal data in this screenshot"
              }
              onClick={() => toggle("redact")}
            >
              Redact
            </Button>
          </>
        }
      />
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Permanently redact this screenshot?"
        confirmLabel={`Black out ${pluralize(regions.length, "area")}`}
        tone="danger"
        onConfirm={async () => {
          await onRedact(attachment, regions);
          setRegions([]);
          setMode("view");
        }}
      >
        <p>
          {pluralize(regions.length, "marked area")} will be filled with black in the image file itself. The original image is deleted,
          so the hidden content cannot be recovered from DevTrace.
        </p>
        <p>Annotations are kept. The redaction is recorded in the review history.</p>
      </ConfirmDialog>
    </>
  );
}

interface EventDocumentProps {
  event: SessionEvent;
  editable: boolean;
  readOnlyReason: string;
  onChooseFiles: (eventId?: string) => void;
}

function EventDocument({ event, editable, readOnlyReason, onChooseFiles }: EventDocumentProps) {
  const info = eventTypes[event.eventType];
  const code = CODE_BLOCKS[event.eventType];
  const showCode = code !== undefined && (event.eventType === "command" || event.code.trim() !== "");
  // Commands recorded from a terminal log keep the output that followed them.
  const output = event.eventType === "command" ? (event.metadata.terminal?.output ?? "") : "";
  const empty = !event.description && !event.notes && !showCode;
  return (
    <section className={styles.document} aria-label="Step content">
      <div className={styles.documentToolbar}>
        <span className={styles.documentToolbarText}>No screenshot attached</span>
        <Button
          size="sm"
          variant="ghost"
          icon={Paperclip}
          onClick={() => onChooseFiles(event.id)}
          disabledReason={editable ? undefined : readOnlyReason}
        >
          Attach screenshot…
        </Button>
      </div>
      <div className={styles.documentScroll}>
        <article className={styles.documentBody}>
          <span className={styles.docEyebrow}>
            <Icon icon={info.icon} size={14} />
            {info.label} · {formatDateTime(event.occurredAt)}
          </span>
          <h2 className={styles.docTitle}>{event.title}</h2>
          {showCode && (
            <div className={styles.docSection}>
              <CodeBlock code={event.code} label={code.label} copied={code.copied} />
            </div>
          )}
          {output.trim() !== "" && (
            <div className={styles.docSection}>
              <CodeBlock code={output} label="Output · as recorded from the log" copied="Output copied" />
            </div>
          )}
          {event.description && (
            <section className={styles.docSection}>
              <h3 className={styles.docSectionTitle}>Description</h3>
              <p className={styles.prose}>{event.description}</p>
            </section>
          )}
          {event.notes && (
            <section className={styles.docSection}>
              <h3 className={styles.docSectionTitle}>Notes</h3>
              <p className={styles.prose}>{event.notes}</p>
            </section>
          )}
          {empty && <p className={cx(styles.docSection, styles.muted)}>No description yet.</p>}
        </article>
      </div>
    </section>
  );
}

/** How the monospaced text of each step type is introduced, and what Copy reports. */
const CODE_BLOCKS: Partial<Record<SessionEvent["eventType"], { label: string; copied: string }>> = {
  command: { label: "Command · stored as text, never run by DevTrace", copied: "Command copied" },
  log: { label: "Terminal output · as recorded from the log", copied: "Output copied" },
  change: { label: "Changed lines · − removed, + added", copied: "Changed lines copied" },
};

/** Monospaced step text (a command, terminal output or changed lines) with a copy action. DevTrace never runs it. */
function CodeBlock({ code, label, copied }: { code: string; label: string; copied: string }) {
  const toast = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      toast.success(copied);
    } catch {
      toast.error("The text could not be copied", "Select the text and copy it manually.");
    }
  };
  return (
    <div className={styles.codeBlock}>
      <div className={styles.codeHeader}>
        <span>{label}</span>
        <Button size="sm" variant="ghost" icon={Copy} onClick={() => void copy()}>
          Copy
        </Button>
      </div>
      {/* Long lines scroll sideways; focusable so that works with the keyboard too. */}
      <pre className={styles.code} role="group" aria-label={label} tabIndex={0}>
        <code>{code}</code>
      </pre>
    </div>
  );
}
