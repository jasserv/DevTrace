import { cx } from "../lib/cx";
import styles from "./Primitives.module.css";

export function Spinner({ size = 14, label }: { size?: number; label?: string }) {
  return (
    <span
      className={styles.spinner}
      style={{ width: size, height: size }}
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}

export function Kbd({ children, onDark = false }: { children: string; onDark?: boolean }) {
  return <kbd className={cx(styles.kbd, onDark && styles.kbdOnDark)}>{children}</kbd>;
}
