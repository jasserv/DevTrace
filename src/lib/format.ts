/**
 * Date formatting. Stored timestamps are UTC (RFC 3339); they are displayed in the user's
 * local time zone. Invalid or missing values render as an em dash rather than "Invalid Date".
 */

const PLACEHOLDER = "\u2014";

function parse(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const dateFormat = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" });

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** "Oct 22, 2026, 11:33 PM" */
export function formatDateTime(value: string | null | undefined): string {
  const date = parse(value);
  return date ? dateTimeFormat.format(date) : PLACEHOLDER;
}

/** "Oct 22, 2026" */
export function formatDate(value: string | null | undefined): string {
  const date = parse(value);
  return date ? dateFormat.format(date) : PLACEHOLDER;
}

/** "23:33:42" - for event timelines. */
export function formatTime(value: string | null | undefined): string {
  const date = parse(value);
  return date ? timeFormat.format(date) : PLACEHOLDER;
}

const relativeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

/** "5 minutes ago", "yesterday", "just now". */
export function formatRelative(value: string | null | undefined, now: Date = new Date()): string {
  const date = parse(value);
  if (!date) return PLACEHOLDER;
  const seconds = Math.round((date.getTime() - now.getTime()) / 1000);
  const magnitude = Math.abs(seconds);
  if (magnitude < 45) return "just now";
  for (const [unit, size] of UNITS) {
    if (magnitude >= size) return relativeFormat.format(Math.round(seconds / size), unit);
  }
  return relativeFormat.format(Math.round(seconds / 60), "minute");
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}

/** "512 bytes", "48 KB", "1.2 MB" (binary units, like the backend limits). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return PLACEHOLDER;
  if (bytes < 1024) return pluralize(bytes, "byte");
  const kilobytes = bytes / 1024;
  if (kilobytes < 1024) return `${kilobytes < 10 ? kilobytes.toFixed(1) : Math.round(kilobytes)} KB`;
  const megabytes = kilobytes / 1024;
  return `${megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes)} MB`;
}
