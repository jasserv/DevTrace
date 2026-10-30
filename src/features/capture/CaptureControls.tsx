import { useEffect, useState } from "react";
import { Camera, Pause, Play, ScanEye, Square } from "lucide-react";

import { useCapture } from "../../app/contexts";
import { Button, IconButton, Notice, useToast } from "../../components";
import { api, toApiError, type CaptureStatus } from "../../lib/api";
import { cx } from "../../lib/cx";
import styles from "./CapturePage.module.css";

function elapsed(startedAt: string | null, now: number): string {
  if (!startedAt) return "0:00";
  const seconds = Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

/** Live recording indicator: state, elapsed time and number of screenshots. */
export function CaptureStatusPill({ status }: { status: CaptureStatus }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (status.state !== "recording") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [status.state]);

  const label = status.state === "recording" ? "Recording" : status.state === "paused" ? "Paused" : "Not recording";
  return (
    <span
      className={cx(styles.status, status.state === "recording" && styles.statusRecording, status.state === "paused" && styles.statusPaused)}
      role="status"
      aria-label={`Capture status: ${label}, ${status.captureCount} screenshots${status.autoCapture && status.state !== "idle" ? ", automatic capture on" : ""}`}
    >
      <span className={styles.statusDot} aria-hidden="true" />
      {label}
      {status.state !== "idle" && (
        <span className={styles.statusMeta}>
          {status.state === "recording" ? `${elapsed(status.startedAt, now)} \u00b7 ` : ""}
          {status.captureCount}
        </span>
      )}
    </span>
  );
}

/** Capture now, pause/resume, automatic capture and stop. Every action reports failures instead of failing silently. */
export function CaptureControls() {
  const { status, setStatus, reportShot, refresh } = useCapture();
  const toast = useToast();
  const [busy, setBusy] = useState<"shot" | "pause" | "stop" | "auto" | null>(null);

  const run = async (kind: "shot" | "pause" | "stop" | "auto", action: () => Promise<void>) => {
    setBusy(kind);
    try {
      await action();
    } catch (raw) {
      toast.error(kind === "shot" ? "Screenshot not saved" : "Capture action failed", toApiError(raw).message);
    } finally {
      setBusy(null);
    }
  };

  const paused = status.state === "paused";
  return (
    <>
      <CaptureStatusPill status={status} />
      <span className={styles.divider} aria-hidden="true" />
      <Button
        variant="primary"
        icon={Camera}
        loading={busy === "shot"}
        disabledReason={paused ? "Capture is paused. Resume to take screenshots." : undefined}
        tooltip={status.shortcutActive ? `Capture the selected target now (${status.shortcut})` : "Capture the selected target now"}
        onClick={() =>
          void run("shot", async () => {
            reportShot(await api.capture.captureNow());
            refresh();
          })
        }
      >
        Capture now
      </Button>
      <Button
        icon={ScanEye}
        loading={busy === "auto"}
        aria-pressed={status.autoCapture}
        tooltip={
          status.autoCapture
            ? "Automatic capture is on: a screenshot is taken after the screen changes and settles. Click to switch it off."
            : "Switch on automatic capture after screen changes (it does not detect clicks or keystrokes)."
        }
        onClick={() => void run("auto", async () => setStatus(await api.capture.setAutoCapture(!status.autoCapture)))}
      >
        Auto capture
      </Button>
      <IconButton
        icon={paused ? Play : Pause}
        label={paused ? "Resume capture" : "Pause capture"}
        loading={busy === "pause"}
        onClick={() => void run("pause", async () => setStatus(paused ? await api.capture.resume() : await api.capture.pause()))}
      />
      <Button
        icon={Square}
        loading={busy === "stop"}
        tooltip="Stop capturing. The session stays open for review."
        onClick={() =>
          void run("stop", async () => {
            setStatus(await api.capture.stop());
            toast.success("Capture stopped", "Review the screenshots, then complete the session.");
          })
        }
      >
        Stop
      </Button>
    </>
  );
}

/**
 * Problems that happen away from the Capture now button: a shortcut that could not be
 * registered, or a screenshot from the shortcut or tray menu that failed.
 */
export function CaptureAlerts({ className }: { className?: string }) {
  const { status } = useCapture();
  if (status.state === "idle") return null;
  return (
    <>
      {status.shortcutError && (
        <Notice tone="warning" className={className} title="Capture shortcut unavailable">
          {status.shortcutError}
        </Notice>
      )}
      {status.lastError && (
        <Notice tone="danger" className={className} title="Last screenshot failed" role="alert">
          {status.lastError}
        </Notice>
      )}
    </>
  );
}
