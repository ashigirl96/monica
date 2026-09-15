/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import {
  consoleLine,
  errorEventLine,
  installConsoleForwarding,
  rejectionLine,
  type BackendLogLevel,
} from "./forward-console";

function harness(sink?: (level: BackendLogLevel, message: string) => Promise<void>) {
  const printed: unknown[][] = [];
  const sent: Array<[BackendLogLevel, string]> = [];
  const listeners = new Map<string, (event: Event) => void>();
  const options = new Map<string, AddEventListenerOptions | undefined>();
  const fakeConsole = {
    error: (...args: unknown[]) => printed.push(args),
    warn: (...args: unknown[]) => printed.push(args),
  };
  installConsoleForwarding({
    console: fakeConsole,
    addEventListener: (type, listener, opts) => {
      listeners.set(type, listener);
      options.set(type, opts);
    },
    sink:
      sink ??
      ((level, message) => {
        sent.push([level, message]);
        return Promise.resolve();
      }),
  });
  return { printed, sent, listeners, options, console: fakeConsole };
}

describe("line formatting", () => {
  test("a console call becomes one key=value line", () => {
    expect(consoleLine("error", ["boom", 42])).toBe('console kind=error message="boom 42"');
  });

  test("an Error argument keeps its name and message", () => {
    expect(consoleLine("warn", [new TypeError("x is not a function")])).toBe(
      'console kind=warn message="TypeError: x is not a function"',
    );
  });

  test("a multiline stack stays on one line", () => {
    const error = new Error("boom");
    error.stack = "Error: boom\n    at a (f.js:1:1)\n    at b (f.js:2:2)";
    const line = rejectionLine(error);
    expect(line).not.toInclude("\n");
    expect(line).toInclude('stack="Error: boom     at a (f.js:1:1)     at b (f.js:2:2)"');
  });

  test("an uncaught error carries its source location", () => {
    expect(errorEventLine({ message: "boom", filename: "/a/b.js", lineno: 12, colno: 5 })).toBe(
      'uncaught kind=error message="boom" source="/a/b.js:12:5"',
    );
  });

  test("a failed resource is named by its element, not by a message", () => {
    // `window`'s error event is a plain Event (no `message`) when an <img>/<script> fails to load.
    expect(errorEventLine({ target: { src: "/assets/missing.png" } })).toBe(
      'uncaught kind=error message="resource failed to load" source="/assets/missing.png"',
    );
  });

  test("a failed stylesheet is named by its href", () => {
    expect(errorEventLine({ target: { href: "/assets/app.css" } })).toBe(
      'uncaught kind=error message="resource failed to load" source="/assets/app.css"',
    );
  });

  test("an error event with neither a message nor a resource still logs", () => {
    expect(errorEventLine({})).toBe('uncaught kind=error message="undefined"');
  });

  test("an oversized message is capped and marked", () => {
    const line = consoleLine("error", ["x".repeat(600)]);
    expect(line).toEndWith('…"');
    expect(line.length).toBeLessThan(560);
  });

  test("an embedded quote is escaped", () => {
    expect(consoleLine("error", ['say "hi"'])).toBe('console kind=error message="say \\"hi\\""');
  });

  test("a non-serializable reason still produces a line", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(rejectionLine(cyclic)).toBe('unhandledrejection kind=error message="[object Object]"');
  });

  test("a value that neither serializes nor coerces still produces a line", () => {
    // Cyclic (JSON.stringify throws) and null-prototype (String() throws too).
    const hostile = Object.create(null) as Record<string, unknown>;
    hostile.self = hostile;
    expect(rejectionLine(hostile)).toBe('unhandledrejection kind=error message="[object Object]"');
  });
});

describe("installation", () => {
  test("console.error is printed locally and forwarded", () => {
    const h = harness();
    h.console.error("boom");
    expect(h.printed).toEqual([["boom"]]);
    expect(h.sent).toEqual([["error", 'console kind=error message="boom"']]);
  });

  test("console.warn forwards at warn level", () => {
    const h = harness();
    h.console.warn("careful");
    expect(h.sent[0]?.[0]).toBe("warn");
  });

  test("window error and rejection events are forwarded", () => {
    const h = harness();
    h.listeners.get("error")?.({ message: "boom" } as unknown as Event);
    h.listeners.get("unhandledrejection")?.({ reason: "nope" } as unknown as Event);
    expect(h.sent.map(([, line]) => line)).toEqual([
      'uncaught kind=error message="boom"',
      'unhandledrejection kind=error message="nope"',
    ]);
  });

  test("the error listener captures, so non-bubbling resource failures reach it", () => {
    const h = harness();
    expect(h.options.get("error")?.capture).toBe(true);
  });

  test("a console call made by the sink itself does not recurse", () => {
    const h = harness((level, message) => {
      h.console.error("from inside the sink");
      h.sent.push([level, message]);
      return Promise.resolve();
    });
    h.console.error("boom");
    expect(h.sent).toEqual([["error", 'console kind=error message="boom"']]);
  });

  test("a console call whose argument cannot be formatted does not reach the caller", () => {
    const h = harness();
    const hostile = Object.create(null) as Record<string, unknown>;
    hostile.self = hostile;
    expect(() => h.console.error(hostile)).not.toThrow();
    expect(h.sent).toEqual([["error", 'console kind=error message="[object Object]"']]);
  });

  test("a sink that throws synchronously is reported once, not rethrown", () => {
    const h = harness(() => {
      throw new Error("no tauri here");
    });
    expect(() => h.console.error("first")).not.toThrow();
    h.console.error("second");
    const reports = h.printed.filter(
      ([first]) => first === "failed to forward logs to the backend:",
    );
    expect(reports).toHaveLength(1);
  });

  test("a sink that rejects is reported once", async () => {
    const h = harness(() => Promise.reject(new Error("permission denied")));
    h.console.error("first");
    h.console.error("second");
    await Promise.resolve();
    const reports = h.printed.filter(
      ([first]) => first === "failed to forward logs to the backend:",
    );
    expect(reports).toHaveLength(1);
  });
});
