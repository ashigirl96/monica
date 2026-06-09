import { atom } from "jotai";

export const workboardSearchAtom = atom("");
export const workboardTrackOpenAtom = atom(false);
export const workboardRefreshNonceAtom = atom(0);

export const refreshWorkboardAtom = atom(null, (get, set) => {
  set(workboardRefreshNonceAtom, get(workboardRefreshNonceAtom) + 1);
});
