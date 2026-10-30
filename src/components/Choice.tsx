import { useRef, type KeyboardEvent } from "react";

import styles from "./Choice.module.css";
import { Icon, type LucideIcon } from "./Icon";
import { tabId, tabPanelId } from "./utils";

export interface ChoiceOption<T extends string> {
  value: T;
  label: string;
  icon?: LucideIcon;
  count?: number;
}

function nextIndex(key: string, current: number, length: number): number | null {
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return (current + 1) % length;
    case "ArrowLeft":
    case "ArrowUp":
      return (current - 1 + length) % length;
    case "Home":
      return 0;
    case "End":
      return length - 1;
    default:
      return null;
  }
}

interface SegmentedControlProps<T extends string> {
  label: string;
  options: ChoiceOption<T>[];
  value: T;
  onChange: (value: T) => void;
}

/** Single choice among a few options (radiogroup with roving focus). */
export function SegmentedControl<T extends string>({ label, options, value, onChange }: SegmentedControlProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );

  const onKeyDown = (event: KeyboardEvent) => {
    const index = nextIndex(event.key, selectedIndex, options.length);
    if (index === null) return;
    event.preventDefault();
    const option = options[index];
    if (option) {
      onChange(option.value);
      refs.current[index]?.focus();
    }
  };

  return (
    <div role="radiogroup" aria-label={label} className={styles.segmented} onKeyDown={onKeyDown}>
      {options.map((option, index) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            ref={(element) => {
              refs.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            className={styles.segment}
            onClick={() => onChange(option.value)}
          >
            {option.icon && <Icon icon={option.icon} size={14} />}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

interface TabsProps<T extends string> {
  label: string;
  /** Prefix for tab/panel ids; panels should use `tabPanelId(idPrefix, value)`. */
  idPrefix: string;
  options: ChoiceOption<T>[];
  value: T;
  onChange: (value: T) => void;
}

/** Tabs with automatic activation and arrow-key navigation. */
export function Tabs<T extends string>({ label, idPrefix, options, value, onChange }: TabsProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") return;
    const index = nextIndex(event.key, selectedIndex, options.length);
    if (index === null) return;
    event.preventDefault();
    const option = options[index];
    if (option) {
      onChange(option.value);
      refs.current[index]?.focus();
    }
  };

  return (
    <div role="tablist" aria-label={label} className={styles.tabs} onKeyDown={onKeyDown}>
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            ref={(element) => {
              refs.current[index] = element;
            }}
            id={tabId(idPrefix, option.value)}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={tabPanelId(idPrefix, option.value)}
            tabIndex={selected ? 0 : -1}
            className={styles.tab}
            onClick={() => onChange(option.value)}
          >
            {option.icon && <Icon icon={option.icon} size={14} />}
            {option.label}
            {option.count !== undefined && <span className={styles.count}>{option.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
