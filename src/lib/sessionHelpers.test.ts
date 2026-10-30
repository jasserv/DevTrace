import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { annotationHighlights, captureDetails } from "../features/sessions/eventTypes";
import type { SessionEvent } from "./api";
import { formatBytes } from "./format";
import { useAutosave } from "./hooks";
import { EVENT_CODE_RULE, normalizePreformatted, validatePreformatted } from "./validation";

describe("capture details", () => {
  const event = (metadata: SessionEvent["metadata"]) => ({ metadata }) as SessionEvent;

  it("describes what took a screenshot and of what", () => {
    expect(
      captureDetails(
        event({ capture: { trigger: "shortcut", target: { kind: "window", title: "Router admin", appName: "Microsoft Edge", width: 1280, height: 800 } } }),
      ),
    ).toEqual({ trigger: "Capture shortcut", target: "Window: Router admin (Microsoft Edge)", size: "1280 \u00d7 800" });
    expect(captureDetails(event({ capture: { trigger: "tray", target: { kind: "monitor", title: "Display 1", appName: "DELL U2720Q" } } }))).toEqual({
      trigger: "Tray menu",
      target: "Display: Display 1",
      size: null,
    });
  });

  it("returns nothing for events that were not captured", () => {
    expect(captureDetails(event({}))).toBeNull();
    expect(captureDetails(event({ capture: { trigger: "button" } }))).toBeNull();
  });

  it("numbers annotation labels", () => {
    const boxes = annotationHighlights([
      { id: "a", x: 0, y: 0, width: 10, height: 10, label: "Apply" },
      { id: "b", x: 5, y: 5, width: 10, height: 10, label: "" },
    ]);
    expect(boxes.map((box) => box.label)).toEqual(["1 Apply", "2"]);
  });
});

describe("preformatted text", () => {
  it("drops leading blank lines and trailing whitespace but keeps indentation", () => {
    expect(normalizePreformatted("\n  \n    show running-config\n  | include ntp \n\n")).toBe("    show running-config\n  | include ntp");
    expect(normalizePreformatted("\r\n\tGet-Service\r\n")).toBe("\tGet-Service");
    expect(normalizePreformatted(" \n \n")).toBe("");
  });

  it("validates like the backend", () => {
    expect(validatePreformatted(EVENT_CODE_RULE, "  \n ")).toBe("Command is required.");
    expect(validatePreformatted(EVENT_CODE_RULE, "echo \u001b[31m")).toMatch(/control characters/);
    expect(validatePreformatted(EVENT_CODE_RULE, "  ping 10.0.0.1")).toBeNull();
  });
});

describe("formatBytes", () => {
  it("uses binary units", () => {
    expect(formatBytes(512)).toBe("512 bytes");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(250 * 1024)).toBe("250 KB");
    expect(formatBytes(25 * 1024 * 1024)).toBe("25 MB");
    expect(formatBytes(-1)).toBe("\u2014");
  });
});

describe("useAutosave", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces, reports progress honestly and saves the latest value", async () => {
    const save = vi.fn(async (value: string) => `saved:${value}`);
    const { result, rerender } = renderHook(({ value }) => useAutosave(value, "", save, { delay: 500 }), { initialProps: { value: "" } });
    expect(result.current.state).toBe("idle");

    rerender({ value: "a" });
    rerender({ value: "ab" });
    expect(result.current.state).toBe("saving");
    expect(save).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenLastCalledWith("ab");
    expect(result.current.state).toBe("saved");
    expect(result.current.savedAt).toBe("saved:ab");
  });

  it("keeps unsaved text marked as an error until a save succeeds, and saves on unmount", async () => {
    let fail = true;
    const save = vi.fn(async (value: string) => {
      if (fail) throw { kind: "database", message: "disk full", field: null };
      return `saved:${value}`;
    });
    const onBackgroundError = vi.fn();
    const { result, rerender, unmount } = renderHook(({ value }) => useAutosave(value, "start", save, { delay: 100, onBackgroundError }), {
      initialProps: { value: "start" },
    });

    rerender({ value: "start + edit" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(result.current.state).toBe("error");
    expect(result.current.error?.message).toBe("disk full");

    fail = false;
    await act(async () => {
      result.current.flush();
      await vi.runAllTimersAsync();
    });
    expect(result.current.state).toBe("saved");

    rerender({ value: "final" });
    unmount();
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(save).toHaveBeenLastCalledWith("final");
    expect(onBackgroundError).not.toHaveBeenCalled();
  });
});
