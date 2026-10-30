import type { LucideIcon, LucideProps } from "lucide-react";

export type { LucideIcon };

interface IconProps extends Omit<LucideProps, "ref"> {
  icon: LucideIcon;
  size?: number;
  /** Accessible label. Omit for decorative icons (the default). */
  label?: string;
}

/** Outline icon with consistent size and stroke across the app. */
export function Icon({ icon: Glyph, size = 16, label, ...rest }: IconProps) {
  return (
    <Glyph
      size={size}
      strokeWidth={1.8}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
      focusable="false"
      {...rest}
    />
  );
}
