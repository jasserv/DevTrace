import { useMemo } from "react";

import { cx } from "../lib/cx";
import { collapseUnchanged, diffLines, summarizeDiff, type DiffKind, type DiffRow } from "../lib/diff";
import { pluralize } from "../lib/format";
import styles from "./DiffView.module.css";

interface DiffViewProps {
  /** What changed, e.g. a file path or setting name. */
  label: string;
  before: string | null;
  after: string | null;
  /**
   * When set, runs of unchanged lines longer than twice this many lines are collapsed, keeping
   * `context` lines around each change. Shows every line when omitted.
   */
  context?: number;
}

const SIGN: Record<DiffKind, string> = { add: "+", remove: "\u2212", same: " " };
const SPOKEN: Record<DiffKind, string> = { add: "Added: ", remove: "Removed: ", same: "Unchanged: " };

/**
 * Readable before/after diff. Changes are distinguished by color, by a +/− sign column, and
 * by hidden text for screen readers - never by color alone.
 */
export function DiffView({ label, before, after, context }: DiffViewProps) {
  const lines = useMemo(() => diffLines(before, after), [before, after]);
  const summary = summarizeDiff(lines);
  const unchanged = summary.additions === 0 && summary.removals === 0;
  const rows = useMemo<DiffRow[]>(
    () => (context === undefined ? lines.map((line) => ({ type: "line", line })) : collapseUnchanged(lines, context)),
    [lines, context],
  );

  return (
    <figure className={styles.diff} aria-label={`Changes to ${label}`}>
      <figcaption className={styles.header}>
        <span className={styles.label}>{label}</span>
        <span className={styles.summary}>
          <span className={styles.added}>+{pluralize(summary.additions, "addition")}</span>
          <span className={styles.removed}>
            {"\u2212"}
            {pluralize(summary.removals, "removal")}
          </span>
        </span>
      </figcaption>
      {lines.length === 0 || unchanged ? (
        <p className={styles.none}>{lines.length === 0 ? "Both values are empty." : "No differences between the values."}</p>
      ) : (
        // Long lines scroll sideways; focusable so that works with the keyboard too.
        <div className={styles.scroll} role="group" aria-label={`Lines of ${label}`} tabIndex={0}>
          <table className={styles.table}>
            <thead className="visually-hidden">
              <tr>
                <th scope="col">Line before</th>
                <th scope="col">Line after</th>
                <th scope="col">Change</th>
                <th scope="col">Content</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) =>
                row.type === "gap" ? (
                  <tr key={index} className={styles.gap}>
                    <td className={styles.lineNo} />
                    <td className={styles.lineNo} />
                    <td className={styles.sign} aria-hidden="true">
                      {"\u22ef"}
                    </td>
                    <td className={styles.text}>{pluralize(row.count, "unchanged line")}</td>
                  </tr>
                ) : (
                  <tr key={index} className={cx(row.line.kind === "add" && styles.add, row.line.kind === "remove" && styles.remove)}>
                    <td className={styles.lineNo}>{row.line.oldNumber ?? ""}</td>
                    <td className={styles.lineNo}>{row.line.newNumber ?? ""}</td>
                    <td className={styles.sign} aria-hidden="true">
                      {SIGN[row.line.kind]}
                    </td>
                    <td className={styles.text}>
                      <span className="visually-hidden">{SPOKEN[row.line.kind]}</span>
                      {row.line.text || " "}
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
    </figure>
  );
}
