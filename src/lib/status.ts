import {
  BadgeCheck,
  Ban,
  CalendarX2,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CirclePause,
  CircleX,
  Clock,
  Eye,
  FilePenLine,
  MessageSquareText,
  ScanEye,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";

import type { ApprovalState, ChangeAssertion, EventReviewStatus, PlaybookStatus, ReviewState, SessionStatus } from "./api";

export type Tone = "neutral" | "info" | "success" | "warning" | "danger";

/** Every status is rendered with an icon and a text label, never color alone. */
export interface StatusDescriptor {
  label: string;
  tone: Tone;
  icon: LucideIcon;
  description: string;
}

export const sessionStatus: Record<SessionStatus, StatusDescriptor> = {
  draft: { label: "Draft", tone: "neutral", icon: CircleDashed, description: "Being documented; steps and evidence can be changed." },
  recording: { label: "Recording", tone: "danger", icon: CircleDot, description: "Capture is in progress." },
  paused: { label: "Paused", tone: "warning", icon: CirclePause, description: "Capture is paused; nothing is recorded." },
  completed: {
    label: "Completed",
    tone: "success",
    icon: CircleCheck,
    description: "Documentation is finished; steps and evidence are read-only until the session is reopened.",
  },
};

export const reviewState: Record<ReviewState, StatusDescriptor> = {
  unreviewed: { label: "Not reviewed", tone: "warning", icon: Clock, description: "Captured evidence has not been reviewed." },
  in_review: { label: "In review", tone: "info", icon: Eye, description: "Review is in progress." },
  reviewed: { label: "Reviewed", tone: "success", icon: CircleCheck, description: "All evidence has been reviewed." },
};

export const eventReviewStatus: Record<EventReviewStatus, StatusDescriptor> = {
  pending: {
    label: "Pending review",
    tone: "neutral",
    icon: Clock,
    description: "Not reviewed yet.",
  },
  approved: {
    label: "Approved",
    tone: "success",
    icon: CircleCheck,
    description: "Approved as evidence for documentation.",
  },
  rejected: {
    label: "Rejected",
    tone: "danger",
    icon: CircleX,
    description: "Rejected by a reviewer; never used in playbooks.",
  },
  excluded: {
    label: "Excluded",
    tone: "neutral",
    icon: Ban,
    description: "Excluded as irrelevant; never used in playbooks.",
  },
};

export const playbookStatus: Record<PlaybookStatus, StatusDescriptor> = {
  draft: { label: "Draft", tone: "neutral", icon: FilePenLine, description: "Being written; not for general use." },
  in_review: { label: "In review", tone: "info", icon: Eye, description: "Awaiting review before publication." },
  published: { label: "Published", tone: "success", icon: BadgeCheck, description: "Approved for reuse." },
};

/** Shown next to the status of a published procedure that was marked out of date. */
export const outdatedStatus: StatusDescriptor = {
  label: "Out of date",
  tone: "warning",
  icon: CalendarX2,
  description: "The published procedure may no longer match the systems it describes.",
};

export const changeAssertion: Record<ChangeAssertion, StatusDescriptor> = {
  observed: {
    label: "Observed",
    tone: "neutral",
    icon: ScanEye,
    description: "Recorded by DevTrace, for example from a watched file; not confirmed by a person.",
  },
  declared: {
    label: "Declared",
    tone: "info",
    icon: MessageSquareText,
    description: "Stated by a user; the outcome has not been verified.",
  },
  verified: {
    label: "Verified",
    tone: "success",
    icon: ShieldCheck,
    description: "The outcome was explicitly verified and recorded.",
  },
};

export const approvalState: Record<ApprovalState, StatusDescriptor> = {
  pending: { label: "Pending", tone: "warning", icon: Clock, description: "Awaiting approval." },
  approved: { label: "Approved", tone: "success", icon: CircleCheck, description: "Approved by a reviewer." },
  rejected: { label: "Rejected", tone: "danger", icon: CircleX, description: "Rejected by a reviewer." },
};
