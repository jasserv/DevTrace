import { useState, type FormEvent } from "react";

import { Button, Dialog, Notice, TextArea, TextField } from "../../components";
import { api, toApiError, type Project } from "../../lib/api";
import { PROJECT_DESCRIPTION_RULE, PROJECT_NAME_RULE, validateText } from "../../lib/validation";

interface ProjectFormDialogProps {
  /** Existing project to edit; omit to create a new one. */
  project?: Project;
  onClose: () => void;
  onSaved: (project: Project) => void;
}

interface FormErrors {
  name?: string;
  description?: string;
  form?: string;
}

/**
 * Create or edit a project. Mount it only while open: each mount starts with fresh state.
 * Input is preserved when validation or saving fails.
 */
export function ProjectFormDialog({ project, onClose, onSaved }: ProjectFormDialogProps) {
  const editing = Boolean(project);
  const [name, setName] = useState(project?.name ?? "");
  const [description, setDescription] = useState(project?.description ?? "");
  const [errors, setErrors] = useState<FormErrors>({});
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const nameError = validateText(PROJECT_NAME_RULE, name);
    const descriptionError = validateText(PROJECT_DESCRIPTION_RULE, description);
    if (nameError || descriptionError) {
      setErrors({ name: nameError ?? undefined, description: descriptionError ?? undefined });
      form.querySelector<HTMLElement>("[aria-invalid=true]")?.focus();
      return;
    }

    setSaving(true);
    setErrors({});
    try {
      const input = { name: name.trim(), description: description.trim() };
      const saved = project ? await api.projects.update(project.id, input) : await api.projects.create(input);
      onSaved(saved);
    } catch (raw) {
      const error = toApiError(raw);
      if (error.field === "name" || error.field === "description") setErrors({ [error.field]: error.message });
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
      title={editing ? "Edit project" : "New project"}
      description="Projects group related capture sessions, playbooks, attachments and changes."
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={saving}>
            {editing ? "Save changes" : "Create project"}
          </Button>
        </>
      }
    >
      {errors.form && (
        <Notice tone="danger" role="alert" title="The project could not be saved">
          {errors.form}
        </Notice>
      )}
      <TextField
        label="Name"
        name="name"
        placeholder="e.g. Branch firewall migration"
        value={name}
        maxLength={PROJECT_NAME_RULE.maxChars}
        showCounter
        error={errors.name}
        autoComplete="off"
        onChange={(event) => {
          setName(event.target.value);
          if (errors.name) setErrors((current) => ({ ...current, name: undefined }));
        }}
      />
      <TextArea
        label="Description"
        name="description"
        optional
        rows={4}
        placeholder="Systems, environment, customer or goal"
        value={description}
        maxLength={PROJECT_DESCRIPTION_RULE.maxChars}
        showCounter
        error={errors.description}
        onChange={(event) => {
          setDescription(event.target.value);
          if (errors.description) setErrors((current) => ({ ...current, description: undefined }));
        }}
      />
    </Dialog>
  );
}
