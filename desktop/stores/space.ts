import { atom } from "jotai";

export type SpaceId = "work-board" | "work-bench" | "journal";

export const SIDEBAR_DEFAULT_WIDTH = 200;
export const SIDEBAR_MIN_WIDTH = 160;
export const SIDEBAR_MAX_WIDTH = 360;

export const activeSpaceAtom = atom<SpaceId>("work-board");
export const sidebarOpenAtom = atom(true);
export const sidebarWidthAtom = atom(SIDEBAR_DEFAULT_WIDTH);
export const sidebarResizingAtom = atom(false);
