/**
 * What this build can and cannot do. Controls for unavailable features render disabled with
 * these explanations instead of pretending to work. Update an entry when its milestone ships.
 */

export interface Availability {
  available: boolean;
  /** Roadmap milestone that delivers the feature (docs/ROADMAP.md). */
  milestone: number;
  /** Short explanation shown in tooltips and notices. */
  reason: string;
}

export const availability = {
  sessionManagement: {
    available: true,
    milestone: 2,
    reason: "Sessions, manual steps and imported or pasted screenshots are available.",
  },
  capture: {
    available: true,
    milestone: 3,
    reason: "Capture screenshots of a display or window you choose. Each screenshot is taken only when you ask for it.",
  },
  eventReview: {
    available: true,
    milestone: 4,
    reason: "Approve, reject or exclude each step, reorder steps and permanently redact screenshot areas.",
  },
  playbookAuthoring: {
    available: true,
    milestone: 5,
    reason: "Create playbooks from approved session steps or from scratch, edit them and publish revisions.",
  },
  export: {
    available: true,
    milestone: 6,
    reason: "Export playbooks as Markdown with images, self-contained HTML or PDF into the workspace exports folder.",
  },
  revisions: {
    available: true,
    milestone: 7,
    reason: "Read, compare and restore published revisions, mark procedures out of date and duplicate playbooks for reuse.",
  },
  changeTracking: {
    available: true,
    milestone: 8,
    reason: "Record changes, watch configuration files, review, approve and verify changes with an explicit note.",
  },
} as const satisfies Record<string, Availability>;

export type FeatureKey = keyof typeof availability;
