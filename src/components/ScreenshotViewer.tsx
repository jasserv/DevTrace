import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, ImageOff, Scan, ZoomIn, ZoomOut } from "lucide-react";

import { Button, IconButton } from "./Button";
import { EmptyState } from "./Feedback";
import styles from "./ScreenshotViewer.module.css";

export interface Screenshot {
  src: string;
  alt: string;
  /** Intrinsic pixel size. */
  width: number;
  height: number;
}

/** A highlighted region (for example a click target), in image pixel coordinates. */
export interface Highlight {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  label?: string;
  /** "redact" renders a solid box (a pending redaction). */
  tone?: "highlight" | "redact";
}

export interface DrawnRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ScreenshotViewerProps {
  label: string;
  image: Screenshot | null;
  highlights?: Highlight[];
  position?: { index: number; total: number };
  onPrevious?: () => void;
  onNext?: () => void;
  /** Shown when there is no image. */
  empty?: ReactNode;
  /** Extra toolbar controls (for example a before/after compare toggle). */
  toolbarEnd?: ReactNode;
  /** Explains why the controls are unavailable when there is no image. */
  unavailableReason?: string;
  /** When true, dragging on the image draws a rectangle (reported in image pixels). */
  drawing?: boolean;
  onDraw?: (rect: DrawnRect) => void;
}

const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3];
const CANVAS_PADDING = 48;
const MIN_DRAWN_SIDE = 4;

function toImagePoint(event: PointerEvent<HTMLDivElement>, width: number, height: number, scale: number) {
  const bounds = event.currentTarget.getBoundingClientRect();
  const x = Math.round((event.clientX - bounds.left) / scale);
  const y = Math.round((event.clientY - bounds.top) / scale);
  return { x: Math.min(Math.max(x, 0), width), y: Math.min(Math.max(y, 0), height) };
}

function normalizeRect(draft: { startX: number; startY: number; x: number; y: number }): DrawnRect {
  return {
    x: Math.min(draft.startX, draft.x),
    y: Math.min(draft.startY, draft.y),
    width: Math.abs(draft.x - draft.startX),
    height: Math.abs(draft.y - draft.startY),
  };
}

/** Large evidence preview with fit/zoom, navigation, highlighted regions and rectangle drawing. */
export function ScreenshotViewer({
  label,
  image,
  highlights = [],
  position,
  onPrevious,
  onNext,
  empty,
  toolbarEnd,
  unavailableReason = "No screenshot is selected.",
  drawing = false,
  onDraw,
}: ScreenshotViewerProps) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState<"fit" | number>("fit");
  const [fitScale, setFitScale] = useState(1);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ startX: number; startY: number; x: number; y: number } | null>(null);
  const failed = image !== null && failedSrc === image.src;
  const shown = failed ? null : image;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !shown || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      const scale = Math.min((width - CANVAS_PADDING) / shown.width, (height - CANVAS_PADDING) / shown.height, 1);
      setFitScale(Math.max(0.05, scale));
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [shown]);

  const scale = zoom === "fit" ? fitScale : zoom;
  const reason = shown ? undefined : failed ? "The image could not be loaded." : unavailableReason;

  const step = (direction: 1 | -1) => {
    const current = scale;
    const next =
      direction === 1
        ? (ZOOM_STEPS.find((value) => value > current + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]!)
        : ([...ZOOM_STEPS].reverse().find((value) => value < current - 0.001) ?? ZOOM_STEPS[0]!);
    setZoom(next);
  };

  return (
    <section className={styles.viewer} aria-label={label}>
      <div className={styles.toolbar} role="toolbar" aria-label="Screenshot controls">
        <IconButton icon={ZoomOut} label="Zoom out" size="sm" onClick={() => step(-1)} disabledReason={reason} />
        <span className={styles.zoomLabel} aria-live="polite">
          {shown ? `${Math.round(scale * 100)}%` : "\u2014"}
        </span>
        <IconButton icon={ZoomIn} label="Zoom in" size="sm" onClick={() => step(1)} disabledReason={reason} />
        <Button size="sm" variant="ghost" icon={Scan} onClick={() => setZoom("fit")} disabledReason={reason} aria-pressed={zoom === "fit"}>
          Fit
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setZoom(1)} disabledReason={reason} aria-pressed={zoom === 1}>
          100%
        </Button>
        {position && (
          <>
            <span className={styles.divider} aria-hidden="true" />
            <IconButton
              icon={ChevronLeft}
              label="Previous screenshot"
              size="sm"
              onClick={onPrevious}
              disabledReason={position.total === 0 ? unavailableReason : position.index <= 1 ? "This is the first screenshot." : undefined}
            />
            <span className={styles.position}>
              {position.total > 0 ? `${position.index} of ${position.total}` : "0 of 0"}
            </span>
            <IconButton
              icon={ChevronRight}
              label="Next screenshot"
              size="sm"
              onClick={onNext}
              disabledReason={
                position.total === 0 ? unavailableReason : position.index >= position.total ? "This is the last screenshot." : undefined
              }
            />
          </>
        )}
        <span className={styles.spacer} />
        {toolbarEnd}
      </div>
      <div ref={canvasRef} className={styles.canvas}>
        {shown ? (
          <div className={styles.frame} style={{ width: Math.round(shown.width * scale), height: Math.round(shown.height * scale) }}>
            <img className={styles.image} src={shown.src} alt={shown.alt} draggable={false} onError={() => setFailedSrc(shown.src)} />
            {highlights.map((highlight) => (
              <span
                key={highlight.id}
                className={highlight.tone === "redact" ? styles.redaction : styles.highlight}
                style={{
                  left: `${(highlight.x / shown.width) * 100}%`,
                  top: `${(highlight.y / shown.height) * 100}%`,
                  width: `${(highlight.width / shown.width) * 100}%`,
                  height: `${(highlight.height / shown.height) * 100}%`,
                }}
              >
                {highlight.label && <span className={styles.highlightLabel}>{highlight.label}</span>}
              </span>
            ))}
            {drawing && onDraw && (
              <div
                className={styles.drawLayer}
                aria-hidden="true"
                onPointerDown={(event) => {
                  const point = toImagePoint(event, shown.width, shown.height, scale);
                  event.currentTarget.setPointerCapture(event.pointerId);
                  setDraft({ startX: point.x, startY: point.y, x: point.x, y: point.y });
                }}
                onPointerMove={(event) => {
                  if (!draft) return;
                  const point = toImagePoint(event, shown.width, shown.height, scale);
                  setDraft({ ...draft, x: point.x, y: point.y });
                }}
                onPointerUp={() => {
                  if (!draft) return;
                  const rect = normalizeRect(draft);
                  setDraft(null);
                  if (rect.width >= MIN_DRAWN_SIDE && rect.height >= MIN_DRAWN_SIDE) onDraw(rect);
                }}
                onPointerCancel={() => setDraft(null)}
              >
                {draft && (
                  <span
                    className={styles.draft}
                    style={(() => {
                      const rect = normalizeRect(draft);
                      return {
                        left: `${(rect.x / shown.width) * 100}%`,
                        top: `${(rect.y / shown.height) * 100}%`,
                        width: `${(rect.width / shown.width) * 100}%`,
                        height: `${(rect.height / shown.height) * 100}%`,
                      };
                    })()}
                  />
                )}
              </div>
            )}
          </div>
        ) : failed ? (
          <div className={styles.empty}>
            <EmptyState
              icon={ImageOff}
              title="The image could not be loaded"
              description="The file may have been moved or deleted from the workspace folder."
            />
          </div>
        ) : (
          <div className={styles.empty}>{empty}</div>
        )}
      </div>
    </section>
  );
}
