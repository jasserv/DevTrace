import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { api, toApiError, type ApiError, type AppSettings, type CapturedShot, type CaptureStatus, type SettingsPatch } from "../lib/api";
import { BACKEND_EVENTS, listenBackend, publishLocal } from "../lib/events";
import { useMediaQuery, useResource } from "../lib/hooks";
import { syncNativeTheme } from "../lib/platform";
import {
  AppInfoContext,
  CaptureContext,
  DEFAULT_SETTINGS,
  IDLE_CAPTURE,
  SettingsContext,
  type CaptureContextValue,
  type SettingsContextValue,
} from "./contexts";

/** localStorage key read by public/boot-theme.js before React starts. */
export const APPEARANCE_CACHE_KEY = "devtrace.appearance";

function readCachedAppearance(): Partial<AppSettings> {
  try {
    const cached = JSON.parse(localStorage.getItem(APPEARANCE_CACHE_KEY) ?? "{}") as Partial<AppSettings>;
    const result: Partial<AppSettings> = {};
    if (cached.theme === "light" || cached.theme === "dark" || cached.theme === "system") result.theme = cached.theme;
    if (typeof cached.reduceMotion === "boolean") result.reduceMotion = cached.reduceMotion;
    if (typeof cached.sidebarCollapsed === "boolean") result.sidebarCollapsed = cached.sidebarCollapsed;
    return result;
  } catch {
    return {};
  }
}

/**
 * Loads settings from SQLite (the source of truth), applies theme and motion preferences to
 * the document and the native window, and refreshes the boot cache.
 */
export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(() => ({ ...DEFAULT_SETTINGS, ...readCachedAppearance() }));
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const systemDark = useMediaQuery("(prefers-color-scheme: dark)");
  const resolvedTheme = settings.theme === "system" ? (systemDark ? "dark" : "light") : settings.theme;

  useEffect(() => {
    let active = true;
    api.settings.get().then(
      (value) => {
        if (!active) return;
        setSettings(value);
        setLoaded(true);
      },
      (raw: unknown) => {
        if (!active) return;
        setError(toApiError(raw));
        setLoaded(true);
      },
    );
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = resolvedTheme;
    if (settings.reduceMotion) root.dataset.reduceMotion = "true";
    else delete root.dataset.reduceMotion;
  }, [resolvedTheme, settings.reduceMotion]);

  useEffect(() => {
    try {
      localStorage.setItem(
        APPEARANCE_CACHE_KEY,
        JSON.stringify({
          theme: settings.theme,
          reduceMotion: settings.reduceMotion,
          sidebarCollapsed: settings.sidebarCollapsed,
        }),
      );
    } catch {
      // Storage unavailable: the app still works, it may briefly show the default theme at startup.
    }
  }, [settings.theme, settings.reduceMotion, settings.sidebarCollapsed]);

  useEffect(() => {
    void syncNativeTheme(settings.theme);
  }, [settings.theme]);

  const update = useCallback(async (patch: SettingsPatch) => {
    setSettings((current) => ({ ...current, ...patch }));
    try {
      const saved = await api.settings.update(patch);
      setSettings(saved);
      return saved;
    } catch (raw) {
      const failure = toApiError(raw);
      try {
        setSettings(await api.settings.get());
      } catch {
        // Keep the current state if the database cannot be read either.
      }
      throw failure;
    }
  }, []);

  const value = useMemo<SettingsContextValue>(
    () => ({ settings, loaded, error, resolvedTheme, update }),
    [settings, loaded, error, resolvedTheme, update],
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

/** Loads application and workspace diagnostics once. */
export function AppInfoProvider({ children }: { children: ReactNode }) {
  const info = useResource(api.app.info);
  return <AppInfoContext.Provider value={info}>{children}</AppInfoContext.Provider>;
}

/**
 * Keeps the live capture state available everywhere (sidebar indicator, Capture page, session
 * workspace). The backend broadcasts every change, including ones triggered by the global
 * shortcut or the tray menu while DevTrace is in the background.
 */
export function CaptureProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<CaptureStatus>(IDLE_CAPTURE);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let active = true;
    api.capture.status().then(
      (value) => {
        if (active) setStatus(value);
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [version]);

  // Backend events and local publications (command results) arrive through the same channel.
  useEffect(() => listenBackend<CaptureStatus>(BACKEND_EVENTS.captureStatus, setStatus), []);

  const publishStatus = useCallback((next: CaptureStatus) => publishLocal(BACKEND_EVENTS.captureStatus, next), []);
  const reportShot = useCallback((shot: CapturedShot) => publishLocal(BACKEND_EVENTS.captureCaptured, shot), []);
  const refresh = useCallback(() => setVersion((value) => value + 1), []);
  const value = useMemo<CaptureContextValue>(
    () => ({ status, setStatus: publishStatus, reportShot, refresh }),
    [status, publishStatus, reportShot, refresh],
  );
  return <CaptureContext.Provider value={value}>{children}</CaptureContext.Provider>;
}
