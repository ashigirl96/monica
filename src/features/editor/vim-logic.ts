export type VimMode = "insert" | "normal";
export type VimPendingKey = "d" | null;

export type MinimalVimState = {
  mode: VimMode;
  pending: VimPendingKey;
};

export type VimAction =
  | "none"
  | "blockInput"
  | "enterInsert"
  | "enterNormal"
  | "moveLeft"
  | "moveRight"
  | "moveRightAndInsert"
  | "moveNextBlock"
  | "movePreviousBlock"
  | "deleteBlock";

export type VimKeyResolution = {
  handled: boolean;
  state: MinimalVimState;
  action: VimAction;
};

const VIM_KEYS = new Set(["Escape", "i", "a", "h", "j", "k", "l", "d"]);

export function createInitialMinimalVimState(): MinimalVimState {
  return { mode: "insert", pending: null };
}

export function isHandledVimKey(key: string): boolean {
  return VIM_KEYS.has(key);
}

export function isPrintableKey(key: string): boolean {
  return key.length === 1;
}

export function shouldStopVimPropagation(state: MinimalVimState, key: string): boolean {
  return (
    key === "Escape" || (state.mode === "normal" && (isHandledVimKey(key) || isPrintableKey(key)))
  );
}

export function resolveMinimalVimKey(state: MinimalVimState, key: string): VimKeyResolution {
  if (key === "Escape") {
    return {
      handled: true,
      state: { mode: "normal", pending: null },
      action: "enterNormal",
    };
  }

  if (state.mode === "insert") {
    return { handled: false, state, action: "none" };
  }

  switch (key) {
    case "i":
      return { handled: true, state: { mode: "insert", pending: null }, action: "enterInsert" };
    case "a":
      return {
        handled: true,
        state: { mode: "insert", pending: null },
        action: "moveRightAndInsert",
      };
    case "h":
      return { handled: true, state: { ...state, pending: null }, action: "moveLeft" };
    case "l":
      return { handled: true, state: { ...state, pending: null }, action: "moveRight" };
    case "j":
      return { handled: true, state: { ...state, pending: null }, action: "moveNextBlock" };
    case "k":
      return { handled: true, state: { ...state, pending: null }, action: "movePreviousBlock" };
    case "d":
      return state.pending === "d"
        ? { handled: true, state: { ...state, pending: null }, action: "deleteBlock" }
        : { handled: true, state: { ...state, pending: "d" }, action: "none" };
    default:
      return isPrintableKey(key)
        ? { handled: true, state: { ...state, pending: null }, action: "blockInput" }
        : { handled: false, state, action: "none" };
  }
}
