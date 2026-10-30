import { getCurrentWindow } from "@tauri-apps/api/window";

import { hasDesktopRuntime } from "./api";
import type { ThemePreference } from "./api";

/** True on macOS, where shortcuts use the Command key. */
export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

/** Human-readable modifier label for shortcut hints. */
export const modKeyLabel = isMac ? "\u2318" : "Ctrl";

const isWindows = typeof navigator !== "undefined" && /Windows/.test(navigator.userAgent);

/** Platform wording for "open the containing folder". */
export const revealLabel = isMac ? "Reveal in Finder" : isWindows ? "Show in File Explorer" : "Show in file manager";

export function formatShortcut(key: string, options: { shift?: boolean; alt?: boolean } = {}): string {
  const parts = [modKeyLabel];
  if (options.alt) parts.push(isMac ? "\u2325" : "Alt");
  if (options.shift) parts.push(isMac ? "\u21e7" : "Shift");
  parts.push(key);
  return isMac ? parts.join("") : parts.join("+");
}

/** Shows the main window (it starts hidden to avoid a flash of the wrong theme). */
export async function revealWindow(): Promise<void> {
  if (!hasDesktopRuntime()) return;
  try {
    const window = getCurrentWindow();
    await window.show();
    await window.setFocus();
  } catch (error) {
    console.error("Could not show the window", error);
  }
}

/** Keeps the native title bar in sync with the app theme. `system` follows the OS. */
export async function syncNativeTheme(preference: ThemePreference): Promise<void> {
  if (!hasDesktopRuntime()) return;
  try {
    await getCurrentWindow().setTheme(preference === "system" ? null : preference);
  } catch (error) {
    console.error("Could not update the window theme", error);
  }
}
