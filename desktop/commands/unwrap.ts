import type { ApiError, ApiErrorCode } from "./bindings";

type Result<T> = { status: "ok"; data: T } | { status: "error"; error: ApiError };

/**
 * Thrown when a command returns a structured error. Carries the machine-readable `code` so callers
 * can branch on the kind (e.g. `not_found` vs `conflict`) instead of string-matching the message.
 */
export class CommandError extends Error {
  readonly code: ApiErrorCode;
  constructor(apiError: ApiError) {
    super(apiError.message);
    this.name = "CommandError";
    this.code = apiError.code;
  }
}

export async function unwrap<T>(result: Promise<Result<T>>): Promise<T> {
  const r = await result;
  if (r.status === "error") throw new CommandError(r.error);
  return r.data;
}
