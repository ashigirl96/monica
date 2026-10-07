import type { EssayStatus, Note } from '../../../contract.ts'
import { nextEssayStatus } from './support.ts'

/** 保存を予約する経路（本文と title の変更）が読む、開いている Note。null の間は予約しない。 */
export type Gate = { current: Note | null }

/**
 * 開いている Essay を消す。消した Essay を返し、消さなかったら null を返す。
 * ⌥Z で戻せるのは Backend に届いた本文までなので、flush しても未保存が残れば消さない。
 */
export async function removeOpenEssay({
  gate,
  isOpen,
  flush,
  hasUnsaved,
  remove,
  reschedule,
}: {
  gate: Gate
  isOpen: (id: string) => boolean
  flush: () => Promise<void>
  hasUnsaved: (id: string) => boolean
  remove: (id: string) => Promise<void>
  reschedule: (note: Note) => void
}): Promise<Note | null> {
  const target = gate.current
  if (target === null) return null
  // 往復の間に打った分を予約させない。予約すると flush の成否に入らず、消した後に保存が 404 を繰り返す。
  gate.current = null
  const keep = () => {
    // 別の Note へ移った後に戻すと、その Note の本文を target に保存してしまう。
    if (gate.current !== null || !isOpen(target.id)) return
    gate.current = target
    reschedule(target)
  }
  await flush()
  if (hasUnsaved(target.id)) {
    keep()
    return null
  }
  try {
    await remove(target.id)
  } catch {
    keep()
    return null
  }
  return target
}

/**
 * 開いている Essay の status を次へ進め、返った Essay を返す。進めなかったら null を返す。
 * 未保存が残る間は進めない。進めた版を基準版にすると、競合で残った古い本文が次の保存で外の変更を上書きする。
 */
export async function setOpenEssayStatus({
  targetId,
  gate,
  flush,
  hasUnsaved,
  setStatus,
  setBase,
  adopt,
  patchStatus,
}: {
  targetId: string
  gate: Gate
  flush: () => Promise<void>
  hasUnsaved: (id: string) => boolean
  setStatus: (id: string, status: EssayStatus) => Promise<Note>
  setBase: (id: string, updatedAt: Date) => void
  adopt: (note: Note) => void
  patchStatus: (status: EssayStatus) => void
}): Promise<Note | null> {
  const current = gate.current
  if (current === null || current.id !== targetId || current.kind !== 'essay') return null
  await flush()
  if (hasUnsaved(current.id)) return null
  const updated = await setStatus(current.id, nextEssayStatus(current.status))
  if (updated.kind !== 'essay') return null
  // status だけが変わった版なので、手元の本文はその上に積んでよい。
  setBase(updated.id, updated.updatedAt)
  if (gate.current?.id !== updated.id) return updated
  // 往復の間に打った本文は返った本文より新しい。
  if (hasUnsaved(updated.id)) patchStatus(updated.status)
  else adopt(updated)
  return updated
}
