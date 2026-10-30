import { useId, useState, type FormEvent } from "react";

import { Button, Dialog, Notice, Select, TextArea, TextField, type SelectOption } from "../../components";
import { api, toApiError, type SessionDetail, type SessionInput } from "../../lib/api";
import { useResource } from "../../lib/hooks";
import {
  SESSION_APPLICATION_RULE,
  SESSION_ENVIRONMENT_RULE,
  SESSION_NOTES_RULE,
  SESSION_TITLE_RULE,
  normalizePreformatted,
  validatePreformatted,
  validateText,
} from "../../lib/validation";

const NO_PROJECT = "";
const ENVIRONMENT_SUGGESTIONS = ["Production", "Staging", "Test", "Lab", "Development"];

interface SessionFormDialogProps {
  /** Existing session to edit; omit to create a new one. */
  session?: SessionDetail;
  /** Project preselected when creating (for example from a project's page). */
  defaultProjectId?: string | null;
  onClose: () => void;
  onSaved: (session: SessionDetail) => void;
}

type FieldName = "title" | "projectId" | "application" | "environment" | "notes";
type FormErrors = Partial<Record<FieldName | "form", string>>;

const FIELDS: readonly string[] = ["title", "projectId", "application", "environment", "notes"];

/**
 * Create a session or edit its details. Mount it only while open so each mount starts fresh.
 * Input is preserved when validation or saving fails.
 */
export function SessionFormDialog({ session, defaultProjectId, onClose, onSaved }: SessionFormDialogProps) {
  const editing = Boolean(session);
  const projects = useResource(api.projects.list);
  const environmentListId = useId();
  const [title, setTitle] = useState(session?.title ?? "");
  const [projectId, setProjectId] = useState(session ? (session.projectId ?? NO_PROJECT) : (defaultProjectId ?? NO_PROJECT));
  const [application, setApplication] = useState(session?.application ?? "");
  const [environment, setEnvironment] = useState(session?.environment ?? "");
  const [notes, setNotes] = useState("");
  const [errors, setErrors] = useState<FormErrors>({});
  const [saving, setSaving] = useState(false);

  const projectOptions: SelectOption[] = [{ value: NO_PROJECT, label: "No project" }];
  for (const project of projects.data ?? []) projectOptions.push({ value: project.id, label: project.name });
  // Keep the current project visible while the list is loading.
  if (projectId && !projects.data && session?.projectName) projectOptions.push({ value: projectId, label: session.projectName });

  const clearError = (field: FieldName) => {
    if (errors[field]) setErrors((current) => ({ ...current, [field]: undefined }));
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const found: FormErrors = {
      title: validateText(SESSION_TITLE_RULE, title) ?? undefined,
      application: validateText(SESSION_APPLICATION_RULE, application) ?? undefined,
      environment: validateText(SESSION_ENVIRONMENT_RULE, environment) ?? undefined,
      notes: editing ? undefined : (validatePreformatted(SESSION_NOTES_RULE, notes) ?? undefined),
    };
    if (Object.values(found).some(Boolean)) {
      setErrors(found);
      requestAnimationFrame(() => form.querySelector<HTMLElement>("[aria-invalid=true]")?.focus());
      return;
    }

    setSaving(true);
    setErrors({});
    const input: SessionInput = {
      title: title.trim(),
      projectId: projectId || null,
      application: application.trim(),
      environment: environment.trim(),
    };
    try {
      const saved = session
        ? await api.sessions.update(session.id, input)
        : await api.sessions.create(input, normalizePreformatted(notes));
      onSaved(saved);
    } catch (raw) {
      const error = toApiError(raw);
      if (error.field && FIELDS.includes(error.field)) setErrors({ [error.field]: error.message });
      else setErrors({ form: error.message });
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      size="md"
      onClose={onClose}
      dismissible={!saving}
      title={editing ? "Edit session details" : "New session"}
      description={
        editing
          ? "Rename the session or change its project, application and environment."
          : "A session documents one technical task. Add steps, notes, commands and screenshots as you work."
      }
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={saving}>
            {editing ? "Save changes" : "Create session"}
          </Button>
        </>
      }
    >
      {errors.form && (
        <Notice tone="danger" role="alert" title="The session could not be saved">
          {errors.form}
        </Notice>
      )}
      <TextField
        label="Title"
        name="title"
        placeholder="e.g. Configure NTP on the branch firewall"
        value={title}
        maxLength={SESSION_TITLE_RULE.maxChars}
        showCounter
        error={errors.title}
        autoComplete="off"
        onChange={(event) => {
          setTitle(event.target.value);
          clearError("title");
        }}
      />
      <Select
        label="Project"
        options={projectOptions}
        value={projectId}
        hint={projects.error ? "Projects could not be loaded." : undefined}
        onChange={(event) => {
          setProjectId(event.target.value);
          clearError("projectId");
        }}
      />
      {errors.projectId && (
        <Notice tone="danger" role="alert">
          {errors.projectId}
        </Notice>
      )}
      <TextField
        label="Application or platform"
        name="application"
        optional
        placeholder="e.g. FortiGate 7.4, Windows Server 2022, AWS Console"
        value={application}
        maxLength={SESSION_APPLICATION_RULE.maxChars}
        error={errors.application}
        autoComplete="off"
        onChange={(event) => {
          setApplication(event.target.value);
          clearError("application");
        }}
      />
      <TextField
        label="Environment"
        name="environment"
        optional
        placeholder="e.g. Production, Lab"
        list={environmentListId}
        value={environment}
        maxLength={SESSION_ENVIRONMENT_RULE.maxChars}
        error={errors.environment}
        autoComplete="off"
        onChange={(event) => {
          setEnvironment(event.target.value);
          clearError("environment");
        }}
      />
      <datalist id={environmentListId}>
        {ENVIRONMENT_SUGGESTIONS.map((value) => (
          <option key={value} value={value} />
        ))}
      </datalist>
      {!editing && (
        <TextArea
          label="Notes"
          name="notes"
          optional
          rows={3}
          placeholder="Goal, scope, ticket or change number"
          value={notes}
          maxLength={SESSION_NOTES_RULE.maxChars}
          error={errors.notes}
          onChange={(event) => {
            setNotes(event.target.value);
            clearError("notes");
          }}
        />
      )}
    </Dialog>
  );
}
