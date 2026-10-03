import { atom } from "jotai";

const FONT_SIZE_DEFAULT = 15;
const FONT_SIZE_MIN = 10;
const FONT_SIZE_MAX = 28;

export const terminalFontSizeAtom = atom(FONT_SIZE_DEFAULT);

export const zoomTerminalAtom = atom(null, (get, set, delta: 1 | -1) => {
  const current = get(terminalFontSizeAtom);
  set(terminalFontSizeAtom, Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, current + delta)));
});
