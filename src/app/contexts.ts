import { createContext, useContext } from "react";

import type { ApiError, AppInfo, AppSettings, CapturedShot, CaptureStatus, SettingsPatch } from "../lib/api";
import type { Resource } from "../lib/hooks";

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "system",
  reduceMotion: false,
  sidebarCollapsed: false,
  workspaceName: "Local Workspace",
  authorName: "",
  captureShortcut: "Ctrl+Alt+Shift+S",
};

export interface SettingsContextValue {
  settings: AppSettings;
  /** True once settings were read from the database (or the read failed). */
  loaded: boolean;
  error: ApiError | null;
  resolvedTheme: "light" | "dark";
  /** Persists a change. Appearance changes apply immediately; failures revert and throw. */
  update: (patch: SettingsPatch) => Promise<AppSettings>;
}

export const SettingsContext = createContext<SettingsContextValue | null>(null);

export function useSettings(): SettingsContextValue {
  const context = useContext(SettingsContext);
  if (!context) throw new Error("useSettings must be used inside <SettingsProvider>");
  return context;
}

export const AppInfoContext = createContext<Resource<AppInfo> | null>(null);

export function useAppInfo(): Resource<AppInfo> {
  const context = useContext(AppInfoContext);
  if (!context) throw new Error("useAppInfo must be used inside <AppInfoProvider>");
  return context;
}

export const IDLE_CAPTURE: CaptureStatus = {
  state: "idle",
  sessionId: null,
  sessionTitle: null,
  target: null,
  startedAt: null,
  captureCount: 0,
  lastCaptureAt: null,
  shortcut: "",
  shortcutActive: false,
  shortcutError: null,
  supported: true,
  unsupportedReason: null,
  lastError: null,
  autoCapture: false,
};

export interface CaptureContextValue {
  /** Live capture state from the backend (`capture-status` events). */
  status: CaptureStatus;
  /** Applies a status returned by a capture command immediately, everywhere in the app. */
  setStatus: (status: CaptureStatus) => void;
  /** Announces a screenshot returned by Capture now, like a `capture-captured` event. */
  reportShot: (shot: CapturedShot) => void;
  /** Reloads the status from the backend. */
  refresh: () => void;
}

export const CaptureContext = createContext<CaptureContextValue | null>(null);

export function useCapture(): CaptureContextValue {
  const context = useContext(CaptureContext);
  if (!context) throw new Error("useCapture must be used inside <CaptureProvider>");
  return context;
}
