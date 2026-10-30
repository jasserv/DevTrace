import { useCallback, useMemo, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";

import { useToast } from "../components";
import { useSettings } from "../app/contexts";
import { cx } from "../lib/cx";
import { useHotkeys, useMediaQuery, type Hotkey } from "../lib/hooks";
import styles from "./AppShell.module.css";
import { NAV_ITEMS, navItemForPath } from "./navigation";
import { ShellContext, type ShellContextValue } from "./shellContext";
import { Sidebar } from "./Sidebar";

/** Windows narrower than this always use the icon-only sidebar. */
const NARROW_QUERY = "(max-width: 1100px)";

export function AppShell({ children }: { children: ReactNode }) {
  const { settings, update } = useSettings();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const narrow = useMediaQuery(NARROW_QUERY);
  const collapsed = narrow || settings.sidebarCollapsed;

  const toggleSidebar = useCallback(() => {
    if (narrow) return;
    update({ sidebarCollapsed: !settings.sidebarCollapsed }).catch((error: Error) =>
      toast.error("Could not save the sidebar preference", error.message),
    );
  }, [narrow, settings.sidebarCollapsed, update, toast]);

  const hotkeys = useMemo<Hotkey[]>(
    () => [
      ...NAV_ITEMS.map((item) => ({ key: item.shortcutKey, mod: true, handler: () => navigate(item.path) })),
      { key: ",", mod: true, handler: () => navigate("/settings") },
      { key: "\\", mod: true, handler: toggleSidebar },
    ],
    [navigate, toggleSidebar],
  );
  useHotkeys(hotkeys);

  const shell = useMemo<ShellContextValue>(
    () => ({ sidebarCollapsed: collapsed, sidebarForced: narrow, toggleSidebar }),
    [collapsed, narrow, toggleSidebar],
  );

  const current = navItemForPath(location.pathname);

  const skipToContent = () => {
    document.getElementById("main-content")?.focus();
  };

  return (
    <ShellContext.Provider value={shell}>
      <div className={cx(styles.shell, collapsed && styles.collapsed)}>
        <button type="button" className={styles.skipLink} onClick={skipToContent}>
          Skip to content
        </button>
        <Sidebar collapsed={collapsed} />
        <div className={styles.main}>{children}</div>
      </div>
      {/* Announces page changes to screen readers. */}
      <div className="visually-hidden" aria-live="polite" aria-atomic="true">
        {current ? `${current.label} page` : ""}
      </div>
    </ShellContext.Provider>
  );
}
