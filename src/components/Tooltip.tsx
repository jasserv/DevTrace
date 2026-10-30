import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { Kbd } from "./Primitives";
import styles from "./Tooltip.module.css";

export type TooltipPlacement = "bottom" | "top" | "right";

interface TooltipProps {
  content: ReactNode;
  shortcut?: string;
  placement?: TooltipPlacement;
  /** A single element that receives hover/focus. */
  children: ReactElement<{ "aria-describedby"?: string }>;
}

const SHOW_DELAY_HOVER = 450;
const SHOW_DELAY_FOCUS = 150;
const GAP = 6;
const MARGIN = 8;

/**
 * Lightweight tooltip shown on hover or keyboard focus. Rendered in a portal with fixed
 * positioning so it is never clipped by scroll containers.
 */
export function Tooltip({ content, shortcut, placement = "bottom", children }: TooltipProps) {
  const id = useId();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const [open, setOpen] = useState(false);

  const clearTimer = () => window.clearTimeout(timer.current);
  const show = (delay: number) => {
    clearTimer();
    timer.current = window.setTimeout(() => setOpen(true), delay);
  };
  const hide = () => {
    clearTimer();
    setOpen(false);
  };

  useEffect(() => () => window.clearTimeout(timer.current), []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  // Position before paint, writing styles directly to avoid an extra render.
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current?.firstElementChild as HTMLElement | null;
    const tip = tipRef.current;
    if (!anchor || !tip) return;
    const a = anchor.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    let top: number;
    let left: number;
    if (placement === "right") {
      left = a.right + GAP + 2;
      top = a.top + a.height / 2 - t.height / 2;
    } else if (placement === "top") {
      top = a.top - t.height - GAP;
      left = a.left + a.width / 2 - t.width / 2;
    } else {
      top = a.bottom + GAP;
      left = a.left + a.width / 2 - t.width / 2;
    }
    left = Math.max(MARGIN, Math.min(left, window.innerWidth - t.width - MARGIN));
    top = Math.max(MARGIN, Math.min(top, window.innerHeight - t.height - MARGIN));
    tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }, [open, placement]);

  const onFocus = (event: FocusEvent) => {
    const target = event.target as HTMLElement;
    if (target.matches?.(":focus-visible")) show(SHOW_DELAY_FOCUS);
  };

  const child = isValidElement(children)
    ? cloneElement(children, {
        "aria-describedby": open ? [children.props["aria-describedby"], id].filter(Boolean).join(" ") : children.props["aria-describedby"],
      })
    : children;

  return (
    <span
      ref={anchorRef}
      className={styles.anchor}
      onMouseEnter={() => show(SHOW_DELAY_HOVER)}
      onMouseLeave={hide}
      onFocus={onFocus}
      onBlur={hide}
      onPointerDown={hide}
    >
      {child}
      {open &&
        createPortal(
          <div ref={tipRef} id={id} role="tooltip" className={styles.tooltip}>
            <span className={styles.content}>{content}</span>
            {shortcut && <Kbd onDark>{shortcut}</Kbd>}
          </div>,
          document.body,
        )}
    </span>
  );
}
