import { atom } from "jotai";

export type SpaceId = "library" | "work-board" | "work-bench";

export const SIDEBAR_DEFAULT_WIDTH = 200;
export const SIDEBAR_MIN_WIDTH = 160;
export const SIDEBAR_MAX_WIDTH = 360;

export const activeSpaceAtom = atom<SpaceId>("library");
export const sidebarOpenAtom = atom(true);
export const sidebarWidthAtom = atom(SIDEBAR_DEFAULT_WIDTH);
export const sidebarResizingAtom = atom(false);
