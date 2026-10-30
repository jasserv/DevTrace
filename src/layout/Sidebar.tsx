import { NavLink } from "react-router";

import { useCapture } from "../app/contexts";
import { Icon, Tooltip } from "../components";
import { availability } from "../lib/availability";
import { cx } from "../lib/cx";
import { pluralize } from "../lib/format";
import { formatShortcut } from "../lib/platform";
import { NAV_GROUPS, NAV_ITEMS, type NavItem } from "./navigation";
import styles from "./Sidebar.module.css";
import { WorkspaceSelector } from "./WorkspaceSelector";

/** Original DevTrace mark: a traced path through captured steps, ending at the current step. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg className={cx(styles.mark, className)} viewBox="0 0 32 32" aria-hidden="true">
      <rect className={styles.markBg} width="32" height="32" rx="7" />
      <path
        className={styles.markFg}
        d="M8 21.5 L14 12.5 L19 18 L24.5 10.5"
        fill="none"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle className={styles.markFg} cx="8" cy="21.5" r="2.4" />
      <circle className={styles.markFg} cx="14" cy="12.5" r="2.4" />
      <circle className={styles.markAccent} cx="24.5" cy="10.5" r="2.8" />
    </svg>
  );
}

function SidebarLink({ item, collapsed }: { item: NavItem; collapsed: boolean }) {
  return (
    <Tooltip content={item.label} shortcut={formatShortcut(item.shortcutKey)} placement="right">
      <NavLink
        to={item.path}
        className={({ isActive }) => cx(styles.link, isActive && styles.active)}
        aria-label={collapsed ? item.label : undefined}
      >
        <Icon icon={item.icon} size={16} className={styles.linkIcon} />
        {!collapsed && <span className={styles.linkLabel}>{item.label}</span>}
      </NavLink>
    </Tooltip>
  );
}

/** Always-visible capture status, updated live from the backend. */
function CaptureStatus({ collapsed }: { collapsed: boolean }) {
  const { status } = useCapture();
  const count = pluralize(status.captureCount, "screenshot");
  const target = status.target?.title ?? "";
  const label =
    status.state === "recording" ? `Recording \u00b7 ${status.captureCount}` : status.state === "paused" ? `Paused \u00b7 ${status.captureCount}` : "Not recording";
  const detail =
    status.state === "recording"
      ? `Capturing ${target}. ${count} so far.${status.shortcutActive ? ` Press ${status.shortcut} to capture.` : ""}`
      : status.state === "paused"
        ? `Paused: nothing is captured. ${count} so far.`
        : status.supported
          ? "Nothing is being captured. Start a capture from the Capture workspace."
          : (status.unsupportedReason ?? availability.capture.reason);
  const spoken = status.state === "recording" ? "Recording" : status.state === "paused" ? "Paused" : "Not recording";
  return (
    <Tooltip
      placement="right"
      content={
        <>
          <strong>{spoken}</strong>
          <span>{detail}</span>
        </>
      }
    >
      <NavLink
        to="/capture"
        className={cx(styles.capture, status.state === "recording" && styles.recording, status.state === "paused" && styles.paused)}
        aria-label={`Capture status: ${label}. ${detail}`}
      >
        <span className={styles.captureDot} aria-hidden="true" />
        {!collapsed && <span className={styles.captureLabel}>{label}</span>}
      </NavLink>
    </Tooltip>
  );
}

export function Sidebar({ collapsed }: { collapsed: boolean }) {
  const settingsItem = NAV_ITEMS.find((item) => item.group === "system");
  return (
    <nav className={cx(styles.sidebar, collapsed && styles.collapsed)} aria-label="Main">
      <div className={styles.brand}>
        <BrandMark />
        {!collapsed && <span className={styles.wordmark}>DevTrace</span>}
      </div>
      <WorkspaceSelector collapsed={collapsed} />
      <div className={styles.scroll}>
        {NAV_GROUPS.map((group) => (
          <div key={group.id} className={styles.group} role="group" aria-labelledby={`nav-group-${group.id}`}>
            <div id={`nav-group-${group.id}`} className={collapsed ? "visually-hidden" : styles.groupLabel}>
              {group.label}
            </div>
            <ul className={styles.list}>
              {NAV_ITEMS.filter((item) => item.group === group.id).map((item) => (
                <li key={item.id}>
                  <SidebarLink item={item} collapsed={collapsed} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className={styles.footer}>
        <CaptureStatus collapsed={collapsed} />
        {settingsItem && <SidebarLink item={settingsItem} collapsed={collapsed} />}
      </div>
    </nav>
  );
}
