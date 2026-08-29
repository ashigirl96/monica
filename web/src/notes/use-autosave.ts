import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, updateNote } from "@/api";
import type { UpdateNote } from "@/types.gen";
import { type NoteConflict, removeConflict, shouldAdvanceBase, upsertConflict } from "./conflicts";

const DEBOUNCE_MS = 1000;
const RETRY_MS = 5000;

/** schedule に渡す payload。基準版は台帳が持つのでここには載らない。 */
export type NoteDraft = Omit<UpdateNote, "expected_updated_at">;

/**
 * ノート id ごとに最新 payload を保持し、1 秒 debounce で PUT する。flush はノート切替・
 * pagehide（keepalive fetch）から呼ばれる。失敗した payload は同 id のより新しい pending や
 * 削除済み id がない限り復元し、RETRY_MS 後に自動再試行する。
 *
 * 併せて id ごとの基準版（最後に読んだ / 書いた updated_at）を台帳に持ち、PUT に
 * expected_updated_at として添える。サーバが 409 を返したら他クライアントに先を越された
 * ということなので、再試行せず競合台帳に積んで呼び手に委ねる（同じ stale な基準版で
 * 再試行しても永久に 409 になるため）。
 *
 * この hook は router より上（AutosaveProvider）で 1 度だけ mount する。ページ単位で持つと、
 * 別セクションへ移った瞬間に台帳ごと消えて、後から返った 409 の行き場が無くなる。
 */
export function useAutosave() {
  const pendingRef = useRef(new Map<string, NoteDraft>());
  const discardedRef = useRef(new Set<string>());
  // id ごとの基準版。PUT が返す updated_at で前進させる
  const versionRef = useRef(new Map<string, string>());
  // 送信中の id。差し替え判定が in-flight な書き込みを見落とさないために要る
  const inflightRef = useRef(new Set<string>());
  // 409 で行き場を失った draft。再送しても永久に 409 なので pending には戻さないが、
  // 「未保存」ではあるので削除や content 採用の前で止められるよう別に持つ
  const conflictedRef = useRef(new Map<string, NoteDraft>());
  // 競合通知に出す見出し。kind ごとの決め方はページの知識なので schedule で受け取る
  const labelRef = useRef(new Map<string, string>());
  const timerRef = useRef<number | null>(null);
  // flush を直列化し、古い payload の PUT が新しい PUT を追い越して上書きするのを防ぐ
  const flushChainRef = useRef<Promise<void>>(Promise.resolve());
  const [error, setError] = useState<string | null>(null);
  // 競合の一覧。開いている note に依らず保持するので、離脱後に返った 409 も surface できる
  const [conflicts, setConflicts] = useState<NoteConflict[]>([]);
  // 画面に出ている note。通知はこの行を出さない（インラインバナーと二重になる）
  const [openNoteId, setOpenNote] = useState<string | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const baseVersion = useCallback((id: string) => versionRef.current.get(id) ?? null, []);

  /** 前進の可否は shouldAdvanceBase が持つ（単調性 + 競合中のピン留め）。 */
  const setBase = useCallback((id: string, updatedAt: string) => {
    const current = versionRef.current.get(id) ?? null;
    if (!shouldAdvanceBase(current, updatedAt, conflictedRef.current.has(id))) return;
    versionRef.current.set(id, updatedAt);
  }, []);

  /** 未保存（pending・送信中・競合で滞留）の編集を抱えているか。 */
  const hasUnsaved = useCallback(
    (id: string) =>
      pendingRef.current.has(id) || inflightRef.current.has(id) || conflictedRef.current.has(id),
    [],
  );

  /** 競合バナーの表示条件。台帳ではなく state から引くので、409 の到着で再描画される。 */
  const hasConflict = useCallback((id: string) => conflicts.some((c) => c.id === id), [conflicts]);

  /** pending を出し切る。成否は id ごとに `hasUnsaved(id)` で見る — 呼び手が気にするのは
   * 常に自分が触っている note の 1 件で、無関係な note の失敗で操作を止める理由はない。 */
  const flush = useCallback(
    (keepalive = false): Promise<void> => {
      const run = async (): Promise<void> => {
        clearTimer();
        if (pendingRef.current.size === 0) return;
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
                  // 基準版が古いので同じ payload を投げ直しても永久に 409。pending へ戻して
                  // リトライさせず、競合として保持したうえで通知とバナーに渡す。
                  // failure にはしない（自動リトライを誘発し、競合表示とも二重になる）。
                  conflictedRef.current.set(id, draft);
                  const label = labelRef.current.get(id) ?? "Untitled";
                  setConflicts((list) => upsertConflict(list, { id, label }));
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
      };
      const settled = flushChainRef.current.then(run);
      flushChainRef.current = settled;
      return settled;
    },
    [clearTimer, setBase],
  );

  const schedule = useCallback(
    (id: string, draft: NoteDraft, label: string) => {
      pendingRef.current.set(id, draft);
      labelRef.current.set(id, label);
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
      conflictedRef.current.delete(id);
      labelRef.current.delete(id);
      setConflicts((list) => removeConflict(list, id));
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
   * discard と違い削除済みの印は残さない（そのまま編集を続けられる）。
   * 基準版のピン（shouldAdvanceBase）が解けるのはこの経路だけ。 */
  const dropPending = useCallback(
    (id: string) => {
      pendingRef.current.delete(id);
      conflictedRef.current.delete(id);
      versionRef.current.delete(id);
      setConflicts((list) => removeConflict(list, id));
      if (pendingRef.current.size === 0) clearTimer();
    },
    [clearTimer],
  );

  useEffect(() => {
    // pagehide の keepalive flush が 409 を返しても、それを出す画面はもう無い。ここでは
    // 拾わない方針で確定している: サーバのデータは壊れず勝った側の変更がそのまま残るので、
    // 次回ロード時の再フェッチが最新を見せる形で吸収する。
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
    hasConflict,
    setOpenNote,
    error,
    conflicts,
    openNoteId,
  };
}

export type Autosave = ReturnType<typeof useAutosave>;
