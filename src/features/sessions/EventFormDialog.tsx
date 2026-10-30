import { useState, type FormEvent, type KeyboardEvent } from "react";

import { Button, Dialog, Notice, TextArea, TextField } from "../../components";
import { api, toApiError, type EventInput, type EventType, type SessionEvent } from "../../lib/api";
import { isMac } from "../../lib/platform";
import {
  EVENT_CODE_RULE,
  EVENT_DESCRIPTION_RULE,
  EVENT_NOTES_RULE,
  EVENT_TITLE_RULE,
  normalizePreformatted,
  validatePreformatted,
  validateText,
} from "../../lib/validation";
import { eventTypes, type ManualEventType } from "./eventTypes";
import styles from "./SessionPage.module.css";

export type EventFormMode = { kind: "create"; eventType: ManualEventType } | { kind: "edit"; event: SessionEvent };

interface EventFormDialogProps {
  sessionId: string;
  mode: EventFormMode;
  onClose: () => void;
  onSaved: (event: SessionEvent, created: boolean) => void;
}

type FieldName = "title" | "code" | "description" | "notes";
type FormErrors = Partial<Record<FieldName | "form", string>>;

const FIELDS: readonly string[] = ["title", "code", "description", "notes"];

const DESCRIPTION_PLACEHOLDER: Record<EventType, string> = {
  step: "What was done, where, and why",
  note: "Details",
  command: "What the command does and the output to expect",
  screenshot: "What the screenshot shows",
  log: "What this output shows",
  change: "Why the file changed",
};

/** Ctrl+Enter (Command+Enter on macOS) submits from a multi-line field. */
function submitOnModEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
  const mod = isMac ? event.metaKey : event.ctrlKey;
  if (mod && event.key === "Enter") {
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }
}

/** Add or edit a step, note or command. Mount only while open. Input survives failures. */
export function EventFormDialog({ sessionId, mode, onClose, onSaved }: EventFormDialogProps) {
  const existing = mode.kind === "edit" ? mode.event : null;
  const eventType: EventType = mode.kind === "edit" ? mode.event.eventType : mode.eventType;
  const info = eventTypes[eventType];
  const isCommand = eventType === "command";
  /** Recorded terminal output and file changes keep their monospaced text when edited. */
  const hasCode = isCommand || eventType === "log" || eventType === "change";

  const [title, setTitle] = useState(existing?.title ?? "");
  const [code, setCode] = useState(existing?.code ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [errors, setErrors] = useState<FormErrors>({});
  const [saving, setSaving] = useState(false);

  const clearError = (field: FieldName) => {
    if (errors[field]) setErrors((current) => ({ ...current, [field]: undefined }));
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const found: FormErrors = {
      title: validateText(EVENT_TITLE_RULE, title) ?? undefined,
      code: isCommand ? (validatePreformatted(EVENT_CODE_RULE, code) ?? undefined) : undefined,
      description: validatePreformatted(EVENT_DESCRIPTION_RULE, description) ?? undefined,
      notes: validatePreformatted(EVENT_NOTES_RULE, notes) ?? undefined,
    };
    if (Object.values(found).some(Boolean)) {
      setErrors(found);
      requestAnimationFrame(() => form.querySelector<HTMLElement>("[aria-invalid=true]")?.focus());
      return;
    }

    setSaving(true);
    setErrors({});
    const input: EventInput = {
      title: title.trim(),
      code: hasCode ? normalizePreformatted(code) : "",
      description: normalizePreformatted(description),
      notes: normalizePreformatted(notes),
    };
    try {
      const saved =
        mode.kind === "edit"
          ? await api.events.update(mode.event.id, input)
          : await api.events.create(sessionId, mode.eventType, input);
      onSaved(saved, mode.kind === "create");
    } catch (raw) {
      const error = toApiError(raw);
      if (error.field && FIELDS.includes(error.field)) setErrors({ [error.field]: error.message });
      else setErrors({ form: error.message });
      setSaving(false);
    }
  };

  const noun = eventType === "screenshot" ? "screenshot step" : info.label.toLowerCase();
  const dialogTitle = mode.kind === "edit" ? `Edit ${noun}` : `Add ${noun}`;
  const dialogDescription = isCommand
    ? "Commands are stored as text for documentation. DevTrace never runs them."
    : mode.kind === "create"
      ? `${info.description}. It is added to the end of the timeline.`
      : undefined;

  return (
    <Dialog
      open
      size="md"
      onClose={onClose}
      dismissible={!saving}
      title={dialogTitle}
      description={dialogDescription}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={saving}>
            {mode.kind === "edit" ? "Save changes" : dialogTitle}
          </Button>
        </>
      }
    >
      {errors.form && (
        <Notice tone="danger" role="alert" title="The step could not be saved">
          {errors.form}
        </Notice>
      )}
      <TextField
        label="Title"
        name="title"
        placeholder={info.placeholder}
        value={title}
        maxLength={EVENT_TITLE_RULE.maxChars}
        showCounter
        error={errors.title}
        autoComplete="off"
        onChange={(event) => {
          setTitle(event.target.value);
          clearError("title");
        }}
      />
      {hasCode && (
        <TextArea
          label={isCommand ? "Command" : eventType === "log" ? "Recorded output" : "Changed lines"}
          name="code"
          rows={5}
          className={styles.codeInput}
          placeholder="e.g. show ntp status"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          value={code}
          maxLength={EVENT_CODE_RULE.maxChars}
          error={errors.code}
          hint={isCommand ? "Indentation is preserved. Do not include passwords or secrets." : "Recorded text; indentation is preserved."}
          onKeyDown={submitOnModEnter}
          onChange={(event) => {
            setCode(event.target.value);
            clearError("code");
          }}
        />
      )}
      <TextArea
        label="Description"
        name="description"
        optional
        rows={isCommand ? 2 : 3}
        placeholder={DESCRIPTION_PLACEHOLDER[eventType]}
        value={description}
        maxLength={EVENT_DESCRIPTION_RULE.maxChars}
        error={errors.description}
        onKeyDown={submitOnModEnter}
        onChange={(event) => {
          setDescription(event.target.value);
          clearError("description");
        }}
      />
      <TextArea
        label="Notes"
        name="notes"
        optional
        rows={2}
        placeholder="Caveats, follow-ups or remarks for reviewers"
        value={notes}
        maxLength={EVENT_NOTES_RULE.maxChars}
        error={errors.notes}
        onKeyDown={submitOnModEnter}
        onChange={(event) => {
          setNotes(event.target.value);
          clearError("notes");
        }}
      />
    </Dialog>
  );
}
