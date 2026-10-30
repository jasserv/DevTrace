import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { hasDesktopRuntime } from "./api";

/** Names of events the Rust backend broadcasts to the webview. */
export const BACKEND_EVENTS = {
  captureStatus: "capture-status",
  captureCaptured: "capture-captured",
  /** A terminal log started, recorded steps or stopped (`TerminalLogStatus`). */
  terminalLog: "terminal-log",
  /** A watched file started, recorded a change or stopped (`FileWatchStatus`). */
  fileWatch: "file-watch",
} as const;

/**
 * In-app channel for the same events. Command results are published here as soon as they
 * arrive, so every subscriber updates immediately and the app also works without the desktop
 * runtime (tests, plain browser), where backend events never arrive.
 */
const local = new EventTarget();

/** Delivers `payload` to every `listenBackend` subscriber of `event` in this window. */
export function publishLocal<T>(event: string, payload: T): void {
  local.dispatchEvent(new CustomEvent<T>(event, { detail: payload }));
}

/**
 * Subscribes to a backend event (and its local publications). Returns an unsubscribe function.
 * Safe outside the desktop runtime: only local publications are delivered then.
 */
export function listenBackend<T>(event: string, handler: (payload: T) => void): () => void {
  const onLocal = (message: Event) => handler((message as CustomEvent<T>).detail);
  local.addEventListener(event, onLocal);
  let disposed = false;
  let unlisten: UnlistenFn | null = null;
  if (hasDesktopRuntime()) {
    listen<T>(event, (message) => handler(message.payload))
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((error: unknown) => console.error(`Could not subscribe to ${event}`, error));
  }
  return () => {
    disposed = true;
    local.removeEventListener(event, onLocal);
    unlisten?.();
  };
}
