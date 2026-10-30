import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { type ApiError, toApiError } from "./api";
import { isMac } from "./platform";

export interface Resource<T> {
  data: T | undefined;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
}

interface ResourceState<T> {
  data: T | undefined;
  error: ApiError | null;
  loading: boolean;
}

/**
 * Loads data from the backend. `fetcher` must be referentially stable (a module-level API
 * function or a memoized callback). Previous data stays visible while reloading.
 */
export function useResource<T>(fetcher: () => Promise<T>): Resource<T> {
  const [state, setState] = useState<ResourceState<T>>({ data: undefined, error: null, loading: true });
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let active = true;
    fetcher().then(
      (data) => {
        if (active) setState({ data, error: null, loading: false });
      },
      (error: unknown) => {
        if (active) setState((previous) => ({ data: previous.data, error: toApiError(error), loading: false }));
      },
    );
    return () => {
      active = false;
    };
  }, [fetcher, version]);

  const reload = useCallback(() => {
    setState((previous) => ({ ...previous, loading: true }));
    setVersion((value) => value + 1);
  }, []);

  return { ...state, reload };
}

/** Subscribes to a CSS media query. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

export interface Hotkey {
  /** `event.key` (case-insensitive) or a digit "1".."9". */
  key: string;
  /** Requires Ctrl (Windows/Linux) or Command (macOS). */
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
  handler: (event: KeyboardEvent) => void;
}

/** Registers global keyboard shortcuts for the lifetime of the component. */
export function useHotkeys(hotkeys: Hotkey[]): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing) return;
      const mod = isMac ? event.metaKey : event.ctrlKey;
      for (const hotkey of hotkeys) {
        if (Boolean(hotkey.mod) !== mod) continue;
        if (Boolean(hotkey.shift) !== event.shiftKey) continue;
        if (Boolean(hotkey.alt) !== event.altKey) continue;
        const digit = /^[0-9]$/.test(hotkey.key);
        const matches = digit ? event.code === `Digit${hotkey.key}` : event.key.toLowerCase() === hotkey.key.toLowerCase();
        if (matches) {
          event.preventDefault();
          hotkey.handler(event);
          return;
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [hotkeys]);
}

export type SaveState = "idle" | "saving" | "saved" | "error";

export interface Autosave {
  /** "saving" whenever the current value differs from the last saved value. */
  state: SaveState;
  error: ApiError | null;
  /** Server timestamp of the last successful save. */
  savedAt: string | null;
  /** Saves now if there are unsaved changes (for example when a field loses focus). */
  flush: () => void;
  /** Saves now and resolves true once everything is saved, false if saving failed. */
  saveNow: () => Promise<boolean>;
}

interface AutosaveOptions {
  delay?: number;
  /** Called when a save that finishes after unmount fails, so the failure is not silent. */
  onBackgroundError?: (error: ApiError) => void;
}

interface AutosaveBox {
  saved: string;
  latest: string;
  saving: boolean;
  mounted: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  save: (value: string) => Promise<string>;
  onBackgroundError?: (error: ApiError) => void;
}

/**
 * Saves a text value automatically: `delay` ms after the last change, immediately on `flush()`
 * and when the component unmounts. Saves never overlap; changes made during a save are saved
 * right after it. `save` resolves with the server's timestamp. `initial` is the stored value.
 */
export function useAutosave(
  value: string,
  initial: string,
  save: (value: string) => Promise<string>,
  { delay = 800, onBackgroundError }: AutosaveOptions = {},
): Autosave {
  const [status, setStatus] = useState<{ saved: string; error: ApiError | null; savedAt: string | null; failed: boolean }>({
    saved: initial,
    error: null,
    savedAt: null,
    failed: false,
  });
  const box = useRef<AutosaveBox>({ saved: initial, latest: initial, saving: false, mounted: true, timer: null, save, onBackgroundError });

  useEffect(() => {
    box.current.save = save;
    box.current.onBackgroundError = onBackgroundError;
  }, [save, onBackgroundError]);

  const persist = useCallback(async (): Promise<boolean> => {
    const current = box.current;
    if (current.timer !== null) {
      clearTimeout(current.timer);
      current.timer = null;
    }
    if (current.saving) {
      // The running save picks up newer changes when it finishes; wait for it.
      while (current.saving) await new Promise((resolve) => setTimeout(resolve, 20));
      return current.latest === current.saved;
    }
    current.saving = true;
    try {
      while (current.latest !== current.saved) {
        const target = current.latest;
        const savedAt = await current.save(target);
        current.saved = target;
        if (current.mounted) setStatus({ saved: target, error: null, savedAt, failed: false });
      }
      return true;
    } catch (raw) {
      const error = toApiError(raw);
      if (current.mounted) setStatus((previous) => ({ ...previous, error, failed: true }));
      else current.onBackgroundError?.(error);
      return false;
    } finally {
      current.saving = false;
    }
  }, []);

  useEffect(() => {
    const current = box.current;
    current.latest = value;
    if (current.timer !== null) clearTimeout(current.timer);
    current.timer = value === current.saved ? null : setTimeout(() => void persist(), delay);
  }, [value, delay, persist]);

  useEffect(() => {
    const current = box.current;
    current.mounted = true;
    return () => {
      current.mounted = false;
      if (current.latest !== current.saved) void persist();
    };
  }, [persist]);

  const dirty = value !== status.saved;
  const state: SaveState = status.failed && dirty ? "error" : dirty ? "saving" : status.savedAt ? "saved" : "idle";
  return { state, error: state === "error" ? status.error : null, savedAt: status.savedAt, flush: () => void persist(), saveNow: persist };
}
