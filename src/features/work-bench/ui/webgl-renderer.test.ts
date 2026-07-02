/// <reference types="bun" />
import { describe, expect, spyOn, test } from "bun:test";
import type { WebglAddon } from "@xterm/addon-webgl";
import { attachWebglRenderer } from "./webgl-renderer";

type FakeAddon = {
  disposeCalls: number;
  dispose(): void;
  onContextLoss(cb: () => void): { dispose(): void };
  fireLoss(): void;
};

function makeFakeAddon(throwOnDispose: boolean): FakeAddon {
  let lossCb: (() => void) | null = null;
  return {
    disposeCalls: 0,
    dispose() {
      this.disposeCalls++;
      if (throwOnDispose) throw new Error("already disposed");
    },
    onContextLoss(cb) {
      lossCb = cb;
      return { dispose() {} };
    },
    fireLoss() {
      lossCb?.();
    },
  };
}

function makeHarness(opts: { createThrows?: boolean; throwOnDispose?: boolean } = {}) {
  const addons: FakeAddon[] = [];
  const loaded: unknown[] = [];
  const refreshes: [number, number][] = [];
  const scheduled: (() => void)[] = [];
  const cancelled: number[] = [];
  const term = {
    loadAddon: (addon: unknown) => {
      loaded.push(addon);
    },
    refresh: (start: number, end: number) => {
      refreshes.push([start, end]);
    },
    rows: 24,
  };
  const detach = attachWebglRenderer(
    term,
    () => {
      if (opts.createThrows) throw new Error("no webgl");
      const addon = makeFakeAddon(opts.throwOnDispose ?? false);
      addons.push(addon);
      return addon as unknown as WebglAddon;
    },
    (cb) => scheduled.push(cb),
    (id) => {
      cancelled.push(id);
    },
  );
  const runScheduled = () => {
    for (const cb of scheduled.splice(0)) cb();
  };
  return { addons, loaded, refreshes, scheduled, cancelled, detach, runScheduled };
}

describe("attachWebglRenderer", () => {
  test("loads the addon once and repaints the full viewport", () => {
    const h = makeHarness();
    expect(h.addons.length).toBe(1);
    expect(h.loaded).toEqual([h.addons[0]]);
    expect(h.refreshes).toEqual([[0, 23]]);
  });

  test("falls back to the DOM renderer when the addon cannot be created", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const h = makeHarness({ createThrows: true });
      expect(h.loaded.length).toBe(0);
      expect(h.refreshes.length).toBe(0);
      expect(() => h.detach()).not.toThrow();
    } finally {
      warn.mockRestore();
    }
  });

  test("recovers from context loss by disposing and reloading", () => {
    const h = makeHarness();
    h.addons[0].fireLoss();
    expect(h.addons[0].disposeCalls).toBe(1);
    expect(h.loaded.length).toBe(1);
    expect(h.scheduled.length).toBe(1);

    h.runScheduled();
    expect(h.addons.length).toBe(2);
    expect(h.loaded[1]).toBe(h.addons[1]);
    expect(h.refreshes).toEqual([
      [0, 23],
      [0, 23],
    ]);
  });

  test("detach during a pending reload cancels it", () => {
    const h = makeHarness();
    h.addons[0].fireLoss();
    h.detach();
    expect(h.cancelled.length).toBe(1);

    h.runScheduled();
    expect(h.addons.length).toBe(1);
    expect(h.loaded.length).toBe(1);
  });

  test("detach is idempotent and tolerates the addon dispose throwing", () => {
    const h = makeHarness({ throwOnDispose: true });
    expect(() => h.detach()).not.toThrow();
    expect(h.addons[0].disposeCalls).toBe(1);

    h.detach();
    expect(h.addons[0].disposeCalls).toBe(1);
  });

  test("context loss after detach does not reload", () => {
    const h = makeHarness();
    h.detach();
    expect(h.addons[0].disposeCalls).toBe(1);

    h.addons[0].fireLoss();
    expect(h.scheduled.length).toBe(0);
    h.runScheduled();
    expect(h.addons.length).toBe(1);
    expect(h.loaded.length).toBe(1);
  });
});
