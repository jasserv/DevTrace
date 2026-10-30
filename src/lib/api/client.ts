import { invoke, isTauri, type InvokeArgs, type InvokeOptions } from "@tauri-apps/api/core";

export type ApiErrorKind =
  | "validation"
  | "not_found"
  | "conflict"
  | "storage_unavailable"
  | "database"
  | "io"
  | "serialization"
  | "internal"
  | "runtime_unavailable"
  | "unknown";

const KNOWN_KINDS = new Set<string>([
  "validation",
  "not_found",
  "conflict",
  "storage_unavailable",
  "database",
  "io",
  "serialization",
  "internal",
]);

/** Normalized error for every backend call. `field` names the input a message belongs to. */
export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly field: string | null;

  constructor(kind: ApiErrorKind, message: string, field: string | null = null) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.field = field;
  }
}

export function toApiError(raw: unknown): ApiError {
  if (raw instanceof ApiError) return raw;
  if (raw && typeof raw === "object" && "message" in raw) {
    const record = raw as { kind?: unknown; message?: unknown; field?: unknown };
    const kind = typeof record.kind === "string" && KNOWN_KINDS.has(record.kind) ? (record.kind as ApiErrorKind) : "unknown";
    const message = typeof record.message === "string" ? record.message : "An unexpected error occurred.";
    const field = typeof record.field === "string" ? record.field : null;
    return new ApiError(kind, message, field);
  }
  if (typeof raw === "string" && raw.trim()) return new ApiError("unknown", raw);
  return new ApiError("unknown", "An unexpected error occurred.");
}

/** True when running inside the DevTrace desktop shell (not a plain browser or test). */
export function hasDesktopRuntime(): boolean {
  return isTauri();
}

/** Calls a backend command and normalizes failures into {@link ApiError}. */
export async function call<T>(command: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  if (!hasDesktopRuntime()) {
    throw new ApiError(
      "runtime_unavailable",
      "The DevTrace desktop runtime is not available. Start the app with `npm run tauri dev`.",
    );
  }
  try {
    return await invoke<T>(command, args, options);
  } catch (raw) {
    throw toApiError(raw);
  }
}
