import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CircleAlert, CircleCheck, Info, X } from "lucide-react";

import { cx } from "../lib/cx";
import { Icon } from "./Icon";
import styles from "./Toast.module.css";
import { ToastContext, type ToastApi, type ToastInput, type ToastTone } from "./toastContext";

interface ToastItem extends ToastInput {
  id: number;
}

const DURATION: Record<ToastTone, number> = { success: 4000, info: 5000, error: 9000 };
const ICONS = { success: CircleCheck, info: Info, error: CircleAlert };
const MAX_VISIBLE = 4;

/** Transient confirmations and errors. Errors stay longer and are announced assertively. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    window.clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((items) => items.filter((item) => item.id !== id));
  }, []);

  const show = useCallback(
    (toast: ToastInput) => {
      const id = nextId.current++;
      setToasts((items) => [...items.slice(-(MAX_VISIBLE - 1)), { ...toast, id }]);
      timers.current.set(
        id,
        window.setTimeout(() => dismiss(id), DURATION[toast.tone]),
      );
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((timer) => window.clearTimeout(timer));
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      show,
      success: (title, description) => show({ tone: "success", title, description }),
      error: (title, description) => show({ tone: "error", title, description }),
      info: (title, description) => show({ tone: "info", title, description }),
    }),
    [show],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <section className={styles.viewport} aria-label="Notifications">
        <div aria-live="polite" className={styles.stack}>
          {toasts
            .filter((toast) => toast.tone !== "error")
            .map((toast) => (
              <Toast key={toast.id} toast={toast} onDismiss={dismiss} />
            ))}
        </div>
        <div aria-live="assertive" className={styles.stack}>
          {toasts
            .filter((toast) => toast.tone === "error")
            .map((toast) => (
              <Toast key={toast.id} toast={toast} onDismiss={dismiss} />
            ))}
        </div>
      </section>
    </ToastContext.Provider>
  );
}

function Toast({ toast, onDismiss }: { toast: ToastItem; onDismiss: (id: number) => void }) {
  return (
    <div className={cx(styles.toast, styles[toast.tone])} role={toast.tone === "error" ? "alert" : "status"}>
      <Icon icon={ICONS[toast.tone]} size={16} className={styles.icon} />
      <div className={styles.text}>
        <span className={styles.title}>{toast.title}</span>
        {toast.description && <span className={styles.description}>{toast.description}</span>}
      </div>
      <button type="button" className={styles.close} aria-label="Dismiss notification" onClick={() => onDismiss(toast.id)}>
        <Icon icon={X} size={13} />
      </button>
    </div>
  );
}
