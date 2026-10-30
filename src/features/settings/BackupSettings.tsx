import { useState } from "react";
import { Archive, ArchiveRestore, FolderOpen } from "lucide-react";

import { useAppInfo, useCapture } from "../../app/contexts";
import { Button, ConfirmDialog, Notice, PropertyList, useToast } from "../../components";
import { api, toApiError, type BackupInfo, type BackupResult } from "../../lib/api";
import { formatBytes, formatDateTime, pluralize } from "../../lib/format";
import { revealLabel } from "../../lib/platform";
import { rememberRestore, reloadApp, takeRestoreNotice } from "../../lib/reload";
import styles from "./SettingsPage.module.css";

/**
 * Back up the whole workspace to one file, and restore a backup. Restoring replaces the data
 * only after the backup was checked, and keeps the replaced data in the workspace.
 */
export function BackupSettings() {
  const toast = useToast();
  const { status } = useCapture();
  const appInfo = useAppInfo();
  const [busy, setBusy] = useState<"backup" | "choose" | null>(null);
  const [saved, setSaved] = useState<BackupResult | null>(null);
  const [error, setError] = useState<{ title: string; message: string } | null>(null);
  const [chosen, setChosen] = useState<BackupInfo | null>(null);
  const [restoredFrom] = useState(() => takeRestoreNotice());

  const capturing = status.state !== "idle" ? "Stop the capture first, so every screenshot is included." : undefined;

  const backUp = async () => {
    setBusy("backup");
    setError(null);
    try {
      const result = await api.backup.create();
      if (result) {
        setSaved(result);
        toast.success("Backup saved", result.fileName);
      }
    } catch (raw) {
      setError({ title: "The backup could not be saved", message: toApiError(raw).message });
    } finally {
      setBusy(null);
    }
  };

  const choose = async () => {
    setBusy("choose");
    setError(null);
    try {
      const info = await api.backup.choose();
      if (info) setChosen(info);
    } catch (raw) {
      setError({ title: "This backup cannot be restored", message: toApiError(raw).message });
    } finally {
      setBusy(null);
    }
  };

  const reveal = () => {
    api.backup.reveal().catch((raw: unknown) => toast.error("Could not show the backup", toApiError(raw).message));
  };

  const upgrades = chosen && appInfo.data && chosen.schemaVersion < appInfo.data.latestSchemaVersion;

  return (
    <>
      {restoredFrom && (
        <Notice tone="success" title="Backup restored">
          Every screen now shows the restored workspace. The data it replaced is kept in the workspace folder under {restoredFrom}.
        </Notice>
      )}
      <div className={styles.row}>
        <div className={styles.rowText}>
          <span className={styles.rowLabel}>Back up</span>
          <span className={styles.rowHint}>
            Saves the database, screenshots, playbook images and terminal logs as one .zip file wherever you choose, for example another
            drive. Exports are not included; they can be created again.
          </span>
        </div>
        <Button icon={Archive} loading={busy === "backup"} disabledReason={capturing} onClick={() => void backUp()}>
          Back up workspace…
        </Button>
      </div>
      {saved && (
        <Notice
          tone="success"
          title="Backup saved"
          action={
            <Button size="sm" icon={FolderOpen} onClick={reveal}>
              {revealLabel}
            </Button>
          }
        >
          <span className={styles.path}>{saved.path}</span>
          {` \u00b7 ${formatBytes(saved.sizeBytes)} \u00b7 ${pluralize(saved.fileCount, "file")}`}
        </Notice>
      )}
      <div className={styles.row}>
        <div className={styles.rowText}>
          <span className={styles.rowLabel}>Restore</span>
          <span className={styles.rowHint}>
            Replaces this workspace with a backup after checking every file. The data it replaces is kept in the workspace&apos;s backups
            folder, so nothing is deleted.
          </span>
        </div>
        <Button
          icon={ArchiveRestore}
          loading={busy === "choose"}
          disabledReason={status.state !== "idle" ? "Stop the capture before restoring a backup." : undefined}
          onClick={() => void choose()}
        >
          Restore from backup…
        </Button>
      </div>
      {error && (
        <Notice tone="danger" role="alert" title={error.title}>
          {error.message}
        </Notice>
      )}
      <ConfirmDialog
        open={chosen !== null}
        onClose={() => setChosen(null)}
        title="Restore this backup?"
        confirmLabel="Restore backup"
        tone="danger"
        onConfirm={async () => {
          if (!chosen) return;
          const result = await api.backup.restore(chosen.token);
          rememberRestore(result.previousData);
          reloadApp();
        }}
      >
        {chosen && (
          <>
            <p>
              The workspace is replaced by the backup <strong>{chosen.fileName}</strong>. Terminal logs and watched files that are on stop
              first. The current data is moved to the workspace&apos;s backups folder and kept.
            </p>
            <div className={styles.restoreDetails}>
              <PropertyList
                items={[
                  { label: "Created", value: formatDateTime(chosen.createdAt) },
                  { label: "Workspace", value: chosen.workspaceName },
                  { label: "Made with", value: `DevTrace ${chosen.appVersion} (schema ${chosen.schemaVersion})` },
                  {
                    label: "Contents",
                    value: `${pluralize(chosen.counts.projects, "project")}, ${pluralize(chosen.counts.sessions, "session")}, ${pluralize(chosen.counts.playbooks, "playbook")}, ${pluralize(chosen.counts.changes, "change")}`,
                  },
                  { label: "Files", value: `${pluralize(chosen.fileCount, "file")} \u00b7 ${formatBytes(chosen.totalBytes)}` },
                ]}
              />
            </div>
            {upgrades && <p>The backup is from an older version; its data is upgraded to the current format when it is restored.</p>}
          </>
        )}
      </ConfirmDialog>
    </>
  );
}
