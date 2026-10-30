import { useMemo, useState } from "react";
import { AppWindow, CircleDot, Monitor, RefreshCw, ShieldCheck } from "lucide-react";

import { useCapture, useSettings } from "../../app/contexts";
import { Button, EmptyState, Icon, Notice, Select, Spinner, Switch, TextField, type SelectOption } from "../../components";
import { Page } from "../../layout/Page";
import { api, toApiError, type CaptureTarget } from "../../lib/api";
import { cx } from "../../lib/cx";
import { formatDateTime } from "../../lib/format";
import { useResource } from "../../lib/hooks";
import { SESSION_TITLE_RULE, validateText } from "../../lib/validation";
import { SessionPage } from "../sessions/SessionPage";
import styles from "./CapturePage.module.css";

const NEW_SESSION = "__new__";

/**
 * Capture workspace. While a capture is active it shows the live session (timeline, evidence
 * viewer, inspector) with capture controls; otherwise it sets up a new capture.
 */
export function CapturePage() {
  const { status } = useCapture();
  if (status.state !== "idle" && status.sessionId) {
    return <SessionPage sessionIdOverride={status.sessionId} variant="capture" />;
  }
  return <CaptureSetup />;
}

function targetDetail(target: CaptureTarget): string {
  const size = `${target.width} \u00d7 ${target.height}`;
  if (target.kind === "monitor") return target.primary ? `Primary display \u00b7 ${size}` : `Display \u00b7 ${size}`;
  return target.appName ? `${target.appName} \u00b7 ${size}` : size;
}

function CaptureSetup() {
  const { status, setStatus } = useCapture();
  const { settings } = useSettings();
  const sessions = useResource(api.sessions.list);
  const targets = useResource(api.capture.targets);
  const [sessionChoice, setSessionChoice] = useState(NEW_SESSION);
  const [title, setTitle] = useState(() => `Capture ${formatDateTime(new Date().toISOString())}`);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [autoCapture, setAutoCapture] = useState(false);

  const drafts = useMemo(() => (sessions.data ?? []).filter((session) => session.status === "draft"), [sessions.data]);
  const sessionOptions: SelectOption[] = [
    { value: NEW_SESSION, label: "New session" },
    ...drafts.map((session) => ({ value: session.id, label: session.title })),
  ];
  const list = targets.data ?? [];
  const selected = list.find((target) => target.id === targetId) ?? list.find((target) => target.primary) ?? list[0] ?? null;
  const monitors = list.filter((target) => target.kind === "monitor");
  const windows = list.filter((target) => target.kind === "window");

  const start = async () => {
    if (!selected) return;
    setError(null);
    if (sessionChoice === NEW_SESSION) {
      const problem = validateText(SESSION_TITLE_RULE, title);
      setTitleError(problem);
      if (problem) return;
    }
    setStarting(true);
    try {
      let sessionId = sessionChoice;
      if (sessionChoice === NEW_SESSION) {
        const created = await api.sessions.create({
          title: title.trim(),
          projectId: null,
          application: selected.kind === "window" ? selected.appName : "",
          environment: "",
        });
        sessionId = created.id;
        // If starting fails below, a retry reuses this session instead of creating another.
        setSessionChoice(created.id);
        sessions.reload();
      }
      setStatus(await api.capture.start(sessionId, selected.id, autoCapture));
    } catch (raw) {
      setError(toApiError(raw).message);
      setStarting(false);
    }
  };

  const renderTarget = (target: CaptureTarget) => {
    const checked = selected?.id === target.id;
    return (
      <li key={target.id}>
        <label className={cx(styles.target, checked && styles.targetSelected)}>
          <input
            type="radio"
            name="capture-target"
            className={styles.targetRadio}
            checked={checked}
            onChange={() => setTargetId(target.id)}
          />
          <Icon icon={target.kind === "monitor" ? Monitor : AppWindow} size={16} className={styles.targetIcon} />
          <span className={styles.targetText}>
            <span className={styles.targetTitle}>{target.title}</span>
            <span className={styles.targetMeta}>{targetDetail(target)}</span>
          </span>
        </label>
      </li>
    );
  };

  return (
    <Page title="Capture">
      <div className={styles.setup}>
        <header className={styles.setupHeader}>
          <h2 className={styles.setupTitle}>Start a capture</h2>
          <p className={styles.setupText}>
            Choose a session and a display or window. While recording, take a screenshot with Capture now, the tray icon or{" "}
            <strong>{settings.captureShortcut}</strong>. Each screenshot is added to the session timeline with its time and target.
          </p>
        </header>

        {!status.supported && (
          <Notice tone="warning" title="Capture is not available on this system">
            {status.unsupportedReason ?? "Screen capture is not supported here."} You can still document tasks manually in a session.
          </Notice>
        )}
        {error && (
          <Notice tone="danger" role="alert" title="The capture could not be started">
            {error}
          </Notice>
        )}

        <section className={styles.step} aria-labelledby="capture-session-heading">
          <h3 id="capture-session-heading" className={styles.stepTitle}>
            1. Session
          </h3>
          <Select
            label="Add screenshots to"
            options={sessionOptions}
            value={sessionChoice}
            onChange={(event) => setSessionChoice(event.target.value)}
          />
          {sessionChoice === NEW_SESSION && (
            <TextField
              label="New session title"
              value={title}
              maxLength={SESSION_TITLE_RULE.maxChars}
              error={titleError}
              autoComplete="off"
              onChange={(event) => {
                setTitle(event.target.value);
                setTitleError(null);
              }}
            />
          )}
        </section>

        <section className={styles.step} aria-labelledby="capture-target-heading">
          <div className={styles.stepHeader}>
            <h3 id="capture-target-heading" className={styles.stepTitle}>
              2. What to capture
            </h3>
            <Button size="sm" variant="ghost" icon={RefreshCw} onClick={targets.reload}>
              Refresh
            </Button>
          </div>
          {!status.supported ? null : targets.error ? (
            <Notice tone="danger" role="alert" title="Displays and windows could not be listed">
              {targets.error.message}
            </Notice>
          ) : targets.loading && !targets.data ? (
            <Spinner size={16} />
          ) : list.length === 0 ? (
            <EmptyState compact headingLevel={3} icon={Monitor} title="Nothing to capture" description="No display or window was found." />
          ) : (
            <div role="radiogroup" aria-labelledby="capture-target-heading" className={styles.targets}>
              {monitors.length > 0 && (
                <>
                  <p className={styles.groupLabel}>Displays</p>
                  <ul className={styles.targetList}>{monitors.map(renderTarget)}</ul>
                </>
              )}
              {windows.length > 0 && (
                <>
                  <p className={styles.groupLabel}>Windows</p>
                  <ul className={styles.targetList}>{windows.map(renderTarget)}</ul>
                </>
              )}
            </div>
          )}
        </section>

        <section className={styles.step} aria-labelledby="capture-options-heading">
          <h3 id="capture-options-heading" className={styles.stepTitle}>
            3. When to take screenshots
          </h3>
          <Switch
            label="Also capture automatically when the screen changes"
            description="DevTrace compares the target about once a second, in memory only, and takes a screenshot after a visible change has settled. Small changes such as a blinking cursor or typing are ignored, and nothing is sampled while paused. It does not detect clicks or keystrokes."
            checked={autoCapture}
            onCheckedChange={setAutoCapture}
            disabled={!status.supported}
          />
        </section>

        <Notice tone="neutral" icon={ShieldCheck} title="What DevTrace records">
          Only screenshots taken while recording, with their time, target and how they were taken (Capture now, shortcut, tray, or
          automatically after a screen change if you switch that on). Keystrokes, clicks and typed text are never recorded. While
          recording, DevTrace hides its own window from screenshots and shows a tray icon. Minimized windows are not listed. Protected or
          some hardware-accelerated windows can come back black; such screenshots are not saved, so capture the whole display instead.
        </Notice>

        <div className={styles.setupActions}>
          <Button
            variant="primary"
            size="lg"
            icon={CircleDot}
            loading={starting}
            disabledReason={!status.supported ? (status.unsupportedReason ?? "Capture is not supported here.") : !selected ? "Choose a display or window first." : undefined}
            onClick={() => void start()}
          >
            Start capture
          </Button>
        </div>
      </div>
    </Page>
  );
}
