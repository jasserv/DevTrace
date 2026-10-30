import type { ReactNode } from "react";
import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";

import { cx } from "../lib/cx";
import type { StatusDescriptor, Tone } from "../lib/status";
import styles from "./Feedback.module.css";
import { Icon, type LucideIcon } from "./Icon";

interface StatusBadgeProps {
  status: StatusDescriptor;
  /** Plain renders icon + text without the tinted background (dense tables). */
  plain?: boolean;
  /** Show the status description as a native tooltip. */
  showDescription?: boolean;
}

/** Status indicator that never relies on color alone: icon + text label. */
export function StatusBadge({ status, plain = false, showDescription = true }: StatusBadgeProps) {
  return (
    <span
      className={cx(styles.badge, styles[status.tone], plain && styles.plain)}
      title={showDescription ? status.description : undefined}
    >
      <Icon icon={status.icon} size={13} className={styles.icon} />
      {status.label}
    </span>
  );
}

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  /** Compact: left-aligned, no icon tile; for sections inside a page. */
  compact?: boolean;
  headingLevel?: 2 | 3;
}

/** Explains why something is empty and what the user can do next. */
export function EmptyState({ icon, title, description, actions, compact = false, headingLevel = 2 }: EmptyStateProps) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <div className={cx(styles.empty, compact && styles.emptyCompact)}>
      <span className={styles.emptyIcon}>
        <Icon icon={icon} size={18} />
      </span>
      <Heading className={styles.emptyTitle}>{title}</Heading>
      {description && <p className={styles.emptyDescription}>{description}</p>}
      {actions && <div className={styles.emptyActions}>{actions}</div>}
    </div>
  );
}

const NOTICE_ICONS: Record<Tone, LucideIcon> = {
  neutral: Info,
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  danger: CircleAlert,
};

interface NoticeProps {
  tone?: Tone;
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
  icon?: LucideIcon;
  className?: string;
  /** Use "alert" only for errors that need immediate attention. */
  role?: "status" | "alert" | "note";
}

/** Inline message for limitations, warnings and errors. */
export function Notice({ tone = "info", title, children, action, icon, className, role = "note" }: NoticeProps) {
  return (
    <div className={cx(styles.notice, styles[tone], className)} role={role}>
      <Icon icon={icon ?? NOTICE_ICONS[tone]} size={16} />
      <div className={styles.noticeBody}>
        {title && <span className={styles.noticeTitle}>{title}</span>}
        {children && <span className={styles.noticeText}>{children}</span>}
      </div>
      {action && <div className={styles.noticeAction}>{action}</div>}
    </div>
  );
}
