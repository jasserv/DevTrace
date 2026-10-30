import { useState } from "react";
import { ArrowDown, ArrowUp, BadgeCheck, Ban, CircleCheck, CircleX, RotateCcw, Undo2 } from "lucide-react";

import { Button, IconButton, InspectorSection, PropertyList, StatusBadge, TextArea, type LucideIcon } from "../../components";
import type { EventReviewStatus, ReviewDecision, SessionDetail, SessionEvent } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { reviewState } from "../../lib/status";
import { decisionSummary, markReviewedBlocker, type ReviewCounts } from "./review";
import styles from "./SessionPage.module.css";

const DECISIONS: Array<{ status: EventReviewStatus; label: string; icon: LucideIcon; hint: string }> = [
  { status: "approved", label: "Approve", icon: CircleCheck, hint: "Correct and relevant: may become playbook content (A)" },
  { status: "rejected", label: "Reject", icon: CircleX, hint: "Wrong or misleading: never used in playbooks (R)" },
  { status: "excluded", label: "Exclude", icon: Ban, hint: "Irrelevant to the task: never used in playbooks (X)" },
  { status: "pending", label: "Pending", icon: Undo2, hint: "Set back to pending (P)" },
];

function History({ decisions, label }: { decisions: ReviewDecision[]; label: string }) {
  if (decisions.length === 0) return <p className={styles.inspectorHint}>No review decisions yet.</p>;
  return (
    // The list scrolls when it is long; focusable so it can be scrolled with the keyboard.
    <ol className={styles.decisionList} aria-label={label} tabIndex={0}>
      {decisions.map((decision) => (
        <li key={decision.id} className={styles.decisionItem}>
          <span className={styles.decisionText}>{decisionSummary(decision)}</span>
          <span className={styles.decisionMeta}>
            {formatDateTime(decision.createdAt)}
            {decision.reviewer ? ` \u00b7 ${decision.reviewer}` : ""}
          </span>
          {decision.comment && <span className={styles.decisionComment}>{decision.comment}</span>}
        </li>
      ))}
    </ol>
  );
}

interface StepReviewProps {
  event: SessionEvent;
  decisions: ReviewDecision[];
  /** Resolves true when the decision was saved. */
  onReview: (status: EventReviewStatus, comment: string) => Promise<boolean>;
  canMoveUp: boolean;
  canMoveDown: boolean;
  /** Why the step order cannot change (completed session), if so. */
  moveLockedReason?: string;
  onMove: (delta: -1 | 1) => void;
}

/** Review decision, comment, order and history of the selected step. */
export function StepReview({ event, decisions, onReview, canMoveUp, canMoveDown, moveLockedReason, onMove }: StepReviewProps) {
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState<EventReviewStatus | null>(null);
  const history = decisions.filter((decision) => decision.eventId === event.id);

  const apply = async (status: EventReviewStatus) => {
    if (status === event.reviewStatus && !comment.trim()) return;
    setBusy(status);
    try {
      if (await onReview(status, comment)) setComment("");
    } finally {
      setBusy(null);
    }
  };

  return (
    <InspectorSection title="Review">
      <div className={styles.reviewButtons} role="group" aria-label="Review decision">
        {DECISIONS.map((option) => (
          <Button
            key={option.status}
            size="sm"
            variant={event.reviewStatus === option.status ? "primary" : "secondary"}
            icon={option.icon}
            aria-pressed={event.reviewStatus === option.status}
            loading={busy === option.status}
            tooltip={option.hint}
            onClick={() => void apply(option.status)}
          >
            {option.label}
          </Button>
        ))}
      </div>
      <TextArea
        label="Review comment"
        optional
        rows={2}
        value={comment}
        maxLength={2000}
        placeholder="Why this decision? Saved with the next decision."
        onChange={(change) => setComment(change.target.value)}
      />
      <div className={styles.inspectorActions}>
        <IconButton
          size="sm"
          icon={ArrowUp}
          label="Move step up"
          disabledReason={moveLockedReason ?? (canMoveUp ? undefined : "This is the first step.")}
          onClick={() => onMove(-1)}
        />
        <IconButton
          size="sm"
          icon={ArrowDown}
          label="Move step down"
          disabledReason={moveLockedReason ?? (canMoveDown ? undefined : "This is the last step.")}
          onClick={() => onMove(1)}
        />
        <span className={styles.reviewKeys}>In the step list: A approve · R reject · X exclude · P pending · Alt+↑/↓ move</span>
      </div>
      <History decisions={history} label="Review history of this step" />
    </InspectorSection>
  );
}

interface SessionReviewProps {
  session: SessionDetail;
  counts: ReviewCounts;
  decisions: ReviewDecision[];
  busy: boolean;
  onMarkReviewed: () => void;
  onReopen: () => void;
}

/** Review progress, completion and the full audit trail of the session. */
export function SessionReview({ session, counts, decisions, busy, onMarkReviewed, onReopen }: SessionReviewProps) {
  const blocker = markReviewedBlocker(counts);
  return (
    <InspectorSection title="Review">
      <PropertyList
        items={[
          { label: "State", value: <StatusBadge status={reviewState[session.reviewState]} plain /> },
          { label: "Decided", value: `${counts.decided} of ${counts.total}` },
          { label: "Approved", value: counts.approved },
          { label: "Rejected", value: counts.rejected },
          { label: "Excluded", value: counts.excluded },
        ]}
      />
      <div className={styles.inspectorActions}>
        {session.reviewState === "reviewed" ? (
          <Button size="sm" icon={RotateCcw} loading={busy} onClick={onReopen}>
            Reopen review
          </Button>
        ) : (
          <Button size="sm" icon={BadgeCheck} loading={busy} disabledReason={blocker} onClick={onMarkReviewed}>
            Mark reviewed
          </Button>
        )}
      </div>
      <History decisions={decisions.slice(0, 100)} label="Review history" />
    </InspectorSection>
  );
}
