/**
 * Line-based diff (longest common subsequence) for before/after configuration values.
 * Inputs are small technical snippets; very large inputs fall back to a full replace so the
 * UI never freezes.
 */

export type DiffKind = "same" | "add" | "remove";

export interface DiffLine {
  kind: DiffKind;
  text: string;
  /** 1-based line number in the "before" text, null for additions. */
  oldNumber: number | null;
  /** 1-based line number in the "after" text, null for removals. */
  newNumber: number | null;
}

export interface DiffSummary {
  additions: number;
  removals: number;
  unchanged: number;
}

const MAX_CELLS = 4_000_000;

export function splitLines(text: string | null | undefined): string[] {
  if (!text) return [];
  const normalized = text.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function diffLines(before: string | null | undefined, after: string | null | undefined): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  const n = a.length;
  const m = b.length;

  if (n * m > MAX_CELLS) {
    return [
      ...a.map((text, i): DiffLine => ({ kind: "remove", text, oldNumber: i + 1, newNumber: null })),
      ...b.map((text, j): DiffLine => ({ kind: "add", text, oldNumber: null, newNumber: j + 1 })),
    ];
  }

  // lcs[i][j] = length of the LCS of a[i..] and b[j..], stored in a flat array.
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * width + j + 1]! + 1
          : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      result.push({ kind: "same", text: a[i]!, oldNumber: i + 1, newNumber: j + 1 });
      i++;
      j++;
    } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) {
      result.push({ kind: "remove", text: a[i]!, oldNumber: i + 1, newNumber: null });
      i++;
    } else {
      result.push({ kind: "add", text: b[j]!, oldNumber: null, newNumber: j + 1 });
      j++;
    }
  }
  while (i < n) {
    result.push({ kind: "remove", text: a[i]!, oldNumber: i + 1, newNumber: null });
    i++;
  }
  while (j < m) {
    result.push({ kind: "add", text: b[j]!, oldNumber: null, newNumber: j + 1 });
    j++;
  }
  return result;
}

export function summarizeDiff(lines: DiffLine[]): DiffSummary {
  const summary: DiffSummary = { additions: 0, removals: 0, unchanged: 0 };
  for (const line of lines) {
    if (line.kind === "add") summary.additions++;
    else if (line.kind === "remove") summary.removals++;
    else summary.unchanged++;
  }
  return summary;
}

/** A displayed diff row: a line, or a placeholder for collapsed unchanged lines. */
export type DiffRow = { type: "line"; line: DiffLine } | { type: "gap"; count: number };

/**
 * Keeps `context` unchanged lines next to each change and replaces longer unchanged runs with
 * a gap row (leading and trailing runs keep no context).
 */
export function collapseUnchanged(lines: DiffLine[], context: number): DiffRow[] {
  const rows: DiffRow[] = [];
  let index = 0;
  while (index < lines.length) {
    if (lines[index]!.kind !== "same") {
      rows.push({ type: "line", line: lines[index]! });
      index++;
      continue;
    }
    let end = index;
    while (end < lines.length && lines[end]!.kind === "same") end++;
    const run = lines.slice(index, end);
    const keepStart = index === 0 ? 0 : context;
    const keepEnd = end === lines.length ? 0 : context;
    if (run.length > keepStart + keepEnd + 1) {
      run.slice(0, keepStart).forEach((line) => rows.push({ type: "line", line }));
      rows.push({ type: "gap", count: run.length - keepStart - keepEnd });
      run.slice(run.length - keepEnd).forEach((line) => rows.push({ type: "line", line }));
    } else {
      run.forEach((line) => rows.push({ type: "line", line }));
    }
    index = end;
  }
  return rows;
}
