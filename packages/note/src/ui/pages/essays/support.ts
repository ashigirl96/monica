import type { EssayStatus, EssaySummary, Note, NoteSummary } from '../../../contract.ts'

/** サイドバーのタブが引くリスト。両 status のキーが必ず存在する */
export type EssayGroups = Record<EssayStatus, EssaySummary[]>

/** サイドバーのタブ並び（左 → 右）。描画順と ⌥H/⌥L の移動先がこの 1 箇所から決まる。
 * EssayStatus の全値を並べる（到達できない status を作らない）。 */
export const ESSAY_TABS: readonly [EssayStatus, EssayStatus] = ['writing', 'finished']

/** ⌥H/⌥L の移動先。両端で折り返すので、タブが 2 つの今は左右どちらのキーでも往復になる
 * （同じキーを 2 回押せば元のタブに戻る）。 */
export function otherEssayTab(current: EssayStatus): EssayStatus {
  return current === ESSAY_TABS[0] ? ESSAY_TABS[1] : ESSAY_TABS[0]
}

/** ⌃W・StatusChip・一覧の右クリックで送る status。procedure は toggle ではなく値を受ける。 */
export function nextEssayStatus(current: EssayStatus): EssayStatus {
  return current === 'writing' ? 'finished' : 'writing'
}

/** 未取得（null）を保ったまま status 別に分ける。 */
export function splitEssaysByStatus(list: readonly NoteSummary[] | null): EssayGroups | null {
  if (list === null) return null
  const groups: EssayGroups = { writing: [], finished: [] }
  for (const summary of list) {
    if (summary.kind === 'essay') groups[summary.status].push(summary)
  }
  return groups
}

/** 未取得（null）を保ったまま手元の一覧を繕う。取り直しを待たずに反映するため */
export function patchEssay(
  list: EssaySummary[] | null,
  id: string,
  patch: Partial<Pick<EssaySummary, 'title' | 'status'>>,
): EssaySummary[] | null {
  return list?.map((s) => (s.id === id ? { ...s, ...patch } : s)) ?? list
}

export function dropEssay(list: EssaySummary[] | null, id: string): EssaySummary[] | null {
  return list?.filter((s) => s.id !== id) ?? list
}

/** ⌥Z の undo 対象。削除後の落ち先が一覧（= 別コンポーネント）になり得るので、
 * スタックをコンポーネント寿命から切り離して一覧とエディタで共有する。 */
const deletedEssayIds: string[] = []

export function pushDeletedEssay(id: string) {
  deletedEssayIds.push(id)
}

/** 直近に削除した essay を復活させる。失敗（既に消えている等）は undefined を返すだけ —
 * ⌥Z は次の操作で押し直せるので呼び手にエラー表示の責務を作らない。 */
export async function restoreLastDeletedEssay(
  restore: (id: string) => Promise<Note>,
): Promise<Note | undefined> {
  const id = deletedEssayIds.pop()
  if (id === undefined) return undefined
  const index = deletedEssayIds.length
  try {
    return await restore(id)
  } catch {
    // 失敗のたびに id を捨てると ⌥Z が二度と効かなくなる。抜いた位置に戻して押し直せるようにする
    // （待っている間に別の削除が積まれても順序が壊れないよう index 指定で戻す）
    deletedEssayIds.splice(index, 0, id)
    return undefined
  }
}
