import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'

import type { EssaySummary } from '../../contract.ts'
import { reach, useNoteClient } from '../client.ts'
import { queryKeys } from '../query.ts'
import { SaveQueue } from './save-queue.ts'
import { withSavedPreview } from './summary.ts'

export type { NoteDraft } from './save-queue.ts'

/**
 * この hook は router より上（AutosaveProvider）で 1 度だけ mount する。ページ単位で持つと、
 * 別セクションへ移った瞬間に台帳ごと消えて、後から返った CONFLICT の行き場が無くなる。
 */
export function useAutosave() {
  const client = useNoteClient()
  const queryClient = useQueryClient()
  const [queue] = useState(
    () =>
      new SaveQueue(async (input, keepalive) => {
        const saved = await client.save(input, { context: { keepalive } })
        // 一覧を取り直すと、打っている途中の title が保存済みの古い値へ戻るので、preview だけを写す
        queryClient.setQueryData(queryKeys.essays(), (list: EssaySummary[] | undefined) =>
          withSavedPreview(list, input.id, input.content),
        )
        return saved
      }),
  )
  const errors = useSyncExternalStore(queue.subscribe, queue.errors)
  const conflicts = useSyncExternalStore(queue.subscribe, queue.conflicts)
  // 画面に出ている note。通知はこの行を出さない（インラインバナーと二重になる）
  const [openNoteId, setOpenNote] = useState<string | null>(null)

  /** 競合バナーの表示条件。台帳ではなく state から引くので、CONFLICT の到着で再描画される。 */
  const hasConflict = useCallback((id: string) => conflicts.some((c) => c.id === id), [conflicts])

  /** その note の保存失敗メッセージ（再試行待ち）。 */
  const saveError = useCallback((id: string) => errors[id] ?? null, [errors])

  useEffect(() => {
    // pagehide の keepalive flush が CONFLICT を返しても、それを出す画面はもう無い。ここでは
    // 拾わない方針で確定している: サーバのデータは壊れず勝った側の変更がそのまま残るので、
    // 次回ロード時の再フェッチが最新を見せる形で吸収する。
    const onPageHide = () => void queue.flush(true)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      window.removeEventListener('pagehide', onPageHide)
      void queue.flush()
    }
  }, [queue])

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (queue.wouldLoseOnLeave(reach.isUnreachable())) e.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [queue])

  return {
    schedule: queue.schedule,
    flush: queue.flush,
    discard: queue.discard,
    resume: queue.resume,
    dropPending: queue.dropPending,
    baseVersion: queue.baseVersion,
    setBase: queue.setBase,
    hasUnsaved: queue.hasUnsaved,
    unsavedDraft: queue.unsavedDraft,
    editMark: queue.editMark,
    hasConflict,
    saveError,
    setOpenNote,
    conflicts,
    openNoteId,
  }
}

export type Autosave = ReturnType<typeof useAutosave>
