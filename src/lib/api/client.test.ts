import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: vi.fn(),
}));

import { ApiError, call, toApiError } from "./client";

describe("toApiError", () => {
  it("keeps the backend error kind, message and field", () => {
    const error = toApiError({ kind: "conflict", message: "Duplicate name.", field: "name" });
    expect(error).toBeInstanceOf(ApiError);
    expect(error.kind).toBe("conflict");
    expect(error.message).toBe("Duplicate name.");
    expect(error.field).toBe("name");
  });

  it("maps unknown kinds and plain strings to 'unknown'", () => {
    expect(toApiError({ kind: "weird", message: "x" }).kind).toBe("unknown");
    expect(toApiError("boom").message).toBe("boom");
    expect(toApiError(undefined).message).toBe("An unexpected error occurred.");
  });
});

describe("call", () => {
  it("fails clearly outside the desktop runtime", async () => {
    await expect(call("get_settings")).rejects.toMatchObject({ kind: "runtime_unavailable" });
  });
});
