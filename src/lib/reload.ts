/**
 * Reloads the interface so every screen reads the workspace again (after a backup was restored).
 * In its own module so tests can replace it.
 */
export function reloadApp(): void {
  window.location.reload();
}

const RESTORED_KEY = "devtrace.restored";

/** Remembers, across the reload, where the replaced data was kept. */
export function rememberRestore(previousData: string): void {
  try {
    sessionStorage.setItem(RESTORED_KEY, previousData);
  } catch {
    // Storage unavailable: the notice is skipped, the restore itself succeeded.
  }
}

/** Returns (once) the folder remembered by `rememberRestore`. */
export function takeRestoreNotice(): string | null {
  try {
    const value = sessionStorage.getItem(RESTORED_KEY);
    sessionStorage.removeItem(RESTORED_KEY);
    return value;
  } catch {
    return null;
  }
}
