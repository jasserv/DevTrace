/**
 * Client-side validation mirroring src-tauri/src/validate.rs for instant feedback.
 * The backend remains authoritative and re-validates everything.
 */

export interface TextRule {
  label: string;
  maxChars: number;
  required: boolean;
  multiline: boolean;
}

// eslint-disable-next-line no-control-regex
const CONTROL_EXCEPT_WHITESPACE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
const LINE_BREAKS_OR_TABS = /[\n\r\t]/;

function check(rule: TextRule, normalized: string): string | null {
  if (!normalized) return rule.required ? `${rule.label} is required.` : null;
  if ([...normalized].length > rule.maxChars) return `${rule.label} must be ${rule.maxChars} characters or fewer.`;
  if (!rule.multiline && LINE_BREAKS_OR_TABS.test(normalized)) {
    return `${rule.label} must be a single line without control characters.`;
  }
  if (CONTROL_EXCEPT_WHITESPACE.test(normalized)) {
    return rule.multiline
      ? `${rule.label} contains unsupported control characters.`
      : `${rule.label} must be a single line without control characters.`;
  }
  return null;
}

/** Returns an error message, or null when the value is valid. */
export function validateText(rule: TextRule, value: string): string | null {
  return check(rule, value.trim());
}

/**
 * Normalizes preformatted text (commands, notes) the way the backend stores it: leading blank
 * lines and trailing whitespace are removed; indentation is preserved.
 */
export function normalizePreformatted(value: string): string {
  const trimmedEnd = value.trimEnd();
  const lines = trimmedEnd.split("\n");
  let start = 0;
  while (start < lines.length - 1 && lines[start]!.trim() === "") start += 1;
  const rest = lines.slice(start).join("\n");
  return rest.trim() === "" ? "" : rest;
}

export function validatePreformatted(rule: TextRule, value: string): string | null {
  return check(rule, normalizePreformatted(value));
}

export const PROJECT_NAME_RULE: TextRule = { label: "Project name", maxChars: 120, required: true, multiline: false };
export const PROJECT_DESCRIPTION_RULE: TextRule = { label: "Description", maxChars: 2000, required: false, multiline: true };
export const WORKSPACE_NAME_RULE: TextRule = { label: "Workspace name", maxChars: 60, required: true, multiline: false };
export const AUTHOR_NAME_RULE: TextRule = { label: "Author name", maxChars: 80, required: false, multiline: false };

export const SESSION_TITLE_RULE: TextRule = { label: "Session title", maxChars: 200, required: true, multiline: false };
export const SESSION_APPLICATION_RULE: TextRule = { label: "Application or platform", maxChars: 120, required: false, multiline: false };
export const SESSION_ENVIRONMENT_RULE: TextRule = { label: "Environment", maxChars: 60, required: false, multiline: false };
export const SESSION_NOTES_RULE: TextRule = { label: "Notes", maxChars: 20000, required: false, multiline: true };

export const EVENT_TITLE_RULE: TextRule = { label: "Title", maxChars: 200, required: true, multiline: false };
export const EVENT_DESCRIPTION_RULE: TextRule = { label: "Description", maxChars: 10000, required: false, multiline: true };
export const EVENT_NOTES_RULE: TextRule = { label: "Notes", maxChars: 10000, required: false, multiline: true };
export const EVENT_CODE_RULE: TextRule = { label: "Command", maxChars: 20000, required: true, multiline: true };

/** Mirrors storage.rs; the backend also checks the file content, not just its size. */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
