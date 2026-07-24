import { restoreNote } from "@/api";
import type { EssayStatus, Note, NoteKind, NoteSummary } from "@/types.gen";

/** summary から essay の status を取り出す。essay 以外は現れない前提だが型上は防御する */
export function essayStatus(summary: NoteSummary): EssayStatus | null {
  return summary.kind.kind === "essay" ? summary.kind.status : null;
}

/** 次に送る status。遷移規則は domain の `EssayStatus::toggled` が持つので導出せず受け取る */
export function nextEssayStatus(summary: NoteSummary): EssayStatus | null {
  return summary.kind.kind === "essay" ? summary.kind.next_status : null;
}

export function essayTitle(summary: NoteSummary): string {
  return summary.kind.kind === "essay" ? summary.kind.title : "";
}

/** `2026-07-21T…` → `2026/7/21`（ゼロ埋めなし。一覧カードの日付表記） */
export function slashDate(timestamp: string): string {
  const [y, m, d] = timestamp.slice(0, 10).split("-");
  return `${y}/${Number(m)}/${Number(d)}`;
}

/** 未取得（null）を保ったまま手元の一覧を繕う。取り直しを待たずに反映するため */
export function patchEssayKind(
  list: NoteSummary[] | null,
  id: string,
  kind: NoteKind,
): NoteSummary[] | null {
  return list?.map((s) => (s.id === id ? { ...s, kind } : s)) ?? list;
}

export function dropEssay(list: NoteSummary[] | null, id: string): NoteSummary[] | null {
  return list?.filter((s) => s.id !== id) ?? list;
}

/** ⌥Z の undo 対象。projects と違い essay は削除後の落ち先が一覧（= 別コンポーネント）に
 * なり得るので、スタックをコンポーネント寿命から切り離して一覧とエディタで共有する。 */
const deletedEssayIds: string[] = [];

export function pushDeletedEssay(id: string) {
  deletedEssayIds.push(id);
}

/** 直近に削除した essay を復活させる。失敗（既に消えている等）は undefined を返すだけ —
 * ⌥Z は次の操作で押し直せるので呼び手にエラー表示の責務を作らない。 */
export async function restoreLastDeletedEssay(): Promise<Note | undefined> {
  const id = deletedEssayIds.pop();
  if (id === undefined) return undefined;
  const index = deletedEssayIds.length;
  try {
    return await restoreNote(id);
  } catch {
    // 失敗のたびに id を捨てると ⌥Z が二度と効かなくなる。抜いた位置に戻して押し直せるようにする
    // （待っている間に別の削除が積まれても順序が壊れないよう index 指定で戻す）
    deletedEssayIds.splice(index, 0, id);
    return undefined;
  }
}
