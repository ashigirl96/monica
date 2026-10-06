import { useQuery } from '@tanstack/react-query'

import { useNoteClient } from '../client.ts'
import { queryKeys } from '../query.ts'

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
