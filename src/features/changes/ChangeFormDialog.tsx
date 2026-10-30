import { useState, type FormEvent } from "react";

import { Button, Dialog, Notice, Select, TextArea, TextField, type SelectOption } from "../../components";
import { api, toApiError, type ChangeInput, type ChangeRecord } from "../../lib/api";
import { useResource } from "../../lib/hooks";

interface ChangeFormDialogProps {
  /** The change to edit; a new declared change when omitted. */
  change?: ChangeRecord;
  onClose: () => void;
  onSaved: (change: ChangeRecord) => void;
}

/** `2026-10-23T08:15:00.000Z` → the local `datetime-local` value. */
function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

/**
 * Declares a change (or edits a declared one before review): what changed, where, and the values
 * before and after. Declared changes are statements by the user, not verified facts.
 */
export function ChangeFormDialog({ change, onClose, onSaved }: ChangeFormDialogProps) {
  const projects = useResource(api.projects.list);
  const sessions = useResource(api.sessions.list);
  const [form, setForm] = useState({
    target: change?.target ?? "",
    summary: change?.summary ?? "",
    projectId: change?.projectId ?? "",
    sessionId: change?.sessionId ?? "",
    occurredAt: toLocalInput(change?.occurredAt),
    environment: change?.environment ?? "",
    platform: change?.platform ?? "",
    version: change?.version ?? "",
    beforeValue: change?.beforeValue ?? "",
    afterValue: change?.afterValue ?? "",
  });
  const [error, setError] = useState<{ field: string | null; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<typeof form>) => setForm((current) => ({ ...current, ...patch }));

  const projectOptions: SelectOption[] = [{ value: "", label: "Unassigned" }, ...(projects.data ?? []).map((project) => ({ value: project.id, label: project.name }))];
  const sessionOptions: SelectOption[] = [{ value: "", label: "No session" }, ...(sessions.data ?? []).map((session) => ({ value: session.id, label: session.title }))];

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.target.trim()) {
      setError({ field: "target", message: "Describe what changed." });
      return;
    }
    if (!form.beforeValue && !form.afterValue) {
      setError({ field: "values", message: "Enter the value before or after the change (or both)." });
      return;
    }
    setSaving(true);
    setError(null);
    const input: ChangeInput = {
      target: form.target.trim(),
      summary: form.summary,
      projectId: form.projectId || null,
      sessionId: form.sessionId || null,
      occurredAt: form.occurredAt ? new Date(form.occurredAt).toISOString() : null,
      environment: form.environment,
      platform: form.platform,
      version: form.version,
      beforeValue: form.beforeValue || null,
      afterValue: form.afterValue || null,
    };
    try {
      onSaved(change ? await api.changes.update(change.id, input) : await api.changes.declare(input));
    } catch (raw) {
      const failure = toApiError(raw);
      setError({ field: failure.field, message: failure.message });
      setSaving(false);
    }
  };

  const fieldError = (field: string) => (error?.field === field ? error.message : undefined);

  return (
    <Dialog
      open
      size="md"
      onClose={onClose}
      dismissible={!saving}
      title={change ? "Edit declared change" : "Record a change"}
      description="A recorded change is declared: it states what you changed. Approve it after review, and mark it verified only with a note on how you checked the outcome."
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={saving}>
            {change ? "Save changes" : "Record change"}
          </Button>
        </>
      }
    >
      {error && !["target", "values"].includes(error.field ?? "") && (
        <Notice tone="danger" role="alert" title="The change could not be saved">
          {error.message}
        </Notice>
      )}
      <TextField
        label="What changed"
        placeholder="e.g. /etc/ssh/sshd_config: PermitRootLogin"
        value={form.target}
        maxLength={300}
        error={fieldError("target")}
        onChange={(event) => set({ target: event.target.value })}
      />
      <TextArea label="Summary" optional rows={2} maxLength={2000} value={form.summary} onChange={(event) => set({ summary: event.target.value })} />
      <Select label="Project" options={projectOptions} value={form.projectId} onChange={(event) => set({ projectId: event.target.value })} />
      <Select label="Session (evidence)" options={sessionOptions} value={form.sessionId} onChange={(event) => set({ sessionId: event.target.value })} />
      <TextField
        label="When"
        type="datetime-local"
        optional
        hint="Leave empty to use the current time."
        value={form.occurredAt}
        error={fieldError("occurredAt")}
        onChange={(event) => set({ occurredAt: event.target.value })}
      />
      <TextField label="Environment" optional maxLength={60} value={form.environment} onChange={(event) => set({ environment: event.target.value })} />
      <TextField label="Platform" optional maxLength={120} value={form.platform} onChange={(event) => set({ platform: event.target.value })} />
      <TextField label="Version" optional maxLength={60} value={form.version} onChange={(event) => set({ version: event.target.value })} />
      <TextArea
        label="Value before"
        optional
        rows={4}
        spellCheck={false}
        className="mono"
        value={form.beforeValue}
        error={fieldError("values")}
        onChange={(event) => set({ beforeValue: event.target.value })}
      />
      <TextArea label="Value after" optional rows={4} spellCheck={false} className="mono" value={form.afterValue} onChange={(event) => set({ afterValue: event.target.value })} />
    </Dialog>
  );
}
