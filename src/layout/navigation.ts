import {
  Aperture,
  FileDiff,
  Folders,
  LayoutDashboard,
  Library,
  ListVideo,
  NotebookText,
  Settings,
  type LucideIcon,
} from "lucide-react";

export type NavGroup = "workflow" | "documentation" | "organization" | "system";

export interface NavItem {
  id: string;
  path: string;
  label: string;
  icon: LucideIcon;
  /** Digit used with Ctrl/Command for navigation. */
  shortcutKey: string;
  group: NavGroup;
}

/** Primary navigation, in the order defined by the product specification. */
export const NAV_ITEMS: NavItem[] = [
  { id: "overview", path: "/overview", label: "Overview", icon: LayoutDashboard, shortcutKey: "1", group: "workflow" },
  { id: "capture", path: "/capture", label: "Capture", icon: Aperture, shortcutKey: "2", group: "workflow" },
  { id: "sessions", path: "/sessions", label: "Sessions", icon: ListVideo, shortcutKey: "3", group: "workflow" },
  { id: "playbooks", path: "/playbooks", label: "Playbooks", icon: NotebookText, shortcutKey: "4", group: "documentation" },
  { id: "changes", path: "/changes", label: "Change History", icon: FileDiff, shortcutKey: "5", group: "documentation" },
  { id: "library", path: "/library", label: "Knowledge Library", icon: Library, shortcutKey: "6", group: "documentation" },
  { id: "projects", path: "/projects", label: "Projects", icon: Folders, shortcutKey: "7", group: "organization" },
  { id: "settings", path: "/settings", label: "Settings", icon: Settings, shortcutKey: "8", group: "system" },
];

export const NAV_GROUPS: Array<{ id: Exclude<NavGroup, "system">; label: string }> = [
  { id: "workflow", label: "Workflow" },
  { id: "documentation", label: "Documentation" },
  { id: "organization", label: "Organization" },
];

export function navItemForPath(pathname: string): NavItem | undefined {
  return NAV_ITEMS.find((item) => pathname === item.path || pathname.startsWith(`${item.path}/`));
}
