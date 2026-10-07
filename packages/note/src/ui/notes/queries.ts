import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'

import type { EssaySummary, Note } from '../../contract.ts'
import { useNoteClient } from '../client.ts'
import { queryKeys } from '../query.ts'

export function useNoteQuery(id: string) {
  const client = useNoteClient()
  return useQuery({ queryKey: queryKeys.note(id), queryFn: () => client.get({ id }) })
}

/** daily は get ではなく get-or-create（開く = 作る）。既存 note があるときは
 * updatedAt を触らないので、復帰のたびに叩いても版は進まない。 */
export function useDailyNoteQuery(date: string) {
  const client = useNoteClient()
  return useQuery({
    queryKey: queryKeys.dailyNote(date),
    queryFn: () => client.daily.open({ date }),
  })
}

export function useDailyDatesQuery() {
  const client = useNoteClient()
  return useQuery({ queryKey: queryKeys.dailyDates(), queryFn: () => client.daily.dates() })
}

export function useEssaysQuery() {
  const client = useNoteClient()
  return useQuery({ queryKey: queryKeys.essays(), queryFn: () => client.essay.list() })
}

/** procedure が返した note を本文の cache へ置く。移った直後に loading を挟まない。 */
export function useSeedNote() {
  const queryClient = useQueryClient()
  return useCallback(
    (note: Note) => queryClient.setQueryData(queryKeys.note(note.id), note),
    [queryClient],
  )
}

/** 消した Note の本文の cache を捨てる。残すと、履歴で戻ったときに消した Note を cache から開く。 */
export function useForgetNote() {
  const queryClient = useQueryClient()
  return useCallback(
    (id: string) => queryClient.removeQueries({ queryKey: queryKeys.note(id), exact: true }),
    [queryClient],
  )
}

/** Essay の一覧の cache を手で直す。一覧の画面と編集の画面のサイドバーが共有する。 */
export function useEssaysCache() {
  const queryClient = useQueryClient()
  const patchEssays = useCallback(
    (update: (list: EssaySummary[] | null) => EssaySummary[] | null) => {
      queryClient.setQueryData(
        queryKeys.essays(),
        (list: EssaySummary[] | undefined) => update(list ?? null) ?? undefined,
      )
    },
    [queryClient],
  )
  const invalidateEssays = useCallback(
    () => void queryClient.invalidateQueries({ queryKey: queryKeys.essays() }),
    [queryClient],
  )
  return { patchEssays, invalidateEssays }
}
