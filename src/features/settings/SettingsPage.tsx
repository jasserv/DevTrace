import { useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { FolderOpen, Monitor, Moon, ShieldCheck, Sun } from "lucide-react";

import {
  Button,
  Icon,
  Kbd,
  Notice,
  PropertyList,
  SegmentedControl,
  Select,
  Switch,
  TextField,
  useToast,
  type ChoiceOption,
} from "../../components";
import { useAppInfo, useSettings } from "../../app/contexts";
import { Page } from "../../layout/Page";
import { NAV_ITEMS } from "../../layout/navigation";
import { api, toApiError, type AppSettings, type ThemePreference } from "../../lib/api";
import { useResource } from "../../lib/hooks";
import { formatShortcut, revealLabel } from "../../lib/platform";
import { AUTHOR_NAME_RULE, validateText, WORKSPACE_NAME_RULE, type TextRule } from "../../lib/validation";
import { CAPTURE_SHORTCUTS } from "../capture/shortcuts";
import { BackupSettings } from "./BackupSettings";
import styles from "./SettingsPage.module.css";

const themeOptions: ChoiceOption<ThemePreference>[] = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

const PRIVACY_FACTS = [
  "All workspace data, including screenshots, is stored locally in the folder shown above.",
  "No telemetry, analytics or crash reports are collected.",
  "The interface cannot connect to external servers; its content security policy blocks it.",
  "Screenshots are added only when you paste, drop or choose them, or during a capture you started: when you press Capture now, the capture shortcut or the tray menu item, or — only if you switch automatic capture on — after the chosen display or window visibly changes. The clipboard is read only when you paste into a session.",
  "Capture records only the display or window you chose, and only while recording. Keystrokes, clicks and typed text are never recorded; DevTrace has no keyboard or mouse hooks.",
  "While recording, DevTrace hides its own window from screenshots and shows a tray icon until the capture stops.",
  "Terminal logs and watched files are switched on per session. DevTrace reads only the log file it created for you and the files you picked, and masks values that look like secrets before storing terminal text.",
  "Commands you document or record are stored as text and are never executed.",
  "Backups are written only where you choose. DevTrace never uploads them.",
];

const shortcutOptions = CAPTURE_SHORTCUTS.map((shortcut) => ({ value: shortcut, label: shortcut }));

function Group({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  const id = `settings-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <section className={styles.group} aria-labelledby={id}>
      <header className={styles.groupHeader}>
        <h2 id={id} className={styles.groupTitle}>
          {title}
        </h2>
        {description && <p className={styles.groupDescription}>{description}</p>}
      </header>
      <div>{children}</div>
    </section>
  );
}

function Row({ label, hint, children, stack = false }: { label: string; hint?: ReactNode; children: ReactNode; stack?: boolean }) {
  return (
    <div className={`${styles.row} ${stack ? styles.rowStack : ""}`}>
      <div className={styles.rowText}>
        <span className={styles.rowLabel}>{label}</span>
        {hint && <span className={styles.rowHint}>{hint}</span>}
      </div>
      {children}
    </div>
  );
}

/** Text setting with explicit save; input is preserved and the error shown when saving fails. */
function TextSetting({
  label,
  rule,
  field,
  placeholder,
}: {
  label: string;
  rule: TextRule;
  field: "workspaceName" | "authorName";
  placeholder?: string;
}) {
  const { settings, update } = useSettings();
  const toast = useToast();
  const saved = settings[field];
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const value = draft ?? saved;
  const dirty = draft !== null && draft.trim() !== saved;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!dirty) return;
    const problem = validateText(rule, value);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    try {
      const patch: Partial<AppSettings> = { [field]: value.trim() };
      await update(patch);
      setDraft(null);
      setError(null);
      toast.success(`${label} saved`);
    } catch (raw) {
      setError(toApiError(raw).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className={styles.inlineForm} onSubmit={submit} noValidate>
      <TextField
        label={label}
        labelHidden
        value={value}
        placeholder={placeholder}
        maxLength={rule.maxChars}
        error={error}
        onChange={(event) => {
          setDraft(event.target.value);
          if (error) setError(null);
        }}
      />
      <Button type="submit" loading={saving} disabledReason={dirty ? undefined : "No changes to save."}>
        Save
      </Button>
    </form>
  );
}

export function SettingsPage() {
  const { settings, update } = useSettings();
  const appInfo = useAppInfo();
  const toast = useToast();
  const info = appInfo.data;

  const save = (patch: Partial<AppSettings>) => {
    update(patch).catch((raw: unknown) => toast.error("The setting could not be saved", toApiError(raw).message));
  };

  const reveal = () => {
    api.app.revealDataDirectory().catch((raw: unknown) => toast.error("Could not open the workspace folder", toApiError(raw).message));
  };

  const shortcuts: Array<{ action: string; keys: string[] }> = [
    ...NAV_ITEMS.map((item) => ({ action: `Go to ${item.label}`, keys: [formatShortcut(item.shortcutKey)] })),
    { action: "Open Settings", keys: [formatShortcut(",")] },
    { action: "Show or hide the sidebar", keys: [formatShortcut("\\")] },
    { action: "Search the current list", keys: [formatShortcut("F")] },
    { action: "New project (on Projects)", keys: [formatShortcut("N")] },
    { action: "Take a screenshot while recording (from any application)", keys: [settings.captureShortcut] },
    { action: "Approve, reject or exclude the focused step; set it back to pending", keys: ["A", "R", "X", "P"] },
    { action: "Move the focused step up or down", keys: ["Alt+\u2191", "Alt+\u2193"] },
    { action: "Close a dialog, menu or tooltip", keys: ["Esc"] },
  ];

  return (
    <Page title="Settings">
      <div className={styles.container}>
        <Group title="Appearance">
          <Row label="Theme" hint="Follow the operating system, or always use light or dark.">
            <SegmentedControl label="Theme" options={themeOptions} value={settings.theme} onChange={(theme) => save({ theme })} />
          </Row>
          <div className={styles.row}>
            <div className={styles.switchRow}>
              <Switch
                label="Reduce motion"
                description="Turn off interface animations. DevTrace also follows the system setting."
                checked={settings.reduceMotion}
                onCheckedChange={(reduceMotion) => save({ reduceMotion })}
              />
            </div>
          </div>
          <div className={styles.row}>
            <div className={styles.switchRow}>
              <Switch
                label="Compact sidebar"
                description="Show navigation as icons only. Narrow windows always use the compact sidebar."
                checked={settings.sidebarCollapsed}
                onCheckedChange={(sidebarCollapsed) => save({ sidebarCollapsed })}
              />
            </div>
          </div>
        </Group>

        <Group title="Workspace" description="A workspace is a local folder containing the database, attachments, exports and backups.">
          <Row label="Name" hint="Shown in the sidebar and on the Overview.">
            <TextSetting label="Workspace name" field="workspaceName" rule={WORKSPACE_NAME_RULE} />
          </Row>
          <Row label="Location" hint={info ? <span className={styles.path}>{info.dataDir}</span> : "Loading\u2026"} stack>
            <Button icon={FolderOpen} onClick={reveal} disabledReason={info ? undefined : "The workspace location is not available."}>
              {revealLabel}
            </Button>
          </Row>
          <Row label="Database" hint={info ? `SQLite ${info.sqliteVersion} · schema version ${info.schemaVersion ?? "unknown"}` : "Loading\u2026"}>
            <span />
          </Row>
        </Group>

        <Group
          title="Backup and restore"
          description="Keep a copy of the workspace somewhere safe. DevTrace never uploads it; you choose where the file goes."
        >
          <BackupSettings />
        </Group>

        <Group title="Profile" description="Used for authorship metadata. Stored only in this workspace.">
          <Row label="Author name" hint="Recorded as the author of playbook revisions.">
            <TextSetting label="Author name" field="authorName" rule={AUTHOR_NAME_RULE} placeholder="Your name" />
          </Row>
        </Group>

        <Group
          title="Capture"
          description="Screenshots are taken only while a capture you started is recording, and only of the display or window you chose."
        >
          <Row
            label="Capture shortcut"
            hint="Takes a screenshot from any application while recording. It is registered only during a capture, so it does not affect other applications otherwise."
          >
            <Select
              aria-label="Capture shortcut"
              options={shortcutOptions}
              value={settings.captureShortcut}
              onChange={(event) => save({ captureShortcut: event.target.value })}
            />
          </Row>
        </Group>

        <Group title="Privacy">
          <ul className={styles.facts}>
            {PRIVACY_FACTS.map((fact) => (
              <li key={fact} className={styles.fact}>
                <Icon icon={ShieldCheck} size={15} />
                <span>{fact}</span>
              </li>
            ))}
          </ul>
          <Notice tone="neutral" title="Redaction">
            To hide passwords, tokens or personal data, open a screenshot and use Redact: the marked areas are blacked out in the image
            file itself and the original is deleted. Review decisions, including redactions, are recorded in each session&apos;s review
            history.
          </Notice>
        </Group>

        <Group
          title="Integrations"
          description="Opt-in sources of recorded steps. Each one runs only after you switch it on for a session or capture, shows its state, and records steps that still need review. None of them observes keyboard or mouse input."
        >
          <IntegrationList />
        </Group>

        <Group title="Keyboard shortcuts">
          <table className={styles.shortcuts}>
            <tbody>
              {shortcuts.map((shortcut) => (
                <tr key={shortcut.action}>
                  <td>{shortcut.action}</td>
                  <td className={styles.shortcutKeys}>
                    <span className={styles.keys}>
                      {shortcut.keys.map((key) => (
                        <Kbd key={key}>{key}</Kbd>
                      ))}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Group>

        <Group title="About">
          <div className={styles.about}>
            {info ? (
              <PropertyList
                items={[
                  { label: "Version", value: `${info.name} ${info.version}` },
                  { label: "Build", value: info.debugBuild ? "Development" : "Release" },
                  { label: "Platform", value: `${info.os} (${info.arch})` },
                  { label: "Tauri", value: info.tauriVersion, mono: true },
                  { label: "SQLite", value: info.sqliteVersion, mono: true },
                  { label: "Schema", value: `${info.schemaVersion ?? "unknown"} of ${info.latestSchemaVersion}`, mono: true },
                  { label: "Identifier", value: info.identifier, mono: true },
                ]}
              />
            ) : appInfo.error ? (
              <Notice tone="danger" title="Application details are unavailable">
                {appInfo.error.message}
              </Notice>
            ) : (
              <span className={styles.rowHint}>{"Loading\u2026"}</span>
            )}
          </div>
          {import.meta.env.DEV && (
            <p className={styles.rowHint}>
              Development build: <Link to="/dev/components">open the component gallery</Link>.
            </p>
          )}
        </Group>
      </div>
    </Page>
  );
}

/** What each opt-in integration does and where it is switched on (from the backend catalog). */
function IntegrationList() {
  const integrations = useResource(api.integrations.list);
  if (integrations.error) {
    return (
      <Notice tone="danger" role="alert" title="Integrations could not be listed">
        {integrations.error.message}
      </Notice>
    );
  }
  return (
    <ul className={styles.integrations}>
      {(integrations.data ?? []).map((integration) => (
        <li key={integration.id} className={styles.integration}>
          <span className={styles.integrationName}>
            {integration.name}
            {!integration.available && <span className={styles.integrationUnavailable}> (unavailable: {integration.unavailableReason})</span>}
          </span>
          <span className={styles.integrationText}>{integration.description}</span>
          <span className={styles.integrationText}>Where: {integration.location}</span>
        </li>
      ))}
    </ul>
  );
}
