import type { PlaybookAsset, PlaybookDetail, RestorePointSummary, VersionSnapshot } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { CLOSING_SECTIONS, LIST_SECTIONS } from "./playbookModel";

/** Version id of a playbook's working copy (draft, in review, or published). */
export const WORKING_COPY = "current";

export type VersionKind = "working" | "revision" | "restorePoint";

export interface VersionEntry {
  id: string;
  kind: VersionKind;
  /** "Current draft", "Revision 2", "Saved draft". */
  label: string;
  /** Date and author, or what replaced a saved draft. */
  detail: string;
  /** Revision note or the saved draft's title. */
  note: string;
  /** Revision number for revisions. */
  revisionNumber: number | null;
}

/** Label of the working copy, which depends on the publication state. */
export function workingCopyLabel(detail: PlaybookDetail): string {
  if (detail.status === "draft") return "Current draft";
  if (detail.status === "in_review") return "Current version (in review)";
  const latest = detail.revisions[0];
  return latest ? `Current version (revision ${latest.revisionNumber})` : "Current version";
}

/** "Replaced by revision 2" / "Replaced by an earlier saved draft". */
export function replacedByText(point: RestorePointSummary): string {
  const match = /^revision:(\d+)$/.exec(point.replacedBy);
  return match ? `Replaced by revision ${match[1]}` : "Replaced by an earlier saved draft";
}

/** Every version of a playbook: the working copy, published revisions, then saved drafts. */
export function versionEntries(detail: PlaybookDetail): VersionEntry[] {
  const entries: VersionEntry[] = [
    {
      id: WORKING_COPY,
      kind: "working",
      label: workingCopyLabel(detail),
      detail: `Updated ${formatDateTime(detail.updatedAt)}`,
      note: "",
      revisionNumber: null,
    },
  ];
  for (const revision of detail.revisions) {
    entries.push({
      id: revision.id,
      kind: "revision",
      label: `Revision ${revision.revisionNumber}`,
      detail: `Published ${formatDateTime(revision.createdAt)}${revision.author ? ` by ${revision.author}` : ""}`,
      note: revision.note,
      revisionNumber: revision.revisionNumber,
    });
  }
  for (const point of detail.restorePoints) {
    entries.push({
      id: point.id,
      kind: "restorePoint",
      label: "Saved draft",
      detail: `${formatDateTime(point.createdAt)} \u00b7 ${replacedByText(point)}`,
      note: point.title,
      revisionNumber: null,
    });
  }
  return entries;
}

/** The working copy as a snapshot, comparable with stored versions. */
export function workingSnapshot(detail: PlaybookDetail): VersionSnapshot {
  return {
    title: detail.title,
    summary: detail.summary,
    projectId: detail.projectId,
    projectName: detail.projectName,
    platform: detail.platform,
    product: detail.product,
    productVersion: detail.productVersion,
    environment: detail.environment,
    taskType: detail.taskType,
    author: detail.author,
    content: detail.content,
  };
}

const ORIGIN_SUFFIX = { session: " (from session)", edited: " (edited from session)", authored: "" } as const;

function indented(text: string, prefix = "    "): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => `${prefix}${line}`);
}

/**
 * A plain-text rendering of a version for line-by-line comparison: metadata, then every
 * section in document order. Screenshots appear as one line each (size, short id, redaction),
 * so adding, removing or redacting one shows up as a change.
 */
export function versionText(snapshot: VersionSnapshot, assets: Map<string, PlaybookAsset>): string {
  const lines: string[] = [`Title: ${snapshot.title}`];
  if (snapshot.summary.trim()) lines.push("Description:", ...indented(snapshot.summary));
  const fields: Array<[string, string | null]> = [
    ["Project", snapshot.projectName],
    ["Platform", snapshot.platform],
    ["Product", snapshot.product],
    ["Version", snapshot.productVersion],
    ["Environment", snapshot.environment],
    ["Task type", snapshot.taskType],
    ["Author", snapshot.author],
  ];
  for (const [label, value] of fields) {
    if (value && value.trim()) lines.push(`${label}: ${value}`);
  }
  const content = snapshot.content;
  for (const [title, text] of [
    ["Purpose", content.purpose],
    ["Scope", content.scope],
  ] as const) {
    if (text.trim()) lines.push("", `## ${title}`, ...indented(text, ""));
  }
  const listSection = (title: string, items: VersionSnapshot["content"]["prerequisites"], marker: (index: number) => string) => {
    if (items.length === 0) return;
    lines.push("", `## ${title}`);
    items.forEach((item, index) => {
      const [first = "", ...rest] = item.text.replace(/\r\n?/g, "\n").split("\n");
      lines.push(`${marker(index)}${first}${ORIGIN_SUFFIX[item.origin]}`, ...rest.map((line) => `   ${line}`));
    });
  };
  for (const section of LIST_SECTIONS) listSection(section.title, content[section.key], () => "- ");
  lines.push("", "## Steps");
  if (content.steps.length === 0) lines.push("(no steps)");
  content.steps.forEach((step, index) => {
    lines.push("", `### ${index + 1}. ${step.title}${ORIGIN_SUFFIX[step.origin]}`);
    if (step.instruction.trim()) lines.push(...indented(step.instruction, ""));
    if (step.command.trim()) lines.push("Command:", ...indented(step.command));
    if (step.expectedResult.trim()) lines.push("Expected result:", ...indented(step.expectedResult));
    if (step.note.trim()) lines.push("Note:", ...indented(step.note));
    step.assetIds.forEach((assetId, position) => {
      const asset = assets.get(assetId);
      const size = asset?.width && asset.height ? `${asset.width}\u00d7${asset.height}` : "unavailable";
      const extras = [asset?.redactedAt ? "redacted" : "", asset && asset.annotations.length > 0 ? `${asset.annotations.length} highlighted` : ""]
        .filter(Boolean)
        .join(", ");
      lines.push(`Screenshot ${position + 1}: ${size} \u00b7 image ${assetId.slice(-8)}${extras ? ` (${extras})` : ""}`);
    });
  });
  for (const section of CLOSING_SECTIONS) {
    listSection(section.title, content[section.key], section.key === "verification" ? () => "[ ] " : section.key === "rollback" ? (index) => `${index + 1}. ` : () => "- ");
  }
  return lines.join("\n");
}
