import { useId, type ButtonHTMLAttributes, type MouseEvent, type ReactNode, type Ref } from "react";

import { cx } from "../lib/cx";
import styles from "./Button.module.css";
import { Icon, type LucideIcon } from "./Icon";
import { Spinner } from "./Primitives";
import { Tooltip, type TooltipPlacement } from "./Tooltip";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: LucideIcon;
  iconEnd?: LucideIcon;
  /** Shows a spinner and blocks activation. */
  loading?: boolean;
  /**
   * Marks the action as unavailable and explains why. The button stays focusable
   * (aria-disabled) so keyboard and screen reader users can discover the reason.
   */
  disabledReason?: string;
  tooltip?: ReactNode;
  tooltipPlacement?: TooltipPlacement;
  shortcut?: string;
  children?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  iconEnd,
  loading = false,
  disabled = false,
  disabledReason,
  tooltip,
  tooltipPlacement,
  shortcut,
  className,
  children,
  onClick,
  type = "button",
  ref,
  ...rest
}: ButtonProps) {
  const reasonId = useId();
  const unavailable = Boolean(disabledReason);
  const blocked = disabled || unavailable || loading;
  const iconSize = size === "sm" ? 14 : 16;
  const label = rest["aria-label"];

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (blocked) {
      event.preventDefault();
      return;
    }
    onClick?.(event);
  };

  const describedBy = [rest["aria-describedby"], unavailable ? reasonId : undefined].filter(Boolean).join(" ") || undefined;

  const button = (
    <button
      {...rest}
      ref={ref}
      type={type}
      className={cx(styles.button, styles[variant], size !== "md" && styles[size], !children && styles.iconOnly, className)}
      disabled={disabled && !unavailable}
      aria-disabled={unavailable || loading ? true : undefined}
      aria-busy={loading || undefined}
      aria-describedby={describedBy}
      onClick={handleClick}
    >
      {loading ? <Spinner size={iconSize - 2} /> : icon ? <Icon icon={icon} size={iconSize} /> : null}
      {children !== undefined && children !== null && <span className={styles.label}>{children}</span>}
      {iconEnd && <Icon icon={iconEnd} size={iconSize - 2} />}
    </button>
  );

  const tipContent = unavailable ? (
    label ? (
      <>
        <strong>{label}</strong>
        <span>{disabledReason}</span>
      </>
    ) : (
      disabledReason
    )
  ) : (
    tooltip
  );

  return (
    <>
      {tipContent ? (
        <Tooltip content={tipContent} shortcut={unavailable ? undefined : shortcut} placement={tooltipPlacement}>
          {button}
        </Tooltip>
      ) : (
        button
      )}
      {unavailable && (
        <span id={reasonId} className="visually-hidden">
          {disabledReason}
        </span>
      )}
    </>
  );
}

export interface IconButtonProps extends Omit<ButtonProps, "children" | "icon" | "tooltip" | "aria-label"> {
  icon: LucideIcon;
  /** Accessible name, also shown as the tooltip. */
  label: string;
}

/** Square icon-only button. Always has an accessible label and a tooltip. */
export function IconButton({ icon, label, variant = "ghost", ...rest }: IconButtonProps) {
  return <Button {...rest} variant={variant} icon={icon} aria-label={label} tooltip={label} />;
}
