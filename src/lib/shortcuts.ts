import { useEffect, useRef } from "react";

export const KEYMAP = {
  toggleSidebar: { keys: "mod+1", label: "サイドバーの開閉" },
} as const satisfies Record<string, { keys: string; label: string }>;

export type ShortcutId = keyof typeof KEYMAP;

type Handlers = Partial<Record<ShortcutId, () => void>>;

function matches(keys: string, e: KeyboardEvent): boolean {
  const parts = keys.toLowerCase().split("+");
  const key = parts[parts.length - 1];
  const wantMod = parts.includes("mod");
  if (wantMod !== (e.metaKey || e.ctrlKey)) return false;
  if (parts.includes("shift") !== e.shiftKey) return false;
  if (parts.includes("alt") !== e.altKey) return false;
  return e.key.toLowerCase() === key;
}

export function useShortcuts(handlers: Handlers): void {
  const latest = useRef(handlers);
  latest.current = handlers;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      for (const id of Object.keys(latest.current) as ShortcutId[]) {
        const run = latest.current[id];
        if (run && matches(KEYMAP[id].keys, e)) {
          e.preventDefault();
          run();
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
