import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactElement, type Ref } from "react";
import { Check } from "lucide-react";

import { cx } from "../lib/cx";
import { Icon, type LucideIcon } from "./Icon";
import styles from "./Overlay.module.css";

export interface MenuItem {
  type?: "item";
  id: string;
  label: string;
  description?: string;
  icon?: LucideIcon;
  onSelect?: () => void;
  /** Disabled items stay visible and explain why via their description. */
  disabled?: boolean;
  checked?: boolean;
  tone?: "default" | "danger";
}

export type MenuEntry = MenuItem | { type: "separator"; id: string } | { type: "label"; id: string; label: string };

export interface MenuTriggerProps {
  ref: Ref<HTMLButtonElement>;
  onClick: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  "aria-haspopup": "menu";
  "aria-expanded": boolean;
  "aria-controls": string | undefined;
}

interface MenuProps {
  /** Accessible name of the menu. */
  label: string;
  entries: MenuEntry[];
  renderTrigger: (props: MenuTriggerProps) => ReactElement;
  align?: "start" | "end" | "stretch";
  placement?: "bottom" | "top";
  className?: string;
}

const isItem = (entry: MenuEntry): entry is MenuItem => entry.type === undefined || entry.type === "item";

/** Dropdown menu with full keyboard support (arrows, Home/End, Enter, Escape, typeahead-free). */
export function Menu({ label, entries, renderTrigger, align = "start", placement = "bottom", className }: MenuProps) {
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const items = entries.filter(isItem);
  const itemIndexById = new Map(items.map((item, index) => [item.id, index]));

  const openMenu = (index: number) => {
    setActiveIndex(index);
    setOpen(true);
  };

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  useEffect(() => {
    if (open) itemRefs.current[activeIndex]?.focus();
  }, [open, activeIndex]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const select = (item: MenuItem) => {
    if (item.disabled) return;
    close(true);
    item.onSelect?.();
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const last = items.length - 1;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActiveIndex((index) => (index >= last ? 0 : index + 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex((index) => (index <= 0 ? last : index - 1));
        break;
      case "Home":
        event.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        event.preventDefault();
        setActiveIndex(last);
        break;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        close(true);
        break;
      case "Tab":
        close(false);
        break;
    }
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openMenu(0);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      openMenu(items.length - 1);
    }
  };

  return (
    <div ref={rootRef} className={cx(styles.menuRoot, className)}>
      {renderTrigger({
        ref: triggerRef,
        onClick: () => (open ? close(false) : openMenu(0)),
        onKeyDown: onTriggerKeyDown,
        "aria-haspopup": "menu",
        "aria-expanded": open,
        "aria-controls": open ? menuId : undefined,
      })}
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={label}
          className={cx(
            styles.menu,
            align === "end" && styles.menuEnd,
            align === "stretch" && styles.menuFull,
            placement === "top" && styles.menuTop,
          )}
          onKeyDown={onMenuKeyDown}
        >
          {entries.map((entry) => {
            if (entry.type === "separator") return <div key={entry.id} role="separator" className={styles.separator} />;
            if (entry.type === "label") {
              return (
                <div key={entry.id} className={styles.groupLabel} role="presentation">
                  {entry.label}
                </div>
              );
            }
            const index = itemIndexById.get(entry.id) ?? 0;
            const hasCheck = entry.checked !== undefined;
            return (
              <button
                key={entry.id}
                ref={(element) => {
                  itemRefs.current[index] = element;
                }}
                type="button"
                role={hasCheck ? "menuitemradio" : "menuitem"}
                aria-checked={hasCheck ? entry.checked : undefined}
                aria-disabled={entry.disabled || undefined}
                tabIndex={index === activeIndex ? 0 : -1}
                className={cx(styles.item, entry.tone === "danger" && styles.itemDanger)}
                onClick={() => select(entry)}
                onMouseEnter={() => setActiveIndex(index)}
              >
                {hasCheck ? (
                  <span className={styles.check}>{entry.checked && <Icon icon={Check} size={14} />}</span>
                ) : (
                  entry.icon && <Icon icon={entry.icon} size={15} className={styles.itemIcon} />
                )}
                <span className={styles.itemText}>
                  <span className={styles.itemLabel}>{entry.label}</span>
                  {entry.description && <span className={styles.itemDescription}>{entry.description}</span>}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
