import { useMemo, useRef, type KeyboardEvent, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";

import { cx } from "../lib/cx";
import styles from "./DataTable.module.css";
import { Icon } from "./Icon";
import { sortRows } from "./utils";

export interface Column<T> {
  id: string;
  header: string;
  cell: (row: T) => ReactNode;
  /** CSS width, e.g. "28%" or "120px". */
  width?: string;
  align?: "start" | "end";
  /** Enables sorting on this column. */
  sortValue?: (row: T) => string | number;
  tone?: "default" | "secondary" | "mono";
  /** Hidden from view but kept for screen readers (e.g. an actions column header). */
  hideHeader?: boolean;
}

export interface SortState {
  columnId: string;
  direction: "asc" | "desc";
}

interface DataTableProps<T> {
  /** Accessible name for the table. */
  label: string;
  columns: Column<T>[];
  rows: T[];
  getRowId: (row: T) => string;
  loading?: boolean;
  sort?: SortState | null;
  onSortChange?: (sort: SortState) => void;
  /** Makes rows focusable and activatable with Enter/Space or click. */
  onRowActivate?: (row: T) => void;
  selectedId?: string | null;
  /** Shown below the header when there are no rows. */
  empty?: ReactNode;
}

/** Structured, accessible data table for compact technical lists. */
export function DataTable<T>({
  label,
  columns,
  rows,
  getRowId,
  loading = false,
  sort,
  onSortChange,
  onRowActivate,
  selectedId,
  empty,
}: DataTableProps<T>) {
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const sorted = useMemo(() => sortRows(rows, columns, sort), [rows, columns, sort]);
  const interactive = Boolean(onRowActivate);
  const focusIndex = Math.max(
    0,
    sorted.findIndex((row) => getRowId(row) === selectedId),
  );

  const toggleSort = (column: Column<T>) => {
    if (!onSortChange) return;
    const direction = sort?.columnId === column.id && sort.direction === "asc" ? "desc" : "asc";
    onSortChange({ columnId: column.id, direction });
  };

  const onRowKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, row: T) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onRowActivate?.(row);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const rowsEls = Array.from(bodyRef.current?.querySelectorAll<HTMLTableRowElement>("tr[data-row]") ?? []);
    const index = rowsEls.indexOf(event.currentTarget);
    const next = rowsEls[event.key === "ArrowDown" ? index + 1 : index - 1];
    next?.focus();
  };

  return (
    <div className={styles.wrap}>
      <table className={styles.table} aria-label={label} aria-busy={loading || undefined}>
        <colgroup>
          {columns.map((column) => (
            <col key={column.id} style={column.width ? { width: column.width } : undefined} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {columns.map((column) => {
              const isSorted = sort?.columnId === column.id;
              const ariaSort = isSorted ? (sort.direction === "asc" ? "ascending" : "descending") : undefined;
              const SortIcon = isSorted ? (sort.direction === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
              return (
                <th
                  key={column.id}
                  scope="col"
                  aria-sort={column.sortValue ? (ariaSort ?? "none") : undefined}
                  className={cx(styles.th, column.align === "end" && styles.end, isSorted && styles.sorted)}
                >
                  {column.hideHeader ? (
                    <span className="visually-hidden">{column.header}</span>
                  ) : column.sortValue && onSortChange ? (
                    <button type="button" className={styles.sortButton} onClick={() => toggleSort(column)}>
                      {column.header}
                      <Icon icon={SortIcon} size={12} className={styles.sortIcon} />
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody ref={bodyRef}>
          {loading && sorted.length === 0
            ? [0, 1, 2].map((index) => (
                <tr key={`skeleton-${index}`} className={styles.row} aria-hidden="true">
                  {columns.map((column) => (
                    <td key={column.id} className={styles.td}>
                      <span className={styles.skeleton} />
                    </td>
                  ))}
                </tr>
              ))
            : sorted.map((row, index) => {
                const id = getRowId(row);
                const selected = id === selectedId;
                return (
                  <tr
                    key={id}
                    data-row=""
                    className={cx(styles.row, interactive && styles.interactive, selected && styles.selected)}
                    tabIndex={interactive ? (index === focusIndex ? 0 : -1) : undefined}
                    aria-current={selected ? "true" : undefined}
                    onClick={interactive ? () => onRowActivate?.(row) : undefined}
                    onKeyDown={interactive ? (event) => onRowKeyDown(event, row) : undefined}
                  >
                    {columns.map((column) => (
                      <td
                        key={column.id}
                        className={cx(
                          styles.td,
                          column.align === "end" && styles.end,
                          column.tone === "secondary" && styles.secondary,
                          column.tone === "mono" && styles.mono,
                        )}
                      >
                        {column.cell(row)}
                      </td>
                    ))}
                  </tr>
                );
              })}
          {!loading && sorted.length === 0 && empty && (
            <tr>
              <td className={cx(styles.td, styles.emptyCell)} colSpan={columns.length}>
                {empty}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
