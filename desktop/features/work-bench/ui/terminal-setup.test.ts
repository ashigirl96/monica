/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import type { Terminal } from "@xterm/xterm";
import { createWheelHandler } from "./terminal-setup";

type CsiHandler = (params: (number | number[])[]) => boolean;

type FakeTerm = {
  rows: number;
  cols: number;
  modes: { mouseTrackingMode: string };
  buffer: { active: { type: string } };
  /// Drives the registered `CSI ? Pm h/l` observers the way xterm's parser would.
  setDecMode(mode: number, on: boolean): boolean[];
};

function fakeTerm(overrides: Partial<FakeTerm> = {}): Terminal & FakeTerm {
  const handlers = new Map<string, CsiHandler>();
  return {
    rows: 24,
    cols: 80,
    modes: { mouseTrackingMode: "any" },
    buffer: { active: { type: "alternate" } },
    parser: {
      registerCsiHandler: ({ final, prefix }: { final: string; prefix: string }, h: CsiHandler) => {
        handlers.set(`${prefix}${final}`, h);
        return { dispose: () => {} };
      },
    },
    setDecMode(mode: number, on: boolean) {
      const handler = handlers.get(on ? "?h" : "?l");
      return handler ? [handler([mode])] : [];
    },
    ...overrides,
  } as unknown as Terminal & FakeTerm;
}

function wheelEvent(overrides: Partial<WheelEvent> = {}) {
  let prevented = 0;
  const event = {
    deltaY: 0,
    deltaMode: 0,
    ...overrides,
    preventDefault: () => {
      prevented++;
    },
    stopPropagation: () => {},
  };
  return { event: event as unknown as WheelEvent, prevented: () => prevented };
}

/// Wires the handler to a terminal that has already announced SGR mouse reporting, which is
/// what every app Monica cares about does (and what the attach replay now restores).
function handlerWithSink(term: Terminal & FakeTerm = fakeTerm(), sgr = true) {
  const writes: string[] = [];
  const onWheel = createWheelHandler(term, (text) => writes.push(text));
  if (sgr) term.setDecMode(1006, true);
  return { onWheel, writes, term };
}

describe("createWheelHandler", () => {
  test("stays out of the way when the app is not reporting mouse events", () => {
    const { onWheel, writes } = handlerWithSink(fakeTerm({ modes: { mouseTrackingMode: "none" } }));
    const { event, prevented } = wheelEvent({ deltaY: 200 });

    onWheel(event);

    expect(writes).toEqual([]);
    expect(prevented()).toBe(0);
  });

  // A pane reconnected from a replay tail without the app's one-shot `?1049h` reports the
  // normal buffer, yet still needs the fast wheel path.
  test("sends SGR events on the normal buffer while mouse tracking is on", () => {
    const { onWheel, writes } = handlerWithSink(
      fakeTerm({ buffer: { active: { type: "normal" } } }),
    );
    const { event, prevented } = wheelEvent({ deltaY: 60 });

    onWheel(event);

    expect(writes).toEqual(["\x1b[<65;40;12M".repeat(3)]);
    expect(prevented()).toBe(1);
  });

  test("leaves the wheel to xterm when the app never asked for SGR encoding", () => {
    const { onWheel, writes } = handlerWithSink(fakeTerm(), false);
    const { event, prevented } = wheelEvent({ deltaY: 200 });

    onWheel(event);

    expect(writes).toEqual([]);
    expect(prevented()).toBe(0);
  });

  // xterm keeps one active encoding, so pixel coordinates displace SGR cell coordinates and
  // our cell-based reports would point at the wrong place.
  test("stands down when ?1016 takes the encoding slot", () => {
    const { onWheel, writes, term } = handlerWithSink();

    term.setDecMode(1016, true);
    onWheel(wheelEvent({ deltaY: 200 }).event);
    expect(writes).toEqual([]);

    // Releasing 1016 clears the slot outright rather than falling back to SGR.
    term.setDecMode(1016, false);
    onWheel(wheelEvent({ deltaY: 200 }).event);
    expect(writes).toEqual([]);

    term.setDecMode(1006, true);
    onWheel(wheelEvent({ deltaY: 20 }).event);
    expect(writes).toEqual(["\x1b[<65;40;12M"]);
  });

  test("stops sending SGR events once the app resets ?1006", () => {
    const { onWheel, writes, term } = handlerWithSink();

    onWheel(wheelEvent({ deltaY: 20 }).event);
    expect(writes).toEqual(["\x1b[<65;40;12M"]);

    term.setDecMode(1006, false);
    onWheel(wheelEvent({ deltaY: 20 }).event);
    expect(writes).toEqual(["\x1b[<65;40;12M"]);
  });

  test("observes ?1006 without swallowing it from xterm's own handling", () => {
    const term = fakeTerm();
    handlerWithSink(term, false);

    expect(term.setDecMode(1006, true)).toEqual([false]);
    expect(term.setDecMode(1049, true)).toEqual([false]);
  });

  test("accumulates sub-line deltas until they cross one line", () => {
    const { onWheel, writes } = handlerWithSink();

    for (let i = 0; i < 3; i++) onWheel(wheelEvent({ deltaY: 6 }).event);
    expect(writes).toEqual([]);

    onWheel(wheelEvent({ deltaY: 6 }).event);
    expect(writes).toEqual(["\x1b[<65;40;12M"]);
  });

  test("reads a line-mode delta as whole lines", () => {
    const { onWheel, writes } = handlerWithSink();

    onWheel(wheelEvent({ deltaY: 2, deltaMode: 1 }).event);

    expect(writes).toEqual(["\x1b[<65;40;12M".repeat(2)]);
  });

  test("clamps a single gesture to one screenful", () => {
    const { onWheel, writes } = handlerWithSink(fakeTerm({ rows: 10 }));

    onWheel(wheelEvent({ deltaY: 20 * 999 }).event);

    expect(writes).toEqual(["\x1b[<65;40;5M".repeat(10)]);
  });

  test("uses button 64 for scroll up and 65 for scroll down", () => {
    const { onWheel, writes } = handlerWithSink();

    onWheel(wheelEvent({ deltaY: -20 }).event);
    onWheel(wheelEvent({ deltaY: 40 }).event);

    expect(writes).toEqual(["\x1b[<64;40;12M", "\x1b[<65;40;12M".repeat(2)]);
  });
});
