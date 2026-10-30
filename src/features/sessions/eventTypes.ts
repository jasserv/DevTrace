import { Camera, ClipboardPaste, FileDiff, FileImage, Footprints, PenLine, ScanEye, ScrollText, StickyNote, Terminal, type LucideIcon } from "lucide-react";

import type { Highlight } from "../../components";
import type { Annotation, Attachment, AttachmentSource, CaptureTrigger, EventSource, EventType, SessionEvent } from "../../lib/api";
import { formatBytes } from "../../lib/format";

/** Mirrors `MAX_ANNOTATIONS` in `src-tauri/src/features/attachments.rs`. */
export const MAX_ANNOTATIONS = 50;

/** Identifier for a new annotation (accepted by the backend's identifier rules). */
export function newAnnotationId(): string {
  return crypto.randomUUID();
}

const TRIGGER_LABELS: Record<CaptureTrigger, string> = {
  button: "Capture now button",
  shortcut: "Capture shortcut",
  tray: "Tray menu",
  auto: "Automatic capture",
};

/** Recorded facts about a captured screenshot, for the inspector. Null for other events. */
export function captureDetails(event: SessionEvent): { trigger: string; target: string; size: string | null } | null {
  const capture = event.metadata.capture;
  if (!capture?.target) return null;
  const { kind, title, appName, width, height } = capture.target;
  const what = kind === "monitor" ? `Display: ${title}` : `Window: ${title}`;
  return {
    trigger: capture.trigger ? TRIGGER_LABELS[capture.trigger] : "Unknown",
    target: kind === "window" && appName ? `${what} (${appName})` : what,
    size: width && height ? `${width} \u00d7 ${height}` : null,
  };
}

/** Numbered labels shown on the image and in the inspector. */
export function annotationHighlights(annotations: Annotation[]): Highlight[] {
  return annotations.map((annotation, index) => ({
    id: annotation.id,
    x: annotation.x,
    y: annotation.y,
    width: annotation.width,
    height: annotation.height,
    label: annotation.label ? `${index + 1} ${annotation.label}` : `${index + 1}`,
  }));
}

/** "image/png" -> "PNG" */
export function mediaLabel(mediaType: string): string {
  const subtype = mediaType.split("/")[1] ?? mediaType;
  return subtype === "jpeg" ? "JPEG" : subtype.toUpperCase();
}

/** "1920 × 1080 · PNG · 245 KB" */
export function imageFacts(attachment: Attachment): string {
  const size = attachment.width && attachment.height ? `${attachment.width} \u00d7 ${attachment.height}` : null;
  return [size, mediaLabel(attachment.mediaType), formatBytes(attachment.byteSize)].filter(Boolean).join(" \u00b7 ");
}

export interface EventTypeInfo {
  label: string;
  icon: LucideIcon;
  /** Example title shown as a placeholder in the event form. */
  placeholder: string;
  /** Short explanation shown in the Add menu. */
  description: string;
}

export const eventTypes: Record<EventType, EventTypeInfo> = {
  step: {
    label: "Step",
    icon: Footprints,
    placeholder: "e.g. Open the NTP settings page",
    description: "An action that was performed",
  },
  note: {
    label: "Note",
    icon: StickyNote,
    placeholder: "e.g. Change window approved by the CAB",
    description: "Context, a decision or an observation",
  },
  command: {
    label: "Command",
    icon: Terminal,
    placeholder: "e.g. Verify NTP synchronization",
    description: "A command that was run; stored as text, never executed",
  },
  screenshot: {
    label: "Screenshot",
    icon: Camera,
    placeholder: "e.g. NTP settings after the change",
    description: "An image you provide",
  },
  log: {
    label: "Terminal output",
    icon: ScrollText,
    placeholder: "e.g. Output of the update",
    description: "Output read from a terminal log you started",
  },
  change: {
    label: "File change",
    icon: FileDiff,
    placeholder: "e.g. nginx.conf changed",
    description: "A change seen in a configuration file you chose to watch",
  },
};

/** Manually written event types (screenshot steps are created by adding an image). */
export const manualEventTypes = ["step", "note", "command"] as const satisfies readonly EventType[];
export type ManualEventType = (typeof manualEventTypes)[number];

export interface SourceInfo {
  label: string;
  icon: LucideIcon;
  description: string;
}

/** Where content came from; keeps user-provided content distinct from recorded content. */
export const eventSources: Record<EventSource, SourceInfo> = {
  manual: { label: "Written by you", icon: PenLine, description: "Entered manually in DevTrace." },
  file: { label: "Image file", icon: FileImage, description: "Created from an image file you chose or dropped." },
  clipboard: { label: "Pasted image", icon: ClipboardPaste, description: "Created from an image you pasted." },
  capture: { label: "Recorded by capture", icon: ScanEye, description: "Recorded by DevTrace capture." },
  terminal: { label: "Terminal log", icon: Terminal, description: "Read from a terminal log you started; values that looked like secrets are masked." },
  file_watch: { label: "Watched file", icon: FileDiff, description: "Recorded when a configuration file you chose to watch changed." },
};

/** Recorded facts about a terminal log step, for the inspector. Null for other events. */
export function terminalDetails(event: SessionEvent): { output: string | null; masked: boolean; format: string } | null {
  const terminal = event.metadata.terminal;
  if (!terminal) return null;
  return {
    output: terminal.output ? terminal.output : null,
    masked: terminal.masked === true,
    format: terminal.format === "powershell" ? "PowerShell transcript" : "Plain text log",
  };
}

export const attachmentSources: Record<AttachmentSource, SourceInfo> = {
  file: eventSources.file,
  clipboard: eventSources.clipboard,
  capture: eventSources.capture,
};
