/// <reference types="bun" />
import { describe, expect, mock, test } from "bun:test";
import { EventCleanupManager } from "@/lib/event-cleanup";

function mockEventTarget() {
  const add = mock<EventTarget["addEventListener"]>();
  const remove = mock<EventTarget["removeEventListener"]>();
  return {
    addEventListener: add,
    removeEventListener: remove,
    dispatchEvent: () => true,
  } satisfies EventTarget;
}

describe("EventCleanupManager", () => {
  test("addEventListener registers and disposeAll removes", () => {
    const mgr = new EventCleanupManager();
    const target = mockEventTarget();
    const handler = () => {};

    mgr.addEventListener(target, "click", handler, true);

    expect(target.addEventListener).toHaveBeenCalledWith("click", handler, true);
    expect(target.removeEventListener).not.toHaveBeenCalled();

    mgr.disposeAll();

    expect(target.removeEventListener).toHaveBeenCalledWith("click", handler, true);
  });

  test("addEventListener with options object", () => {
    const mgr = new EventCleanupManager();
    const target = mockEventTarget();
    const handler = () => {};
    const opts = { capture: true };

    mgr.addEventListener(target, "wheel", handler, opts);
    mgr.disposeAll();

    expect(target.removeEventListener).toHaveBeenCalledWith("wheel", handler, opts);
  });

  test("add registers arbitrary cleanup", () => {
    const mgr = new EventCleanupManager();
    const fn = mock(() => {});

    mgr.add(fn);
    expect(fn).not.toHaveBeenCalled();

    mgr.disposeAll();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("disposeAll clears list — no double dispose", () => {
    const mgr = new EventCleanupManager();
    const fn = mock(() => {});

    mgr.add(fn);
    mgr.disposeAll();
    mgr.disposeAll();

    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("multiple registrations dispose in order", () => {
    const mgr = new EventCleanupManager();
    const order: number[] = [];

    mgr.add(() => order.push(1));
    mgr.add(() => order.push(2));
    mgr.add(() => order.push(3));

    mgr.disposeAll();

    expect(order).toEqual([1, 2, 3]);
  });
});
