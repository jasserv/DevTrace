import type { DecisionKind, EventReviewStatus, ReviewDecision, SessionEvent } from "../../lib/api";
import { pluralize } from "../../lib/format";

export interface ReviewCounts {
  total: number;
  pending: number;
  approved: number;
  rejected: number;
  excluded: number;
  decided: number;
}

export function reviewCounts(events: SessionEvent[]): ReviewCounts {
  const counts = { total: events.length, pending: 0, approved: 0, rejected: 0, excluded: 0, decided: 0 };
  for (const event of events) counts[event.reviewStatus] += 1;
  counts.decided = counts.total - counts.pending;
  return counts;
}

/** Why the review cannot be marked finished yet, or undefined when it can. */
export function markReviewedBlocker(counts: ReviewCounts): string | undefined {
  if (counts.total === 0) return "Add steps before reviewing this session.";
  if (counts.pending > 0) return `${pluralize(counts.pending, "step")} still ${counts.pending === 1 ? "needs" : "need"} a decision.`;
  return undefined;
}

/** The step order after moving `id` by `delta` places, or null when it cannot move. */
export function moveInOrder(ids: string[], id: string, delta: number): string[] | null {
  const from = ids.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= ids.length || delta === 0) return null;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

/** Single-letter review shortcuts used in the step list. */
export const REVIEW_KEYS: Record<string, EventReviewStatus> = {
  a: "approved",
  r: "rejected",
  x: "excluded",
  p: "pending",
};

export const DECISION_LABELS: Record<DecisionKind, string> = {
  approve: "Approved",
  reject: "Rejected",
  exclude: "Excluded",
  reset: "Set back to pending",
  reorder: "Reordered the steps",
  redact: "Redacted a screenshot",
  mark_reviewed: "Marked the session reviewed",
  reopen_review: "Reopened the review",
};

/** "Approved · Open console" style summary for the history list. */
export function decisionSummary(decision: ReviewDecision): string {
  const label = DECISION_LABELS[decision.decision];
  if (decision.eventId === null) return label;
  return `${label} \u00b7 ${decision.eventTitle ?? "deleted step"}`;
}
