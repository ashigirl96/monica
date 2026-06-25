import { atom } from "jotai";

// Single-value for now; the union and cycle exist so a second mode can be added without reworking
// the Ctrl+Q shortcut. Cycling one value is intentionally a no-op.
export type LibraryMode = "notebooks";
const LIBRARY_MODES: LibraryMode[] = ["notebooks"];

export const libraryModeAtom = atom<LibraryMode>("notebooks");

export const cycleLibraryModeAtom = atom(null, (get, set, direction: "up" | "down") => {
  const current = get(libraryModeAtom);
  const idx = LIBRARY_MODES.indexOf(current);
  const newIdx =
    direction === "up"
      ? (idx - 1 + LIBRARY_MODES.length) % LIBRARY_MODES.length
      : (idx + 1) % LIBRARY_MODES.length;
  set(libraryModeAtom, LIBRARY_MODES[newIdx]);
});
