import { atom, getDefaultStore } from "jotai";

export type Toast = { id: number; message: string; type: "error" | "info" };

export const toastsAtom = atom<Toast[]>([]);

const TOAST_TTL_MS = 8000;
const MAX_TOASTS = 5;
let nextId = 0;

export function dismissToast(id: number) {
  const store = getDefaultStore();
  store.set(
    toastsAtom,
    store.get(toastsAtom).filter((t) => t.id !== id),
  );
}

export function pushErrorToast(message: string) {
  const store = getDefaultStore();
  const current = store.get(toastsAtom);
  if (current.some((t) => t.message === message)) return;
  const id = ++nextId;
  store.set(toastsAtom, [
    ...current.slice(-(MAX_TOASTS - 1)),
    { id, message, type: "error" as const },
  ]);
  setTimeout(() => dismissToast(id), TOAST_TTL_MS);
}

export function pushInfoToast(message: string) {
  const store = getDefaultStore();
  const current = store.get(toastsAtom);
  if (current.some((t) => t.message === message)) return;
  const id = ++nextId;
  store.set(toastsAtom, [
    ...current.slice(-(MAX_TOASTS - 1)),
    { id, message, type: "info" as const },
  ]);
  setTimeout(() => dismissToast(id), TOAST_TTL_MS);
}
