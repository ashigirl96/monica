import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, updateNote } from "@/api";
import type { UpdateNote } from "@/types.gen";

const DEBOUNCE_MS = 1000;
const RETRY_MS = 5000;

/** schedule に渡す payload。基準版は台帳が持つのでここには載らない。 */
export type NoteDraft = Omit<UpdateNote, "expected_updated_at">;

/**
 * ノート id ごとに最新 payload を保持し、1 秒 debounce で PUT する。flush はノート切替・
 * unmount・pagehide（keepalive fetch）から呼ばれる。失敗した payload は同 id のより新しい
 * pending や削除済み id がない限り復元し、RETRY_MS 後に自動再試行する。
 *
 * 併せて id ごとの基準版（最後に読んだ / 書いた updated_at）を台帳に持ち、PUT に
 * expected_updated_at として添える。サーバが 409 を返したら他クライアントに先を越された
 * ということなので、再試行せず conflictId を立てて呼び手に委ねる（同じ stale な基準版で
 * 再試行しても永久に 409 になるため）。
 */
export function useAutosave() {
  const pendingRef = useRef(new Map<string, NoteDraft>());
  const discardedRef = useRef(new Set<string>());
  // id ごとの基準版。PUT が返す updated_at で前進させる
  const versionRef = useRef(new Map<string, string>());
  // 送信中の id。差し替え判定が in-flight な書き込みを見落とさないために要る
  const inflightRef = useRef(new Set<string>());
  const timerRef = useRef<number | null>(null);
  // flush を直列化し、古い payload の PUT が新しい PUT を追い越して上書きするのを防ぐ
  const flushChainRef = useRef<Promise<void>>(Promise.resolve());
  const [error, setError] = useState<string | null>(null);
  const [conflictId, setConflictId] = useState<string | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const baseVersion = useCallback((id: string) => versionRef.current.get(id) ?? null, []);

  /** 基準版は単調にしか進めない。巻き戻すと偽の 409 か、古い doc での静かな上書きに直結する。 */
  const setBase = useCallback((id: string, updatedAt: string) => {
    const current = versionRef.current.get(id);
    if (current === undefined || updatedAt > current) versionRef.current.set(id, updatedAt);
  }, []);

  /** 未保存（pending か送信中）の編集を抱えているか。 */
  const hasUnsaved = useCallback(
    (id: string) => pendingRef.current.has(id) || inflightRef.current.has(id),
    [],
  );

  /** 保存が全て通ったかを返す。false = pending が残っている（再試行待ち）ので、
   * 呼び手は「未保存分が消えると困る操作」（削除など）を中断できる。 */
  const flush = useCallback(
    (keepalive = false): Promise<boolean> => {
      const run = async (): Promise<boolean> => {
        clearTimer();
        if (pendingRef.current.size === 0) return true;
        const batch = pendingRef.current;
        pendingRef.current = new Map();
        let failure: string | null = null;
        await Promise.all(
          [...batch].map(([id, draft]) => {
            inflightRef.current.add(id);
            const payload: UpdateNote = {
              ...draft,
              expected_updated_at: versionRef.current.get(id) ?? null,
            };
            return updateNote(id, payload, keepalive)
              .then((version) => setBase(id, version.updated_at))
              .catch((e: unknown) => {
                if (e instanceof ApiError && e.status === 409) {
                  // 基準版が古いので同じ payload を投げ直しても永久に 409。pending へ戻さず
                  // 呼び手（バナー）に渡し、サーバの最新を読み直させる。
                  setConflictId(id);
                  return;
                }
                if (!discardedRef.current.has(id) && !pendingRef.current.has(id)) {
                  pendingRef.current.set(id, draft);
                }
                failure = e instanceof Error ? e.message : "Failed to save";
              })
              .finally(() => inflightRef.current.delete(id));
          }),
        );
        setError(failure);
        if (failure !== null && pendingRef.current.size > 0 && timerRef.current === null) {
          timerRef.current = window.setTimeout(() => void flush(), RETRY_MS);
        }
        return failure === null;
      };
      const settled = flushChainRef.current.then(run);
      // chain 自体は void で繋ぐ（次の flush が前回の結果を引数として受け取らないように）
      flushChainRef.current = settled.then(() => undefined);
      return settled;
    },
    [clearTimer, setBase],
  );

  const schedule = useCallback(
    (id: string, draft: NoteDraft) => {
      pendingRef.current.set(id, draft);
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

  /** undo で復活した note の再試行を戻す。同じページに留まったまま復活すると
   * discard の印が残り続け、以降その id の保存失敗が再試行されなくなるため。 */
  const resume = useCallback((id: string) => {
    discardedRef.current.delete(id);
  }, []);

  /** 競合解決で「サーバの最新を読む」を選んだときに、捨てる編集を落とす。
   * discard と違い削除済みの印は残さない（そのまま編集を続けられる）。 */
  const dropPending = useCallback(
    (id: string) => {
      pendingRef.current.delete(id);
      versionRef.current.delete(id);
      setConflictId((current) => (current === id ? null : current));
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

  return {
    schedule,
    flush,
    discard,
    resume,
    dropPending,
    baseVersion,
    setBase,
    hasUnsaved,
    error,
    conflictId,
  };
}

export type Autosave = ReturnType<typeof useAutosave>;
