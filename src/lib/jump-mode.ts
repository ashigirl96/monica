const MODIFIER_KEYS = new Set(["Alt", "Control", "Meta", "Shift"]);

export type JumpModeActions = {
  clearTimeout: () => void;
  deactivate: () => void;
  createTab: () => void;
  jumpToHint: (params: { key: string; runspace: boolean }) => void;
  moveActiveTab: (direction: "left" | "right") => void;
};

export function handleJumpMode(
  e: KeyboardEvent,
  isWorkBench: boolean,
  actions: JumpModeActions,
): void {
  if (MODIFIER_KEYS.has(e.key)) return;

  e.preventDefault();
  actions.clearTimeout();

  if (e.ctrlKey && e.key === "t") {
    actions.deactivate();
    return;
  }

  if (e.key === "c" && !e.ctrlKey) {
    actions.deactivate();
    actions.createTab();
    return;
  }

  if (!isWorkBench) {
    actions.deactivate();
    return;
  }

  if (e.key === "<" || e.key === ">") {
    actions.moveActiveTab(e.key === "<" ? "left" : "right");
    return;
  }

  actions.jumpToHint({ key: e.key.toLowerCase(), runspace: e.ctrlKey });
}
