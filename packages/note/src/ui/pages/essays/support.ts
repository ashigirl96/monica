import type { EssayStatus, EssaySummary, NoteSummary } from '../../../contract.ts'

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
