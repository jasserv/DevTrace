import { useRef, type KeyboardEvent, type ReactNode } from "react";

import { cx } from "../lib/cx";
import { formatTime } from "../lib/format";
import type { StatusDescriptor } from "../lib/status";
import { StatusBadge } from "./Feedback";
import { Icon, type LucideIcon } from "./Icon";
import styles from "./Timeline.module.css";

export interface TimelineEvent {
  id: string;
  occurredAt: string;
  title: string;
  typeLabel: string;
  icon: LucideIcon;
  /** Extra metadata shown after the type label, for example "2 images". */
  detail?: string;
  status?: StatusDescriptor;
  /** Shown dimmed: not used for documentation (pair with a `status` that says why). */
  excluded?: boolean;
}

interface TimelineProps {
  label: string;
  events: TimelineEvent[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  /** Enter or double-click on an event (for example to edit it). */
  onActivate?: (id: string) => void;
  /**
   * Extra key handling for the focused event (for example review shortcuts). Call
   * `preventDefault()` to skip the built-in navigation for that key.
   */
  onItemKeyDown?: (keyboardEvent: KeyboardEvent<HTMLLIElement>, id: string) => void;
  /** Rendered when there are no events. */
  empty?: ReactNode;
}

/** Chronological event list (listbox) with arrow-key navigation. */
export function Timeline({ label, events, selectedId, onSelect, onActivate, onItemKeyDown, empty }: TimelineProps) {
  const listRef = useRef<HTMLUListElement>(null);

  if (events.length === 0) return <>{empty}</>;

  const focusIndex = Math.max(
    0,
    events.findIndex((event) => event.id === selectedId),
  );

  const onKeyDown = (keyboardEvent: KeyboardEvent<HTMLLIElement>, index: number) => {
    const current = events[index];
    if (current && onItemKeyDown) {
      onItemKeyDown(keyboardEvent, current.id);
      if (keyboardEvent.defaultPrevented) return;
    }
    if (keyboardEvent.key === "Enter" && onActivate) {
      keyboardEvent.preventDefault();
      if (current) onActivate(current.id);
      return;
    }
    let next: number | null = null;
    if (keyboardEvent.key === "ArrowDown") next = Math.min(events.length - 1, index + 1);
    else if (keyboardEvent.key === "ArrowUp") next = Math.max(0, index - 1);
    else if (keyboardEvent.key === "Home") next = 0;
    else if (keyboardEvent.key === "End") next = events.length - 1;
    if (next === null) return;
    keyboardEvent.preventDefault();
    const target = events[next];
    if (!target) return;
    onSelect?.(target.id);
    listRef.current?.querySelectorAll<HTMLLIElement>("[role=option]")[next]?.focus();
  };

  return (
    <ul ref={listRef} role="listbox" aria-label={label} className={styles.timeline}>
      {events.map((event, index) => {
        const selected = event.id === selectedId;
        return (
          <li
            key={event.id}
            role="option"
            aria-selected={selected}
            tabIndex={index === focusIndex ? 0 : -1}
            className={cx(styles.item, event.excluded && styles.excluded)}
            onClick={() => onSelect?.(event.id)}
            onDoubleClick={() => onActivate?.(event.id)}
            onKeyDown={(keyboardEvent) => onKeyDown(keyboardEvent, index)}
          >
            <span className={styles.node}>
              <Icon icon={event.icon} size={13} />
            </span>
            <span className={styles.content}>
              <span className={styles.title}>{event.title}</span>
              <span className={styles.meta}>
                <time className={styles.time} dateTime={event.occurredAt}>
                  {formatTime(event.occurredAt)}
                </time>
                <span aria-hidden="true">·</span>
                <span>{event.typeLabel}</span>
                {event.detail && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>{event.detail}</span>
                  </>
                )}
              </span>
              {event.status && (
                <span>
                  <StatusBadge status={event.status} plain />
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
