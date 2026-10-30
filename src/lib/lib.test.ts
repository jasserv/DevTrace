import { describe, expect, it } from "vitest";

import { diffLines, splitLines, summarizeDiff } from "./diff";
import { formatDateTime, formatRelative, pluralize } from "./format";
import { validateText, PROJECT_DESCRIPTION_RULE, PROJECT_NAME_RULE } from "./validation";

describe("validateText", () => {
  it("requires required values and trims whitespace", () => {
    expect(validateText(PROJECT_NAME_RULE, "   ")).toBe("Project name is required.");
    expect(validateText(PROJECT_NAME_RULE, "  Core Network ")).toBeNull();
  });

  it("allows empty optional values", () => {
    expect(validateText(PROJECT_DESCRIPTION_RULE, "")).toBeNull();
  });

  it("counts characters, not UTF-16 code units", () => {
    const rule = { label: "Name", maxChars: 3, required: true, multiline: false };
    expect(validateText(rule, "\u{1F680}\u{1F680}\u{1F680}")).toBeNull();
    expect(validateText(rule, "abcd")).toBe("Name must be 3 characters or fewer.");
  });

  it("rejects line breaks in single-line fields and control characters everywhere", () => {
    expect(validateText(PROJECT_NAME_RULE, "two\nlines")).toMatch(/single line/);
    expect(validateText(PROJECT_DESCRIPTION_RULE, "line one\nline two")).toBeNull();
    expect(validateText(PROJECT_DESCRIPTION_RULE, "bell\u0007")).toMatch(/control characters/);
  });
});

describe("format", () => {
  const now = new Date("2026-10-22T12:00:00.000Z");

  it("formats relative times", () => {
    expect(formatRelative("2026-10-22T11:59:40.000Z", now)).toBe("just now");
    expect(formatRelative("2026-10-22T11:55:00.000Z", now)).toMatch(/5 minutes ago/);
    expect(formatRelative("2026-10-21T12:00:00.000Z", now)).toMatch(/yesterday|1 day ago/);
  });

  it("renders missing or invalid timestamps as an em dash", () => {
    expect(formatDateTime(null)).toBe("\u2014");
    expect(formatDateTime("not a date")).toBe("\u2014");
    expect(formatRelative(undefined)).toBe("\u2014");
  });

  it("pluralizes counts", () => {
    expect(pluralize(0, "project")).toBe("0 projects");
    expect(pluralize(1, "project")).toBe("1 project");
    expect(pluralize(2, "change")).toBe("2 changes");
  });
});

describe("diffLines", () => {
  it("normalizes line endings and ignores a trailing newline", () => {
    expect(splitLines("a\r\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("")).toEqual([]);
  });

  it("marks identical inputs as unchanged", () => {
    const lines = diffLines("a\nb", "a\nb");
    expect(lines.every((line) => line.kind === "same")).toBe(true);
    expect(summarizeDiff(lines)).toEqual({ additions: 0, removals: 0, unchanged: 2 });
  });

  it("finds additions and removals with line numbers", () => {
    const lines = diffLines("PermitRootLogin yes\nPort 22", "PermitRootLogin no\nPort 22\nMaxAuthTries 3");
    expect(summarizeDiff(lines)).toEqual({ additions: 2, removals: 1, unchanged: 1 });
    expect(lines).toContainEqual({ kind: "remove", text: "PermitRootLogin yes", oldNumber: 1, newNumber: null });
    expect(lines).toContainEqual({ kind: "add", text: "MaxAuthTries 3", oldNumber: null, newNumber: 3 });
    expect(lines).toContainEqual({ kind: "same", text: "Port 22", oldNumber: 2, newNumber: 2 });
  });

  it("handles missing values", () => {
    expect(summarizeDiff(diffLines(null, "new"))).toEqual({ additions: 1, removals: 0, unchanged: 0 });
    expect(diffLines(null, null)).toEqual([]);
  });
});
