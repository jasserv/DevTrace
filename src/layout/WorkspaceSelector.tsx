import { useState, type FormEvent } from "react";
import { ChevronsUpDown, FolderOpen, HardDrive, Pencil, Plus } from "lucide-react";

import { Button, Dialog, Icon, Menu, TextField, Tooltip, useToast, type MenuEntry } from "../components";
import { useAppInfo, useSettings } from "../app/contexts";
import { api, toApiError } from "../lib/api";
import { revealLabel } from "../lib/platform";
import { validateText, WORKSPACE_NAME_RULE } from "../lib/validation";
import styles from "./Sidebar.module.css";

/**
 * Shows the current workspace. A workspace is one local data directory; this build supports a
 * single workspace, so adding another is listed but explained as unavailable.
 */
export function WorkspaceSelector({ collapsed }: { collapsed: boolean }) {
  const { settings } = useSettings();
  const appInfo = useAppInfo();
  const toast = useToast();
  const [renaming, setRenaming] = useState(false);
  const [renameKey, setRenameKey] = useState(0);

  const reveal = () => {
    api.app
      .revealDataDirectory()
      .catch((raw: unknown) => toast.error("Could not open the workspace folder", toApiError(raw).message));
  };

  const entries: MenuEntry[] = [
    { type: "label", id: "heading", label: "Workspace" },
    {
      id: "current",
      label: settings.workspaceName,
      description: appInfo.data?.dataDir ?? "Local data directory on this device",
      checked: true,
    },
    { type: "separator", id: "separator-1" },
    {
      id: "rename",
      label: "Rename workspace\u2026",
      icon: Pencil,
      onSelect: () => {
        setRenameKey((key) => key + 1);
        setRenaming(true);
      },
    },
    { id: "reveal", label: revealLabel, icon: FolderOpen, onSelect: reveal, disabled: !appInfo.data },
    { type: "separator", id: "separator-2" },
    {
      id: "add",
      label: "Add workspace",
      icon: Plus,
      disabled: true,
      description: "Multiple workspaces are planned. This build uses one local workspace.",
    },
  ];

  const menu = (
    <Menu
      label="Workspace"
      entries={entries}
      align={collapsed ? "start" : "stretch"}
      renderTrigger={(props) => (
        <button
          {...props}
          type="button"
          className={styles.workspaceButton}
          aria-label={collapsed ? `Workspace: ${settings.workspaceName}` : undefined}
        >
          <span className={styles.workspaceTile} aria-hidden="true">
            <Icon icon={HardDrive} size={13} />
          </span>
          {!collapsed && (
            <>
              <span className={styles.workspaceText}>
                <span className={styles.workspaceName}>{settings.workspaceName}</span>
                <span className={styles.workspaceMeta}>Local · this device</span>
              </span>
              <Icon icon={ChevronsUpDown} size={14} className={styles.workspaceChevron} />
            </>
          )}
        </button>
      )}
    />
  );

  return (
    <div className={styles.workspace}>
      {collapsed ? (
        <Tooltip content={settings.workspaceName} placement="right">
          <div>{menu}</div>
        </Tooltip>
      ) : (
        menu
      )}
      <RenameWorkspaceDialog key={renameKey} open={renaming} onClose={() => setRenaming(false)} />
    </div>
  );
}

/** Remounted (via key) each time it opens, so the form starts from the saved name. */
function RenameWorkspaceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { settings, update } = useSettings();
  const toast = useToast();
  const [name, setName] = useState(settings.workspaceName);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const problem = validateText(WORKSPACE_NAME_RULE, name);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    try {
      await update({ workspaceName: name.trim() });
      toast.success("Workspace renamed");
      onClose();
    } catch (raw) {
      setError(toApiError(raw).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissible={!saving}
      title="Rename workspace"
      description="The name appears in the sidebar and on the Overview."
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={saving}>
            Save
          </Button>
        </>
      }
    >
      <TextField
        label="Workspace name"
        value={name}
        maxLength={WORKSPACE_NAME_RULE.maxChars}
        showCounter
        error={error}
        onChange={(event) => {
          setName(event.target.value);
          if (error) setError(null);
        }}
      />
    </Dialog>
  );
}
