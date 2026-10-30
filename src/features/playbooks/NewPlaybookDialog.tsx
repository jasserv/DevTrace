import { useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";

import { Button, Dialog, Notice, SegmentedControl, Select, TextField, type SelectOption } from "../../components";
import { api, toApiError } from "../../lib/api";
import { useResource } from "../../lib/hooks";

type Mode = "session" | "blank";

interface NewPlaybookDialogProps {
  open: boolean;
  onClose: () => void;
  /** Preselects a session (for example when opened from a session page). */
  sessionId?: string;
}

/**
 * Creates a playbook either from the approved steps of a session (evidence is copied) or as an
 * empty draft, then opens it in the editor.
 */
export function NewPlaybookDialog({ open, onClose, sessionId }: NewPlaybookDialogProps) {
  const navigate = useNavigate();
  const sessions = useResource(api.sessions.list);
  const [mode, setMode] = useState<Mode>("session");
  const [chosen, setChosen] = useState(sessionId ?? "");
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const options: SelectOption[] = useMemo(
    () => [
      { value: "", label: "Choose a session" },
      ...(sessions.data ?? []).filter((session) => session.eventCount > 0).map((session) => ({ value: session.id, label: session.title })),
    ],
    [sessions.data],
  );

  const close = () => {
    if (busy) return;
    setError(null);
    onClose();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (mode === "session" && !chosen) {
      setError("Choose the session to create the playbook from.");
      return;
    }
    if (mode === "blank" && !title.trim()) {
      setError("Playbook title is required.");
      return;
    }
    setBusy(true);
    try {
      const created =
        mode === "session"
          ? await api.playbooks.createFromSession(chosen)
          : await api.playbooks.create({
              title: title.trim(),
              summary: "",
              projectId: null,
              platform: "",
              product: "",
              productVersion: "",
              environment: "",
              taskType: "",
              author: "",
            });
      setBusy(false);
      onClose();
      navigate(`/playbooks/${created.id}`);
    } catch (raw) {
      setError(toApiError(raw).message);
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="New playbook"
      dismissible={!busy}
      footer={
        <>
          <Button onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="new-playbook-form" loading={busy}>
            Create playbook
          </Button>
        </>
      }
    >
      <form id="new-playbook-form" onSubmit={submit} noValidate style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
        <SegmentedControl<Mode>
          label="Start from"
          value={mode}
          onChange={(next) => {
            setMode(next);
            setError(null);
          }}
          options={[
            { value: "session", label: "Reviewed session" },
            { value: "blank", label: "Blank" },
          ]}
        />
        {mode === "session" ? (
          <>
            <Select label="Session" options={options} value={chosen} onChange={(change) => setChosen(change.target.value)} />
            <p style={{ color: "var(--color-text-secondary)", fontSize: "var(--text-sm)" }}>
              Each approved step becomes a numbered step with its description, command and screenshots. Rejected, excluded and pending steps
              are left out. Purpose, verification and the other sections start empty for you to write.
            </p>
          </>
        ) : (
          <TextField label="Title" value={title} maxLength={200} autoFocus onChange={(change) => setTitle(change.target.value)} />
        )}
        {error && (
          <Notice tone="danger" role="alert" title="The playbook could not be created">
            {error}
          </Notice>
        )}
      </form>
    </Dialog>
  );
}
