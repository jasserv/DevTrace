import type { Column, SortState } from "./DataTable";

/** Element ids linking a tab to its panel. */
export const tabId = (prefix: string, value: string) => `${prefix}-tab-${value}`;
export const tabPanelId = (prefix: string, value: string) => `${prefix}-panel-${value}`;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Sorts rows by the column's `sortValue`; numbers numerically, text with natural ordering. */
export function sortRows<T>(rows: T[], columns: Column<T>[], sort: SortState | null | undefined): T[] {
  if (!sort) return rows;
  const column = columns.find((candidate) => candidate.id === sort.columnId);
  if (!column?.sortValue) return rows;
  const factor = sort.direction === "asc" ? 1 : -1;
  const value = column.sortValue;
  return [...rows].sort((a, b) => {
    const left = value(a);
    const right = value(b);
    const result =
      typeof left === "number" && typeof right === "number" ? left - right : collator.compare(String(left), String(right));
    return result * factor;
  });
}
