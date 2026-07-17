import { useCallback, useEffect, useRef, useState } from "react";
import { updateNote } from "@/api";
import type { UpdateNote } from "@/types.gen";

const DEBOUNCE_MS = 1000;
const RETRY_MS = 5000;

/**
 * ノート id ごとに最新 payload を保持し、1 秒 debounce で PUT する。flush はノート切替・
 * unmount・pagehide（keepalive fetch）から呼ばれる。失敗した payload は同 id のより新しい
 * pending や削除済み id がない限り復元し、RETRY_MS 後に自動再試行する。
 * 競合は考慮しない（last-write-wins）。
 */
export function useAutosave() {
  const pendingRef = useRef(new Map<string, UpdateNote>());
  const discardedRef = useRef(new Set<string>());
  const timerRef = useRef<number | null>(null);
  // flush を直列化し、古い payload の PUT が新しい PUT を追い越して上書きするのを防ぐ
  const flushChainRef = useRef<Promise<void>>(Promise.resolve());
  const [error, setError] = useState<string | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const flush = useCallback(
    (keepalive = false): Promise<void> => {
      const run = async () => {
        clearTimer();
        if (pendingRef.current.size === 0) return;
        const batch = pendingRef.current;
        pendingRef.current = new Map();
        let failure: string | null = null;
        await Promise.all(
          [...batch].map(([id, payload]) =>
            updateNote(id, payload, keepalive).catch((e: unknown) => {
              if (!discardedRef.current.has(id) && !pendingRef.current.has(id)) {
                pendingRef.current.set(id, payload);
              }
              failure = e instanceof Error ? e.message : "Failed to save";
            }),
          ),
        );
        setError(failure);
        if (failure !== null && pendingRef.current.size > 0 && timerRef.current === null) {
          timerRef.current = window.setTimeout(() => void flush(), RETRY_MS);
        }
      };
      flushChainRef.current = flushChainRef.current.then(run);
      return flushChainRef.current;
    },
    [clearTimer],
  );

  const schedule = useCallback(
    (id: string, payload: UpdateNote) => {
      pendingRef.current.set(id, payload);
      clearTimer();
      timerRef.current = window.setTimeout(() => void flush(), DEBOUNCE_MS);
    },
    [clearTimer, flush],
  );

  /** ノート削除時、その id 宛の pending と in-flight 失敗時の復元を無効化する */
  const discard = useCallback(
    (id: string) => {
      discardedRef.current.add(id);
      pendingRef.current.delete(id);
      if (pendingRef.current.size === 0) clearTimer();
    },
    [clearTimer],
  );

  useEffect(() => {
    const onPageHide = () => void flush(true);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      void flush();
    };
  }, [flush]);

  return { schedule, flush, discard, error };
}
