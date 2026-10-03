const MODIFIER_KEYS = new Set(["Alt", "Control", "Meta", "Shift"]);

export type JumpModeActions = {
  deactivate: () => void;
  createTab: () => void;
  jumpToHint: (params: { key: string; runspace: boolean }) => void;
  moveActiveTab: (direction: "left" | "right") => void;
  moveActiveRunspace: (direction: "up" | "down") => void;
};

export function handleJumpMode(e: KeyboardEvent, actions: JumpModeActions): void {
  if (MODIFIER_KEYS.has(e.key)) return;

  e.preventDefault();

  if (e.ctrlKey && e.key === "t") {
    actions.deactivate();
    return;
  }

  if (e.key === "c" && !e.ctrlKey) {
    actions.deactivate();
    actions.createTab();
    return;
  }

  if (e.key === "H" || e.key === "L") {
    actions.moveActiveTab(e.key === "H" ? "left" : "right");
    return;
  }

  if (e.key === "J" || e.key === "K") {
    actions.moveActiveRunspace(e.key === "K" ? "up" : "down");
    return;
  }

  actions.jumpToHint({ key: e.key.toLowerCase(), runspace: e.ctrlKey });
}
