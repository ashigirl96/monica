import { type QueryObserverOptions, useInfiniteQuery, useQuery } from '@tanstack/react-query'

import type { Note, RepoNotesCursor } from '../../contract.ts'
import { type NoteClient, useNoteClient } from '../client.ts'
import { queryKeys } from '../query.ts'

export type NoteQueryOptions = QueryObserverOptions<Note, Error, Note, Note>

export function noteQueryOptions(client: NoteClient, id: string): NoteQueryOptions {
  return { queryKey: queryKeys.note(id), queryFn: () => client.get({ id }) }
}

/** date が null なら Pad。daily も Pad も get ではなく get-or-create（開く = 作る）。
 * 既存 note があるときは updatedAt を触らないので、復帰のたびに叩いても版は進まない。 */
export function dailyOrPadQueryOptions(client: NoteClient, date: string | null): NoteQueryOptions {
  return {
    queryKey: date === null ? queryKeys.pad() : queryKeys.dailyNote(date),
    queryFn: () => (date === null ? client.pad.open() : client.daily.open({ date })),
  }
}

/** Scratch も daily と同じく get-or-create で、既にあれば updatedAt を触らない。 */
export function scratchQueryOptions(client: NoteClient, repo: string): NoteQueryOptions {
  return { queryKey: queryKeys.scratch(repo), queryFn: () => client.scratch.open({ repo }) }
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

export function useScratchQuery(repo: string) {
  const client = useNoteClient()
  return useQuery(scratchQueryOptions(client, repo))
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
