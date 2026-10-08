import type { Doc, EssayStatus, Note } from '../../../contract.ts'
import { nextEssayStatus } from './support.ts'

/** 保存を予約する経路（本文と title の変更）が読む、開いている Note。null の間は予約しない。 */
export type Gate = { current: Note | null }

type Saving = {
  flush: () => Promise<void>
  hasUnsaved: (id: string) => boolean
}

/**
 * 開いている Essay の status を次へ進め、返った Essay を返す。進めなかったら null を返す。
 * 未保存が残る間は進めない。進めた版を基準版にすると、競合で残った古い本文が次の保存で外の変更を上書きする。
 */
export async function setOpenEssayStatus({
  targetId,
  gate,
  shownContent,
  flush,
  hasUnsaved,
  setStatus,
  setBase,
  adopt,
  patchStatus,
}: Saving & {
  targetId: string
  gate: Gate
  /** 画面に出している本文。 */
  shownContent: () => Doc
  setStatus: (id: string, status: EssayStatus) => Promise<Note>
  setBase: (id: string, updatedAt: Date) => void
  adopt: (note: Note, remount: boolean) => void
  patchStatus: (status: EssayStatus) => void
}): Promise<Note | null> {
  const current = gate.current
  if (current === null || current.id !== targetId || current.kind !== 'essay') return null
  await flush()
  if (hasUnsaved(current.id)) return null
  // 未保存が無いので、画面の title と本文は Backend の版と同じはず。
  const shown = gate.current?.kind === 'essay' ? gate.current : current
  const shownDoc = JSON.stringify(shownContent())
  const updated = await setStatus(current.id, nextEssayStatus(current.status))
  if (updated.kind !== 'essay') return null
  // 外で書き換わった版を基準版にすると、画面の古い本文が次の保存でその変更を競合なしに上書きする。
  const statusOnly = updated.title === shown.title && JSON.stringify(updated.content) === shownDoc
  if (statusOnly) setBase(updated.id, updated.updatedAt)
  if (gate.current?.id !== updated.id) return updated
  // 往復の間に打った本文は返った本文より新しい。
  if (hasUnsaved(updated.id)) patchStatus(updated.status)
  else adopt(updated, !statusOnly)
  return updated
}
