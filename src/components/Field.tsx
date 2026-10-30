import {
  useId,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { ChevronDown, CircleAlert, Search, X } from "lucide-react";

import { cx } from "../lib/cx";
import styles from "./Field.module.css";
import { Icon } from "./Icon";

interface FieldChromeProps {
  label: string;
  /** Keeps the label for assistive technology but hides it visually. */
  labelHidden?: boolean;
  hint?: ReactNode;
  error?: string | null;
  optional?: boolean;
  counter?: { value: number; max: number };
}

interface FieldProps extends FieldChromeProps {
  id: string;
  hintId: string;
  errorId: string;
  children: ReactNode;
}

/** Label, hint, character counter and error message around a control. */
export function Field({ id, hintId, errorId, label, labelHidden, hint, error, optional, counter, children }: FieldProps) {
  return (
    <div className={styles.field}>
      <div className={labelHidden ? "visually-hidden" : styles.labelRow}>
        <label htmlFor={id} className={styles.label}>
          {label}
          {optional && <span className={styles.optional}>Optional</span>}
        </label>
        {counter && (
          <span className={styles.counter} aria-hidden="true">
            {counter.value}/{counter.max}
          </span>
        )}
      </div>
      {children}
      {hint && !error && (
        <p id={hintId} className={styles.hint}>
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className={styles.error} role="alert">
          <Icon icon={CircleAlert} size={13} />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}

function useFieldIds(explicitId?: string) {
  const generated = useId();
  const id = explicitId ?? generated;
  return { id, hintId: `${id}-hint`, errorId: `${id}-error` };
}

function describedBy(hint: ReactNode, error: string | null | undefined, ids: { hintId: string; errorId: string }) {
  if (error) return ids.errorId;
  if (hint) return ids.hintId;
  return undefined;
}

export interface TextFieldProps extends FieldChromeProps, Omit<InputHTMLAttributes<HTMLInputElement>, "children"> {
  ref?: Ref<HTMLInputElement>;
  showCounter?: boolean;
}

export function TextField({ label, labelHidden, hint, error, optional, showCounter, id, className, ref, ...input }: TextFieldProps) {
  const ids = useFieldIds(id);
  const value = typeof input.value === "string" ? input.value : "";
  const counter = showCounter && input.maxLength ? { value: [...value].length, max: input.maxLength } : undefined;
  return (
    <Field {...ids} label={label} labelHidden={labelHidden} hint={hint} error={error} optional={optional} counter={counter}>
      <input
        {...input}
        ref={ref}
        id={ids.id}
        className={cx(styles.control, className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(hint, error, ids)}
      />
    </Field>
  );
}

export interface TextAreaProps extends FieldChromeProps, Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "children"> {
  ref?: Ref<HTMLTextAreaElement>;
  showCounter?: boolean;
}

export function TextArea({ label, labelHidden, hint, error, optional, showCounter, id, className, ref, ...textarea }: TextAreaProps) {
  const ids = useFieldIds(id);
  const value = typeof textarea.value === "string" ? textarea.value : "";
  const counter = showCounter && textarea.maxLength ? { value: [...value].length, max: textarea.maxLength } : undefined;
  return (
    <Field {...ids} label={label} labelHidden={labelHidden} hint={hint} error={error} optional={optional} counter={counter}>
      <textarea
        {...textarea}
        ref={ref}
        id={ids.id}
        className={cx(styles.control, styles.textarea, className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(hint, error, ids)}
      />
    </Field>
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "children" | "size"> {
  options: SelectOption[];
  /** Visible label. When omitted, provide `aria-label` (for compact filter bars). */
  label?: string;
  hint?: ReactNode;
  size?: "sm" | "md";
}

/** Native select (fully keyboard accessible) with consistent styling. */
export function Select({ options, label, hint, size = "md", id, className, ...select }: SelectProps) {
  const ids = useFieldIds(id);
  const control = (
    <span className={styles.selectWrap}>
      <select
        {...select}
        id={ids.id}
        className={cx(styles.control, styles.select, size === "sm" && styles.selectSm, className)}
        aria-describedby={hint ? ids.hintId : undefined}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <Icon icon={ChevronDown} size={14} className={styles.selectIcon} />
    </span>
  );
  if (!label) return control;
  return (
    <Field {...ids} label={label} hint={hint}>
      {control}
    </Field>
  );
}

export interface SearchFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value" | "type"> {
  value: string;
  onValueChange: (value: string) => void;
  /** Accessible name, e.g. "Search sessions". */
  label: string;
  ref?: Ref<HTMLInputElement>;
}

/** Search input with a clear button. Escape clears the query. */
export function SearchField({ value, onValueChange, label, className, ref, onKeyDown, ...input }: SearchFieldProps) {
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && value) {
      event.preventDefault();
      event.stopPropagation();
      onValueChange("");
    }
    onKeyDown?.(event);
  };
  return (
    <div className={cx(styles.search, className)}>
      <Icon icon={Search} size={14} className={styles.searchIcon} />
      <input
        {...input}
        ref={ref}
        type="search"
        aria-label={label}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={handleKeyDown}
        className={cx(styles.control, styles.searchInput)}
        spellCheck={false}
        autoComplete="off"
      />
      {value && (
        <button type="button" className={styles.clear} aria-label="Clear search" onClick={() => onValueChange("")}>
          <Icon icon={X} size={13} />
        </button>
      )}
    </div>
  );
}

export interface SwitchProps {
  label: string;
  description?: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}

/** Toggle with label and optional description. Uses role="switch". */
export function Switch({ label, description, checked, onCheckedChange, disabled }: SwitchProps) {
  const id = useId();
  return (
    <div className={styles.switchRow}>
      <div className={styles.switchText}>
        <span id={`${id}-label`} className={styles.label}>
          {label}
        </span>
        {description && (
          <span id={`${id}-description`} className={styles.hint}>
            {description}
          </span>
        )}
      </div>
      <button
        type="button"
        role="switch"
        className={styles.switch}
        aria-checked={checked}
        aria-labelledby={`${id}-label`}
        aria-describedby={description ? `${id}-description` : undefined}
        disabled={disabled}
        onClick={() => onCheckedChange(!checked)}
      />
    </div>
  );
}
