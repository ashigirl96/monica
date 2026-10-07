import {
  type InfiniteData,
  skipToken,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { useCallback } from 'react'

import type {
  EssaySummary,
  Note,
  RepoNoteSummary,
  RepoNotesCursor,
  RepoNotesPage,
} from '../../contract.ts'
import { useNoteClient } from '../client.ts'
import { queryKeys } from '../query.ts'

/** 開いている note の本文。id が決まるまで（Scratch を開いている間など）は取らない。 */
export function useNoteQuery(id: string | null) {
  const client = useNoteClient()
  return useQuery({
    queryKey: queryKeys.note(id ?? ''),
    queryFn: id === null ? skipToken : () => client.get({ id }),
  })
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

/** ghq を spawn するので、picker を開いている間だけ取る。 */
export function useRepoCandidatesQuery(enabled: boolean) {
  const client = useNoteClient()
  return useQuery({
    queryKey: queryKeys.repoCandidates(),
    queryFn: () => client.repo.candidates(),
    enabled,
  })
}

/** Scratch も daily と同じく get-or-create で、既にあれば updatedAt を触らない。 */
export function useScratchQuery(repo: string) {
  const client = useNoteClient()
  return useQuery({
    queryKey: queryKeys.scratch(repo),
    queryFn: () => client.scratch.open({ repo }),
  })
}

export function useRepoNotesQuery(repo: string) {
  const client = useNoteClient()
  return useInfiniteQuery({
    queryKey: queryKeys.repoNotes(repo),
    queryFn: ({ pageParam }) => client.repoNote.list({ repo, after: pageParam }),
    initialPageParam: undefined as RepoNotesCursor | undefined,
    getNextPageParam: (last) => last.next ?? undefined,
  })
}

/** 作った・戻した note を本文の cache に置く。navigate の直後に loading を挟まない。 */
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

/** Repo Note の一覧（infinite query）の手動操作。頁の構造を保ったまま行を書き換える。 */
export function useRepoNotesCache(repo: string) {
  const queryClient = useQueryClient()
  const patchRepoNotes = useCallback(
    (update: (notes: RepoNoteSummary[]) => RepoNoteSummary[]) => {
      queryClient.setQueryData(
        queryKeys.repoNotes(repo),
        (data: InfiniteData<RepoNotesPage, RepoNotesCursor | undefined> | undefined) =>
          data === undefined
            ? data
            : {
                ...data,
                pages: data.pages.map((page) => ({ ...page, notes: update(page.notes) })),
              },
      )
    },
    [queryClient, repo],
  )
  const invalidateRepoNotes = useCallback(
    () => void queryClient.invalidateQueries({ queryKey: queryKeys.repoNotes(repo) }),
    [queryClient, repo],
  )
  return { patchRepoNotes, invalidateRepoNotes }
}
