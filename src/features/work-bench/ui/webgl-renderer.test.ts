/// <reference types="bun" />
import { describe, expect, spyOn, test } from "bun:test";
import type { WebglAddon } from "@xterm/addon-webgl";
import { attachWebglRenderer, createWebglRendererPool } from "./webgl-renderer";

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

// Mimics the xterm DOM: the WebGL canvas is the only unclassed canvas in .xterm-screen,
// and it hands back the same webgl2 context it was created with.
function makeFakeElement() {
  const loseCalls: number[] = [];
  let visible = true;
  const glContext = {
    getExtension: (name: string) =>
      name === "WEBGL_lose_context" ? { loseContext: () => loseCalls.push(1) } : null,
  };
  const glCanvas = {
    className: "",
    getContext: (type: string) => (type === "webgl2" ? glContext : null),
  };
  const linkCanvas = { className: "xterm-link-layer", getContext: () => null };
  const screen = { querySelectorAll: () => [linkCanvas, glCanvas] };
  const element = {
    querySelector: (selector: string) => (selector === ".xterm-screen" ? screen : null),
    getClientRects: () => ({ length: visible ? 1 : 0 }),
  } as unknown as HTMLElement;
  return {
    element,
    loseCalls,
    setVisible: (v: boolean) => {
      visible = v;
    },
  };
}

function makeHarness(
  opts: { createThrows?: boolean; throwOnDispose?: boolean; element?: HTMLElement } = {},
) {
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
    element: opts.element,
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

  test("detach explicitly loses the GL context of the unclassed canvas", () => {
    const fake = makeFakeElement();
    const h = makeHarness({ element: fake.element });
    expect(fake.loseCalls.length).toBe(0);

    h.detach();
    expect(fake.loseCalls.length).toBe(1);
  });

  test("context loss on a hidden pane defers the reload until it is shown", () => {
    const fake = makeFakeElement();
    const h = makeHarness({ element: fake.element });
    fake.setVisible(false);
    h.addons[0].fireLoss();

    h.runScheduled();
    expect(h.addons.length).toBe(1);
    expect(h.scheduled.length).toBe(1);

    fake.setVisible(true);
    h.runScheduled();
    expect(h.addons.length).toBe(2);
    expect(h.loaded[1]).toBe(h.addons[1]);
  });
});

type FakeTerm = Parameters<typeof attachWebglRenderer>[0];

function makePoolHarness(limit: number) {
  const attached: FakeTerm[] = [];
  const detachedTerms: FakeTerm[] = [];
  const pool = createWebglRendererPool(limit, (term) => {
    attached.push(term);
    return () => detachedTerms.push(term);
  });
  const makeTerm = (): FakeTerm => ({
    loadAddon: () => {},
    refresh: () => {},
    rows: 24,
    element: undefined,
  });
  return { pool, attached, detachedTerms, makeTerm };
}

describe("createWebglRendererPool", () => {
  test("acquire attaches once per terminal", () => {
    const h = makePoolHarness(2);
    const term = h.makeTerm();
    h.pool.acquire(term);
    h.pool.acquire(term);
    expect(h.attached).toEqual([term]);
    expect(h.detachedTerms).toEqual([]);
  });

  test("evicts the least recently acquired terminal past the limit", () => {
    const h = makePoolHarness(2);
    const [a, b, c] = [h.makeTerm(), h.makeTerm(), h.makeTerm()];
    h.pool.acquire(a);
    h.pool.acquire(b);
    h.pool.acquire(c);
    expect(h.detachedTerms).toEqual([a]);
  });

  test("re-acquiring refreshes recency", () => {
    const h = makePoolHarness(2);
    const [a, b, c] = [h.makeTerm(), h.makeTerm(), h.makeTerm()];
    h.pool.acquire(a);
    h.pool.acquire(b);
    h.pool.acquire(a);
    h.pool.acquire(c);
    expect(h.detachedTerms).toEqual([b]);
  });

  test("release detaches and allows a later re-attach", () => {
    const h = makePoolHarness(2);
    const term = h.makeTerm();
    h.pool.acquire(term);
    h.pool.release(term);
    expect(h.detachedTerms).toEqual([term]);

    h.pool.release(term);
    expect(h.detachedTerms).toEqual([term]);

    h.pool.acquire(term);
    expect(h.attached).toEqual([term, term]);
  });

  test("an evicted terminal re-attaches on the next acquire", () => {
    const h = makePoolHarness(1);
    const [a, b] = [h.makeTerm(), h.makeTerm()];
    h.pool.acquire(a);
    h.pool.acquire(b);
    expect(h.detachedTerms).toEqual([a]);

    h.pool.acquire(a);
    expect(h.attached).toEqual([a, b, a]);
    expect(h.detachedTerms).toEqual([a, b]);
  });
});
