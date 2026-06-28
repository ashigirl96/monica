/// <reference types="bun" />
import { describe, expect, mock, test } from "bun:test";
import { handleJumpMode, type JumpModeActions } from "@/lib/jump-mode";

function mockActions(): JumpModeActions {
  return {
    clearTimeout: mock(),
    deactivate: mock(),
    createTab: mock(),
    jumpToHint: mock(),
    moveActiveTab: mock(),
  };
}

function keyEvent(overrides: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return {
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    preventDefault: mock(),
    ...overrides,
  } as unknown as KeyboardEvent;
}

describe("handleJumpMode", () => {
  test("ignores modifier-only keys", () => {
    for (const key of ["Alt", "Control", "Meta", "Shift"]) {
      const actions = mockActions();
      const e = keyEvent({ key });
      handleJumpMode(e, true, actions);
      expect(e.preventDefault).not.toHaveBeenCalled();
      expect(actions.clearTimeout).not.toHaveBeenCalled();
    }
  });

  test("Ctrl+T deactivates without creating tab", () => {
    const actions = mockActions();
    const e = keyEvent({ key: "t", ctrlKey: true });
    handleJumpMode(e, true, actions);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(actions.clearTimeout).toHaveBeenCalled();
    expect(actions.deactivate).toHaveBeenCalled();
    expect(actions.createTab).not.toHaveBeenCalled();
    expect(actions.jumpToHint).not.toHaveBeenCalled();
  });

  test("'c' key deactivates and creates tab", () => {
    const actions = mockActions();
    const e = keyEvent({ key: "c" });
    handleJumpMode(e, true, actions);
    expect(actions.deactivate).toHaveBeenCalled();
    expect(actions.createTab).toHaveBeenCalled();
    expect(actions.jumpToHint).not.toHaveBeenCalled();
  });

  test("'c' with ctrl does not create tab", () => {
    const actions = mockActions();
    const e = keyEvent({ key: "c", ctrlKey: true });
    handleJumpMode(e, true, actions);
    expect(actions.createTab).not.toHaveBeenCalled();
  });

  test("non-workBench deactivates without jump", () => {
    const actions = mockActions();
    const e = keyEvent({ key: "a" });
    handleJumpMode(e, false, actions);
    expect(actions.deactivate).toHaveBeenCalled();
    expect(actions.jumpToHint).not.toHaveBeenCalled();
  });

  test("workBench dispatches jumpToHint with lowercased key", () => {
    const actions = mockActions();
    const e = keyEvent({ key: "A" });
    handleJumpMode(e, true, actions);
    expect(actions.jumpToHint).toHaveBeenCalledWith({
      key: "a",
      runspace: false,
    });
    expect(actions.deactivate).not.toHaveBeenCalled();
  });

  test("workBench with ctrl sets runspace flag", () => {
    const actions = mockActions();
    const e = keyEvent({ key: "b", ctrlKey: true });
    handleJumpMode(e, true, actions);
    expect(actions.jumpToHint).toHaveBeenCalledWith({
      key: "b",
      runspace: true,
    });
  });

  test("preventDefault is called for non-modifier keys", () => {
    const actions = mockActions();
    const e = keyEvent({ key: "x" });
    handleJumpMode(e, true, actions);
    expect(e.preventDefault).toHaveBeenCalled();
  });

  test("'<' moves active tab left without deactivating", () => {
    const actions = mockActions();
    const e = keyEvent({ key: "<", shiftKey: true });
    handleJumpMode(e, true, actions);
    expect(actions.moveActiveTab).toHaveBeenCalledWith("left");
    expect(actions.deactivate).not.toHaveBeenCalled();
    expect(actions.jumpToHint).not.toHaveBeenCalled();
  });

  test("'>' moves active tab right without deactivating", () => {
    const actions = mockActions();
    const e = keyEvent({ key: ">", shiftKey: true });
    handleJumpMode(e, true, actions);
    expect(actions.moveActiveTab).toHaveBeenCalledWith("right");
    expect(actions.deactivate).not.toHaveBeenCalled();
    expect(actions.jumpToHint).not.toHaveBeenCalled();
  });

  test("'<' / '>' are ignored outside workBench", () => {
    const actions = mockActions();
    const e = keyEvent({ key: "<", shiftKey: true });
    handleJumpMode(e, false, actions);
    expect(actions.moveActiveTab).not.toHaveBeenCalled();
    expect(actions.deactivate).toHaveBeenCalled();
  });
});
