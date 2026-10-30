import type { ReactNode } from "react";
import { X } from "lucide-react";

import { cx } from "../lib/cx";
import { IconButton } from "./Button";
import styles from "./Inspector.module.css";

interface InspectorProps {
  /** Accessible name of the panel. */
  label: string;
  eyebrow?: string;
  /** Title row content; ignored when `header` is provided. */
  title?: ReactNode;
  /** Replaces the default title row, for example with tabs. */
  header?: ReactNode;
  onClose?: () => void;
  actions?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** Contextual right-hand panel. Appears only when there is something to inspect. */
export function Inspector({ label, eyebrow, title, header, onClose, actions, footer, children, className }: InspectorProps) {
  return (
    <aside className={cx(styles.inspector, className)} aria-label={label}>
      {header ?? (
        <header className={styles.header}>
          <div className={styles.titles}>
            {eyebrow && <span className={styles.eyebrow}>{eyebrow}</span>}
            <h2 className={styles.title}>{title}</h2>
          </div>
          {actions}
          {onClose && <IconButton icon={X} label="Close inspector" size="sm" onClick={onClose} />}
        </header>
      )}
      <div className={styles.body}>{children}</div>
      {footer && <footer className={styles.footer}>{footer}</footer>}
    </aside>
  );
}

export function InspectorSection({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className={styles.section}>
      {title && <h3 className={styles.sectionTitle}>{title}</h3>}
      {children}
    </section>
  );
}

export interface Property {
  label: string;
  value: ReactNode;
  mono?: boolean;
}

/** Key/value metadata as a definition list. Empty values render as an em dash. */
export function PropertyList({ items }: { items: Property[] }) {
  return (
    <dl className={styles.properties}>
      {items.map((item) => {
        const empty = item.value === null || item.value === undefined || item.value === "";
        return (
          <div key={item.label} style={{ display: "contents" }}>
            <dt>{item.label}</dt>
            <dd className={cx(item.mono && styles.propertyMono, empty && styles.muted)}>{empty ? "\u2014" : item.value}</dd>
          </div>
        );
      })}
    </dl>
  );
}
