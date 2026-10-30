import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

import { toApiError } from "../lib/api";
import { cx } from "../lib/cx";
import { Button } from "./Button";
import { Notice } from "./Feedback";
import styles from "./Overlay.module.css";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md";
  /** When false, Escape does not close the dialog (e.g. while saving). */
  dismissible?: boolean;
  /** Renders body and footer inside a form so Enter submits. */
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
}

/**
 * Modal dialog built on the native <dialog> element: focus is trapped, the rest of the app is
 * inert, and Escape closes it. Content mounts only while open, so forms start fresh.
 * Clicking the backdrop does not close it, to protect unsaved input.
 */
export function Dialog({ open, onClose, title, description, children, footer, size = "sm", dismissible = true, onSubmit }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // When the dialog is unmounted while open (conditional rendering), close it first so the
  // browser restores focus to the element that opened it. Layout cleanups run before removal.
  useLayoutEffect(() => {
    const dialog = ref.current;
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);

  const content = (
    <>
      <div className={styles.body}>{children}</div>
      {footer && <footer className={styles.footer}>{footer}</footer>}
    </>
  );

  return (
    <dialog
      ref={ref}
      className={cx(styles.dialog, size === "md" && styles.md)}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => {
        event.preventDefault();
        if (dismissible) onClose();
      }}
    >
      {open && (
        <div className={styles.inner}>
          <header className={styles.header}>
            <h2 id={titleId} className={styles.title}>
              {title}
            </h2>
            {description && (
              <p id={descriptionId} className={styles.description}>
                {description}
              </p>
            )}
          </header>
          {onSubmit ? (
            <form className={styles.inner} onSubmit={onSubmit} noValidate>
              {content}
            </form>
          ) : (
            content
          )}
        </div>
      )}
    </dialog>
  );
}

interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  tone?: "danger" | "default";
  /** May return a promise; the dialog stays open and shows the error if it rejects. */
  onConfirm: () => Promise<void> | void;
}

/** Confirmation for consequential actions. Destructive confirmations focus Cancel first. */
export function ConfirmDialog({ open, onClose, title, children, confirmLabel, tone = "default", onConfirm }: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    if (busy) return;
    setError(null);
    onClose();
  };

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      setBusy(false);
      onClose();
    } catch (raw) {
      setError(toApiError(raw).message);
      setBusy(false);
    }
  };

  // Cancel comes first in DOM order, so the native dialog focuses it on open (safe default).
  return (
    <Dialog
      open={open}
      onClose={close}
      title={title}
      dismissible={!busy}
      footer={
        <>
          <Button onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button variant={tone === "danger" ? "danger" : "primary"} onClick={confirm} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className={styles.message}>{children}</div>
      {error && (
        <Notice tone="danger" role="alert" title="The action could not be completed">
          {error}
        </Notice>
      )}
    </Dialog>
  );
}
