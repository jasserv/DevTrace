import { useCallback, useEffect, useState } from "react";
import { Copy, FileSearch, Square, SquareTerminal, X } from "lucide-react";

import { Button, IconButton, InspectorSection, Select, useToast } from "../../components";
import { api, toApiError, type FileWatchStatus, type LogFormat, type SessionDetail, type TerminalLogStatus } from "../../lib/api";
import { BACKEND_EVENTS, listenBackend } from "../../lib/events";
import { formatTime, pluralize } from "../../lib/format";
import styles from "./SessionIntegrations.module.css";

const FORMAT_OPTIONS = [
  { value: "powershell", label: "PowerShell transcript" },
  { value: "plain", label: "Plain text log (PuTTY and others)" },
];

/** The command that makes a terminal write to the log file. */
function startCommand(format: LogFormat, path: string): string {
  return format === "powershell" ? `Start-Transcript -Path "${path}" -Append` : path;
}

interface SessionIntegrationsProps {
  session: SessionDetail;
  /** Why recording is unavailable (for example a completed session); undefined when allowed. */
  lockedReason: string | undefined;
}

/**
 * Opt-in sources of recorded steps for this session: a terminal log the user starts in their own
 * terminal, and configuration files chosen in the system file dialog. Both show their state and
 * stop with one click; recorded steps still need review.
 */
export function SessionIntegrations({ session, lockedReason }: SessionIntegrationsProps) {
  const toast = useToast();
  const [format, setFormat] = useState<LogFormat>("powershell");
  const [log, setLog] = useState<TerminalLogStatus | null>(null);
  const [watches, setWatches] = useState<FileWatchStatus[]>([]);
  const [busy, setBusy] = useState<"log" | "watch" | null>(null);

  const loadWatches = useCallback(() => {
    api.integrations.files
      .list(session.id)
      .then(setWatches)
      .catch(() => setWatches([]));
  }, [session.id]);

  useEffect(() => {
    let active = true;
    api.integrations.terminal
      .get(session.id)
      .then((status) => {
        if (active) setLog(status);
      })
      .catch(() => undefined);
    api.integrations.files
      .list(session.id)
      .then((list) => {
        if (active) setWatches(list);
      })
      .catch(() => undefined);
    const stopLogs = listenBackend<TerminalLogStatus>(BACKEND_EVENTS.terminalLog, (status) => {
      if (status.sessionId === session.id) setLog(status);
    });
    const stopWatches = listenBackend<FileWatchStatus>(BACKEND_EVENTS.fileWatch, (status) => {
      if (status.sessionId === session.id) loadWatches();
    });
    return () => {
      active = false;
      stopLogs();
      stopWatches();
    };
  }, [session.id, loadWatches]);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied", "Paste it into your terminal or tool.");
    } catch {
      toast.error("Could not copy", "Select the text and copy it manually.");
    }
  };

  const startLog = async () => {
    setBusy("log");
    try {
      setLog(await api.integrations.terminal.start(session.id, format));
    } catch (raw) {
      toast.error("Terminal logging could not start", toApiError(raw).message);
    } finally {
      setBusy(null);
    }
  };

  const stopLog = async () => {
    setBusy("log");
    try {
      const stopped = await api.integrations.terminal.stop(session.id);
      setLog(stopped);
      if (stopped) toast.success("Terminal logging stopped", `${pluralize(stopped.stepsRecorded, "step")} recorded.`);
    } catch (raw) {
      toast.error("Terminal logging could not stop", toApiError(raw).message);
    } finally {
      setBusy(null);
    }
  };

  const watchFile = async () => {
    setBusy("watch");
    try {
      const started = await api.integrations.files.watch(session.id);
      if (started) {
        toast.success("Watching file", started.fileName);
        loadWatches();
      }
    } catch (raw) {
      toast.error("The file cannot be watched", toApiError(raw).message);
    } finally {
      setBusy(null);
    }
  };

  const stopWatch = async (watch: FileWatchStatus) => {
    try {
      await api.integrations.files.stop(watch.id);
      loadWatches();
    } catch (raw) {
      toast.error("Watching could not stop", toApiError(raw).message);
    }
  };

  const logging = log?.active === true;
  const command = log ? startCommand(log.format, log.path) : "";

  return (
    <InspectorSection title="Integrations">
      <div className={styles.group} role="group" aria-label="Terminal log">
        <span className={styles.groupTitle}>Terminal log</span>
        {logging && log ? (
          <>
            <span className={styles.status} role="status">
              <span className={styles.dot} aria-hidden="true" />
              {`Reading the log \u00b7 ${pluralize(log.stepsRecorded, "step")} recorded`}
            </span>
            <p className={styles.text}>
              {log.format === "powershell"
                ? "Run this in the PowerShell window you work in. Run Stop-Transcript there when you are done."
                : "Set your tool to log to this file (for example PuTTY: Session \u2192 Logging \u2192 Log file name)."}
            </p>
            <div className={styles.snippet} role="group" aria-label={log.format === "powershell" ? "Command to start the transcript" : "Log file path"}>
              <code>{command}</code>
              <IconButton size="sm" icon={Copy} label="Copy" onClick={() => void copy(command)} />
            </div>
            <div className={styles.row}>
              <Button size="sm" icon={Square} loading={busy === "log"} onClick={() => void stopLog()}>
                Stop terminal log
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className={styles.text}>
              Records commands and output from a terminal you start logging yourself. DevTrace never runs commands; values that look like
              secrets are masked, and every recorded step needs review.
            </p>
            <Select label="Log format" size="sm" options={FORMAT_OPTIONS} value={format} onChange={(event) => setFormat(event.target.value as LogFormat)} />
            <div className={styles.row}>
              <Button size="sm" icon={SquareTerminal} loading={busy === "log"} disabledReason={lockedReason} onClick={() => void startLog()}>
                Start terminal log
              </Button>
            </div>
          </>
        )}
        {log?.lastError && (
          <p className={styles.error} role="alert">
            {log.lastError}
          </p>
        )}
        {log && !logging && log.stepsRecorded > 0 && <p className={styles.text}>Last log: {pluralize(log.stepsRecorded, "step")} recorded.</p>}
      </div>

      <div className={styles.group} role="group" aria-label="Watched files">
        <span className={styles.groupTitle}>Watched files</span>
        <p className={styles.text}>
          Choose a text configuration file (up to 1 MB). Each change becomes a step and an observed change in Change History, with the
          values before and after.
        </p>
        {watches.length > 0 && (
          <ul className={styles.watches}>
            {watches.map((watch) => (
              <li key={watch.id} className={styles.watch}>
                <span className={styles.watchText}>
                  <span className={styles.watchName}>{watch.fileName}</span>
                  <span className={styles.path}>{watch.path}</span>
                  <span className={styles.text}>
                    {watch.changesRecorded > 0
                      ? `${pluralize(watch.changesRecorded, "change")} recorded, last at ${formatTime(watch.lastChangeAt)}`
                      : "No changes yet"}
                  </span>
                  {watch.lastError && <span className={styles.error}>{watch.lastError}</span>}
                </span>
                <IconButton size="sm" icon={X} label={`Stop watching ${watch.fileName}`} onClick={() => void stopWatch(watch)} />
              </li>
            ))}
          </ul>
        )}
        <div className={styles.row}>
          <Button size="sm" icon={FileSearch} loading={busy === "watch"} disabledReason={lockedReason} onClick={() => void watchFile()}>
            Watch a file…
          </Button>
        </div>
      </div>
    </InspectorSection>
  );
}
