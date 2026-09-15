import { logToBackend, type BackendLogLevel } from "@/commands/log";

export type { BackendLogLevel };

type Sink = (level: BackendLogLevel, message: string) => Promise<void>;

interface PatchableConsole {
  error: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

export interface ForwardingDeps {
  sink: Sink;
  console: PatchableConsole;
  addEventListener: (
    type: "error" | "unhandledrejection",
    listener: (event: Event) => void,
    options?: AddEventListenerOptions,
  ) => void;
}

const MAX_MESSAGE = 500;
const MAX_STACK = 800;

/// Mirrors the Rust-side `command_log::field`: one record must stay one greppable line, and an
/// exception's message and stack are exactly the values that carry newlines.
function field(value: string, maxChars: number): string {
  const flat = Array.from(value, (c) => {
    const code = c.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f ? " " : c;
  });
  const capped = flat.length > maxChars ? `${flat.slice(0, maxChars).join("")}…` : flat.join("");
  return `"${capped.replace(/"/g, '\\"')}"`;
}

function describe(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    try {
      // A cyclic value lands here, and coercing one with a null prototype throws all over again.
      return String(value);
    } catch {
      return Object.prototype.toString.call(value);
    }
  }
}

function stackOf(value: unknown): string | null {
  return value instanceof Error && value.stack ? value.stack : null;
}

export function consoleLine(kind: BackendLogLevel, args: unknown[]): string {
  const message = args.map(describe).join(" ");
  return `console kind=${kind} message=${field(message, MAX_MESSAGE)}`;
}

/// The URL of an element whose load failed. A resource `error` event carries no message — the
/// element it fired on is the only thing that says what went wrong.
function resourceUrl(target: unknown): string | null {
  if (target === null || typeof target !== "object") return null;
  const element = target as { src?: unknown; href?: unknown };
  if (typeof element.src === "string" && element.src) return element.src;
  if (typeof element.href === "string" && element.href) return element.href;
  return null;
}

export function errorEventLine(event: {
  message?: unknown;
  filename?: string;
  lineno?: number;
  colno?: number;
  error?: unknown;
  target?: unknown;
}): string {
  const resource = event.message === undefined ? resourceUrl(event.target) : null;
  const message = resource === null ? describe(event.message) : "resource failed to load";
  const origin = event.filename
    ? `${event.filename}:${event.lineno ?? 0}:${event.colno ?? 0}`
    : resource;
  const stack = stackOf(event.error);
  return (
    `uncaught kind=error message=${field(message, MAX_MESSAGE)}` +
    (origin === null ? "" : ` source=${field(origin, MAX_MESSAGE)}`) +
    (stack ? ` stack=${field(stack, MAX_STACK)}` : "")
  );
}

export function rejectionLine(reason: unknown): string {
  const stack = stackOf(reason);
  return (
    `unhandledrejection kind=error message=${field(describe(reason), MAX_MESSAGE)}` +
    (stack ? ` stack=${field(stack, MAX_STACK)}` : "")
  );
}

/// Send `console.error` / `console.warn` and every uncaught exception to the Rust logger, which is
/// the only thing that writes a log file in a release build.
///
/// `console.debug` / `info` / `trace` are left alone: `vite.config.ts` strips them from the release
/// bundle. `attachConsole` from the log plugin is deliberately not used — it prints Rust records
/// with `console.error`, which these wrappers would forward straight back to Rust.
export function installConsoleForwarding(overrides: Partial<ForwardingDeps> = {}): void {
  const sink = overrides.sink ?? logToBackend;
  const patched = overrides.console ?? console;
  const listen = overrides.addEventListener ?? window.addEventListener.bind(window);

  const original = { error: patched.error.bind(patched), warn: patched.warn.bind(patched) };
  let forwardingSynchronously = false;
  let sinkFailureReported = false;

  // Report the first failure only, through the unpatched console so it cannot recurse. A missing
  // `log:default` capability fails here and would otherwise be silent in a release build.
  const reportSinkFailure = (e: unknown) => {
    if (sinkFailureReported) return;
    sinkFailureReported = true;
    original.error("failed to forward logs to the backend:", e);
  };

  // The line is built inside the guard, not passed in: this runs inside a patched `console.error`,
  // so an exception escaping here would break the caller rather than just lose the log. Both
  // halves can throw — formatting on a value that neither serializes nor coerces, and `invoke`
  // synchronously when the Tauri internals are absent.
  const forward = (level: BackendLogLevel, line: () => string) => {
    if (forwardingSynchronously) return;
    forwardingSynchronously = true;
    try {
      void sink(level, line()).catch(reportSinkFailure);
    } catch (e) {
      reportSinkFailure(e);
    } finally {
      forwardingSynchronously = false;
    }
  };

  patched.error = (...args: unknown[]) => {
    original.error(...args);
    forward("error", () => consoleLine("error", args));
  };
  patched.warn = (...args: unknown[]) => {
    original.warn(...args);
    forward("warn", () => consoleLine("warn", args));
  };

  // Capture phase: a failed `<img>` / `<script>` / stylesheet fires `error` on the element and it
  // does not bubble, so a listener on `window` only sees those while capturing.
  listen(
    "error",
    (event) => {
      forward("error", () => errorEventLine(event as ErrorEvent));
    },
    { capture: true },
  );
  listen("unhandledrejection", (event) => {
    forward("error", () => rejectionLine((event as PromiseRejectionEvent).reason));
  });
}
