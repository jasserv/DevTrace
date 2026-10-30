import { createContext, useContext } from "react";

export interface ShellContextValue {
  /** Effective state (user preference, or forced on narrow windows). */
  sidebarCollapsed: boolean;
  /** True when the window is too narrow for the expanded sidebar. */
  sidebarForced: boolean;
  toggleSidebar: () => void;
}

export const ShellContext = createContext<ShellContextValue | null>(null);

export function useShell(): ShellContextValue {
  const context = useContext(ShellContext);
  if (!context) throw new Error("useShell must be used inside <AppShell>");
  return context;
}
