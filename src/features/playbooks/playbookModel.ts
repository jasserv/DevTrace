import type { EventSource, LinkedSession, ListItem, Origin, PlaybookContent, PlaybookDetail, PlaybookInput, PlaybookStep } from "../../lib/api";
import { formatDateTime } from "../../lib/format";

/** The editable part of a playbook: metadata plus document. */
export interface PlaybookDraft {
  input: PlaybookInput;
  content: PlaybookContent;
}

export type ListSectionKey = "prerequisites" | "permissions" | "verification" | "warnings" | "troubleshooting" | "rollback";

export function draftOf(detail: PlaybookDetail): PlaybookDraft {
  return {
    input: {
      title: detail.title,
      summary: detail.summary,
      projectId: detail.projectId,
      platform: detail.platform,
      product: detail.product,
      productVersion: detail.productVersion,
      environment: detail.environment,
      taskType: detail.taskType,
      author: detail.author,
    },
    content: detail.content,
  };
}

export function newId(): string {
  return crypto.randomUUID();
}

export function newItem(): ListItem {
  return { id: newId(), text: "", origin: "authored" };
}

export function newStep(): PlaybookStep {
  return {
    id: newId(),
    title: "",
    instruction: "",
    command: "",
    expectedResult: "",
    note: "",
    assetIds: [],
    origin: "authored",
    sourceSessionId: null,
    sourceEventId: null,
    sourceKind: null,
  };
}

/** Content copied from a session becomes "edited" as soon as someone changes it. */
export function touched(origin: Origin): Origin {
  return origin === "session" ? "edited" : origin;
}

export function editStep(step: PlaybookStep, patch: Partial<PlaybookStep>): PlaybookStep {
  return { ...step, ...patch, origin: touched(step.origin) };
}

export function editItem(item: ListItem, text: string): ListItem {
  return { ...item, text, origin: touched(item.origin) };
}

export function moveBy<T>(items: T[], index: number, delta: number): T[] {
  const target = index + delta;
  if (target < 0 || target >= items.length) return items;
  const next = [...items];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved!);
  return next;
}

export const ORIGIN_LABELS: Record<Origin, string> = {
  session: "From session",
  edited: "Edited after generation",
  authored: "Written in playbook",
};

const SOURCE_KIND_LABELS: Record<EventSource, string> = {
  capture: "captured screenshot",
  file: "imported image",
  clipboard: "pasted screenshot",
  manual: "written step",
  terminal: "terminal log",
  file_watch: "watched file",
};

/** "From session “Rotate keys” · captured screenshot" */
export function sourceText(step: PlaybookStep, sessions: LinkedSession[]): string | null {
  if (step.origin === "authored" || !step.sourceEventId) return null;
  const session = sessions.find((item) => item.id === step.sourceSessionId);
  const where = session ? `session \u201c${session.title}\u201d` : "a deleted session";
  const kind = step.sourceKind ? ` \u00b7 ${SOURCE_KIND_LABELS[step.sourceKind]}` : "";
  return `${step.origin === "edited" ? "Edited from" : "From"} ${where}${kind}`;
}

/** Why a playbook cannot be submitted or published yet. */
export function publishBlocker(content: PlaybookContent): string | undefined {
  if (content.steps.length === 0) return "Add at least one step first.";
  const untitled = content.steps.findIndex((step) => !step.title.trim());
  if (untitled >= 0) return `Step ${untitled + 1} needs a title.`;
  return undefined;
}

export const LIST_SECTIONS: Array<{ key: ListSectionKey; title: string; hint: string; empty: string }> = [
  {
    key: "prerequisites",
    title: "Prerequisites",
    hint: "What must be true or available before starting.",
    empty: "No prerequisites listed.",
  },
  {
    key: "permissions",
    title: "Required permissions",
    hint: "Roles, accounts or access the operator needs.",
    empty: "No permissions listed.",
  },
  {
    key: "warnings",
    title: "Warnings",
    hint: "Risks, impact and things to avoid. Shown before the steps so they are read first.",
    empty: "No warnings listed.",
  },
];

export const CLOSING_SECTIONS: Array<{ key: ListSectionKey; title: string; hint: string; empty: string }> = [
  {
    key: "verification",
    title: "Verification",
    hint: "How to confirm the procedure worked. DevTrace never fills this in: describe checks someone actually performs.",
    empty: "No verification steps yet. Nothing here was recorded automatically.",
  },
  {
    key: "troubleshooting",
    title: "Troubleshooting",
    hint: "Known problems and what to do about them.",
    empty: "No troubleshooting notes.",
  },
  {
    key: "rollback",
    title: "Rollback and recovery",
    hint: "How to undo the change or recover if something goes wrong.",
    empty: "No rollback steps listed.",
  },
];

/** Export version value for the saved working copy of an unpublished playbook. */
export const CURRENT_VERSION = "current";

/** The versions that can be exported: the unpublished working copy, then every published revision. */
export function exportVersionOptions(detail: PlaybookDetail): Array<{ value: string; label: string }> {
  const options: Array<{ value: string; label: string }> = [];
  const latest = detail.revisions[0];
  if (detail.status === "draft") {
    options.push({
      value: CURRENT_VERSION,
      label: latest ? `Current draft (changes after revision ${latest.revisionNumber})` : "Current draft (not published)",
    });
  } else if (detail.status === "in_review") {
    options.push({ value: CURRENT_VERSION, label: "Version in review (not published)" });
  }
  detail.revisions.forEach((revision, index) => {
    const current = index === 0 && detail.status === "published" ? " (current)" : "";
    options.push({
      value: revision.id,
      label: `Revision ${revision.revisionNumber} \u2014 published ${formatDateTime(revision.createdAt)}${current}`,
    });
  });
  return options;
}
