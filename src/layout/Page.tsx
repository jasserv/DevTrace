import type { ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { ChevronLeft, ChevronRight, PanelLeft } from "lucide-react";

import { Icon, IconButton } from "../components";
import { cx } from "../lib/cx";
import { formatShortcut } from "../lib/platform";
import styles from "./Page.module.css";
import { useShell } from "./shellContext";

export interface Crumb {
  label: string;
  to: string;
}

interface PageProps {
  /** Page heading, shown as the last breadcrumb. */
  title: string;
  breadcrumbs?: Crumb[];
  /** Contextual actions on the right of the toolbar. */
  actions?: ReactNode;
  /** Optional right-hand inspector. */
  inspector?: ReactNode;
  /** "scroll": the page scrolls; "fill": children manage their own panes (Capture). */
  layout?: "scroll" | "fill";
  children: ReactNode;
}

/** History index maintained by React Router in `history.state`. */
function historyIndex(): number {
  const state = window.history.state as { idx?: unknown } | null;
  return typeof state?.idx === "number" ? state.idx : 0;
}

export function Page({ title, breadcrumbs = [], actions, inspector, layout = "scroll", children }: PageProps) {
  const navigate = useNavigate();
  useLocation(); // re-render on navigation so back/forward availability stays current
  const { sidebarCollapsed, sidebarForced, toggleSidebar } = useShell();
  const index = historyIndex();
  const canGoBack = index > 0;
  const canGoForward = index < window.history.length - 1;

  return (
    <div className={styles.page}>
      <header className={styles.toolbar}>
        <div className={styles.navButtons}>
          <IconButton
            icon={PanelLeft}
            label={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
            shortcut={formatShortcut("\\")}
            onClick={toggleSidebar}
            disabledReason={sidebarForced ? "The window is too narrow for the full sidebar." : undefined}
          />
          <span className={styles.separator} aria-hidden="true" />
          <IconButton
            icon={ChevronLeft}
            label="Back"
            onClick={() => navigate(-1)}
            disabledReason={canGoBack ? undefined : "There is no previous page."}
          />
          <IconButton
            icon={ChevronRight}
            label="Forward"
            onClick={() => navigate(1)}
            disabledReason={canGoForward ? undefined : "There is no next page."}
          />
        </div>
        <nav aria-label="Breadcrumb" className={styles.breadcrumbs}>
          <ol className={styles.crumbs}>
            {breadcrumbs.map((crumb) => (
              <li key={crumb.to} className={styles.crumb}>
                <Link to={crumb.to}>{crumb.label}</Link>
                <Icon icon={ChevronRight} size={12} className={styles.crumbSeparator} />
              </li>
            ))}
            <li className={styles.crumb} aria-current="page">
              <h1 className={styles.title}>{title}</h1>
            </li>
          </ol>
        </nav>
        {actions && <div className={styles.actions}>{actions}</div>}
      </header>
      <div className={styles.body}>
        <main id="main-content" tabIndex={-1} className={cx(styles.main, layout === "fill" && styles.fill)}>
          {children}
        </main>
        {inspector}
      </div>
    </div>
  );
}

interface SectionProps {
  title: string;
  count?: number;
  action?: { label: string; to: string };
  children: ReactNode;
  className?: string;
}

/** Titled content section separated by a divider (no card container). */
export function Section({ title, count, action, children, className }: SectionProps) {
  const headingId = `section-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <section className={cx(styles.section, className)} aria-labelledby={headingId}>
      <div className={styles.sectionHeader}>
        <h2 id={headingId} className={styles.sectionTitle}>
          {title}
        </h2>
        {count !== undefined && <span className={styles.sectionCount}>{count}</span>}
        {action && (
          <Link to={action.to} className={styles.sectionAction}>
            {action.label}
            <Icon icon={ChevronRight} size={12} />
          </Link>
        )}
      </div>
      {children}
    </section>
  );
}
